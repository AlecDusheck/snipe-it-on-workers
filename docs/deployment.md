# Deployment and configuration

## Standalone

```sh
pnpm install --frozen-lockfile
pnpm build          # builds missing pinned releases with Docker and bundles the Worker
pnpm dev:standalone  # optional local preview
pnpm deploy         # deploy from this machine
```

Builds require Node 22+, pnpm and a running Docker engine. Releases are deployed with the Worker as static assets; see [releases](releases.md). Build products and local data are ignored by Git. The Workers Paid plan is required; the free plan's CPU allowance is unsuitable.

Deploying with a newer `DEFAULT_RELEASE` upgrades the instance: standalone runs upstream migrations before activating the new release. Downgrades are rejected.

## Hosted deployment

- `workers/snipe-it/backplane/wrangler.jsonc`: tenant routing, state, management RPC and Dynamic Worker Loader.
- `workers/snipe-it/control-panel/wrangler.jsonc`: SvelteKit with native remote functions and a named Worker service binding.
- `wrangler.jsonc`: the independent standalone deployment.

The panel uses `Service<BackplaneControl>`; there is no public provisioning or database-management HTTP API. Tenant requests go directly to the backplane. The panel lists tenants, edits their databases, changes URLs and policy settings, and selects version upgrades.

For development, prepare artifacts with `pnpm build`, copy `workers/snipe-it/control-panel/.dev.vars.example` to `workers/snipe-it/control-panel/.dev.vars`, then run these in separate terminals:

```sh
pnpm --dir workers/snipe-it/backplane dev
pnpm --dir workers/snipe-it/control-panel dev
```

The panel uses Vite on port 5173; tenant requests use Wrangler on port 8793. The local panel override selects the tenant listener. New tenant URLs default to subdomains of the panel's incoming origin; optional `TENANT_BASE_URL` changes that default. Each tenant stores its own canonical URL, editable from the panel. DNS, certificates and the wildcard route that reaches the backplane are configured manually in Cloudflare.

## Wrangler environments

The hosted backplane and panel use only named environments: `development` and `production`. Standalone has one default configuration. Wrangler creates separate Workers with an environment suffix. Variables, assets, Durable Object, KV, Loader and service bindings are declared inside each hosted `env` block; each environment uses its own KV namespace and Durable Object namespace. The panel's production binding targets `snipe-it-backplane-production#BackplaneControl`, and development targets `snipe-it-backplane-development#BackplaneControl`. See [Cloudflare's environment rules](https://developers.cloudflare.com/workers/wrangler/environments/).

For hosted production, create the directory once with `pnpm exec wrangler kv namespace create snipe-it-directory-production`, then put the returned `id` in the production `kv_namespaces` entry. Repeat with a distinct namespace for any other deployed environment. Local development accepts the placeholder id.

KV is eventually consistent: the backplane reads its own writes at once, but other locations may take up to a minute to route a new or renamed hostname or to show a new workspace in the panel's list. Workspace details come from the tenant itself and are always current. If two workspaces are created for the same URL at the same moment from different locations, the second one to publish fails with a conflict and keeps its initialized state; recreate it under a different URL.

Build once, then deploy the matching pair:

```sh
pnpm build
pnpm exec wrangler deploy --config workers/snipe-it/backplane/wrangler.jsonc --env production
pnpm exec wrangler deploy --config workers/snipe-it/control-panel/wrangler.jsonc --env production
```

Migrations, compatibility flags, observability and CPU limits are shared inheritable settings. Assets are bound explicitly per environment. The panel build selects `production` unless `CLOUDFLARE_ENV` is set. For standalone: `pnpm build`, then `pnpm deploy`. Hosted deployments must select an environment with `--env` or `CLOUDFLARE_ENV`; the hosted top level has no application bindings. To add another environment, copy its non-inherited bindings and suffix both the service target and namespace id. Configure distinct routes or custom domains for each environment in its `env` block.

Both local `pnpm dev` commands default to `development`. Set `CLOUDFLARE_ENV` to select another environment. The SvelteKit adapter passes the selected environment to Wrangler's platform proxy. Secrets use `wrangler secret put MAIL_PASSWORD --env production` with the relevant config. Environment-specific `.dev.vars.<environment>` files are ignored; they replace the generic `.dev.vars` file when present.

`pnpm dry-run` validates the built artifacts for standalone plus every environment declared in each `wrangler.jsonc` without deploying. CI runs the same checks. Update `workers/snipe-it/backplane/tests/environments.test.ts` when adding an environment.

## Configuration and limits

Wrangler settings use native objects, not encoded JSON strings:

```json
{
	"SNIPEIT_ENV": { "APP_TIMEZONE": "America/Chicago", "SESSION_LIFETIME": "120" },
	"RUNTIME_LIMITS": { "httpCpuMs": 60000, "backgroundCpuMs": 60000, "subRequests": 10000 },
	"TENANT_DEFAULTS": { "maxDatabaseMiB": 256, "maxStorageMiB": 1024, "maxRequestMiB": 16 }
}
```

Ordinary string vars and secrets such as `MAIL_PASSWORD` pass through to Snipe-IT too. Precedence is built-in defaults, `SNIPEIT_ENV`, individual Worker vars/secrets, then tenant overrides. `configureTenant(slug, environment)` replaces tenant overrides through the service binding. Values are validated with Valibot. Environment changes and URL changes select a fresh hosted runtime identity.

`APP_KEY`, `APP_URL`, `DB_CONNECTION`, `DB_DATABASE`, `CACHE_DRIVER` and `SESSION_DRIVER` are managed by the adapter. All other values are strings as expected by Laravel. Hosted runtimes have outbound networking enabled; PHP sockets are not bridged to Workers TCP, so SMTP delivery is unavailable.

Parent CPU ceilings belong in Wrangler's `limits`. Hosted child limits are applied through Dynamic Workers' native `getEntrypoint(..., { limits })`; they cannot raise the parent's or account's limits. Standalone uses the ordinary Worker limits and has no child-limit setting.

Tenant policies include database and total storage allowances, request size, suspension, scheduled-job enablement and inactivity pause days. Database and files use 64 KiB immutable blocks with a bounded 4 MiB page cache; the 8 MiB cap applies to the file index, not file contents. Uploads use PHP's native multipart parser and the application's validation. The buffered HTTP request ceiling defaults to 16 MiB and is configurable up to 32 MiB; it is separate from the storage allowance.

Instance blocks, manifests, sessions and keys live in Durable Object storage. Unreferenced blocks are collected locally. There is no platform backup service or object-storage binding. Cloudflare storage limits apply.

## Verification

```sh
pnpm verify
```

That runs, in order: checks, unit tests, the Laravel fixture build and contract tests, `pnpm build`, the Snipe-IT and panel integration suites, and a dry-run deploy of every configuration.

`pnpm benchmark` prints per-request latency and retained memory for the plain Laravel fixture and for Snipe-IT, and a page-load waterfall. Set `BENCHMARK_REQUESTS`, `BENCHMARK_PATHS` (comma-separated), `BENCHMARK_RELEASE` or `BENCHMARK_URL` to vary a run.

Integration tests exercise PHP WASM, Durable Objects, KV, upstream setup, login, inventory, concurrent checkouts, tenant isolation, database editing, URL changes, uploads, restart persistence, every upstream migration and upgrades between the pinned releases. The panel tests invoke SvelteKit's generated remote endpoints through the real service binding. Wrangler configuration tests resolve all environment names and bindings using Wrangler itself.
