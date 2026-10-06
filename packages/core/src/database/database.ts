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

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase
    const schema = process.env.OPENCODE_DATABASE_SCHEMA
    if (schema) yield* db.run(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
    yield* DatabaseMigration.apply(db)
    return { db }
  }).pipe(Effect.orDie),
)

function url() {
  const value = new URL(process.env.OPENCODE_DATABASE_URL!)
  const schema = process.env.OPENCODE_DATABASE_SCHEMA
  if (schema) value.searchParams.set("options", `-c search_path=${schema}`)
  return value.toString()
}

export function layerFromPath(_filename: string) {
  return layer.pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url()), maxConnections: 4 }).pipe(Layer.orDie)))
}

export function path() {
  return "postgres"
}

export const node = makeGlobalNode({ service: Service, layer: layerFromPath(path()), deps: [] })
