import { handle } from "@simplyalec/laravel-cf-workers-cloudflare-platform/router";
import { errorResponse } from "@simplyalec/laravel-cf-workers-cloudflare-platform/http";
import { application } from "./application";
export { Tenant } from "./dynamic";
export { BackplaneControl } from "@simplyalec/laravel-cf-workers-cloudflare-platform/control";
export default {
	fetch: (request, env) => handle(request, env, application).catch(errorResponse),
} satisfies ExportedHandler<Env>;
