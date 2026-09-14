import type { BackplaneControl } from "../../src/control";
import type { TenantInput } from "../../src/types";
import type { DatabaseAction } from "@simplyalec/laravel-cf-workers-laravel-runtime/types";

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/__test/url") {
			const input = await request.json<{ slug: string; url: string }>();
			const result = await env.CONTROL.setTenantUrl(input.slug, input.url);
			return Response.json(result, { status: result.ok ? 200 : result.status });
		}
		if (url.pathname === "/__test/details") {
			const result = await env.CONTROL.getTenant(url.searchParams.get("slug") ?? "");
			return Response.json(result, { status: result.ok ? 200 : result.status });
		}
		if (url.pathname === "/__test/policy") {
			const { slug, policy } = await request.json<{
				slug: string;
				policy: import("../../src/policy").PolicyOverrides;
			}>();
			const result = await env.CONTROL.setTenantPolicy(slug, policy);
			return Response.json(result, { status: result.ok ? 200 : result.status });
		}
		if (url.pathname === "/__test/list") {
			const result = await env.CONTROL.listTenants(url.searchParams.get("cursor"));
			return Response.json(result, { status: result.ok ? 200 : result.status });
		}
		if (url.pathname === "/__test/database") {
			const { slug, action } = await request.json<{ slug: string; action: DatabaseAction }>();
			const result = await env.CONTROL.database(slug, action);
			return Response.json(result, { status: result.ok ? 200 : result.status });
		}

		if (url.pathname === "/__test/provision") {
			const input = await request.json<TenantInput>();
			const origin = new URL(url);
			origin.hostname = `${input?.slug}.${origin.hostname}`;
			const result = await env.CONTROL.createTenant(
				input,
				request.headers.get("idempotency-key") ?? "",
				origin.origin,
			);
			return Response.json(result, { status: result.ok ? 201 : result.status });
		}
		if (url.pathname === "/__test/upgrade") {
			const { slug, release } = await request.json<{ slug: string; release: string }>();
			const result = await env.CONTROL.upgradeTenant(slug, release);
			return Response.json(result, { status: result.ok ? 200 : result.status });
		}
		if (url.pathname === "/__test/configure") {
			const { slug, environment } = await request.json<{
				slug: string;
				environment: Record<string, string>;
			}>();
			const result = await env.CONTROL.configureTenant(slug, environment);
			return Response.json(result, { status: result.ok ? 200 : result.status });
		}

		return env.TENANT_HTTP.fetch(request);
	},
} satisfies ExportedHandler<{ CONTROL: Service<BackplaneControl>; TENANT_HTTP: Fetcher }>;
