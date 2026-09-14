import { WorkerEntrypoint } from "cloudflare:workers";
import { RuntimeExecutor } from "./executor";
import type { ApplicationProfile } from "./application";
import type { RuntimeEnv } from "./executor";
import type { RuntimeInput, RuntimeOutput } from "./types";
import type { RuntimeStorage } from "./files";

/** Dynamic Worker entrypoint. Instantiated per RPC session; the executor is module-scoped to keep the interpreter. */
export function runtimeEntrypoint(application: ApplicationProfile) {
	let executor: RuntimeExecutor | undefined;
	return class extends WorkerEntrypoint<RuntimeEnv> {
		execute(input: RuntimeInput, storage: RuntimeStorage): Promise<RuntimeOutput> {
			executor ??= new RuntimeExecutor(this.env, application);
			return executor.execute(input, storage);
		}
	};
}
