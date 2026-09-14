import * as v from "valibot";
import { jsonObjectSchema, parse } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";

export const MIB = 1024 * 1024;
export const DEFAULT_REQUEST_MIB = 16;
const allowance = v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(1048576));
export const policyObjectSchema = v.strictObject({
	suspended: v.optional(v.boolean(), false),
	scheduledJobsEnabled: v.optional(v.boolean(), true),
	pauseJobsAfterInactiveDays: v.optional(
		v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3650))),
		null,
	),
	maxRequestMiB: v.optional(
		v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(32)),
		DEFAULT_REQUEST_MIB,
	),
	maxDatabaseMiB: v.optional(allowance, 256),
	maxStorageMiB: v.optional(allowance, 1024),
});
export const tenantPolicySchema = v.pipe(jsonObjectSchema, policyObjectSchema);
export type TenantPolicy = v.InferOutput<typeof tenantPolicySchema>;
export const policyOverridesSchema = v.pipe(jsonObjectSchema, v.partial(policyObjectSchema));
export type PolicyOverrides = v.InferOutput<typeof policyOverridesSchema>;
export function tenantPolicy(value: unknown): TenantPolicy {
	return parse(tenantPolicySchema, value, 400, "Invalid workspace limits or job settings.");
}
export function effectivePolicy(value: unknown, overrides: unknown = {}): TenantPolicy {
	const defaults = parse(
		tenantPolicySchema,
		value === undefined ? {} : value,
		503,
		"TENANT_DEFAULTS must contain valid workspace limits and job settings.",
	);
	return tenantPolicy({
		...defaults,
		...parse(policyOverridesSchema, overrides, 503, "Invalid saved workspace policy."),
	});
}
export type JobsPausedReason = "suspended" | "manual" | "inactive" | null;
export function jobsPausedReason(policy: TenantPolicy, lastActivity: number, now: number): JobsPausedReason {
	if (policy.suspended) return "suspended";
	if (!policy.scheduledJobsEnabled) return "manual";
	if (
		policy.pauseJobsAfterInactiveDays !== null &&
		now - lastActivity >= policy.pauseJobsAfterInactiveDays * 86400000
	)
		return "inactive";
	return null;
}
