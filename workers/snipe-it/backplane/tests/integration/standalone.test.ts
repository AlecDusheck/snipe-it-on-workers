import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { csrf } from "../browser";
import { adminForm } from "../setup";

test(
	"standalone boots, completes upstream setup and survives restart without a loader, panel, preset origin or control binding",
	{ timeout: 120000 },
	async () => {
		const state = await mkdtemp(`${tmpdir()}/snipe-standalone-`);
		const origin = "https://inventory.example.test";
		const start = () =>
			new Miniflare(
				convertV4MiniflareOptions({
					resourcePersistencePath: state,
					resourceTmpPath: `${state}/tmp`,
					modules: [
						{ type: "ESModule", path: ".build/snipe-it/standalone/worker.mjs" },
						{ type: "CompiledWasm", path: ".build/snipe-it/standalone/php.wasm" },
					],
					modulesRoot: ".build/snipe-it/standalone",
					compatibilityDate: "2026-09-01",
					compatibilityFlags: ["nodejs_compat"],
					bindings: { TENANT_DEFAULTS: { scheduledJobsEnabled: false }, DEFAULT_RELEASE: "snipeit-8.7.2" },
					durableObjects: { SNIPEIT: { className: "SnipeIT", useSQLite: true } },
					assets: {
						directory: ".build/snipe-it/assets",
						binding: "ASSETS",
						run_worker_first: true,
						routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
					},
				}),
			);
		let mf = start();
		const cookies = new Map<string, string>();
		const visit = async (path: string, form?: Record<string, string>) => {
			const response = await mf.dispatchFetch(origin + path, {
				method: form ? "POST" : "GET",
				redirect: "manual",
				headers: {
					cookie: Array.from(cookies, ([key, value]) => `${key}=${value}`).join("; "),
					...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
				},
				...(form ? { body: new URLSearchParams(form).toString() } : {}),
			});
			for (const cookie of response.headers.getSetCookie()) {
				const pair = cookie.split(";", 1)[0] ?? "";
				const at = pair.indexOf("=");
				cookies.set(pair.slice(0, at), pair.slice(at + 1));
			}
			return response;
		};
		try {
			const first = await visit("/");
			assert.equal(first.status, 302);
			assert.equal(first.headers.get("location"), origin + "/setup");
			const page = await visit("/setup");
			assert.equal(page.status, 200, await page.clone().text());
			assert.equal((await visit("/setup/migrate", { _token: csrf(await page.text()) })).status, 200);
			const user = await visit("/setup/user");
			assert.equal(user.status, 200);
			const created = await visit("/setup/user", adminForm(csrf(await user.text()), "Standalone inventory"));
			assert.equal(created.status, 302);
			assert.equal(created.headers.get("location"), origin + "/setup/done");
			const dashboard = await visit("/");
			assert.equal(dashboard.status, 200);
			assert.match(await dashboard.text(), /Standalone inventory/);
			assert.equal(
				(await visit("/setup/user")).status,
				302,
				"setup cannot create a second admin after completion",
			);
			for (const path of ["/.env", "/__platform/provision", "/releases/catalog.json"])
				assert.equal((await visit(path)).status, 404);
			assert.equal((await mf.dispatchFetch("https://other.inventory.example.test/")).status, 404);
			assert.equal((await mf.dispatchFetch("https://attacker.example.test/")).status, 404);
			await mf.dispose();
			mf = start();
			assert.equal((await visit("/")).status, 200);
			assert.equal((await visit("/setup/user")).status, 302);
		} finally {
			await mf.dispose();
			await rm(state, { recursive: true, force: true });
		}
	},
);
