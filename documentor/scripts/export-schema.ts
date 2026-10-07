// The path names the Effect that packages/core resolves; the root node_modules holds another version.
import { Effect } from "../../packages/core/node_modules/effect/dist/index.js"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { DatabaseMigration } from "../../packages/core/src/database/migration"
import schema from "../../packages/core/src/database/schema.gen"
import pkg from "../../packages/opencode/package.json"

/**
 * Runs a migration's `up` against a transaction that records instead of
 * executing, and returns its SQL as statements terminated by `;`. A migration
 * that needs a result back (reads a row, branches on it) or issues anything but
 * literal SQL text cannot be reduced to a file, so it throws.
 */
export async function captureSql(up: (tx: any) => any): Promise<string> {
  const statements: string[] = []
  const unsupported = (method: string) => () => {
    throw new Error(`calls tx.${method}, which cannot be recorded as SQL`)
  }
  const recorder = {
    run: (text: unknown) =>
      typeof text === "string"
        ? Effect.sync(() => void statements.push(text))
        : Effect.die(new Error("passes tx.run something other than literal SQL text")),
    all: unsupported("all"),
    get: unsupported("get"),
    values: unsupported("values"),
  }
  await Effect.runPromise(up(recorder))
  return (
    statements
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0)
      .map((statement) => (statement.endsWith(";") ? statement : statement + ";"))
      .join("\n") + "\n"
  )
}

export async function main(out: string) {
  mkdirSync(path.join(out, "ported"), { recursive: true })
  const files: Record<string, string> = {}
  files["baseline.sql"] = await captureSql(schema.up)
  for (const [id, up] of Object.entries(DatabaseMigration.ported)) {
    try {
      files[`ported/${id}.sql`] = await captureSql(up)
    } catch (error) {
      throw new Error(`ported migration ${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  files["baseline-ids.json"] = JSON.stringify([...DatabaseMigration.BASELINE_IDS].sort(), null, 2) + "\n"
  files["manifest.json"] =
    JSON.stringify({ version: pkg.version, migrationIds: [...DatabaseMigration.registry.ids].sort() }, null, 2) + "\n"
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(out, name), content)
}

if (import.meta.main) {
  main(path.resolve(process.argv[2])).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
