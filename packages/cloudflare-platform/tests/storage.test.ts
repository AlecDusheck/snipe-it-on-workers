import { fileURLToPath } from "node:url";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./support";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { record } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";

let mf: Miniflare;
const release = `r-${"a".repeat(64)}`;
before(async () => {
	const source = await bundle(fileURLToPath(new URL("./fixtures/storage-worker.ts", import.meta.url)));
	mf = new Miniflare(
		convertV4MiniflareOptions({
			workers: [
				{
					name: "storage-test",
					modules: true,
					script: source,
					compatibilityDate: "2026-09-01",
					kvNamespaces: ["DIRECTORY"],
					durableObjects: { INSTANCES: { className: "StorageFixture", useSQLite: true } },
				},
			],
		}),
	);
});
after(async () => {
	await mf.dispose();
});
const save = (
	tenant: string,
	value: number,
	revision: number,
	etag: string | null,
	targetRelease = release,
) =>
	mf.dispatchFetch(`https://test/?tenant=${tenant}`, {
		method: "POST",
		body: JSON.stringify({ value, revision, etag, release: targetRelease }),
	});
async function read(tenant: string) {
	const value: unknown = await (await mf.dispatchFetch(`https://test/?tenant=${tenant}`)).json();
	if (!record(value)) throw new Error("Missing snapshot");
	return value;
}

test("Durable Object first-write condition prevents a second initialization", async () => {
	assert.equal((await save("first", 1, 1, null)).status, 200);
	assert.equal((await save("first", 2, 1, null)).status, 409);
	assert.deepEqual((await read("first")).bytes, [1]);
});
test("Durable Object revision token comparison rejects a stale writer", async () => {
	await save("cas", 1, 1, null);
	const first = await read("cas");
	if (typeof first.etag !== "string") throw new Error("Missing revision token");
	assert.equal((await save("cas", 2, 2, first.etag)).status, 200);
	assert.equal((await save("cas", 3, 3, first.etag)).status, 409);
	assert.deepEqual((await read("cas")).bytes, [2]);
});
test("Durable Object snapshot bytes and release metadata change in the same write", async () => {
	await save("upgrade", 1, 1, null);
	const first = await read("upgrade");
	if (typeof first.etag !== "string") throw new Error("Missing revision token");
	const next = `r-${"b".repeat(64)}`;
	await save("upgrade", 2, 2, first.etag, next);
	const current = await read("upgrade");
	assert.equal(current.release, next);
	assert.equal(current.revision, 2);
	assert.deepEqual(current.bytes, [2]);
});
test("release changes invalidate old revision tokens even when the database bytes are identical", async () => {
	await save("same-bytes", 7, 1, null);
	const first = await read("same-bytes");
	if (typeof first.etag !== "string") throw new Error("Missing revision token");
	await save("same-bytes", 7, 2, first.etag, `r-${"b".repeat(64)}`);
	assert.notEqual((await read("same-bytes")).etag, first.etag);
	assert.equal((await save("same-bytes", 8, 2, first.etag)).status, 409);
});
test("Durable Object namespaces isolate tenants", async () => {
	await save("other", 99, 1, null);
	assert.deepEqual((await read("other")).bytes, [99]);
	assert.deepEqual((await read("first")).bytes, [1]);
});
test("tenant directory is paginated, immutable on retries and separate from snapshots", async () => {
	const descriptors = Array.from({ length: 61 }, (_, i) => ({
		slug: `workspace-${String(i).padStart(3, "0")}`,
		name: `Team ${i} 💻`,
		url: `https://workspace-${String(i).padStart(3, "0")}.example.test`,
		createdAt: "2026-09-09T00:00:00Z",
	}));
	const list: unknown = await (
		await mf.dispatchFetch("https://test/directory", { method: "POST", body: JSON.stringify(descriptors) })
	).json();
	assert.ok(record(list));
	assert.ok(Array.isArray(list.tenants));
	assert.equal(list.tenants.length, 50);
	assert.deepEqual(list.tenants[0], descriptors[0]);
	assert.equal(typeof list.cursor, "string");
	const next: unknown = await (
		await mf.dispatchFetch(`https://test/directory?cursor=${encodeURIComponent(String(list.cursor))}`)
	).json();
	assert.ok(record(next));
	assert.ok(Array.isArray(next.tenants));
	assert.equal(next.tenants.length, 11);
	assert.equal(next.cursor, null);
	const retry: unknown = await (
		await mf.dispatchFetch("https://test/directory", {
			method: "POST",
			body: JSON.stringify([{ ...descriptors[0], name: "Changed on retry" }]),
		})
	).json();
	assert.ok(record(retry));
	assert.ok(Array.isArray(retry.tenants));
	assert.deepEqual(retry.tenants[0], descriptors[0]);
	assert.deepEqual((await read("first")).bytes, [1]);
});

