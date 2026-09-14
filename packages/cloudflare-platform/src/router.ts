import { TenantDirectory } from "./directory";
import { HttpError } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";
import { isAssetRequest, publicPrefixes, serveReleaseAsset } from "./assets";
import type { Release } from "@simplyalec/laravel-cf-workers-laravel-runtime/types";
import type { ApplicationProfile } from "@simplyalec/laravel-cf-workers-laravel-runtime/application";
import type { OperationResult } from "./types";

export interface RoutingEnv {
	DIRECTORY: KVNamespace;
	ASSETS: Fetcher;
	TENANTS: {
		getByName(name: string): Fetcher & { currentRelease(origin: string): Promise<OperationResult<Release>> };
	};
}
// Platform, release-asset and dotfile paths never reach the application.
export function reservedPath(pathname: string): boolean {
	return ["/__platform", "/releases/", "/."].some((prefix) => pathname.startsWith(prefix));
}

export async function handle(
	request: Request,
	env: RoutingEnv,
	application: ApplicationProfile = {},
): Promise<Response> {
	const url = new URL(request.url);
	if (reservedPath(url.pathname)) throw new HttpError(404, "Not found.");
	const slug = await new TenantDirectory(env.DIRECTORY).resolve(url.origin);
	if (!slug) throw new HttpError(404, "Not found.");
	const tenant = env.TENANTS.getByName(slug);
	if (isAssetRequest(request, url.pathname, publicPrefixes(application))) {
		const release = await tenant.currentRelease(url.origin);
		if (!release.ok) throw new HttpError(release.status, release.message);
		const served = await serveReleaseAsset(request, url.pathname, release.value, env.ASSETS);
		if (served) return served;
	}
	const headers = new Headers(request.headers);
	headers.set("x-platform-slug", slug);
	return tenant.fetch(new Request(request, { headers }));
}
