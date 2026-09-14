#!/usr/bin/env bash
# Validate every deployment and Wrangler environment without deploying.
source "$(dirname "$0")/lib.sh"
for config in "$ROOT/wrangler.jsonc" "$ROOT"/workers/*/*/wrangler.jsonc; do
	for env in $(jsonc_field "$config" "Object.keys(c.env ?? {}).join(' ') || '-'"); do
		[ "$env" = "-" ] && env=""
		echo "Validating ${config#$ROOT/}: ${env:-default}"
		"$WRANGLER" deploy --config "$config" --env "$env" --dry-run
	done
done
