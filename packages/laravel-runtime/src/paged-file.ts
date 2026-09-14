import { BLOCK_BYTES, readBlock } from "./files";
import { digest } from "./crypto";
import type { BlockStorage, FileReference, BlockReference } from "./files";

interface Page {
	file: PagedFile;
	index: number;
	bytes: Uint8Array<ArrayBuffer>;
	dirty: boolean;
}

const FLUSH_CONCURRENCY = 4;

/** Eviction stages blocks; the manifest commit makes them durable. Verified contents stay keyed by hash within the page budget. */
export class PageCache {
	readonly pages = new Map<string, Page>();
	readonly #clean = new Map<string, Uint8Array>();
	#identity = 0;
	constructor(
		public storage: BlockStorage,
		readonly capacity = 64,
	) {
		if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid page cache capacity");
	}
	/** Starts a request: per-file pages go, verified block contents stay. */
	reset(storage: BlockStorage): void {
		if ([...this.pages.values()].some((page) => page.dirty)) throw new Error("Dirty pages were not flushed");
		for (const [key, page] of this.pages) {
			this.pages.delete(key);
			const block = page.file.block(page.index);
			if (block) this.#keep(block.hash, page.bytes.subarray(0, block.length));
		}
		this.storage = storage;
	}
	get retainedBytes(): number {
		return (this.pages.size + this.#clean.size) * BLOCK_BYTES;
	}
	file(reference: FileReference): PagedFile {
		return new PagedFile(this, this.#identity++, reference);
	}
	/** Drops every page of a file, dirty or not; used when the file is deleted. */
	forget(file: PagedFile): void {
		for (const [key, page] of this.pages) if (page.file === file) this.pages.delete(key);
	}
	async load(file: PagedFile, index: number): Promise<void> {
		const key = file.key(index);
		const cached = this.pages.get(key);
		if (cached) {
			this.pages.delete(key);
			this.pages.set(key, cached);
			return;
		}
		while (this.pages.size + this.#clean.size >= this.capacity) {
			const stale = this.#clean.keys().next().value;
			if (stale !== undefined) {
				this.#clean.delete(stale);
				continue;
			}
			const oldest = this.pages.entries().next().value;
			if (!oldest) throw new Error("Page cache is inconsistent");
			await this.flushPage(oldest[1]);
			this.pages.delete(oldest[0]);
		}
		const reference = file.block(index);
		const bytes = new Uint8Array(BLOCK_BYTES);
		if (reference) bytes.set(await this.#block(reference));
		this.pages.set(key, { file, index, bytes, dirty: false });
		this.#trim();
	}
	async #block(reference: BlockReference): Promise<Uint8Array> {
		const kept = this.#clean.get(reference.hash);
		if (kept) {
			this.#clean.delete(reference.hash);
			this.#clean.set(reference.hash, kept);
			return kept;
		}
		const bytes = await readBlock(this.storage, reference);
		this.#keep(reference.hash, bytes);
		return bytes;
	}
	#keep(hash: string, bytes: Uint8Array): void {
		// Callers mutate their page in place, so the retained copy is always private.
		this.#clean.set(hash, bytes.slice(0));
		this.#trim();
	}
	#trim(): void {
		while (this.pages.size + this.#clean.size > this.capacity) {
			const stale = this.#clean.keys().next().value;
			if (stale === undefined) throw new Error("Page cache exceeds its capacity");
			this.#clean.delete(stale);
		}
	}

