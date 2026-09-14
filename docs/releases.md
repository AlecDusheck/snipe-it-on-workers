# Releases

A release is one version of an application, built once and deployed with the Worker.

**A pin** is source: `workers/snipe-it/releases/<version>.json`. It names the release (`snipeit-<version>`), the Snipe-IT commit and tag, and the PHP WebAssembly package and files to run it on, with checksums. A release is reproducible from its pin. Older pins are retained for upgrade tests.

**A built release** is output: `.build/snipe-it/assets/releases/<name>/`, ignored by git.

| File                     | Purpose                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`          | Name, version, PHP version, and the digest of every other file. Everything is verified against it before use.                                                                 |
| `files.idx`              | Binary index of the application archive: every path with its size, checksum and offset, so files can be read without unpacking the archive.                                   |
| `application.zip.000` …  | The PHP code and vendor libraries, in 1 MiB parts. Files are read from the parts they live in; the runtime keeps a few recently read parts and never holds the whole archive. |
| `worker.mjs`, `php.wasm` | The hosted runtime Worker and the patched PHP binary; a tenant's Dynamic Worker is created from them.                                                                         |
| `public/`                | Browser-facing files, served directly by the front Worker.                                                                                                                    |

`releases/releases.json` lists the built releases; the control panel's upgrade menu reads it.

## Building

```sh
pnpm build:release 8.7.2
```

Needs Docker. Steps:

1. `scripts/prepare-runtime.sh` verifies the pinned PHP WASM package against its checksums and applies the project's patches to the loader and the module. No PHP is compiled.
2. `scripts/prepare-upstream.sh` clones Snipe-IT at the pinned commit, runs Composer inside the `docker/Dockerfile` image, then builds Laravel's package, event and compiled view caches with artisan. The checkout is mounted at `/app`, the path the application has at runtime, so the caches stay valid. Configuration is not cached because it carries per-instance settings; routes are not cached because Laravel signs closure routes with the instance's key. Nothing is migrated or seeded: a new instance starts from an empty database and the application's own setup runs its migrations.
3. `packages/release-tools/src/build-release.ts` packages the checkout, bundles the runtime Worker and lays out the release directory.

Packaging excludes build inputs, not features: dotfiles, vendor test suites and docs, and frontend sources that are compiled into `public/`. The caches from step 2 ship in the archive. Locales, fonts, PDF and cloud SDKs ship as upstream provides them.

`pnpm build` builds every pinned release using Docker, then bundles the standalone Worker and control panel. Prepared upstream checkouts are reused; runtime binaries, archive indexes and Worker bundles are regenerated. `pnpm build:release <version>` also refreshes the upstream checkout. CI uses the same build path.

Docker is used only for native PHP and Composer during the build. Deployed requests execute PHP WebAssembly inside Workers.

## Deploying

Both Wrangler configurations expose `.build/snipe-it` as Static Assets under `/releases/`, which the front Worker never serves to browsers. Boots read the archive parts from the edge; the assets binding is the same in standalone and hosted mode.

`DEFAULT_RELEASE` names the release new instances start on and the one standalone upgrades to. Hosted tenants record the release they run in their own state; upgrades happen from the control panel. Standalone bundles the PHP binary of its default release and refuses to run a release built on a different binary, because Workers cannot load a binary at runtime.
