import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

/** Browser-style page load: HTML, then referenced assets in parallel. Reports TTFB/total per resource and the DO trace. BENCHMARK_URL targets a live deployment. */
const ROUNDS = Number(process.env.BENCHMARK_ROUNDS ?? 3);
const PAGE = process.env.BENCHMARK_PAGE ?? "/setup";

interface Fetched {
	status: number;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
	arrayBuffer(): Promise<ArrayBuffer>;
}
type Fetcher = (path: string) => Promise<Fetched>;
interface Timing {
	path: string;
	status: number;
	ttfbMs: number;
	totalMs: number;
	bytes: number;
	trace: string | null;
}
async function timed(fetcher: Fetcher, path: string): Promise<Timing> {
	const started = performance.now();
	const response = await fetcher(path);
	const ttfbMs = performance.now() - started;
	const bytes = (await response.arrayBuffer()).byteLength;
	return {
		path,
		status: response.status,
		ttfbMs: Math.round(ttfbMs),
		totalMs: Math.round(performance.now() - started),
		bytes,
		trace: response.headers.get("x-platform-trace"),
	};
}
function assetPaths(html: string, origin: string): string[] {
	const paths = new Set<string>();
	for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
		const value = match[1] ?? "";
		try {
			const url = new URL(value, origin);
			if (url.origin !== origin || !/\.(?:css|js|png|jpe?g|gif|svg|ico|woff2?)(?:$|\?)/.test(url.pathname))
				continue;
			paths.add(url.pathname + url.search);
		} catch {
			continue;
		}
	}
	return [...paths];
}
const median = (values: number[]): number =>
	values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

test("page load waterfall", { timeout: 600000 }, async (t) => {
	const live = process.env.BENCHMARK_URL;
	const origin = live ? new URL(live).origin : "https://inventory.example.test";
	let fetcher: Fetcher;
	if (live) {
		fetcher = (path) => fetch(new URL(path, origin));
	} else {
		const state = await mkdtemp(`${tmpdir()}/snipe-waterfall-`);
		const mf = new Miniflare(
			convertV4MiniflareOptions({
				resourcePersistencePath: state,
				modules: [
					{ type: "ESModule", path: ".build/snipe-it/standalone/worker.mjs" },
					{ type: "CompiledWasm", path: ".build/snipe-it/standalone/php.wasm" },
				],
				modulesRoot: ".build/snipe-it/standalone",
				compatibilityDate: "2026-09-01",
				compatibilityFlags: ["nodejs_compat"],
				bindings: { TENANT_DEFAULTS: {}, PLATFORM_TRACE: "1", DEFAULT_RELEASE: "snipeit-8.7.2" },
				durableObjects: { SNIPEIT: { className: "SnipeIT", useSQLite: true } },
				assets: {
					directory: ".build/snipe-it/assets",
					binding: "ASSETS",
					run_worker_first: true,
					routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
				},
			}),
		);
		fetcher = (path) => mf.dispatchFetch(origin + path);
		t.after(async () => {
			await mf.dispose();
			await rm(state, { recursive: true, force: true });
		});
	}
	const htmlTimes: number[] = [];
	const assetPhases: number[] = [];
	const loads: number[] = [];
	for (let round = 1; round <= ROUNDS; round++) {
		const started = performance.now();
		const response = await fetcher(PAGE);
		const html = await response.text();
		const htmlMs = Math.round(performance.now() - started);
		assert.equal(response.status, 200, html.slice(0, 200));
		const paths = assetPaths(html, origin);
		const assetsStarted = performance.now();
		const assets = await Promise.all(paths.map((path) => timed(fetcher, path)));
		const assetMs = Math.round(performance.now() - assetsStarted);
		const loadMs = Math.round(performance.now() - started);
		htmlTimes.push(htmlMs);
		assetPhases.push(assetMs);
		loads.push(loadMs);
		console.log(
			`round ${round}: html ${htmlMs} ms, ${paths.length} assets in ${assetMs} ms (parallel), loaded ${loadMs} ms`,
		);
		if (round === 1) {
			console.log(`  html trace: ${response.headers.get("x-platform-trace") ?? "n/a"}`);
			for (const asset of assets.toSorted((a, b) => b.totalMs - a.totalMs).slice(0, 5))
				console.log(
					`  ${String(asset.status).padStart(3)} ${String(asset.totalMs).padStart(5)} ms ${asset.path}${asset.trace ? `  ${asset.trace}` : ""}`,
				);
			for (const asset of assets) assert.ok(asset.status < 400, `${asset.path} -> ${asset.status}`);
		}
	}
	console.log(
		`median: html ${median(htmlTimes)} ms, assets ${median(assetPhases)} ms, loaded ${median(loads)} ms`,
	);
});
