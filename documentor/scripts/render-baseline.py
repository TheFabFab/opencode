#!/usr/bin/env python3
"""Renders a drizzle-kit migration.sql into packages/core/src/database/schema.gen.ts.

Usage: render-baseline.py <migration.sql> <schema.gen.ts>
The output format is the one packages/core/script/migration.ts writes.
"""
import sys

sql_path, out_path = sys.argv[1], sys.argv[2]
with open(sql_path) as file:
    statements = [part.strip() for part in file.read().split("--> statement-breakpoint") if part.strip()]


def escape(line: str) -> str:
    return line.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")


def render(statement: str) -> str:
    lines = statement.replace("\t", "  ").split("\n")
    if len(lines) == 1:
        return f"      yield* tx.run(`{escape(lines[0])}`)"
    body = "\n".join("        " + escape(line) for line in lines)
    return f"      yield* tx.run(`\n{body}\n      `)"


with open(out_path, "w") as file:
    file.write(
        'import { Effect } from "effect"\n'
        'import type { DatabaseMigration } from "./migration"\n\n'
        "export default {\n  up(tx) {\n    return Effect.gen(function* () {\n"
        + "\n".join(render(statement) for statement in statements)
        + '\n    })\n  },\n} satisfies Omit<DatabaseMigration.Migration, "id">\n'
    )
print(f"wrote {out_path} with {len(statements)} statements")
