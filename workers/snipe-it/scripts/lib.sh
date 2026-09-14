source "$(dirname "${BASH_SOURCE[0]}")/../../../scripts/lib.sh"
BUILD="$ROOT/.build/snipe-it"
ASSETS="$BUILD/assets"
PINS="$ROOT/workers/snipe-it/releases"
pin_field() { json_field "$PINS/$1.json" "$2"; }
# build_release <version>: prepares the pinned runtime and lays out the release from an existing checkout.
build_release() {
	local pin="$PINS/$1.json"
	local runtime="$BUILD/runtime/$(pin_field "$1" php.version)"
	"$ROOT/scripts/prepare-runtime.sh" "$pin" "$runtime"
	"$TSX" "$ROOT/packages/release-tools/src/build-release.ts" \
		--pin "$pin" --checkout "$BUILD/upstream/$(pin_field "$1" name)" --runtime "$runtime" --releases "$ASSETS" \
		--entry "$ROOT/workers/snipe-it/backplane/src/runtime.ts"
}
