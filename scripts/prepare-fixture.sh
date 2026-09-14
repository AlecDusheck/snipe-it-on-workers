#!/usr/bin/env bash
# Build the plain Laravel release the runtime's contract tests run against. Needs Docker.
source "$(dirname "$0")/lib.sh"
fixture="$ROOT/packages/laravel-runtime/tests/fixtures"
output="$ROOT/.build/runtime-tests"
checkout="$output/laravel"
mkdir -p "$output"; rm -rf "$checkout"; cp -R "$fixture/laravel" "$checkout"
php_run "$checkout" composer install --no-dev --prefer-dist --no-scripts --no-interaction --quiet
"$ROOT/scripts/prepare-runtime.sh" "$fixture/php.json" "$output/php"
"$TSX" "$ROOT/packages/release-tools/src/build-release.ts" --fixture \
	--pin "$fixture/php.json" --checkout "$checkout" --runtime "$output/php" --releases "$output"
