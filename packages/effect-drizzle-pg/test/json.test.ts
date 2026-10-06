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
        const exit = yield* db.insert(Raw).values({ id: "a", data: { out: "a\u0000b" } }).run().pipe(Effect.exit)
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
})
