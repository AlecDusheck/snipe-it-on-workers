import { createSnipeSecrets } from "../../src/secrets";
import { getRelease } from "@simplyalec/laravel-cf-workers-cloudflare-platform/releases";
import { loadReleaseWorker } from "@simplyalec/laravel-cf-workers-cloudflare-platform/dynamic";
import { fileStream } from "@simplyalec/laravel-cf-workers-laravel-runtime/stream";
import { parseRuntimeOutput } from "@simplyalec/laravel-cf-workers-laravel-runtime/validation";
import type SnipeRuntime from "../../src/runtime";
import type { TenantSecrets } from "@simplyalec/laravel-cf-workers-cloudflare-platform/types";
import { TenantBlocks } from "@simplyalec/laravel-cf-workers-cloudflare-platform/blocks";
import { MemoryBlockStorage } from "@simplyalec/laravel-cf-workers-laravel-runtime/files";
const memory = new MemoryBlockStorage();
import { decodeFiles } from "@simplyalec/laravel-cf-workers-laravel-runtime/files";

let secrets: Promise<TenantSecrets> | undefined;

export default {
	async fetch(request, env) {
		const release = await getRelease(env.ASSETS, "snipeit-8.7.2");
		const stub = loadReleaseWorker(env.LOADER, env.ASSETS, `migration:${release.name}`, release);
		secrets ??= createSnipeSecrets("migration-test");
		const runtime = stub.getEntrypoint<InstanceType<typeof SnipeRuntime>>();
		using blocks = new TenantBlocks(memory);
		const output = parseRuntimeOutput(
			await runtime.execute(
				{
					command: { kind: "migrate" },
					database: request.method === "POST" ? await request.arrayBuffer() : new ArrayBuffer(0),
					ephemeral: new ArrayBuffer(0),
					secrets: await secrets,
					origin: "https://migration.example",
				},
				blocks,
			),
		);
		const file = decodeFiles(output.database).files["/app/database/database.sqlite"];
		if (!file) throw new Error("Missing migrated database");
		using reader = new TenantBlocks(memory);
		return new Response(await new Response(fileStream(file, reader)).arrayBuffer(), {
			status: output.response.status,
		});
	},
} satisfies ExportedHandler<{ LOADER: WorkerLoader; ASSETS: Fetcher }>;
