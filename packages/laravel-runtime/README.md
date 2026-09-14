# Laravel runtime

`@simplyalec/laravel-cf-workers-laravel-runtime` executes Laravel in PHP WebAssembly. It owns the PHP request bridge, paged filesystem, release reader and runtime protocol.

Applications supply an `ApplicationProfile` through `/application`. `/executor` runs requests; `/entrypoint` exposes the hosted runtime entrypoint. Storage is supplied through the `BlockStorage` interface.

Unit tests live in `tests/`; `tests/integration/` and `tests/benchmark/` run an independent Laravel fixture. `/testing` and `/testing/driver` expose the shared test harness and diagnostic Worker; `/bundle` exposes the shared esbuild options.

Run `pnpm --filter @simplyalec/laravel-cf-workers-laravel-runtime test`. Prepare the fixture with `pnpm prepare:fixture` before `test:integration` or `test:benchmark`.
