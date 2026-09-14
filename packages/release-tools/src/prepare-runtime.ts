/**
 * Verify the pinned Playground PHP runtime and apply the project's patches. No PHP is compiled.
 *   tsx packages/release-tools/src/prepare-runtime.ts --pin <pin.json> --output <dir>
 * Each patch must apply exactly once or the build fails.
 */
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { readPin, sha256 } from "./lib";

export const PAGE = 65536;
/** Playground reserves 64 MiB up front; Workers count reserved memory, and PHP grows on demand. */
export const INITIAL_PAGES = 320;
const CHUNK = 2 * 1024 * 1024;
const SLAB_CHUNKS = 2;

export function verify(data: Uint8Array, expected: string): Uint8Array {
	if (sha256(data) !== expected) throw new Error("Runtime checksum mismatch");
	return data;
}
function once(source: string, needle: string, what: string): void {
	if (source.split(needle).length !== 2) throw new Error(`${what} no longer applies exactly once`);
}

export function patchRuntime(source: string, wasm: string): string {
	const expression = `import dependencyFilename from './${wasm}';`;
	once(source, expression, "Runtime WASM import");
	return source.replace(expression, "import dependencyFilename from './php.wasm';");
}

export function patchFilesystemIo(source: string): string {
	for (const operation of ["read", "write"] as const) {
		const name = operation === "read" ? "Read" : "Write";
		const before = `function _fd_${operation}(fd, iov, iovcnt, pnum) {`;
		const io = `var num = do${name}v(stream, iov, iovcnt);`;
		const hook = `var num = await Module['filesystemIo']?.(stream, HEAPU8, iov, iovcnt, ${operation === "write"}, (ptr, len) => FS.${operation}(stream, HEAP8, ptr, len)) ?? do${name}v(stream, iov, iovcnt);`;
		const signature = `_fd_${operation}.sig = 'iippp';`;
		for (const needle of [before, io, signature]) once(source, needle, `Filesystem ${operation} hook`);
		source = source
			.replace(before, "async " + before)
			.replace(io, hook)
			.replace(signature, `${signature}\n\t_fd_${operation}.isAsync = true;`);
	}
	// js_fd_read polls pipes/sockets; only paged files may bypass its polling path.
	const before =
		"stream = SYSCALLS.getStreamFromFD(fd);\n\t\t\t\tHEAPU32[pnum >> 2] = doReadv(stream, iov, iovcnt);";
	once(source, before, "PHP read hook");
	return source.replace(
		before,
		before.replace(
			"HEAPU32[pnum >> 2]",
			"if (Module['isPersistentFile']?.(stream)) return _fd_read(fd, iov, iovcnt, pnum);\n\t\t\t\tHEAPU32[pnum >> 2]",
		),
	);
}

/** Grow the heap to exactly what was asked for; the isolate limit counts every page. */
export function patchHeapGrowth(source: string): string {
	const before =
		"var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);\n\t\t\toverGrownHeapSize = Math.min(\n\t\t\t\toverGrownHeapSize,\n\t\t\t\trequestedSize + 100663296\n\t\t\t);";
	once(source, before, "Heap growth policy");
	return source.replace(before, "var overGrownHeapSize = requestedSize;");
}

export function heapBase(loader: string): number {
	const match = loader.match(/var ___heap_base = (\d+);/);
	if (!match) throw new Error("Runtime heap base not found");
	return Number(match[1]);
}

function leb(bytes: Uint8Array, offset: number): [number, number] {
	let value = 0;
	let shift = 0;
	for (;;) {
		const byte = bytes[offset++] ?? 0;
		value |= (byte & 0x7f) << shift;
		shift += 7;
		if (!(byte & 0x80)) return [value >>> 0, offset];
	}
}
function encodeLeb(value: number): Uint8Array {
	const out: number[] = [];
	for (;;) {
		const byte = value & 0x7f;
		value >>>= 7;
		out.push(value ? byte | 0x80 : byte);
		if (!value) return Uint8Array.from(out);
	}
}
function encodeSleb(value: number): Uint8Array {
	const out: number[] = [];
	for (;;) {
		const byte = value & 0x7f;
		value >>= 7;
		const done = (value === 0 && !(byte & 0x40)) || (value === -1 && !!(byte & 0x40));
		out.push(done ? byte : byte | 0x80);
		if (done) return Uint8Array.from(out);
	}
}
const concat = (...parts: Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};
const vec = (items: Uint8Array[]): Uint8Array => concat(encodeLeb(items.length), ...items);
const name = (value: string): Uint8Array => concat(encodeLeb(Buffer.byteLength(value)), Buffer.from(value));
interface Section {
	id: number;
	start: number;
	end: number;
}
function sections(wasm: Uint8Array): Section[] {
	const out: Section[] = [];
	let offset = 8;
	while (offset < wasm.length) {
		const id = wasm[offset] ?? 0;
		const [size, start] = leb(wasm, offset + 1);
		out.push({ id, start, end: start + size });
		offset = start + size;
	}
	return out;
}
function rebuild(wasm: Uint8Array, additions: Map<number, Uint8Array[]>): Uint8Array {
	const parts: Uint8Array[] = [wasm.subarray(0, 8)];
	for (const section of sections(wasm)) {
		let body = wasm.subarray(section.start, section.end);
		const extra = additions.get(section.id);
		if (extra) {
			const [count, head] = leb(body, 0);
			body = concat(encodeLeb(count + extra.length), body.subarray(head), ...extra);
		}
		parts.push(Uint8Array.of(section.id), encodeLeb(body.length), body);
	}
	return concat(...parts);
}

