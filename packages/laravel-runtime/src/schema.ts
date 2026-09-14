import * as v from "valibot";

export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const jsonObjectSchema = v.custom<Record<string, unknown>>(record);

export function parse<T extends v.GenericSchema>(
	schema: T,
	value: unknown,
	status: number,
	message: string,
): v.InferOutput<T> {
	const result = v.safeParse(schema, value);
	if (!result.success) throw new HttpError(status, message);
	return result.output;
}

/** Status and message for a caught error; non-HttpError failures get `fallback` and 503. */
export function describeError(error: unknown, fallback: string): { status: number; message: string } {
	return error instanceof HttpError
		? { status: error.status, message: error.message }
		: { status: 503, message: fallback };
}
