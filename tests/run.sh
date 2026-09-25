#!/usr/bin/env bash
# Runs the whole suite against a throwaway static server on :8080.
# Needs: node >= 18, python3, playwright (npm i -D playwright && npx playwright install chromium).
set -u
cd "$(dirname "$0")/.."
# global installs (e.g. the claude.ai container) keep playwright/eslint under this path
export NODE_PATH="${NODE_PATH:-/opt/node22/lib/node_modules}"
python3 -m http.server 8080 --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT
sleep 1
status=0
for f in tests/demo.test.mjs tests/mock.test.mjs tests/probe3.test.mjs; do
  echo; echo "##### $f"
  node "$f" || status=1
done
if command -v eslint >/dev/null 2>&1 || [ -x node_modules/.bin/eslint ]; then
  echo; echo "##### eslint"
  ( [ -x node_modules/.bin/eslint ] && node_modules/.bin/eslint --no-config-lookup --config tests/eslint.config.mjs js/*.js ) \
    || eslint --no-config-lookup --config tests/eslint.config.mjs js/*.js || true
fi
exit $status
