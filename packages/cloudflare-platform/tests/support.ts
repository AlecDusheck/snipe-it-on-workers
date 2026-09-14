import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { workerBundleOptions } from "@simplyalec/laravel-cf-workers-laravel-runtime/bundle";

export const rpcClientEntrypoint = fileURLToPath(new URL("./fixtures/rpc-client-worker.ts", import.meta.url));

export async function bundle(entry: string, define: Record<string, string> = {}): Promise<string> {
	const result = await build({ ...workerBundleOptions(entry), define, write: false });
	const script = result.outputFiles[0]?.text;
	if (!script) throw new Error(`Missing bundle for ${entry}`);
	return script;
}
