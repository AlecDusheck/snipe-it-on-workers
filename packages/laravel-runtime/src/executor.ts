import type { ApplicationProfile } from "./application";
import { REQUEST_SCRIPT, createPhp, runPhp } from "./php";
import { Corpus } from "./corpus";
import { decodeCorpusIndex } from "./corpus-index";
import { ArchiveReader, archiveIdentity, releaseFile } from "./release";

import * as v from "valibot";
import { parseHttpOutput } from "./validation";
import { record } from "./schema";
import { digestText } from "./crypto";
import { runtimeEnvironment, runtimeIdentity } from "./environment";
import type { RuntimeMemory } from "./validation";
import { SerialQueue } from "./queue";
import type { Release, RuntimeInput, RuntimeOutput } from "./types";
import { __private__dont__use, setPhpIniEntries } from "@php-wasm/universal";
import type { PHP } from "@php-wasm/universal";
import script from "./request.php";
import laravel from "./laravel.php";
import databaseEditor from "./database.php";
import { PersistentFilesystem } from "./filesystem";
import { CODE_CACHE_ROOT } from "./files";
import type { RuntimeStorage } from "./files";

export interface RuntimeEnv {
	ASSETS: Fetcher;
	RELEASE: Release;
}
interface Runtime {
	php: PHP;
	files: PersistentFilesystem;
	corpus: Corpus;
	reader: ArchiveReader;
}
/** Archive parts held while a request runs; a boot streams the hot region through them. */
const REQUEST_PARTS = 2;
/** Archive parts kept between requests for the occasional miss. */
const IDLE_PARTS = 0;

/** PHP-reported counters from the last request. */
const phpStatsSchema = v.object({
	peak: v.optional(v.number(), 0),
	opcache: v.optional(v.number(), 0),
	opcacheFull: v.optional(v.boolean(), false),
	opcacheKeys: v.optional(v.number(), 0),
	opcacheMaxKeys: v.optional(v.number(), 0),
});

function heap(php: PHP): { wasmBytes: number; sbrkBytes: number } {
	const module: unknown = Reflect.get(php, __private__dont__use);
	if (!record(module) || !(module.HEAPU8 instanceof Uint8Array) || !record(module.wasmExports))
		return { wasmBytes: 0, sbrkBytes: 0 };
	const pointer = module.wasmExports.emscripten_get_sbrk_ptr;
	const address: unknown = typeof pointer === "function" ? pointer() : undefined;
	const sbrkBytes =
		typeof address === "number" ? (new Uint32Array(module.HEAPU8.buffer, address, 1)[0] ?? 0) : 0;
	return { wasmBytes: module.HEAPU8.byteLength, sbrkBytes };
}

async function boot(
	env: RuntimeEnv,
	input: RuntimeInput,
	application: ApplicationProfile,
	storage: RuntimeStorage,
): Promise<Runtime> {
	const indexBytes = await releaseFile(env.ASSETS, env.RELEASE, "index");
	const index = decodeCorpusIndex(new Uint8Array(indexBytes));
	const reader = new ArchiveReader(env.ASSETS, env.RELEASE, REQUEST_PARTS);
	let filesystem: PersistentFilesystem | undefined;
	let corpus: Corpus | undefined;
	const archive = await archiveIdentity(env.RELEASE);
	const cacheIdentity = await digestText(
		archive + env.RELEASE.files.wasm + script + laravel + databaseEditor + (application.bootstrap ?? ""),
	);
	const opcacheDirectory = `${CODE_CACHE_ROOT}/${cacheIdentity}`;
	const php = await createPhp(
		async (stream, ...rest) => {
			if (corpus?.owns(stream)) {
				await corpus.prepare(stream);
				return undefined;
			}
			return filesystem?.io(stream, ...rest);
		},
		(stream) => (filesystem?.owns(stream) || corpus?.owns(stream)) ?? false,
		opcacheDirectory,
	);
	try {
		php.mkdirTree("/app");
		await php.mount("/app", (_php, fs) => {
			corpus = new Corpus(fs, index, (offset, length) => reader.range(offset, length), {
				storage,
				archive,
			});
			filesystem = new PersistentFilesystem(fs, application.storageDirectories, cacheIdentity);
			return () => {};
		});
		php.writeFile(REQUEST_SCRIPT, script);
		php.writeFile("/laravel.php", laravel);
		php.writeFile("/application.php", application.bootstrap ?? "<?php");
		php.writeFile("/database.php", databaseEditor);
		for (const [path, value] of Object.entries(input.secrets.files ?? {})) {
			php.mkdirTree(path.slice(0, path.lastIndexOf("/")));
			php.writeFile(path, value);
		}
		php.writeFile(
			"/environment.json",
			JSON.stringify(runtimeEnvironment(input, application.environment?.(input.origin))),
		);
		if (!filesystem || !corpus) throw new Error("Persistent filesystem did not initialize");
		return { php, files: filesystem, corpus, reader };
	} catch (error) {
		php.exit();
		throw error;
	}
}

