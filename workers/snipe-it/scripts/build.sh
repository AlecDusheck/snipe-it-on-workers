#!/usr/bin/env bash
# Build every pinned Snipe-IT release (reusing prepared checkouts), the standalone Worker and the control panel.
source "$(dirname "$0")/lib.sh"
for pin in "$PINS"/*.json; do
	version="$(basename "$pin" .json)"
	checkout="$BUILD/upstream/$(pin_field "$version" name)"
	[ -f "$checkout/vendor/autoload.php" ] || "$ROOT/scripts/prepare-upstream.sh" "$pin" "$checkout"
	build_release "$version"
done
# The standalone Worker bundles the PHP runtime of the release it runs.
default="$(jsonc_field "$ROOT/wrangler.jsonc" c.vars.DEFAULT_RELEASE)"
pin="$(grep -l "\"name\": \"$default\"" "$PINS"/*.json)"
runtime="$BUILD/runtime/$(json_field "$pin" php.version)"
"$TSX" "$ROOT/packages/release-tools/src/build-standalone.ts" \
	--entry "$ROOT/workers/snipe-it/backplane/src/standalone.ts" --runtime "$runtime" --output "$BUILD/standalone"
(cd "$ROOT/workers/snipe-it/control-panel" && CLOUDFLARE_ENV="${CLOUDFLARE_ENV:-production}" "$ROOT/node_modules/.bin/vite" build)
