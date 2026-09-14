import { test } from "node:test";
import assert from "node:assert/strict";
import type { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { MIB, builtRelease, measure, report, retained, root, startRuntimeWorker } from "../harness";

const artifacts = root + ".build/runtime-tests";
const REQUESTS = Number(process.env.BENCHMARK_REQUESTS ?? 12);

// Workers isolates hold 128 MiB in total; the runtime must leave room for the V8 heap and buffers.
test("plain Laravel retains bounded memory and settles after warm-up", { timeout: 300000 }, async (t) => {
	const directory = await mkdtemp(`${tmpdir()}/laravel-benchmark-`);
	let mf: Miniflare | undefined;
	t.after(async () => {
		await mf?.dispose();
		await rm(directory, { recursive: true, force: true });
	});
	mf = await startRuntimeWorker({
		entry: fileURLToPath(new URL("../fixtures/worker.ts", import.meta.url)),
		php: `${artifacts}/php`,
		releases: artifacts,
		release: await builtRelease(artifacts, "fixture"),
		directory,
	});
	const samples = await measure(mf, "https://fixture.test", ["/contract", "/storage"], REQUESTS);
	console.log(report("Laravel fixture", samples));
	console.log("Interpreter:", await (await mf.dispatchFetch("https://fixture.test/php")).text());
	const warm = samples[2];
	const last = samples.at(-1);
	assert.ok(warm && last);
	for (const sample of samples) assert.equal(sample.status, 200, `${sample.path} failed`);
	assert.ok(retained(last.memory) < 100 * MIB, `retained ${(retained(last.memory) / MIB).toFixed(1)} MiB`);
	assert.ok(retained(last.memory) - retained(warm.memory) < 16 * MIB, "memory keeps growing after warm-up");
	// A later boot of the same instance finds every file it needs in the working set.
	assert.equal((await mf.dispatchFetch("https://fixture.test/__restart")).status, 204);
	const [rebooted] = await measure(mf, "https://fixture.test", ["/contract"], 1);
	assert.ok(rebooted);
	console.log(report("Laravel fixture, rebooted", [rebooted]));
	assert.equal(rebooted.memory.archiveFetches, 0);
});
