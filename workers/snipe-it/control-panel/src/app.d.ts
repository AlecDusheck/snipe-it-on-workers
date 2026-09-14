import type { BackplaneControl } from "@simplyalec/laravel-cf-workers-cloudflare-platform/control";

declare global {
	namespace App {
		interface Platform {
			env: { BACKPLANE: Service<BackplaneControl>; TENANT_BASE_URL?: string };
		}
	}
}
