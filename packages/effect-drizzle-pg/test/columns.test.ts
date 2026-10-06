import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { pgTable } from "drizzle-orm/pg-core"
import { Effect } from "effect"
import { count, text } from "../src/index"
import { withSchema } from "./harness"

const Row = pgTable("row", { id: text().primaryKey(), title: text().notNull(), total: count().notNull() })
const create = sql`CREATE TABLE "row" (id text PRIMARY KEY, title text NOT NULL, total bigint NOT NULL)`
const one = (db: Parameters<Parameters<typeof withSchema>[0]>[0], id: string) =>
  db.select().from(Row).where(eq(Row.id, id)).get()

describe("text column", () => {
  test("Postgres itself rejects NUL in text", () =>
    withSchema((db) =>
      Effect.gen(function* () {
        yield* db.run(create)
        const exit = yield* db
          .run(sql`insert into "row" (id, title, total) values ('a', ${"a\u0000b"}, 1)`)
          .pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    ))

  test("stores NUL as U+FFFD and leaves every other string alone", () =>
    withSchema((db) =>
      Effect.gen(function* () {
        yield* db.run(create)
        yield* db
          .insert(Row)
          .values([
            { id: "nul", title: "before\u0000after", total: 1 },
            { id: "digits", title: "12345", total: 1 },
            { id: "empty", title: "", total: 1 },
            { id: "unicode", title: "naïve — 日本語 🎉", total: 1 },
          ])
          .run()
        expect((yield* one(db, "nul"))!.title).toBe("before\uFFFDafter")
        expect((yield* one(db, "digits"))!.title).toBe("12345")
        expect((yield* one(db, "empty"))!.title).toBe("")
        expect((yield* one(db, "unicode"))!.title).toBe("naïve — 日本語 🎉")
      }),
    ))
})

describe("count column", () => {
  test("round-trips integers beyond 32 bits as numbers", () =>
    withSchema((db) =>
      Effect.gen(function* () {
        yield* db.run(create)
        yield* db
          .insert(Row)
          .values([
            { id: "zero", title: "t", total: 0 },
            { id: "big", title: "t", total: 1791311070891 },
            { id: "negative", title: "t", total: -5 },
          ])
          .run()
        expect((yield* one(db, "zero"))!.total).toBe(0)
        expect((yield* one(db, "big"))!.total).toBe(1791311070891)
        expect((yield* one(db, "negative"))!.total).toBe(-5)
      }),
    ))

  test("rounds a fraction", () =>
    withSchema((db) =>
      Effect.gen(function* () {
        yield* db.run(create)
        yield* db.insert(Row).values({ id: "a", title: "t", total: 10.6 }).run()
        expect((yield* one(db, "a"))!.total).toBe(11)
      }),
    ))

  test("refuses NaN and Infinity and writes nothing", () =>
    withSchema((db) =>
      Effect.gen(function* () {
        yield* db.run(create)
        for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
          const exit = yield* Effect.suspend(() =>
            db.insert(Row).values({ id: "bad", title: "t", total: bad }).run(),
          ).pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
        }
        expect(yield* db.select().from(Row).all()).toEqual([])
      }),
    ))
})
