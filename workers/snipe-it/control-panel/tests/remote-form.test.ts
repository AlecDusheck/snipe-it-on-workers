import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "@simplyalec/laravel-cf-workers-cloudflare-platform/testing";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_readConfig } from "wrangler";
import type { Unstable_Config } from "wrangler";
import { adminForm } from "../../backplane/tests/setup";
import { csrf } from "../../backplane/tests/browser";
import { databaseRow } from "@simplyalec/laravel-cf-workers-cloudflare-platform/database";

// Drain streamed bodies before Miniflare disposal; an unread response can keep teardown pending.
async function expectStatus(
	response: { status: number; text(): Promise<string> },
	status: number,
): Promise<void> {
	assert.equal(response.status, status, await response.text());
}

test(
	"remote form crosses the production service binding and provisions real Snipe-IT",
	{ timeout: 120000 },
	async (t) => {
		const panel = await bundle("workers/snipe-it/control-panel/.svelte-kit/cloudflare/_worker.js");
		const backplane = await bundle("workers/snipe-it/backplane/src/index.ts");
		const panelConfig: Unstable_Config = unstable_readConfig({
			config: "workers/snipe-it/control-panel/wrangler.jsonc",
			env: "production",
		});
		const backplaneConfig: Unstable_Config = unstable_readConfig({
			config: "workers/snipe-it/backplane/wrangler.jsonc",
			env: "production",
		});
		const serviceBinding = panelConfig.services?.find((service) => service.binding === "BACKPLANE");
		assert.ok(serviceBinding?.entrypoint);
		assert.ok(panelConfig.name);
		assert.ok(backplaneConfig.name);
		const origin = "https://panel.example.test";
		const mf = new Miniflare(
			convertV4MiniflareOptions({
				workers: [
					{
						name: panelConfig.name,
						bindings: { TENANT_BASE_URL: "https://inventory.example.test" },
						modules: true,
						script: panel,
						compatibilityDate: "2026-09-01",
						compatibilityFlags: ["nodejs_compat"],
						serviceBindings: {
							BACKPLANE: { name: serviceBinding.service, entrypoint: serviceBinding.entrypoint },
							// Miniflare shares one asset disk across Workers; these SSR tests only need backplane assets.
							ASSETS: async () => new Response(null, { status: 404 }),
						},
					},
					{
						name: backplaneConfig.name,
						modules: true,
						script: backplane,
						compatibilityDate: "2026-09-01",
						compatibilityFlags: ["nodejs_compat"],
						bindings: backplaneConfig.vars,
						durableObjects: { TENANTS: { className: "Tenant", useSQLite: true } },
						workerLoaders: { LOADER: {} },
						kvNamespaces: ["DIRECTORY"],
						assets: {
							directory: ".build/snipe-it/assets",
							binding: "ASSETS",
							routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
						},
					},
				],
			}),
		);
		try {
			const home = await mf.dispatchFetch(origin + "/");
			assert.equal(home.status, 200);
			const html = await home.text();
			assert.match(html, /Create your workspace/);
			const action = html.match(/<form[^>]*action="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
			const requestKey = html.match(/name="requestKey"[^>]*value="([^"]+)"/)?.[1];
			assert.ok(action, html.slice(0, 3000));
			assert.ok(requestKey, html.slice(0, 3000));
			const input = {
				requestKey,
				slug: "remote",
				name: "Remote form",
			};
			const submit = (values: Record<string, string>, requestOrigin = origin) =>
				mf.dispatchFetch(new URL(action, origin), {
					method: "POST",
					headers: {
						"content-type": "application/x-www-form-urlencoded",
						accept: "text/html",
						origin: requestOrigin,
					},
					body: new URLSearchParams(values).toString(),
					redirect: "manual",
				});
			await t.test(
				"server validation rejects invalid addresses and creation has no credentials",
				async () => {
					const response = await submit({ ...input, slug: "INVALID" });
					const body = await response.text();
					assert.match(body, /lowercase letters/);
					assert.doesNotMatch(body, /Admin password|Admin email/);
					assert.match(await (await submit({ ...input, slug: "admin" })).text(), /Reserved addresses/);
				},
			);
			await t.test("SvelteKit rejects cross-origin submissions", async () =>
				expectStatus(await submit(input, "https://elsewhere.example"), 403),
			);
			await t.test("a native HTML form submission provisions through RPC", async () => {
				const response = await submit(input);
				const body = await response.text();
				assert.equal(response.status, 200, body.slice(0, 3000));
				assert.match(body, /Workspace created/);
				assert.match(body, /https:\/\/remote\.inventory\.example\.test\/setup/);
				assert.doesNotMatch(body, /Admin password|Admin email/);
			});
			await t.test("retry preserves the tenant and conflicting creation returns a form issue", async () => {
				assert.match(await (await submit(input)).text(), /Workspace created/);
				const rejected = await submit({ ...input, requestKey: crypto.randomUUID() });
				assert.match(await rejected.text(), /already reserved/);
			});
			await t.test("the provisioned workspace serves the actual Snipe-IT setup wizard", async () => {
				const worker = await mf.getWorker(backplaneConfig.name);
				const login = await worker.fetch("https://remote.inventory.example.test/setup");
				assert.equal(login.status, 200);
				assert.match(await login.text(), /name="_token"/);
			});
			await t.test("remote query renders tenants with canonical URL and database links", async () => {
				const response = await mf.dispatchFetch(origin + "/");
				const body = await response.text();
				assert.equal(response.status, 200);
				assert.match(body, /Remote form/);
				assert.match(body, /href="https:\/\/remote\.inventory\.example\.test"/);
				assert.match(body, /href="\/tenants\/remote\/database"/);
			});
			await t.test(
				"backplane tenant routing preserves login redirects, cookies, POST bodies and static assets",
				async () => {
					const tenant = "https://remote.inventory.example.test";
					const tenantWorker = await mf.getWorker(backplaneConfig.name);
					const cookies = new Map<string, string>();
					const visit = async (path: string, form?: Record<string, string>) => {
						const response = await tenantWorker.fetch(tenant + path, {
							method: form ? "POST" : "GET",
							redirect: "manual",
							headers: {
								cookie: Array.from(cookies, ([key, value]) => `${key}=${value}`).join("; "),
								...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
							},
							...(form ? { body: new URLSearchParams(form).toString() } : {}),
						});
						for (const cookie of response.headers.getSetCookie()) {
							assert.doesNotMatch(cookie, /domain=/i);
							const pair = cookie.split(";", 1)[0] ?? "";
							const at = pair.indexOf("=");
							cookies.set(pair.slice(0, at), pair.slice(at + 1));
						}
						return response;
					};
					const migrationPage = await visit("/setup");
					await expectStatus(
						await visit("/setup/migrate", { _token: csrf(await migrationPage.text()) }),
						200,
					);
					const setup = await visit("/setup/user");
					assert.equal(setup.status, 200);
					const setupHtml = await setup.text();
					const created = await visit("/setup/user", adminForm(csrf(setupHtml), "Remote form"));
					assert.equal(created.status, 302, await created.text());
					assert.ok(created.headers.get("location")?.endsWith("/setup/done"));
					const dashboard = await visit("/");
					assert.equal(dashboard.status, 200);
					assert.match(await dashboard.text(), /Dashboard/);
					await expectStatus(await visit("/css/dist/all.css"), 200);
					for (const path of ["/.env", "/__platform/provision", "/releases/catalog.json"])
						await expectStatus(await visit(path), 404);
					await expectStatus(
						await tenantWorker.fetch("https://nested.remote.inventory.example.test/login"),
						404,
					);
				},
			);
			await t.test("database remote query and native edit form read and modify real SQLite", async () => {
				const pageUrl = origin + "/tenants/remote/database?table=settings&row=0";
				const page = await mf.dispatchFetch(pageUrl);
				const body = await page.text();
				assert.equal(page.status, 200, body.slice(0, 1500));
				assert.match(body, /Remote form/);
				const editAction = body
					.match(/<form[^>]*action="([^"]*remote=[^"]+)"/)?.[1]
					?.replaceAll("&amp;", "&");
				const encoded = body.match(/<textarea[^>]*name="_values"[^>]*>([\s\S]*?)<\/textarea>/)?.[1];
				assert.ok(editAction, body.slice(-5000));
				assert.ok(encoded, body.slice(-5000));
				const decoded = encoded
					.replaceAll("&lt;", "<")
					.replaceAll("&gt;", ">")
					.replaceAll("&quot;", '"')
					.replaceAll("&#39;", "'")
					.replaceAll("&amp;", "&");
				const parsed: unknown = JSON.parse(decoded);
				const original = databaseRow(parsed);
				const values = { ...original, site_name: "Edited through remote form" };
				const result = await mf.dispatchFetch(new URL(editAction, pageUrl), {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", origin },
					body: new URLSearchParams({
						slug: "remote",
						table: "settings",
						offset: "0",
						_original: JSON.stringify(original),
						_values: JSON.stringify(values),
					}).toString(),
				});
				const saved = await result.text();
				assert.equal(result.status, 200, saved.slice(0, 1500));
				assert.match(await (await mf.dispatchFetch(pageUrl)).text(), /Edited through remote form/);
			});
			await t.test("native policy forms save numeric quotas and unchecked job controls", async () => {
				const pageUrl = origin + "/tenants/remote";
				const manage = await (await mf.dispatchFetch(pageUrl)).text();
				const policyForm = [...manage.matchAll(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)].find(
					(match) => match[2]?.includes("scheduledJobsEnabled"),
				);
				assert.ok(policyForm?.[1] && policyForm[2]);
				const values = new URLSearchParams();
				for (const field of policyForm[2].matchAll(/<input\b([^>]*)>/g)) {
					const attrs = field[1] ?? "";
					const name = attrs.match(/name="([^"]+)"/)?.[1];
					if (!name || /type="checkbox"/.test(attrs)) continue;
					values.set(name, attrs.match(/value="([^"]*)"/)?.[1] ?? "");
				}
				const response = await mf.dispatchFetch(new URL(policyForm[1].replaceAll("&amp;", "&"), pageUrl), {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", origin },
					body: values.toString(),
				});
				assert.equal(response.status, 200, await response.text());
				assert.match(await (await mf.dispatchFetch(pageUrl)).text(), /Paused: manual/);
			});

			await t.test("the URL remote form updates routing, the workspace and directory links", async () => {
				const pageUrl = origin + "/tenants/remote";
				const page = await mf.dispatchFetch(pageUrl);
				const manageHtml = await page.text();
				assert.equal(page.status, 200, manageHtml.slice(0, 1500));
				const form = [...manageHtml.matchAll(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)].find(
					(match) => match[2]?.includes('name="url"'),
				);
				assert.ok(form?.[1], manageHtml.slice(-5000));
				const target = "https://assets.customer.example";
				const response = await mf.dispatchFetch(new URL(form[1].replaceAll("&amp;", "&"), pageUrl), {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", origin },
					body: new URLSearchParams({ slug: "remote", url: target }).toString(),
				});
				assert.equal(response.status, 200, await response.text());
				assert.ok((await (await mf.dispatchFetch(pageUrl)).text()).includes(target));
				assert.ok((await (await mf.dispatchFetch(origin + "/")).text()).includes(target));
				const tenant = await mf.getWorker(backplaneConfig.name);
				await expectStatus(await tenant.fetch("https://remote.inventory.example.test/login"), 404);
				await expectStatus(await tenant.fetch(target + "/login"), 200);
			});
		} finally {
			await mf.dispose();
		}
	},
);
