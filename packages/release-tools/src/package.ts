/**
 * Packages a prepared checkout into application.zip, application.idx and public/.
 * Only build inputs are excluded; Laravel caches from prepare-upstream.sh ship in the archive.
 */
import { crc32, deflateRawSync } from "node:zlib";
import { readFile, lstat, mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { indexArchive } from "@simplyalec/laravel-cf-workers-laravel-runtime/corpus";
import { encodeCorpusIndex } from "@simplyalec/laravel-cf-workers-laravel-runtime/corpus-index";
import { walk } from "./lib";

const ARCHIVE_TIME = [1980, 0, 1] as const;
/** Directories the application writes at runtime; they exist in the archive so mounts have them. */
const RUNTIME_DIRECTORIES = [
	"bootstrap/cache/",
	"storage/logs/",
	"storage/framework/views/",
	"storage/framework/cache/data/",
	"storage/framework/sessions/",
	"database/",
	"public/uploads/",
];
const PHP_ROOTS = new Set(["app", "bootstrap", "config", "routes", "vendor", "database", "resources"]);
const CACHE_ROOTS = ["bootstrap/cache/", "storage/framework/views/"];
const PHP_FILES = new Set([
	"artisan",
	"composer.json",
	"composer.lock",
	"LICENSE",
	"public/mix-manifest.json",
]);

/** Why a checkout file is not part of the runtime archive, or undefined when it is. */
export function excluded(path: string): string | undefined {
	const parts = path.split("/");
	const top = parts[0] ?? "";
	if (parts.some((part) => part.startsWith("."))) return "environment file";
	if (CACHE_ROOTS.some((root) => path.startsWith(root)))
		return path.endsWith(".php") ? undefined : "cache metadata";
	if (
		top === "vendor" &&
		parts.slice(3).some((part) => ["tests", "Tests", "docs", "examples"].includes(part))
	)
		return "vendor development assets";
	if (top === "resources" && !["lang", "views"].includes(parts[1] ?? "")) return "frontend sources";
	if (top === "database" && !["migrations", "seeders", "factories"].includes(parts[1] ?? ""))
		return "mutable database data";
	if (!PHP_ROOTS.has(top) && !PHP_FILES.has(path)) return "outside PHP application";
	return undefined;
}

/** A deterministic deflate ZIP: fixed timestamps, read-only entries, sorted paths. */
export class ZipWriter {
	readonly #locals: Uint8Array[] = [];
	readonly #centrals: Uint8Array[] = [];
	#offset = 0;
	#count = 0;
	add(path: string, data: Uint8Array): void {
		const name = Buffer.from(path);
		const directory = path.endsWith("/");
		const packed = directory ? new Uint8Array() : deflateRawSync(data, { level: 9 });
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(directory ? 0 : 8, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(((ARCHIVE_TIME[0] - 1980) << 9) | ((ARCHIVE_TIME[1] + 1) << 5) | ARCHIVE_TIME[2], 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(directory ? 0 : 8, 10);
		central.writeUInt16LE(0, 12);
		central.writeUInt16LE(local.readUInt16LE(12), 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(packed.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(((directory ? 0o40755 : 0o100444) << 16) >>> 0, 38);
		central.writeUInt32LE(this.#offset, 42);
		this.#locals.push(local, name, packed);
		this.#centrals.push(central, name);
		this.#offset += 30 + name.length + packed.length;
		this.#count++;
	}
	finish(): Uint8Array {
		const directorySize = this.#centrals.reduce((total, part) => total + part.length, 0);
		const end = Buffer.alloc(22);
		end.writeUInt32LE(0x06054b50, 0);
		end.writeUInt16LE(this.#count, 8);
		end.writeUInt16LE(this.#count, 10);
		end.writeUInt32LE(directorySize, 12);
		end.writeUInt32LE(this.#offset, 16);
		return Buffer.concat([...this.#locals, ...this.#centrals, end]);
	}
}

export interface Packaged {
	files: number;
	archiveBytes: number;
	omittedBytesByReason: Record<string, number>;
}

/** With `commit`, the checkout must be at that commit and clean. */
export async function packageCheckout(
	checkout: string,
	output: string,
	options: { commit?: string } = {},
): Promise<Packaged> {
	if (options.commit) {
		const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		if (head !== options.commit) throw new Error("Source commit does not match the pin");
		if (execFileSync("git", ["-C", checkout, "diff", "HEAD", "--"], { encoding: "utf8" }))
			throw new Error("Upstream source has changes; record explicit overlays instead");
	}
	await mkdir(output, { recursive: true });
	const lock: unknown = JSON.parse(await readFile(join(checkout, "composer.lock"), "utf8"));
	const packages = new Set<string>();
	if (typeof lock === "object" && lock !== null && "packages" in lock && Array.isArray(lock.packages))
		for (const entry of lock.packages)
			if (typeof entry === "object" && entry !== null && "name" in entry) packages.add(String(entry.name));
	const zip = new ZipWriter();
	const omitted: Record<string, number> = {};
	let files = 0;
	for await (const full of walk(checkout)) {
		if ((await lstat(full)).isSymbolicLink()) continue;
		const path = relative(checkout, full).split("\\").join("/");
		const parts = path.split("/");
		let reason = excluded(path);
		if (!reason && parts[0] === "vendor" && parts[1] !== "composer" && path !== "vendor/autoload.php")
			if (!packages.has(`${parts[1]}/${parts[2]}`)) reason = "development dependency";
		if (reason) {
			omitted[reason] = (omitted[reason] ?? 0) + (await lstat(full)).size;
			continue;
		}
		let data = new Uint8Array(await readFile(full));
		if (path === "vendor/composer/installed.json") {
			const metadata: unknown = JSON.parse(Buffer.from(data).toString());
			if (
				typeof metadata === "object" &&
				metadata !== null &&
				"packages" in metadata &&
				Array.isArray(metadata.packages)
			) {
				const kept = metadata.packages.filter(
					(entry: unknown) =>
						typeof entry === "object" &&
						entry !== null &&
						"name" in entry &&
						packages.has(String(entry.name)),
				);
				data = Buffer.from(
					JSON.stringify({ ...metadata, packages: kept, dev: false, "dev-package-names": [] }),
				);
			}
		}
		zip.add(path, data);
		files++;
	}
	for (const directory of RUNTIME_DIRECTORIES) zip.add(directory, new Uint8Array());
	const archive = zip.finish();
	await writeFile(join(output, "application.zip"), archive);
	await writeFile(join(output, "application.idx"), encodeCorpusIndex(indexArchive(archive)));
	await rm(join(output, "public"), { recursive: true, force: true });
	await mkdir(join(output, "public"), { recursive: true });
	for await (const full of walk(join(checkout, "public"))) {
		const path = relative(join(checkout, "public"), full);
		if (path.startsWith("uploads/") || (await lstat(full)).isSymbolicLink() || path.endsWith(".php"))
			continue;
		await mkdir(dirname(join(output, "public", path)), { recursive: true });
		await copyFile(full, join(output, "public", path));
	}
	return { files, archiveBytes: archive.length, omittedBytesByReason: omitted };
}
