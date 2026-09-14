#!/usr/bin/env bash
# Generate shared runtime types and per-Worker binding types from the Wrangler configs.
source "$(dirname "$0")/lib.sh"
env="${CLOUDFLARE_ENV:-production}"
configs=("$ROOT"/workers/*/*/wrangler.jsonc)
"$WRANGLER" types --env "$env" --strict-vars=false --config "${configs[0]}" "$ROOT/worker-runtime.d.ts" --include-env=false
for config in "${configs[@]}"; do
	"$WRANGLER" types --env "$env" --strict-vars=false --config "$config" "$(dirname "$config")/worker-configuration.d.ts" --include-runtime=false
done
