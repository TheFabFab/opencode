import * as PgClient from "@effect/sql-pg/PgClient"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import { Effect, Layer, Redacted } from "effect"
import "../src/index"

export const adminUrl = process.env.OPENCODE_TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5432/postgres"

const makeDatabase = EffectDrizzlePostgres.makeWithDefaults()
export type TestDatabase = Effect.Success<typeof makeDatabase>

export function connect(schema: string, maxConnections = 2) {
  const url = new URL(adminUrl)
  url.searchParams.set("options", `-c search_path=${schema}`)
  return PgClient.layer({ url: Redacted.make(url.toString()), maxConnections }).pipe(Layer.orDie)
}

/** Runs `body` against a schema that exists only for this call. */
export function withSchema<A, E>(body: (db: TestDatabase, schema: string) => Effect.Effect<A, E, PgClient.PgClient>) {
  const schema = `t_${crypto.randomUUID().replaceAll("-", "")}`
  return Effect.gen(function* () {
    const db = yield* makeDatabase
    yield* db.run(`CREATE SCHEMA "${schema}"`)
    return yield* body(db, schema).pipe(Effect.ensuring(db.run(`DROP SCHEMA "${schema}" CASCADE`).pipe(Effect.ignore)))
  }).pipe(Effect.provide(connect(schema)), Effect.runPromise)
}
