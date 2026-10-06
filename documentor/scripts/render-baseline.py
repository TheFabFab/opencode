#!/usr/bin/env python3
"""Renders a drizzle-kit migration.sql into packages/core/src/database/schema.gen.ts.

Usage: render-baseline.py <migration.sql> <schema.gen.ts>
The whole baseline is one `tx.run`, so creating a schema costs one round trip.
"""
import sys

sql_path, out_path = sys.argv[1], sys.argv[2]
with open(sql_path) as file:
    statements = [part.strip() for part in file.read().split("--> statement-breakpoint") if part.strip()]


def escape(line: str) -> str:
    return line.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")


def indent(statement: str) -> str:
    return "\n".join("        " + escape(line) for line in statement.replace("\t", "  ").split("\n"))


for statement in statements:
    if not statement.endswith(";"):
        sys.exit(f"statement does not end with a semicolon: {statement[:60]}")

with open(out_path, "w") as file:
    file.write(
        'import { Effect } from "effect"\n'
        'import type { DatabaseMigration } from "./migration"\n\n'
        "export default {\n  up(tx) {\n    return Effect.gen(function* () {\n"
        # One round trip: Postgres runs a parameterless multi-statement string as a unit.
        + "      yield* tx.run(`\n"
        + "\n".join(indent(statement) for statement in statements)
        + "\n      `)"
        + '\n    })\n  },\n} satisfies Omit<DatabaseMigration.Migration, "id">\n'
    )
print(f"wrote {out_path} with {len(statements)} statements")
