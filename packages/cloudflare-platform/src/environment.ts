import {
	environmentOverrides,
	deploymentEnvironment,
} from "@simplyalec/laravel-cf-workers-laravel-runtime/environment";

const platform = new Set(["APP_URL", "TENANT_DEFAULTS", "DEFAULT_RELEASE"]);
// Individual secrets override JSON defaults; binding objects and platform vars must not reach PHP.
export function workerEnvironment(env: object, environmentKey = "APPLICATION_ENV"): Record<string, string> {
	const entries = Object.entries(env).filter(
		([name, value]) => typeof value === "string" && name !== environmentKey && !platform.has(name),
	);
	const configuration: unknown = Object.entries(env).find(([name]) => name === environmentKey)?.[1];
	return environmentOverrides({ ...deploymentEnvironment(configuration), ...Object.fromEntries(entries) });
}
