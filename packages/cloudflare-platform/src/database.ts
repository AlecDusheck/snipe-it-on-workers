import * as v from "valibot";
import { HttpError, jsonObjectSchema, parse } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";
import { fromBase64 } from "@simplyalec/laravel-cf-workers-laravel-runtime/crypto";
import type {
	DatabaseAction,
	DatabasePage,
	DatabaseRow,
	HttpOutput,
} from "@simplyalec/laravel-cf-workers-laravel-runtime/types";

export const tableSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(255), v.excludes("\0"));
export const offsetSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(10000000));
// Valibot records omit __proto__ and constructor, both valid SQL column names.
export const rowSchema = v.pipe(
	jsonObjectSchema,
	v.maxEntries(256),
	v.transform((value) => Object.entries(value)),
	v.array(v.strictTuple([v.string(), v.nullable(v.string())])),
	v.transform((entries): DatabaseRow => Object.fromEntries(entries)),
);
const actionSchema = v.variant("kind", [
	v.strictObject({
		kind: v.literal("inspect"),
		table: v.nullable(tableSchema),
		offset: offsetSchema,
	}),
	v.strictObject({ kind: v.literal("update"), table: tableSchema, original: rowSchema, values: rowSchema }),
]);
export function databaseRow(value: unknown): DatabaseRow {
	return parse(
		rowSchema,
		value,
		400,
		"Column values must be strings or null, including numbers written as strings.",
	);
}
export function databaseAction(value: unknown): DatabaseAction {
	const action = parse(actionSchema, value, 400, "Invalid database operation, table or row values.");
	if (action.kind === "update" && new TextEncoder().encode(JSON.stringify(action)).byteLength > 128 * 1024)
		throw new HttpError(413, "Row edit exceeds 128 KiB.");
	return action;
}
const pageSchema = v.object({
	tables: v.array(v.string()),
	table: v.nullable(v.string()),
	columns: v.array(v.object({ name: v.string(), type: v.string(), primaryKey: v.boolean() })),
	rows: v.array(v.object({ values: rowSchema, editable: v.boolean() })),
	offset: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
	hasMore: v.boolean(),
});
export function databaseResponse(response: HttpOutput): DatabasePage {
	const value: unknown = JSON.parse(new TextDecoder().decode(fromBase64(response.body)));
	if (response.status >= 400) {
		const failure = v.safeParse(v.object({ error: v.string() }), value);
		throw new HttpError(
			response.status,
			failure.success ? failure.output.error : "Database operation failed.",
		);
	}
	return parse(pageSchema, value, 502, "Invalid database response.");
}
