#!/usr/bin/env bash
# Proves a compiled opencode binary serves from Postgres as a scope role and
# never touches SQLite. Needs OPENCODE_TEST_DATABASE_URL (a superuser).
set -euo pipefail

binary="$(realpath "$1")"
admin="${OPENCODE_TEST_DATABASE_URL:?set OPENCODE_TEST_DATABASE_URL}"
scope="smoke_$(date +%s)_$$"
home="$(mktemp -d)"
port=47190
server=""
trap '[ -z "$server" ] || kill "$server" 2>/dev/null || true; rm -rf "$home"' EXIT

mkdir "$home/proj" && git -C "$home/proj" init -q
export HOME="$home" XDG_DATA_HOME="$home/data" XDG_CONFIG_HOME="$home/config" \
  XDG_CACHE_HOME="$home/cache" XDG_STATE_HOME="$home/state" \
  OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1

# As the administrator: create the scope, then its tables.
OPENCODE_DATABASE_URL="$admin" OPENCODE_DATABASE_ROLE_PASSWORD=smoke-only \
  "$binary" db provision --schema "$scope" --role "$scope"
OPENCODE_DATABASE_URL="$admin" OPENCODE_DATABASE_SCHEMA="$scope" "$binary" db migrate

# As the scope role: serve.
role_url="$(node -e 'const u=new URL(process.argv[1]);u.username=process.argv[2];u.password="smoke-only";console.log(u.toString())' "$admin" "$scope")"
OPENCODE_DATABASE_URL="$role_url" OPENCODE_DATABASE_SCHEMA="$scope" \
  "$binary" serve --port "$port" --hostname 127.0.0.1 >"$home/serve.log" 2>&1 &
server=$!

# Each probe has its own timeout: a request that arrives in the instant the
# server starts listening can be accepted and never answered.
ready=""
for _ in $(seq 1 100); do
  if [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/session?directory=$home/proj")" = 200 ]; then
    ready=1
    break
  fi
  kill -0 "$server" 2>/dev/null || { cat "$home/serve.log" >&2; echo "server exited" >&2; exit 1; }
  sleep 0.2
done
[ -n "$ready" ] || { cat "$home/serve.log" >&2; echo "server never answered" >&2; exit 1; }

created="$(curl -fsS -m 20 -X POST "http://127.0.0.1:$port/session?directory=$home/proj" \
  -H 'content-type: application/json' -d '{"title":"12345"}')"
listed="$(curl -fsS -m 20 "http://127.0.0.1:$port/session?directory=$home/proj")"
node -e '
  const created = JSON.parse(process.argv[1]), listed = JSON.parse(process.argv[2])
  const found = listed.find((item) => item.id === created.id)
  if (!found || found.title !== "12345") { console.error("session did not round-trip", listed); process.exit(1) }
' "$created" "$listed"

# A prompt for a session that does not exist is refused, with its body unread.
missing="ses_ffffffffffffmissing0000000000"
refused="$(curl -sS -m 20 -o "$home/refused.json" -w '%{http_code}' -X POST \
  "http://127.0.0.1:$port/api/session/$missing/prompt" \
  -H "x-opencode-directory: $home/proj" -H 'content-type: application/json' \
  -d '{"prompt":{"text":"hello"}}')"
[ "$refused" = 404 ] || { echo "prompt to a missing session returned $refused, expected 404" >&2; exit 1; }
node -e '
  const body = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
  if (body._tag !== "SessionNotFoundError" || body.sessionID !== process.argv[2]) {
    console.error("unexpected refusal body", body); process.exit(1)
  }
' "$home/refused.json" "$missing"

# The same refusal with a 6 MB body the route never reads: the server must
# answer, not wait for the body to be consumed.
node -e 'process.stdout.write(JSON.stringify({ prompt: { text: "x".repeat(6 * 1024 * 1024) } }))' > "$home/big.json"
big="$(curl -sS -m 30 -o /dev/null -w '%{http_code}' -X POST \
  "http://127.0.0.1:$port/api/session/$missing/prompt" \
  -H "x-opencode-directory: $home/proj" -H 'content-type: application/json' \
  --data-binary "@$home/big.json")"
[ "$big" = 404 ] || { echo "prompt with a 6 MB body to a missing session returned $big, expected 404" >&2; exit 1; }

stray="$(find "$home" -name '*.db' -o -name '*.db-wal' -o -name '*.sqlite')"
[ -z "$stray" ] || { echo "SQLite file created: $stray" >&2; exit 1; }

rows="$(OPENCODE_DATABASE_URL="$admin" OPENCODE_DATABASE_SCHEMA="$scope" \
  "$binary" db "select count(*) as n from \"$scope\".session" --format json)"
node -e 'if (JSON.parse(process.argv[1])[0].n != 1) { console.error("expected one session row"); process.exit(1) }' "$rows"

OPENCODE_DATABASE_URL="$admin" "$binary" db "drop schema \"$scope\" cascade" >/dev/null
OPENCODE_DATABASE_URL="$admin" "$binary" db "drop role \"$scope\"" >/dev/null
echo "binary smoke passed for $scope"
