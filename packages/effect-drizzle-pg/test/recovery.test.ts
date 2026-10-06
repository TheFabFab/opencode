import { describe, expect, test } from "bun:test"
import * as PgClient from "@effect/sql-pg/PgClient"
import { sql } from "drizzle-orm"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import { Effect } from "effect"
import { connect } from "./harness"

const makeDatabase = EffectDrizzlePostgres.makeWithDefaults()
const admin = <A, E>(body: (db: Effect.Success<typeof makeDatabase>) => Effect.Effect<A, E, PgClient.PgClient>) =>
  Effect.flatMap(makeDatabase, body).pipe(Effect.provide(connect("public", 1)), Effect.runPromise)

describe("connection pool", () => {
  test("recovers after its connection is dropped", () =>
    Effect.gen(function* () {
      const db = yield* makeDatabase
      const before = (yield* db.get<{ pid: number }>(sql`select pg_backend_pid() as pid`))!.pid
      yield* Effect.promise(() => admin((other) => other.run(sql`select pg_terminate_backend(${before})`)))
      const attempts = yield* Effect.all(
        Array.from({ length: 5 }, () => db.get<{ pid: number }>(sql`select pg_backend_pid() as pid`).pipe(Effect.exit)),
      )
      console.log("attempts:", attempts.map((exit) => exit._tag).join(","))
      const after = yield* db.get<{ pid: number }>(sql`select pg_backend_pid() as pid`)
      expect(after!.pid).not.toBe(before)
    }).pipe(Effect.provide(connect("public", 1)), Effect.runPromise))
})
