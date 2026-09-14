import { test } from "node:test";
import assert from "node:assert/strict";
import type { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
	MIB,
	builtRelease,
	measure,
	report,
	retained,
	root,
	startRuntimeWorker,
} from "@simplyalec/laravel-cf-workers-laravel-runtime/testing";

const REQUESTS = Number(process.env.BENCHMARK_REQUESTS ?? 12);
const PATHS = (process.env.BENCHMARK_PATHS ?? "/setup,/login").split(",");
const RELEASE = process.env.BENCHMARK_RELEASE ?? "snipeit-8.7.2";
// Workers isolates hold 128 MiB in total; leave room for the V8 heap and request buffers.
const RETAINED_LIMIT = 100 * MIB;

test("Snipe-IT retains bounded memory and settles after warm-up", { timeout: 600000 }, async (t) => {
	const directory = await mkdtemp(`${tmpdir()}/snipe-benchmark-`);
	let mf: Miniflare | undefined;
	t.after(async () => {
		await mf?.dispose();
		await rm(directory, { recursive: true, force: true });
	});
	mf = await startRuntimeWorker({
		entry: fileURLToPath(new URL("../../src/driver.ts", import.meta.url)),
		php: `${root}.build/snipe-it/runtime/8.5.10`,
		releases: `${root}.build/snipe-it/assets`,
		release: await builtRelease(`${root}.build/snipe-it/assets`, RELEASE),
		directory,
	});
	const boot = await measure(mf, "https://fixture.test", ["/setup", "/__migrate"], 2);
	console.log(report(`Snipe-IT ${RELEASE}, cold setup and migrations`, boot));
	for (const sample of boot) {
		assert.equal(sample.status, 200, `${sample.path} failed`);
		assert.ok(
			retained(sample.memory) < RETAINED_LIMIT,
			`migration retained ${(retained(sample.memory) / MIB).toFixed(1)} MiB`,
		);
	}
	const samples = await measure(mf, "https://fixture.test", PATHS, REQUESTS);
	console.log(report(`Snipe-IT ${RELEASE}`, samples));
	const warm = samples[2];
	const last = samples.at(-1);
	assert.ok(warm && last);
	for (const sample of samples) assert.equal(sample.status, 200, `${sample.path} failed`);
	assert.ok(
		retained(last.memory) < RETAINED_LIMIT,
		`retained ${(retained(last.memory) / MIB).toFixed(1)} MiB`,
	);
	assert.ok(retained(last.memory) - retained(warm.memory) < 16 * MIB, "memory keeps growing after warm-up");
});
