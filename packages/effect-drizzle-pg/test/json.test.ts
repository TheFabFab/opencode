import { describe, expect, test } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { jsonb as builtin, pgTable, text } from "drizzle-orm/pg-core"
import { Effect } from "effect"
import { jsonb } from "../src/index"
import { withSchema } from "./harness"

const Doc = pgTable("doc", { id: text().primaryKey(), data: jsonb().$type<Record<string, unknown>>().notNull() })
const Raw = pgTable("doc", { id: text().primaryKey(), data: builtin().$type<Record<string, unknown>>().notNull() })
const create = sql`CREATE TABLE doc (id text PRIMARY KEY, data jsonb NOT NULL)`

describe("jsonb column", () => {
  test("Postgres itself rejects an escaped NUL in jsonb", () =>
    withSchema((db) =>
      Effect.gen(function* () {
        yield* db.run(create)
        const exit = yield* db
          .insert(Raw)
          .values({ id: "a", data: { out: "a\u0000b" } })
          .run()
          .pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    ))

  test("stores NUL as U+FFFD and round-trips everything else unchanged", () =>
    withSchema((db) =>
      Effect.gen(function* () {
        yield* db.run(create)
        const value = {
          out: "a\u0000b",
          nested: [{ "k\u0000": "12345" }],
          digits: "12345",
          float: 0.1 + 0.2,
          big: 1791311070891,
          unicode: "naïve — 日本語 🎉",
          empty: "",
          none: null,
        }
        yield* db.insert(Doc).values({ id: "a", data: value }).run()
        expect((yield* db.select().from(Doc).where(eq(Doc.id, "a")).get())!.data).toEqual({
          ...value,
          out: "a�b",
          nested: [{ "k�": "12345" }],
        })
        expect(yield* db.get(sql`select jsonb_typeof(data) as kind, data->>'digits' as digits from doc`)).toEqual({
          kind: "object",
          digits: "12345",
        })
      }),
    ))

  test("stores a lone surrogate as U+FFFD, as text columns do", () =>
    withSchema((db) =>
      Effect.gen(function* () {
        yield* db.run(create)
        // Shell output cut at 30,000 characters can start inside an emoji.
        const value = {
          out: "\uDE00 after the cut",
          key: { ["k\uD83D"]: "high surrogate in a key" },
          ok: "x\uD83D\uDE00",
        }
        yield* db.insert(Doc).values({ id: "a", data: value }).run()
        expect((yield* db.select().from(Doc).where(eq(Doc.id, "a")).get())!.data).toEqual({
          out: "\uFFFD after the cut",
          key: { ["k\uFFFD"]: "high surrogate in a key" },
          ok: "x\uD83D\uDE00",
        })
      }),
    ))

  test("round-trips top-level strings, numbers, arrays and null", () =>
    withSchema((db) =>
      Effect.gen(function* () {
        yield* db.run(sql`CREATE TABLE any_doc (id text PRIMARY KEY, data jsonb)`)
        const AnyDoc = pgTable("any_doc", { id: text().primaryKey(), data: jsonb().$type<unknown>() })
        const values: Record<string, unknown> = { s: "abc", digits: "123", n: 123, a: [1, "2"], z: null, b: false }
        for (const [id, data] of Object.entries(values)) yield* db.insert(AnyDoc).values({ id, data }).run()
        for (const [id, data] of Object.entries(values))
          expect((yield* db.select().from(AnyDoc).where(eq(AnyDoc.id, id)).get())!.data).toEqual(data)
      }),
    ))

  test("stores a 5 MB string value", () =>
    withSchema((db) =>
      Effect.gen(function* () {
        yield* db.run(create)
        const out = "x".repeat(5 * 1024 * 1024)
        yield* db.insert(Doc).values({ id: "big", data: { out } }).run()
        expect(yield* db.get(sql`select length(data->>'out')::int as n from doc`)).toEqual({ n: out.length })
      }),
    ))
})
