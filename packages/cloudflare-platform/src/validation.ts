import * as v from "valibot";
import { HttpError, parse } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";
import { releaseName } from "@simplyalec/laravel-cf-workers-laravel-runtime/validation";
import type { TenantInput } from "./types";

export function slugValid(value: string): boolean {
	return (
		/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(value) &&
		!["www", "api", "admin", "assets", "mail", "support", "status", "releases"].includes(value)
	);
}
export function requireSlug(value: unknown): string {
	if (typeof value !== "string" || !slugValid(value)) throw new HttpError(400, "Choose a workspace.");
	return value;
}
export function requestKey(value: unknown): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(value))
		throw new HttpError(400, "Invalid creation request key.");
	return value;
}
export const releaseNameSchema = v.pipe(v.string(), v.check(releaseName));
export function requireRelease(value: unknown): string {
	if (typeof value !== "string" || !releaseName(value)) throw new HttpError(400, "Choose a target release.");
	return value;
}

export const originSchema = v.pipe(
	v.string(),
	v.url(),
	v.check((value) => {
		const url = new URL(value);
		return (
			["http:", "https:"].includes(url.protocol) &&
			!url.username &&
			!url.password &&
			url.pathname === "/" &&
			!url.search &&
			!url.hash
		);
	}),
	v.transform((value) => new URL(value).origin),
);

export function tenantUrl(value: unknown): string {
	return parse(
		originSchema,
		value,
		400,
		"Enter an HTTP or HTTPS origin without a path, credentials, query or fragment.",
	);
}

export const slugSchema = v.pipe(v.string(), v.check(slugValid));
export const tenantInputSchema = v.object({
	slug: slugSchema,
	name: v.pipe(
		v.string(),
		v.trim(),
		v.minLength(1),
		v.maxLength(100),
		v.check((value) => !Array.from(value).some((character) => character.charCodeAt(0) < 32)),
	),
});

export function tenantInput(value: unknown): TenantInput {
	return parse(tenantInputSchema, value, 400, "Enter a valid workspace address and name.");
}
