export * as Database from "./database"

import "@opencode-ai/effect-drizzle-pg"
import * as PgClient from "@effect/sql-pg/PgClient"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import { Context, Effect, Layer, Redacted } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { DatabaseCollation } from "./collation"
import { DatabaseMigration } from "./migration"
import { DatabaseTarget } from "./target"

const makeDatabase = EffectDrizzlePostgres.makeWithDefaults()

export type Client = Effect.Success<typeof makeDatabase>
export type Transaction = Parameters<Parameters<Client["transaction"]>[0]>[0]

export interface Interface {
  db: Client
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const layer = Layer.unwrap(
  Effect.sync(() => {
    const { url, schema, ephemeral, maxConnections } = DatabaseTarget.read()
    return Layer.effect(
      Service,
      Effect.gen(function* () {
        const db = yield* makeDatabase
        if (ephemeral) {
          yield* db.run(`CREATE SCHEMA "${schema}"`)
          yield* Effect.addFinalizer(() => db.run(`DROP SCHEMA "${schema}" CASCADE`).pipe(Effect.ignore))
          yield* DatabaseMigration.migrate(db)
        }
        yield* DatabaseCollation.verify(db)
        yield* DatabaseMigration.verify(db)
        return { db }
      }).pipe(Effect.orDie),
    ).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url), maxConnections }).pipe(Layer.orDie)))
  }),
)

/**
 * Upstream's tests ask for a database by file name. Every database here is the
 * one the environment names, so the argument is unused.
 */
export function layerFromPath(_filename: string) {
  return layer
}

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
