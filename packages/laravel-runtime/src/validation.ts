import * as v from "valibot";
import { fileSchema, safePathSegments } from "./files";
import { DIGEST_PATTERN } from "./crypto";
import { parse } from "./schema";
import type { HttpOutput, Release, RuntimeOutput } from "./types";

/** Release names double as directory and catalog names: lowercase, dots and dashes, no leading dot. */
export function releaseName(value: string): boolean {
	return /^[a-z0-9][a-z0-9.-]{0,79}$/.test(value);
}

const sha256 = v.pipe(v.string(), v.regex(DIGEST_PATTERN));
const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const releaseSchema = v.object({
	name: v.pipe(v.string(), v.check(releaseName)),
	version: v.string(),
	phpVersion: v.exactOptional(v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/))),
	compatibilityDate: v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/)),
	files: v.object({
		worker: sha256,
		wasm: sha256,
		index: sha256,
	}),
	corpus: v.pipe(
		v.object({ bytes: count, partBytes: v.pipe(count, v.minValue(1)), parts: v.array(sha256) }),
		v.check((corpus) => corpus.parts.length === Math.ceil(corpus.bytes / corpus.partBytes)),
	),
	public: v.optional(
		v.record(
			v.pipe(
				v.string(),
				v.minLength(1),
				v.check((path) => !path.startsWith("/") && safePathSegments(path)),
			),
			sha256,
		),
		{},
	),
});
export function parseRelease(value: unknown): Release {
	return parse(releaseSchema, value, 503, "Release manifest is invalid.");
}
export const httpOutputSchema = v.object({
	file: v.exactOptional(fileSchema),
	status: v.pipe(v.number(), v.integer(), v.minValue(200), v.maxValue(599)),
	headers: v.array(v.strictTuple([v.string(), v.string()])),
	body: v.string(),
});
export function parseHttpOutput(value: unknown): HttpOutput {
	return parse(httpOutputSchema, value, 502, "The application returned an invalid response.");
}
const runtimeOutputSchema = v.object({
	database: v.instance(ArrayBuffer),
	ephemeral: v.instance(ArrayBuffer),
	response: httpOutputSchema,
});
export function parseRuntimeOutput(value: unknown): RuntimeOutput {
	return parse(runtimeOutputSchema, value, 502, "The application returned an invalid snapshot or response.");
}
/** Everything the isolate retains between requests; the WASM heap never shrinks. */
export const runtimeMemorySchema = v.object({
	wasmBytes: v.number(),
	/** dlmalloc break; the gap to wasmBytes is growth slack. */
	sbrkBytes: v.number(),
	zendPeakBytes: v.number(),
	/** Opcache shared segment: compiled scripts and interned strings. */
	opcacheBytes: v.number(),
	opcacheFull: v.boolean(),
	opcacheKeys: v.number(),
	opcacheMaxKeys: v.number(),
	/** Upper bound of retained archive parts. */
	corpusBytes: v.number(),
	archiveFetches: v.number(),
	inflatedBytes: v.number(),
	pageCacheBytes: v.number(),
	indexBytes: v.number(),
	manifestBytes: v.number(),
});
export type RuntimeMemory = v.InferOutput<typeof runtimeMemorySchema>;
