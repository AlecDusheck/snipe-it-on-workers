import type { WorkerEntrypoint } from "cloudflare:workers";
import { digestText } from "@simplyalec/laravel-cf-workers-laravel-runtime/crypto";
import { runtimeIdentity } from "@simplyalec/laravel-cf-workers-laravel-runtime/environment";
import { runtimeLimits } from "./limits";
import { releaseFile } from "@simplyalec/laravel-cf-workers-laravel-runtime/release";
import type { TenantEnv, TenantRuntime } from "./tenant";
import type {
	Release,
	RuntimeInput,
	RuntimeOutput,
} from "@simplyalec/laravel-cf-workers-laravel-runtime/types";
import type { ApplicationProfile } from "@simplyalec/laravel-cf-workers-laravel-runtime/application";
import type { RuntimeStorage } from "@simplyalec/laravel-cf-workers-laravel-runtime/files";

export interface DynamicEnv extends TenantEnv {
	DIRECTORY: KVNamespace;
	LOADER: WorkerLoader;
	RUNTIME_LIMITS?: unknown;
}
type RuntimeEntrypoint = WorkerEntrypoint & {
	execute(input: RuntimeInput, storage: RuntimeStorage): Promise<RuntimeOutput>;
};

// Release workers are immutable, so the loader caches them by key across requests.
export function loadReleaseWorker(
	loader: WorkerLoader,
	assets: Fetcher,
	key: string,
	release: Release,
): WorkerStub {
	return loader.get(key, async () => {
		const [worker, wasm] = await Promise.all([
			releaseFile(assets, release, "worker"),
			releaseFile(assets, release, "wasm"),
		]);
		return {
			compatibilityDate: release.compatibilityDate,
			compatibilityFlags: ["nodejs_compat"],
			mainModule: "worker.js",
			modules: { "worker.js": new TextDecoder().decode(worker), "php.wasm": { wasm } },
			env: { ASSETS: assets, RELEASE: release },
		};
	});
}

// Hosted mode: each tenant, release and environment identity gets its own Dynamic Worker.
export function dynamicRuntime(
	ctx: DurableObjectState,
	env: DynamicEnv,
	application: ApplicationProfile,
): TenantRuntime {
	let key: { identity: string; digest: string } | undefined;
	return {
		application,
		async execute(release, input, storage) {
			const limits = runtimeLimits(env.RUNTIME_LIMITS);
			const identity = runtimeIdentity(release, input);
			if (key?.identity !== identity) key = { identity, digest: await digestText(identity) };
			return loadReleaseWorker(env.LOADER, env.ASSETS, `${ctx.id}:${release.name}:${key.digest}`, release)
				.getEntrypoint<RuntimeEntrypoint>(undefined, {
					limits: {
						cpuMs: input.command.kind === "http" ? limits.httpCpuMs : limits.backgroundCpuMs,
						subRequests: limits.subRequests,
					},
				})
				.execute(input, storage);
		},
	};
}
