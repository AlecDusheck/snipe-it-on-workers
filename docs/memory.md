# Memory and execution

Standalone is one deployed Worker: its HTTP handler and Durable Object share an isolate and its memory budget. Hosted mode runs PHP behind the Dynamic Worker boundary. Cloudflare enforces a [128 MB per-isolate limit](https://developers.cloudflare.com/workers/platform/limits/#memory) covering JavaScript and WebAssembly; local workerd does not enforce it, so a passing local benchmark is not proof that a deployment fits.

## Runtime budgets

| Component                      | Budget                                                        |
| ------------------------------ | ------------------------------------------------------------- |
| WASM initial memory            | 20 MiB; the linear heap never shrinks                         |
| OPcache shared segment         | 32 MiB, 4 MiB interned strings, `max_accelerated_files=10000` |
| OPcache file cache             | Paged Durable Object files under `/php-opcache/<identity>`    |
| Archive parts during a request | 2 × 1 MiB; none retained between requests                     |
| Inflated application files     | 1 MiB LRU                                                     |
| Page cache (dirty + verified)  | 4 MiB                                                         |
| Instance source cache          | 16 MiB in Durable Object SQLite, fetched per file             |
| Staged write batch             | 256 KiB or 64 entries, then one transaction and `sync()`      |
| File index                     | One binary buffer with sorted offset tables                   |

Bytecode lives in an independent `bytecode` manifest keyed by release identity, loaded once per interpreter and saved only when changed. Application data and sessions publish atomically; bytecode commits independently. Filesystem nodes are reused across requests when the incoming manifests match the previous snapshot; otherwise the trees are remounted. Temporary files are cleared on every request. Snapshot commits compare manifest chunks and block references and write only differences.

Durable Object SQLite schedules commits on the next event-loop turn; the storage layer awaits `storage.sync()` after each write batch so no native write is left pending while the interpreter runs.

## Measurement

`pnpm benchmark` runs plain Laravel and Snipe-IT through workerd, including fresh migrations, and reports per request: WASM linear memory, allocator break, Zend peak, OPcache usage, archive buffers, inflated sources, page buffers, binary index and manifests. Tracked buffers are a lower bound: they exclude the V8 heap, compilation metadata and transient garbage. The benchmark driver keeps its storage in-memory in the isolate and is not a production storage layout.

Hosted invocations default to 60 s CPU and 10,000 subrequests via `RUNTIME_LIMITS`; custom Dynamic Worker limits can only lower the parent's allowance. [Cloudflare custom limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/).
