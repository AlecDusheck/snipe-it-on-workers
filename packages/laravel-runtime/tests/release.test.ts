import { test } from "node:test";
import assert from "node:assert/strict";
import { digest } from "../src/crypto";
import { ArchiveReader, archiveIdentity, releaseFile } from "../src/release";
import type { Release } from "../src/types";

const PART = 4;
const archive = Uint8Array.from({ length: 10 }, (_, i) => i + 1);
const parts = [archive.subarray(0, 4), archive.subarray(4, 8), archive.subarray(8, 10)];

async function fixture(): Promise<{ release: Release; assets: Fetcher; fetches: string[] }> {
	const fetches: string[] = [];
	const release: Release = {
		name: "app-1.0.0",
		version: "1.0.0",
		compatibilityDate: "2026-09-01",
		files: {
			worker: "0".repeat(64),
			wasm: "0".repeat(64),
			index: await digest(Buffer.from("{}")),
		},
		corpus: {
			bytes: archive.length,
			partBytes: PART,
			parts: await Promise.all(parts.map((part) => digest(part))),
		},
	};
	const assets = {
		async fetch(input: RequestInfo | URL): Promise<Response> {
			const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
				.pathname;
			fetches.push(path);
			const match = path.match(/application\.zip\.(\d{3})$/);
			if (match)
				return new Response(parts[Number(match[1])] ?? null, { status: parts[Number(match[1])] ? 200 : 404 });
			if (path.endsWith("files.idx")) return new Response("{}");
			return new Response(null, { status: 404 });
		},
		connect: () => {
			throw new Error("unused");
		},
	};
	return { release, assets, fetches };
}

test("whole files are verified against the manifest", async () => {
	const { release, assets } = await fixture();
	assert.equal(Buffer.from(await releaseFile(assets, release, "index")).toString(), "{}");
	await assert.rejects(releaseFile(assets, release, "wasm"), /missing/);
	await assert.rejects(
		releaseFile(assets, { ...release, files: { ...release.files, index: "f".repeat(64) } }, "index"),
		/checksum/,
	);
});

test("range reads span parts and reuse recently read ones", async () => {
	const { release, assets, fetches } = await fixture();
	const reader = new ArchiveReader(assets, release, 2);
	assert.deepEqual(await reader.range(3, 3), Uint8Array.from([4, 5, 6]));
	assert.equal(fetches.length, 2);
	assert.deepEqual(await reader.range(4, 4), Uint8Array.from([5, 6, 7, 8]));
	assert.equal(fetches.length, 2);
	assert.deepEqual(await reader.range(8, 2), Uint8Array.from([9, 10]));
	assert.equal(fetches.length, 3);
	assert.deepEqual(await reader.range(0, 1), Uint8Array.from([1]));
	assert.equal(fetches.length, 4);
	await assert.rejects(reader.range(9, 2), /out of range/);
	const tampered = { ...release, corpus: { ...release.corpus, parts: [...release.corpus.parts] } };
	tampered.corpus.parts[1] = "e".repeat(64);
	await assert.rejects(new ArchiveReader(assets, tampered).range(4, 1), /checksum/);
});

test("retain drops the least recently read parts", async () => {
	const { release, assets, fetches } = await fixture();
	const reader = new ArchiveReader(assets, release, 3);
	await reader.range(0, 10);
	assert.equal(fetches.length, 3);
	assert.equal(reader.heldBytes, 12);
	reader.retain(1);
	assert.equal(reader.heldBytes, 4);
	await reader.range(8, 2);
	assert.equal(fetches.length, 3);
	await reader.range(0, 1);
	assert.equal(fetches.length, 4);
});

test("source cache identity includes authenticated archive parts, not only the ZIP index", async () => {
	const { release } = await fixture();
	const identity = await archiveIdentity(release);
	assert.equal(await archiveIdentity({ ...release }), identity);
	assert.notEqual(
		await archiveIdentity({
			...release,
			corpus: { ...release.corpus, parts: ["f".repeat(64), ...release.corpus.parts.slice(1)] },
		}),
		identity,
	);
});
