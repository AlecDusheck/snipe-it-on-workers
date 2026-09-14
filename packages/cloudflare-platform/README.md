# Cloudflare platform

`@simplyalec/laravel-cf-workers-cloudflare-platform` hosts the Laravel runtime on Cloudflare. It owns Durable Object storage and request coordination, the optional KV tenant directory, routing, quotas, release upgrades and management RPC.

Application Workers wire `/tenant` to `/standalone` or `/dynamic` and supply their application profile. `/router` handles hosted tenant traffic; `/control` exposes the management service-binding entrypoint. Wrangler configuration belongs to the application Workers.

Tests live in `tests/`, including workerd tests for KV and Durable Object SQLite. `/testing` exposes bundling helpers to application integration suites.

Run `pnpm --filter @simplyalec/laravel-cf-workers-cloudflare-platform test`.
