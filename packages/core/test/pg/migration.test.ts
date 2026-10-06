import { describe, expect, test } from "bun:test"
import * as PgClient from "@effect/sql-pg/PgClient"
import { sql } from "drizzle-orm"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import { Effect, Layer, Redacted } from "effect"
import "@opencode-ai/effect-drizzle-pg"
import { DatabaseCollation } from "@opencode-ai/core/database/collation"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"

const admin = process.env.OPENCODE_TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5432/postgres"
const makeDatabase = EffectDrizzlePostgres.makeWithDefaults()
type Db = Effect.Success<typeof makeDatabase>
const fresh = () => `t_${crypto.randomUUID().replaceAll("-", "")}`

function client(schema: string, database?: string) {
  const url = new URL(admin)
  if (database) url.pathname = `/${database}`
  url.searchParams.set("options", `-c search_path=${schema}`)
  return PgClient.layer({ url: Redacted.make(url.toString()), maxConnections: 2 }).pipe(Layer.orDie)
}

/** Runs `body` connected to a schema that exists only for this call. */
function inSchema<A, E>(body: (db: Db, schema: string) => Effect.Effect<A, E, PgClient.PgClient>) {
  const schema = fresh()
  return Effect.gen(function* () {
    const db = yield* makeDatabase
    yield* db.run(`CREATE SCHEMA "${schema}"`)
    return yield* body(db, schema).pipe(Effect.ensuring(db.run(`DROP SCHEMA "${schema}" CASCADE`).pipe(Effect.ignore)))
  }).pipe(Effect.provide(client(schema)), Effect.runPromise)
}

const ids = DatabaseMigration.registry.ids
const next = "99990101000000_from_upstream"
/** A build that knows one upstream migration newer than the baseline, ported as "add a marker table". */
const withPort: DatabaseMigration.Registry = {
  ids: [...ids, next],
  ported: { [next]: (tx) => tx.run(sql`CREATE TABLE marker (id text)`) },
}

