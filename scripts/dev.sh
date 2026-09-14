#!/usr/bin/env bash
source "$(dirname "$0")/lib.sh"
cd "$ROOT"
export CLOUDFLARE_ENV="${CLOUDFLARE_ENV:-development}"
backplane() {
	exec "$WRANGLER" dev --config "$ROOT/workers/snipe-it/backplane/wrangler.jsonc" --env "$CLOUDFLARE_ENV" --persist-to "$ROOT/.wrangler/state" --ip 127.0.0.1 --port 8793 --inspector-port 9241
}
panel() {
	cd "$ROOT/workers/snipe-it/control-panel"
	exec "$ROOT/node_modules/.bin/vite" dev --host 127.0.0.1
}
case "${1:-both}" in
	standalone) exec "$WRANGLER" dev --persist-to "$ROOT/.wrangler/state" --ip 127.0.0.1 --port 8795 --inspector-port 9243 ;;
	backplane) backplane ;;
	panel) panel ;;
	both)
		backplane &
		panel &
		trap 'kill $(jobs -p) 2>/dev/null' EXIT INT TERM
		wait ;;
	*) echo "Usage: scripts/dev.sh [standalone|backplane|panel]" >&2; exit 1 ;;
esac
