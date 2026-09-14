import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateRawSync } from "node:zlib";
import { Corpus, indexArchive } from "../src/corpus";
import { encodeCorpusIndex, decodeCorpusIndex } from "../src/corpus-index";
import { MemoryBlockStorage } from "../src/files";
import type { CorpusFilesystem } from "../src/corpus";

// A small stand-in for Emscripten's MEMFS: lookups fall back to the directory's node_ops.
const DIR = 0o040755;
const FILE = 0o100444;
class Node {
	children = new Map<string, Node>();
	contents: Uint8Array = new Uint8Array();
	usedBytes = 0;
	stream_ops: Record<string, unknown> = {};
	node_ops: Record<string, unknown>;
	constructor(
		readonly name: string,
		readonly mode: number,
	) {
		this.node_ops = {
			lookup: () => {
				throw Object.assign(new Error("ENOENT"), { errno: 44 });
			},
			readdir: (self: unknown) => [".", "..", ...asNode(self).children.keys()],
			mknod: (parent: unknown, child: unknown, kind: unknown) => {
				const created = new Node(String(child), Number(kind));
				asNode(parent).children.set(created.name, created);
				return created;
			},
		};
	}
}
function asNode(value: unknown): Node {
	if (!(value instanceof Node)) throw new Error("Not a node");
	return value;
}
function call(node: Node, operation: string, ...args: unknown[]): unknown {
	const fn = node.node_ops[operation];
	if (typeof fn !== "function") throw new Error(`Missing ${operation}`);
	return Reflect.apply(fn, node.node_ops, args);
}
class Fs implements CorpusFilesystem {
	root = new Node("", DIR);
	isDir(mode: number) {
		return (mode & 0o170000) === 0o040000;
	}
	#walk(path: string): Node {
		let node = this.root;
		for (const part of path.split("/").filter(Boolean))
			node = node.children.get(part) ?? asNode(call(node, "lookup", node, part));
		return node;
	}
	mkdirTree(path: string) {
		let node = this.root;
		for (const part of path.split("/").filter(Boolean))
			node = node.children.get(part) ?? asNode(call(node, "mknod", node, part, DIR, 0));
	}
	createDataFile(parent: string, name: string, data: Uint8Array) {
		const node = this.#walk(parent);
		asNode(call(node, "mknod", node, name, FILE, 0)).contents = data;
	}
	lookupPath(path: string) {
		return { node: this.#walk(path) };
	}
	readdir(path: string): string[] {
		const node = this.#walk(path);
		const listed = call(node, "readdir", node);
		return Array.isArray(listed) ? listed.map(String).filter((name) => !name.startsWith(".")) : [];
	}
}

interface Entry {
	name: string;
	text?: string;
	compression?: number;
}
function zip(entries: Entry[]): Uint8Array {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const { name, text, compression = 8 } of entries) {
		const path = Buffer.from(name);
		const data = Buffer.from(text ?? "");
		const packed = compression === 8 ? deflateRawSync(data) : data;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50);
		local.writeUInt16LE(compression, 8);
		local.writeUInt16LE(path.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50);
		central.writeUInt16LE(compression, 10);
		central.writeUInt32LE(crc32(data), 16);
		central.writeUInt32LE(packed.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(path.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, path, packed);
		centrals.push(central, path);
		offset += 30 + path.length + packed.length;
	}
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, ...centrals, end]);
}
const archive = zip([
	{ name: "vendor/" },
	{ name: "vendor/lib/a.php", text: "<?php echo 'a';" },
	{ name: "vendor/lib/b.php", text: "plain", compression: 0 },
	{ name: "index.php", text: "<?php echo 1;" },
]);
const range = (bytes: Uint8Array, reads?: number[]) => async (offset: number, length: number) => {
	reads?.push(length);
	return bytes.slice(offset, offset + length);
};
const index = () => decodeCorpusIndex(encodeCorpusIndex(indexArchive(archive)));
function mount(fs = new Fs(), reads: number[] = []) {
	return new Corpus(fs, index(), range(archive, reads));
}