describe("migration lifecycle", () => {
  test("every upstream migration is either in the baseline or ported", () => {
    expect(DatabaseMigration.pending()).toEqual([])
    expect(ids).toContain(DatabaseMigration.BASELINE)
  })

  test("pending names an upstream migration that is newer than the baseline and has no port", () => {
    expect(DatabaseMigration.pending({ ids: [...ids, next], ported: {} })).toEqual([next])
    expect(DatabaseMigration.pending(withPort)).toEqual([])
  })

  test("verify refuses an empty schema and changes nothing", () =>
    inSchema((db) =>
      Effect.gen(function* () {
        const exit = yield* DatabaseMigration.verify(db).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        expect(String(exit)).toContain("opencode db migrate")
        expect(
          yield* db.all(sql`select 1 from information_schema.tables where table_schema = current_schema()`),
        ).toEqual([])
      }),
    ))

  test("migrate creates the baseline, records every upstream id, and verify then passes", () =>
    inSchema((db) =>
      Effect.gen(function* () {
        yield* DatabaseMigration.migrate(db)
        yield* DatabaseMigration.verify(db)
        const recorded = yield* db.all<{ id: string }>(sql`select id from migration order by id`)
        expect(recorded.map((row) => row.id)).toEqual([...ids].sort())
        expect(
          yield* db.get<{ n: number }>(
            sql`select count(*)::int as n from information_schema.tables where table_schema = current_schema()`,
          ),
        ).toEqual({ n: 20 })
      }),
    ))

  test("migrate is idempotent, and eight at once on one empty schema all succeed", () =>
    inSchema((db) =>
      Effect.gen(function* () {
        yield* Effect.all(
          Array.from({ length: 8 }, () => DatabaseMigration.migrate(db)),
          { concurrency: "unbounded" },
        )
        yield* DatabaseMigration.migrate(db)
        expect(yield* db.get<{ n: number }>(sql`select count(*)::int as n from migration`)).toEqual({ n: ids.length })
      }),
    ))

  test("a ported migration is applied once to an existing schema, and to a new one after its baseline", () =>
    inSchema((db) =>
      Effect.gen(function* () {
        yield* DatabaseMigration.migrate(db)
        expect((yield* DatabaseMigration.verify(db, withPort).pipe(Effect.exit))._tag).toBe("Failure")
        yield* DatabaseMigration.migrate(db, { registry: withPort })
        yield* DatabaseMigration.migrate(db, { registry: withPort })
        yield* DatabaseMigration.verify(db, withPort)
        expect(yield* db.all(sql`select id from marker`)).toEqual([])
        expect(yield* db.get<{ n: number }>(sql`select count(*)::int as n from migration where id = ${next}`)).toEqual({
          n: 1,
        })
      }),
    ))

  test("a failing ported migration rolls back and leaves the schema as it was", () =>
    inSchema((db) =>
      Effect.gen(function* () {
        yield* DatabaseMigration.migrate(db)
        const broken: DatabaseMigration.Registry = {
          ids: [...ids, next],
          ported: {
            [next]: (tx) => Effect.andThen(tx.run(sql`CREATE TABLE marker (id text)`), Effect.fail("stop")),
          },
        }
        expect((yield* DatabaseMigration.migrate(db, { registry: broken }).pipe(Effect.exit))._tag).toBe("Failure")
        yield* DatabaseMigration.verify(db)
        expect(
          yield* db.all(
            sql`select 1 from information_schema.tables where table_schema = current_schema() and table_name = 'marker'`,
          ),
        ).toEqual([])
      }),
    ))

  test("an upstream migration with no port stops the migration", () =>
    inSchema((db) =>
      Effect.gen(function* () {
        yield* DatabaseMigration.migrate(db)
        const exit = yield* DatabaseMigration.migrate(db, { registry: { ids: [...ids, next], ported: {} } }).pipe(
          Effect.exit,
        )
        expect(exit._tag).toBe("Failure")
        expect(String(exit)).toContain(next)
      }),
    ))

  test("verify refuses a schema that is missing a migration the build expects", () =>
    inSchema((db) =>
      Effect.gen(function* () {
        yield* DatabaseMigration.migrate(db)
        yield* db.run(sql`delete from migration where id = ${DatabaseMigration.BASELINE}`)
        const exit = yield* DatabaseMigration.verify(db).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        expect(String(exit)).toContain(DatabaseMigration.BASELINE)
      }),
    ))

  test("migrate skips a named schema that no longer exists, and creates nothing", () =>
    inSchema((db) =>
      Effect.gen(function* () {
        const gone = fresh()
        yield* DatabaseMigration.migrate(db, { schema: gone })
        expect(yield* db.all(sql`select 1 from information_schema.schemata where schema_name = ${gone}`)).toEqual([])
        expect(yield* db.all(sql`select 1 from information_schema.tables where table_schema = ${gone}`)).toEqual([])
      }),
    ))

  test("migrate refuses a schema that has tables but no session table", () =>
    inSchema((db) =>
      Effect.gen(function* () {
        yield* db.run(sql`create table stray (id text)`)
        expect((yield* DatabaseMigration.migrate(db).pipe(Effect.exit))._tag).toBe("Failure")
      }),
    ))

  test("migrateAll brings every schema that holds opencode's tables up to date and skips the rest", () =>
    inSchema((db, first) =>
      Effect.gen(function* () {
        const second = fresh()
        const empty = fresh()
        yield* db.run(`CREATE SCHEMA "${second}"`)
        yield* db.run(`CREATE SCHEMA "${empty}"`)
        yield* Effect.gen(function* () {
          yield* DatabaseMigration.migrate(db)
          yield* DatabaseMigration.migrate(db, { schema: second })
          const visited = yield* DatabaseMigration.migrateAll(db, withPort)
          expect(visited).toContain(first)
          expect(visited).toContain(second)
          expect(visited).not.toContain(empty)
          for (const name of [first, second])
            expect(yield* db.all(sql.raw(`select id from "${name}".marker`))).toEqual([])
          expect(yield* db.all(sql`select 1 from information_schema.tables where table_schema = ${empty}`)).toEqual([])
          expect(yield* db.get<{ name: string }>(sql`select current_schema() as name`)).toEqual({ name: first })
        }).pipe(
          Effect.ensuring(
            Effect.all([
              db.run(`DROP SCHEMA "${second}" CASCADE`).pipe(Effect.ignore),
              db.run(`DROP SCHEMA "${empty}" CASCADE`).pipe(Effect.ignore),
            ]),
          ),
        )
      }),
    ))
})

describe("collation", () => {
  test("accepts the test database, whose collation is byte order", () => inSchema((db) => DatabaseCollation.verify(db)))

  test("refuses a database with a locale collation", async () => {
    const name = `c_${crypto.randomUUID().replaceAll("-", "")}`
    const run = <A>(effect: Effect.Effect<A, unknown, PgClient.PgClient>, database?: string) =>
      effect.pipe(Effect.provide(client("public", database)), Effect.runPromise)
    await run(
      Effect.flatMap(makeDatabase, (db) =>
        db.run(`CREATE DATABASE "${name}" TEMPLATE template0 LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LOCALE 'C.UTF-8'`),
      ),
    )
    try {
      const exit = await run(
        Effect.flatMap(makeDatabase, (db) => DatabaseCollation.verify(db).pipe(Effect.exit)),
        name,
      )
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain("collation")
    } finally {
      await run(Effect.flatMap(makeDatabase, (db) => db.run(`DROP DATABASE "${name}"`)))
    }
  })
})
