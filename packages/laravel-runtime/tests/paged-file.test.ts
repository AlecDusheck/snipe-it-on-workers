import { test } from "node:test";
import assert from "node:assert/strict";
import { PageCache } from "../src/paged-file";
import { BLOCK_BYTES } from "../src/files";
import { digest } from "../src/crypto";
import type { BlockStorage } from "../src/files";

class Blocks implements BlockStorage {
	readonly data = new Map<string, ArrayBuffer>();
	reads = 0;
	failWrite = false;
	corrupt = false;
	async read(hash: string) {
		this.reads++;
		const value = this.data.get(hash);
		if (!value) throw new Error("Missing block");
		return this.corrupt ? new ArrayBuffer(value.byteLength) : value.slice(0);
	}
	async write(bytes: ArrayBuffer) {
		if (this.failWrite) throw new Error("Injected storage failure");
		const hash = await digest(bytes);
		this.data.set(hash, bytes.slice(0));
		return hash;
	}
}

test("dirty eviction, immutable blocks and restart preserve a file with bounded cache", async () => {
	const blocks = new Blocks();
	const cache = new PageCache(blocks, 2);
	const file = cache.file({ size: 0, blocks: [] });
	for (let index = 0; index < 100; index++) {
		await file.prepare(index * BLOCK_BYTES, BLOCK_BYTES);
		file.write(new Uint8Array(BLOCK_BYTES).fill(index), 0, BLOCK_BYTES, index * BLOCK_BYTES);
		assert.ok(cache.pages.size <= 2);
	}
	await cache.flush();
	const restarted = new PageCache(blocks, 2).file(file.reference());
	for (const index of [0, 99, 1, 70, 44]) {
		await restarted.prepare(index * BLOCK_BYTES, BLOCK_BYTES);
		const bytes = new Uint8Array(BLOCK_BYTES);
		assert.equal(restarted.read(bytes, 0, bytes.length, index * BLOCK_BYTES), BLOCK_BYTES);
		assert.ok(bytes.every((value) => value === index));
	}
});

test("shrink then regrow never exposes old bytes, including an evicted boundary page", async () => {
	const storage = new Blocks();
	const cache = new PageCache(storage, 1);
	const file = cache.file({ size: 0, blocks: [] });
	for (const offset of [0, BLOCK_BYTES]) {
		await file.prepare(offset, BLOCK_BYTES);
		file.write(new Uint8Array(BLOCK_BYTES).fill(91), 0, BLOCK_BYTES, offset);
	}
	await cache.flush();
	file.truncate(13);
	file.truncate(4 * BLOCK_BYTES);
	await cache.flush();
	const restarted = new PageCache(storage, 1).file(file.reference());
	await restarted.prepare(0, BLOCK_BYTES);
	const bytes = new Uint8Array(BLOCK_BYTES);
	restarted.read(bytes, 0, bytes.length, 0);
	assert.ok(bytes.subarray(0, 13).every((value) => value === 91));
	assert.ok(bytes.subarray(13).every((value) => value === 0));
	await restarted.prepare(3 * BLOCK_BYTES, BLOCK_BYTES);
	restarted.read(bytes, 0, bytes.length, 3 * BLOCK_BYTES);
	assert.ok(bytes.every((value) => value === 0));
});

test("a sparse 256 MiB file uses one resident page and stores only the written block", async () => {
	const storage = new Blocks();
	const cache = new PageCache(storage, 2);
	const file = cache.file({ size: 0, blocks: [] });
	file.truncate(256 * 1024 * 1024);
	const offset = file.size - 4;
	await file.prepare(offset, 4);
	file.write(new Uint8Array([1, 2, 3, 4]), 0, 4, offset);
	await cache.flush();
	assert.equal(cache.pages.size, 1);
	assert.equal(storage.data.size, 1);
	assert.equal(file.reference().blocks.filter(Boolean).length, 1);
});

test("failed eviction cannot acknowledge a staged write or discard the dirty page", async () => {
	const storage = new Blocks();
	const cache = new PageCache(storage, 1);
	const file = cache.file({ size: 0, blocks: [] });
	await file.prepare(0, 4);
	file.write(new Uint8Array([1, 2, 3, 4]), 0, 4, 0);
	storage.failWrite = true;
	await assert.rejects(() => file.prepare(BLOCK_BYTES, 4));
	assert.equal(file.reference().blocks[0], null);
	assert.equal(cache.pages.size, 1);
	storage.failWrite = false;
	await cache.flush();
	assert.equal(storage.data.size, 1);
});

test("corrupt stored blocks fail checksum verification before exposing bytes", async () => {
	const storage = new Blocks();
	const hash = await storage.write(new Uint8Array(BLOCK_BYTES).fill(17).buffer);
	storage.corrupt = true;
	const cache = new PageCache(storage, 1);
	const file = cache.file({ size: BLOCK_BYTES, blocks: [{ hash, length: BLOCK_BYTES }] });
	await assert.rejects(() => file.prepare(0, 1), /checksum/);
	assert.equal(cache.pages.size, 0);
});

test("flush and request reset share one budget with verified block copies", async () => {
	const storage = new Blocks();
	const cache = new PageCache(storage, 4);
	const file = cache.file({ size: 0, blocks: [] });
	for (let index = 0; index < 12; index++) {
		await file.prepare(index * BLOCK_BYTES, BLOCK_BYTES);
		file.write(new Uint8Array(BLOCK_BYTES).fill(index), 0, BLOCK_BYTES, index * BLOCK_BYTES);
		assert.ok(cache.retainedBytes <= 4 * BLOCK_BYTES);
	}
	await cache.flush();
	assert.ok(cache.retainedBytes <= 4 * BLOCK_BYTES);
	const reference = file.reference();
	cache.reset(storage);
	assert.ok(cache.retainedBytes <= 4 * BLOCK_BYTES);
	const restored = cache.file(reference);
	for (let index = 0; index < 12; index++) {
		await restored.prepare(index * BLOCK_BYTES, BLOCK_BYTES);
		const bytes = new Uint8Array(BLOCK_BYTES);
		restored.read(bytes, 0, bytes.length, index * BLOCK_BYTES);
		assert.ok(bytes.every((byte) => byte === index));
		assert.ok(cache.retainedBytes <= 4 * BLOCK_BYTES);
	}
});
