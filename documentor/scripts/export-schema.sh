#!/usr/bin/env bash
# Writes the schema files DocuMentor applies when it provisions a scope:
# the baseline, the ids it covers, and the Postgres ports of later migrations.
# Usage: export-schema.sh <output directory>
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$1/ported"
out="$(cd "$1" && pwd)"
script="$(mktemp "$root/packages/core/.export-schema-XXXXXX.ts")"
trap 'rm -f "$script"' EXIT
cat > "$script" <<TS
import { Effect } from "effect"
import { writeFileSync } from "node:fs"
import { DatabaseMigration } from "$root/packages/core/src/database/migration"
import schema from "$root/packages/core/src/database/schema.gen"
import pkg from "$root/packages/opencode/package.json"

const out = process.argv[2]
const statements: string[] = []
// schema.up issues its SQL through tx.run; record the text instead of executing it.
const recorder = { run: (text: string) => Effect.sync(() => void statements.push(text)) }
await Effect.runPromise(schema.up(recorder as any))
writeFileSync(\`\${out}/baseline.sql\`, statements.join("\n").trim() + "\n")
writeFileSync(\`\${out}/baseline-ids.json\`, JSON.stringify([...DatabaseMigration.BASELINE_IDS].sort(), null, 2) + "\n")
writeFileSync(
  \`\${out}/manifest.json\`,
  JSON.stringify({ version: pkg.version, migrationIds: [...DatabaseMigration.registry.ids].sort() }, null, 2) + "\n",
)
for (const id of Object.keys(DatabaseMigration.ported))
  writeFileSync(\`\${out}/ported/\${id}.sql\`, "-- see packages/core/src/database/migration.ts ported[" + JSON.stringify(id) + "]\n")
TS
cd "$root/packages/core"
bun run "$script" "$out"
