import { describe, expect, test } from "bun:test"
import * as PgClient from "@effect/sql-pg/PgClient"
import { sql } from "drizzle-orm"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import { Effect, Fiber, Layer, Redacted } from "effect"
import "../src/index"
import { adminUrl } from "./harness"

const makeDatabase = EffectDrizzlePostgres.makeWithDefaults()
const pool = () => PgClient.layer({ url: Redacted.make(adminUrl), maxConnections: 2 }).pipe(Layer.orDie)

describe("interruption", () => {
  // A pool cannot close while a connection is checked out, so a leaked
  // connection shows up as a pool that never finishes closing.
  for (const [name, behavior] of [
    ["a transaction", undefined],
    ["an immediate transaction", "immediate"],
  ] as const)
    test(`interrupting a fiber as it starts ${name} returns its connection to the pool`, async () => {
      const closed = await Effect.gen(function* () {
        const db = yield* makeDatabase
        // Warm the pool so a connection is ready to be handed over.
        yield* db.run(sql`select 1`)
        for (let round = 0; round < 25; round++) {
          const work = behavior
            ? db.transaction((tx) => tx.run(sql`select 1`), { behavior })
            : db.transaction((tx) => tx.run(sql`select 1`))
          const fiber = yield* work.pipe(Effect.forkChild)
          yield* Effect.yieldNow
          yield* Fiber.interrupt(fiber)
        }
        return yield* db.get<{ n: number }>(sql`select 1 as n`)
      }).pipe(Effect.provide(pool()), Effect.timeoutOption("8 seconds"), Effect.runPromise)
      expect(closed).toMatchObject({ _tag: "Some", value: { n: 1 } })
    }, 20000)

  for (const [name, behavior] of [
    ["a transaction", undefined],
    ["an immediate transaction", "immediate"],
  ] as const)
    test(`${name} run by an interrupted fiber's cleanup returns its connection to the pool`, async () => {
      const closed = await Effect.gen(function* () {
        const db = yield* makeDatabase
        yield* db.run(sql`create temporary table if not exists closed (id int)`)
        const cleanup = behavior
          ? db.transaction((tx) => tx.run(sql`select 1`), { behavior })
          : db.transaction((tx) => tx.run(sql`select 1`))
        const fiber = yield* Effect.never.pipe(
          Effect.onInterrupt(() => cleanup.pipe(Effect.orDie)),
          Effect.forkChild,
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        return yield* db.get<{ n: number }>(sql`select 1 as n`)
      }).pipe(Effect.provide(pool()), Effect.timeoutOption("8 seconds"), Effect.runPromise)
      expect(closed).toMatchObject({ _tag: "Some", value: { n: 1 } })
    }, 20000)

  test("interrupting a query in flight returns its connection to the pool", async () => {
    const closed = await Effect.gen(function* () {
      const db = yield* makeDatabase
      for (let round = 0; round < 5; round++) {
        const fiber = yield* db.run(sql`select pg_sleep(5)`).pipe(Effect.forkChild)
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(fiber)
      }
      return yield* db.get<{ n: number }>(sql`select 1 as n`)
    }).pipe(Effect.provide(pool()), Effect.timeoutOption("8 seconds"), Effect.runPromise)
    expect(closed).toMatchObject({ _tag: "Some", value: { n: 1 } })
  }, 20000)
})
