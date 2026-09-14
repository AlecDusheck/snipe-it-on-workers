#!/usr/bin/env bash
# Clone the pinned application, run Composer and build Laravel's package, event and view caches in Docker.
# Config and route caches are per-instance and are not built.
#   scripts/prepare-upstream.sh <pin.json> <checkout dir>
source "$(dirname "$0")/lib.sh"
pin="$1"; mkdir -p "$2"; checkout="$(cd "$2" && pwd)"
repository="$(json_field "$pin" application.repository)"
commit="$(json_field "$pin" application.commit)"
if [ ! -d "$checkout/.git" ]; then
	git clone --quiet --filter=blob:none --no-checkout "$repository" "$checkout"
elif [ -n "$(git -C "$checkout" status --porcelain --untracked-files=no)" ]; then
	echo "Prepared checkout has local changes; refusing to replace them" >&2; exit 1
fi
git -C "$checkout" fetch --quiet --depth=1 origin "$commit"
git -C "$checkout" checkout --quiet --detach "$commit"
php_run "$checkout" composer install --no-dev --prefer-dist --no-scripts --no-interaction --quiet
php_run "$checkout" composer dump-autoload --no-dev --optimize --no-scripts --quiet
for command in package:discover event:cache view:cache; do
	php_run "$checkout" php artisan "$command" --quiet
done
