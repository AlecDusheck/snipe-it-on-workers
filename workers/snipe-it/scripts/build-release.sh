#!/usr/bin/env bash
# Build one Snipe-IT release into .build/snipe-it/assets/releases/<name>, refreshing its upstream checkout. Needs Docker.
#   workers/snipe-it/scripts/build-release.sh <version>
source "$(dirname "$0")/lib.sh"
version="${1:?usage: $0 <version>}"
"$ROOT/scripts/prepare-upstream.sh" "$PINS/$version.json" "$BUILD/upstream/$(pin_field "$version" name)"
build_release "$version"
