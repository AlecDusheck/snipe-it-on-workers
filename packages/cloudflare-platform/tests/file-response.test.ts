import { test } from "node:test";
import assert from "node:assert/strict";
import { fileResponse } from "../src/file-response";
import { fileStream } from "@simplyalec/laravel-cf-workers-laravel-runtime/stream";
import { digest } from "@simplyalec/laravel-cf-workers-laravel-runtime/crypto";
import { BLOCK_BYTES } from "@simplyalec/laravel-cf-workers-laravel-runtime/files";
import type { BlockStorage, FileReference } from "@simplyalec/laravel-cf-workers-laravel-runtime/files";
import { toResponse } from "../src/http";

test("response streams read ahead within the lookahead, handle sparse blocks, cancellation, HEAD and validators", async () => {
	const data = new Uint8Array(BLOCK_BYTES).fill(23).buffer;
	const hash = await digest(data);
	let reads = 0;
	const storage: BlockStorage = {
		read: async () => {
			reads++;
			return data;
		},
		write: async () => {
			throw new Error("Unexpected write");
		},
	};
	const file: FileReference = { size: BLOCK_BYTES + 4, blocks: [{ hash, length: BLOCK_BYTES }, null] };
	const stream = fileStream(file, storage);
	assert.equal(reads, 0);
	const reader = stream.getReader();
	assert.equal((await reader.read()).value?.length, BLOCK_BYTES);
	assert.equal(reads, 1);
	assert.deepEqual((await reader.read()).value, new Uint8Array(4));
	assert.equal((await reader.read()).done, true);
	assert.equal(reads, 1);
	await fileStream(file, storage).cancel();
	const head = fileResponse(
		file,
		storage,
		new Request("https://x/photo.png", { method: "HEAD" }),
		"photo.png",
	);
	assert.equal(head.headers.get("content-type"), "image/png");
	assert.equal(head.headers.get("content-length"), String(file.size));
	assert.equal(head.headers.get("cache-control"), "private, no-cache");
	assert.equal(await head.text(), "");
	const etag = head.headers.get("etag");
	assert.ok(etag);
	const fresh = fileResponse(
		file,
		storage,
		new Request("https://x/photo.png", { headers: { "if-none-match": `W/${etag}` } }),
		"photo.png",
	);
	assert.equal(fresh.status, 304);
	let done = 0;
	const full = fileResponse(file, storage, new Request("https://x/photo.png"), "photo.png", () => done++);
	assert.equal((await full.arrayBuffer()).byteLength, file.size);
	assert.equal(done, 1);
});

test("corrupt blocks fail the response stream without returning corrupted data", async () => {
	const storage: BlockStorage = { read: async () => new Uint8Array([2]).buffer, write: async () => "" };
	const file: FileReference = { size: 1, blocks: [{ hash: await digest(new Uint8Array([1])), length: 1 }] };
	await assert.rejects(() => new Response(fileStream(file, storage)).arrayBuffer(), /checksum/);
});

test("native streamed responses retain status and disposition without exposing a storage URL", async () => {
	const file: FileReference = { size: 3, blocks: [null] };
	const storage: BlockStorage = {
		read: async () => {
			throw new Error("Unexpected read");
		},
		write: async () => "",
	};
	const response = toResponse(
		{ status: 200, headers: [["content-disposition", "attachment; filename=export.csv"]], body: "", file },
		"GET",
		storage,
	);
	assert.equal(response.headers.get("content-disposition"), "attachment; filename=export.csv");
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(response.headers.get("content-length"), "3");
	assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array(3));
});
