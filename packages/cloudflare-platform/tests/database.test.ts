import { test } from "node:test";
import assert from "node:assert/strict";
import { databaseAction, databaseResponse, databaseRow } from "../src/database";
import { base64 } from "@simplyalec/laravel-cf-workers-laravel-runtime/crypto";

test("database inspection validates table selection and row offset", () => {
	assert.deepEqual(databaseAction({ kind: "inspect", table: null, offset: 0 }), {
		kind: "inspect",
		table: null,
		offset: 0,
	});
	for (const offset of [-1, 1.5, Infinity, NaN, 10000001, "0"])
		assert.throws(() => databaseAction({ kind: "inspect", table: "users", offset }), { status: 400 });
});
for (const table of ["", "bad\0table", "x".repeat(256), 3, undefined])
	test(`database rejects invalid table ${String(table).slice(0, 30)}`, () => {
		assert.throws(() => databaseAction({ kind: "inspect", table, offset: 0 }), { status: 400 });
	});
test("database edits preserve null, Unicode and integers larger than JavaScript's range", () => {
	const original = { id: "9223372036854775807", name: "💻", notes: null };
	assert.deepEqual(databaseAction({ kind: "update", table: "assets", original, values: original }), {
		kind: "update",
		table: "assets",
		original,
		values: original,
	});
});
for (const value of [null, [], { id: 3 }, { id: true }, { id: {} }, { id: [] }])
	test(`database row rejects non-string values ${JSON.stringify(value)}`, () =>
		assert.throws(() => databaseRow(value), { status: 400 }));
test("database row names cannot mutate prototypes", () => {
	const value: unknown = JSON.parse('{"__proto__":"safe","constructor":"value"}');
	const row = databaseRow(value);
	assert.equal(Object.getPrototypeOf(row), Object.prototype);
	assert.equal(row.__proto__, "safe");
});
test("oversized edits and unknown operations are rejected", () => {
	assert.throws(() => databaseAction({ kind: "sql", sql: "DELETE FROM users" }), { status: 400 });
	assert.throws(
		() =>
			databaseAction({ kind: "update", table: "users", original: {}, values: { notes: "x".repeat(131073) } }),
		{ status: 413 },
	);
});
const response = (value: unknown, status = 200) => ({
	status,
	headers: [],
	body: base64(new TextEncoder().encode(JSON.stringify(value))),
});
test("database responses are validated and expected failures retain their status", () => {
	const page = {
		tables: ["users"],
		table: "users",
		columns: [{ name: "id", type: "INTEGER", primaryKey: true }],
		rows: [{ values: { id: "1" }, editable: true }],
		offset: 0,
		hasMore: false,
	};
	assert.deepEqual(databaseResponse(response(page)), page);
	for (const invalid of [
		null,
		{ ...page, columns: [null] },
		{ ...page, rows: [{}] },
		{ ...page, tables: [3] },
	])
		assert.throws(() => databaseResponse(response(invalid)), { status: 502 });
	assert.throws(() => databaseResponse(response({ error: "Changed" }, 409)), {
		status: 409,
		message: "Changed",
	});
});
