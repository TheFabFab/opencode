export * as DatabaseProvision from "./provision"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "./database"

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

function name(kind: string, value: string) {
  return IDENTIFIER.test(value)
    ? Effect.succeed(`"${value}"`)
    : Effect.die(`${kind} must be 1 to 63 characters of a-z, 0-9 and _, not starting with a digit`)
}

/**
 * Gives one scope a schema and a login role limited to it.
 *
 * The caller's role owns the schema and its tables, so the scope role can read
 * and write rows but cannot alter, drop or create anything. Tables created
 * later by the same caller are covered by default privileges.
 */
export function scope(db: Database.Client, input: { schema: string; role: string; password?: string }) {
  return Effect.gen(function* () {
    const schema = yield* name("schema", input.schema)
    const role = yield* name("role", input.role)
    const exists = yield* db.get(sql`select 1 as found from pg_roles where rolname = ${input.role}`)
    if (!exists) {
      if (!input.password) return yield* Effect.die(`role ${input.role} does not exist and no password was given`)
      // CREATE ROLE takes no bind parameters; the literal is escaped by Postgres' own quoting function.
      const literal = (yield* db.get<{ value: string }>(sql`select quote_literal(${input.password}) as value`))!.value
      yield* db.run(`CREATE ROLE ${role} LOGIN NOINHERIT NOCREATEDB NOCREATEROLE PASSWORD ${literal}`)
    }
    yield* db.run(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    yield* db.run(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`)
    yield* db.run(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`)
    yield* db.run(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`)
    yield* db.run(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    )
  }).pipe(Effect.orDie)
}

/** Lets `role` read every table in `schema`, present and future, and nothing more. */
export function reader(db: Database.Client, input: { schema: string; role: string }) {
  return Effect.gen(function* () {
    const schema = yield* name("schema", input.schema)
    const role = yield* name("role", input.role)
    yield* db.run(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`)
    yield* db.run(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`)
    yield* db.run(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT ON TABLES TO ${role}`)
  }).pipe(Effect.orDie)
}
