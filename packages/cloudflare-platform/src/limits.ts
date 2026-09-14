import * as v from "valibot";
import { jsonObjectSchema, parse } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";

const positiveInteger = (maximum: number) =>
	v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(maximum));
export const runtimeLimitsSchema = v.pipe(
	jsonObjectSchema,
	v.strictObject({
		httpCpuMs: v.optional(positiveInteger(300000), 60000),
		backgroundCpuMs: v.optional(positiveInteger(300000), 60000),
		subRequests: v.optional(positiveInteger(10000000), 10000),
	}),
);
export type RuntimeLimits = v.InferOutput<typeof runtimeLimitsSchema>;

// Per-invocation limits can only lower the parent ceilings configured in Wrangler.
export function runtimeLimits(value: unknown): RuntimeLimits {
	return parse(
		runtimeLimitsSchema,
		value === undefined ? {} : value,
		503,
		"RUNTIME_LIMITS must contain valid CPU and subrequest limits with no unknown settings.",
	);
}
