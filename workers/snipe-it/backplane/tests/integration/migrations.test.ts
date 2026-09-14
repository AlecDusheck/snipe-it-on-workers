import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "@simplyalec/laravel-cf-workers-cloudflare-platform/testing";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

test(
	"all upstream migrations execute inside PHP WASM against a fresh SQLite database",
	{ timeout: 180000 },
	async () => {
		const script = await bundle("workers/snipe-it/backplane/tests/fixtures/migration-worker.ts");
		const mf = new Miniflare(
			convertV4MiniflareOptions({
				workers: [
					{
						name: "migration-test",
						modules: true,
						script,
						compatibilityDate: "2026-09-01",
						compatibilityFlags: ["nodejs_compat"],
						workerLoaders: { LOADER: {} },
						assets: {
							directory: ".build/snipe-it/assets",
							binding: "ASSETS",
							run_worker_first: true,
							routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
						},
					},
				],
			}),
		);
		const directory = await mkdtemp(`${tmpdir()}/snipe-migrations-`);
		try {
			const response = await mf.dispatchFetch("https://migration.example/");
			assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
			const bytes = await response.arrayBuffer();
			const repeated = await mf.dispatchFetch("https://migration.example/", { method: "POST", body: bytes });
			assert.equal(repeated.status, 200, repeated.status === 200 ? undefined : await repeated.text());
			await writeFile(`${directory}/database.sqlite`, Buffer.from(await repeated.arrayBuffer()));
			const database = new DatabaseSync(`${directory}/database.sqlite`, { readOnly: true });
			try {
				assert.equal(database.prepare("SELECT COUNT(*) AS count FROM migrations").get()?.count, 472);
				assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
				assert.equal(database.prepare("SELECT COUNT(*) AS count FROM users").get()?.count, 0);
			} finally {
				database.close();
			}
		} finally {
			await mf.dispose();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