/** Lower the module's minimum memory; static data and the stack must still fit. */
export function patchInitialMemory(wasm: Uint8Array, base: number, pages = INITIAL_PAGES): Uint8Array {
	if (pages * PAGE < base) throw new Error("Initial memory cannot hold the module data and stack");
	const memory = sections(wasm).find((section) => section.id === 5);
	if (!memory) throw new Error("WASM memory section missing");
	const [count, cursor] = leb(wasm, memory.start);
	const flags = wasm[cursor] ?? 0;
	const [minimum, end] = leb(wasm, cursor + 1);
	if (count !== 1 || !(flags & 1) || minimum * PAGE < base) throw new Error("Unexpected WASM memory section");
	const encoded = encodeLeb(pages);
	if (encoded.length !== end - cursor - 1) throw new Error("Initial memory encoding length changed");
	return concat(wasm.subarray(0, cursor + 1), encoded, wasm.subarray(end));
}

const op = {
	get: (i: number) => concat(Uint8Array.of(0x20), encodeLeb(i)),
	set: (i: number) => concat(Uint8Array.of(0x21), encodeLeb(i)),
	i32: (v: number) => concat(Uint8Array.of(0x41), encodeSleb(v)),
	call: (i: number) => concat(Uint8Array.of(0x10), encodeLeb(i)),
	loadHead: (storage: number) =>
		concat(Uint8Array.of(0x20), encodeLeb(storage), Uint8Array.of(0x28, 0x02, 0x10)),
	storeHead: Uint8Array.of(0x36, 0x02, 0x10),
	store: Uint8Array.of(0x36, 0x02, 0x00),
	load: Uint8Array.of(0x28, 0x02, 0x00),
	ne: Uint8Array.of(0x47),
	or: Uint8Array.of(0x72),
	eqz: Uint8Array.of(0x45),
	geU: Uint8Array.of(0x4f),
	mul: Uint8Array.of(0x6c),
	add: Uint8Array.of(0x6a),
	if: Uint8Array.of(0x04, 0x40),
	block: Uint8Array.of(0x02, 0x40),
	loop: Uint8Array.of(0x03, 0x40),
	br: (d: number) => Uint8Array.of(0x0c, d),
	brIf: (d: number) => Uint8Array.of(0x0d, d),
	ret: Uint8Array.of(0x0f),
	end: Uint8Array.of(0x0b),
	fill: Uint8Array.of(0xfc, 0x0b, 0x00),
};

/**
 * Zend MM chunk handlers: 2 MiB chunks carved from aligned slabs, free list in `storage->data`.
 * Locals: 0 storage, 1 size/ptr, 2 align/size, 3 ptr, 4 base, 5 index.
 */
function poolBodies(memalign: number, free: number): [Uint8Array, Uint8Array] {
	const alloc = concat(
		op.get(1),
		op.i32(CHUNK),
		op.ne,
		op.get(2),
		op.i32(CHUNK),
		op.ne,
		op.or,
		op.if,
		op.get(2),
		op.get(1),
		op.call(memalign),
		op.ret,
		op.end,
		op.loadHead(0),
		op.eqz,
		op.if,
		op.i32(CHUNK),
		op.i32(CHUNK * SLAB_CHUNKS),
		op.call(memalign),
		op.set(4),
		op.get(4),
		op.eqz,
		op.if,
		op.i32(0),
		op.ret,
		op.end,
		op.i32(0),
		op.set(5),
		op.block,
		op.loop,
		op.get(5),
		op.i32(SLAB_CHUNKS),
		op.geU,
		op.brIf(1),
		op.get(4),
		op.get(5),
		op.i32(CHUNK),
		op.mul,
		op.add,
		op.set(3),
		op.get(3),
		op.loadHead(0),
		op.store,
		op.get(0),
		op.get(3),
		op.storeHead,
		op.get(5),
		op.i32(1),
		op.add,
		op.set(5),
		op.br(0),
		op.end,
		op.end,
		op.end,
		op.loadHead(0),
		op.set(3),
		op.get(0),
		op.get(3),
		op.load,
		op.storeHead,
		op.get(3),
		op.i32(0),
		op.i32(CHUNK),
		op.fill,
		op.get(3),
		op.end,
	);
	const release = concat(
		op.get(2),
		op.i32(CHUNK),
		op.ne,
		op.if,
		op.get(1),
		op.call(free),
		op.ret,
		op.end,
		op.get(1),
		op.loadHead(0),
		op.store,
		op.get(0),
		op.get(1),
		op.storeHead,
		op.end,
	);
	return [concat(vec([concat(encodeLeb(3), Uint8Array.of(0x7f))]), alloc), concat(vec([]), release)];
}

