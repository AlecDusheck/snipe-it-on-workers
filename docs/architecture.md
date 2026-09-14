# Architecture

Standalone runs PHP directly inside its tenant Durable Object's Worker. Hosted mode runs the same executor in a Dynamic Worker selected by tenant, release, canonical URL and effective environment. Both modes are adapters exported by `cloudflare-platform` (`standaloneRuntime`, `dynamicRuntime`); an application worker passes one of them plus its profile to the shared tenant coordinator.

The SvelteKit panel uses remote `query` and `form` functions, Valibot Standard Schema validation and `getRequestEvent().platform.env.BACKPLANE`. The named `BackplaneControl` service exposes management RPC. There is no public control HTTP endpoint. Tenant traffic bypasses the panel. [SvelteKit remote functions](https://svelte.dev/docs/kit/remote-functions), [Cloudflare service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/).

## Request path

A hosted request resolves its origin through the KV directory, selects the tenant Durable Object, and rechecks the canonical URL. Release assets are served from the deployed release by the front Worker; public uploads stream from the committed file manifest under a download lease. Everything else enters the tenant's serial queue: GET requests may write application data, so reads are not dispatched to concurrent replicas. Concurrency within an instance is bounded by PHP execution time; separate tenants have separate coordinators and runtimes.

## Tenant directory

A tenant's slug identifies a stable Durable Object. Workers KV stores the hosted directory as two key families: `origin:<origin>` maps a hostname to its slug and `tenant:<slug>` holds the published descriptor, duplicated in key metadata so listing needs no per-key reads. Provisioning reserves the origin key before initializing PHP, then publishes the tenant key with its name and creation time. Routing and listing ignore reserved-but-unpublished tenants. KV has no transactions: each slug's writes are serialized by its Durable Object; two slugs racing for one hostname are checked, not locked; other locations may see a new hostname up to a minute late. The Durable Object also checks the canonical origin before executing PHP. Changing a hostname does not provision DNS or certificates. Standalone requires no KV binding.

## State

The coordinator serializes PHP execution, management writes and upgrades. Native PHP PDO SQLite uses its own transactions and DELETE journal; there is no SQL translation or custom WAL. Database and uploaded files share a manifest of immutable 64 KiB blocks in the instance's Durable Object SQLite. A request stages changed blocks, then one local transaction publishes the manifest, release, revision and block references. Errors leave the previous state authoritative. There is no R2 binding, replication tier or platform backup service.

Laravel file sessions and cache use a separate persistent tree in the same object. Both trees commit together, but session-only changes do not advance the application revision. Local alarms reclaim unreferenced blocks after a one-hour staging grace period. Download leases protect blocks while streaming and expire after a day if the reader disappears; alarms stop when no cleanup remains.

## PHP runtime

The PHP engine comes from pinned WordPress Playground packages. Runtime preparation applies verified patches without rebuilding PHP: the loader import is renamed, read/write syscalls await the paged filesystem, the heap grows only as far as requested, the module's initial memory is 20 MiB, and pooled Zend MM chunk handlers are appended to the module. OPcache uses a bounded shared segment and a durable, demand-generated file cache with timestamp validation. A release upgrade boots a new interpreter. Native Emscripten read/write operations retain permissions, append handling and offsets; the adapter loads pages and divides large operations into bounded chunks. PHP parses multipart requests into `$_POST`, `$_COOKIE` and `$_FILES`. The application keeps responsibility for upload authorization, validation, MIME detection, image processing and SVG sanitization.

The application corpus is mounted lazily. Only its compact binary file index stays resident: filesystem nodes appear on first lookup, contents load through the async read hook into a bounded cache, and after the first request the archive parts are released so later misses read the 1 MiB part they live in. Releases are static assets deployed with the Worker; see [releases](releases.md).

Public uploads stream from the committed manifest. Private downloads stay behind the Laravel kernel. Symfony streamed/download responses run their existing callbacks; a PHP output handler spools chunks through the paged filesystem. PHP shutdown closes PDO, the coordinator commits state, and only then does the response stream from immutable blocks. First byte is sent after commit. Response spools and aborted writes are reclaimed by the instance collector.

Releases contain the pinned PHP runtime, the application archive, public assets and provenance. Hosted tenants retain independent versions; standalone follows `DEFAULT_RELEASE`. Upgrades run upstream migrations in the target runtime and publish the migrated state and release name together. Failure preserves the original state. Keep every release a hosted tenant still runs in the deployment.

The Snipe-IT compatibility overlay replaces its self-HTTP `.env` exposure check: the front Worker rejects dotfile paths and a self-request would deadlock behind tenant serialization. Other setup steps run upstream code. Bootstrap does not create an administrator or site settings.

Worker bindings, JSON vars and service names are ordinary Wrangler configuration, including environment suffixes. Child CPU/subrequest ceilings use the native [Dynamic Worker limits API](https://developers.cloudflare.com/dynamic-workers/usage/limits/). Local workerd does not enforce the [Worker memory limit](https://developers.cloudflare.com/workers/platform/limits/); the benchmark suite reports retained memory explicitly. See [memory](memory.md).

Hosted Dynamic Workers inherit outbound HTTP/TCP access from their parent by omitting `globalOutbound`. PHP sockets are not bridged to Workers TCP, so SMTP delivery through `MAIL_*` does not work. [Cloudflare egress semantics](https://developers.cloudflare.com/dynamic-workers/api-reference/).

The runtime is from [WordPress Playground](https://github.com/WordPress/wordpress-playground). Preserve upstream Snipe-IT's AGPL source obligations and all bundled third-party notices.

## Package boundaries and tests

- `laravel-runtime` owns PHP loading, paged files, the Laravel request bridge and its protocol. Its `ApplicationProfile` contract describes compatibility hooks, environment defaults, writable directories and per-instance secret generation.
- `cloudflare-platform` depends on `laravel-runtime` and owns Durable Object coordination and storage, the KV directory, quotas, release selection and management RPC. Its standalone and dynamic execution adapters share one coordinator.
- `release-tools` depends on the runtime's archive format and validation. It prepares PHP, packages upstream checkouts and bundles release/standalone Workers from explicit input paths. It is build-time tooling, never a dependency of deployed Workers.

Application Workers depend on the runtime and platform; neither imports an application or the release tools. Explicit package exports define the public surface, including `/testing` helpers for cross-package integration tests. Lint rejects imports that reverse these dependencies or reach into another package's files. Each package owns its tests. Worker bindings are generated separately from shared platform types.

Snipe-IT lives under `workers/snipe-it`: its Workers, Passport key generation, setup-controller override, release pins, build scripts and application integration tests. The backplane selects the runtime adapter and supplies the application profile; the control panel depends on the platform's management RPC contract and validation schemas. Root build/deploy commands delegate to `workers/snipe-it/scripts`. Builds, downloaded source, runtime binaries and local state are ignored under `.build/` and `.wrangler/`.

To add another Laravel application, add its profile, release pins and entrypoints under `workers/<app>`, then test its setup, persistence and upgrades through the shared runtime. Application compatibility belongs there; changes to the generic Laravel bridge must also pass the independent Laravel contract suite.

| Suite                      | Owner                                                                                    | Purpose                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime unit tests         | `packages/laravel-runtime/tests`                                                         | Paging, binary formats, environment policy and runtime validation                                                                              |
| Release toolchain tests    | `packages/release-tools/tests`                                                           | Checksums and exact application of upstream loader patches                                                                                     |
| Laravel contract tests     | `packages/laravel-runtime/tests/integration`                                             | An independent Laravel application with its own Composer lock; SQLite, sessions, CSRF, files and streamed responses without a Snipe-IT profile |
| Platform tests             | `packages/cloudflare-platform/tests`                                                     | Tenant commits, rollback, quotas, routing and management contracts; storage tests use workerd with KV and Durable Object SQLite                |
| Memory benchmarks          | `packages/laravel-runtime/tests/benchmark`, `workers/snipe-it/backplane/tests/benchmark` | `pnpm benchmark`: repeated requests through the real runtime in workerd, reporting latency and retained memory per request                     |
| Snipe-IT integration tests | `workers/snipe-it/backplane/tests/integration`                                           | Setup, login, assets, concurrent edits, uploads, restarts, migrations and cross-PHP upgrades                                                   |
| Panel integration tests    | `workers/snipe-it/control-panel/tests`                                                   | Generated SvelteKit remote endpoints and real service bindings; SSR and native remote submissions, not browser hydration                       |

Storage formats belong to the shared packages: `LARAVEL-FILES/1` identifies the paged file manifest. It does not embed an application name. Format versions are separate from application release versions; incompatible prefixes are rejected.
