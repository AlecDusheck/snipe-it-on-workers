import { RpcTarget } from "cloudflare:workers";
import {
	BLOCK_BYTES,
	MAX_MANIFEST_BYTES,
	SOURCE_CACHE_ENTRY_BYTES,
	safePathSegments,
} from "@simplyalec/laravel-cf-workers-laravel-runtime/files";
import type { RuntimeStorage } from "@simplyalec/laravel-cf-workers-laravel-runtime/files";
import { DIGEST_PATTERN } from "@simplyalec/laravel-cf-workers-laravel-runtime/crypto";

// PHP receives block access only; publishing snapshots remains a parent capability.
export class TenantBlocks extends RpcTarget implements RuntimeStorage {
	#storage: RuntimeStorage;
	#closed = false;
	constructor(storage: RuntimeStorage) {
		super();
		this.#storage = storage;
	}
	[Symbol.dispose](): void {
		this.#closed = true;
	}
	async read(hash: string): Promise<ArrayBuffer> {
		if (this.#closed) throw new Error("File capability has expired");
		if (!DIGEST_PATTERN.test(hash)) throw new Error("Invalid block hash");
		return this.#storage.read(hash);
	}
	async write(bytes: ArrayBuffer): Promise<string> {
		if (this.#closed) throw new Error("File capability has expired");
		if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > BLOCK_BYTES)
			throw new Error("Invalid file block");
		return this.#storage.write(bytes);
	}
	async flush(): Promise<void> {
		if (this.#closed) throw new Error("File capability has expired");
		return this.#storage.flush();
	}
	async readCodeCache(namespace: string): Promise<ArrayBuffer> {
		this.#namespace(namespace);
		return this.#storage.readCodeCache(namespace);
	}
	async writeCodeCache(namespace: string, manifest: ArrayBuffer): Promise<void> {
		this.#namespace(namespace);
		if (!(manifest instanceof ArrayBuffer) || manifest.byteLength > MAX_MANIFEST_BYTES)
			throw new Error("Invalid code cache manifest");
		return this.#storage.writeCodeCache(namespace, manifest);
	}
	#namespace(archive: string): void {
		if (this.#closed) throw new Error("File capability has expired");
		if (!DIGEST_PATTERN.test(archive)) throw new Error("Invalid cache namespace");
	}
	#source(archive: string, path: string): void {
		this.#namespace(archive);
		if (!path || path.startsWith("/") || !safePathSegments(path)) throw new Error("Invalid source cache key");
	}
	async readSource(archive: string, path: string): Promise<ArrayBuffer | null> {
		this.#source(archive, path);
		return this.#storage.readSource(archive, path);
	}
	async writeSource(archive: string, path: string, bytes: ArrayBuffer): Promise<void> {
		this.#source(archive, path);
		if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > SOURCE_CACHE_ENTRY_BYTES)
			throw new Error("Invalid source cache entry");
		return this.#storage.writeSource(archive, path, bytes);
	}
}
