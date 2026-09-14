import type { BuildOptions } from "esbuild";

/** esbuild options shared by release builds and test harnesses: neutral platform, PHP overlays as text. */
export function workerBundleOptions(entry: string, runtime?: string): BuildOptions {
	return {
		entryPoints: [entry],
		bundle: true,
		format: "esm",
		platform: "neutral",
		target: "es2022",
		mainFields: ["module", "main"],
		alias: {
			...(runtime && { "php-wasm-loader": `${runtime}/php-loader.mjs` }),
			worker_threads: "node:worker_threads",
			events: "node:events",
		},
		external: ["cloudflare:workers", "node:*", "./php.wasm"],
		loader: { ".php": "text" },
	};
}
