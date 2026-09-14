# Release tools

`@simplyalec/laravel-cf-workers-release-tools` prepares pinned PHP WASM binaries and packages Laravel application releases. It runs in Node during builds, outside deployed Workers.

The CLIs in `src/` accept explicit paths: `prepare-runtime.ts`, `build-release.ts` and `build-standalone.ts`. Application-specific pins and wrapper commands belong under `workers/<app>/`. The runtime package owns the archive format consumed by the packager.

Tests in `tests/` verify packaging, checksums and exact application of patches to pinned upstream PHP loaders and binaries.

Run `pnpm --filter @simplyalec/laravel-cf-workers-release-tools test`.