	private async flushPage(page: Page): Promise<void> {
		if (!page.dirty) return;
		const length = Math.min(BLOCK_BYTES, page.file.size - page.index * BLOCK_BYTES);
		const bytes = page.bytes.buffer.slice(0, length);
		const hash = await this.storage.write(bytes);
		if (hash !== (await digest(bytes))) throw new Error("Stored block checksum mismatch");
		page.file.setBlock(page.index, { hash, length });
		page.dirty = false;
		this.#keep(hash, page.bytes.subarray(0, length));
	}
	/** Writes every dirty page, a few at a time; the manifest is encoded only after all succeed. */
	async flush(): Promise<void> {
		const dirty = [...this.pages.values()].filter((page) => page.dirty);
		let cursor = 0;
		const worker = async (): Promise<void> => {
			for (;;) {
				const page = dirty[cursor++];
				if (!page) return;
				await this.flushPage(page);
			}
		};
		await Promise.all(Array.from({ length: Math.min(FLUSH_CONCURRENCY, dirty.length) }, worker));
	}
}

export class PagedFile {
	#size: number;
	#blocks: (BlockReference | null)[];
	constructor(
		private readonly cache: PageCache,
		private readonly id: number,
		reference: FileReference,
	) {
		this.#size = reference.size;
		this.#blocks = reference.blocks.map((block) => (block ? { ...block } : null));
	}
	get size(): number {
		return this.#size;
	}
	key(index: number): string {
		return `${this.id}:${index}`;
	}
	block(index: number): BlockReference | null {
		return this.#blocks[index] ?? null;
	}
	setBlock(index: number, value: BlockReference): void {
		this.#blocks[index] = value;
	}
	async prepare(position: number, length: number): Promise<void> {
		const first = Math.floor(position / BLOCK_BYTES);
		const end = Math.ceil((position + length) / BLOCK_BYTES);
		if (
			!Number.isSafeInteger(position) ||
			!Number.isSafeInteger(length) ||
			position < 0 ||
			length < 0 ||
			end - first > this.cache.capacity
		)
			throw new Error("File operation exceeds the page cache capacity");
		for (let index = first; index < end; index++) await this.cache.load(this, index);
	}
	read(buffer: Uint8Array, offset: number, length: number, position: number): number {
		const count = Math.min(length, Math.max(0, this.#size - position));
		this.copy(buffer, offset, count, position, false);
		return count;
	}
	write(buffer: Uint8Array, offset: number, length: number, position: number): number {
		this.copy(buffer, offset, length, position, true);
		this.#grow(Math.max(this.#size, position + length));
		return length;
	}
	#grow(size: number): void {
		this.#size = size;
		while (this.#blocks.length < Math.ceil(size / BLOCK_BYTES)) this.#blocks.push(null);
	}
	private copy(buffer: Uint8Array, offset: number, length: number, position: number, write: boolean): void {
		for (let copied = 0; copied < length;) {
			const absolute = position + copied;
			const page = this.cache.pages.get(this.key(Math.floor(absolute / BLOCK_BYTES)));
			if (!page) throw new Error("File page was not loaded before its syscall");
			const start = absolute % BLOCK_BYTES;
			const count = Math.min(length - copied, BLOCK_BYTES - start);
			if (write) {
				page.bytes.set(buffer.subarray(offset + copied, offset + copied + count), start);
				page.dirty = true;
			} else buffer.set(page.bytes.subarray(start, start + count), offset + copied);
			copied += count;
		}
	}
	truncate(size: number): void {
		if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid file size");
		if (size < this.#size) {
			const count = Math.ceil(size / BLOCK_BYTES);
			this.#blocks.length = count;
			const last = this.#blocks[count - 1];
			if (last && size % BLOCK_BYTES)
				this.#blocks[count - 1] = { ...last, length: Math.min(last.length, size % BLOCK_BYTES) };
			for (const [key, page] of this.cache.pages) {
				if (page.file !== this) continue;
				if (page.index >= count) this.cache.pages.delete(key);
				else if (page.index === count - 1 && size % BLOCK_BYTES) {
					page.bytes.fill(0, size % BLOCK_BYTES);
					page.dirty = true;
				}
			}
		}
		this.#grow(size);
	}
	reference(): FileReference {
		return { size: this.#size, blocks: this.#blocks.map((block) => (block ? { ...block } : null)) };
	}
}
