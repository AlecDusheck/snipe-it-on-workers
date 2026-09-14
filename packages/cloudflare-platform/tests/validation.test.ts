import { test } from "node:test";
import assert from "node:assert/strict";
import { slugValid, tenantInput } from "../src/validation";
import { HttpError } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";
import {
	parseHttpOutput,
	parseRelease,
	parseRuntimeOutput,
	releaseName,
} from "@simplyalec/laravel-cf-workers-laravel-runtime/validation";
import { readBody, toResponse, toHttpInput } from "../src/http";

const valid = {
	slug: "acme-it",
	name: "Acme IT",
};
for (const slug of [
	"ab",
	"Abc",
	"-abc",
	"abc-",
	"abc.def",
	"abc/def",
	"www",
	"api",
	"admin",
	"a".repeat(41),
	"ábc",
	"abc\n",
])
	test(`reject tenant address ${JSON.stringify(slug)}`, () => assert.equal(slugValid(slug), false));
for (const slug of ["abc", "acme-it", "a12", "a".repeat(40)])
	test(`accept tenant address ${slug}`, () => assert.equal(slugValid(slug), true));
for (const patch of [{ name: "" }, { name: " " }, { name: "x".repeat(101) }, { name: "x\ny" }])
	test(`reject invalid input ${Object.keys(patch)[0]} ${JSON.stringify(patch)}`, () =>
		assert.throws(() => tenantInput({ ...valid, ...patch }), HttpError));
test("normalizes the directory label without preconfiguring the application", () =>
	assert.deepEqual(tenantInput({ ...valid, name: " Acme " }), { ...valid, name: "Acme" }));

for (const input of [null, [], true, "text", 1])
	test(`reject non-object input ${JSON.stringify(input)}`, () =>
		assert.throws(() => tenantInput(input), HttpError));
test("release names are directory-safe", () => {
	assert.ok(releaseName("snipeit-8.7.2"));
	for (const value of ["", ".hidden", "../x", "Snipe It", "a".repeat(81)])
		assert.equal(releaseName(value), false);
});
test("reject corrupt release manifests", () => {
	for (const value of [
		null,
		{},
		{ name: "../x" },
		{ name: "app-1", version: "v1", compatibilityDate: "yesterday", files: {} },
	])
		assert.throws(() => parseRelease(value), HttpError);
});
test("RPC requires a real ArrayBuffer and validated response", () => {
	for (const value of [
		{},
		{ database: [], response: {} },
		{
			database: new ArrayBuffer(0),
			ephemeral: new ArrayBuffer(0),
			response: { status: 700, body: "", headers: [] },
		},
	])
		assert.throws(() => parseRuntimeOutput(value), HttpError);
});
for (const status of [0, 101, 199, 600, 200.5, NaN])
	test(`reject invalid HTTP status ${status}`, () =>
		assert.throws(() => parseHttpOutput({ status, headers: [], body: "" }), HttpError));
test("multiple Set-Cookie headers survive the response adapter", () => {
	const response = toResponse(
		{
			status: 200,
			headers: [
				["Set-Cookie", "a=1; HttpOnly"],
				["Set-Cookie", "b=2"],
				["Content-Length", "999"],
			],
			body: btoa("hello"),
		},
		"GET",
	);
	assert.deepEqual(response.headers.getSetCookie(), ["a=1; HttpOnly", "b=2"]);
	assert.equal(response.headers.get("content-length"), null);
});
test("HEAD and no-content responses have no body", async () => {
	for (const [method, status] of [
		["HEAD", 200],
		["GET", 204],
		["GET", 304],
	]) {
		assert.equal(typeof method, "string");
		assert.equal(typeof status, "number");
		if (typeof method !== "string" || typeof status !== "number") throw new Error("Invalid fixture");
		assert.equal(await toResponse({ status, headers: [], body: btoa("ignored") }, method).text(), "");
	}
});
test("request adapter strips spoofed forwarding and internal headers", async () => {
	const input = await toHttpInput(
		new Request("https://acme.example/login", {
			headers: {
				"x-forwarded-host": "evil.test",
				"x-platform-slug": "other",
				cookie: "session=value",
				"cf-connecting-ip": "192.0.2.1",
			},
		}),
	);
	assert.deepEqual(input.headers, [
		["cookie", "session=value"],
		["x-platform-client-ip", "192.0.2.1"],
		["content-length", "0"],
	]);
});
test("multipart reaches native PHP unchanged, including its boundary and binary body", async () => {
	const data = new FormData();
	data.append("file", new Blob([new Uint8Array([0, 128, 255])]), "photo.png");
	const request = new Request("https://example.test", { method: "POST", body: data });
	const original = await request.clone().arrayBuffer();
	const input = await toHttpInput(request);
	assert.deepEqual(input.body, original);
	assert.deepEqual(input.headers, [
		["content-type", request.headers.get("content-type")],
		["content-length", String(original.byteLength)],
	]);
});
test("bounds declared and actual request bodies", async () => {
	await assert.rejects(
		() =>
			readBody(
				new Request("https://example.test", {
					method: "POST",
					body: "large",
					headers: { "content-length": "2000" },
				}),
				4,
			),
		HttpError,
	);
	await assert.rejects(
		() => readBody(new Request("https://example.test", { method: "POST", body: "large" }), 4),
		HttpError,
	);
	assert.equal(
		new TextDecoder().decode(
			await readBody(new Request("https://example.test", { method: "POST", body: "okay" }), 4),
		),
		"okay",
	);
});

test("framework and application headers survive the PHP request boundary", async () => {
	const input = await toHttpInput(
		new Request("https://example.test/livewire/update", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-livewire": "",
				"x-app-feature": "enabled",
				origin: "https://example.test",
			},
			body: '{"components":[]}',
		}),
	);
	const headers = new Headers(input.headers);
	assert.equal(headers.has("x-livewire"), true);
	assert.equal(headers.get("x-app-feature"), "enabled");
	assert.equal(headers.get("origin"), "https://example.test");
	assert.equal(headers.get("content-length"), String(input.body.byteLength));
});

test("transport headers and proxy aliases cannot cross into PHP", async () => {
	const input = await toHttpInput(
		new Request("https://example.test/", {
			headers: {
				connection: "keep-alive, x-hop-only",
				"x-hop-only": "hidden",
				"keep-alive": "timeout=5",
				forwarded: "host=evil.test;proto=http",
				x_forwarded_host: "evil.test",
				x_platform_client_ip: "127.0.0.1",
				"x-real-ip": "127.0.0.1",
				host: "evil.test",
				proxy: "http://evil.test",
				"x-application": "kept",
			},
		}),
	);
	assert.deepEqual(input.headers, [
		["x-application", "kept"],
		["content-length", "0"],
	]);
});

test("declared request bodies preserve bytes and reject length mismatches", async () => {
	const bytes = new Uint8Array(131075).map((_, index) => index % 251);
	assert.deepEqual(
		await readBody(
			new Request("https://test", {
				method: "POST",
				body: bytes,
				headers: { "content-length": String(bytes.length) },
			}),
		),
		bytes,
	);
	for (const length of [2, 9])
		await assert.rejects(
			readBody(
				new Request("https://test", {
					method: "POST",
					body: "test",
					headers: { "content-length": String(length) },
				}),
			),
			{ status: 400 },
		);
});
