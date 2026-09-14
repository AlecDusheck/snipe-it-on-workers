import {
	BLOCK_BYTES,
	MAX_MANIFEST_BYTES,
	SOURCE_CACHE_ENTRY_BYTES,
	decodeFiles,
	isFileManifest,
} from "@simplyalec/laravel-cf-workers-laravel-runtime/files";
import type { RuntimeStorage, FileReference } from "@simplyalec/laravel-cf-workers-laravel-runtime/files";
import { digest, sameBytes } from "@simplyalec/laravel-cf-workers-laravel-runtime/crypto";
import { HttpError } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";
import type { Snapshot, SnapshotWrite } from "./types";

type Header = Omit<Snapshot, "bytes">;
type Tree = "committed" | "ephemeral" | "code";
/** Disposable source-cache allowance, independent of the application data tree. */
const WORKING_SET_BYTES = 16 * 1024 * 1024;
const WRITE_BUFFER_BYTES = 256 * 1024;
const WRITE_BUFFER_ENTRIES = 64;
type PendingWrite = { bytes: ArrayBuffer } & (
	| { kind: "block"; hash: string }
	| { kind: "source"; archive: string; path: string }
);

/** Blocks are staged independently; one local transaction publishes both trees and their roots. */
export class InstanceStorage implements RuntimeStorage {
	#sourceArchive: string | undefined;
	#sourceBytes = 0;
	#pending = new Map<string, PendingWrite>();
	#pendingBytes = 0;
	#flushing: Promise<void> | undefined;
	/** False once a collection pass found nothing; set again by writes, root removals and leases. */
	#maybeCollectable = true;
	constructor(private readonly storage: DurableObjectStorage) {
		storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS instance_blocks (hash TEXT PRIMARY KEY, data BLOB NOT NULL, created INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS instance_trees (tree TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(tree, part));
			CREATE TABLE IF NOT EXISTS instance_roots (owner TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(owner, hash));
			CREATE INDEX IF NOT EXISTS instance_roots_hash ON instance_roots(hash);
			CREATE TABLE IF NOT EXISTS instance_leases (owner TEXT PRIMARY KEY, expires INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS instance_working_set (archive TEXT NOT NULL, path TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(archive, path));
		`);
	}
	async readSource(archive: string, path: string): Promise<ArrayBuffer | null> {
		await this.#flushing;
		const pending = this.#pending.get(`source:${archive}:${path}`);
		if (pending) return pending.bytes.slice(0);
		return (
			this.storage.sql
				.exec<{ data: ArrayBuffer }>(
					"SELECT data FROM instance_working_set WHERE archive = ? AND path = ?",
					archive,
					path,
				)
				.toArray()[0]?.data ?? null
		);
	}
	async writeSource(archive: string, path: string, data: ArrayBuffer): Promise<void> {
		if (data.byteLength > SOURCE_CACHE_ENTRY_BYTES) return;
		await this.#stage(`source:${archive}:${path}`, { kind: "source", archive, path, bytes: data });
	}
	#storeSource(archive: string, path: string, data: ArrayBuffer): void {
		let used = this.#sourceBytes;
		if (this.#sourceArchive !== archive) {
			this.storage.sql.exec("DELETE FROM instance_working_set WHERE archive != ?", archive);
			used =
				this.storage.sql
					.exec<{ bytes: number | null }>("SELECT SUM(LENGTH(data)) AS bytes FROM instance_working_set")
					.one().bytes ?? 0;
		}
		const previous =
			this.storage.sql
				.exec<{ bytes: number }>(
					"SELECT LENGTH(data) AS bytes FROM instance_working_set WHERE archive = ? AND path = ?",
					archive,
					path,
				)
				.toArray()[0]?.bytes ?? 0;
		const total = used - previous + data.byteLength;
		if (total <= WORKING_SET_BYTES) {
			this.storage.sql.exec(
				"INSERT INTO instance_working_set VALUES (?, ?, ?) ON CONFLICT(archive, path) DO UPDATE SET data = excluded.data",
				archive,
				path,
				data,
			);
			used = total;
		}
		this.#sourceArchive = archive;
		this.#sourceBytes = used;
	}
	#tree(name: string): ArrayBuffer {
		const parts = this.storage.sql
			.exec<{ data: ArrayBuffer }>("SELECT data FROM instance_trees WHERE tree = ? ORDER BY part", name)
			.toArray();
		const bytes = new Uint8Array(parts.reduce((size, part) => size + part.data.byteLength, 0));
		let offset = 0;
		for (const part of parts) {
			bytes.set(new Uint8Array(part.data), offset);
			offset += part.data.byteLength;
		}
		return bytes.buffer;
	}
	#blockHashes(bytes: ArrayBuffer, tree: Tree): Set<string> {
		if (!isFileManifest(bytes)) return new Set();
		return new Set(
			Object.values(decodeFiles(bytes, tree).files).flatMap((file) =>
				file.blocks.flatMap((block) => (block ? [block.hash] : [])),
			),
		);
	}
	/** Records `hash` as reachable from `owner`; the block must already be stored. */
	#pin(owner: string, hash: string): void {
		if (!this.storage.sql.exec("SELECT 1 FROM instance_blocks WHERE hash = ?", hash).toArray().length)
			throw new HttpError(503, "Cannot commit a missing file block.");
		this.storage.sql.exec("INSERT OR IGNORE INTO instance_roots VALUES (?, ?)", owner, hash);
	}
	#replace(name: string, bytes: ArrayBuffer, tree: Tree = "committed"): void {
		if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new HttpError(413, "File index capacity exceeded.");
		const previous = this.#tree(name);
		if (sameBytes(previous, bytes)) return;
		const oldHashes = this.#blockHashes(previous, tree);
		const nextHashes = this.#blockHashes(bytes, tree);
		for (const hash of oldHashes)
			if (!nextHashes.has(hash)) {
				this.storage.sql.exec("DELETE FROM instance_roots WHERE owner = ? AND hash = ?", name, hash);
				this.#maybeCollectable = true;
			}
		for (const hash of nextHashes) if (!oldHashes.has(hash)) this.#pin(name, hash);
		const next = new Uint8Array(bytes);
		const prior = new Uint8Array(previous);
		for (let offset = 0; offset < bytes.byteLength; offset += BLOCK_BYTES) {
			const end = offset + BLOCK_BYTES;
			if (!sameBytes(next.subarray(offset, end), prior.subarray(offset, end)))
				this.storage.sql.exec(
					"INSERT INTO instance_trees VALUES (?, ?, ?) ON CONFLICT(tree, part) DO UPDATE SET data = excluded.data",
					name,
					offset / BLOCK_BYTES,
					bytes.slice(offset, end),
				);
		}
		this.storage.sql.exec(
			"DELETE FROM instance_trees WHERE tree = ? AND part >= ?",
			name,
			Math.ceil(bytes.byteLength / BLOCK_BYTES),
		);
	}
	async readCodeCache(namespace: string): Promise<ArrayBuffer> {
		return this.storage.kv.get<string>("codeCacheNamespace") === namespace
			? this.#tree("bytecode")
			: new ArrayBuffer(0);
	}
	async writeCodeCache(namespace: string, bytes: ArrayBuffer): Promise<void> {
		decodeFiles(bytes, "code");
		await this.flush();
		this.storage.transactionSync(() => {
			this.#replace("bytecode", bytes, "code");
			if (this.storage.kv.get<string>("codeCacheNamespace") !== namespace)
				this.storage.kv.put("codeCacheNamespace", namespace);
		});
		await this.storage.sync();
	}
	async #stage(key: string, entry: PendingWrite): Promise<void> {
		await this.#flushing;
		while (
			this.#pendingBytes + entry.bytes.byteLength > WRITE_BUFFER_BYTES ||
			this.#pending.size >= WRITE_BUFFER_ENTRIES
		)
			await this.flush();
		this.#pendingBytes -= this.#pending.get(key)?.bytes.byteLength ?? 0;
		this.#pending.set(key, { ...entry, bytes: entry.bytes.slice(0) });
		this.#pendingBytes += entry.bytes.byteLength;
		if (this.#pendingBytes >= WRITE_BUFFER_BYTES || this.#pending.size >= WRITE_BUFFER_ENTRIES)
			await this.flush();
	}
	#drain(): void {
		if (!this.#pending.size) return;
		const archive = this.#sourceArchive;
		const sourceBytes = this.#sourceBytes;
		try {
			this.storage.transactionSync(() => {
				for (const entry of this.#pending.values()) {
					if (entry.kind === "source") this.#storeSource(entry.archive, entry.path, entry.bytes);
					else
						this.storage.sql.exec(
							"INSERT OR IGNORE INTO instance_blocks(hash, data, created) VALUES (?, ?, ?)",
							entry.hash,
							entry.bytes,
							Date.now(),
						);
				}
			});
		} catch (error) {
			this.#sourceArchive = archive;
			this.#sourceBytes = sourceBytes;
			throw error;
		}
		this.#pending.clear();
		this.#pendingBytes = 0;
	}
	async flush(): Promise<void> {
		if (this.#flushing) await this.#flushing;
		if (!this.#pending.size) return;
		this.#drain();
		// No native write remains pending when a batch returns control to synchronous PHP.
		const pending = (this.#flushing = this.storage.sync());
		await pending;
		if (this.#flushing === pending) this.#flushing = undefined;
	}

	snapshot(): Snapshot | null {
		const header = this.storage.kv.get<Header>("snapshot");
		return header ? { ...header, bytes: this.#tree("committed") } : null;
	}
	ephemeral(): ArrayBuffer {
		return this.#tree("ephemeral");
	}
	commit(value: SnapshotWrite | null, previous: Snapshot | null, ephemeral: ArrayBuffer): Snapshot {
		this.#drain();
		return this.storage.transactionSync(() => {
			const current = this.storage.kv.get<Header>("snapshot");
			if (current?.etag !== previous?.etag) throw new HttpError(409, "Workspace changed while saving.");
			this.#replace("ephemeral", ephemeral, "ephemeral");
			if (value) {
				this.#replace("committed", value.bytes);
				const header: Header = {
					release: value.release,
					revision: value.revision,
					createdAt: value.createdAt,
					etag: crypto.randomUUID(),
				};
				this.storage.kv.put("snapshot", header);
				return { ...header, bytes: value.bytes };
			}
			if (!previous) throw new HttpError(503, "Instance has no committed state.");
			return previous;
		});
	}
	async read(hash: string): Promise<ArrayBuffer> {
		await this.#flushing;
		const pending = this.#pending.get(`block:${hash}`);
		if (pending) return pending.bytes.slice(0);
		const row = this.storage.sql
			.exec<{ data: ArrayBuffer }>("SELECT data FROM instance_blocks WHERE hash = ?", hash)
			.toArray()[0];
		if (!row || (await digest(row.data)) !== hash)
			throw new HttpError(503, "File block is missing or corrupt.");
		return row.data;
	}
	async write(bytes: ArrayBuffer): Promise<string> {
		if (bytes.byteLength > BLOCK_BYTES) throw new HttpError(413, "File block is too large.");
		const hash = await digest(bytes);
		this.#maybeCollectable = true;
		await this.#stage(`block:${hash}`, { kind: "block", hash, bytes });
		return hash;
	}
	lease(file: FileReference): () => void {
		const owner = crypto.randomUUID();
		this.#maybeCollectable = true;
		this.storage.transactionSync(() => {
			for (const block of file.blocks) if (block) this.#pin(owner, block.hash);
			// A crashed download must not retain blocks forever.
			this.storage.sql.exec("INSERT INTO instance_leases VALUES (?, ?)", owner, Date.now() + 86400000);
		});
		return () =>
			this.storage.transactionSync(() => {
				this.storage.sql.exec("DELETE FROM instance_roots WHERE owner = ?", owner);
				this.storage.sql.exec("DELETE FROM instance_leases WHERE owner = ?", owner);
			});
	}
	needsCollection(): boolean {
		if (!this.#maybeCollectable) return false;
		this.#maybeCollectable =
			this.storage.sql.exec("SELECT 1 FROM instance_leases LIMIT 1").toArray().length > 0 ||
			this.storage.sql
				.exec(
					"SELECT 1 FROM instance_blocks WHERE NOT EXISTS (SELECT 1 FROM instance_roots WHERE instance_roots.hash = instance_blocks.hash) LIMIT 1",
				)
				.toArray().length > 0;
		return this.#maybeCollectable;
	}

	collect(now = Date.now()): void {
		this.#drain();
		this.storage.transactionSync(() => {
			this.storage.sql.exec(
				"DELETE FROM instance_roots WHERE owner IN (SELECT owner FROM instance_leases WHERE expires <= ?)",
				now,
			);
			this.storage.sql.exec("DELETE FROM instance_leases WHERE expires <= ?", now);
			// Grace covers staged writes; live downloads are retained explicitly by leases.
			this.storage.sql.exec(
				"DELETE FROM instance_blocks WHERE created < ? AND NOT EXISTS (SELECT 1 FROM instance_roots WHERE instance_roots.hash = instance_blocks.hash)",
				now - 3600000,
			);
		});
	}
}
