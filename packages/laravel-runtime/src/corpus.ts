import { crc32, inflateRawSync } from "node:zlib";
import { record } from "./schema";
import { object, unsupportedMmap } from "./emscripten";
import { safePathSegments, SOURCE_CACHE_ENTRY_BYTES } from "./files";
import type { SourceCache } from "./files";

// Archive entries are stamped 1980 by the packager; matching node times keep derived caches fresh.
const ARCHIVE_TIME = Date.UTC(1980, 0, 1);
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;

export interface CorpusEntry {
	size: number;
	crc: number;
	/** Offset of the entry's local header in the archive. */
	local: number;
	packedSize: number;
	deflated: boolean;
}
/** Every path in the release with its size and checksum; the only part of the corpus the isolate retains. */
export interface CorpusIndex {
	files: Pick<ReadonlyMap<string, CorpusEntry>, "size" | "get" | "has" | "keys" | typeof Symbol.iterator>;
	directories: Pick<ReadonlyMap<string, string[]>, "keys" | "get" | "has">;
	byteLength?: number;
}
export interface CorpusFilesystem {
	mkdirTree(path: string): void;
	lookupPath(path: string): { node: object };
	isDir(mode: number): boolean;
}
const FILE_MODE = 0o100444;
const DIRECTORY_MODE = 0o040755;
export type ArchiveRange = (offset: number, length: number) => Promise<Uint8Array>;

// Accept only authenticated release archives, never uploaded ZIPs.
export function indexArchive(bytes: Uint8Array): CorpusIndex {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const u16 = (offset: number): number => view.getUint16(offset, true);
	const u32 = (offset: number): number => view.getUint32(offset, true);
	const minimum = Math.max(0, bytes.length - 65557);
	let end = bytes.length - 22;
	while (end >= minimum && u32(end) !== 0x06054b50) end--;
	if (end < minimum) throw new Error("ZIP directory missing");
	let cursor = u32(end + 16);
	const count = u16(end + 10);
	const files = new Map<string, CorpusEntry>();
	const directories = new Map<string, string[]>();
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
	const addChild = (path: string): void => {
		const slash = path.lastIndexOf("/");
		const parent = slash < 0 ? "" : path.slice(0, slash);
		const children = directories.get(parent);
		if (children) children.push(path.slice(slash + 1));
		else {
			directories.set(parent, [path.slice(slash + 1)]);
			if (parent) addChild(parent);
		}
	};
	for (let i = 0; i < count; i++) {
		if (u32(cursor) !== 0x02014b50) throw new Error("Invalid ZIP directory entry");
		const compression = u16(cursor + 10);
		const crc = u32(cursor + 16);
		const packedSize = u32(cursor + 20);
		const size = u32(cursor + 24);
		const nameLength = u16(cursor + 28);
		const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
		const local = u32(cursor + 42);
		cursor += 46 + nameLength + u16(cursor + 30) + u16(cursor + 32);
		if (!name || name.startsWith("/") || !safePathSegments(name)) throw new Error("Unsafe archive path");
		if (![0, 8].includes(compression) || size > MAX_ENTRY_BYTES) throw new Error("Unsupported archive entry");
		if (local + 30 > bytes.length) throw new Error("Truncated archive entry");
		if (name.endsWith("/")) {
			const path = name.slice(0, -1);
			if (!directories.has(path)) {
				directories.set(path, []);
				addChild(path);
			}
			continue;
		}
		if (files.has(name)) throw new Error("Unsafe archive path");
		files.set(name, { size, crc, local, packedSize, deflated: compression === 8 });
		addChild(name);
	}
	return { files, directories };
}

