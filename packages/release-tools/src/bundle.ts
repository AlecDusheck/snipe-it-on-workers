import { build } from "esbuild";
import { workerBundleOptions } from "@simplyalec/laravel-cf-workers-laravel-runtime/bundle";

export async function bundleWorker(
	entry: string,
	outfile: string,
	runtime: string,
	define: Record<string, string> = {},
): Promise<void> {
	await build({ ...workerBundleOptions(entry, runtime), outfile, define });
}
