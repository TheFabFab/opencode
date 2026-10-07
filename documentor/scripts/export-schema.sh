#!/usr/bin/env bash
# Writes the schema files DocuMentor applies when it provisions a scope:
# the baseline, the ids it covers, and the Postgres ports of later migrations.
# Usage: export-schema.sh <output directory>
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$1"
out="$(cd "$1" && pwd)"
cd "$root/packages/core"
exec bun run "$root/documentor/scripts/export-schema.ts" "$out"
