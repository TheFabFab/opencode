export * as DatabaseConnect from "./connect"

import "@opencode-ai/effect-drizzle-pg"
import * as PgClient from "@effect/sql-pg/PgClient"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import { Effect, Layer, Redacted } from "effect"
import type { Database } from "./database"

/** Where a command connects: the URL with the schema folded in, and the schema's name. */
export interface Target {
  readonly url: string
  readonly schema: string | undefined
}

function read(useSchema: boolean): Target {
  const address = process.env.OPENCODE_DATABASE_URL
  if (!address) throw new Error("OPENCODE_DATABASE_URL is not set")
  const schema = useSchema ? process.env.OPENCODE_DATABASE_SCHEMA || undefined : undefined
  const url = new URL(address)
  if (schema) url.searchParams.set("options", `-c search_path=${schema}`)
  return { url: url.toString(), schema }
}

/**
 * Runs `body` on one connection made from the environment, without the checks
 * `Database.Service` makes. The migrate and provision commands need this: the
 * service refuses a schema that is not migrated yet.
 *
 * With `schema: false` the connection ignores `OPENCODE_DATABASE_SCHEMA` and
 * uses the role's own search path.
 */
export function run<A, E>(
  body: (db: Database.Client, target: Target) => Effect.Effect<A, E, PgClient.PgClient>,
  options: { readonly schema: boolean } = { schema: true },
): Effect.Effect<A, E> {
  return Effect.suspend(() => {
    const target = read(options.schema)
    return Effect.flatMap(EffectDrizzlePostgres.makeWithDefaults(), (db) => body(db, target)).pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(target.url), maxConnections: 1 }).pipe(Layer.orDie)),
    )
  })
}
