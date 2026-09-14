import { describeError } from "@simplyalec/laravel-cf-workers-laravel-runtime/schema";
import type { OperationResult } from "./types";

// RPC does not preserve custom Error properties. Expected failures are values.
export async function operation<T>(work: () => Promise<T>): Promise<OperationResult<T>> {
	try {
		return { ok: true, value: await work() };
	} catch (error) {
		return { ok: false, ...describeError(error, "The workspace operation failed. Please retry.") };
	}
}
