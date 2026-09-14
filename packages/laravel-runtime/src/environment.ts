import * as v from "valibot";
import { jsonObjectSchema, parse } from "./schema";
import { DATABASE_PATH } from "./files";
import type { Release, RuntimeInput } from "./types";

const managed = new Set([
	"APP_KEY",
	"APP_URL",
	"DB_CONNECTION",
	"DB_DATABASE",
	"CACHE_DRIVER",
	"SESSION_DRIVER",
]);

const environmentSchema = v.pipe(
	jsonObjectSchema,
	v.record(
		v.pipe(
			v.string(),
			v.regex(/^[A-Z][A-Z0-9_]*$/),
			v.check((key) => !managed.has(key)),
		),
		v.pipe(v.string(), v.excludes("\0")),
	),
	v.check((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 32 * 1024),
);
export function environmentOverrides(value: unknown): Record<string, string> {
	return parse(
		environmentSchema,
		value,
		400,
		"Environment overrides must use unmanaged uppercase names and string values without NUL bytes, within 32 KiB.",
	);
}

export function deploymentEnvironment(value: unknown): Record<string, string> {
	return parse(
		environmentSchema,
		value === undefined ? {} : value,
		503,
		"Application environment defaults are invalid.",
	);
}

export function runtimeEnvironment(
	input: RuntimeInput,
	defaults: Record<string, string> = {},
): Record<string, string> {
	return {
		APP_ENV: "production",
		APP_DEBUG: "false",
		SESSION_LIFETIME: "120",
		MAIL_MAILER: "log",
		LOG_CHANNEL: "stderr",
		QUEUE_CONNECTION: "sync",
		...defaults,
		...environmentOverrides(input.environment ?? {}),
		APP_KEY: input.secrets.appKey,
		APP_URL: input.origin,
		DB_CONNECTION: "sqlite",
		DB_DATABASE: DATABASE_PATH,
		CACHE_DRIVER: "file",
		SESSION_DRIVER: "file",
	};
}

export function environmentIdentity(environment: Record<string, string>): string {
	return JSON.stringify(Object.entries(environment).toSorted(([a], [b]) => a.localeCompare(b)));
}

/** Everything a booted interpreter is specific to; a change requires a new interpreter. */
export function runtimeIdentity(
	release: Release,
	input: Pick<RuntimeInput, "origin" | "secrets" | "environment">,
): string {
	return [
		release.name,
		release.files.worker,
		release.files.wasm,
		release.files.index,
		input.origin,
		input.secrets.appKey,
		environmentIdentity(input.environment ?? {}),
	].join("\n");
}
