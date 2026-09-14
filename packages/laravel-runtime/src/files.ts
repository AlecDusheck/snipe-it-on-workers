import * as v from "valibot";
import { HttpError, parse } from "./schema";
import { DIGEST_PATTERN, digest } from "./crypto";

export const BLOCK_BYTES = 64 * 1024;
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
export const DATABASE_PATH = "/app/database/database.sqlite";
export interface BlockReference {
	hash: string;
	length: number;
}
export interface FileReference {
	size: number;
	blocks: (BlockReference | null)[];
	mode?: number;
	modifiedAt?: number;
}
export interface FileManifest {
	format: "laravel-files/1";
	files: Record<string, FileReference>;
	directories?: string[];
}
export interface BlockStorage {
	read(hash: string): Promise<ArrayBuffer>;
	write(bytes: ArrayBuffer): Promise<string>;
}
export const SOURCE_CACHE_ENTRY_BYTES = 256 * 1024;
/** Optional source caching is per file; a boot never downloads the instance's whole working set. */
export interface SourceCache {
	readSource(archive: string, path: string): Promise<ArrayBuffer | null>;
	writeSource(archive: string, path: string, bytes: ArrayBuffer): Promise<void>;
}
export interface RuntimeStorage extends BlockStorage, SourceCache {
	readCodeCache(namespace: string): Promise<ArrayBuffer>;
	writeCodeCache(namespace: string, manifest: ArrayBuffer): Promise<void>;
	flush(): Promise<void>;
}
export const CODE_CACHE_ROOT = "/php-opcache";
/** Ephemeral tree roots: persisted between requests, never versioned with application data. */
export const EPHEMERAL_ROOTS = ["/app/storage/framework/sessions", "/app/storage/framework/cache"];
export const ephemeralPath = (path: string): boolean =>
	EPHEMERAL_ROOTS.some((root) => path.startsWith(root + "/"));
/** In-memory blocks for benchmarks and tests. */
export class MemoryBlockStorage implements RuntimeStorage {
	readonly blocks = new Map<string, ArrayBuffer>();
	readonly sources = new Map<string, ArrayBuffer>();
	#codeCache: { namespace: string; bytes: ArrayBuffer } | undefined;
	async readCodeCache(namespace: string): Promise<ArrayBuffer> {
		return this.#codeCache?.namespace === namespace ? this.#codeCache.bytes.slice(0) : new ArrayBuffer(0);
	}
	async writeCodeCache(namespace: string, bytes: ArrayBuffer): Promise<void> {
		this.#codeCache = { namespace, bytes: bytes.slice(0) };
	}
	async flush(): Promise<void> {}
	async readSource(archive: string, path: string): Promise<ArrayBuffer | null> {
		return this.sources.get(archive + ":" + path)?.slice(0) ?? null;
	}
	async writeSource(archive: string, path: string, bytes: ArrayBuffer): Promise<void> {
		this.sources.set(archive + ":" + path, bytes.slice(0));
	}
	async read(hash: string): Promise<ArrayBuffer> {
		const value = this.blocks.get(hash);
		if (!value) throw new Error("Missing block");
		return value.slice(0);
	}
	async write(bytes: ArrayBuffer): Promise<string> {
		const hash = await digest(bytes);
		this.blocks.set(hash, bytes.slice(0));
		return hash;
	}
}
const magic = new TextEncoder().encode("LARAVEL-FILES/1\n");
export function isFileManifest(bytes: ArrayBuffer): boolean {
	const value = new Uint8Array(bytes);
	return magic.every((byte, index) => value[index] === byte);
}
const blockSchema = v.strictObject({
	hash: v.pipe(v.string(), v.regex(DIGEST_PATTERN)),
	length: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(BLOCK_BYTES)),
});
export const fileSchema = v.pipe(
	v.strictObject({
		size: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
		blocks: v.array(v.nullable(blockSchema)),
		mode: v.exactOptional(v.pipe(v.number(), v.integer(), v.minValue(0))),
		modifiedAt: v.exactOptional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
	}),
	v.check((file) => file.blocks.length === Math.ceil(file.size / BLOCK_BYTES)),
);
export function fileReference(value: unknown): FileReference {
	return parse(fileSchema, value, 503, "Invalid file reference.");
}
export function safePathSegments(path: string): boolean {
	return (
		!path.includes("\\") &&
		!path.includes("\0") &&
		!path.split("/").some((part) => part === "." || part === "..")
	);
}
export function persistentPath(path: string, roots: string[] = ["/app/storage", "/app/public"]): boolean {
	return (
		safePathSegments(path) && (path === DATABASE_PATH || roots.some((root) => path.startsWith(root + "/")))
	);
}
// Blocks are content-addressed; verify the hash and declared length before trusting storage.
export async function readBlock(storage: BlockStorage, block: BlockReference): Promise<Uint8Array> {
	const stored = await storage.read(block.hash);
	if (
		stored.byteLength > BLOCK_BYTES ||
		stored.byteLength < block.length ||
		(await digest(stored)) !== block.hash
	)
		throw new Error("File block checksum failed");
	return new Uint8Array(stored, 0, block.length);
}
/** An empty buffer is the empty ephemeral tree; the committed tree always carries the database. */
export function decodeFiles(
	bytes: ArrayBuffer,
	tree: "committed" | "ephemeral" | "code" = "committed",
): FileManifest {
	if (tree !== "committed" && bytes.byteLength === 0) return { format: "laravel-files/1", files: {} };
	const allowed =
		tree === "code"
			? (path: string) => safePathSegments(path) && path.startsWith(CODE_CACHE_ROOT + "/")
			: persistentPath;
	if (!isFileManifest(bytes) || bytes.byteLength > MAX_MANIFEST_BYTES)
		throw new HttpError(503, "Invalid file manifest.");
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(bytes.slice(magic.length)));
	} catch {
		throw new HttpError(503, "Invalid file manifest.");
	}
	return parse(
		v.pipe(
			v.strictObject({
				format: v.literal("laravel-files/1"),
				files: v.record(v.pipe(v.string(), v.check(allowed)), fileSchema),
				directories: v.exactOptional(
					v.array(
						v.pipe(
							v.string(),
							v.check((path) => allowed(path + "/")),
						),
					),
				),
			}),
			v.check((manifest) => tree !== "committed" || !!manifest.files[DATABASE_PATH]),
		),
		value,
		503,
		"Invalid workspace file manifest.",
	);
}

export function encodeFiles(value: FileManifest): ArrayBuffer {
	const json = new TextEncoder().encode(JSON.stringify(value));
	if (json.length + magic.length > MAX_MANIFEST_BYTES)
		throw new HttpError(413, "Workspace file index exceeds its configured capacity.");
	const bytes = new Uint8Array(magic.length + json.length);
	bytes.set(magic);
	bytes.set(json, magic.length);
	return bytes.buffer;
}
/** Raw SQLite bytes count as one database file; manifests may be passed pre-decoded. */
export function databaseBytes(source: ArrayBuffer | FileManifest): number {
	if (source instanceof ArrayBuffer && !isFileManifest(source)) return source.byteLength;
	const manifest = source instanceof ArrayBuffer ? decodeFiles(source) : source;
	return manifest.files[DATABASE_PATH]?.size ?? 0;
}
export function storageBytes(source: ArrayBuffer | FileManifest): number {
	if (source instanceof ArrayBuffer && !isFileManifest(source)) return source.byteLength;
	const manifest = source instanceof ArrayBuffer ? decodeFiles(source) : source;
	return Object.values(manifest.files).reduce((total, file) => total + file.size, 0);
}
