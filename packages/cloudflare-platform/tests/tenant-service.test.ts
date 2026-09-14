import { MAX_MANIFEST_BYTES } from "@simplyalec/laravel-cf-workers-laravel-runtime/files";
import { test } from "node:test";
import assert from "node:assert/strict";
import { TenantService } from "../src/tenant-service";
import { SerialQueue } from "@simplyalec/laravel-cf-workers-laravel-runtime/queue";
import { base64, digestText } from "@simplyalec/laravel-cf-workers-laravel-runtime/crypto";
import { HttpError } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";
import { tenantPolicy } from "../src/policy";
import type { TenantDependencies, TenantSecrets, Snapshot, SnapshotWrite } from "../src/types";
import type {
	DatabaseAction,
	HttpInput,
	Release,
	RuntimeInput,
	RuntimeOutput,
} from "@simplyalec/laravel-cf-workers-laravel-runtime/types";

const release: Release = {
	name: "app-8.7.2",
	version: "v8.7.2",
	compatibilityDate: "2026-09-01",
	files: {
		worker: "a".repeat(64),
		wasm: "b".repeat(64),
		index: "e".repeat(64),
	},
	corpus: { bytes: 0, partBytes: 1048576, parts: [] },
};
const nextRelease: Release = { ...release, name: "app-8.7.3", version: "v8.7.3" };
const request: HttpInput = {
	url: "https://acme.example/",
	method: "GET",
	headers: [],
	body: new ArrayBuffer(0),
};

class Memory implements TenantDependencies {
	snapshot: Snapshot | null = null;
	secrets: TenantSecrets | undefined;
	failCommit = false;
	failRun = false;
	status = 200;
	body = "";
	bytes = 8;
	change = true;
	writes = 0;
	runs: RuntimeInput[] = [];
	async policy() {
		return tenantPolicy({});
	}
	environment() {
		return {};
	}
	async read() {
		return this.snapshot ? { ...this.snapshot, bytes: this.snapshot.bytes.slice(0) } : null;
	}
	async readEphemeral() {
		return new ArrayBuffer(0);
	}
	async commit(value: SnapshotWrite | null, previous: Snapshot | null) {
		if (this.failCommit) throw new Error("Injected storage failure");
		if (previous?.etag !== this.snapshot?.etag) throw new HttpError(409, "Conflict");
		if (!value) return;
		this.writes++;
		this.snapshot = { ...value, bytes: value.bytes.slice(0), etag: String(this.writes) };
	}
	async getSecrets() {
		return this.secrets;
	}
	async putSecrets(value: TenantSecrets) {
		this.secrets = value;
	}
	async release(name: string) {
		if (name === "missing") throw new HttpError(404, "Missing release");
		return name === nextRelease.name ? nextRelease : release;
	}
	async run(_release: Release, value: RuntimeInput): Promise<RuntimeOutput> {
		this.runs.push(value);
		const buffer = this.change ? new ArrayBuffer(this.bytes) : value.database.slice(0);
		if (this.change && buffer.byteLength)
			new Uint8Array(buffer)[0] = (new Uint8Array(value.database)[0] ?? 0) + 1;
		if (this.failRun) {
			new Uint8Array(value.database)[0] = 255;
			throw new Error("Injected PHP failure");
		}
		return {
			database: buffer,
			ephemeral: new ArrayBuffer(0),
			response: { status: this.status, headers: [], body: this.body },
		};
	}
}

async function fixture() {
	const memory = new Memory();
	memory.secrets = {
		appKey: "fixture",
		files: {},
		creationKey: await digestText("request-key"),
	};
	const service = new TenantService(memory, "https://acme.example");
	return { memory, service };
}

