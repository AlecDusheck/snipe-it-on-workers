import { test } from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { csrf } from "../browser";
import { adminForm } from "../setup";
import { record } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";

test(
	"standalone persists large private uploads and streams authorized downloads",
	{ timeout: 60000 },
	async () => {
		const mf = new Miniflare(
			convertV4MiniflareOptions({
				modules: [
					{ type: "ESModule", path: ".build/snipe-it/standalone/worker.mjs" },
					{ type: "CompiledWasm", path: ".build/snipe-it/standalone/php.wasm" },
				],
				modulesRoot: ".build/snipe-it/standalone",
				compatibilityDate: "2026-09-01",
				compatibilityFlags: ["nodejs_compat"],
				durableObjects: { SNIPEIT: { className: "SnipeIT", useSQLite: true } },
				assets: {
					directory: ".build/snipe-it/assets",
					binding: "ASSETS",
					run_worker_first: true,
					routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
				},
				bindings: { DEFAULT_RELEASE: "snipeit-8.7.2" },
			}),
		);
		const origin = "https://uploads.example.test";
		const cookies = new Map<string, string>();
		const visit = async (path: string, body?: URLSearchParams | FormData, token?: string) => {
			const encoded = body ? new Request(origin + path, { method: "POST", body }) : undefined;
			const response = await mf.dispatchFetch(origin + path, {
				method: body ? "POST" : "GET",
				redirect: "manual",
				headers: {
					...(encoded ? { "content-type": encoded.headers.get("content-type") ?? "" } : {}),
					cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
					...(token ? { "x-csrf-token": token, accept: "application/json" } : {}),
				},
				...(encoded ? { body: await encoded.arrayBuffer() } : {}),
			});
			for (const cookie of response.headers.getSetCookie()) {
				const pair = cookie.split(";", 1)[0] ?? "";
				const at = pair.indexOf("=");
				cookies.set(pair.slice(0, at), pair.slice(at + 1));
			}
			return response;
		};
		try {
			const migrationPage = await visit("/setup");
			assert.equal(
				(await visit("/setup/migrate", new URLSearchParams({ _token: csrf(await migrationPage.text()) })))
					.status,
				200,
			);
			const page = await visit("/setup/user");
			assert.equal(page.status, 200, await page.clone().text());
			const setup = await visit(
				"/setup/user",
				new URLSearchParams(adminForm(csrf(await page.text()), "Uploads")),
			);
			assert.equal(setup.status, 302, await setup.text());
			const token = csrf(await (await visit("/")).text());
			const bytes = new TextEncoder().encode("private inventory evidence\n".repeat(240000));
			const form = new FormData();
			form.set("file[]", new Blob([bytes], { type: "text/plain" }), "evidence.txt");
			const uploaded = await visit("/api/v1/users/1/files", form, token);
			const text = await uploaded.text();
			assert.equal(uploaded.status, 200, text);
			const result: unknown = JSON.parse(text);
			assert.ok(
				record(result) &&
					result.status === "success" &&
					record(result.payload) &&
					Array.isArray(result.payload.rows),
				text,
			);
			const file: unknown = result.payload.rows[0];
			assert.ok(record(file) && typeof file.id === "number");
			const downloaded = await visit(`/api/v1/users/1/files/${file.id}`, undefined, token);
			assert.equal(downloaded.status, 200, await downloaded.clone().text());
			assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), bytes);
		} finally {
			await mf.dispose();
		}
	},
);
