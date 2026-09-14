/**
 * Bundle the single-instance Worker for a PHP runtime. The digest of that runtime's binary is stamped
 * into the bundle so the Worker refuses releases built on a different binary.
 *
 *   tsx packages/release-tools/src/build-standalone.ts --entry <worker> --runtime <dir> --output <dir>
 */
import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { mkdir, copyFile } from "node:fs/promises";
import { digestFile } from "./lib";
import { bundleWorker } from "./bundle";

const { values } = parseArgs({
	options: { entry: { type: "string" }, runtime: { type: "string" }, output: { type: "string" } },
});
if (!values.entry || !values.runtime || !values.output) throw new Error("Missing arguments");
const runtime = resolve(values.runtime);
const output = resolve(values.output);
await mkdir(output, { recursive: true });
await bundleWorker(resolve(values.entry), join(output, "worker.mjs"), runtime, {
	RUNTIME_WASM_SHA256: JSON.stringify(await digestFile(join(runtime, "php.wasm"))),
});
await copyFile(join(runtime, "php.wasm"), join(output, "php.wasm"));
console.log(`Standalone Worker ready: ${output}`);
