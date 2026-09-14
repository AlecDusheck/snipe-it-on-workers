import { RuntimeExecutor } from "./executor";
import type { ApplicationProfile } from "./application";
import type { RuntimeEnv } from "./executor";
import { createSecrets, fromBase64 } from "./crypto";
import { fileStream } from "./stream";
import { SerialQueue } from "./queue";
import type { RuntimeCommand } from "./types";
import { MemoryBlockStorage } from "./files";

/** Benchmark driver over an in-memory block store. Endpoints: /__memory, /__migrate, /__restart. */
export function runtimeDriver(application: ApplicationProfile = {}): ExportedHandler<RuntimeEnv> {
	const queue = new SerialQueue();
	const storage = new MemoryBlockStorage();
	const origin = "https://fixture.test";
	let secrets: ReturnType<typeof createSecrets> | undefined;
	let runtime: RuntimeExecutor | undefined;
	let trees = { database: new ArrayBuffer(0), ephemeral: new ArrayBuffer(0) };
	let initialized = false;
	const run = async (command: RuntimeCommand) => {
		if (!runtime || !secrets) throw new Error("Runtime is unavailable");
		const output = await runtime.execute({ command, ...trees, secrets, origin }, storage);
		if (output.response.status < 500) trees = { database: output.database, ephemeral: output.ephemeral };
		return output;
	};
	return {
		fetch(request, env) {
			return queue.run(async () => {
				runtime ??= new RuntimeExecutor(env, application);
				secrets ??= createSecrets("driver");
				const path = new URL(request.url).pathname;
				if (path === "/__restart") {
					runtime.dispose();
					runtime = new RuntimeExecutor(env, application);
					return new Response(null, { status: 204 });
				}
				if (path === "/__memory") return Response.json(runtime.memory() ?? null);
				if (!initialized) {
					await run({ kind: "initialize" });
					initialized = true;
				}
				if (path === "/__migrate")
					return new Response(null, { status: (await run({ kind: "migrate" })).response.status });
				if (!["GET", "HEAD", "POST"].includes(request.method)) throw new Error("Unsupported method");
				const command: RuntimeCommand = {
					kind: "http",
					request: {
						url: request.url,
						method: request.method === "GET" || request.method === "HEAD" ? request.method : "POST",
						headers: [...request.headers],
						body: await request.arrayBuffer(),
					},
				};
				const output = await run(command);
				return new Response(
					request.method === "HEAD"
						? null
						: output.response.file
							? fileStream(output.response.file, storage)
							: fromBase64(output.response.body),
					{ status: output.response.status, headers: output.response.headers },
				);
			});
		},
	};
}
