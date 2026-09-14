import { TenantBase } from "@simplyalec/laravel-cf-workers-cloudflare-platform/tenant";
import { dynamicRuntime } from "@simplyalec/laravel-cf-workers-cloudflare-platform/dynamic";
import { application } from "./application";

export class Tenant extends TenantBase<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env, dynamicRuntime(ctx, env, application));
	}
}
