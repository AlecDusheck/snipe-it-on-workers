import { record } from "./schema";

export function object(value: unknown): Record<string, unknown> {
	if (!record(value)) throw new Error("Invalid Emscripten filesystem object");
	return value;
}

/** ENODEV: mounted files never expose linear-memory mappings. */
export function unsupportedMmap(): never {
	throw Object.assign(new Error("File mapping unavailable"), { name: "ErrnoError", errno: 43 });
}