export class RuntimeExecutor {
	#queue = new SerialQueue();
	#ready: Promise<Runtime> | undefined;
	#runtime: Runtime | undefined;
	#identity: string | undefined;
	#requestLimit: string | undefined;
	#stats = v.parse(phpStatsSchema, {});
	constructor(
		private readonly env: RuntimeEnv,
		private readonly application: ApplicationProfile = {},
	) {}
	dispose(): void {
		this.#runtime?.php.exit();
		this.#ready = this.#runtime = undefined;
	}
	memory(): RuntimeMemory | undefined {
		const runtime = this.#runtime;
		if (!runtime) return undefined;
		return {
			...heap(runtime.php),
			zendPeakBytes: this.#stats.peak,
			opcacheBytes: this.#stats.opcache,
			opcacheFull: this.#stats.opcacheFull,
			opcacheKeys: this.#stats.opcacheKeys,
			opcacheMaxKeys: this.#stats.opcacheMaxKeys,
			corpusBytes: runtime.reader.heldBytes,
			archiveFetches: runtime.reader.fetches,
			inflatedBytes: runtime.corpus.cachedBytes,
			pageCacheBytes: runtime.files.cachedBytes,
			indexBytes: runtime.corpus.index.byteLength ?? 0,
			manifestBytes: runtime.files.manifestBytes,
		};
	}
	execute(input: RuntimeInput, storage: RuntimeStorage): Promise<RuntimeOutput> {
		return this.#queue.run(async () => {
			try {
				return await this.#executeOne(input, storage);
			} catch (error) {
				// An aborted WASM instance cannot safely execute another request.
				this.dispose();
				throw error;
			}
		});
	}
	async #executeOne(input: RuntimeInput, storage: RuntimeStorage): Promise<RuntimeOutput> {
		const expected = runtimeIdentity(this.env.RELEASE, input);
		if (this.#identity && this.#identity !== expected) throw new Error("Runtime tenant identity changed");
		this.#identity = expected;
		this.#ready ??= boot(this.env, input, this.application, storage);
		const runtime = (this.#runtime = await this.#ready);
		const { php, files, reader } = runtime;
		reader.retain(REQUEST_PARTS);
		runtime.corpus.setStorage(storage);
		await files.restore({ database: input.database, ephemeral: input.ephemeral }, storage);
		php.writeFile("/request.json", JSON.stringify({ command: input.command, origin: input.origin }));
		const http = input.command.kind === "http" ? input.command.request : undefined;
		const limit = String(input.requestLimitBytes ?? 16 * 1024 * 1024);
		if (limit !== this.#requestLimit) {
			await setPhpIniEntries(php, { upload_max_filesize: limit, post_max_size: limit });
			this.#requestLimit = limit;
		}
		// HEAD suppresses SAPI stdout; application output can also corrupt an envelope there.
		if (php.fileExists("/response.json")) php.unlink("/response.json");
		await runPhp(
			php,
			http
				? { method: http.method, headers: Object.fromEntries(http.headers), body: new Uint8Array(http.body) }
				: {},
		);
		if (!php.fileExists("/response.json")) throw new Error("PHP did not return a response");
		const result: unknown = JSON.parse(php.readFileAsText("/response.json"));
		if (!record(result) || result.ok !== true) {
			// PHP returns the exception class only; messages can contain credentials or SQL.
			console.error(
				"PHP request failed",
				record(result) && typeof result.error === "string" ? result.error : "unknown",
			);
			throw new Error("PHP execution failed");
		}
		const stats = v.safeParse(phpStatsSchema, result);
		if (stats.success) this.#stats = stats.output;
		// SAPI shutdown must close PDO before a manifest can be committed.
		for (const suffix of ["-journal", "-wal"])
			if (php.fileExists(`/app/database/database.sqlite${suffix}`))
				throw new Error("SQLite journal remains open");
		const trees = await files.snapshot(storage);
		reader.retain(IDLE_PARTS);
		if (result.bodyFile !== undefined && result.bodyFile !== null && result.bodyFile !== "/app/tmp/response")
			throw new Error("Invalid response spool");
		return {
			...trees,
			response: {
				...parseHttpOutput(result.response),
				...(result.bodyFile ? { file: files.reference("/app/tmp/response") } : {}),
			},
		};
	}
}
