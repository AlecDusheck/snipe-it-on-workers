import { lookup } from "mrmime";
import { HttpError } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";
import { releaseResponse } from "@simplyalec/laravel-cf-workers-laravel-runtime/release";
import { etagsMatch } from "./http";
import type { Release } from "@simplyalec/laravel-cf-workers-laravel-runtime/types";
import type { ApplicationProfile } from "@simplyalec/laravel-cf-workers-laravel-runtime/application";

/** Release files a browser requests directly; uploads are excluded by the caller's public prefixes. */
export const ASSET_PATTERN = /\.(?:css|js|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|mp3|ogg)$/;
export const PUBLIC_ROOT = "/app/public";

/** URL prefixes of the profile's storage directories under the public root, such as `/uploads/`. */
export function publicPrefixes(application: ApplicationProfile): string[] {
	return (application.storageDirectories ?? [])
		.filter((root) => root.startsWith(PUBLIC_ROOT + "/"))
		.map((root) => root.slice(PUBLIC_ROOT.length) + "/");
}

export function isAssetRequest(request: Request, pathname: string, prefixes: string[]): boolean {
	return (
		(request.method === "GET" || request.method === "HEAD") &&
		ASSET_PATTERN.test(pathname) &&
		!prefixes.some((prefix) => pathname.startsWith(prefix))
	);
}

/** Serves a release public file verified by its manifest digest; undefined for unlisted paths. */
export async function serveReleaseAsset(
	request: Request,
	pathname: string,
	release: Release,
	assets: Fetcher,
): Promise<Response | undefined> {
	const path = pathname.slice(1);
	const digest = release.public?.[path];
	if (!digest) return undefined;
	const etag = `"${digest}"`;
	const headers = new Headers({
		etag,
		"cache-control": "public, max-age=86400, must-revalidate",
		"x-content-type-options": "nosniff",
	});
	if (etagsMatch(request.headers.get("if-none-match"), etag))
		return new Response(null, { status: 304, headers });
	const upstream = await releaseResponse(assets, release, `public/${path}`).catch(() => {
		throw new HttpError(503, "A release asset is unavailable.");
	});
	headers.set(
		"content-type",
		upstream.headers.get("content-type") ?? lookup(path) ?? "application/octet-stream",
	);
	const length = upstream.headers.get("content-length");
	if (length) headers.set("content-length", length);
	return new Response(request.method === "HEAD" ? null : upstream.body, { status: 200, headers });
}