test("provision saves a snapshot before returning and keeps credentials out of metadata", async () => {
	const { memory, service } = await fixture();
	assert.equal(await service.provision("request-key", "default"), release.name);
	assert.equal(memory.writes, 1);
	assert.equal(memory.snapshot?.revision, 1);
	assert.ok(!JSON.stringify(memory.snapshot).includes("appKey"));
});
test("same creation key can retry without resetting credentials", async () => {
	const { memory, service } = await fixture();
	await service.provision("request-key", "default");
	await service.provision("request-key", "default");
	assert.equal(memory.runs.length, 1);
});
test("conflicting creation keys cannot take over a reserved slug", async () => {
	const { service, memory } = await fixture();
	await assert.rejects(() => service.provision("another-key", "default"), { status: 409 });
	assert.equal(memory.runs.length, 0);
});
test("unknown release does not reserve a new workspace", async () => {
	const { service, memory } = await fixture();
	memory.secrets = undefined;
	await assert.rejects(() => service.provision("new-key", "missing"), { status: 404 });
	assert.equal(memory.secrets, undefined);
});
test("failed first snapshot write is recoverable with the same creation key", async () => {
	const { memory, service } = await fixture();
	memory.failCommit = true;
	await assert.rejects(() => service.provision("request-key", "default"));
	assert.equal(memory.snapshot, null);
	memory.failCommit = false;
	await service.provision("request-key", "default");
	assert.equal((await memory.read())?.revision, 1);
});
test("a failed snapshot write cannot leak tentative state into the next request", async () => {
	const { memory, service } = await fixture();
	await service.provision("request-key", "default");
	memory.failCommit = true;
	await assert.rejects(() => service.http(request));
	memory.failCommit = false;
	await service.http(request);
	assert.equal(new Uint8Array(memory.snapshot?.bytes ?? new ArrayBuffer(0))[0], 2);
});
test("PHP failure cannot mutate the committed baseline", async () => {
	const { memory, service } = await fixture();
	await service.provision("request-key", "default");
	memory.failRun = true;
	await assert.rejects(() => service.http(request));
	assert.equal(new Uint8Array(memory.snapshot?.bytes ?? new ArrayBuffer(0))[0], 1);
});
test("application 500 discards database changes", async () => {
	const { memory, service } = await fixture();
	await service.provision("request-key", "default");
	memory.status = 500;
	await assert.rejects(() => service.http(request), { status: 502 });
	assert.equal(memory.writes, 1);
});
test("ordinary 4xx may persist rate-limit and session state", async () => {
	const { memory, service } = await fixture();
	await service.provision("request-key", "default");
	memory.status = 429;
	assert.equal((await service.http(request)).status, 429);
	assert.equal(memory.writes, 2);
});
test("read-only requests avoid unnecessary snapshot writes", async () => {
	const { memory, service } = await fixture();
	await service.provision("request-key", "default");
	memory.change = false;
	await service.http(request);
	assert.equal(memory.writes, 1);
});
test("oversized snapshots are never acknowledged", async () => {
	const { memory, service } = await fixture();
	await service.provision("request-key", "default");
	memory.bytes = MAX_MANIFEST_BYTES + 1;
	await assert.rejects(() => service.http(request), { status: 413 });
	assert.equal(memory.writes, 1);
});
test("missing workspace and missing encryption keys fail closed", async () => {
	const { memory, service } = await fixture();
	await assert.rejects(() => service.http(request), { status: 404 });
	await service.provision("request-key", "default");
	memory.secrets = undefined;
	await assert.rejects(() => service.http(request), { status: 503 });
});
test("restart reconstructs the request from durable state", async () => {
	const { memory, service } = await fixture();
	await service.provision("request-key", "default");
	const restarted = new TenantService(memory, "https://acme.example");
	await restarted.http(request);
	assert.equal(memory.snapshot?.revision, 2);
});
test("upgrade commits the new release with the migrated snapshot", async () => {
	const { memory, service } = await fixture();
	await service.provision("request-key", "default");
	assert.equal(await service.upgrade(nextRelease.name), nextRelease.name);
	assert.equal(memory.snapshot?.release, nextRelease.name);
	assert.equal(memory.runs.at(-1)?.command.kind, "migrate");
});
for (const failure of ["migration", "commit"])
	test(`${failure} failure leaves the old release active`, async () => {
		const { memory, service } = await fixture();
		await service.provision("request-key", "default");
		memory.failRun = failure === "migration";
		memory.failCommit = failure === "commit";
		await assert.rejects(() => service.upgrade(nextRelease.name));
		assert.equal(memory.snapshot?.release, release.name);
		assert.equal(memory.snapshot?.revision, 1);
	});
