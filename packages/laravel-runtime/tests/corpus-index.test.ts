import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeCorpusIndex, encodeCorpusIndex } from "../src/corpus-index";
import type { CorpusIndex, CorpusEntry } from "../src/corpus";

const entry: CorpusEntry = { size: 12, crc: 0xf123abcd, local: 200, packedSize: 14, deflated: true };
const fixture = (): CorpusIndex => ({
	files: new Map([
		["z.php", entry],
		["nested/é.php", { ...entry, deflated: false }],
	]),
	directories: new Map([
		["", ["nested", "empty", "z.php"]],
		["nested", ["é.php"]],
		["empty", []],
	]),
});
test("binary index preserves metadata, Unicode names, empty directories and prefix lookup", () => {
	const bytes = encodeCorpusIndex(fixture());
	const index = decodeCorpusIndex(bytes);
	assert.equal(index.byteLength, bytes.byteLength);
	assert.deepEqual([...index.files.keys()], ["nested/é.php", "z.php"]);
	assert.deepEqual(index.files.get("z.php"), entry);
	assert.equal(index.files.get("nested/é.php")?.deflated, false);
	assert.equal(index.files.get("nested/é.ph"), undefined);
	assert.equal(index.files.has("z.php/"), false);
	assert.deepEqual(index.directories.get("")?.toSorted(), ["empty", "nested", "z.php"]);
	assert.deepEqual(index.directories.get("nested"), ["é.php"]);
	assert.deepEqual(index.directories.get("empty"), []);
	assert.equal(index.directories.get("missing"), undefined);
});
test("binary index accepts a view into a larger buffer", () => {
	const bytes = encodeCorpusIndex(fixture());
	const padded = new Uint8Array(bytes.length + 17);
	padded.set(bytes, 7);
	assert.deepEqual(decodeCorpusIndex(padded.subarray(7, 7 + bytes.length)).files.get("z.php"), entry);
});
test("truncated tables and strings are rejected", () => {
	const bytes = encodeCorpusIndex(fixture());
	for (let length = 0; length < bytes.length; length++)
		assert.throws(() => decodeCorpusIndex(bytes.slice(0, length)), `accepted truncation at ${length}`);
});
for (const path of ["", "/abs", "../escape", "a//b", "a/", "a\\b", "a\0b"])
	test(`reject binary file path ${JSON.stringify(path)}`, () => {
		assert.throws(() =>
			decodeCorpusIndex(encodeCorpusIndex({ files: new Map([[path, entry]]), directories: new Map() })),
		);
	});
test("reject overlapping tables, invalid UTF-8, duplicate names and file/directory collisions", () => {
	const bytes = encodeCorpusIndex(fixture());
	const badOffset = bytes.slice();
	new DataView(badOffset.buffer).setUint32(16, 8, true);
	assert.throws(() => decodeCorpusIndex(badOffset), /offset/);
	const badUtf8 = bytes.slice();
	badUtf8[new DataView(bytes.buffer).getUint32(16, true)] = 255;
	assert.throws(() => decodeCorpusIndex(badUtf8));
	const duplicate = bytes.slice();
	duplicate.set(duplicate.subarray(16, 24), 40);
	assert.throws(() => decodeCorpusIndex(duplicate), /sorted and unique/);
	const collision = fixture();
	assert.throws(
		() => decodeCorpusIndex(encodeCorpusIndex({ ...collision, directories: new Map([["z.php", []]]) })),
		/Invalid release file/,
	);
});
