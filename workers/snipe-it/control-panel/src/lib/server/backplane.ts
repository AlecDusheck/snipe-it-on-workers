import { getRequestEvent } from "$app/server";
import { error, invalid } from "@sveltejs/kit";
import type { OperationResult } from "@simplyalec/laravel-cf-workers-cloudflare-platform/types";

export function backplane() {
	const { platform } = getRequestEvent();
	if (!platform) error(503, "The backplane binding is unavailable.");
	return platform.env.BACKPLANE;
}

/** Query failures become HTTP errors. */
export function unwrap<T>(result: OperationResult<T>): T {
	if (!result.ok) error(result.status, result.message);
	return result.value;
}
/** Form failures become field-level validation messages. */
export function unwrapForm<T>(result: OperationResult<T>): T {
	if (!result.ok) invalid(result.message);
	return result.value;
}

export function workspaceUrl(slug: string): string {
	const { url, platform } = getRequestEvent();
	const base = new URL(platform?.env.TENANT_BASE_URL || url.origin);
	base.hostname = `${slug}.${base.hostname}`;
	return base.origin;
}
