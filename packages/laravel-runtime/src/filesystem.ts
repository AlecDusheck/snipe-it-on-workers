import type { Emscripten } from "@php-wasm/universal";
import { PageCache } from "./paged-file";
import type { PagedFile } from "./paged-file";
import {
	BLOCK_BYTES,
	CODE_CACHE_ROOT,
	DATABASE_PATH,
	EPHEMERAL_ROOTS,
	decodeFiles,
	encodeFiles,
	ephemeralPath,
	isFileManifest,
	persistentPath,
} from "./files";
import type { RuntimeStorage, FileManifest, FileReference } from "./files";
import { record } from "./schema";
import { sameBytes } from "./crypto";
import { object, unsupportedMmap } from "./emscripten";

type FsNode = ReturnType<Emscripten.RootFS["lookupPath"]>["node"];
interface Tree {
	roots: string[];
	manifest: FileManifest;
	bytes: ArrayBuffer;
	dirty: Set<FsNode>;
	structural: boolean;
}
const tree = (roots: string[], manifest: FileManifest, bytes: ArrayBuffer, structural = false): Tree => ({
	roots,
	manifest,
	bytes,
	dirty: new Set(),
	structural,
});
export class PersistentFilesystem {
	#files = new Map<object, PagedFile>();
	#cache: PageCache | undefined;
	#committed: Tree | undefined;
	#ephemeral: Tree | undefined;
	#bytecode: Tree | undefined;
	#restoring = false;
	#originalDirectoryOperations = new WeakMap<object, Record<string, unknown>>();
	constructor(
		private readonly fs: Emscripten.RootFS,
		private readonly roots: string[] = ["/app/storage/app"],
		private readonly cacheNamespace?: string,
	) {}
	get cachedBytes(): number {
		return this.#cache?.retainedBytes ?? 0;
	}
	get manifestBytes(): number {
		return [this.#committed, this.#ephemeral, this.#bytecode].reduce(
			(total, state) => total + (state?.bytes.byteLength ?? 0),
			0,
		);
	}
	get #storageRoots(): string[] {
		return [...this.roots, ...EPHEMERAL_ROOTS, "/app/tmp"];
	}
	/** Mounts the committed tree and the ephemeral tree; raw SQLite bytes seed a fresh committed tree. */
	async restore(
		trees: { database: ArrayBuffer; ephemeral: ArrayBuffer },
		storage: RuntimeStorage,
	): Promise<void> {
		if (this.#cache) this.#cache.reset(storage);
		else this.#cache = new PageCache(storage);
		if (!this.#bytecode && this.cacheNamespace) {
			const root = `${CODE_CACHE_ROOT}/${this.cacheNamespace}`;
			const bytes = await storage.readCodeCache(this.cacheNamespace);
			const manifest = decodeFiles(bytes, "code");
			this.fs.mkdirTree(root);
			this.#mount(manifest, (path) => path.startsWith(root + "/"));
			this.#bytecode = tree([root], manifest, bytes);
			this.attachDirectory(root);
		}
		// The coordinator can roll back a completed request; reuse nodes only for the exact snapshot trees.
		if (
			this.#committed &&
			this.#ephemeral &&
			sameBytes(trees.database, this.#committed.bytes) &&
			sameBytes(trees.ephemeral, this.#ephemeral.bytes)
		) {
			this.remove("/app/tmp");
			this.fs.mkdirTree("/app/tmp");
			this.attachDirectory("/app/tmp");
			return;
		}
		this.#committed = this.#ephemeral = undefined;
		this.#restoring = true;
		let committed: FileManifest;
		if (isFileManifest(trees.database)) committed = decodeFiles(trees.database);
		else {
			const blocks = [];
			for (let offset = 0; offset < trees.database.byteLength; offset += BLOCK_BYTES) {
				const bytes = trees.database.slice(offset, offset + BLOCK_BYTES);
				blocks.push({ hash: await storage.write(bytes), length: bytes.byteLength });
			}
			committed = {
				format: "laravel-files/1",
				files: { [DATABASE_PATH]: { size: trees.database.byteLength, blocks } },
			};
		}
		for (const root of this.#storageRoots) {
			this.remove(root);
			this.fs.mkdirTree(root);
		}
		this.remove(DATABASE_PATH);
		this.#mount(committed, (path) => persistentPath(path, this.roots));
		const ephemeral = decodeFiles(trees.ephemeral, "ephemeral");
		this.#mount(ephemeral, ephemeralPath);
		for (const root of this.#storageRoots) this.attachDirectory(root);
		this.attachDirectory("/app/database");
		this.#committed = tree(
			[DATABASE_PATH, ...this.roots],
			committed,
			trees.database,
			!isFileManifest(trees.database),
		);
		this.#ephemeral = tree([...EPHEMERAL_ROOTS], ephemeral, trees.ephemeral);
		this.#restoring = false;
	}
	#mount(manifest: FileManifest, allowed: (path: string) => boolean): void {
		for (const path of manifest.directories ?? []) {
			if (!allowed(path + "/")) throw new Error("Directory is outside application storage");
			this.fs.mkdirTree(path);
		}
		for (const [path, reference] of Object.entries(manifest.files)) {
			if (!allowed(path)) throw new Error("File is outside application storage");
			const slash = path.lastIndexOf("/");
			this.fs.mkdirTree(path.slice(0, slash));
			this.fs.createDataFile(path.slice(0, slash), path.slice(slash + 1), new Uint8Array(), true, true, true);
			this.attachFile(path, reference);
		}
	}
	#mark(path: string, node?: FsNode): void {
		if (this.#restoring) return;
		for (const state of [this.#committed, this.#ephemeral, this.#bytecode]) {
			if (!state?.roots.some((root) => path === root || path.startsWith(root + "/"))) continue;
			if (node) state.dirty.add(node);
			else state.structural = true;
			return;
		}
	}

	private remove(path: string): void {
		const found = this.fs.analyzePath(path);
		if (!found.exists) return;
		const node = this.fs.lookupPath(path).node;
		if (this.fs.isDir(node.mode)) {
			for (const name of this.fs.readdir(path))
				if (name !== "." && name !== "..") this.remove(`${path}/${name}`);
			this.fs.rmdir(path);
		} else this.fs.unlink(path);
	}
	private attachDirectory(path: string): void {
		const node = this.fs.lookupPath(path).node;
		const raw = object(node);
		const operations = this.#originalDirectoryOperations.get(node) ?? object(raw.node_ops);
		this.#originalDirectoryOperations.set(node, operations);
		const original = operations.mknod;
		const unlink = operations.unlink;
		const rename = operations.rename;
		const rmdir = operations.rmdir;
		if (
			typeof original !== "function" ||
			typeof unlink !== "function" ||
			typeof rename !== "function" ||
			typeof rmdir !== "function"
		)
			throw new Error("Filesystem creation hook is unavailable");
		raw.node_ops = {
			...operations,
			// A deleted file's pages, such as a finished SQLite journal, must never be flushed as blocks.
			unlink: (parent: unknown, name: string): unknown => {
				const target = this.fs.lookupPath(`${this.fs.getPath(node)}/${name}`).node;
				const file = this.#files.get(target);
				const removedPath = this.fs.getPath(target);
				const result: unknown = Reflect.apply(unlink, operations, [parent, name]);
				this.#mark(removedPath);
				if (file) {
					this.#cache?.forget(file);
					this.#files.delete(target);
				}
				return result;
			},
			rmdir: (parent: unknown, name: string): unknown => {
				const removedPath = `${this.fs.getPath(node)}/${name}`;
				const result: unknown = Reflect.apply(rmdir, operations, [parent, name]);
				this.#mark(removedPath);
				return result;
			},
			rename: (source: FsNode, parent: FsNode, name: string): unknown => {
				const before = this.fs.getPath(source);
				const after = `${this.fs.getPath(parent)}/${name}`;
				const found = this.fs.analyzePath(after);
				const replaced = found.exists ? this.fs.lookupPath(after).node : undefined;
				const result: unknown = Reflect.apply(rename, operations, [source, parent, name]);
				if (replaced && replaced !== source) {
					const file = this.#files.get(replaced);
					if (file) this.#cache?.forget(file);
					this.#files.delete(replaced);
				}
				this.#mark(before);
				this.#mark(after);
				return result;
			},
			mknod: (parent: unknown, name: string, mode: number, dev: number): unknown => {
				const created: unknown = Reflect.apply(original, operations, [parent, name, mode, dev]);
				const child = `${this.fs.getPath(node)}/${name}`;
				this.#mark(child);
				if (this.fs.isDir(mode)) this.attachDirectory(child);
				else if (this.fs.isFile(mode)) this.attachFile(child, { size: 0, blocks: [] });
				else throw new Error("Persistent storage supports files and directories");
				return created;
			},
		};
		for (const name of this.fs.readdir(path)) {
			if (name === "." || name === "..") continue;
			const child = `${path}/${name}`;
			if (this.fs.isDir(this.fs.lookupPath(child).node.mode)) this.attachDirectory(child);
		}
	}
	private attachFile(path: string, reference: FileReference): void {
		if (!this.#cache) throw new Error("File cache is unavailable");
		const node = this.fs.lookupPath(path).node;
		const raw = object(node);
		const file = this.#cache.file(reference);
		this.#files.set(node, file);
		raw.mode = reference.mode ?? 0o100600;
		raw.mtime = reference.modifiedAt ?? Date.now();
		Object.defineProperty(node, "usedBytes", { configurable: true, get: () => file.size });
		raw.node_ops = {
			...object(raw.node_ops),
			setattr: (_node: unknown, attributes: unknown) => {
				const attr = object(attributes);
				for (const key of ["mode", "atime", "mtime", "ctime"])
					if (attr[key] !== undefined) raw[key] = attr[key];
				if (typeof attr.size === "number") file.truncate(attr.size);
				if (["mode", "mtime", "size"].some((key) => attr[key] !== undefined))
					this.#mark(this.fs.getPath(node), node);
			},
		};
		raw.stream_ops = {
			...object(raw.stream_ops),
			read: (_stream: unknown, buffer: Uint8Array, offset: number, length: number, position: number) =>
				file.read(buffer, offset, length, position),
			write: (_stream: unknown, buffer: Uint8Array, offset: number, length: number, position: number) => {
				raw.mtime = raw.ctime = Date.now();
				this.#mark(this.fs.getPath(node), node);
				return file.write(buffer, offset, length, position);
			},
			mmap: unsupportedMmap,
		};
	}
	owns(stream: unknown): boolean {
		const input = object(stream);
		return record(input.node) && this.#files.has(input.node);
	}
	async io(
		stream: unknown,
		heap: Uint8Array,
		iov: number,
		count: number,
		write: boolean,
		operation: (pointer: number, length: number) => number,
	): Promise<number | undefined> {
		const input = object(stream);
		if (!record(input.node)) return undefined;
		const file = this.#files.get(input.node);
		if (!file) return undefined;
		const view = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
		let total = 0;
		for (let index = 0; index < count; index++) {
			const pointer = view.getUint32(iov + index * 8, true);
			const length = view.getUint32(iov + index * 8 + 4, true);
			for (let offset = 0; offset < length;) {
				if (typeof input.position !== "number") throw new Error("Invalid file position");
				const position =
					write && typeof input.flags === "number" && (input.flags & 1024) !== 0 ? file.size : input.position;
				const size = Math.min(BLOCK_BYTES, length - offset);
				await file.prepare(position, write ? size : Math.min(size, Math.max(0, file.size - position)));
				// Native FS enforces descriptor permissions, O_APPEND and offset updates.
				const consumed = operation(pointer + offset, size);
				total += consumed;
				offset += consumed;
				if (consumed < size) return total;
			}
		}
		return total;
	}

	reference(path: string): FileReference {
		const file = this.#files.get(this.fs.lookupPath(path).node);
		if (!file) throw new Error("File is not tracked by persistent storage");
		return file.reference();
	}
	#capture(node: FsNode): FileReference {
		const file = this.#files.get(node);
		if (!file) throw new Error("Untracked persistent file");
		const raw = object(node);
		return {
			...file.reference(),
			mode: node.mode,
			modifiedAt: typeof raw.mtime === "number" ? raw.mtime : Date.now(),
		};
	}
	#snapshot(state: Tree): ArrayBuffer {
		if (!state.structural && !state.dirty.size) return state.bytes;
		// Renames and directory mutations can affect descendants; ordinary writes only visit dirty nodes.
		if (state.structural) {
			const manifest: FileManifest = { format: "laravel-files/1", files: {}, directories: [] };
			const walk = (path: string): void => {
				const node = this.fs.lookupPath(path).node;
				if (this.fs.isDir(node.mode)) {
					manifest.directories?.push(path);
					for (const name of this.fs.readdir(path).toSorted())
						if (name !== "." && name !== "..") walk(`${path}/${name}`);
				} else manifest.files[path] = this.#capture(node);
			};
			for (const root of state.roots) walk(root);
			state.manifest = manifest;
		} else {
			for (const node of state.dirty) {
				const path = this.fs.getPath(node);
				state.manifest.files[path] = this.#capture(node);
			}
		}
		state.bytes = encodeFiles(state.manifest);
		state.dirty.clear();
		state.structural = false;
		return state.bytes;
	}
	async snapshot(storage: RuntimeStorage): Promise<{ database: ArrayBuffer; ephemeral: ArrayBuffer }> {
		if (!this.#cache || !this.#committed || !this.#ephemeral) throw new Error("File cache is unavailable");
		await this.#cache.flush();
		if (this.#bytecode && this.cacheNamespace) {
			const previous = this.#bytecode.bytes;
			const next = this.#snapshot(this.#bytecode);
			if (next !== previous) await storage.writeCodeCache(this.cacheNamespace, next);
		}
		const trees = { database: this.#snapshot(this.#committed), ephemeral: this.#snapshot(this.#ephemeral) };
		await storage.flush();
		return trees;
	}
}