// Inflated files are retained within a byte budget so the isolate never holds the whole corpus.
class EntryCache {
	#entries = new Map<string, Uint8Array>();
	#bytes = 0;
	constructor(private readonly budget: number) {}
	get bytes(): number {
		return this.#bytes;
	}
	get(path: string): Uint8Array | undefined {
		const cached = this.#entries.get(path);
		if (cached) {
			this.#entries.delete(path);
			this.#entries.set(path, cached);
		}
		return cached;
	}
	set(path: string, contents: Uint8Array): void {
		this.#bytes -= this.#entries.get(path)?.length ?? 0;
		this.#entries.delete(path);
		this.#entries.set(path, contents);
		this.#bytes += contents.length;
		for (const [key, value] of this.#entries) {
			if (this.#bytes <= this.budget || key === path) break;
			this.#entries.delete(key);
			this.#bytes -= value.length;
		}
	}
}

function payloadStart(entry: CorpusEntry, header: Uint8Array): number {
	const view = new DataView(header.buffer, header.byteOffset, 30);
	if (view.getUint32(0, true) !== 0x04034b50) throw new Error("Invalid ZIP local header");
	return entry.local + 30 + view.getUint16(26, true) + view.getUint16(28, true);
}

/** Lazy archive mount: nodes on first lookup, contents via the async read hook, bounded inflate cache. */
export class Corpus {
	#cache: EntryCache;
	#nodes = new Map<object, string>();
	#materialized = new Set<string>();
	#loading = new Map<string, Promise<Uint8Array>>();
	#stats = { files: 0, inflatedFiles: 0, inflatedBytes: 0, fetches: 0 };
	constructor(
		private readonly fs: CorpusFilesystem,
		readonly index: CorpusIndex,
		private readonly range: ArchiveRange,
		private readonly sourceCache?: { storage: SourceCache; archive: string },
		root = "/app",
		cacheBudget = 1024 * 1024,
	) {
		this.#cache = new EntryCache(cacheBudget);
		fs.mkdirTree(root);
		this.#attachDirectory(root, "");
	}
	setStorage(storage: SourceCache): void {
		if (this.sourceCache) this.sourceCache.storage = storage;
	}
	get cachedBytes(): number {
		return this.#cache.bytes;
	}
	get stats(): { files: number; inflatedFiles: number; inflatedBytes: number; fetches: number } {
		return { ...this.#stats, files: this.index.files.size };
	}
	owns(stream: unknown): boolean {
		const input = object(stream);
		return record(input.node) && this.#nodes.has(input.node);
	}
	/** Ensures the stream's file is loaded before the native read runs. */
	async prepare(stream: unknown): Promise<void> {
		const input = object(stream);
		const path = record(input.node) ? this.#nodes.get(input.node) : undefined;
		if (path === undefined) return;
		if (this.#cache.get(path)) return;
		let pending = this.#loading.get(path);
		if (!pending) {
			pending = this.#load(path).finally(() => this.#loading.delete(path));
			this.#loading.set(path, pending);
		}
		await pending;
	}
	async #load(path: string): Promise<Uint8Array> {
		const entry = this.index.files.get(path);
		if (!entry) throw new Error("Unknown corpus entry");
		const contents = await this.#fetch(path, entry);
		this.#stats.inflatedFiles++;
		this.#stats.inflatedBytes += entry.size;
		this.#cache.set(path, contents);
		return contents;
	}
	async #fetch(path: string, entry: CorpusEntry): Promise<Uint8Array> {
		const cached =
			entry.packedSize <= SOURCE_CACHE_ENTRY_BYTES && this.sourceCache
				? await this.sourceCache.storage.readSource(this.sourceCache.archive, path)
				: null;
		const unpack = (packed: Uint8Array): Uint8Array => {
			const contents = entry.deflated ? inflateRawSync(packed, { maxOutputLength: MAX_ENTRY_BYTES }) : packed;
			if (contents.length !== entry.size || crc32(contents) !== entry.crc)
				throw new Error("Corrupt archive entry");
			return contents;
		};
		if (cached && cached.byteLength === entry.packedSize) {
			try {
				return unpack(new Uint8Array(cached));
			} catch {
				/* Disposable cache corruption falls back to the verified release archive. */
			}
		}
		this.#stats.fetches++;
		const start = payloadStart(entry, await this.range(entry.local, 30));
		const packed = await this.range(start, entry.packedSize);
		const contents = unpack(packed);
		if (this.sourceCache && packed.byteLength <= SOURCE_CACHE_ENTRY_BYTES)
			await this.sourceCache.storage.writeSource(
				this.sourceCache.archive,
				path,
				Uint8Array.from(packed).buffer,
			);
		return contents;
	}

	#attachDirectory(path: string, entry: string): void {
		const node = this.fs.lookupPath(path).node;
		const raw = object(node);
		const operations = object(raw.node_ops);
		const lookup = operations.lookup;
		const readdir = operations.readdir;
		const mknod = operations.mknod;
		if (typeof lookup !== "function" || typeof readdir !== "function" || typeof mknod !== "function")
			throw new Error("Filesystem directory hooks are unavailable");
		const child = (name: string): string => (entry ? `${entry}/${name}` : name);
		// Nodes are created through the original mknod so wrappers added by other layers never see them.
		const create = (name: string, mode: number): object => {
			const created: unknown = Reflect.apply(mknod, operations, [node, name, mode, 0]);
			if (!record(created)) throw new Error("Filesystem did not create a node");
			Object.assign(created, { atime: ARCHIVE_TIME, mtime: ARCHIVE_TIME, ctime: ARCHIVE_TIME });
			return created;
		};
		raw.node_ops = {
			...operations,
			lookup: (parent: unknown, name: string): unknown => {
				const target = child(name);
				if (!this.#materialized.has(target)) {
					if (this.index.files.has(target)) return this.#materializeFile(create, name, target);
					if (this.index.directories.has(target))
						return this.#materializeDirectory(create, path, name, target);
				}
				return Reflect.apply(lookup, operations, [parent, name]);
			},
			readdir: (directory: unknown): string[] => {
				const listed: unknown = Reflect.apply(readdir, operations, [directory]);
				const names = new Set(Array.isArray(listed) ? listed.map(String) : []);
				for (const name of this.index.directories.get(entry) ?? [])
					if (!this.#materialized.has(child(name))) names.add(name);
				return [...names];
			},
			mknod: (parent: unknown, name: string, mode: number, dev: number): unknown => {
				const created: unknown = Reflect.apply(mknod, operations, [parent, name, mode, dev]);
				const target = child(name);
				this.#materialized.add(target);
				if (this.fs.isDir(mode) && this.index.directories.has(target))
					this.#attachDirectory(`${path}/${name}`, target);
				return created;
			},
		};
	}
	#materializeDirectory(
		create: (name: string, mode: number) => object,
		parent: string,
		name: string,
		entry: string,
	): object {
		this.#materialized.add(entry);
		const node = create(name, DIRECTORY_MODE);
		this.#attachDirectory(`${parent}/${name}`, entry);
		return node;
	}
	#materializeFile(create: (name: string, mode: number) => object, name: string, entry: string): object {
		const details = this.index.files.get(entry);
		if (!details) throw new Error("Unknown corpus entry");
		this.#materialized.add(entry);
		const node = create(name, FILE_MODE);
		const raw = object(node);
		Object.defineProperty(node, "usedBytes", { value: details.size, writable: true, configurable: true });
		Object.defineProperty(node, "contents", {
			configurable: true,
			get: () => {
				const contents = this.#cache.get(entry);
				if (!contents) throw new Error("Corpus entry was read before it was loaded");
				return contents;
			},
		});
		raw.stream_ops = {
			...object(raw.stream_ops),
			mmap: unsupportedMmap,
		};
		this.#nodes.set(node, entry);
		this.#stats.files++;
		return node;
	}
}
