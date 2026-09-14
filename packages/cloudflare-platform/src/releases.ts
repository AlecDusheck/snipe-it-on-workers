import { HttpError } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";
import { parseRelease, releaseName } from "@simplyalec/laravel-cf-workers-laravel-runtime/validation";
import { compareVersions } from "./versions";
import type { Release } from "@simplyalec/laravel-cf-workers-laravel-runtime/types";
import type { ReleaseSummary } from "./types";

export function releaseSummary(release: Release): ReleaseSummary {
	return { name: release.name, version: release.version, phpVersion: release.phpVersion ?? null };
}

// Manifests never change once published, so a verified one is kept for the isolate's life.
const manifests = new Map<string, Promise<Release>>();
async function readManifest(assets: Fetcher, name: string): Promise<Release> {
	const response = await assets.fetch(`https://assets/releases/${name}/manifest.json`);
	if (!response.ok) throw new HttpError(404, "Release not found.");
	const release = parseRelease(await response.json());
	if (release.name !== name) throw new HttpError(503, "Release directory does not match its manifest.");
	return release;
}

export function getRelease(assets: Fetcher, name: string): Promise<Release> {
	if (!releaseName(name)) return Promise.reject(new HttpError(400, "Invalid release name."));
	let pending = manifests.get(name);
	if (!pending) {
		pending = readManifest(assets, name);
		manifests.set(name, pending);
		pending.catch(() => manifests.delete(name));
	}
	return pending;
}

/** Every deployed release, newest version first; `releases/releases.json` is written by the build. */
export async function listReleases(assets: Fetcher): Promise<ReleaseSummary[]> {
	const response = await assets.fetch("https://assets/releases/releases.json");
	if (!response.ok) throw new HttpError(503, "No application release is deployed.");
	const names: unknown = await response.json();
	if (!Array.isArray(names) || !names.every((name) => typeof name === "string" && releaseName(name)))
		throw new HttpError(503, "Release list is invalid.");
	const releases = await Promise.all(names.map((name) => getRelease(assets, name)));
	return releases.map(releaseSummary).toSorted((a, b) => compareVersions(b.version, a.version));
}
