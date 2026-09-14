# Shared by every script: repo root, pinned tool paths, and the Docker image for native PHP steps.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSX="$ROOT/node_modules/.bin/tsx"
WRANGLER="$ROOT/node_modules/.bin/wrangler"
PHP_IMAGE="laravel-cloudflare/php:8.4"

# json_field <file.json> <expression over the parsed object c>
json_field() { node -p "const c=require(require('path').resolve('$1')); c.$2"; }
# jsonc_field <file.jsonc> <expression over the parsed object c>: strips line comments and trailing commas.
jsonc_field() {
	node -p "const s=require('fs').readFileSync('$1','utf8').replace(/^\\s*\\/\\/.*$/gm,'').replace(/,(\\s*[}\\]])/g,'\$1'); const c=JSON.parse(s); $2"
}

# Native PHP and Composer only ever run inside this container.
php_image() {
	docker image inspect "$PHP_IMAGE" >/dev/null 2>&1 || docker build -q -t "$PHP_IMAGE" "$ROOT/docker" >/dev/null
}
# php_run <dir> <command...>: <dir> is mounted at /app, the runtime path, so cached paths stay valid.
php_run() {
	local directory="$1"; shift
	php_image
	docker run --rm -v "$directory:/app" -w /app -u "$(id -u):$(id -g)" -e COMPOSER_HOME=/tmp/composer "$PHP_IMAGE" "$@"
}