test("upgrading to the current release is a no-op", async () => {
	const { memory, service } = await fixture();
	await service.provision("request-key", "default");
	await service.upgrade(release.name);
	assert.equal(memory.runs.length, 1);
});
test("a downgrade cannot run migrations or change an upgraded tenant", async () => {
	const { memory, service } = await fixture();
	await service.provision("request-key", "default");
	await service.upgrade(nextRelease.name);
	const previous = await memory.read();
	await assert.rejects(() => service.upgrade(release.name), { status: 409 });
	assert.deepEqual(await memory.read(), previous);
	assert.equal(memory.runs.length, 2);
});
test("one hundred concurrent requests are serialized without lost updates", async () => {
	const { memory, service } = await fixture();
	await service.provision("request-key", "default");
	const queue = new SerialQueue();
	await Promise.all(Array.from({ length: 100 }, () => queue.run(() => service.http(request))));
	assert.equal(new Uint8Array(memory.snapshot?.bytes ?? new ArrayBuffer(0))[0], 101);
	assert.equal(memory.snapshot?.revision, 101);
});
test("an error does not poison the tenant queue", async () => {
	const queue = new SerialQueue();
	const first = queue.run(async () => {
		throw new Error("expected");
	});
	const second = queue.run(async () => 2);
	await assert.rejects(() => first);
	assert.equal(await second, 2);
});
test("separate tenants have separate snapshots", async () => {
	const a = await fixture();
	const b = await fixture();
	await a.service.provision("request-key", "default");
	await b.service.provision("request-key", "default");
	await a.service.http(request);
	assert.equal(a.memory.snapshot?.revision, 2);
	assert.equal(b.memory.snapshot?.revision, 1);
});

const databasePage = { tables: ["users"], table: "users", columns: [], rows: [], offset: 0, hasMore: false };
const inspect = {
	kind: "inspect",
	table: "users",
	offset: 0,
} satisfies DatabaseAction;
const update = {
	kind: "update",
	table: "users",
	original: { id: "1" },
	values: { id: "1" },
} satisfies DatabaseAction;
async function databaseFixture() {
	const fixtureValue = await fixture();
	await fixtureValue.service.provision("request-key", "default");
	fixtureValue.memory.body = base64(new TextEncoder().encode(JSON.stringify(databasePage)));
	return fixtureValue;
}
test("database inspection never commits runtime side effects", async () => {
	const { memory, service } = await databaseFixture();
	assert.deepEqual(await service.database(inspect), databasePage);
	assert.equal(memory.writes, 1);
});
test("database update commits a new revision of the current release", async () => {
	const { memory, service } = await databaseFixture();
	assert.deepEqual(await service.database(update), databasePage);
	assert.equal(memory.writes, 2);
	assert.equal(memory.snapshot?.release, release.name);
});
for (const failure of ["runtime", "commit", "conflict", "invalid-response"])
	test(`database ${failure} failure preserves the original snapshot`, async () => {
		const { memory, service } = await databaseFixture();
		const original = await memory.read();
		memory.failRun = failure === "runtime";
		memory.failCommit = failure === "commit";
		if (failure === "conflict") {
			memory.status = 409;
			memory.body = base64(new TextEncoder().encode('{"error":"Row changed"}'));
		}
		if (failure === "invalid-response") memory.body = "";
		await assert.rejects(() => service.database(update));
		assert.deepEqual(await memory.read(), original);
	});
