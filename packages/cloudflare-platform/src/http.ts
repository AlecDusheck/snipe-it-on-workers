import { fileStream } from "@simplyalec/laravel-cf-workers-laravel-runtime/stream";
import type { BlockStorage } from "@simplyalec/laravel-cf-workers-laravel-runtime/files";
import * as v from "valibot";
import { fromBase64 } from "@simplyalec/laravel-cf-workers-laravel-runtime/crypto";
import { HttpError, describeError, parse } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";
import type { HttpInput, HttpOutput } from "@simplyalec/laravel-cf-workers-laravel-runtime/types";
import { DEFAULT_REQUEST_MIB, MIB } from "./policy";

export const etagsMatch = (header: string | null, etag: string): boolean =>
	header !== null && header.split(",").some((value) => value.trim().replace(/^W\//, "") === etag);

export async function readBody(
	request: Request,
	limit = DEFAULT_REQUEST_MIB * MIB,
): Promise<Uint8Array<ArrayBuffer>> {
	const declared = request.headers.get("content-length");
	if (declared && Number(declared) > limit) throw new HttpError(413, "Request is too large.");
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const expected = declared !== null && /^\d+$/.test(declared) ? Number(declared) : undefined;
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (let part = await reader.read(); !part.done; part = await reader.read()) {
			length += part.value.byteLength;
			if (length > limit || (expected !== undefined && length > expected)) {
				await reader.cancel();
				if (length > limit) throw new HttpError(413, "Request is too large.");
				throw new HttpError(400, "Request length does not match Content-Length.");
			}
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	if (expected !== undefined && length !== expected)
		throw new HttpError(400, "Request length does not match Content-Length.");
	const result = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

export async function toHttpInput(request: Request, limit = DEFAULT_REQUEST_MIB * MIB): Promise<HttpInput> {
	const method = parse(
		v.picklist(["GET", "POST", "HEAD", "OPTIONS", "PATCH", "PUT", "DELETE"]),
		request.method,
		405,
		"Unsupported HTTP method.",
	);
	const headers: [string, string][] = [];
	const excluded = new Set([
		"connection",
		"keep-alive",
		"proxy",
		"proxy-authenticate",
		"proxy-authorization",
		"te",
		"trailer",
		"transfer-encoding",
		"upgrade",
		"host",
		"content-length",
		"forwarded",
		"x-real-ip",
		...(request.headers.get("connection") ?? "")
			.toLowerCase()
			.split(",")
			.map((value) => value.trim()),
	]);
	// Transport and proxy metadata belong to the adapter; framework headers pass through.
	for (const [name, value] of request.headers) {
		const canonical = name.replaceAll("_", "-");
		if (excluded.has(name) || excluded.has(canonical) || /^(?:x-forwarded-|x-platform-|cf-)/.test(canonical))
			continue;
		headers.push([name, value]);
	}
	const ip = request.headers.get("cf-connecting-ip");
	if (ip) headers.push(["x-platform-client-ip", ip]);
	const body = (await readBody(request, limit)).buffer;
	headers.push(["content-length", String(body.byteLength)]);
	return { url: request.url, method, headers, body };
}

export function toResponse(
	output: HttpOutput,
	method: string,
	storage?: BlockStorage,
	onDone?: () => void,
): Response {
	const headers = new Headers();
	for (const [name, value] of output.headers) {
		if (
			(method === "HEAD" && name.toLowerCase() === "content-length") ||
			!["content-length", "transfer-encoding", "connection", "content-encoding"].includes(name.toLowerCase())
		)
			headers.append(name, value);
	}
	headers.set("cache-control", "private, no-store");
	headers.set("x-content-type-options", "nosniff");
	if (output.file && !storage) throw new Error("Response file storage is missing");
	if (output.file && method !== "HEAD") headers.set("content-length", String(output.file.size));
	const empty = method === "HEAD" || [204, 205, 304].includes(output.status);
	if (empty || !output.file) onDone?.();
	return new Response(
		empty
			? null
			: output.file && storage
				? fileStream(output.file, storage, onDone)
				: fromBase64(output.body),
		{ status: output.status, headers },
	);
}

export function errorResponse(error: unknown): Response {
	// Unexpected failures are logged for operators; clients only see a generic retry message.
	if (!(error instanceof HttpError)) console.error("Request failed", error);
	const { status, message } = describeError(error, "The request could not be completed. Please retry.");
	return Response.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}
