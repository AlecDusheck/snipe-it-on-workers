import { HttpError } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";

export function compareVersions(left: string, right: string): number {
	const a = parseVersion(left);
	const b = parseVersion(right);
	for (const index of [0, 1, 2]) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference) return Math.sign(difference);
	}
	return 0;
}

function parseVersion(value: string): number[] {
	if (!/^v?\d+\.\d+\.\d+$/.test(value))
		throw new HttpError(400, "Only stable, numbered application releases can be activated.");
	const parts = value.replace(/^v/, "").split(".").map(Number);
	if (parts.some((part) => !Number.isSafeInteger(part))) throw new HttpError(400, "Invalid release version.");
	return parts;
}
