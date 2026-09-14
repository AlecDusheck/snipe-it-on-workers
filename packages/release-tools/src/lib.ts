import * as v from "valibot";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Regular files under a directory in a stable order; a missing directory yields nothing. */
export async function* walk(directory: string): AsyncGenerator<string> {
	const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
	for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
		const full = join(directory, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else if (entry.isFile()) yield full;
	}
}

export const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");
export const digestFile = async (path: string): Promise<string> => sha256(await readFile(path));

/** The PHP runtime pin: which Playground package and files a release is built on, with their checksums. */
export const phpPinSchema = v.object({
	version: v.string(),
	package: v.string(),
	packageVersion: v.string(),
	wasm: v.string(),
	loader: v.string(),
	sha256: v.string(),
	loaderSha256: v.string(),
	mode: v.string(),
});
/** An application pin: where its source comes from and which PHP runtime it runs on. */
export const pinSchema = v.object({
	/** Directory and catalog name of the release this pin builds. */
	name: v.string(),
	application: v.optional(
		v.object({
			repository: v.string(),
			tag: v.string(),
			commit: v.string(),
		}),
	),
	php: phpPinSchema,
});
export type Pin = v.InferOutput<typeof pinSchema>;
export async function readPin(path: string): Promise<Pin> {
	return v.parse(pinSchema, JSON.parse(await readFile(path, "utf8")));
}
