#!/usr/bin/env python3
"""Rewrites opencode's SQLite table files as Postgres table files, in place.

Run from the repository root. It is idempotent on already-converted files.
Column rules (documentor/specs/2026-10-06-postgres-core-design.md, section 2):
  time_* and token_expiry integer columns -> doublePrecision()
  other integer() columns                  -> count()
  integer({ mode: "boolean" })             -> boolean()
  text({ mode: "json" })                   -> jsonb()
  text()                                   -> text()
  real()                                   -> doublePrecision()
count, jsonb and text come from @opencode-ai/effect-drizzle-pg: count rounds and
refuses non-finite numbers, and jsonb and text store NUL as U+FFFD.
"""
import re
import sys

FILES = [
    "packages/core/src/account/sql.ts",
    "packages/core/src/control-plane/workspace.sql.ts",
    "packages/core/src/credential/sql.ts",
    "packages/core/src/data-migration.sql.ts",
    "packages/core/src/event/sql.ts",
    "packages/core/src/permission/sql.ts",
    "packages/core/src/project/sql.ts",
    "packages/core/src/session/sql.ts",
    "packages/core/src/share/sql.ts",
    "packages/core/src/database/schema.sql.ts",
    "packages/core/src/database/path.ts",
]
RENAMED = {"sqliteTable": "pgTable", "integer": None, "real": None, "text": None}
BUILDERS = ["doublePrecision", "boolean"]
OWN = ["count", "jsonb", "text"]
OWN_IMPORT = re.compile(r'import \{[^}]*\} from "@opencode-ai/effect-drizzle-pg"\n')


def convert(source: str) -> str:
    source = source.replace('text({ mode: "json" })', "jsonb()")
    source = source.replace('integer({ mode: "boolean" })', "boolean()")
    source = re.sub(r"\b(time_\w+|token_expiry): integer\(\)", r"\1: doublePrecision()", source)
    source = re.sub(r"\binteger\(\)", "count()", source)
    source = re.sub(r"\breal\(\)", "doublePrecision()", source)
    source = source.replace("sqliteTable(", "pgTable(")

    def imports(match: re.Match) -> str:
        names = []
        for name in (part.strip() for part in match.group(1).split(",")):
            name = RENAMED.get(name, name)
            if name and name not in names:
                names.append(name)
        for builder in BUILDERS:
            if re.search(rf"\b{builder}\(", source) and builder not in names:
                names.append(builder)
        return "import { " + ", ".join(names) + ' } from "drizzle-orm/pg-core"'

    source = re.sub(r'import \{([^}]*)\} from "drizzle-orm/(?:sqlite|pg)-core"', imports, source)
    used = [name for name in OWN if re.search(rf"\b{name}\(", source)]
    source = OWN_IMPORT.sub("", source)
    if used:
        own = "import { " + ", ".join(used) + ' } from "@opencode-ai/effect-drizzle-pg"\n'
        source = re.sub(r'(import \{[^}]*\} from "drizzle-orm/pg-core"\n)', r"\1" + own, source, count=1)
    return source


for path in FILES:
    with open(path) as file:
        before = file.read()
    after = convert(before)
    if "sqlite" in after:
        sys.exit(f"{path}: still mentions sqlite after conversion")
    with open(path, "w") as file:
        file.write(after)
    print(("converted " if after != before else "unchanged ") + path)
