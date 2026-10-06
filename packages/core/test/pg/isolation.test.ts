import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import * as PgClient from "@effect/sql-pg/PgClient"
import { sql } from "drizzle-orm"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import { Effect, Layer, Redacted } from "effect"
import "@opencode-ai/effect-drizzle-pg"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { DatabaseProvision } from "@opencode-ai/core/database/provision"

const admin = process.env.OPENCODE_TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5432/postgres"
const makeDatabase = EffectDrizzlePostgres.makeWithDefaults()
const tag = crypto.randomUUID().replaceAll("-", "").slice(0, 12)
const password = "isolation-test-only"

// Two users. Ada has a project scope and a global scope; Ben has a project scope.
const ada = { project: `ada_p_${tag}`, global: `ada_g_${tag}` }
const ben = { project: `ben_p_${tag}` }
const all = [ada.project, ada.global, ben.project]

function as<A, E>(
  login: { role?: string; schema: string },
  body: (db: Effect.Success<typeof makeDatabase>) => Effect.Effect<A, E, PgClient.PgClient>,
) {
  const url = new URL(admin)
  if (login.role) {
    url.username = login.role
    url.password = password
  }
  url.searchParams.set("options", `-c search_path=${login.schema}`)
  return Effect.flatMap(makeDatabase, body).pipe(
    Effect.provide(PgClient.layer({ url: Redacted.make(url.toString()), maxConnections: 1 }).pipe(Layer.orDie)),
    Effect.runPromise,
  )
}

const failed = <A, E>(effect: Effect.Effect<A, E, PgClient.PgClient>) =>
  Effect.map(Effect.exit(effect), (exit) => exit._tag === "Failure")

beforeAll(async () => {
  for (const name of all) {
    await as({ schema: "public" }, (db) => DatabaseProvision.scope(db, { schema: name, role: name, password }))
    await as({ schema: name }, (db) => DatabaseMigration.migrate(db))
    await as({ role: name, schema: name }, (db) =>
      db.run(sql`insert into data_migration (name, time_completed) values (${name}, 1)`),
    )
  }
  await as({ schema: "public" }, (db) => DatabaseProvision.reader(db, { schema: ada.project, role: ada.global }))
})

afterAll(async () => {
  await as({ schema: "public" }, (db) =>
    Effect.gen(function* () {
      for (const name of all) yield* db.run(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)
      for (const name of all) {
        yield* db.run(`DROP OWNED BY "${name}"`).pipe(Effect.ignore)
        yield* db.run(`DROP ROLE IF EXISTS "${name}"`)
      }
    }),
  )
})

const read = (schema: string) => sql.raw(`select name from "${schema}".data_migration`)
const write = (schema: string) => sql.raw(`insert into "${schema}".data_migration (name, time_completed) values ('x', 1)`)

describe("scope isolation", () => {
  test("a scope role reads and writes its own schema", () =>
    as({ role: ada.project, schema: ada.project }, (db) =>
      Effect.gen(function* () {
        expect(yield* db.all(read(ada.project))).toEqual([{ name: ada.project }])
        yield* db.run(sql`update data_migration set time_completed = 2`)
        yield* db.run(sql`delete from data_migration where name = 'nobody'`)
      }),
    ))

  test("a project role cannot read or write another project of the same user, or another user's", () =>
    as({ role: ada.project, schema: ada.project }, (db) =>
      Effect.gen(function* () {
        for (const other of [ada.global, ben.project]) {
          expect(yield* failed(db.all(read(other)))).toBe(true)
          expect(yield* failed(db.run(write(other)))).toBe(true)
        }
      }),
    ))

  test("the global role reads its user's project schema but cannot write it", () =>
    as({ role: ada.global, schema: ada.global }, (db) =>
      Effect.gen(function* () {
        expect(yield* db.all(read(ada.project))).toEqual([{ name: ada.project }])
        expect(yield* failed(db.run(write(ada.project)))).toBe(true)
        expect(yield* failed(db.run(sql.raw(`delete from "${ada.project}".data_migration`)))).toBe(true)
      }),
    ))

  test("the global role cannot reach another user's schema", () =>
    as({ role: ada.global, schema: ada.global }, (db) =>
      Effect.gen(function* () {
        expect(yield* failed(db.all(read(ben.project)))).toBe(true)
      }),
    ))

  test("a scope role cannot change its own schema's structure or create schemas", () =>
    as({ role: ada.project, schema: ada.project }, (db) =>
      Effect.gen(function* () {
        expect(yield* failed(db.run(sql`alter table session add column leak text`))).toBe(true)
        expect(yield* failed(db.run(sql`drop table session`))).toBe(true)
        expect(yield* failed(db.run(sql`create table mine (id text)`))).toBe(true)
        expect(yield* failed(db.run(sql`create schema elsewhere`))).toBe(true)
        expect(yield* failed(db.run(sql`set role postgres`))).toBe(true)
      }),
    ))

  test("a table created by a later migration is readable and writable by the scope role and readable by the reader", async () => {
    await as({ schema: ada.project }, (db) => db.run(sql`create table later (id text)`))
    await as({ role: ada.project, schema: ada.project }, (db) => db.run(sql`insert into later (id) values ('a')`))
    await as({ role: ada.global, schema: ada.global }, (db) =>
      Effect.gen(function* () {
        expect(yield* db.all(sql.raw(`select id from "${ada.project}".later`))).toEqual([{ id: "a" }])
      }),
    )
  })

  test("provisioning twice is harmless, and bad names are refused", async () => {
    await as({ schema: "public" }, (db) => DatabaseProvision.scope(db, { schema: ada.project, role: ada.project }))
    for (const bad of ['a"b', "a b", "A", ""])
      expect(
        await as({ schema: "public" }, (db) => failed(DatabaseProvision.scope(db, { schema: bad, role: ada.project }))),
      ).toBe(true)
  })

  test("a server started as a scope role serves from its own schema", () =>
    as({ role: ada.project, schema: ada.project }, (db) =>
      Effect.gen(function* () {
        yield* DatabaseMigration.verify(db)
        expect(yield* db.get<{ name: string }>(sql`select current_schema() as name`)).toEqual({ name: ada.project })
      }),
    ))
})
