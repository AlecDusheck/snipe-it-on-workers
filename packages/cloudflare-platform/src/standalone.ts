import { HttpError } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";
import { RuntimeExecutor } from "@simplyalec/laravel-cf-workers-laravel-runtime/executor";
import { runtimeIdentity } from "@simplyalec/laravel-cf-workers-laravel-runtime/environment";
import { errorResponse } from "./http";
import { getRelease } from "./releases";
import { isAssetRequest, publicPrefixes, serveReleaseAsset } from "./assets";
import type { TenantEnv, TenantRuntime } from "./tenant";
import type { ApplicationProfile } from "@simplyalec/laravel-cf-workers-laravel-runtime/application";

export interface StandaloneEnv extends TenantEnv {
	APP_URL?: string;
}

/** One tenant, PHP in the Durable Object. Runs only releases built on the bundled PHP binary; upgrades to DEFAULT_RELEASE. */
export function standaloneRuntime(
	ctx: DurableObjectState,
	env: StandaloneEnv,
	application: ApplicationProfile,
	wasmDigest: string,
): TenantRuntime {
	let executor: RuntimeExecutor | undefined;
	let identity: string | undefined;
	let prepared: Promise<void> | undefined;
	let stored: string | undefined;
	return {
		application,
		async requestOrigin(_slug, url) {
			stored ??= await ctx.storage.get<string>("origin");
			const origin = env.APP_URL || stored || url.origin;
			if (new URL(origin).origin !== url.origin) throw new HttpError(404, "Not found.");
			if (stored !== url.origin) {
				stored = url.origin;
				await ctx.storage.put("origin", url.origin);
			}
			return url.origin;
		},
		// Initialization and the upgrade to the configured release happen once per instance lifetime.
		prepareInstance(service) {
			prepared ??= (async () => {
				await service.provision("standalone", env.DEFAULT_RELEASE);
				await service.upgrade(env.DEFAULT_RELEASE);
			})().catch((error: unknown) => {
				prepared = undefined;
				throw error;
			});
			return prepared;
		},
		async execute(release, input, storage) {
			if (release.files.wasm !== wasmDigest)
				throw new HttpError(
					503,
					"This release was built for a different PHP runtime than the deployed Worker.",
				);
			const next = runtimeIdentity(release, input);
			if (identity !== next) {
				executor?.dispose();
				executor = new RuntimeExecutor({ ASSETS: env.ASSETS, RELEASE: release }, application);
				identity = next;
			}
			if (!executor) throw new Error("Runtime is unavailable");
			return executor.execute(input, storage);
		},
		memory: () => executor?.memory(),
	};
}

// Release assets are answered here from the assets binding; everything else goes to the single tenant.
export function standaloneHandler<E extends StandaloneEnv>(
	tenant: (env: E) => { getByName(name: string): Fetcher },
	application: ApplicationProfile,
): ExportedHandler<E> {
	const prefixes = publicPrefixes(application);
	return {
		async fetch(request, env) {
			try {
				const { pathname } = new URL(request.url);
				if (isAssetRequest(request, pathname, prefixes)) {
					const release = await getRelease(env.ASSETS, env.DEFAULT_RELEASE);
					const served = await serveReleaseAsset(request, pathname, release, env.ASSETS);
					if (served) return served;
				}
				const headers = new Headers(request.headers);
				headers.set("x-platform-slug", "main");
				return await tenant(env).getByName("main").fetch(new Request(request, { headers }));
			} catch (error) {
				return errorResponse(error);
			}
		},
	};
}
