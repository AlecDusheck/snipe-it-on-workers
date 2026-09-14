import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle, rpcClientEntrypoint } from "@simplyalec/laravel-cf-workers-cloudflare-platform/testing";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { Browser, csrf } from "../browser";
import { completeSetup } from "../setup";
import { record } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";
import { base64 } from "@simplyalec/laravel-cf-workers-laravel-runtime/crypto";
import { databaseResponse } from "@simplyalec/laravel-cf-workers-cloudflare-platform/database";
import type { DatabaseAction } from "@simplyalec/laravel-cf-workers-laravel-runtime/types";

const decodeHtmlAttribute = (value: string) =>
	value
		.replaceAll("&quot;", '"')
		.replaceAll("&#039;", "'")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing test port");
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return address.port;
}

test("Snipe-IT works through real HTTP, PHP WASM, Durable Objects and KV", { timeout: 180000 }, async (t) => {
	const state = await mkdtemp(`${tmpdir()}/snipe-workers-test-`);
	const port = await freePort();
	const source = await bundle("workers/snipe-it/backplane/src/index.ts");
	const client = await bundle(rpcClientEntrypoint);
	const start = () =>
		new Miniflare(
			convertV4MiniflareOptions({
				port,
				host: "127.0.0.1",
				resourcePersistencePath: state,
				resourceTmpPath: `${state}/tmp`,
				workers: [
					{
						name: "rpc-client",
						modules: true,
						script: client,
						compatibilityDate: "2026-09-01",
						serviceBindings: {
							CONTROL: { name: "application-test", entrypoint: "BackplaneControl" },
							TENANT_HTTP: "application-test",
						},
					},
					{
						name: "application-test",
						modules: true,
						script: source,
						compatibilityDate: "2026-09-01",
						compatibilityFlags: ["nodejs_compat"],
						bindings: {
							DEFAULT_RELEASE: "snipeit-8.7.1",
							SNIPEIT_ENV: { COOKIE_NAME: "deployment_session" },
						},
						durableObjects: { TENANTS: { className: "Tenant", useSQLite: true } },
						kvNamespaces: ["DIRECTORY"],
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
	let mf = start();
	try {
		await mf.ready;
		const platform = new Browser("localhost", port);
		const browser = new Browser("acme.localhost", port);
		const provision = (slug: string, key = `${slug}-request-key-12345`) =>
			platform.visit("/__test/provision", {
				json: {
					slug,
					name: "WASM Inventory",
				},
				headers: { origin: `http://localhost:${port}`, "idempotency-key": key },
			});
		let token = "";
		const database = (action: DatabaseAction, slug = "acme") =>
			platform.visit("/__test/database", { json: { slug, action } });
		const inspect = async (table: string, slug = "acme", offset = 0) => {
			const result = await database({ kind: "inspect", table, offset }, slug);
			assert.equal(result.status, 200, result.body);
			const envelope: unknown = JSON.parse(result.body);
			assert.ok(record(envelope));
			return databaseResponse({
				status: 200,
				headers: [],
				body: base64(new TextEncoder().encode(JSON.stringify(envelope.value))),
			});
		};
		await t.test("creation uses real tenant provisioning", async () => {
			const first = await provision("acme");
			assert.equal(first.status, 201, first.body);
			assert.equal((await provision("acme")).status, 201);
			assert.equal((await provision("acme", "a-different-request-key")).status, 409);
		});
		await t.test(
			"provisioning leaves setup to the owner and runs the genuine upstream setup wizard",
			async () => {
				assert.equal((await database({ kind: "inspect", table: "users", offset: 0 })).status, 404);
				assert.equal((await database({ kind: "inspect", table: "settings", offset: 0 })).status, 404);
				const setup = new Browser("acme.localhost", port);
				const page = await setup.visit("/setup");
				assert.equal(page.status, 200, page.body.slice(0, 1000));
				const migrated = await setup.visit("/setup/migrate", { form: { _token: csrf(page.body) } });
				assert.equal(migrated.status, 200, migrated.body.slice(0, 1000));
				await completeSetup(setup);
				assert.equal((await inspect("users")).rows.length, 1);
			},
		);

		await t.test("private artifacts and internal operations are unreachable", async () => {
			for (const path of ["/releases/catalog.json", "/__platform/provision", "/.env"]) {
				assert.equal((await platform.visit(path)).status, 404);
				assert.equal((await browser.visit(path)).status, 404);
			}
		});
		await t.test("missing CSRF token rejects login", async () => {
			// Snipe-IT turns TokenMismatchException into a redirect with a flash error.
			assert.equal(
				(
					await browser.visit("/login", {
						form: { username: "admin@example.test", password: "test-only-long-password" },
					})
				).status,
				302,
			);
			const rejected = await browser.visit("/login");
			assert.equal(rejected.status, 200);
			assert.match(rejected.body, /expired/i);
			assert.equal((await browser.visit("/")).status, 302);
		});
		await t.test("password login and persistent cookies render the authenticated dashboard", async () => {
			const page = await browser.visit("/login");
			assert.equal(page.status, 200);
			token = csrf(page.body);
			const login = await browser.visit("/login", {
				form: { _token: token, username: "admin@example.test", password: "test-only-long-password" },
			});
			assert.equal(login.status, 302);
			const dashboard = await browser.visit("/");
			assert.equal(dashboard.status, 200);
			assert.match(dashboard.body, /Dashboard/);
			token = csrf(dashboard.body);
			assert.ok(browser.cookies.has("deployment_session"));
		});
		await t.test("inventory pages and their actual CSS and JS render", async () => {
			for (const path of [
				"/hardware",
				"/hardware/create",
				"/models",
				"/categories",
				"/statuslabels",
				"/users",
				"/account/profile",
				"/css/dist/all.css",
				"/js/dist/all.js",
			])
				assert.equal((await browser.visit(path)).status, 200, path);
		});
		await t.test("real category, model and asset creation; API reads the saved asset", async () => {
			// Seeded category/status rows determine the IDs used below.
			for (const [path, form] of Object.entries({
				"/categories": { name: "WASM laptops", category_type: "asset" },
				"/models": { name: "WASM model", category_id: "2" },
				"/hardware": { name: "WASM laptop", "asset_tags[1]": "WASM-001", model_id: "1", status_id: "2" },
			})) {
				const response = await browser.visit(path, {
					form: { _token: token, ...form },
					headers: { accept: "application/json" },
				});
				assert.equal(response.status, 302, `${path}: ${response.body.slice(0, 1000)}`);
			}
			const asset = await browser.visit("/hardware/1");
			assert.equal(asset.status, 200);
			assert.match(asset.body, /WASM-001/);
			const api = await browser.visit("/api/v1/hardware", {
				headers: { accept: "application/json", "x-csrf-token": token },
			});
			assert.equal(api.status, 200);
			assert.match(api.body, /WASM-001/);
		});
		await t.test("four competing checkouts leave one assignee and one checkout event", async () => {
			const results = await Promise.all(
				Array.from({ length: 4 }, () =>
					browser.visit("/hardware/1/checkout", {
						form: { _token: token, checkout_to_type: "user", assigned_user: "1", status_id: "2" },
					}),
				),
			);
			for (const result of results) assert.equal(result.status, 302);
			const response = await browser.visit("/api/v1/hardware/1", {
				headers: { accept: "application/json", "x-csrf-token": token },
			});
			const asset: unknown = JSON.parse(response.body);
			assert.ok(record(asset));
			assert.ok(record(asset.assigned_to));
			assert.equal(asset.assigned_to.id, 1);
			const activity = await browser.visit("/api/v1/reports/activity?action_type=checkout", {
				headers: { accept: "application/json", "x-csrf-token": token },
			});
			assert.equal(activity.status, 200);
			const rows: unknown = JSON.parse(activity.body);
			assert.ok(record(rows));
			assert.equal(rows.total, 1);
		});
		await t.test("cross-tenant cookies do not authenticate and data stays separate", async () => {
			assert.equal((await provision("other")).status, 201);
			await completeSetup(new Browser("other.localhost", port));
			const other = new Browser("other.localhost", port);
			for (const [key, value] of browser.cookies) other.cookies.set(key, value);
			assert.equal((await other.visit("/")).status, 302);
			const login = await other.visit("/login");
			assert.equal(login.status, 200);
			assert.equal(
				(
					await other.visit("/login", {
						form: {
							_token: csrf(login.body),
							username: "admin@example.test",
							password: "test-only-long-password",
						},
					})
				).status,
				302,
			);
			const dashboard = await other.visit("/");
			assert.equal(dashboard.status, 200);
			const api = await other.visit("/api/v1/hardware", {
				headers: { accept: "application/json", "x-csrf-token": csrf(dashboard.body) },
			});
			assert.equal(api.status, 200);
			assert.doesNotMatch(api.body, /WASM-001/);
		});
		await t.test("tenant environment changes take effect through RPC and remain isolated", async () => {
			const configured = await platform.visit("/__test/configure", {
				json: {
					slug: "other",
					environment: { COOKIE_NAME: "other_environment_session", REFERRER_POLICY: "no-referrer" },
				},
			});
			assert.equal(configured.status, 200, configured.body);
			const other = new Browser("other.localhost", port);
			assert.equal((await other.visit("/login")).status, 200);
			assert.ok(other.cookies.has("other_environment_session"));
			assert.equal((await browser.visit("/")).status, 200);
			assert.ok(browser.cookies.has("deployment_session"));
			assert.equal(
				(
					await platform.visit("/__test/configure", {
						json: { slug: "other", environment: { DB_CONNECTION: "mysql" } },
					})
				).status,
				400,
			);
		});

		await t.test("directory lists only successfully provisioned tenants", async () => {
			const result = await platform.visit("/__test/list");
			assert.equal(result.status, 200);
			const envelope: unknown = JSON.parse(result.body);
			assert.ok(record(envelope) && record(envelope.value) && Array.isArray(envelope.value.tenants));
			assert.deepEqual(
				envelope.value.tenants.map((tenant: unknown) => (record(tenant) ? tenant.slug : null)),
				["acme", "other"],
			);
			assert.doesNotMatch(result.body, /password|appKey|oauth|creationKey/);
		});
		await t.test("PDO editor lists real tables, columns and paginated rows", async () => {
			const page = await inspect("assets");
			assert.ok(page.tables.includes("users"));
			assert.ok(!page.tables.includes("_hosting_sessions"));
			assert.ok(!page.tables.includes("sqlite_sequence"));
			assert.ok(page.columns.some((column) => column.name === "id" && column.primaryKey));
			assert.equal(page.rows[0]?.values.asset_tag, "WASM-001");
			assert.equal(page.rows[0]?.values.id, "1");
			const migrations = await inspect("migrations");
			assert.equal(migrations.rows.length, 50);
			assert.equal(migrations.hasMore, true);
			const next = await inspect("migrations", "acme", 50);
			assert.equal(next.rows[0]?.values.id, "51");
		});
		await t.test("database edits appear in Snipe-IT and stale edits cannot overwrite them", async () => {
			const original = (await inspect("assets")).rows[0]?.values;
			assert.ok(original);
			// Session writes between inspection and saving must not cause false conflicts.
			assert.equal((await browser.visit("/")).status, 200);
			const saved = await database({
				kind: "update",
				table: "assets",
				original,
				values: { ...original, name: "Edited from panel 💻", notes: "' ; DROP TABLE assets; --" },
			});
			assert.equal(saved.status, 200, saved.body);
			assert.match((await browser.visit("/hardware/1")).body, /Edited from panel/);
			const stale = await database({
				kind: "update",
				table: "assets",
				original,
				values: { ...original, name: "Stale edit" },
			});
			assert.equal(stale.status, 409, stale.body);
			assert.equal((await inspect("assets")).rows[0]?.values.name, "Edited from panel 💻");
			assert.equal((await inspect("assets", "other")).rows.length, 0);
		});
		await t.test("editor preserves NULL and empty strings as distinct values", async () => {
			for (const notes of [null, "", "line one\nline two 💻"]) {
				const original = (await inspect("assets")).rows[0]?.values;
				assert.ok(original);
				const saved = await database({
					kind: "update",
					table: "assets",
					original,
					values: { ...original, notes },
				});
				assert.equal(saved.status, 200, saved.body);
				assert.equal((await inspect("assets")).rows[0]?.values.notes, notes);
			}
		});
		await t.test(
			"editor rejects unknown tables, extra columns, missing tenants and constraint violations",
			async () => {
				assert.equal(
					(await database({ kind: "inspect", table: 'assets"; DROP TABLE users; --', offset: 0 })).status,
					404,
				);
				assert.equal((await database({ kind: "inspect", table: "users", offset: 0 }, "missing")).status, 404);
				const original = (await inspect("assets")).rows[0]?.values;
				assert.ok(original);
				assert.equal(
					(
						await database({
							kind: "update",
							table: "assets",
							original,
							values: { ...original, injected: "bad" },
						})
					).status,
					400,
				);
				const users = (await inspect("users")).rows[0]?.values;
				assert.ok(users);
				const invalid = await database({
					kind: "update",
					table: "users",
					original: users,
					values: { ...users, id: null },
				});
				assert.equal(invalid.status, 400, invalid.body);
				assert.deepEqual((await inspect("users")).rows[0]?.values, users);
			},
		);

		await t.test(
			"a tenant upgrades from Snipe-IT 8.7.1 / PHP 8.4 to 8.7.2 / PHP 8.5 independently",
			async () => {
				const info = async (slug: string) => {
					const result = await platform.visit(`/__test/details?slug=${slug}`);
					const envelope: unknown = JSON.parse(result.body);
					assert.ok(record(envelope) && record(envelope.value) && record(envelope.value.release));
					return envelope.value.release;
				};
				assert.equal((await info("acme")).phpVersion, "8.4.25");
				const upgraded = await platform.visit("/__test/upgrade", {
					json: { slug: "acme", release: "snipeit-8.7.2" },
				});
				assert.equal(upgraded.status, 200, upgraded.body);
				assert.equal((await info("acme")).phpVersion, "8.5.10");
				assert.equal((await info("other")).phpVersion, "8.4.25");
				assert.equal((await browser.visit("/")).status, 200);
				assert.match((await browser.visit("/hardware/1")).body, /Edited from panel/);
				assert.equal(
					(await platform.visit("/__test/upgrade", { json: { slug: "acme", release: "snipeit-8.7.1" } }))
						.status,
					409,
				);
			},
		);
		await t.test("Livewire hydrates and updates an upstream component through the HTTP adapter", async () => {
			const page = await browser.visit("/fields/create");
			assert.equal(page.status, 200, page.body.slice(0, 1000));

			const snapshot = [...page.body.matchAll(/wire:snapshot="([^"]+)"/g)]
				.map((match) => decodeHtmlAttribute(match[1] ?? ""))
				.find((value) => value.includes("custom-field-editor"));
			assert.ok(snapshot, "The upstream editor must render a signed Livewire snapshot");
			const url = page.body.match(/data-update-uri="([^"]+)"/)?.[1];
			assert.ok(url, "The upstream page must declare its Livewire update endpoint");
			const endpoint = new URL(decodeHtmlAttribute(url));
			assert.equal(endpoint.origin, `http://${browser.host}:${port}`);
			const path = endpoint.pathname + endpoint.search;
			const payload = {
				_token: csrf(page.body),
				components: [{ snapshot, updates: { name: "Header regression" }, calls: [] }],
			};
			const update = await browser.visit(path, {
				json: payload,
				headers: { "x-livewire": "", accept: "application/json" },
			});
			assert.equal(update.status, 200, update.body.slice(0, 1000));
			const result: unknown = JSON.parse(update.body);
			assert.ok(record(result) && Array.isArray(result.components));
			const component: unknown = result.components[0];
			assert.ok(record(component) && typeof component.snapshot === "string");
			const componentState: unknown = JSON.parse(component.snapshot);
			assert.ok(record(componentState) && record(componentState.data));
			assert.equal(componentState.data.name, "Header regression");
			assert.equal((await browser.visit(path, { json: payload })).status, 404);
		});
		const qrImages = new Map<string, Buffer>();
		await t.test("upstream QR rendering creates and caches a PNG in writable storage", async () => {
			const created = await browser.visit("/licenses", {
				form: { _token: token, name: "QR license", seats: "1", category_id: "2" },
			});
			assert.equal(created.status, 302, created.body);
			assert.equal((await inspect("licenses")).rows[0]?.values.name, "QR license");
			for (const path of ["/licenses/1/qr_code", "/hardware/1/qr_code", "/users/1/qr_code"]) {
				const image = await browser.visit(path);
				assert.equal(image.status, 200, image.body.slice(0, 1000));
				assert.equal(image.headers["content-type"], "image/png");
				assert.deepEqual(image.bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
				qrImages.set(path, image.bytes);
				assert.deepEqual((await browser.visit(path)).bytes, image.bytes);
			}
		});

		let avatarPath = "";
		let avatarBytes: Buffer = Buffer.alloc(0);
		await t.test("native multipart uploads pass Snipe-IT validation and persist public images", async () => {
			const page = await browser.visit("/account/profile");
			assert.equal(page.status, 200);
			const form = new FormData();
			form.set("_token", csrf(page.body));
			form.set("first_name", "Test");
			form.set("last_name", "Admin");
			form.set("locale", "en-US");
			const png = await readFile(
				".build/snipe-it/upstream/snipeit-8.7.2/public/img/demo/manufacturers/lenovoicon.png",
			);
			form.set("avatar", new Blob([png], { type: "image/png" }), "avatar.png");
			const uploaded = await browser.visit("/account/profile", {
				multipart: form,
				headers: { accept: "application/json" },
			});
			assert.equal(uploaded.status, 302, uploaded.body);
			const avatar = (await inspect("users")).rows[0]?.values.avatar;
			assert.ok(avatar, (await browser.visit("/account/profile")).body.slice(-10000));
			avatarPath = `/uploads/avatars/${avatar}`;
			const image = await browser.visit(avatarPath);
			assert.equal(image.status, 200, image.body);
			assert.equal(image.headers["content-type"], "image/png");
			assert.deepEqual(image.bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
			avatarBytes = image.bytes;
			assert.equal((await new Browser("other.localhost", port).visit(avatarPath)).status, 404);
			form.set("avatar", new Blob(["this is not an image"], { type: "image/png" }), "fake.png");
			const invalid = await browser.visit("/account/profile", {
				multipart: form,
				headers: { accept: "application/json" },
			});
			assert.equal(invalid.status, 200, invalid.body);
			assert.match(invalid.body, /"status":"error"/);
			assert.match(invalid.body, /avatar/);
			assert.equal((await inspect("users")).rows[0]?.values.avatar, avatar);
		});

		let attachmentId = 0;
		const attachment = Buffer.from("Snipe-IT durable attachment.\n".repeat(240000));
		await t.test(
			"a multipart attachment larger than 5 MiB is durable and downloads through native authorization",
			async () => {
				const form = new FormData();
				form.set("_token", csrf((await browser.visit("/")).body));
				form.set("file[]", new Blob([attachment], { type: "text/plain" }), "evidence.txt");
				const uploaded = await browser.visit("/api/v1/hardware/1/files", {
					multipart: form,
					headers: { accept: "application/json", "x-csrf-token": String(form.get("_token")) },
				});
				assert.equal(uploaded.status, 200, uploaded.body);
				const payload: unknown = JSON.parse(uploaded.body);
				assert.ok(
					record(payload) &&
						payload.status === "success" &&
						record(payload.payload) &&
						Array.isArray(payload.payload.rows),
					uploaded.body,
				);
				const file: unknown = payload.payload.rows[0];
				assert.ok(record(file) && typeof file.id === "number", uploaded.body);
				attachmentId = file.id;
				assert.equal(file.exists_on_disk, true);
				const download = await browser.visit(`/api/v1/hardware/1/files/${attachmentId}`, {
					headers: {
						accept: "application/octet-stream",
						"x-csrf-token": csrf((await browser.visit("/")).body),
					},
				});
				assert.equal(download.status, 200, download.body.slice(0, 500));
				assert.deepEqual(download.bytes, attachment);
				const partial = await browser.visit(`/api/v1/hardware/1/files/${attachmentId}`, {
					headers: { "x-csrf-token": String(form.get("_token")), range: "bytes=17-46" },
				});
				assert.equal(partial.status, 206, partial.body.slice(0, 500));
				assert.deepEqual(partial.bytes, attachment.subarray(17, 47));
				const head = await browser.visit(`/api/v1/hardware/1/files/${attachmentId}`, {
					method: "HEAD",
					headers: { "x-csrf-token": String(form.get("_token")) },
				});
				assert.equal(head.status, 200);
				assert.equal(head.headers["content-length"], String(attachment.byteLength));
				assert.equal(head.bytes.length, 0);
				assert.match(String(download.headers["content-disposition"]), /attachment/);
				assert.equal(download.headers["x-content-type-options"], "nosniff");
				assert.equal(
					(
						await new Browser("acme.localhost", port).visit(`/api/v1/hardware/1/files/${attachmentId}`, {
							headers: { accept: "application/json" },
						})
					).status,
					401,
				);
				assert.equal(
					(await browser.visit(`/uploads/../storage/private_uploads/assets/${String(file.filename)}`)).status,
					404,
				);
			},
		);
		await t.test("upstream streamed CSV exports complete through the durable response spool", async () => {
			const exported = await browser.visit("/reports/export/licenses");
			assert.equal(exported.status, 200, exported.body.slice(0, 1000));
			assert.match(String(exported.headers["content-disposition"]), /attachment/);
			assert.match(exported.body, /^License,Serial,Seats,/);
		});

		await t.test("suspension blocks the tenant but preserves management access and data", async () => {
			const suspended = await platform.visit("/__test/policy", {
				json: { slug: "acme", policy: { suspended: true } },
			});
			assert.equal(suspended.status, 200, suspended.body);
			assert.equal((await browser.visit("/")).status, 503);
			assert.equal((await browser.visit("/css/dist/all.css")).status, 503);
			assert.equal((await inspect("assets")).rows[0]?.values.asset_tag, "WASM-001");
			assert.equal(
				(
					await platform.visit("/__test/policy", {
						json: { slug: "acme", policy: { suspended: false, scheduledJobsEnabled: false } },
					})
				).status,
				200,
			);
			assert.equal((await browser.visit("/")).status, 200);
		});

		await t.test("process restart preserves login, data and checkout", async () => {
			await mf.dispose();
			mf = start();
			await mf.ready;
			const other = new Browser("other.localhost", port);
			assert.equal((await other.visit("/login")).status, 200);
			assert.ok(other.cookies.has("other_environment_session"));
			const restoredAttachment = await browser.visit(`/api/v1/hardware/1/files/${attachmentId}`, {
				headers: { "x-csrf-token": csrf((await browser.visit("/")).body) },
			});
			assert.equal(restoredAttachment.status, 200);
			assert.deepEqual(restoredAttachment.bytes, attachment);
			const restoredImage = await browser.visit(avatarPath);
			assert.equal(restoredImage.status, 200);
			assert.deepEqual(restoredImage.bytes, avatarBytes);
			for (const [path, bytes] of qrImages) {
				const restoredQr = await browser.visit(path);
				assert.equal(restoredQr.status, 200);
				assert.deepEqual(restoredQr.bytes, bytes);
			}
			const dashboard = await browser.visit("/");
			assert.equal(dashboard.status, 200);
			token = csrf(dashboard.body);
			const response = await browser.visit("/api/v1/hardware/1", {
				headers: { accept: "application/json", "x-csrf-token": token },
			});
			assert.equal(response.status, 200);
			const asset: unknown = JSON.parse(response.body);
			assert.ok(record(asset));
			assert.equal(asset.asset_tag, "WASM-001");
			assert.equal(asset.name, "Edited from panel 💻");
			assert.ok(record(asset.assigned_to));
			assert.equal(asset.assigned_to.id, 1);
		});
		await t.test("logout invalidates the authenticated session", async () => {
			assert.equal((await browser.visit("/logout", { form: { _token: token } })).status, 302);
			assert.equal((await browser.visit("/")).status, 302);
		});
		await t.test(
			"URL changes preserve tenant state, reject collisions and invalidate the old host",
			async () => {
				const next = `http://inventory.customer.test:${port}`;
				const collision = await platform.visit("/__test/url", {
					json: { slug: "acme", url: `http://other.localhost:${port}` },
				});
				assert.equal(collision.status, 409, collision.body);
				for (const url of ["javascript:alert(1)", next + "/path", "https://user:pass@example.test/"])
					assert.equal((await platform.visit("/__test/url", { json: { slug: "acme", url } })).status, 400);
				const changed = await platform.visit("/__test/url", { json: { slug: "acme", url: next } });
				assert.equal(changed.status, 200, changed.body);
				assert.equal((await browser.visit("/login")).status, 404);
				const moved = new Browser("inventory.customer.test", port);
				const login = await moved.visit("/login");
				assert.equal(login.status, 200, login.body);
				assert.match(login.body, /WASM Inventory/);
				assert.equal((await inspect("assets")).rows[0]?.values.asset_tag, "WASM-001");
				assert.deepEqual((await moved.visit(avatarPath)).bytes, avatarBytes);
				assert.ok((await platform.visit("/__test/list")).body.includes(next));
				await mf.dispose();
				mf = start();
				await mf.ready;
				assert.equal((await moved.visit("/login")).status, 200);
				assert.equal((await browser.visit("/login")).status, 404);
			},
		);
	} finally {
		await mf.dispose();
		await rm(state, { recursive: true, force: true });
	}
});
