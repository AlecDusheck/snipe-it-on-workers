import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { copyFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseRelease } from "../src/validation";
import { parse } from "../src/schema";
import { workerBundleOptions } from "../src/bundle";
import { runtimeMemorySchema } from "../src/validation";
import type { RuntimeMemory } from "../src/validation";
import type { Release } from "../src/types";

export const root = fileURLToPath(new URL("../../../", import.meta.url));

export interface RuntimeWorkerOptions {
	/** Worker entry that drives a `RuntimeExecutor`, such as `tests/fixtures/worker.ts`. */
	entry: string;
	/** Directory holding `php.wasm` and `php-loader.mjs` from `prepare-runtime.ts`. */
	php: string;
	/** Local release tree containing `releases/<name>/`, served through the ASSETS binding. */
	releases: string;
	release: Release;
	/** Scratch directory for the bundle and WASM copy. */
	directory: string;
}

export async function startRuntimeWorker(options: RuntimeWorkerOptions): Promise<Miniflare> {
	await build({
		...workerBundleOptions(options.entry, options.php),
		outfile: `${options.directory}/worker.mjs`,
	});
	await copyFile(`${options.php}/php.wasm`, `${options.directory}/php.wasm`);
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			workers: [
				{
					name: "runtime",
					modules: [
						{ type: "ESModule", path: `${options.directory}/worker.mjs` },
						{ type: "CompiledWasm", path: `${options.directory}/php.wasm` },
					],
					modulesRoot: options.directory,
					compatibilityDate: "2026-09-01",
					compatibilityFlags: ["nodejs_compat"],
					bindings: { RELEASE: options.release },
					assets: {
						directory: options.releases,
						binding: "ASSETS",
						run_worker_first: true,
						routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
					},
				},
			],
		}),
	);
	return mf;
}

export async function builtRelease(releases: string, name: string): Promise<Release> {
	return parseRelease(JSON.parse(await readFile(`${releases}/releases/${name}/manifest.json`, "utf8")));
}

export interface Sample {
	request: number;
	path: string;
	status: number;
	ms: number;
	memory: RuntimeMemory;
}
export const MIB = 1024 * 1024;
export const retained = (memory: RuntimeMemory): number =>
	memory.wasmBytes +
	memory.corpusBytes +
	memory.inflatedBytes +
	memory.pageCacheBytes +
	memory.indexBytes +
	memory.manifestBytes;

// Requests the paths round-robin and records latency plus retained memory after each one.
export async function measure(
	mf: Miniflare,
	origin: string,
	paths: string[],
	requests: number,
): Promise<Sample[]> {
	const samples: Sample[] = [];
	for (let request = 1; request <= requests; request++) {
		const path = paths[(request - 1) % paths.length] ?? "/";
		const started = performance.now();
		const response = await mf.dispatchFetch(origin + path);
		await response.arrayBuffer();
		const ms = Math.round(performance.now() - started);
		const memory = parse(
			runtimeMemorySchema,
			await (await mf.dispatchFetch(origin + "/__memory")).json(),
			500,
			"No memory report",
		);
		samples.push({ request, path, status: response.status, ms, memory });
	}
	return samples;
}

export function report(title: string, samples: Sample[]): string {
	const mib = (bytes: number) => (bytes / MIB).toFixed(1).padStart(6);
	const rows = samples.map(
		(s) =>
			`${String(s.request).padStart(3)}  ${s.path.padEnd(14)} ${String(s.status).padStart(3)} ${String(s.ms).padStart(6)} ms` +
			`  wasm ${mib(s.memory.wasmBytes)} (sbrk ${mib(s.memory.sbrkBytes)}, zend peak ${mib(s.memory.zendPeakBytes)}, opcache ${mib(s.memory.opcacheBytes)})` +
			`  keys ${s.memory.opcacheKeys}/${s.memory.opcacheMaxKeys}${s.memory.opcacheFull ? " full" : ""}` +
			`  corpus ${mib(s.memory.corpusBytes)} (${s.memory.archiveFetches} fetches)  inflated ${mib(s.memory.inflatedBytes)}` +
			`  pages ${mib(s.memory.pageCacheBytes)}  index ${mib(s.memory.indexBytes)}  manifests ${mib(s.memory.manifestBytes)}  tracked ${mib(retained(s.memory))} MiB`,
	);
	return [`${title}`, ...rows].join("\n");
}
