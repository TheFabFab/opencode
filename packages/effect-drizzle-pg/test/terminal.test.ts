import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { bigint, pgTable, text } from "drizzle-orm/pg-core"
import { Effect } from "effect"
import { jsonb } from "../src/index"
import { withSchema } from "./harness"

const Item = pgTable("item", {
  id: text().primaryKey(),
  title: text().notNull(),
  count: bigint({ mode: "number" }).notNull(),
  data: jsonb().$type<{ note: string }>(),
})

const create = sql`CREATE TABLE item (id text PRIMARY KEY, title text NOT NULL, count bigint NOT NULL, data jsonb)`

describe("terminal methods", () => {
  test("get returns the first row or undefined, all returns every row, run returns nothing", () =>
    withSchema((db) =>
      Effect.gen(function* () {
        yield* db.run(create)
        expect(yield* db.select().from(Item).where(eq(Item.id, "a")).get()).toBeUndefined()
        expect(
          yield* db
            .insert(Item)
            .values([
              { id: "a", title: "12345", count: 1791311070891, data: { note: "x" } },
              { id: "b", title: "second", count: 2 },
            ])
            .run(),
        ).toBeUndefined()
        expect(yield* db.select().from(Item).where(eq(Item.id, "a")).get()).toEqual({
          id: "a",
          title: "12345",
          count: 1791311070891,
          data: { note: "x" },
        })
        expect((yield* db.select({ id: Item.id }).from(Item).orderBy(Item.id).all()).map((row) => row.id)).toEqual([
          "a",
          "b",
        ])
        expect(
          yield* db.update(Item).set({ count: 3 }).where(eq(Item.id, "b")).returning({ count: Item.count }).get(),
        ).toEqual({ count: 3 })
        expect(yield* db.delete(Item).where(eq(Item.id, "b")).returning().all()).toHaveLength(1)
        expect(yield* db.get<{ n: number }>(sql`select count(*)::int as n from item`)).toEqual({ n: 1 })
        expect(yield* db.all<{ id: string }>(sql`select id from item`)).toEqual([{ id: "a" }])
      }),
    ))

  test("terminal methods work inside a transaction, and a failed transaction leaves nothing behind", () =>
    withSchema((db) =>
      Effect.gen(function* () {
        yield* db.run(create)
        const exit = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.insert(Item).values({ id: "a", title: "t", count: 1 }).run()
              expect(yield* tx.get<{ n: number }>(sql`select count(*)::int as n from item`)).toEqual({ n: 1 })
              return yield* Effect.fail("stop")
            }),
          )
          .pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        expect(yield* db.select().from(Item).all()).toEqual([])
      }),
    ))

  // SQLite ran every transaction behind one connection, so two never overlapped.
  // Upstream's read-then-write code relies on that, whether or not it asked for
  // an "immediate" transaction.
  for (const [name, config] of [
    ["a plain transaction", undefined],
    ["an immediate transaction", { behavior: "immediate" as const }],
  ] as const)
    test(`${name} on one schema never overlaps another`, () =>
      withSchema((db) =>
        Effect.gen(function* () {
          yield* db.run(create)
          yield* db.insert(Item).values({ id: "n", title: "counter", count: 0 }).run()
          const body = (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) =>
            Effect.gen(function* () {
              const row = yield* tx.select().from(Item).where(eq(Item.id, "n")).get()
              yield* Effect.sleep("20 millis")
              yield* tx
                .update(Item)
                .set({ count: row!.count + 1 })
                .where(eq(Item.id, "n"))
                .run()
            })
          const bump = config ? db.transaction(body, config) : db.transaction(body)
          yield* Effect.all([bump, bump, bump, bump], { concurrency: "unbounded" })
          expect((yield* db.select().from(Item).where(eq(Item.id, "n")).get())!.count).toBe(4)
        }),
      ))
})
