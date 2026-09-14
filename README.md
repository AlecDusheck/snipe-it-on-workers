# Snipe-IT on Workers

Run Snipe-IT on Cloudflare Workers with PHP WebAssembly and Durable Object SQLite. No Containers.

Want to host multiple instances? Using [dynamic workers](https://developers.cloudflare.com/dynamic-workers/), you can host unlimited instances with configurable limits, etc.

| Application                   | Pinned version  | Deployment                             |
| ----------------------------- | --------------- | -------------------------------------- |
| [Snipe-IT](workers/snipe-it/) | 8.7.2 · PHP 8.5 | [Build and deploy](docs/deployment.md) |

## Status

Works and is stable. We have quite a large test/regression suite for issues identified during testing. However, performence is still rather slow. You'll see there are _many_ performence tricks used to get things to even this point. If you have suggestions, please contribute :)

## How and why?

Many PHP applications are still very expensive to host nowdays. Snipe-IT on workers costs about $2 a month of metered usage for a small team (10 users, 20,000 page views, 1 GB of data) and about $35 for a large one (200 users, 880,000 page views, 5 GB), before the Workers Paid plan's $5 minimum and included quotas, which cover the small team entirely and bring the large one to roughly $14, with _no_ coldstarts, ever!

In order to do this, PHP itself runs as WebAssembly inside a Durable Object. The interpreter is booted once and kept warm, the application archive is mounted lazily from Static Assets, and the database and uploads live in Durable Object SQLite as immutable 64 KiB blocks that a paged filesystem reads and writes on demand. Every request is one serialized execution against that state, committed in a single local transaction, so there is no container, no cold VM and no object storage in the request path.

## Architecture

`packages/` contains reusable libraries and build tools; `workers/` contains deployable applications and their configuration.

| Location                                  | Responsibility                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/laravel-runtime`                | PHP WASM execution, Laravel request handling, paged files and the application profile contract             |
| `packages/cloudflare-platform`            | Durable Object storage and coordination, KV tenant directory, routing, quotas, upgrades and management RPC |
| `packages/release-tools`                  | Prepare pinned PHP runtimes, package application releases and build standalone Workers                     |
| `workers/snipe-it/backplane`              | Wire the shared packages to Snipe-IT's profile; standalone and hosted Worker entrypoints                   |
| `workers/snipe-it/control-panel`          | SvelteKit management app, connected to the backplane through a Worker service binding                      |
| `workers/snipe-it/releases` and `scripts` | Snipe-IT version pins and release commands                                                                 |

**Standalone:** the root Wrangler configuration deploys one instance in your account, with no panel, KV directory or Dynamic Workers. Complete Snipe-IT's own setup wizard after deployment.

**Hosted:** deploy the backplane and panel. Workers KV stores tenant names and hostnames; each tenant's database, uploads and sessions live in its Durable Object SQLite. Dynamic Workers execute the tenant's selected release. Releases ship as Static Assets.

The project is modular so other Laravel apps can be added with their own profile, release pins, Worker entrypoints and integration tests. The shared packages contain no Snipe-IT integration code. Each package owns its unit tests; a plain Laravel fixture tests the runtime independently, and Snipe-IT keeps its full application integration suite. [Architecture and testing](docs/architecture.md#package-boundaries-and-tests).

## Development

Requires Node 22+, pnpm and Docker for building upstream releases.

```sh
pnpm install --frozen-lockfile
pnpm build                 # build missing pinned releases with Docker, then bundle the Workers
cp workers/snipe-it/control-panel/.dev.vars.example workers/snipe-it/control-panel/.dev.vars
pnpm dev                   # hosted backplane and panel
# pnpm dev:standalone      # single-instance Worker
pnpm verify
```

Configure Snipe-IT through `SNIPEIT_ENV` and secrets; no administrator credentials are needed at deployment. Hosted Wrangler vars and bindings are scoped to `development` and `production`. Root commands target Snipe-IT. [Configuration and local URLs](docs/deployment.md) · [Release builds and upgrades](docs/releases.md).

## License

**This repository's original code is [MIT licensed](LICENSE).** Snipe-IT's source is fetched at build time, not vendored in this checkout. Snipe-IT remains [AGPLv3](https://github.com/grokability/snipe-it/blob/v8.7.2/LICENSE), and other dependencies retain their own licenses. Locally generated deployment bundles contain Snipe-IT; sharing those bundles is distribution even though its source is absent from this Git tree.

**For operators:** AGPL §13 requires modified networked versions to prominently offer their users the complete Corresponding Source at no charge. This project applies compatibility overrides, so provide source for the adapted version: the exact Snipe-IT source, modifications, and applicable dependency source and scripts needed to build, install, run and modify it. Preserve license notices and meet the distribution requirements when sharing release bundles. MIT licensing of our original code does not remove AGPL obligations for a combined or modified Snipe-IT application.
