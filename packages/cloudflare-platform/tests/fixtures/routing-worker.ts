import { TenantDirectory } from "../../src/directory";
import type { TenantInput } from "../../src/types";
import { DurableObject } from "cloudflare:workers";
import { handle } from "../../src/router";
import { errorResponse } from "../../src/http";
import { HttpError } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";

export { BackplaneControl } from "../../src/control";

export class RouteTarget extends DurableObject<{ DIRECTORY: KVNamespace }> {
	async provision(input: TenantInput, requestKey: string, url: string) {
		await new TenantDirectory(this.env.DIRECTORY).register({
			...input,
			url,
			createdAt: new Date().toISOString(),
		});
		return { ok: true, value: { input, requestKey } };
	}
	async upgrade(slug: string, release: string) {
		return { ok: true, value: { slug, release } };
	}
	async currentRelease(_origin: string) {
		return { ok: false, status: 404, message: "Workspace not found." };
	}
	override async fetch(request: Request): Promise<Response> {
		return Response.json({
			path: new URL(request.url).pathname,
			slug: request.headers.get("x-platform-slug"),
			key: request.headers.get("idempotency-key"),
			body: await request.text(),
		});
	}
}

export default {
	fetch: (request, env) =>
		handle(request, env).catch((error: unknown) =>
			errorResponse(error instanceof SyntaxError ? new HttpError(400, "Invalid JSON") : error),
		),
} satisfies ExportedHandler<import("../../src/router").RoutingEnv>;
