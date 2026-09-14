/**
 * Build one release from a prepared checkout into `<releases>/releases/<name>/`.
 *   tsx packages/release-tools/src/build-release.ts --pin <pin.json> --checkout <dir> --runtime <dir>
 *       --releases <tree> --entry <runtime worker> [--fixture]
 * Output: manifest, file index, 1 MiB archive parts, Worker bundle + php.wasm, public files.
 * --fixture: plain Laravel release for the runtime tests, no Worker.
 */
import { parseArgs } from "node:util";
import { resolve, join, relative } from "node:path";
import { mkdir, mkdtemp, readFile, writeFile, copyFile, cp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { partName } from "@simplyalec/laravel-cf-workers-laravel-runtime/release";
import { digestFile, readPin, sha256, walk } from "./lib";
import { packageCheckout } from "./package";
import { bundleWorker } from "./bundle";

const COMPATIBILITY_DATE = "2026-09-01";
const PART_BYTES = 1024 * 1024;

const { values } = parseArgs({
	options: {
		pin: { type: "string" },
		checkout: { type: "string" },
		runtime: { type: "string" },
		releases: { type: "string" },
		entry: { type: "string" },
		fixture: { type: "boolean", default: false },
	},
});
if (!values.pin || !values.checkout || !values.runtime || !values.releases)
	throw new Error("Missing arguments");
const pin = await readPin(values.pin);
const checkout = resolve(values.checkout);
const runtime = resolve(values.runtime);
const releases = resolve(values.releases);
const destination = join(releases, "releases", pin.name);
const staging = await mkdtemp(`${tmpdir()}/release-`);
try {
	const { application } = pin;
	const packaged = await packageCheckout(
		checkout,
		staging,
		application ? { commit: application.commit } : {},
	);
	if (!values.fixture) {
		if (!values.entry) throw new Error("--entry is required");
		await bundleWorker(resolve(values.entry), join(staging, "worker.mjs"), runtime);
		await copyFile(join(runtime, "php.wasm"), join(staging, "php.wasm"));
	}

	await rm(destination, { recursive: true, force: true });
	await mkdir(destination, { recursive: true });
	const archive = await readFile(join(staging, "application.zip"));
	const parts: string[] = [];
	for (let offset = 0; offset < archive.length; offset += PART_BYTES) {
		const part = archive.subarray(offset, offset + PART_BYTES);
		await writeFile(join(destination, partName(parts.length)), part);
		parts.push(sha256(part));
	}
	await copyFile(join(staging, "application.idx"), join(destination, "files.idx"));
	await cp(join(staging, "public"), join(destination, "public"), { recursive: true });
	const files: Record<string, string> = {
		worker: "0".repeat(64),
		wasm: "0".repeat(64),
		index: await digestFile(join(destination, "files.idx")),
	};
	if (!values.fixture) {
		await copyFile(join(staging, "worker.mjs"), join(destination, "worker.mjs"));
		await copyFile(join(staging, "php.wasm"), join(destination, "php.wasm"));
		await cp(join(runtime, "LICENSES"), join(destination, "licenses"), { recursive: true });
		await copyFile(join(runtime, "NOTICE"), join(destination, "NOTICE"));
		files.worker = await digestFile(join(destination, "worker.mjs"));
		files.wasm = await digestFile(join(destination, "php.wasm"));
	}
	const publicFiles: Record<string, string> = {};
	for await (const full of walk(join(destination, "public")))
		publicFiles[relative(join(destination, "public"), full).split("\\").join("/")] = await digestFile(full);
	const manifest = {
		name: pin.name,
		version: application?.tag ?? "1.0.0",
		phpVersion: pin.php.version,
		compatibilityDate: COMPATIBILITY_DATE,
		files,
		corpus: { bytes: archive.length, partBytes: PART_BYTES, parts },
		public: publicFiles,
		source: pin,
		stats: packaged,
	};
	await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
	await refreshList(releases);

	console.log(
		`Built ${pin.name} (${packaged.files} files, ${(archive.length / 1048576).toFixed(1)} MiB archive in ${parts.length} parts)`,
	);
} finally {
	await rm(staging, { recursive: true, force: true });
}

/** `releases/releases.json` lists every built release; the control panel reads it. */
async function refreshList(tree: string): Promise<void> {
	const names = (await readdir(join(tree, "releases"), { withFileTypes: true }))
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.toSorted();
	await writeFile(join(tree, "releases/releases.json"), JSON.stringify(names) + "\n");
}