async function command(tenant: string, input: unknown) {
	return mf.dispatchFetch(`https://test/?tenant=${tenant}`, { method: "POST", body: JSON.stringify(input) });
}
async function block(tenant: string, value: number): Promise<string> {
	const hash: unknown = await (await command(tenant, { op: "write", value })).json();
	assert.equal(typeof hash, "string");
	if (typeof hash !== "string") throw new Error("Missing hash");
	return hash;
}
test("sessions persist without changing the application revision", async () => {
	await save("sessions", 1, 1, null);
	const original = await read("sessions");
	await command("sessions", { op: "ephemeral", value: 2, revision: 1, release, etag: original.etag });
	assert.deepEqual(await read("sessions"), { ...original, ephemeral: [2] });
});
test("missing blocks roll back both trees and the revision together", async () => {
	await save("rollback", 1, 1, null);
	const original = await read("rollback");
	const result = await command("rollback", {
		value: 2,
		revision: 2,
		release,
		etag: original.etag,
		hash: "a".repeat(64),
	});
	assert.equal(result.status, 503);
	assert.deepEqual(await read("rollback"), original);
});
test("collection retains committed blocks and leases, then reclaims abandoned writes", async () => {
	const tenant = "collection";
	const retained = await block(tenant, 10);
	const leased = await block(tenant, 20);
	const abandoned = await block(tenant, 30);
	await command(tenant, { value: 1, revision: 1, release, etag: null, hash: retained });
	await command(tenant, { op: "lease", hash: leased });
	await command(tenant, { op: "collect", now: Date.now() + 7200000 });
	assert.equal((await command(tenant, { op: "read", hash: abandoned })).status, 503);
	assert.equal((await command(tenant, { op: "read", hash: retained })).status, 200);
	assert.equal((await command(tenant, { op: "read", hash: leased })).status, 200);
	await command(tenant, { op: "release", hash: leased });
	const result = await command(tenant, { op: "collect", now: Date.now() + 7200000 });
	assert.deepEqual(await result.json(), { pending: false });
	assert.equal((await command(tenant, { op: "read", hash: leased })).status, 503);
});
test("abandoned download leases expire and staged blocks receive a grace period", async () => {
	const hash = await block("grace", 31);
	await command("grace", { op: "collect", now: Date.now() });
	assert.equal((await command("grace", { op: "read", hash })).status, 200);
	await command("grace", { op: "lease", hash });
	await command("grace", { op: "collect", now: Date.now() + 86400001 });
	assert.equal((await command("grace", { op: "read", hash })).status, 503);
});
test("block reads verify content and cannot cross instance boundaries", async () => {
	const hash = await block("checksum", 42);
	assert.equal((await command("other-instance", { op: "read", hash })).status, 503);
	await command("checksum", { op: "corrupt", hash });
	assert.equal((await command("checksum", { op: "read", hash })).status, 503);
});
const route = (slug: string, origin: string, method = "GET") =>
	mf.dispatchFetch(`https://test/route?slug=${slug}&origin=${encodeURIComponent(origin)}`, { method });
test("KV reserves a hostname for one tenant, idempotently, and keeps pending instances unlisted", async () => {
	const url = "https://unique.example.test";
	const responses = await Promise.all([route("pending-one", url, "POST"), route("pending-two", url, "POST")]);
	assert.deepEqual(responses.map((response) => response.status).toSorted(), [200, 409]);
	const winner = await (await route("unused", url)).json();
	assert.equal((await route(String(winner), url, "POST")).status, 200);
	assert.equal((await route(String(winner), "https://elsewhere.example.test", "POST")).status, 200);
	assert.equal((await route("workspace-000", url, "POST")).status, 409);
	const page: unknown = await (await mf.dispatchFetch("https://test/directory")).json();
	assert.ok(record(page) && Array.isArray(page.tenants));
	assert.ok(!page.tenants.some((tenant) => record(tenant) && String(tenant.slug).startsWith("pending-")));
});
test("KV URL changes release the old hostname and reject a conflicting hostname", async () => {
	const old = "https://workspace-000.example.test";
	const next = "https://moved.example.test";
	assert.equal((await route("workspace-000", next, "PUT")).status, 200);
	assert.equal(await (await route("unused", old)).json(), null);
	assert.equal(await (await route("unused", next)).json(), "workspace-000");
	assert.equal((await route("workspace-001", next, "PUT")).status, 409);
	assert.equal(await (await route("unused", "https://workspace-001.example.test")).json(), "workspace-001");
	assert.equal((await route("missing", next, "PUT")).status, 404);
});
test("directory pagination survives malformed cursors", async () => {
	const response = await mf.dispatchFetch("https://test/directory?cursor=../bad");
	assert.ok([200, 400].includes(response.status), String(response.status));
	if (response.status === 200) assert.deepEqual(await response.json(), { tenants: [], cursor: null });
});

