import { application } from "./application";
import { TenantBase } from "@simplyalec/laravel-cf-workers-cloudflare-platform/tenant";
import {
	standaloneHandler,
	standaloneRuntime,
} from "@simplyalec/laravel-cf-workers-cloudflare-platform/standalone";
import type { StandaloneEnv } from "@simplyalec/laravel-cf-workers-cloudflare-platform/standalone";

interface Env extends StandaloneEnv {
	SNIPEIT: DurableObjectNamespace<SnipeIT>;
	SNIPEIT_ENV?: unknown;
}

// The build stamps the digest of the PHP binary bundled with this Worker.
declare const RUNTIME_WASM_SHA256: string;

export class SnipeIT extends TenantBase<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env, standaloneRuntime(ctx, env, application, RUNTIME_WASM_SHA256));
	}
}

export default standaloneHandler<Env>((env) => env.SNIPEIT, application);
