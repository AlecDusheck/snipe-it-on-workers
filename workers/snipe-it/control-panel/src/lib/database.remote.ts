import { form, query } from "$app/server";
import { invalid } from "@sveltejs/kit";
import * as v from "valibot";
import { backplane, unwrap, unwrapForm } from "$lib/server/backplane";
import {
	offsetSchema,
	rowSchema,
	tableSchema,
} from "@simplyalec/laravel-cf-workers-cloudflare-platform/database";
import { slugSchema } from "@simplyalec/laravel-cf-workers-cloudflare-platform/validation";

export const getDatabase = query(
	v.object({ slug: slugSchema, table: v.nullable(tableSchema), offset: offsetSchema }),
	async ({ slug, table, offset }) =>
		unwrap(await backplane().database(slug, { kind: "inspect", table, offset })),
);

function parseRow(text: string) {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		invalid("Enter valid JSON for the row.");
	}
	const row = v.safeParse(rowSchema, value);
	if (!row.success) invalid("Column values must be strings or null, including numbers written as strings.");
	return row.output;
}
const rowText = v.pipe(v.string(), v.maxLength(131072));
export const saveRow = form(
	v.object({
		slug: slugSchema,
		table: tableSchema,
		offset: v.pipe(v.string(), v.transform(Number), offsetSchema),
		_original: rowText,
		_values: rowText,
	}),
	async ({ slug, table, offset, _original, _values }) => {
		unwrapForm(
			await backplane().database(slug, {
				kind: "update",
				table,
				original: parseRow(_original),
				values: parseRow(_values),
			}),
		);
		await getDatabase({ slug, table, offset }).refresh();
		return { message: "Row saved." };
	},
);
