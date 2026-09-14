import adapter from "@sveltejs/adapter-cloudflare";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
export default {
	preprocess: vitePreprocess(),
	compilerOptions: { experimental: { async: true } },
	kit: {
		adapter: adapter({ platformProxy: { environment: process.env.CLOUDFLARE_ENV ?? "development" } }),
		experimental: { remoteFunctions: true },
	},
};
