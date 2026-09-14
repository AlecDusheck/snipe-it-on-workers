import { fileStream } from "@simplyalec/laravel-cf-workers-laravel-runtime/stream";
import { lookup } from "mrmime";
import type { BlockStorage, FileReference } from "@simplyalec/laravel-cf-workers-laravel-runtime/files";
import { etagsMatch } from "./http";

/** A validator derived from the file's block hashes; identical content yields an identical tag. */
export function fileEtag(file: FileReference): string {
	let hash = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(
		`${file.size}:${file.blocks.map((b) => b?.hash ?? "0").join(",")}`,
	)) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `"${file.size.toString(16)}-${hash.toString(16)}"`;
}

// Downloads outlive runtime RPC and require a separate block capability.
export function fileResponse(
	file: FileReference,
	storage: BlockStorage,
	request: Request,
	path: string,
	onDone?: () => void,
): Response {
	const etag = fileEtag(file);
	const headers: Record<string, string> = {
		etag,
		"x-content-type-options": "nosniff",
		"cache-control": "private, no-cache",
	};
	if (file.modifiedAt) headers["last-modified"] = new Date(file.modifiedAt).toUTCString();
	if (etagsMatch(request.headers.get("if-none-match"), etag)) {
		onDone?.();
		return new Response(null, { status: 304, headers });
	}
	headers["content-type"] = lookup(path) ?? "application/octet-stream";
	headers["content-length"] = String(file.size);
	if (request.method === "HEAD") {
		onDone?.();
		return new Response(null, { headers });
	}
	return new Response(fileStream(file, storage, onDone), { headers });
}
