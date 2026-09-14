import { test } from "node:test";
import assert from "node:assert/strict";
import type { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { record } from "../../src/schema";
import { builtRelease, root, startRuntimeWorker } from "../harness";

const artifacts = root + ".build/runtime-tests";

test(
	"plain Laravel uses the shared runtime without an application profile",
	{ timeout: 120000 },
	async (t) => {
		const directory = await mkdtemp(`${tmpdir()}/laravel-contract-`);
		let mf: Miniflare | undefined;
		t.after(async () => {
			await mf?.dispose();
			await rm(directory, { recursive: true, force: true });
		});
		const worker = (mf = await startRuntimeWorker({
			entry: fileURLToPath(new URL("../fixtures/worker.ts", import.meta.url)),
			php: `${artifacts}/php`,
			releases: artifacts,
			release: await builtRelease(artifacts, "fixture"),
			directory,
		}));
		const cookies = new Map<string, string>();
		const visit = async (
			path: string,
			init: { method?: "POST" | "HEAD"; body?: URLSearchParams; headers?: Record<string, string> } = {},
		) => {
			const headers = new Headers(init.headers);
			headers.set("cookie", [...cookies].map(([key, value]) => `${key}=${value}`).join("; "));
			const response = await worker.dispatchFetch(`https://fixture.test${path}`, {
				...init,
				headers: Object.fromEntries(headers),
			});
			for (const value of response.headers.getSetCookie()) {
				const pair = value.split(";")[0] ?? "";
				const index = pair.indexOf("=");
				if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
			}
			return response;
		};
		let csrf = "";
		await t.test("database and encrypted sessions survive interpreter reconstruction", async () => {
			const first = await visit("/contract");
			assert.equal(first.status, 200, await first.clone().text());
			const data: unknown = await first.json();
			assert.ok(record(data));
			assert.equal(data.rows, 1);
			assert.equal(data.visits, 1);
			assert.equal(data.locale, "en");
			assert.equal(typeof data.csrf, "string");
			if (typeof data.csrf !== "string") throw new Error("Missing CSRF token");
			csrf = data.csrf;
			assert.equal((await visit("/__restart")).status, 204);
			const next: unknown = await (await visit("/contract")).json();
			assert.ok(record(next));
			assert.equal(next.rows, 2);
			assert.equal(next.visits, 2);
		});
		await t.test("native PDO transactions roll back", async () => {
			assert.deepEqual(await (await visit("/rollback")).json(), { rows: 2 });
		});
		await t.test("rejected request trees replace reused filesystem nodes", async () => {
			const rejected = await visit("/discard");
			assert.equal(rejected.status, 500);
			await rejected.text();
			assert.deepEqual(await (await visit("/discard-state")).json(), { rows: 2, file: false });
			assert.deepEqual(await (await visit("/discard-state")).json(), { rows: 2, file: false });
		});
		await t.test("Laravel CSRF middleware and its default local filesystem remain active", async () => {
			const denied = await visit("/storage", {
				method: "POST",
				body: new URLSearchParams({ value: "denied" }),
			});
			assert.equal(denied.status, 419);
			const saved = await visit("/storage", {
				method: "POST",
				body: new URLSearchParams({ _token: csrf, value: "persistent Laravel file" }),
			});
			assert.equal(saved.status, 200, await saved.clone().text());
			await visit("/__restart");
			assert.equal(await (await visit("/storage")).text(), "persistent Laravel file");
		});
		await t.test("Symfony streamed responses survive paged spooling", async () => {
			assert.equal(await (await visit("/stream")).text(), "a".repeat(70000) + "b".repeat(70000));
			const head = await visit("/stream", { method: "HEAD" });
			assert.equal(head.status, 200);
			assert.equal(await head.text(), "");
		});
		await t.test(
			"incremental file state preserves truncation, rename, replacement and deletion across boots",
			async () => {
				assert.equal((await visit("/file-mutations/create")).status, 200);
				assert.deepEqual(await (await visit("/file-mutations/edit")).json(), {
					before: true,
					after: false,
					value: "old target",
					edited: "new",
				});
				await visit("/__restart");
				assert.deepEqual(await (await visit("/file-mutations/read")).json(), {
					before: true,
					after: false,
					value: "old target",
					edited: "new",
				});
				assert.deepEqual(await (await visit("/file-mutations/move")).json(), {
					before: false,
					after: false,
					value: "new",
					edited: null,
				});
				await visit("/__restart");
				assert.deepEqual(await (await visit("/file-mutations/read")).json(), {
					before: false,
					after: false,
					value: "new",
					edited: null,
				});
				await visit("/file-mutations/remove");
				await visit("/__restart");
				assert.deepEqual(await (await visit("/file-mutations/read")).json(), {
					before: false,
					after: false,
					value: null,
					edited: null,
				});
			},
		);
	},
);
