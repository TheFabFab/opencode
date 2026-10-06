import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const run = <A, E>(effect: Effect.Effect<A, E, Database.Service>) =>
  effect.pipe(Effect.provide(LayerNode.compile(Database.node)), Effect.runPromise)

describe("database layer", () => {
  test("builds the 19 tables and the migration journal in a schema of its own", () =>
    run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const schema = (yield* db.get<{ name: string }>(sql`select current_schema() as name`))!.name
        expect(schema).toMatch(/^t_[0-9a-f]{32}$/)
        const tables = yield* db.all<{ name: string }>(
          sql`select table_name as name from information_schema.tables where table_schema = current_schema() order by 1`,
        )
        expect(tables.map((table) => table.name)).toContain("session")
        expect(tables).toHaveLength(20)
      }),
    ))

  test("two layers get two schemas and each is dropped when its layer closes", async () => {
    const name = Effect.gen(function* () {
      const { db } = yield* Database.Service
      return (yield* db.get<{ name: string }>(sql`select current_schema() as name`))!.name
    })
    const first = await run(name)
    const second = await run(name)
    expect(first).not.toBe(second)
    const left = await run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        return yield* db.all<{ name: string }>(
          sql`select schema_name as name from information_schema.schemata where schema_name in (${first}, ${second})`,
        )
      }),
    )
    expect(left).toEqual([])
  })

  test("no time column is a 32-bit integer and every JSON column is jsonb", () =>
    run(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const columns = yield* db.all<{ table: string; column: string; type: string }>(sql`
          select table_name as "table", column_name as "column", data_type as "type"
          from information_schema.columns where table_schema = current_schema()
        `)
        const time = columns.filter((item) => item.column.startsWith("time_") || item.column === "token_expiry")
        expect(time.length).toBeGreaterThan(25)
        expect(time.filter((item) => item.type !== "double precision")).toEqual([])
        expect(columns.filter((item) => item.type === "integer" || item.type === "real")).toEqual([])
        expect(columns.filter((item) => item.type === "jsonb")).toHaveLength(14)
      }),
    ))
})