test("directories and files appear on lookup without touching the archive", () => {
	const fs = new Fs();
	const corpus = mount(fs);
	assert.deepEqual(fs.readdir("/app").toSorted(), ["index.php", "vendor"]);
	assert.deepEqual(fs.readdir("/app/vendor/lib").toSorted(), ["a.php", "b.php"]);
	const node = fs.lookupPath("/app/vendor/lib/a.php").node;
	assert.equal(Reflect.get(node, "usedBytes"), 15);
	assert.equal(corpus.stats.inflatedFiles, 0);
	assert.throws(() => Reflect.get(node, "contents"), /before it was loaded/);
});
test("reads load through the async hook by range and are served from the cache after", async () => {
	const fs = new Fs();
	const reads: number[] = [];
	const corpus = mount(fs, reads);
	const stream = { node: fs.lookupPath("/app/vendor/lib/a.php").node };
	assert.ok(corpus.owns(stream));
	await corpus.prepare(stream);
	assert.equal(Buffer.from(asNode(stream.node).contents).toString(), "<?php echo 'a';");
	assert.equal(reads.length, 2);
	await corpus.prepare(stream);
	assert.equal(reads.length, 2);
	const other = { node: fs.lookupPath("/app/vendor/lib/b.php").node };
	await corpus.prepare(other);
	assert.equal(Buffer.from(asNode(other.node).contents).toString(), "plain");
	assert.deepEqual(reads.slice(2), [30, 5]);
	assert.equal(corpus.stats.fetches, 2);
});
test("fetched ranges are rejected when they do not match the index", async () => {
	const fs = new Fs();
	const corrupt = Uint8Array.from(archive);
	const at = Buffer.from(archive).indexOf("plain");
	corrupt[at] = (corrupt[at] ?? 0) ^ 0xff;
	const corpus = new Corpus(fs, index(), range(corrupt));
	await assert.rejects(corpus.prepare({ node: fs.lookupPath("/app/vendor/lib/b.php").node }), /Corrupt/);
});
test("a binary index mounts the same tree without the archive", async () => {
	const fs = new Fs();
	const corpus = new Corpus(fs, index(), range(archive));
	assert.deepEqual(fs.readdir("/app").toSorted(), ["index.php", "vendor"]);
	const stream = { node: fs.lookupPath("/app/index.php").node };
	await corpus.prepare(stream);
	assert.equal(Buffer.from(asNode(stream.node).contents).toString(), "<?php echo 1;");
	assert.throws(() => decodeCorpusIndex(new Uint8Array(16)));
});
test("files created by the application shadow nothing and stay writable", () => {
	const fs = new Fs();
	mount(fs);
	fs.mkdirTree("/app/storage/framework/views");
	fs.createDataFile("/app/storage/framework/views", "x.php", new Uint8Array([1]));
	assert.deepEqual(fs.readdir("/app").toSorted(), ["index.php", "storage", "vendor"]);
	assert.equal(fs.readdir("/app/storage/framework/views").length, 1);
});
for (const name of ["../secret", "/secret", "a/../secret", "a\\secret", "./secret", "a\0secret"])
	test(`reject archive path ${JSON.stringify(name)}`, () =>
		assert.throws(() => indexArchive(zip([{ name, text: "data" }]))));
test("truncated archives fail", () => {
	for (const length of [0, 1, 10, 21]) assert.throws(() => indexArchive(new Uint8Array(length)));
});
test("unsupported compression fails", () =>
	assert.throws(() => indexArchive(zip([{ name: "file", text: "text", compression: 99 }]))));

test("source cache is demand-driven, survives reboot, and uses the next request capability", async () => {
	const storage = new MemoryBlockStorage();
	const fs = new Fs();
	const corpus = new Corpus(fs, index(), range(archive), { storage, archive: "release" });
	assert.equal(storage.sources.size, 0);
	await corpus.prepare({ node: fs.lookupPath("/app/index.php").node });
	assert.equal(storage.sources.size, 1);
	const rebootFs = new Fs();
	const reads: number[] = [];
	const reboot = new Corpus(rebootFs, index(), range(archive, reads), { storage, archive: "release" });
	await reboot.prepare({ node: rebootFs.lookupPath("/app/index.php").node });
	assert.equal(reads.length, 0);
	const next = new MemoryBlockStorage();
	reboot.setStorage(next);
	await reboot.prepare({ node: rebootFs.lookupPath("/app/vendor/lib/b.php").node });
	assert.equal(next.sources.size, 1);
	assert.equal(storage.sources.size, 1);
});
test("corrupt disposable sources are repaired from the verified archive", async () => {
	const storage = new MemoryBlockStorage();
	storage.sources.set("release:vendor/lib/b.php", new Uint8Array(5).buffer);
	const fs = new Fs();
	const corpus = new Corpus(fs, index(), range(archive), { storage, archive: "release" });
	const stream = { node: fs.lookupPath("/app/vendor/lib/b.php").node };
	await corpus.prepare(stream);
	assert.equal(Buffer.from(asNode(stream.node).contents).toString(), "plain");
	assert.equal(
		Buffer.from((await storage.readSource("release", "vendor/lib/b.php")) ?? new ArrayBuffer(0)).toString(),
		"plain",
	);
});
test("corrupt archive bytes are never committed to the source cache", async () => {
	const storage = new MemoryBlockStorage();
	const fs = new Fs();
	const corrupt = Uint8Array.from(archive);
	corrupt[Buffer.from(archive).indexOf("plain")] = 0;
	const corpus = new Corpus(fs, index(), range(corrupt), { storage, archive: "release" });
	await assert.rejects(corpus.prepare({ node: fs.lookupPath("/app/vendor/lib/b.php").node }), /Corrupt/);
	assert.equal(storage.sources.size, 0);
});
