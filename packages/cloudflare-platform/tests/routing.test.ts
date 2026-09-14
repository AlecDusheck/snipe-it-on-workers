import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./support";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

let mf: Miniflare;
const origin = "https://workspaces.example.test";
const input = { slug: "acme", name: "Acme" };
before(async () => {
	const backend = await bundle(fileURLToPath(new URL("./fixtures/routing-worker.ts", import.meta.url)));
	const client = await bundle(fileURLToPath(new URL("./fixtures/rpc-client-worker.ts", import.meta.url)));
	mf = new Miniflare(
		convertV4MiniflareOptions({
			workers: [
				{
					name: "rpc-client",
					modules: true,
					script: client,
					compatibilityDate: "2026-09-01",
					serviceBindings: {
						CONTROL: { name: "routes", entrypoint: "BackplaneControl" },
						TENANT_HTTP: "routes",
					},
				},
				{
					name: "routes",
					modules: true,
					script: backend,
					compatibilityDate: "2026-09-01",
					compatibilityFlags: ["nodejs_compat"],
					kvNamespaces: ["DIRECTORY"],
					durableObjects: { TENANTS: { className: "RouteTarget", useSQLite: true } },
				},
			],
		}),
	);
});
after(async () => {
	await mf.dispose();
});
const provision = (data: unknown, key = "test-request-key-12345") =>
	mf.dispatchFetch(origin + "/__test/provision", {
		method: "POST",
		headers: { "idempotency-key": key },
		body: JSON.stringify(data),
	});

test("named Worker binding provisions via typed RPC without tokens", async () => {
	const response = await provision(input);
	assert.equal(response.status, 201);
	assert.deepEqual(await response.json(), {
		ok: true,
		value: { input, requestKey: "test-request-key-12345" },
	});
});
test("named Worker binding upgrades via RPC", async () => {
	const response = await mf.dispatchFetch(origin + "/__test/upgrade", {
		method: "POST",
		body: JSON.stringify({ slug: "acme", release: "application-1.0.0" }),
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		ok: true,
		value: { slug: "acme", release: "application-1.0.0" },
	});
});
test("RPC validates the retry key and untrusted inputs", async () => {
	assert.equal((await provision(input, "short")).status, 400);
	for (const data of [null, {}, { ...input, slug: "../bad" }, { ...input, name: "a".repeat(200) }])
		assert.equal((await provision(data)).status, 400);
});
test("invalid upgrade slugs are rejected across RPC", async () => {
	assert.equal(
		(
			await mf.dispatchFetch(origin + "/__test/upgrade", {
				method: "POST",
				body: JSON.stringify({ slug: "INVALID", release: "v1" }),
			})
		).status,
		400,
	);
});
test("tenant route overwrites a forged routing header", async () => {
	const response = await mf.dispatchFetch("https://acme.workspaces.example.test/login", {
		headers: { "x-platform-slug": "victim" },
	});
	assert.deepEqual(await response.json(), { path: "/login", slug: "acme", key: null, body: "" });
});
for (const path of ["/releases/catalog.json", "/__platform/provision", "/.env"]) {
	test(`private path ${path} is unreachable on both hosts`, async () => {
		assert.equal((await mf.dispatchFetch(origin + path)).status, 404);
		assert.equal((await mf.dispatchFetch("https://acme.workspaces.example.test" + path)).status, 404);
	});
}
test("public control API routes do not exist", async () => {
	for (const path of [
		"/api/tenants",
		"/api/tenants/acme/upgrade",
		"/createTenant",
		"/BackplaneControl/createTenant",
	])
		assert.equal(
			(await mf.dispatchFetch(origin + path, { method: "POST", body: JSON.stringify(input) })).status,
			404,
		);
});
test("unrecognized hosts and nested subdomains are rejected", async () => {
	for (const host of [
		"https://elsewhere.example",
		"https://nested.acme.workspaces.example.test",
		"https://www.workspaces.example.test",
	])
		assert.equal((await mf.dispatchFetch(host + "/login")).status, 404);
});

test("database RPC validates input before selecting a tenant", async () => {
	for (const payload of [
		{ slug: "../bad", action: {} },
		{ slug: "acme", action: { kind: "sql" } },
		{ slug: "acme", action: { kind: "inspect", table: "users", offset: -1 } },
	])
		assert.equal(
			(await mf.dispatchFetch(origin + "/__test/database", { method: "POST", body: JSON.stringify(payload) }))
				.status,
			400,
		);
});