/** Append the pool handlers to the module and export them as pool_chunk_alloc / pool_chunk_free. */
export function appendChunkPool(wasm: Uint8Array): Uint8Array {
	const all = sections(wasm);
	const section = (id: number): Section => {
		const found = all.find((candidate) => candidate.id === id);
		if (!found) throw new Error("WASM module is missing a section the chunk pool needs");
		return found;
	};
	const exports = new Map<string, number>();
	let [count, cursor] = leb(wasm, section(7).start);
	for (let i = 0; i < count; i++) {
		const [length, next] = leb(wasm, cursor);
		const exported = Buffer.from(wasm.subarray(next, next + length)).toString();
		const kind = wasm[next + length] ?? 0;
		const [index, after] = leb(wasm, next + length + 1);
		if (kind === 0) exports.set(exported, index);
		cursor = after;
	}
	const memalign = exports.get("emscripten_builtin_memalign");
	const free = exports.get("free");
	if (memalign === undefined || free === undefined || exports.has("pool_chunk_alloc"))
		throw new Error("WASM module exports are not the expected PHP runtime");
	let imported = 0;
	[count, cursor] = leb(wasm, section(2).start);
	for (let i = 0; i < count; i++) {
		for (let field = 0; field < 2; field++) {
			const [length, next] = leb(wasm, cursor);
			cursor = next + length;
		}
		const kind = wasm[cursor++] ?? 0;
		if (kind === 0) {
			[, cursor] = leb(wasm, cursor);
			imported++;
		} else if (kind === 3) cursor += 2;
		else {
			if (kind === 1) cursor++;
			const flags = wasm[cursor++] ?? 0;
			[, cursor] = leb(wasm, cursor);
			if (flags & 1) [, cursor] = leb(wasm, cursor);
		}
	}
	const [types] = leb(wasm, section(1).start);
	const [defined] = leb(wasm, section(3).start);
	const index = imported + defined;
	const [alloc, release] = poolBodies(memalign, free);
	const i32 = Uint8Array.of(0x7f);
	return rebuild(
		wasm,
		new Map<number, Uint8Array[]>([
			[
				1,
				[
					concat(Uint8Array.of(0x60), vec([i32, i32, i32]), vec([i32])),
					concat(Uint8Array.of(0x60), vec([i32, i32, i32]), vec([])),
				],
			],
			[3, [encodeLeb(types), encodeLeb(types + 1)]],
			[
				7,
				[
					concat(name("pool_chunk_alloc"), Uint8Array.of(0x00), encodeLeb(index)),
					concat(name("pool_chunk_free"), Uint8Array.of(0x00), encodeLeb(index + 1)),
				],
			],
			[10, [concat(encodeLeb(alloc.length), alloc), concat(encodeLeb(release.length), release)]],
		]),
	);
}

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { pin: { type: "string" }, output: { type: "string" } } });
	if (!values.pin || !values.output) throw new Error("Usage: --pin <pin.json> --output <dir>");
	const { php } = await readPin(values.pin);
	const require = createRequire(import.meta.url);
	const packageDirectory = require.resolve(`${php.package}/package.json`).replace(/package\.json$/, "");
	const installed: unknown = JSON.parse(await readFile(`${packageDirectory}package.json`, "utf8"));
	if (
		!(
			typeof installed === "object" &&
			installed !== null &&
			"version" in installed &&
			installed.version === php.packageVersion
		)
	)
		throw new Error("Installed runtime version differs from pin; run pnpm install");
	const wasm = verify(await readFile(`${packageDirectory}${php.mode}/${php.wasm}`), php.sha256);
	const loader = Buffer.from(
		verify(await readFile(`${packageDirectory}${php.mode}/${php.loader}`), php.loaderSha256),
	).toString();
	const source = patchHeapGrowth(patchFilesystemIo(patchRuntime(loader, php.wasm)));
	await mkdir(`${values.output}/LICENSES`, { recursive: true });
	await writeFile(`${values.output}/php.wasm`, appendChunkPool(patchInitialMemory(wasm, heapBase(source))));
	await writeFile(`${values.output}/php-loader.mjs`, source);
	await copyFile(`${packageDirectory}LICENSE`, `${values.output}/LICENSES/WordPress-Playground.txt`);
	await writeFile(
		`${values.output}/NOTICE`,
		`PHP ${php.version} from ${php.package}@${php.packageVersion}.\n` +
			"Source and build recipes: https://github.com/WordPress/wordpress-playground\n" +
			"Local changes: rename the ESM WASM import; await persistent-file IO in read/write syscalls;\n" +
			`lower the module's initial memory to ${(INITIAL_PAGES * PAGE) / 2 ** 20} MiB; grow the heap only as far as requested;\n` +
			"append pooled Zend MM chunk handlers (pool_chunk_alloc/pool_chunk_free). PHP's own code is unchanged.\n" +
			"Package license: LICENSES/WordPress-Playground.txt.\n",
	);
	console.log(`Verified PHP ${php.version} runtime installed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
