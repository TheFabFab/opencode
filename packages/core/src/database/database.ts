export * as Database from "./database"

import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import * as PgClient from "@effect/sql-pg/PgClient"
import "./pg-terminal"
import { Context, Effect, Layer, Redacted } from "effect"
import { DatabaseMigration } from "./migration"
import { makeGlobalNode } from "../effect/app-node"

const makeDatabase = EffectDrizzlePostgres.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

const layer = (schema: string | undefined, ephemeral: boolean) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* makeDatabase
      if (schema) yield* db.run(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
      if (ephemeral)
        yield* Effect.addFinalizer(() => db.run(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).pipe(Effect.ignore))
      yield* DatabaseMigration.apply(db)
      return { db }
    }).pipe(Effect.orDie),
  )

export function layerFromPath(_filename: string) {
  return Layer.unwrap(
    Effect.sync(() => {
      const ephemeral = process.env.OPENCODE_DATABASE_EPHEMERAL === "1"
      const schema = ephemeral ? `t_${crypto.randomUUID().replaceAll("-", "")}` : process.env.OPENCODE_DATABASE_SCHEMA
      const value = new URL(process.env.OPENCODE_DATABASE_URL!)
      if (schema) value.searchParams.set("options", `-c search_path=${schema}`)
      return layer(schema, ephemeral).pipe(
        Layer.provide(PgClient.layer({ url: Redacted.make(value.toString()), maxConnections: 2 }).pipe(Layer.orDie)),
      )
    }),
  )
}

export function path() {
  return "postgres"
}

export const node = makeGlobalNode({ service: Service, layer: layerFromPath(path()), deps: [] })
