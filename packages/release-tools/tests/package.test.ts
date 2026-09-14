import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipWriter, excluded, packageCheckout } from "../src/package";
import { indexArchive } from "@simplyalec/laravel-cf-workers-laravel-runtime/corpus";

test("the archive keeps runtime files and drops build inputs", () => {
	for (const kept of [
		"app/Models/Asset.php",
		"vendor/livewire/livewire/dist/livewire.js",
		"vendor/tecnickcom/tcpdf/fonts/helvetica.php",
		"resources/lang/de-DE/general.php",
		"database/migrations/2020_01_01_000000_x.php",
		"public/mix-manifest.json",
		"composer.lock",
	])
		assert.equal(excluded(kept), undefined, kept);
	for (const [dropped, reason] of [
		[".env", "environment file"],
		["bootstrap/cache/.gitignore", "environment file"],
		["vendor/foo/bar/tests/FooTest.php", "vendor development assets"],
		["resources/js/app.js", "frontend sources"],
		["database/database.sqlite", "mutable database data"],
		["public/css/app.css", "outside PHP application"],
		["tests/Feature/x.php", "outside PHP application"],
	])
		assert.equal(excluded(dropped ?? ""), reason, dropped);
});

test("the zip writer produces archives the runtime indexes", () => {
	const zip = new ZipWriter();
	zip.add("dir/", new Uint8Array());
	zip.add("dir/a.php", Buffer.from("<?php echo 'a';"));
	zip.add("b.txt", Buffer.from("plain"));
	const index = indexArchive(zip.finish());
	assert.deepEqual([...index.files.keys()].toSorted(), ["b.txt", "dir/a.php"]);
	assert.deepEqual(index.directories.get("dir"), ["a.php"]);
	assert.equal(index.files.get("dir/a.php")?.deflated, true);
});

test("a checkout packages into archive, index and public files", async () => {
	const checkout = await mkdtemp(`${tmpdir()}/checkout-`);
	const output = await mkdtemp(`${tmpdir()}/package-`);
	try {
		await mkdir(join(checkout, "app"), { recursive: true });
		await mkdir(join(checkout, "vendor/acme/lib/src"), { recursive: true });
		await mkdir(join(checkout, "vendor/composer"), { recursive: true });
		await mkdir(join(checkout, "vendor/dev/tool"), { recursive: true });
		await mkdir(join(checkout, "public/css"), { recursive: true });
		await writeFile(join(checkout, "app/Kernel.php"), "<?php");
		await writeFile(join(checkout, "vendor/autoload.php"), "<?php");
		await writeFile(join(checkout, "vendor/acme/lib/src/Lib.php"), "<?php");
		await writeFile(join(checkout, "vendor/dev/tool/Tool.php"), "<?php");
		await writeFile(join(checkout, "composer.json"), "{}");
		await writeFile(join(checkout, "composer.lock"), JSON.stringify({ packages: [{ name: "acme/lib" }] }));
		await writeFile(
			join(checkout, "vendor/composer/installed.json"),
			JSON.stringify({
				packages: [{ name: "acme/lib" }, { name: "dev/tool" }],
				dev: true,
				"dev-package-names": ["dev/tool"],
			}),
		);
		await writeFile(join(checkout, "public/css/app.css"), "body{}");
		await writeFile(join(checkout, "public/index.php"), "<?php");
		const packaged = await packageCheckout(checkout, output);
		assert.equal(packaged.omittedBytesByReason["development dependency"], 5);
		const index = indexArchive(await readFile(join(output, "application.zip")));
		assert.ok(index.files.has("vendor/acme/lib/src/Lib.php"));
		assert.ok(!index.files.has("vendor/dev/tool/Tool.php"));
		assert.ok(index.directories.has("storage/framework/views"));
		await readFile(join(output, "public/css/app.css"));
		await assert.rejects(readFile(join(output, "public/index.php")));
	} finally {
		await rm(checkout, { recursive: true, force: true });
		await rm(output, { recursive: true, force: true });
	}
});