const source = (tenant: string, path: string, extra: Record<string, unknown> = {}) =>
	mf.dispatchFetch(`https://test/?tenant=${tenant}`, {
		method: "POST",
		body: JSON.stringify({ op: "source", archive: "a".repeat(64), path, ...extra }),
	});
test("source cache survives calls, replaces corrupt entries and invalidates prior releases", async () => {
	assert.deepEqual(await (await source("sources", "vendor/a.php", { size: 17 })).json(), {
		size: 17,
		first: 1,
	});
	assert.deepEqual(await (await source("sources", "vendor/a.php")).json(), { size: 17, first: 1 });
	assert.deepEqual(await (await source("sources", "vendor/a.php", { size: 18, value: 2 })).json(), {
		size: 18,
		first: 2,
	});
	await source("sources", "vendor/new.php", { size: 3, archive: "b".repeat(64) });
	assert.equal(await (await source("sources", "vendor/a.php")).json(), null);
});
test("source cache has a separate bounded storage allowance", async () => {
	for (let index = 0; index < 65; index++)
		assert.equal((await source("source-budget", `file-${index}`, { size: 256 * 1024 })).status, 200);
	assert.deepEqual(await (await source("source-budget", "file-63")).json(), { size: 256 * 1024, first: 1 });
	assert.equal(await (await source("source-budget", "file-64")).json(), null);
});
test("source capability rejects oversized entries, unsafe keys and calls after disposal", async () => {
	for (const extra of [{ size: 256 * 1024 + 1 }, { archive: "not-a-digest" }, { closed: true }])
		assert.equal((await source("source-invalid", "vendor/file.php", extra)).status, 503);
	for (const path of ["../secret", "/secret", "a\\secret", "a\0secret"])
		assert.equal((await source("source-invalid", path)).status, 503);
});

test("concurrent buffered writes remain readable and share durability flushes", async () => {
	const response = await command("batch", { op: "batch" });
	const result: unknown = await response.json();
	assert.ok(record(result), JSON.stringify(result));
	assert.deepEqual(
		result.values,
		Array.from({ length: 10 }, (_, index) => index),
	);
	assert.equal(result.flushes, 3);
});
test("small source entries flush at the bounded entry count", async () => {
	const response = await command("source-batch", { op: "source-batch" });
	assert.deepEqual(await response.json(), {
		flushes: 1,
		values: Array.from({ length: 64 }, (_, index) => index),
	});
});
test("bytecode is independently retained, invalidated by release and reclaimed after replacement", async () => {
	const tenant = "bytecode";
	const first: unknown = await (await command(tenant, { op: "cache", value: 71 })).json();
	assert.ok(record(first) && typeof first.hash === "string");
	const unchanged: unknown = await (await command(tenant, { op: "cache", value: 71 })).json();
	assert.ok(record(unchanged));
	assert.equal(unchanged.changes, 0);
	await save(tenant, 1, 1, null);
	await command(tenant, { op: "collect", now: Date.now() + 7200000 });
	assert.equal((await command(tenant, { op: "read", hash: first.hash })).status, 200);
	assert.deepEqual(await (await command(tenant, { op: "cache", namespace: "b".repeat(64) })).json(), {
		bytes: 0,
	});
	await command(tenant, { op: "cache", value: 72, namespace: "b".repeat(64) });
	await command(tenant, { op: "collect", now: Date.now() + 7200000 });
	assert.equal((await command(tenant, { op: "read", hash: first.hash })).status, 503);
});

test("cache invalidation cannot collect a block still owned by application data", async () => {
	const tenant = "shared-cache-block";
	const first: unknown = await (await command(tenant, { op: "cache", value: 73 })).json();
	assert.ok(record(first) && typeof first.hash === "string");
	assert.equal(
		(await command(tenant, { value: 1, revision: 1, release, etag: null, hash: first.hash })).status,
		200,
	);
	await command(tenant, { op: "cache", value: 74, namespace: "b".repeat(64) });
	await command(tenant, { op: "collect", now: Date.now() + 7200000 });
	assert.deepEqual(await (await command(tenant, { op: "read", hash: first.hash })).json(), [73]);
});
