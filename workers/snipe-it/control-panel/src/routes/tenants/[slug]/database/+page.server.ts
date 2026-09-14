import { error } from "@sveltejs/kit";
import * as v from "valibot";
import type { PageServerLoad } from "./$types";
import { offsetSchema } from "@simplyalec/laravel-cf-workers-cloudflare-platform/database";
import { slugValid } from "@simplyalec/laravel-cf-workers-cloudflare-platform/validation";

const number = (schema: v.GenericSchema<number, number>, fallback: string) =>
	v.optional(v.pipe(v.string(), v.transform(Number), schema), fallback);
const pageSchema = v.object({
	table: v.optional(v.string()),
	offset: number(offsetSchema, "0"),
	row: number(v.pipe(v.number(), v.integer(), v.minValue(-1), v.maxValue(49)), "-1"),
});

export const load: PageServerLoad = ({ params, url }) => {
	const page = v.safeParse(pageSchema, Object.fromEntries(url.searchParams));
	if (!slugValid(params.slug) || !page.success) error(400, "Invalid database page.");
	return { slug: params.slug, ...page.output, table: page.output.table ?? null };
};
