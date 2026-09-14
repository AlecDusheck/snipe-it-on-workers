import { DurableObject } from "cloudflare:workers";
import { InstanceStorage } from "../../src/instance-storage";
import { record, HttpError } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";
import { encodeFiles } from "@simplyalec/laravel-cf-workers-laravel-runtime/files";
import { errorResponse } from "../../src/http";
import { TenantDirectory } from "../../src/directory";
import type { Snapshot, TenantDescriptor } from "../../src/types";
import { TenantBlocks } from "../../src/blocks";

export class StorageFixture extends DurableObject {
	flushes = 0;
	readonly store = new InstanceStorage(
		new Proxy(this.ctx.storage, {
			get: (target, key) => {
				if (key === "sync")
					return () => {
						this.flushes++;
						return target.sync();
					};
				const value: unknown = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}),
	);
	readonly leases = new Map<string, () => void>();
	override async fetch(request: Request): Promise<Response> {
		try {
			const store = this.store;
			if (request.method === "GET") {
				const snapshot = store.snapshot();
				return Response.json(
					snapshot
						? {
								...snapshot,
								bytes: Array.from(new Uint8Array(snapshot.bytes)),
								ephemeral: Array.from(new Uint8Array(store.ephemeral())),
							}
						: null,
				);
			}
			const input: unknown = await request.json();
			if (!record(input)) throw new HttpError(400, "Invalid fixture");
			if (input.op === "batch") {
				const before = this.flushes;
				const hashes = await Promise.all(
					Array.from({ length: 10 }, (_, index) => store.write(new Uint8Array(65536).fill(index).buffer)),
				);
				const reads = await Promise.all(hashes.map((hash) => store.read(hash)));
				await store.flush();
				return Response.json({
					flushes: this.flushes - before,
					values: reads.map((bytes) => new Uint8Array(bytes)[0]),
				});
			}
			if (input.op === "source-batch") {
				const before = this.flushes;
				using blocks = new TenantBlocks(store);
				for (let index = 0; index < 64; index++) {
					await blocks.writeSource("a".repeat(64), `file-${index}`, new Uint8Array([index]).buffer);
				}
				const values = [];
				for (let index = 0; index < 64; index++) {
					const bytes = await blocks.readSource("a".repeat(64), `file-${index}`);
					values.push(bytes ? new Uint8Array(bytes)[0] : null);
				}
				await blocks.flush();
				return Response.json({ flushes: this.flushes - before, values });
			}
			if (input.op === "cache") {
				const namespace = String(input.namespace ?? "a".repeat(64));
				if (typeof input.value === "number") {
					const hash = await store.write(new Uint8Array([input.value]).buffer);
					const bytes = encodeFiles({
						format: "laravel-files/1",
						files: { [`/php-opcache/${namespace}/code.bin`]: { size: 1, blocks: [{ hash, length: 1 }] } },
					});
					await store.flush();
					const before = this.ctx.storage.sql
						.exec<{ changes: number }>("SELECT total_changes() AS changes")
						.one().changes;
					await store.writeCodeCache(namespace, bytes);
					const after = this.ctx.storage.sql
						.exec<{ changes: number }>("SELECT total_changes() AS changes")
						.one().changes;
					return Response.json({ hash, changes: after - before });
				}
				return Response.json({ bytes: (await store.readCodeCache(namespace)).byteLength });
			}
			if (input.op === "source" && typeof input.archive === "string" && typeof input.path === "string") {
				using blocks = new TenantBlocks(store);
				if (input.closed === true) blocks[Symbol.dispose]();
				if (typeof input.size === "number")
					await blocks.writeSource(
						input.archive,
						input.path,
						new Uint8Array(input.size).fill(Number(input.value ?? 1)).buffer,
					);
				const bytes = await blocks.readSource(input.archive, input.path);
				return Response.json(bytes ? { size: bytes.byteLength, first: new Uint8Array(bytes)[0] } : null);
			}
			if (input.op === "write" && typeof input.value === "number")
				return Response.json(await store.write(new Uint8Array([input.value]).buffer));
			if (input.op === "read" && typeof input.hash === "string")
				return Response.json(Array.from(new Uint8Array(await store.read(input.hash))));
			if (input.op === "collect" && typeof input.now === "number") {
				store.collect(input.now);
				return Response.json({ pending: store.needsCollection() });
			}
			if (input.op === "lease" && typeof input.hash === "string") {
				this.leases.set(input.hash, store.lease({ size: 1, blocks: [{ hash: input.hash, length: 1 }] }));
				return new Response("leased");
			}
			if (input.op === "release" && typeof input.hash === "string") {
				this.leases.get(input.hash)?.();
				return new Response("released");
			}
			if (input.op === "corrupt" && typeof input.hash === "string") {
				this.ctx.storage.sql.exec(
					"UPDATE instance_blocks SET data = ? WHERE hash = ?",
					new Uint8Array([0]).buffer,
					input.hash,
				);
				return new Response("corrupted");
			}
			let previous: Snapshot | null = store.snapshot();
			if (input.etag === null) previous = null;
			else if (typeof input.etag === "string" && previous) previous = { ...previous, etag: input.etag };
			if (
				typeof input.value !== "number" ||
				typeof input.revision !== "number" ||
				typeof input.release !== "string"
			)
				throw new HttpError(400, "Invalid fixture");
			const bytes =
				typeof input.hash === "string"
					? encodeFiles({
							format: "laravel-files/1",
							files: {
								"/app/database/database.sqlite": { size: 1, blocks: [{ hash: input.hash, length: 1 }] },
							},
						})
					: new Uint8Array([input.value]).buffer;
			store.commit(
				input.op === "ephemeral"
					? null
					: { bytes, revision: input.revision, release: input.release, createdAt: "2026-09-09T00:00:00Z" },
				previous,
				new Uint8Array([input.value]).buffer,
			);
			return new Response("saved");
		} catch (error) {
			return errorResponse(error);
		} finally {
			await this.store.flush();
		}
	}
}
export default {
	async fetch(request, env) {
		try {
			const url = new URL(request.url);
			if (url.pathname === "/directory") {
				const directory = new TenantDirectory(env.DIRECTORY);
				if (request.method === "POST")
					for (const descriptor of await request.json<TenantDescriptor[]>())
						await directory.register(descriptor);
				return Response.json(await directory.list(url.searchParams.get("cursor")));
			}
			if (url.pathname === "/route") {
				const directory = new TenantDirectory(env.DIRECTORY);
				const slug = url.searchParams.get("slug") ?? "test";
				const origin = url.searchParams.get("origin") ?? "https://example.test";
				if (request.method === "PUT") await directory.setUrl(slug, origin);
				if (request.method === "POST") await directory.reserve(slug, origin);
				return Response.json(await directory.resolve(origin));
			}
			return env.INSTANCES.getByName(url.searchParams.get("tenant") ?? "test").fetch(request);
		} catch (error) {
			return errorResponse(error);
		}
	},
} satisfies ExportedHandler<{ DIRECTORY: KVNamespace; INSTANCES: DurableObjectNamespace<StorageFixture> }>;
