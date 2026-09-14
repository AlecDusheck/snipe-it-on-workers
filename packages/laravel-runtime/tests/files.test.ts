import { test } from "node:test";
import assert from "node:assert/strict";
import {
	decodeFiles,
	encodeFiles,
	fileReference,
	persistentPath,
	databaseBytes,
	storageBytes,
	BLOCK_BYTES,
	isFileManifest,
} from "../src/files";
import type { FileManifest } from "../src/files";

const manifest: FileManifest = {
	format: "laravel-files/1",
	files: {
		"/app/database/database.sqlite": { size: 10, blocks: [{ hash: "a".repeat(64), length: 10 }] },
		"/app/storage/app/private/attachment": {
			size: BLOCK_BYTES + 4,
			blocks: [null, { hash: "b".repeat(64), length: 4 }],
		},
	},
};
const prefix = new TextEncoder().encode("LARAVEL-FILES/1\n");
test("the application-neutral manifest preserves sparse files and logical usage", () => {
	const bytes = encodeFiles(manifest);
	assert.deepEqual(new Uint8Array(bytes, 0, prefix.length), prefix);
	assert.deepEqual(decodeFiles(bytes), manifest);
	assert.equal(databaseBytes(bytes), 10);
	assert.equal(storageBytes(bytes), BLOCK_BYTES + 14);
});
test("unsupported file manifest versions are rejected", () => {
	const bytes = new Uint8Array(encodeFiles(manifest));
	bytes[prefix.length - 2] = "2".charCodeAt(0);
	assert.equal(isFileManifest(bytes.buffer), false);
	assert.throws(() => decodeFiles(bytes.buffer));
});
for (const path of [
	"/app/storage/../vendor/autoload.php",
	"/app/storage/app/./file",
	"/app/storage/app/back\\slash",
	"/app/storage/app/nul\0",
])
	test(`reject unsafe manifest path: ${JSON.stringify(path)}`, () => {
		assert.throws(() =>
			decodeFiles(
				encodeFiles({ ...manifest, files: { ...manifest.files, [path]: { size: 0, blocks: [] } } }),
			),
		);
	});
test("an application's writable roots do not grant access to sibling roots or code", () => {
	const roots = ["/app/storage/app", "/app/public/media"];
	assert.equal(persistentPath("/app/public/media/image.png", roots), true);
	assert.equal(persistentPath("/app/public/medialibrary/image.png", roots), false);
	assert.equal(persistentPath("/app/public/uploads/image.png", roots), false);
	assert.equal(persistentPath("/app/vendor/autoload.php", roots), false);
	assert.equal(persistentPath("/app/database/database.sqlite", roots), true);
});
test("a malformed block list cannot hide data beyond the declared file length", () => {
	assert.throws(() => fileReference({ size: 0, blocks: [{ hash: "a".repeat(64), length: 1 }] }));
	assert.throws(() => fileReference({ size: 1, blocks: [] }));
	assert.throws(() =>
		fileReference({ size: 1, blocks: [{ hash: "a".repeat(64), length: BLOCK_BYTES + 1 }] }),
	);
});

test("bytecode manifests cannot reference application data or escape their cache root", () => {
	const bytes = encodeFiles({
		format: "laravel-files/1",
		files: { "/php-opcache/release/script.bin": { size: 0, blocks: [] } },
	});
	assert.equal(Object.keys(decodeFiles(bytes, "code").files).length, 1);
	assert.throws(() => decodeFiles(bytes, "ephemeral"));
	assert.throws(() => decodeFiles(encodeFiles(manifest), "code"));
	for (const path of ["/php-opcache/../secret", "/php-opcache-extra/script.bin"])
		assert.throws(() =>
			decodeFiles(
				encodeFiles({ format: "laravel-files/1", files: { [path]: { size: 0, blocks: [] } } }),
				"code",
			),
		);
});
