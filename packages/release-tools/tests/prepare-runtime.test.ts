import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readPin } from "../src/lib";
import {
	PAGE,
	appendChunkPool,
	heapBase,
	patchFilesystemIo,
	patchHeapGrowth,
	patchInitialMemory,
	patchRuntime,
	verify,
} from "../src/prepare-runtime";

test("the WASM import rename applies exactly once", () => {
	assert.equal(
		patchRuntime("import dependencyFilename from './8_5_10/php.wasm';\nkeep", "8_5_10/php.wasm"),
		"import dependencyFilename from './php.wasm';\nkeep",
	);
	for (const value of ["", "import dependencyFilename from './php.wasm';".repeat(2), "changed upstream"])
		assert.throws(() => patchRuntime(value, "php.wasm"));
});
test("filesystem hooks use native IO and fail on upstream drift", () => {
	let source = ["read", "write"]
		.map(
			(op) =>
				`function _fd_${op}(fd, iov, iovcnt, pnum) { var num = do${op[0]?.toUpperCase()}${op.slice(1)}v(stream, iov, iovcnt); }\n_fd_${op}.sig = 'iippp';`,
		)
		.join("\n");
	source +=
		"\nstream = SYSCALLS.getStreamFromFD(fd);\n\t\t\t\tHEAPU32[pnum >> 2] = doReadv(stream, iov, iovcnt);";
	const patched = patchFilesystemIo(source);
	for (const op of ["read", "write"]) {
		assert.match(patched, new RegExp(`async function _fd_${op}`));
		assert.match(patched, new RegExp(`FS\\.${op}\\(stream, HEAP8, ptr, len\\)`));
		assert.match(patched, new RegExp(`_fd_${op}\\.isAsync = true;`));
	}
	for (const changed of [patched, source + source, source.replace("doWritev", "changed"), ""])
		assert.throws(() => patchFilesystemIo(changed));
});
test("heap growth becomes linear and drift is rejected", () => {
	const before =
		"var overGrownHeapSize = oldSize * (1 + 0.2 / cutDown);\n\t\t\toverGrownHeapSize = Math.min(\n\t\t\t\toverGrownHeapSize,\n\t\t\t\trequestedSize + 100663296\n\t\t\t);";
	assert.match(patchHeapGrowth(`a ${before} b`), /overGrownHeapSize = requestedSize;/);
	assert.throws(() => patchHeapGrowth("nothing"));
	assert.equal(heapBase("x\nvar ___heap_base = 18944624;\n"), 18944624);
	assert.throws(() => heapBase("nothing"));
});
test("checksums fail closed", () => {
	const data = Buffer.from("wasm binary");
	const digest = createHash("sha256").update(data).digest("hex");
	assert.equal(verify(data, digest), data);
	assert.throws(() => verify(Buffer.from("wasm binary changed"), digest));
});
const leb = (value: number): number[] => {
	const out: number[] = [];
	for (;;) {
		const byte = value & 0x7f;
		value >>>= 7;
		out.push(value ? byte | 0x80 : byte);
		if (!value) return out;
	}
};
const memoryModule = (minimum: number, maximum = 32768): Uint8Array => {
	const body = [1, 0x01, ...leb(minimum), ...leb(maximum)];
	return Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 5, ...leb(body.length), ...body]);
};
test("initial memory pages are lowered in place and the module shape is checked", () => {
	assert.deepEqual(patchInitialMemory(memoryModule(1024), 300 * PAGE, 320), memoryModule(320));
	assert.throws(() => patchInitialMemory(memoryModule(1024), 400 * PAGE, 320));
	const unbounded = Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 5, 4, 1, 0x00, ...leb(1024)]);
	for (const wasm of [Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]), unbounded, memoryModule(100)])
		assert.throws(() => patchInitialMemory(wasm, 300 * PAGE, 320));
});
test("the pinned runtime module accepts the pool and still compiles", async () => {
	const { php } = await readPin(fileURLToPath(new URL("./fixtures/php.json", import.meta.url)));
	const require = createRequire(import.meta.url);
	const directory = require.resolve(`${php.package}/package.json`).replace(/package\.json$/, "");
	const wasm = new Uint8Array(await readFile(`${directory}${php.mode}/${php.wasm}`));
	const loader = await readFile(`${directory}${php.mode}/${php.loader}`, "utf8");
	const patched = appendChunkPool(patchInitialMemory(wasm, heapBase(loader)));
	// The Workers type definitions omit compile; Node provides it.
	const compile: (bytes: Uint8Array) => Promise<WebAssembly.Module> = Reflect.get(WebAssembly, "compile");
	const compiled = await compile(patched);
	const names = new Set(WebAssembly.Module.exports(compiled).map((entry) => entry.name));
	assert.ok(names.has("pool_chunk_alloc") && names.has("pool_chunk_free"));
	assert.throws(() => appendChunkPool(patched), /not the expected PHP runtime/);
});
