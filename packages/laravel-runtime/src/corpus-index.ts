import type { CorpusEntry, CorpusIndex } from "./corpus";
import { safePathSegments } from "./files";

const MAGIC = new TextEncoder().encode("LVINDEX1");
const HEADER = 16;
const FILE = 24;
const DIRECTORY = 8;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Sorted offset tables refer directly into one UTF-8 buffer; no parsed object per release file. */
export function encodeCorpusIndex(index: CorpusIndex): Uint8Array {
	const files = [...index.files].toSorted(([a], [b]) => compare(a, b));
	const directories = [...index.directories.keys()].toSorted(compare);
	const encoder = new TextEncoder();
	const paths = [...files.map(([path]) => path), ...directories].map((path) => encoder.encode(path));
	const start = HEADER + files.length * FILE + directories.length * DIRECTORY;
	const bytes = new Uint8Array(start + paths.reduce((size, path) => size + path.length, 0));
	bytes.set(MAGIC);
	const view = new DataView(bytes.buffer);
	view.setUint32(8, files.length, true);
	view.setUint32(12, directories.length, true);
	let cursor = HEADER;
	let offset = start;
	for (let i = 0; i < paths.length; i++) {
		const path = paths[i];
		if (!path) throw new Error("Missing index path");
		view.setUint32(cursor, offset, true);
		view.setUint32(cursor + 4, path.length, true);
		bytes.set(path, offset);
		offset += path.length;
		const entry = files[i]?.[1];
		if (entry) {
			view.setUint32(cursor + 8, entry.size, true);
			view.setUint32(cursor + 12, entry.crc, true);
			view.setUint32(cursor + 16, entry.local, true);
			if (entry.packedSize >= 0x80000000) throw new Error("Archive entry is too large");
			view.setUint32(cursor + 20, entry.packedSize | (entry.deflated ? 0x80000000 : 0), true);
			cursor += FILE;
		} else cursor += DIRECTORY;
	}
	return bytes;
}

class Table {
	constructor(
		readonly bytes: Uint8Array,
		readonly view: DataView,
		readonly start: number,
		readonly stride: number,
		readonly size: number,
	) {}
	path(index: number): string {
		const cursor = this.start + index * this.stride;
		const offset = this.view.getUint32(cursor, true);
		const length = this.view.getUint32(cursor + 4, true);
		return decoder.decode(this.bytes.subarray(offset, offset + length));
	}
	lowerBound(path: string): number {
		let low = 0;
		let high = this.size;
		while (low < high) {
			const mid = Math.floor((low + high) / 2);
			if (this.path(mid) < path) low = mid + 1;
			else high = mid;
		}
		return low;
	}
	has(path: string): boolean {
		const index = this.lowerBound(path);
		return index < this.size && this.path(index) === path;
	}
	*keys(): IterableIterator<string> {
		for (let index = 0; index < this.size; index++) yield this.path(index);
	}
	validate(strings: number): void {
		let previous: string | undefined;
		for (let index = 0; index < this.size; index++) {
			const cursor = this.start + index * this.stride;
			const offset = this.view.getUint32(cursor, true);
			const length = this.view.getUint32(cursor + 4, true);
			if (offset < strings || offset + length > this.bytes.length) throw new Error("Invalid index offset");
			const path = this.path(index);
			if (path.startsWith("/") || path.endsWith("/") || path.includes("//") || !safePathSegments(path))
				throw new Error("Unsafe release path");
			if (previous !== undefined && previous >= path)
				throw new Error("Index paths must be sorted and unique");
			previous = path;
		}
	}
}

class Files extends Table {
	get(path: string): CorpusEntry | undefined {
		const index = this.lowerBound(path);
		if (index === this.size || this.path(index) !== path) return undefined;
		return this.entry(index);
	}
	entry(index: number): CorpusEntry {
		const cursor = this.start + index * this.stride;
		const packed = this.view.getUint32(cursor + 20, true);
		return {
			size: this.view.getUint32(cursor + 8, true),
			crc: this.view.getUint32(cursor + 12, true),
			local: this.view.getUint32(cursor + 16, true),
			packedSize: packed & 0x7fffffff,
			deflated: (packed & 0x80000000) !== 0,
		};
	}
	*[Symbol.iterator](): IterableIterator<[string, CorpusEntry]> {
		for (let index = 0; index < this.size; index++) yield [this.path(index), this.entry(index)];
	}
}

class Directories extends Table {
	constructor(
		bytes: Uint8Array,
		view: DataView,
		start: number,
		size: number,
		readonly files: Files,
	) {
		super(bytes, view, start, DIRECTORY, size);
	}
	get(path: string): string[] | undefined {
		if (!this.has(path)) return undefined;
		const prefix = path ? path + "/" : "";
		const children = new Set<string>();
		for (const table of [this.files, this]) {
			for (let index = table.lowerBound(prefix); index < table.size; index++) {
				const candidate = table.path(index);
				if (!candidate.startsWith(prefix)) break;
				const child = candidate.slice(prefix.length).split("/", 1)[0];
				if (child) children.add(child);
			}
		}
		return [...children];
	}
}

export function decodeCorpusIndex(bytes: Uint8Array): CorpusIndex {
	if (bytes.length < HEADER || !MAGIC.every((byte, index) => bytes[index] === byte))
		throw new Error("Invalid release index format");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const filesCount = view.getUint32(8, true);
	const directoriesCount = view.getUint32(12, true);
	const directoryStart = HEADER + filesCount * FILE;
	const strings = directoryStart + directoriesCount * DIRECTORY;
	if (strings > bytes.length) throw new Error("Truncated release index");
	const files = new Files(bytes, view, HEADER, FILE, filesCount);
	const directories = new Directories(bytes, view, directoryStart, directoriesCount, files);
	files.validate(strings);
	directories.validate(strings);
	for (const [path, entry] of files)
		if (!path || entry.size > 25 * 1024 * 1024 || directories.has(path))
			throw new Error("Invalid release file");
	return { files, directories, byteLength: bytes.byteLength };
}
