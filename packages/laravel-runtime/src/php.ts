import type { PHPRunOptions } from "@php-wasm/universal";
import { PHP, loadPHPRuntime, setPhpIniEntries } from "@php-wasm/universal";
import * as loader from "php-wasm-loader";
import Wasm from "./php.wasm";

export type FilesystemIo = (
	stream: unknown,
	heap: Uint8Array,
	iov: number,
	count: number,
	write: boolean,
	operation: (pointer: number, length: number) => number,
) => Promise<number | undefined>;

// Every request runs from this path so opcache keys the bridge like any other script.
export const REQUEST_SCRIPT = "/request.php";

// prepare-runtime.ts appends pooled chunk handlers; point Zend MM's storage at them.
function installChunkPool(exports: WebAssembly.Exports): void {
	const { pool_chunk_alloc, pool_chunk_free, __indirect_function_table, wasm_memory_storage_struct, memory } =
		exports;
	if (
		typeof pool_chunk_alloc !== "function" ||
		typeof pool_chunk_free !== "function" ||
		!(__indirect_function_table instanceof WebAssembly.Table) ||
		!(wasm_memory_storage_struct instanceof WebAssembly.Global) ||
		!(memory instanceof WebAssembly.Memory)
	)
		throw new Error("PHP runtime is missing the pooled chunk allocator");
	const index = __indirect_function_table.grow(2);
	__indirect_function_table.set(index, pool_chunk_alloc);
	__indirect_function_table.set(index + 1, pool_chunk_free);
	const address: unknown = wasm_memory_storage_struct.value;
	if (typeof address !== "number") throw new Error("Invalid memory storage address");
	// zend_mm_storage: { handlers: { chunk_alloc, chunk_free, chunk_truncate, chunk_extend }, data }
	new Uint32Array(memory.buffer, address, 2).set([index, index + 1]);
}

export async function createPhp(
	filesystemIo: FilesystemIo,
	isPersistentFile: (stream: unknown) => boolean,
	opcacheDirectory: string,
): Promise<PHP> {
	let wasmExports: WebAssembly.Exports | undefined;
	const id = await loadPHPRuntime(
		{ ...loader, phpWasmAsyncMode: "jspi", init: (_mode, options) => loader.init("WEB", options) },
		{
			locateFile: () => "https://runtime/php.wasm",
			filesystemIo,
			isPersistentFile,
			instantiateWasm: (imports, receive) => {
				const instance = new WebAssembly.Instance(Wasm, imports);
				wasmExports = instance.exports;
				return receive(instance, Wasm);
			},
		},
	);
	if (!wasmExports) throw new Error("PHP module did not instantiate");
	installChunkPool(wasmExports);
	const php = new PHP(id);
	// A bounded hot cache is backed by bytecode generated on demand in durable paged files.
	php.writeFile("/opcache-blacklist.txt", "/internal/*\n");
	await setPhpIniEntries(php, {
		display_errors: "0",
		error_reporting: "24575",
		memory_limit: "96M",
		upload_tmp_dir: "/app/tmp",
		sys_temp_dir: "/app/tmp",
		"opcache.enable": "1",
		"opcache.enable_cli": "1",
		"opcache.file_cache_only": "0",
		"opcache.memory_consumption": "32",
		"opcache.interned_strings_buffer": "4",
		"opcache.max_accelerated_files": "10000",
		"opcache.file_cache": opcacheDirectory,
		// Source files and generated views keep their ordinary timestamp invalidation semantics.
		"opcache.validate_timestamps": "1",
		"opcache.revalidate_freq": "0",
		"opcache.file_update_protection": "0",
		"opcache.blacklist_filename": "/opcache-blacklist.txt",
	});
	return php;
}

export async function runPhp(php: PHP, options: PHPRunOptions = {}): Promise<void> {
	const response = await php.run({ ...options, scriptPath: REQUEST_SCRIPT });
	if (response.exitCode !== 0) throw new Error("PHP request failed");
}
