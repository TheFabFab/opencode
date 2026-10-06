export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "./database"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"

export type Migration = {
  id: string
  up: (tx: Database.Transaction) => Effect.Effect<void, unknown>
}

export class SchemaNotMigratedError extends Schema.TaggedErrorClass<SchemaNotMigratedError>()(
  "DatabaseSchemaNotMigratedError",
  { message: Schema.String },
) {}

/**
 * The newest upstream migration whose effect the generated baseline
 * (`schema.gen.ts`) already contains. Upstream's migration files are SQLite
 * SQL and never run here; ids up to this one are recorded as applied when the
 * baseline is created.
 */
export const BASELINE = "20260622202450_simplify_session_input"

/**
 * Postgres versions of upstream migrations newer than `BASELINE`, keyed by
 * upstream's migration id. An upstream migration with no entry here fails the
 * migration test, which is how a rebase reports that upstream changed the
 * schema.
 */
export const ported: Record<string, Migration["up"]> = {}

/** What a build expects of a schema: every upstream migration id, and the ports of the newer ones. */
export interface Registry {
  readonly ids: readonly string[]
  readonly ported: Readonly<Record<string, Migration["up"]>>
}

export const registry: Registry = { ids: migrations.map((migration) => migration.id), ported }

/** Upstream migration ids that are neither in the baseline nor ported. */
export function pending(input: Registry = registry) {
  return input.ids.filter((id) => id > BASELINE && !(id in input.ported)).sort()
}

/** Arbitrary constant; with the schema's hash it names the migration lock. */
const LOCK_CLASS = 7472

function tables(db: Database.Client | Database.Transaction) {
  return db.all<{ name: string }>(
    sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()`,
  )
}

/**
 * Brings one schema to what `input` expects: the connection's current schema,
 * or `options.schema`. It holds one advisory lock per schema for its whole
 * transaction, so concurrent callers queue and the later ones find the work
 * done.
 */
export function migrate(db: Database.Client, options: { schema?: string; registry?: Registry } = {}) {
  const input = options.registry ?? registry
  const expected = [...input.ids].sort()
  return db.transaction((tx) =>
    Effect.gen(function* () {
      if (options.schema) yield* tx.run(sql`SELECT set_config('search_path', ${options.schema}, true)`)
      yield* tx.run(sql`SELECT pg_advisory_xact_lock(${LOCK_CLASS}, hashtext(current_schema()))`)
      const existing = (yield* tables(tx)).map((table) => table.name)
      if (existing.length > 0 && !existing.includes("session"))
        return yield* Effect.die("Schema is not empty and has no session table")
      if (existing.length === 0) {
        yield* schema.up(tx)
        yield* tx.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed DOUBLE PRECISION NOT NULL)`)
        for (const id of expected.filter((id) => id <= BASELINE))
          yield* tx.run(sql`INSERT INTO migration (id, time_completed) VALUES (${id}, ${Date.now()})`)
      }
      const completed = new Set((yield* tx.all<{ id: string }>(sql`SELECT id FROM migration`)).map((row) => row.id))
      for (const id of expected) {
        if (completed.has(id)) continue
        const up = input.ported[id]
        if (!up) return yield* Effect.die(`Upstream migration ${id} has no Postgres port`)
        yield* up(tx)
        yield* tx.run(sql`INSERT INTO migration (id, time_completed) VALUES (${id}, ${Date.now()})`)
      }
    }),
  )
}

/** Migrates every schema that already holds opencode's tables. Returns their names. */
export function migrateAll(db: Database.Client, input: Registry = registry) {
  return Effect.gen(function* () {
    const schemas = (yield* db.all<{ name: string }>(
      sql`SELECT table_schema AS name FROM information_schema.tables WHERE table_name = 'migration' ORDER BY 1`,
    )).map((row) => row.name)
    for (const name of schemas) yield* migrate(db, { schema: name, registry: input })
    return schemas
  })
}

/** Fails unless the current schema holds every migration `input` expects. Changes nothing. */
export function verify(db: Database.Client, input: Registry = registry) {
  return Effect.gen(function* () {
    const present = (yield* tables(db).pipe(Effect.orDie)).some((table) => table.name === "migration")
    const completed = present
      ? new Set((yield* db.all<{ id: string }>(sql`SELECT id FROM migration`).pipe(Effect.orDie)).map((row) => row.id))
      : new Set<string>()
    const missing = [...input.ids].sort().filter((id) => !completed.has(id))
    if (missing.length === 0) return
    return yield* new SchemaNotMigratedError({
      message: `The database schema is not migrated for this build (missing ${missing.length}, first: ${missing[0]}). Run "opencode db migrate" against this schema before starting a server.`,
    })
  })
}
