import { digest, digestText } from "./crypto";
import { HttpError } from "./schema";
import type { Release } from "./types";

/** Verified reads of a release under `/releases/<name>/`; every byte is checked against the manifest. */
const FILES = {
	worker: "worker.mjs",
	wasm: "php.wasm",
	index: "files.idx",
};
export type ReleaseFile = keyof typeof FILES;
export const releaseUrl = (release: Release, file: string): string =>
	`https://assets/releases/${release.name}/${file}`;

// ZIP CRCs in the index are not a cryptographic identity for the source bytes.
export const archiveIdentity = (release: Release): Promise<string> =>
	digestText(release.files.index + JSON.stringify(release.corpus));

export async function releaseResponse(assets: Fetcher, release: Release, file: string): Promise<Response> {
	const response = await assets.fetch(releaseUrl(release, file));
	if (!response.ok) throw new HttpError(503, `Release file ${file} is missing.`);
	return response;
}

export async function releaseFile(
	assets: Fetcher,
	release: Release,
	file: ReleaseFile,
): Promise<ArrayBuffer> {
	const expected = release.files[file];
	if (!expected) throw new HttpError(503, `Release has no ${file}.`);
	const bytes = await (await releaseResponse(assets, release, FILES[file])).arrayBuffer();
	if ((await digest(bytes)) !== expected)
		throw new HttpError(503, `Release file ${file} failed its checksum.`);
	return bytes;
}

export const partName = (index: number): string => `application.zip.${String(index).padStart(3, "0")}`;

export async function releasePart(assets: Fetcher, release: Release, index: number): Promise<Uint8Array> {
	const expected = release.corpus.parts[index];
	if (!expected) throw new HttpError(503, "Release archive part is out of range.");
	const bytes = await (await releaseResponse(assets, release, partName(index))).arrayBuffer();
	if ((await digest(bytes)) !== expected)
		throw new HttpError(503, "Release archive part failed its checksum.");
	return new Uint8Array(bytes);
}

/** Byte-range reads over the parts, keeping recently read parts so nearby reads are free. */
export class ArchiveReader {
	readonly #parts = new Map<number, Promise<Uint8Array>>();
	#keep: number;
	constructor(
		private readonly assets: Fetcher,
		private readonly release: Release,
		keep = 4,
	) {
		this.#keep = keep;
	}
	fetches = 0;
	/** Upper bound of the bytes held by the retained parts. */
	get heldBytes(): number {
		return this.#parts.size * this.release.corpus.partBytes;
	}
	/** Keeps at most `count` parts from now on, dropping the least recently read ones. */
	retain(count: number): void {
		this.#keep = count;
		this.#evict();
	}
	async range(offset: number, length: number): Promise<Uint8Array> {
		const { partBytes, bytes: total } = this.release.corpus;
		if (offset + length > total) throw new HttpError(503, "Release archive read is out of range.");
		const out = new Uint8Array(length);
		for (let position = offset; position < offset + length;) {
			const index = Math.floor(position / partBytes);
			const part = await this.#part(index);
			const start = position - index * partBytes;
			const take = Math.min(part.length - start, offset + length - position);
			out.set(part.subarray(start, start + take), position - offset);
			position += take;
		}
		return out;
	}
	#part(index: number): Promise<Uint8Array> {
		let pending = this.#parts.get(index);
		if (pending) {
			this.#parts.delete(index);
			this.#parts.set(index, pending);
			return pending;
		}
		this.fetches++;
		pending = releasePart(this.assets, this.release, index);
		pending.catch(() => this.#parts.delete(index));
		this.#parts.set(index, pending);
		this.#evict();
		return pending;
	}
	#evict(): void {
		for (const stale of this.#parts.keys()) {
			if (this.#parts.size <= this.#keep) break;
			this.#parts.delete(stale);
		}
	}
}
