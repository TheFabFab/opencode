export * as DatabaseConnect from "./connect"

import "@opencode-ai/effect-drizzle-pg"
import * as PgClient from "@effect/sql-pg/PgClient"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import { Effect, Layer, Redacted } from "effect"
import type { Database } from "./database"
import { DatabaseTarget } from "./target"

/**
 * Runs `body` on one connection made from the environment, without the checks
 * `Database.Service` makes. The migrate and provision commands need this: the
 * service refuses a schema that is not migrated yet.
 *
 * With `schema: false` the connection ignores `OPENCODE_DATABASE_SCHEMA` and
 * uses the role's own search path.
 */
export function run<A, E>(
  body: (db: Database.Client, target: DatabaseTarget.Target) => Effect.Effect<A, E, PgClient.PgClient>,
  options: { readonly schema: boolean } = { schema: true },
): Effect.Effect<A, E> {
  return Effect.suspend(() => {
    const target = DatabaseTarget.read(
      options.schema ? process.env : { ...process.env, OPENCODE_DATABASE_SCHEMA: undefined },
    )
    return Effect.flatMap(EffectDrizzlePostgres.makeWithDefaults(), (db) => body(db, target)).pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(target.url), maxConnections: 1 }).pipe(Layer.orDie)),
    )
  })
}
