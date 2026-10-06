export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Cause, Effect, Exit, Schema } from "effect"
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
 * The upstream migrations whose effect the generated baseline (`schema.gen.ts`)
 * already contains. Upstream's migration files are SQLite SQL and never run
 * here; these ids are recorded as applied when the baseline is created. The
 * list is explicit because migration ids carry the time they were generated,
 * not the time they were merged, so order says nothing about coverage.
 */
export const BASELINE_IDS: ReadonlySet<string> = new Set([
  "20260127222353_familiar_lady_ursula",
  "20260211171708_add_project_commands",
  "20260213144116_wakeful_the_professor",
  "20260225215848_workspace",
  "20260227213759_add_session_workspace_id",
  "20260228203230_blue_harpoon",
  "20260303231226_add_workspace_fields",
  "20260309230000_move_org_to_state",
  "20260312043431_session_message_cursor",
  "20260323234822_events",
  "20260410174513_workspace-name",
  "20260413175956_chief_energizer",
  "20260423070820_add_icon_url_override",
  "20260427172553_slow_nightmare",
  "20260428004200_add_session_path",
  "20260501142318_next_venus",
  "20260504145000_add_sync_owner",
  "20260507164347_add_workspace_time",
  "20260510033149_session_usage",
  "20260511000411_data_migration_state",
  "20260511173437_session-metadata",
  "20260601010001_normalize_storage_paths",
  "20260601202201_amazing_prowler",
  "20260602002951_lowly_union_jack",
  "20260602182828_add_project_directories",
  "20260603001617_session_message_projection_indexes",
  "20260603040000_session_message_projection_order",
  "20260603141458_session_input_inbox",
  "20260603160727_jittery_ezekiel_stane",
  "20260604172448_event_sourced_session_input",
  "20260605003541_add_session_context_snapshot",
  "20260605042240_add_context_epoch_agent",
  "20260611035744_credential",
  "20260611192811_lush_chimera",
  "20260612174303_project_dir_strategy",
  "20260622142730_simplify_session_context_epoch",
  "20260622170816_reset_v2_session_state",
  "20260622202450_simplify_session_input",
])

/**
 * Postgres versions of upstream migrations outside the baseline, keyed by
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
  return input.ids.filter((id) => !BASELINE_IDS.has(id) && !(id in input.ported)).sort()
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
 * done. A named schema that does not exist is skipped.
 */
export function migrate(db: Database.Client, options: { schema?: string; registry?: Registry } = {}) {
  const input = options.registry ?? registry
  const expected = [...input.ids].sort()
  return db.transaction((tx) =>
    Effect.gen(function* () {
      if (options.schema) {
        // A scope can be removed while a Job that lists every schema is running.
        const present = yield* tx.get(
          sql`SELECT 1 AS found FROM information_schema.schemata WHERE schema_name = ${options.schema}`,
        )
        if (!present) return
        yield* tx.run(sql`SELECT set_config('search_path', ${options.schema}, true)`)
      }
      yield* tx.run(sql`SELECT pg_advisory_xact_lock(${LOCK_CLASS}, hashtext(current_schema()))`)
      const existing = (yield* tables(tx)).map((table) => table.name)
      if (existing.length > 0 && !existing.includes("session"))
        return yield* Effect.die("Schema is not empty and has no session table")
      if (existing.length === 0) {
        yield* schema.up(tx)
        yield* tx.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed DOUBLE PRECISION NOT NULL)`)
        const now = Date.now()
        const covered = expected.filter((id) => BASELINE_IDS.has(id)).map((id) => sql`(${id}, ${now})`)
        if (covered.length > 0)
          yield* tx.run(sql`INSERT INTO migration (id, time_completed) VALUES ${sql.join(covered, sql`, `)}`)
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

/**
 * Migrates every schema that holds opencode's tables: those with both a
 * `session` and a `migration` table. A schema that fails is reported and does
 * not stop the others.
 */
export function migrateAll(db: Database.Client, input: Registry = registry) {
  return Effect.gen(function* () {
    const schemas = (yield* db.all<{ name: string }>(sql`
      SELECT table_schema AS name FROM information_schema.tables
      WHERE table_name IN ('session', 'migration')
      GROUP BY table_schema HAVING count(DISTINCT table_name) = 2
      ORDER BY 1
    `)).map((row) => row.name)
    const done: string[] = []
    const failed: Array<{ schema: string; error: unknown }> = []
    for (const name of schemas) {
      const exit = yield* migrate(db, { schema: name, registry: input }).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) done.push(name)
      else failed.push({ schema: name, error: Cause.squash(exit.cause) })
    }
    return { done, failed }
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
