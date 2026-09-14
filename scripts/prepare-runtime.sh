#!/usr/bin/env bash
# Verify the pinned Playground PHP runtime and apply the project's patches. No PHP is compiled.
#   scripts/prepare-runtime.sh <pin.json> <output dir>
source "$(dirname "$0")/lib.sh"
"$TSX" "$ROOT/packages/release-tools/src/prepare-runtime.ts" --pin "$1" --output "$2"
