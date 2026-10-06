import { describe, expect, test } from "bun:test"
import * as PgClient from "@effect/sql-pg/PgClient"
import { sql } from "drizzle-orm"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import { Effect, Layer, Redacted } from "effect"
import "@opencode-ai/effect-drizzle-pg"

const admin = process.env.OPENCODE_TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5432/postgres"
const makeDatabase = EffectDrizzlePostgres.makeWithDefaults()
// One connection, so the test knows exactly which backend the pool holds.
const pool = () => PgClient.layer({ url: Redacted.make(admin), maxConnections: 1 }).pipe(Layer.orDie)
const pid = sql`select pg_backend_pid() as pid`

describe("connection pool", () => {
  test("recovers after the connection is dropped", () =>
    Effect.gen(function* () {
      const db = yield* makeDatabase
      const before = (yield* db.get<{ pid: number }>(pid))!.pid

      // From a second pool, end the first pool's only backend, as a Postgres restart would.
      yield* Effect.flatMap(makeDatabase, (other) => other.run(sql`select pg_terminate_backend(${before})`)).pipe(
        Effect.provide(pool()),
      )

      const attempts = yield* Effect.all(
        Array.from({ length: 5 }, () => db.get<{ pid: number }>(pid).pipe(Effect.exit)),
      )
      expect(attempts[0]!._tag).toBe("Failure")
      expect(attempts.at(-1)!._tag).toBe("Success")
      expect((yield* db.get<{ pid: number }>(pid))!.pid).not.toBe(before)
    }).pipe(Effect.provide(pool()), Effect.runPromise))
})
