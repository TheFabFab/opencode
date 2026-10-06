# Postgres Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The fork's opencode keeps all database state in Postgres, one schema and role per user scope, with upstream's query code unchanged and upstream's unit suite passing against it.

**Architecture:** The 11 files that declare opencode's tables are converted in place from Drizzle's SQLite builder to its Postgres builder. A small new package, `effect-drizzle-pg`, adds the three SQLite-style terminal methods (`.get()`, `.all()`, `.run()`) to Drizzle's Effect Postgres builders, so about 256 upstream call sites compile and run unchanged. The database service connects with a URL and a schema name; schema work happens only in a separate migrate command, never when a server starts.

**Tech Stack:** Bun 1.3.14, TypeScript (`tsgo`), Effect 4.0.0-beta.83, Drizzle ORM 1.0.0-rc.2 (`drizzle-orm/effect-postgres`), `@effect/sql-pg` 4.0.0-beta.83, `pg` 8.21.0, Postgres 18, `bun:test`.

**Spec:** `documentor/specs/2026-10-06-postgres-core-design.md`

## Global Constraints

- Base: upstream tag `v1.18.34`. Work branch: `documentor-pg`. `documentor` stays on unmodified 1.18.18.
- Postgres 18. The database's collation must be `C`, `POSIX` or `C.UTF-8`; anything else is refused.
- No SQLite: a running server creates no `*.db` file and nothing in `packages/core/src` or `packages/opencode/src` imports `drizzle-orm/sqlite-core`, `bun:sqlite` or `@opencode-ai/effect-drizzle-sqlite`.
- Upstream call sites are not edited to suit Postgres. The complete list of upstream source files this plan may change is in Task 3; any other upstream source edit needs a line in `documentor/FORK.md` saying why.
- Column types: `time_*` and `token_expiry` → `double precision`; other integers → `count()` (`bigint`, read as a JS number, rounds fractions, refuses non-finite numbers); JSON → `jsonb()`; text → `text()`; booleans → `boolean`; `real` → `double precision`. `count`, `jsonb` and `text` come from `@opencode-ai/effect-drizzle-pg`; the last two store NUL as U+FFFD.
- Starting a server never creates, alters or drops anything. Only the migrate command and a test's throwaway schema do.
- A non-local database host is refused unless the URL carries `sslmode=verify-full`.
- Settings: `OPENCODE_DATABASE_URL` (required), `OPENCODE_DATABASE_SCHEMA`, `OPENCODE_DATABASE_POOL_MAX` (default 4). Tests use `OPENCODE_TEST_DATABASE_URL` and `OPENCODE_DATABASE_EPHEMERAL=1`.
- Comments describe how the code is, never what changed.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## What the probe already proved

The throwaway branch `probe/pg-types` on the fork holds a working sketch of Tasks 2 and 3. Read it for reference; do not merge it. On that branch:

- The whole monorepo type-checks after the swap with errors in only one SQLite-specific test file.
- The package from Task 2 exists there as written here, and its tests pass.
- The parity and concurrency tests of Task 8 pass there, as do upstream's pagination tests.
- A server boots against Postgres in its own schema, a session titled `12345` lists correctly, and the 13 prompt-run subprocess tests pass.
- Upstream's core suite gives 1,105 pass and 11 fail on Postgres. The 11 are named in Task 7.
- The compiled binary passes `documentor/scripts/binary-smoke.sh`.
- Thirteen processes starting at once against one empty schema race on table creation and 8 fail. Task 4 removes schema work from start-up for that reason.

## Local Postgres

Tests need a Postgres 18 whose default collation is `C.UTF-8`, reachable as a superuser through `OPENCODE_TEST_DATABASE_URL`. On the DocuMentor dev container there is no Docker and Postgres refuses to run as root; a private copy lives under `/var/tmp/spike-pg` and is started with:

```bash
N=/var/tmp/spike-pg/node_modules/@embedded-postgres/linux-x64/native
runuser -u node -- $N/bin/pg_ctl -D /var/tmp/spike-pg/data -l /var/tmp/spike-pg/pg.log \
  -o "-p 55432 -c listen_addresses=127.0.0.1 -c unix_socket_directories=/var/tmp/spike-pg" -w start
export OPENCODE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/postgres
export PATH="/root/src/tools/bun-1.3.14/node_modules/.bin:$PATH"
```

Elsewhere, `docker run -e POSTGRES_PASSWORD=postgres -e POSTGRES_INITDB_ARGS=--locale=C.UTF-8 -p 5432:5432 postgres:18` and `OPENCODE_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres`.

`bun install` fails the first time on a `tree-sitter-powershell` install script and succeeds when run again.

## Review Focus

Failure modes the spec implies that are most likely to bite a person, most likely first. Each has a test in the task named.

1. **Code that was safe only because SQLite is synchronous.** A read followed by a write with no transaction could not interleave with another fiber on SQLite; on Postgres every query yields. Expected: no lost update or duplicate when two prompts hit one session at once. Test: Task 8, "concurrent appends to one session".
2. **Postgres becomes unreachable while a session is open.** Expected: the request fails with a database error, the process stays up, and the next request succeeds once Postgres is back. Test: Task 5, "recovers after the connection is dropped".
3. **A NUL byte in a plain text column**, for example a model-written session title. Postgres rejects NUL in `text` as well as in `jsonb`. Expected: the write succeeds and the stored title has no NUL. Test: Task 8, "NUL in a text column".
4. **A numeric value SQLite tolerated and Postgres does not**: a fractional token count, `NaN`, or `Infinity` written to a `bigint` column. Expected: fractional counts are rounded, a non-finite number is refused with an error, and the session stays usable. Test: Task 8, "non-integer numbers in count columns".
5. **Two processes started for the same scope**, as during a pod restart overlap. Expected: both run, writes interleave in whole transactions, sequence numbers stay gap-free. Test: Task 8, "two processes on one scope".

One upstream behaviour to keep in mind when probing a server: a request that arrives in the instant `opencode serve` starts listening can be accepted and never answered. Stock 1.18.18 on SQLite does it too (3 to 4 of 80 requests fired at 50 ms intervals from process start). Every readiness probe in this plan therefore carries its own timeout, and the pod packaging design must do the same.

---

### Task 1: Work branch and CI with Postgres

**Files:**

- Modify: `.github/workflows/documentor-ci.yml`
- Carry over from `documentor`: `.github/workflows/documentor-ci.yml`, `.github/workflows/documentor-release.yml`, `documentor/`

**Interfaces:**

- Produces: branch `documentor-pg`; in CI, `OPENCODE_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres` on a Postgres 18 with `C.UTF-8` collation.

- [ ] **Step 1: Create the branch**

```bash
cd /root/src/opencode
git fetch upstream tag v1.18.34
git checkout -b documentor-pg v1.18.34
git checkout documentor -- .github/workflows/documentor-ci.yml .github/workflows/documentor-release.yml documentor
bun install || bun install
```

- [ ] **Step 2: Point CI at the new branch and give the unit job a database**

In `.github/workflows/documentor-ci.yml`, replace both `- documentor` branch entries with:

```yaml
- documentor
- documentor-pg
```

and give the `unit` job a service and the variable, directly under `runs-on: ubuntu-24.04`:

```yaml
services:
  postgres:
    image: postgres:18
    env:
      POSTGRES_PASSWORD: postgres
      POSTGRES_INITDB_ARGS: --locale=C.UTF-8
    ports:
      - 5432:5432
    options: >-
      --health-cmd "pg_isready -U postgres"
      --health-interval 5s
      --health-timeout 5s
      --health-retries 10
env:
  OPENCODE_TEST_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/postgres
```

Add a step before "Run unit tests" that fails fast when the collation is wrong:

```yaml
- name: Check the database collation
  run: |
    collation="$(PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -Atc "select datcollate from pg_database where datname = current_database()")"
    echo "collation: $collation"
    [ "$collation" = "C.UTF-8" ]
```

- [ ] **Step 3: Commit, push and watch**

```bash
git add -A
git commit -m "ci: run the documentor-pg branch against Postgres 18

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push --no-verify -u origin documentor-pg
gh run watch --repo TheFabFab/opencode --exit-status "$(gh run list --repo TheFabFab/opencode --branch documentor-pg --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Expected: `typecheck` and `unit` green on unmodified source. One known flake: `exits nonzero promptly when the model is unknown` asserts under 15 s and can exceed it on hosted runners; rerun the job once if that alone fails.

---

### Task 2: `effect-drizzle-pg` — terminal methods, single-writer transactions, column types

**Files:**

- Create: `packages/effect-drizzle-pg/package.json`
- Create: `packages/effect-drizzle-pg/tsconfig.json`
- Create: `packages/effect-drizzle-pg/src/index.ts`
- Create: `packages/effect-drizzle-pg/src/terminal.ts`
- Create: `packages/effect-drizzle-pg/src/json.ts`
- Create: `packages/effect-drizzle-pg/src/columns.ts`
- Create: `packages/effect-drizzle-pg/test/harness.ts`
- Test: `packages/effect-drizzle-pg/test/terminal.test.ts`
- Test: `packages/effect-drizzle-pg/test/json.test.ts`
- Test: `packages/effect-drizzle-pg/test/columns.test.ts`

**Interfaces:**

- Produces, by importing `@opencode-ai/effect-drizzle-pg` once:
  - on every Drizzle Effect Postgres select, insert, update and delete builder: `.get()` (first row or `undefined`), `.all()` (all rows), `.run()` (void);
  - on the database and on a transaction: `.run(query)`, `.all<T>(query)`, `.get<T>(query)` for raw SQL;
  - `db.transaction(fn, { behavior: "immediate" })`: runs `fn` while holding a transaction-scoped advisory lock keyed on the current schema.
- Produces three column builders, used like Drizzle's own (`text().notNull()`, `jsonb().$type<T>()`):
  - `jsonb` — `jsonb`; stores NUL inside any string as U+FFFD.
  - `text` — `text`; stores NUL as U+FFFD.
  - `count` — `bigint` read as a JS number; rounds a fraction; throws on a non-finite number.
- Produces for tests: `withSchema(body)`, `connect(schema, maxConnections?)`, `adminUrl`, `TestDatabase` from `test/harness.ts`.

- [ ] **Step 1: Create the package manifest and config**

`packages/effect-drizzle-pg/package.json`:

```json
{
  "$schema": "https://json.schemastore.org/package.json",
  "version": "1.18.34",
  "name": "@opencode-ai/effect-drizzle-pg",
  "type": "module",
  "license": "MIT",
  "private": true,
  "scripts": {
    "test": "bun test --timeout 30000 --only-failures",
    "typecheck": "tsgo --noEmit"
  },
  "exports": {
    ".": "./src/index.ts"
  },
  "devDependencies": {
    "@tsconfig/bun": "catalog:",
    "@types/bun": "catalog:",
    "@typescript/native-preview": "catalog:"
  },
  "dependencies": {
    "@effect/sql-pg": "4.0.0-beta.83",
    "drizzle-orm": "catalog:",
    "effect": "catalog:",
    "pg": "8.21.0"
  }
}
```

`packages/effect-drizzle-pg/tsconfig.json`:

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "@tsconfig/bun/tsconfig.json",
  "compilerOptions": {
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "noUncheckedIndexedAccess": false,
    "plugins": [
      {
        "name": "@effect/language-service",
        "transform": "@effect/language-service/transform",
        "namespaceImportPackages": ["effect", "@effect/*"]
      }
    ]
  }
}
```

Run `bun install` from the repository root.

- [ ] **Step 2: Write the test harness**

`packages/effect-drizzle-pg/test/harness.ts`:

```ts
import * as PgClient from "@effect/sql-pg/PgClient"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import { Effect, Layer, Redacted } from "effect"
import "../src/index"

export const adminUrl = process.env.OPENCODE_TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5432/postgres"

const makeDatabase = EffectDrizzlePostgres.makeWithDefaults()
export type TestDatabase = Effect.Success<typeof makeDatabase>

export function connect(schema: string, maxConnections = 2) {
  const url = new URL(adminUrl)
  url.searchParams.set("options", `-c search_path=${schema}`)
  return PgClient.layer({ url: Redacted.make(url.toString()), maxConnections }).pipe(Layer.orDie)
}

/** Runs `body` against a schema that exists only for this call. */
export function withSchema<A, E>(body: (db: TestDatabase, schema: string) => Effect.Effect<A, E, PgClient.PgClient>) {
  const schema = `t_${crypto.randomUUID().replaceAll("-", "")}`
  return Effect.gen(function* () {
    const db = yield* makeDatabase
    yield* db.run(`CREATE SCHEMA "${schema}"`)
    return yield* body(db, schema).pipe(Effect.ensuring(db.run(`DROP SCHEMA "${schema}" CASCADE`).pipe(Effect.ignore)))
  }).pipe(Effect.provide(connect(schema)), Effect.runPromise)
}
```

- [ ] **Step 3: Write the failing terminal tests**

`packages/effect-drizzle-pg/test/terminal.test.ts`:

```ts
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

  test("immediate transactions on one schema never overlap", () =>
    withSchema((db) =>
      Effect.gen(function* () {
        yield* db.run(create)
        yield* db.insert(Item).values({ id: "n", title: "counter", count: 0 }).run()
        const bump = db.transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx.select().from(Item).where(eq(Item.id, "n")).get()
              yield* Effect.sleep("20 millis")
              yield* tx
                .update(Item)
                .set({ count: row!.count + 1 })
                .where(eq(Item.id, "n"))
                .run()
            }),
          { behavior: "immediate" },
        )
        yield* Effect.all([bump, bump, bump, bump], { concurrency: "unbounded" })
        expect((yield* db.select().from(Item).where(eq(Item.id, "n")).get())!.count).toBe(4)
      }),
    ))
})
```

The last test is meaningful: with `behavior: "deferred"` the probe measured 2, not 4.

- [ ] **Step 4: Write the failing JSON tests**

`packages/effect-drizzle-pg/test/json.test.ts`:

```ts
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
```

- [ ] **Step 5: Write the failing column tests**

`packages/effect-drizzle-pg/test/columns.test.ts`:

```ts
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
```

- [ ] **Step 6: Run all three test files to verify they fail**

Run: `cd packages/effect-drizzle-pg && bun test --timeout 30000`
Expected: FAIL — `Cannot find module "../src/index"`.

- [ ] **Step 7: Implement the column types**

`packages/effect-drizzle-pg/src/json.ts`:

```ts
import { customType } from "drizzle-orm/pg-core"

const NUL = /\u0000/g

function scrub(value: unknown): unknown {
  if (typeof value === "string") return value.includes("\u0000") ? value.replace(NUL, "�") : value
  if (Array.isArray(value)) return value.map(scrub)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrub(key), scrub(item)]))
  return value
}

/**
 * A `jsonb` column that accepts any JSON value JavaScript can produce.
 * Postgres rejects the escaped NUL character inside `jsonb` strings, so it is
 * stored as U+FFFD.
 */
export const jsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return "jsonb"
  },
  toDriver(value) {
    return JSON.stringify(scrub(value))
  },
  fromDriver(value) {
    return typeof value === "string" ? JSON.parse(value) : value
  },
})
```

`packages/effect-drizzle-pg/src/columns.ts`:

```ts
import { customType } from "drizzle-orm/pg-core"

/** A `text` column. Postgres cannot store NUL in text, so it is stored as U+FFFD. */
export const text = customType<{ data: string; driverData: string }>({
  dataType() {
    return "text"
  },
  toDriver(value) {
    return typeof value === "string" && value.includes("\u0000") ? value.replaceAll("\u0000", "\uFFFD") : value
  },
})

/**
 * A `bigint` column read as a JS number, for counts and sequence numbers.
 * SQLite stored whatever number it was given; here a fraction is rounded and
 * anything that is not a finite number is refused.
 */
export const count = customType<{ data: number; driverData: string }>({
  dataType() {
    return "bigint"
  },
  toDriver(value) {
    if (!Number.isFinite(value)) throw new Error(`${value} is not a finite number`)
    return String(Math.round(value))
  },
  fromDriver(value) {
    return Number(value)
  },
})
```

- [ ] **Step 8: Implement the terminal methods**

`packages/effect-drizzle-pg/src/terminal.ts`:

```ts
import * as Effect from "effect/Effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { sql } from "drizzle-orm"
import type { Assume, ColumnsSelection, SQL, SQLWrapper, Subquery } from "drizzle-orm"
import type { QueryEffectHKTBase } from "drizzle-orm/effect-core"
import type { PgQueryResultHKT, PgTable } from "drizzle-orm/pg-core"
import type {
  BuildSubquerySelection,
  JoinNullability,
  SelectMode,
  SelectResult,
} from "drizzle-orm/query-builders/select.types"
import type { Join } from "drizzle-orm/pg-core/query-builders/update"
import type { PgViewBase } from "drizzle-orm/pg-core/view-base"
import { PgEffectDatabase } from "drizzle-orm/pg-core/effect/db"
import { PgEffectDeleteBase } from "drizzle-orm/pg-core/effect/delete"
import { PgEffectInsertBase } from "drizzle-orm/pg-core/effect/insert"
import { PgEffectSelectBase } from "drizzle-orm/pg-core/effect/select"
import type { PgEffectTransaction } from "drizzle-orm/pg-core/effect/session"
import { PgEffectUpdateBase } from "drizzle-orm/pg-core/effect/update"

type Rows<T> = T extends Effect.Effect<infer A, any, any> ? (A extends readonly unknown[] ? A : never) : never
type Err<T> = T extends Effect.Effect<any, infer E, any> ? E : never
type Ctx<T> = T extends Effect.Effect<any, any, infer R> ? R : never

/** The three ways opencode's query code ends a builder chain. */
interface Terminal {
  /** The first row, or `undefined` when there is none. */
  get(): Effect.Effect<Rows<this>[number] | undefined, Err<this>, Ctx<this>>
  /** Every row. */
  all(): Effect.Effect<Rows<this>, Err<this>, Ctx<this>>
  /** Runs the statement and discards its result. */
  run(): Effect.Effect<void, Err<this>, Ctx<this>>
}

// Each interface below repeats Drizzle's own type parameters exactly: TypeScript
// merges declarations only when the parameter lists are identical.
declare module "drizzle-orm/pg-core/effect/select" {
  interface PgEffectSelectBase<
    TTableName extends string | undefined,
    TSelection extends ColumnsSelection | undefined,
    TSelectMode extends SelectMode,
    TNullabilityMap extends Record<string, JoinNullability> = TTableName extends string
      ? Record<TTableName, "not-null">
      : {},
    TDynamic extends boolean = false,
    TExcludedMethods extends string = never,
    TResult extends any[] = SelectResult<TSelection, TSelectMode, TNullabilityMap>[],
    TSelectedFields extends ColumnsSelection = BuildSubquerySelection<
      Assume<TSelection, ColumnsSelection>,
      TNullabilityMap
    >,
    TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
  > extends Terminal {}
}
declare module "drizzle-orm/pg-core/effect/insert" {
  interface PgEffectInsertBase<
    TTable extends PgTable,
    TQueryResult extends PgQueryResultHKT,
    TSelectedFields = undefined,
    TReturning = undefined,
    TDynamic extends boolean = false,
    TExcludedMethods extends string = never,
    TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
  > extends Terminal {}
}
declare module "drizzle-orm/pg-core/effect/update" {
  interface PgEffectUpdateBase<
    TTable extends PgTable,
    TQueryResult extends PgQueryResultHKT,
    TFrom extends PgTable | Subquery | PgViewBase | SQL | undefined = undefined,
    TSelectedFields extends ColumnsSelection | undefined = undefined,
    TReturning extends Record<string, unknown> | undefined = undefined,
    TNullabilityMap extends Record<string, JoinNullability> = Record<TTable["_"]["name"], "not-null">,
    TJoins extends Join[] = [],
    TDynamic extends boolean = false,
    TExcludedMethods extends string = never,
    TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
  > extends Terminal {}
}
declare module "drizzle-orm/pg-core/effect/delete" {
  interface PgEffectDeleteBase<
    TTable extends PgTable,
    TQueryResult extends PgQueryResultHKT,
    TSelectedFields extends ColumnsSelection | undefined = undefined,
    TReturning extends Record<string, unknown> | undefined = undefined,
    TDynamic extends boolean = false,
    TExcludedMethods extends string = never,
    TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
  > extends Terminal {}
}
declare module "drizzle-orm/pg-core/effect/db" {
  interface PgEffectDatabase<TEffectHKT, TQueryResult, TRelations> {
    run(query: SQLWrapper | string): Effect.Effect<void, TEffectHKT["error"], TEffectHKT["context"]>
    all<T = unknown>(query: SQLWrapper | string): Effect.Effect<T[], TEffectHKT["error"], TEffectHKT["context"]>
    get<T = unknown>(
      query: SQLWrapper | string,
    ): Effect.Effect<T | undefined, TEffectHKT["error"], TEffectHKT["context"]>
    /**
     * `behavior: "immediate"` and `"exclusive"` mean one writer at a time, as
     * they do in SQLite: the transaction waits for an advisory lock keyed on
     * the current schema before it runs.
     */
    transaction<A, E, R>(
      transaction: (tx: PgEffectTransaction<TEffectHKT, TQueryResult, TRelations>) => Effect.Effect<A, E, R>,
      config: { readonly behavior?: "deferred" | "immediate" | "exclusive" },
    ): Effect.Effect<A, E | SqlError, R>
  }
}

/** Arbitrary constant that namespaces opencode's advisory locks. */
const LOCK_CLASS = 7471

for (const builder of [PgEffectSelectBase, PgEffectInsertBase, PgEffectUpdateBase, PgEffectDeleteBase]) {
  const proto = builder.prototype as any
  proto.get = function (this: Effect.Effect<readonly unknown[]>) {
    return Effect.map(this, (rows) => rows[0])
  }
  proto.all = function (this: Effect.Effect<readonly unknown[]>) {
    return this
  }
  proto.run = function (this: Effect.Effect<unknown>) {
    return Effect.asVoid(this)
  }
}

const database = PgEffectDatabase.prototype as any
database.run = function (query: SQLWrapper | string) {
  return Effect.asVoid(this.execute(query))
}
database.all = function (query: SQLWrapper | string) {
  return this.execute(query)
}
database.get = function (query: SQLWrapper | string) {
  return Effect.map(this.execute(query), (rows: readonly unknown[]) => rows[0])
}

const transaction = database.transaction
database.transaction = function (
  fn: (tx: any) => Effect.Effect<unknown, unknown, unknown>,
  config?: { behavior?: string },
) {
  if (config?.behavior !== "immediate" && config?.behavior !== "exclusive") return transaction.call(this, fn)
  return transaction.call(this, (tx: any) =>
    Effect.flatMap(tx.execute(sql`select pg_advisory_xact_lock(${LOCK_CLASS}, hashtext(current_schema()))`), () =>
      fn(tx),
    ),
  )
}
```

`packages/effect-drizzle-pg/src/index.ts`:

```ts
import "./terminal"

export { count, text } from "./columns"
export { jsonb } from "./json"
```

- [ ] **Step 9: Run tests and type check**

Run: `cd packages/effect-drizzle-pg && bun test --timeout 30000 && bun run typecheck`
Expected: 11 pass, 0 fail; type check prints nothing.

- [ ] **Step 10: Commit**

```bash
git add packages/effect-drizzle-pg bun.lock
git commit -m "feat(effect-drizzle-pg): terminal methods, single-writer transactions and column types

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The swap — Postgres schema, database service, baseline

After this task the monorepo type-checks, a server boots against Postgres, and tests get a throwaway schema per database layer. Start-up still applies the baseline; Task 4 moves that out.

**Files (the complete list of upstream source files this plan changes):**

- Modify by script: `packages/core/src/account/sql.ts`, `control-plane/workspace.sql.ts`, `credential/sql.ts`, `data-migration.sql.ts`, `event/sql.ts`, `permission/sql.ts`, `project/sql.ts`, `session/sql.ts`, `share/sql.ts`, `database/schema.sql.ts`, `database/path.ts` (all under `packages/core/src/`)
- Modify: `packages/core/drizzle.config.ts`
- Modify: `packages/core/package.json` (dependencies)
- Rewrite: `packages/core/src/database/database.ts`
- Modify: `packages/core/src/database/migration.ts`
- Regenerate: `packages/core/src/database/schema.gen.ts`, `packages/core/schema.json`
- Modify: `packages/core/src/project/directories.ts:10,31`
- Modify: `packages/opencode/src/cli/cmd/db.ts` (drop the SQLite shell and `db path`)
- Modify (test helpers): `packages/core/test/preload.ts`, `packages/opencode/test/preload.ts`, `packages/opencode/test/fixture/db.ts`, `packages/opencode/test/server/httpapi-exercise/environment.ts`
- Test: `packages/core/test/pg/boot.test.ts`

**Interfaces:**

- Consumes: `@opencode-ai/effect-drizzle-pg` (Task 2).
- Produces: `Database.Service` with `db` typed as Drizzle's `EffectPgDatabase`; `Database.Client` and `Database.Transaction` types; `Database.node`; `Database.layerFromPath(name)` kept for upstream tests, where the argument is ignored; `DatabaseMigration.apply(db)` which creates the baseline in an empty schema.
- Produces for tests: with `OPENCODE_DATABASE_EPHEMERAL=1`, every build of the database layer creates a schema named `t_<32 hex>`, applies the baseline, and drops the schema when the layer closes.

- [ ] **Step 1: Write the failing boot test**

`packages/core/test/pg/boot.test.ts`:

```ts
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
```

Run: `cd packages/core && OPENCODE_DATABASE_URL=$OPENCODE_TEST_DATABASE_URL OPENCODE_DATABASE_EPHEMERAL=1 bun test test/pg/boot.test.ts`
Expected: FAIL — the first assertion sees no `current_schema` function, because the layer is still SQLite.

- [ ] **Step 2: Convert the table files**

```bash
python3 documentor/scripts/convert-schema.py
```

Expected: eleven `converted …` lines. Running it again prints eleven `unchanged …` lines.

- [ ] **Step 3: Add the dependencies**

In `packages/core/package.json` add to `dependencies`:

```json
    "@effect/sql-pg": "4.0.0-beta.83",
    "@opencode-ai/effect-drizzle-pg": "workspace:*",
    "pg": "8.21.0",
```

and remove `"@opencode-ai/effect-drizzle-sqlite": "workspace:*"` and `"@effect/sql-sqlite-bun": "catalog:"` from the same file. Run `bun install`.

- [ ] **Step 4: Rewrite the database service**

`packages/core/src/database/database.ts`:

```ts
export * as Database from "./database"

import "@opencode-ai/effect-drizzle-pg"
import * as PgClient from "@effect/sql-pg/PgClient"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import { Context, Effect, Layer, Redacted } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { DatabaseMigration } from "./migration"

const makeDatabase = EffectDrizzlePostgres.makeWithDefaults()

export type Client = Effect.Success<typeof makeDatabase>
export type Transaction = Parameters<Parameters<Client["transaction"]>[0]>[0]

export interface Interface {
  db: Client
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/storage/Database") {}

/** Where the process connects, read from the environment when a layer is built. */
function target() {
  const address = process.env.OPENCODE_DATABASE_URL
  if (!address) throw new Error("OPENCODE_DATABASE_URL is not set")
  const ephemeral = process.env.OPENCODE_DATABASE_EPHEMERAL === "1"
  const schema = ephemeral ? `t_${crypto.randomUUID().replaceAll("-", "")}` : process.env.OPENCODE_DATABASE_SCHEMA
  const url = new URL(address)
  if (schema) url.searchParams.set("options", `-c search_path=${schema}`)
  return { url: url.toString(), schema, ephemeral }
}

const layer = Layer.unwrap(
  Effect.sync(() => {
    const { url, schema, ephemeral } = target()
    return Layer.effect(
      Service,
      Effect.gen(function* () {
        const db = yield* makeDatabase
        if (ephemeral) {
          yield* db.run(`CREATE SCHEMA "${schema}"`)
          yield* Effect.addFinalizer(() => db.run(`DROP SCHEMA "${schema}" CASCADE`).pipe(Effect.ignore))
        }
        yield* DatabaseMigration.apply(db)
        return { db }
      }).pipe(Effect.orDie),
    ).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 4 }).pipe(Layer.orDie)))
  }),
)

/**
 * Upstream's tests ask for a database by file name. Every database here is the
 * one the environment names, so the argument is unused.
 */
export function layerFromPath(_filename: string) {
  return layer
}

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
```

- [ ] **Step 5: Point the migration runner at Postgres**

In `packages/core/src/database/migration.ts`:

Replace the two type lines and the import above them with:

```ts
import type { Database as DatabaseService } from "./database"

type Database = DatabaseService.Client
type Transaction = DatabaseService.Transaction
```

Replace the table listing in `apply` with:

```ts
const tables =
  yield *
  db.all<{ name: string }>(
    sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()`,
  )
```

Replace both `(id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)` with `(id TEXT PRIMARY KEY, time_completed DOUBLE PRECISION NOT NULL)`.

In `applyOnly`, delete the whole `if (completed.size === 0) { … }` block. It imports Drizzle's SQLite migration journal, which a Postgres schema never has.

- [ ] **Step 6: Fix the one call site typed against SQLite**

In `packages/core/src/project/directories.ts`, replace

```ts
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
```

with nothing (delete the line), add `Database` to the existing import from `"../database/database"`, and replace

```ts
type DatabaseClient = EffectDrizzleSqlite.EffectSQLiteDatabase
export type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]
```

with

```ts
export type Transaction = Database.Transaction
```

- [ ] **Step 7: Generate the Postgres baseline**

In `packages/core/drizzle.config.ts` set `dialect: "postgresql"` and replace `dbCredentials` with:

```ts
  dbCredentials: {
    url: process.env.OPENCODE_TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5432/postgres",
  },
```

Then:

```bash
cd packages/core
out="$(mktemp -d)"
cat > "$out/config.ts" <<EOF
import config from "$PWD/drizzle.config.ts"
export default { ...config, out: "$out/full" }
EOF
bun drizzle-kit generate --config "$out/config.ts" --name schema
python3 ../../documentor/scripts/render-baseline.py "$out"/full/*/migration.sql src/database/schema.gen.ts
cp "$out"/full/*/snapshot.json schema.json
bunx prettier --write src/database/schema.gen.ts --no-semi --print-width 120
```

Expected: `wrote src/database/schema.gen.ts with 49 statements`, and
`grep -oE '" (bigint|jsonb|boolean|double precision|text)\b' src/database/schema.gen.ts | sort | uniq -c` prints 16 bigint, 2 boolean, 32 double precision, 14 jsonb, 76 text. `packages/core/src/event/sql.ts` now starts with `import { pgTable, index, uniqueIndex } from "drizzle-orm/pg-core"` and `import { count, jsonb, text } from "@opencode-ai/effect-drizzle-pg"`.

- [ ] **Step 8: Make tests ask for a throwaway schema**

In `packages/core/test/preload.ts` replace `process.env.OPENCODE_DB = ":memory:"` with:

```ts
process.env.OPENCODE_DATABASE_URL =
  process.env.OPENCODE_TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5432/postgres"
process.env.OPENCODE_DATABASE_EPHEMERAL = "1"
delete process.env.OPENCODE_DATABASE_SCHEMA
```

In `packages/opencode/test/preload.ts` replace the two lines `// Use in-memory sqlite` and `process.env["OPENCODE_DB"] = ":memory:"` with:

```ts
// Each database layer a test builds gets a schema of its own.
process.env["OPENCODE_DATABASE_URL"] =
  process.env["OPENCODE_TEST_DATABASE_URL"] ?? "postgresql://postgres@127.0.0.1:5432/postgres"
process.env["OPENCODE_DATABASE_EPHEMERAL"] = "1"
delete process.env["OPENCODE_DATABASE_SCHEMA"]
```

- [ ] **Step 9: Remove what referred to a database file**

`Database.path()` is gone, so three places that used it change.

In `packages/opencode/src/cli/cmd/db.ts`: delete `PathCommand`, the `spawn` import, and the `const child = spawn("sqlite3", …)` statement with the `yield*` after it; make the query required by changing `command: "$0 [query]"` to `command: "$0 <query>"` and adding `demandOption: true` to the positional; set the describe text to `"run a SQL query"`; register only the query command: `return yargs.command(QueryCommand).demandCommand()`.

Replace `packages/opencode/test/fixture/db.ts` with:

```ts
import { disposeAllInstances } from "./fixture"

/** Every database layer a test builds has a schema of its own, so disposing the instances is the whole reset. */
export async function resetDatabase() {
  await disposeAllInstances().catch(() => undefined)
}
```

In `packages/opencode/test/server/httpapi-exercise/environment.ts`, replace the block from `const preserveExerciseDatabase` through `Flag.OPENCODE_DB = exerciseDatabasePath` with:

```ts
// The exerciser runs outside `bun test`, so it asks for its own throwaway schema here.
process.env.OPENCODE_DATABASE_URL =
  process.env.OPENCODE_TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5432/postgres"
process.env.OPENCODE_DATABASE_EPHEMERAL = "1"
delete process.env.OPENCODE_DATABASE_SCHEMA
/** Where the exerciser's report says its data lives. */
export const exerciseDatabasePath = "postgres (throwaway schema)"
```

and delete the `if (!preserveExerciseDatabase) { … }` block inside `cleanupExercisePaths`.

- [ ] **Step 10: Run the boot test and the type check**

Run: `cd packages/core && bun test test/pg/boot.test.ts`
Expected: 3 pass.

Run from the root: `bun turbo typecheck --continue 2>&1 | grep "error TS" | sed 's/(.*//' | sort | uniq -c`
Expected: errors only in `packages/core/test/database-migration.test.ts`, which Task 4 replaces.

- [ ] **Step 11: Boot a server and prove there is no SQLite**

```bash
H="$(mktemp -d)"; mkdir "$H/proj"; git -C "$H/proj" init -q
cd packages/opencode
HOME=$H XDG_DATA_HOME=$H/data XDG_CONFIG_HOME=$H/config XDG_CACHE_HOME=$H/cache XDG_STATE_HOME=$H/state \
OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DATABASE_URL=$OPENCODE_TEST_DATABASE_URL OPENCODE_DATABASE_EPHEMERAL=1 \
timeout 40 bun run --conditions=browser ./src/index.ts serve --port 47121 --hostname 127.0.0.1 &
until [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:47121/session?directory=$H/proj")" = 200 ]; do sleep 0.3; done
curl -s -X POST "http://127.0.0.1:47121/session?directory=$H/proj" -H 'content-type: application/json' -d '{"title":"12345"}' >/dev/null
curl -s "http://127.0.0.1:47121/session?directory=$H/proj"
find "$H" -name '*.db*'
```

Expected: the list is a JSON array whose one session has `"title":"12345"`; `find` prints nothing.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat(core): keep database state in Postgres

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Migration lifecycle — verify at start, migrate by command

**Files:**

- Rewrite: `packages/core/src/database/migration.ts`
- Modify: `packages/core/src/database/database.ts` (the `layer` body)
- Create: `packages/core/src/database/collation.ts`
- Create: `packages/core/src/database/connect.ts`
- Modify: `packages/opencode/src/cli/cmd/db.ts`
- Delete: `packages/core/test/database-migration.test.ts`
- Create: `documentor/upstream-test-exceptions.md`
- Test: `packages/core/test/pg/migration.test.ts`

**Interfaces:**

- Consumes: `Database.Client`, `Database.Transaction` (Task 3); `withSchema`-style admin access through `OPENCODE_TEST_DATABASE_URL`.
- Produces:
  - `DatabaseMigration.BASELINE: string` — the id of the newest upstream migration the generated baseline already contains.
  - `DatabaseMigration.Registry` — `{ ids: readonly string[]; ported: Record<string, Migration["up"]> }`; `DatabaseMigration.registry` is the build's own. Every function below takes one optionally, which is how tests exercise a ported migration without adding one.
  - `DatabaseMigration.pending(registry?): string[]` — ids newer than `BASELINE` with no Postgres port.
  - `DatabaseMigration.migrate(db, { schema?, registry? }): Effect<void, unknown>` — under an advisory lock, creates the baseline in an empty schema or applies ported migrations to an existing one. Acts on `schema` when given, else on the connection's current schema. Safe to run concurrently and repeatedly.
  - `DatabaseMigration.migrateAll(db, registry?): Effect<string[], unknown>` — migrates every schema that holds a `migration` table and returns their names.
  - `DatabaseMigration.verify(db, registry?): Effect<void, SchemaNotMigratedError>` — changes nothing.
  - `DatabaseCollation.verify(db): Effect<void, CollationError>`.
  - `DatabaseConnect.run(body, { schema }?)` — runs `body(db, target)` on one connection made from the environment, without the service's start-up checks. With `schema: false` it ignores `OPENCODE_DATABASE_SCHEMA`.
  - CLI: `opencode db migrate` for the schema named by `OPENCODE_DATABASE_SCHEMA`, and `opencode db migrate --all`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/pg/migration.test.ts`:

```ts
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
```

Run: `cd packages/core && bun test test/pg/migration.test.ts`
Expected: FAIL — `database/collation` and `DatabaseMigration.registry` do not exist.

- [ ] **Step 2: Implement the collation check**

`packages/core/src/database/collation.ts`:

```ts
export * as DatabaseCollation from "./collation"

import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "./database"

export class CollationError extends Schema.TaggedErrorClass<CollationError>()("DatabaseCollationError", {
  message: Schema.String,
}) {}

/**
 * opencode pages through sessions and messages by comparing text ids, which
 * sort by creation time only in byte order. A locale collation reorders
 * mixed-case ids, so anything but byte order is refused.
 */
export function verify(db: Database.Client) {
  return Effect.gen(function* () {
    const row = yield* db
      .get<{ provider: string; collate: string | null; locale: string | null }>(
        sql`select datlocprovider as provider, datcollate as "collate", datlocale as locale
            from pg_database where datname = current_database()`,
      )
      .pipe(Effect.orDie)
    const effective = row?.provider === "c" ? row.collate : row?.locale
    if (effective === "C" || effective === "POSIX" || effective === "C.UTF-8") return
    return yield* new CollationError({
      message: `Database collation is ${effective ?? "unknown"} (provider ${row?.provider ?? "unknown"}). opencode needs byte-order collation: create the database with LOCALE 'C.UTF-8' and TEMPLATE template0.`,
    })
  })
}
```

- [ ] **Step 3: Rewrite the migration runner**

`packages/core/src/database/migration.ts`:

```ts
export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "./database"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"

export type Migration = {
  id: string
  up: (tx: Database.Transaction) => Effect.Effect<void, unknown>
}

export class SchemaNotMigratedError extends Schema.TaggedErrorClass<SchemaNotMigratedError>()(
  "DatabaseSchemaNotMigratedError",
  { message: Schema.String },
) {}

/**
 * The newest upstream migration whose effect the generated baseline
 * (`schema.gen.ts`) already contains. Upstream's migration files are SQLite
 * SQL and never run here; ids up to this one are recorded as applied when the
 * baseline is created.
 */
export const BASELINE = "20260622202450_simplify_session_input"

/**
 * Postgres versions of upstream migrations newer than `BASELINE`, keyed by
 * upstream's migration id. An upstream migration with no entry here fails the
 * migration test, which is how a rebase reports that upstream changed the
 * schema.
 */
export const ported: Record<string, Migration["up"]> = {}

/** What a build expects of a schema: every upstream migration id, and the ports of the newer ones. */
export interface Registry {
  readonly ids: readonly string[]
  readonly ported: Readonly<Record<string, Migration["up"]>>
}

export const registry: Registry = { ids: migrations.map((migration) => migration.id), ported }

/** Upstream migration ids that are neither in the baseline nor ported. */
export function pending(input: Registry = registry) {
  return input.ids.filter((id) => id > BASELINE && !(id in input.ported)).sort()
}

/** Arbitrary constant; with the schema's hash it names the migration lock. */
const LOCK_CLASS = 7472

function tables(db: Database.Client | Database.Transaction) {
  return db.all<{ name: string }>(
    sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()`,
  )
}

/**
 * Brings one schema to what `input` expects: the connection's current schema,
 * or `options.schema`. It holds one advisory lock per schema for its whole
 * transaction, so concurrent callers queue and the later ones find the work
 * done.
 */
export function migrate(db: Database.Client, options: { schema?: string; registry?: Registry } = {}) {
  const input = options.registry ?? registry
  const expected = [...input.ids].sort()
  return db.transaction((tx) =>
    Effect.gen(function* () {
      if (options.schema) yield* tx.run(sql`SELECT set_config('search_path', ${options.schema}, true)`)
      yield* tx.run(sql`SELECT pg_advisory_xact_lock(${LOCK_CLASS}, hashtext(current_schema()))`)
      const existing = (yield* tables(tx)).map((table) => table.name)
      if (existing.length > 0 && !existing.includes("session"))
        return yield* Effect.die("Schema is not empty and has no session table")
      if (existing.length === 0) {
        yield* schema.up(tx)
        yield* tx.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed DOUBLE PRECISION NOT NULL)`)
        for (const id of expected.filter((id) => id <= BASELINE))
          yield* tx.run(sql`INSERT INTO migration (id, time_completed) VALUES (${id}, ${Date.now()})`)
      }
      const completed = new Set((yield* tx.all<{ id: string }>(sql`SELECT id FROM migration`)).map((row) => row.id))
      for (const id of expected) {
        if (completed.has(id)) continue
        const up = input.ported[id]
        if (!up) return yield* Effect.die(`Upstream migration ${id} has no Postgres port`)
        yield* up(tx)
        yield* tx.run(sql`INSERT INTO migration (id, time_completed) VALUES (${id}, ${Date.now()})`)
      }
    }),
  )
}

/** Migrates every schema that already holds opencode's tables. Returns their names. */
export function migrateAll(db: Database.Client, input: Registry = registry) {
  return Effect.gen(function* () {
    const schemas = (yield* db.all<{ name: string }>(
      sql`SELECT table_schema AS name FROM information_schema.tables WHERE table_name = 'migration' ORDER BY 1`,
    )).map((row) => row.name)
    for (const name of schemas) yield* migrate(db, { schema: name, registry: input })
    return schemas
  })
}

/** Fails unless the current schema holds every migration `input` expects. Changes nothing. */
export function verify(db: Database.Client, input: Registry = registry) {
  return Effect.gen(function* () {
    const present = (yield* tables(db).pipe(Effect.orDie)).some((table) => table.name === "migration")
    const completed = present
      ? new Set((yield* db.all<{ id: string }>(sql`SELECT id FROM migration`).pipe(Effect.orDie)).map((row) => row.id))
      : new Set<string>()
    const missing = [...input.ids].sort().filter((id) => !completed.has(id))
    if (missing.length === 0) return
    return yield* new SchemaNotMigratedError({
      message: `The database schema is not migrated for this build (missing ${missing.length}, first: ${missing[0]}). Run "opencode db migrate" against this schema before starting a server.`,
    })
  })
}
```

- [ ] **Step 4: Make start-up verify and stop migrating**

In `packages/core/src/database/database.ts`, add the import `import { DatabaseCollation } from "./collation"` and replace the body of the inner `Effect.gen` with:

```ts
const db = yield * makeDatabase
if (ephemeral) {
  yield * db.run(`CREATE SCHEMA "${schema}"`)
  yield * Effect.addFinalizer(() => db.run(`DROP SCHEMA "${schema}" CASCADE`).pipe(Effect.ignore))
  yield * DatabaseMigration.migrate(db)
}
yield * DatabaseCollation.verify(db)
yield * DatabaseMigration.verify(db)
return { db }
```

- [ ] **Step 5: Add a connection for commands, and the migrate command**

`packages/core/src/database/connect.ts`:

```ts
export * as DatabaseConnect from "./connect"

import "@opencode-ai/effect-drizzle-pg"
import * as PgClient from "@effect/sql-pg/PgClient"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import { Effect, Layer, Redacted } from "effect"
import type { Database } from "./database"

/** Where a command connects: the URL with the schema folded in, and the schema's name. */
export interface Target {
  readonly url: string
  readonly schema: string | undefined
}

function read(useSchema: boolean): Target {
  const address = process.env.OPENCODE_DATABASE_URL
  if (!address) throw new Error("OPENCODE_DATABASE_URL is not set")
  const schema = useSchema ? process.env.OPENCODE_DATABASE_SCHEMA || undefined : undefined
  const url = new URL(address)
  if (schema) url.searchParams.set("options", `-c search_path=${schema}`)
  return { url: url.toString(), schema }
}

/**
 * Runs `body` on one connection made from the environment, without the checks
 * `Database.Service` makes. The migrate and provision commands need this: the
 * service refuses a schema that is not migrated yet.
 *
 * With `schema: false` the connection ignores `OPENCODE_DATABASE_SCHEMA` and
 * uses the role's own search path.
 */
export function run<A, E>(
  body: (db: Database.Client, target: Target) => Effect.Effect<A, E, PgClient.PgClient>,
  options: { readonly schema: boolean } = { schema: true },
): Effect.Effect<A, E> {
  return Effect.suspend(() => {
    const target = read(options.schema)
    return Effect.flatMap(EffectDrizzlePostgres.makeWithDefaults(), (db) => body(db, target)).pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(target.url), maxConnections: 1 }).pipe(Layer.orDie)),
    )
  })
}
```

Replace `packages/opencode/src/cli/cmd/db.ts` with:

```ts
import type { Argv } from "yargs"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { DatabaseCollation } from "@opencode-ai/core/database/collation"
import { DatabaseConnect } from "@opencode-ai/core/database/connect"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { cmd } from "./cmd"

// These commands run outside the application runtime. The runtime builds
// `Database.Service`, which refuses a schema that is not migrated, and these
// are the commands that create and migrate schemas.
const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect)

const QueryCommand = cmd({
  command: "$0 <query>",
  describe: "run a SQL query",
  builder: (yargs: Argv) =>
    yargs
      .positional("query", { type: "string", demandOption: true, describe: "SQL query to execute" })
      .option("format", { type: "string", choices: ["json", "tsv"], default: "tsv", describe: "Output format" }),
  async handler(args) {
    const result = await run(DatabaseConnect.run((db) => db.all<Record<string, unknown>>(sql.raw(args.query))))
    if (args.format === "json") console.log(JSON.stringify(result, null, 2))
    else if (result.length > 0) {
      const keys = Object.keys(result[0])
      console.log(keys.join("\t"))
      for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
    }
  },
})

const MigrateCommand = cmd({
  command: "migrate",
  describe: "bring the schema named by OPENCODE_DATABASE_SCHEMA, or every schema with --all, up to date",
  builder: (yargs: Argv) =>
    yargs.option("all", {
      type: "boolean",
      default: false,
      describe: "migrate every schema that holds opencode's tables",
    }),
  async handler(args) {
    const done = await run(
      DatabaseConnect.run(
        (db, target) =>
          Effect.gen(function* () {
            yield* DatabaseCollation.verify(db)
            if (args.all) return yield* DatabaseMigration.migrateAll(db)
            yield* DatabaseMigration.migrate(db)
            yield* DatabaseMigration.verify(db)
            return [target.schema ?? "(default)"]
          }),
        { schema: !args.all },
      ),
    )
    console.log(`up to date: ${done.length === 0 ? "no schemas found" : done.join(", ")}`)
  },
})

export const DbCommand = cmd({
  command: "db",
  describe: "database tools",
  builder: (yargs: Argv) => yargs.command(QueryCommand).command(MigrateCommand).demandCommand(),
  handler() {},
})
```

The commands use yargs' plain `cmd`, not `effectCmd`: `effectCmd` runs its handler inside the application runtime, and that runtime builds `Database.Service`, which fails on exactly the schemas these commands exist to fix. The probe hit this — `db provision` against a fresh database died with "schema is not migrated".

- [ ] **Step 6: Replace upstream's SQLite migration tests**

```bash
git rm packages/core/test/database-migration.test.ts
```

Create `documentor/upstream-test-exceptions.md`:

```markdown
# Upstream tests the fork does not run

Each entry is an upstream test file or case that is absent or changed on
`documentor-pg`, with the reason. A rebase that brings one back must either
make it pass on Postgres or keep it listed here.

| Upstream test                                   | State   | Reason                                                                         | Replaced by                               |
| ----------------------------------------------- | ------- | ------------------------------------------------------------------------------ | ----------------------------------------- |
| `packages/core/test/database-migration.test.ts` | Deleted | Tests SQLite's file journal and the import of Drizzle's SQLite migration table | `packages/core/test/pg/migration.test.ts` |
```

- [ ] **Step 7: Run**

Run: `cd packages/core && bun test test/pg/ && cd ../.. && bun turbo typecheck`
Expected: all pass, 13 of them in `migration.test.ts`; type check clean across all packages.

- [ ] **Step 8: Prove a server refuses an unmigrated schema and starts after migrating**

```bash
cd packages/opencode
export OPENCODE_DATABASE_URL=$OPENCODE_TEST_DATABASE_URL OPENCODE_DATABASE_SCHEMA=plan_task4
psql "$OPENCODE_TEST_DATABASE_URL" -c 'DROP SCHEMA IF EXISTS plan_task4 CASCADE' -c 'CREATE SCHEMA plan_task4'
timeout 20 bun run --conditions=browser ./src/index.ts serve --port 47122 --hostname 127.0.0.1; echo "exit=$?"
bun run --conditions=browser ./src/index.ts db migrate
timeout 8 bun run --conditions=browser ./src/index.ts serve --port 47122 --hostname 127.0.0.1; echo "exit=$?"
```

Expected: the first `serve` exits non-zero and prints `Run "opencode db migrate"`; `db migrate` prints `up to date: plan_task4`; the second `serve` prints `opencode server listening` and ends with `exit=124` from `timeout`. Where there is no `psql`, run the two SQL statements with `bun run --conditions=browser ./src/index.ts db "<sql>"` against a migrated schema.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(core): migrate by command and verify the schema at start

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Connection settings — required URL, verified TLS, pool size, recovery

**Files:**

- Create: `packages/core/src/database/target.ts`
- Modify: `packages/core/src/database/database.ts` (use `DatabaseTarget.read`)
- Modify: `packages/core/src/database/connect.ts` (use `DatabaseTarget.read`)
- Modify: `packages/core/src/flag/flag.ts` (remove `OPENCODE_DB`)
- Test: `packages/core/test/pg/target.test.ts`
- Test: `packages/core/test/pg/recovery.test.ts`

**Interfaces:**

- Produces: `DatabaseTarget.read(env): { url: string; schema: string | undefined; ephemeral: boolean; maxConnections: number }`, which throws `DatabaseTarget.InvalidTargetError` with a message naming the setting at fault.

- [ ] **Step 1: Write the failing settings tests**

`packages/core/test/pg/target.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { DatabaseTarget } from "@opencode-ai/core/database/target"

const read = (env: Record<string, string | undefined>) => DatabaseTarget.read(env)

describe("database target", () => {
  test("requires a URL", () => {
    expect(() => read({})).toThrow("OPENCODE_DATABASE_URL")
  })

  test("accepts a loopback host without TLS", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"])
      expect(read({ OPENCODE_DATABASE_URL: `postgresql://u@${host}:5432/db` }).maxConnections).toBe(4)
  })

  test("refuses a remote host without verified TLS", () => {
    for (const suffix of ["", "?sslmode=require", "?sslmode=prefer", "?sslmode=verify-ca", "?sslmode=disable"])
      expect(() => read({ OPENCODE_DATABASE_URL: `postgresql://u@db.internal:5432/db${suffix}` })).toThrow(
        "sslmode=verify-full",
      )
  })

  test("accepts a remote host with sslmode=verify-full", () => {
    expect(read({ OPENCODE_DATABASE_URL: "postgresql://u@db.internal:5432/db?sslmode=verify-full" }).url).toContain(
      "sslmode=verify-full",
    )
  })

  test("sends the schema as the search path", () => {
    const target = read({ OPENCODE_DATABASE_URL: "postgresql://u@127.0.0.1/db", OPENCODE_DATABASE_SCHEMA: "scope_a" })
    expect(target.schema).toBe("scope_a")
    expect(new URL(target.url).searchParams.get("options")).toBe("-c search_path=scope_a")
  })

  test("refuses a schema name that is not a plain identifier", () => {
    for (const schema of ["a b", 'a"b', "a;drop", "A", "1a", "a".repeat(64), "public,other"])
      expect(() =>
        read({ OPENCODE_DATABASE_URL: "postgresql://u@127.0.0.1/db", OPENCODE_DATABASE_SCHEMA: schema }),
      ).toThrow("OPENCODE_DATABASE_SCHEMA")
  })

  test("an ephemeral target gets a fresh schema each time and ignores the configured one", () => {
    const env = {
      OPENCODE_DATABASE_URL: "postgresql://u@127.0.0.1/db",
      OPENCODE_DATABASE_EPHEMERAL: "1",
      OPENCODE_DATABASE_SCHEMA: "scope_a",
    }
    const first = read(env)
    expect(first.ephemeral).toBe(true)
    expect(first.schema).toMatch(/^t_[0-9a-f]{32}$/)
    expect(read(env).schema).not.toBe(first.schema)
  })

  test("reads the pool size and refuses a bad one", () => {
    const url = "postgresql://u@127.0.0.1/db"
    expect(read({ OPENCODE_DATABASE_URL: url, OPENCODE_DATABASE_POOL_MAX: "2" }).maxConnections).toBe(2)
    for (const bad of ["0", "-1", "1.5", "many", "101"])
      expect(() => read({ OPENCODE_DATABASE_URL: url, OPENCODE_DATABASE_POOL_MAX: bad })).toThrow(
        "OPENCODE_DATABASE_POOL_MAX",
      )
  })

  test("never puts the password in an error", () => {
    try {
      read({ OPENCODE_DATABASE_URL: "postgresql://u:hunter2@db.internal/db" })
      throw new Error("expected a refusal")
    } catch (error) {
      expect(String(error)).not.toContain("hunter2")
    }
  })
})
```

Run: `cd packages/core && bun test test/pg/target.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Implement**

`packages/core/src/database/target.ts`:

```ts
export * as DatabaseTarget from "./target"

export class InvalidTargetError extends Error {
  override readonly name = "DatabaseInvalidTargetError"
}

export interface Target {
  /** Connection URL, with the schema folded in as the search path. Holds the password. */
  readonly url: string
  readonly schema: string | undefined
  /** The schema is created for this layer and dropped when it closes. Tests only. */
  readonly ephemeral: boolean
  readonly maxConnections: number
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

/** Reads where this process connects. Throws `InvalidTargetError` naming the setting at fault. */
export function read(env: Record<string, string | undefined> = process.env): Target {
  const address = env.OPENCODE_DATABASE_URL
  if (!address) throw new InvalidTargetError("OPENCODE_DATABASE_URL is not set")
  const url = (() => {
    try {
      return new URL(address)
    } catch {
      throw new InvalidTargetError("OPENCODE_DATABASE_URL is not a valid URL")
    }
  })()
  if (!LOOPBACK.has(url.hostname) && url.searchParams.get("sslmode") !== "verify-full")
    throw new InvalidTargetError(
      `OPENCODE_DATABASE_URL names the remote host ${url.hostname} without sslmode=verify-full`,
    )

  const ephemeral = env.OPENCODE_DATABASE_EPHEMERAL === "1"
  const schema = ephemeral ? `t_${crypto.randomUUID().replaceAll("-", "")}` : env.OPENCODE_DATABASE_SCHEMA || undefined
  if (schema !== undefined && !IDENTIFIER.test(schema))
    throw new InvalidTargetError(
      "OPENCODE_DATABASE_SCHEMA must be 1 to 63 characters of a-z, 0-9 and _, not starting with a digit",
    )
  if (schema) url.searchParams.set("options", `-c search_path=${schema}`)

  const pool = env.OPENCODE_DATABASE_POOL_MAX
  const maxConnections = pool === undefined || pool === "" ? 4 : Number(pool)
  if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 100)
    throw new InvalidTargetError("OPENCODE_DATABASE_POOL_MAX must be a whole number from 1 to 100")

  return { url: url.toString(), schema, ephemeral, maxConnections }
}
```

In `packages/core/src/database/database.ts` delete the local `target()` function, import `DatabaseTarget`, and start the `Effect.sync` with `const { url, schema, ephemeral, maxConnections } = DatabaseTarget.read()`; pass `maxConnections` to `PgClient.layer`.

In `packages/core/src/database/connect.ts` delete the local `Target` interface and `read` function, import `DatabaseTarget` from `./target`, type `body`'s second parameter as `DatabaseTarget.Target`, and replace `const target = read(options.schema)` with:

```ts
const target = DatabaseTarget.read(
  options.schema ? process.env : { ...process.env, OPENCODE_DATABASE_SCHEMA: undefined },
)
```

Commands then refuse a remote host without verified TLS, as a server does.

In `packages/core/src/flag/flag.ts` delete the line `OPENCODE_DB: process.env["OPENCODE_DB"],`. Nothing reads it after Task 3.

- [ ] **Step 3: Write the recovery test**

`packages/core/test/pg/recovery.test.ts`:

```ts
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
```

Run: `bun test test/pg/target.test.ts test/pg/recovery.test.ts`
Expected: 10 pass (9 and 1). On the probe the five attempts read `Failure, Failure, Success, Success, Success`: the queries that meet the dead connection fail, the pool replaces it, and later queries succeed. That is the behaviour to keep. A request that hits the gap gets a database error; nothing retries a write on its behalf, because a retried write could apply twice.

- [ ] **Step 4: Confirm nothing in the runtime reaches SQLite**

Run: `grep -rnE 'drizzle-orm/sqlite-core|bun:sqlite|node:sqlite|effect-drizzle-sqlite|"#sqlite"|OPENCODE_DB\b' packages/core/src packages/opencode/src packages/server/src packages/cli/src | grep -vE 'packages/core/src/database/sqlite\.(bun|node)?\.?ts'`
Expected: no output. `packages/core/src/database/sqlite*.ts` stay in the tree, unreferenced, so a rebase does not meet a modify/delete conflict.

- [ ] **Step 5: Type check, run, commit**

Run: `bun turbo typecheck && cd packages/core && bun test test/pg/`
Expected: clean; all pass.

```bash
git add -A
git commit -m "feat(core): require a database URL with verified TLS for remote hosts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Scope provisioning and isolation

**Files:**

- Create: `packages/core/src/database/provision.ts`
- Modify: `packages/opencode/src/cli/cmd/db.ts` (two commands)
- Test: `packages/core/test/pg/isolation.test.ts`

**Interfaces:**

- Consumes: `Database.Client`, `DatabaseMigration.migrate`, `DatabaseConnect.run`.
- Produces, all taking an administrator's `Database.Client`:
  - `DatabaseProvision.scope(db, { schema, role, password? })` — creates the role if absent (with login; `password` required then), creates the schema, and grants the role read and write on its tables, present and future. Does not migrate.
  - `DatabaseProvision.reader(db, { schema, role })` — grants `role` read-only access to `schema`, present and future tables.
  - Names are validated with the same identifier rule as `OPENCODE_DATABASE_SCHEMA`.
- CLI: `opencode db provision --schema S --role R` (password from `OPENCODE_DATABASE_ROLE_PASSWORD`), `opencode db grant-read --schema S --role R`. Both connect with `OPENCODE_DATABASE_URL` as the administrator and ignore `OPENCODE_DATABASE_SCHEMA`.

- [ ] **Step 1: Write the failing isolation tests**

`packages/core/test/pg/isolation.test.ts`:

```ts
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
const write = (schema: string) =>
  sql.raw(`insert into "${schema}".data_migration (name, time_completed) values ('x', 1)`)

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
```

These tests log in as the scope roles. The CI service and the local Postgres accept the password set at provisioning; a local cluster in `trust` mode accepts any.

Run: `cd packages/core && bun test test/pg/isolation.test.ts`
Expected: FAIL — `database/provision` does not exist.

- [ ] **Step 2: Implement provisioning**

`packages/core/src/database/provision.ts`:

```ts
export * as DatabaseProvision from "./provision"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "./database"

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

function name(kind: string, value: string) {
  return IDENTIFIER.test(value)
    ? Effect.succeed(`"${value}"`)
    : Effect.die(`${kind} must be 1 to 63 characters of a-z, 0-9 and _, not starting with a digit`)
}

/**
 * Gives one scope a schema and a login role limited to it.
 *
 * The caller's role owns the schema and its tables, so the scope role can read
 * and write rows but cannot alter, drop or create anything. Tables created
 * later by the same caller are covered by default privileges.
 */
export function scope(db: Database.Client, input: { schema: string; role: string; password?: string }) {
  return Effect.gen(function* () {
    const schema = yield* name("schema", input.schema)
    const role = yield* name("role", input.role)
    const exists = yield* db.get(sql`select 1 as found from pg_roles where rolname = ${input.role}`)
    if (!exists) {
      if (!input.password) return yield* Effect.die(`role ${input.role} does not exist and no password was given`)
      // CREATE ROLE takes no bind parameters; the literal is escaped by Postgres' own quoting function.
      const literal = (yield* db.get<{ value: string }>(sql`select quote_literal(${input.password}) as value`))!.value
      yield* db.run(`CREATE ROLE ${role} LOGIN NOINHERIT NOCREATEDB NOCREATEROLE PASSWORD ${literal}`)
    }
    yield* db.run(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    yield* db.run(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`)
    yield* db.run(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`)
    yield* db.run(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`)
    yield* db.run(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    )
  }).pipe(Effect.orDie)
}

/** Lets `role` read every table in `schema`, present and future, and nothing more. */
export function reader(db: Database.Client, input: { schema: string; role: string }) {
  return Effect.gen(function* () {
    const schema = yield* name("schema", input.schema)
    const role = yield* name("role", input.role)
    yield* db.run(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`)
    yield* db.run(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`)
    yield* db.run(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT ON TABLES TO ${role}`)
  }).pipe(Effect.orDie)
}
```

- [ ] **Step 3: Add the two commands**

In `packages/opencode/src/cli/cmd/db.ts` add `import { DatabaseProvision } from "@opencode-ai/core/database/provision"` and, above `DbCommand`:

```ts
const names = (yargs: Argv) =>
  yargs
    .option("schema", { type: "string", demandOption: true, describe: "the scope's schema" })
    .option("role", { type: "string", demandOption: true, describe: "the role to grant" })

const ProvisionCommand = cmd({
  command: "provision",
  describe: "create a scope's schema and role; the role's password is read from OPENCODE_DATABASE_ROLE_PASSWORD",
  builder: names,
  async handler(args) {
    await run(
      DatabaseConnect.run(
        (db) =>
          DatabaseProvision.scope(db, {
            schema: args.schema,
            role: args.role,
            password: process.env.OPENCODE_DATABASE_ROLE_PASSWORD,
          }),
        { schema: false },
      ),
    )
    console.log(`scope ${args.schema} is provisioned for role ${args.role}`)
  },
})

const GrantReadCommand = cmd({
  command: "grant-read",
  describe: "let a role read a scope's schema",
  builder: names,
  async handler(args) {
    await run(
      DatabaseConnect.run((db) => DatabaseProvision.reader(db, { schema: args.schema, role: args.role }), {
        schema: false,
      }),
    )
    console.log(`role ${args.role} can read ${args.schema}`)
  },
})
```

Register both in `DbCommand`'s builder after `.command(MigrateCommand)`. The password comes from the environment so it never appears in a process listing.

- [ ] **Step 4: Run, type check, commit**

Run: `cd packages/core && bun test test/pg/isolation.test.ts && cd ../.. && bun turbo typecheck`
Expected: 8 pass; clean.

```bash
git add -A
git commit -m "feat(core): provision a schema and role per scope

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Upstream's unit suite on Postgres

**Files:**

- Modify: `documentor/upstream-test-exceptions.md`
- Modify (expected, test-only): `packages/core/test/session-runner.test.ts`
- Modify: `.github/workflows/documentor-ci.yml` (timeouts only if needed)

**Interfaces:**

- Consumes: everything above.
- Produces: `bun turbo test` green on `documentor-pg`, locally and in CI, with every deviation from upstream's tests listed in `documentor/upstream-test-exceptions.md`.

With Tasks 2 to 6 in place the probe measured the core suite at 1,105 pass and 11 fail on Postgres:

| Group                                                     | Count | Expected cause                                                                                                                                                                                                                     |
| --------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionRunnerLLM`                                        | 8     | Five assert what a forked fiber has done the moment `session.prompt` returns. On SQLite every query is synchronous, so the fork had always run; on Postgres each query yields. Three (`durably closes partial …`) time out at 30 s |
| `Integration > completes auto OAuth in the background`    | 1     | Not yet examined                                                                                                                                                                                                                   |
| `util.flock`, `util.effect-flock` "unwritable lock roots" | 2     | The probe ran as root, for whom no directory is unwritable. They pass as a normal user, as in CI                                                                                                                                   |

The opencode package's suite had not finished on the probe when this plan was written; expect its own list.

- [ ] **Step 1: Run both suites and save the failures**

```bash
cd packages/core && bun test --timeout 30000 2>&1 | tee /tmp/core.log | grep -E '^\(fail\)|^ +[0-9]+ (pass|fail)'
cd ../opencode && bun test --timeout 30000 2>&1 | tee /tmp/opencode.log | grep -E '^\(fail\)|^ +[0-9]+ (pass|fail)'
```

- [ ] **Step 2: Classify every failure**

For each `(fail)` line, rerun the file alone: `bun test --timeout 30000 <file>`. A test that passes alone and fails only in the full run is load; rerun the full suite once before spending time on it. For the rest, read the assertion and decide which of these it is, in this order:

1. **The product races.** Two operations that must not interleave now can, and a user could see it: a lost update, a duplicate, an event out of order, a prompt that never starts. Fix the product code by putting the read and the write in one transaction (use `{ behavior: "immediate" }` where upstream already does for the same table), add a test that fails without the fix, and record the change in `documentor/FORK.md`.
2. **The test assumes synchronous scheduling.** The product reaches the right state, but the test looks before a forked fiber has run. Change the test to wait for the state it asserts. For a counter that a background fiber fills, poll:

```ts
const eventually = <A>(read: () => A, done: (value: A) => boolean) =>
  Effect.suspend(() => (done(read()) ? Effect.succeed(read()) : Effect.fail("not yet"))).pipe(
    Effect.retry({ times: 200, schedule: Schedule.spaced("10 millis") }),
    Effect.orDie,
  )

yield *
  eventually(
    () => requests.length,
    (count) => count === 1,
  )
expect(requests).toHaveLength(1)
```

3. **The test is about SQLite.** Delete it and write the Postgres equivalent under `test/pg/`.

Decide (1) before (2): a test that passes after adding a wait may be hiding a real race. For each `SessionRunnerLLM` case, read what `session.prompt` promises its caller in `packages/core/src/session.ts` before choosing.

The three `durably closes partial … when the provider stream is interrupted` cases time out at 30 s instead of failing an assertion. Treat them as (1) until shown otherwise: find what the test waits for, and check whether the interrupted fiber's closing write is itself interrupted now that the write is asynchronous. If it is, the fix is to make that write uninterruptible (`Effect.uninterruptible`) in the product.

- [ ] **Step 3: Record every deviation**

Add a row to `documentor/upstream-test-exceptions.md` for each test changed or deleted, with the file, the case name, `Changed` or `Deleted`, and the reason in one sentence. A product fix gets a row in `documentor/FORK.md` instead.

- [ ] **Step 4: Run the whole gate twice**

Run from the root, twice: `GITHUB_ACTIONS=false bun turbo test --force`
Expected: both runs green. A test that passes once and fails once is not done.

- [ ] **Step 5: Commit, push, watch CI**

```bash
git add -A
git commit -m "test: run upstream's unit suite against Postgres

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push --no-verify
gh run watch --repo TheFabFab/opencode --exit-status "$(gh run list --repo TheFabFab/opencode --branch documentor-pg --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Expected: green. If the unit step runs past its 30-minute limit, raise `timeout-minutes` to 45; each database layer a test builds now creates 19 tables.

---

### Task 8: Parity tests for what SQLite tolerated

**Files:**

- Test: `packages/opencode/test/pg/parity.test.ts`
- Test: `packages/opencode/test/pg/concurrency.test.ts`

**Interfaces:**

- Consumes: `Database.Service`, the session and message services, `packages/opencode/test/lib/cli-process.ts` (upstream's subprocess harness with a scripted model).
- Produces: tests that pin, through the session service, what Task 2's column types and Task 4's collation check guarantee.

- [ ] **Step 1: Write the parity tests**

`packages/opencode/test/pg/parity.test.ts`. The header and the two helpers are the ones `packages/opencode/test/session/messages-pagination.test.ts` uses:

```ts
import { describe, expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([SessionNs.node, MessageV2.node, SessionProjector.node, Database.node])),
)

const withSession = <A, E, R>(
  fn: (input: { session: SessionNs.Interface; sessionID: SessionID }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      return { session, sessionID: created.id }
    }),
    fn,
    (input) => input.session.remove(input.sessionID).pipe(Effect.ignore),
  )

const fill = Effect.fn("Test.fill")(function* (sessionID: SessionID, count: number, time: (i: number) => number) {
  const session = yield* SessionNs.Service
  const ids = [] as MessageID[]
  for (let i = 0; i < count; i++) {
    const id = MessageID.ascending()
    ids.push(id)
    yield* session.updateMessage({
      id,
      sessionID,
      role: "user",
      time: { created: time(i) },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    } as unknown as SessionV1.Info)
    yield* session.updatePart({ id: PartID.ascending(), sessionID, messageID: id, type: "text", text: `m${i}` })
  }
  return ids
})
```

The cases, inside `describe("values SQLite tolerated", () => { … })`:

```ts
it.instance("all-digit strings stay strings", () =>
  withSession(({ session, sessionID }) =>
    Effect.gen(function* () {
      yield* session.setTitle({ sessionID, title: "12345" })
      const listed = yield* session.list()
      expect(listed.find((item) => item.id === sessionID)?.title).toBe("12345")
    }),
  ),
)

it.instance("NUL in a text column", () =>
  withSession(({ session, sessionID }) =>
    Effect.gen(function* () {
      yield* session.setTitle({ sessionID, title: "before\u0000after" })
      const read = yield* session.get(sessionID)
      expect(read.title).toBe("before\uFFFDafter")
    }),
  ),
)

it.instance("message times keep fractions and page in order", () =>
  withSession(({ sessionID }) =>
    Effect.gen(function* () {
      const ids = yield* fill(sessionID, 4, (i: number) => 1000.5 + i)
      const first = yield* MessageV2.page({ sessionID, limit: 2 })
      const second = yield* MessageV2.page({ sessionID, limit: 2, before: first.cursor! })
      expect(first.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
      expect(second.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))
    }),
  ),
)

it.instance("text compares in byte order, so mixed-case ids sort by creation", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const row = yield* db.get<{ sorted: string[]; below: boolean }>(sql`
      select array_agg(id order by id) as sorted, 'ses_B' < 'ses_a' as below
      from unnest(array['ses_b', 'ses_B', 'ses_a', 'ses_A', 'ses_0']) as id
    `)
    expect(row).toEqual({ sorted: ["ses_0", "ses_A", "ses_B", "ses_a", "ses_b"], below: true })
  }),
)

it.instance("non-integer numbers in count columns", () =>
  withSession(({ sessionID }) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.update(SessionTable).set({ tokens_input: 10.6 }).where(eq(SessionTable.id, sessionID)).run()
      expect((yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())!.tokens_input).toBe(11)
      const exit = yield* Effect.suspend(() =>
        db.update(SessionTable).set({ tokens_input: Number.NaN }).where(eq(SessionTable.id, sessionID)).run(),
      ).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      const session = yield* SessionNs.Service
      expect((yield* session.get(sessionID)).id).toBe(sessionID)
    }),
  ),
)

it.instance("cost keeps full double precision", () =>
  withSession(({ sessionID }) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ cost: 0.1 + 0.2 })
        .where(eq(SessionTable.id, sessionID))
        .run()
      expect((yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())!.cost).toBe(0.1 + 0.2)
    }),
  ),
)
```

Run: `cd packages/opencode && bun test --timeout 30000 test/pg/parity.test.ts`
Expected: all pass; the column types from Task 2 already give this behaviour, and these tests pin it at the level a user meets it. A failure in "NUL in a text column" or "non-integer numbers in count columns" means a table file still uses a Drizzle builder directly: rerun `documentor/scripts/convert-schema.py`. If "text compares in byte order" fails, the database collation is wrong — stop and fix the environment.

- [ ] **Step 2: Write the concurrency tests**

`packages/opencode/test/pg/concurrency.test.ts`, with the header, `it` and `withSession` from `parity.test.ts` plus the imports below:

```ts
import * as PgClient from "@effect/sql-pg/PgClient"
import * as EffectDrizzlePostgres from "drizzle-orm/effect-postgres"
import { Layer, Redacted } from "effect"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { EventTable } from "@opencode-ai/core/event/sql"
import { cliIt } from "../lib/cli-process"

/** Aggregates whose sequence numbers are not exactly 0..n. Empty means every log is gap-free. */
const broken = sql`
  select aggregate_id from event group by aggregate_id
  having count(*) <> max(seq) + 1 or count(distinct seq) <> count(*)
`

describe("concurrent writers", () => {
  it.instance("concurrent appends to one session", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* Effect.all(
          Array.from({ length: 40 }, (_, index) => session.setTitle({ sessionID, title: `title ${index}` })),
          { concurrency: 8 },
        )
        const events = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()
        expect(events.length).toBeGreaterThanOrEqual(41)
        expect(yield* db.all(broken)).toEqual([])
        expect((yield* session.get(sessionID)).title).toMatch(/^title \d+$/)
      }),
    ),
  )

  cliIt.concurrent(
    "two processes on one scope",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        const schema = `two_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`
        const url = new URL(process.env.OPENCODE_DATABASE_URL!)
        url.searchParams.set("options", `-c search_path=${schema}`)
        const scoped = <A, E>(
          body: (db: Database.Client) => Effect.Effect<A, E, PgClient.PgClient>,
        ): Effect.Effect<A, E> =>
          Effect.flatMap(EffectDrizzlePostgres.makeWithDefaults(), body).pipe(
            Effect.provide(PgClient.layer({ url: Redacted.make(url.toString()), maxConnections: 1 }).pipe(Layer.orDie)),
          )

        yield* scoped((db) => Effect.andThen(db.run(`CREATE SCHEMA "${schema}"`), DatabaseMigration.migrate(db)))
        yield* Effect.addFinalizer(() => scoped((db) => db.run(`DROP SCHEMA "${schema}" CASCADE`)).pipe(Effect.ignore))

        yield* llm.text("first reply")
        yield* llm.text("second reply")
        const env = { OPENCODE_DATABASE_SCHEMA: schema, OPENCODE_DATABASE_EPHEMERAL: "0" }
        const [a, b] = yield* Effect.all([opencode.run("one", { env }), opencode.run("two", { env })], {
          concurrency: 2,
        })
        opencode.expectExit(a, 0)
        opencode.expectExit(b, 0)

        const counts = yield* scoped((db) =>
          db.get<{ sessions: number; events: number }>(
            sql`select (select count(*)::int from session) as sessions, (select count(*)::int from event) as events`,
          ),
        )
        expect(counts!.sessions).toBe(2)
        expect(counts!.events).toBeGreaterThan(2)
        expect(yield* scoped((db) => db.all(broken))).toEqual([])
      }),
    60_000,
  )
})
```

Run: `cd packages/opencode && bun test --timeout 60000 test/pg/concurrency.test.ts`
Expected: both pass. If "concurrent appends" reports a broken aggregate or a unique-index error on `event_aggregate_seq_idx`, the event append reads the sequence and writes it in separate steps that can now interleave: the append in `packages/core/src/event.ts` already runs in a `{ behavior: "immediate" }` transaction, so check that the advisory lock from Task 2 is taken on that code path before changing anything else.

- [ ] **Step 3: Run, then the whole gate**

Run: `cd packages/opencode && bun test --timeout 60000 test/pg/ && cd ../.. && bun turbo typecheck && GITHUB_ACTIONS=false bun turbo test --force`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: pin the values SQLite tolerated and concurrent writers on Postgres

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: The compiled binary on Postgres, and its release

**Files:**

- Use: `documentor/scripts/binary-smoke.sh`
- Modify: `.github/workflows/documentor-ci.yml` (new `binary` job)
- Modify: `.github/workflows/documentor-release.yml` (tag pattern)

**Interfaces:**

- Consumes: the build (`packages/opencode/script/build.ts --single`), `opencode db migrate`, `opencode db provision`.
- Produces: `documentor/scripts/binary-smoke.sh <binary>` exiting 0 only when the binary serves from Postgres as a scope role; releases tagged `v<upstream>-documentor-pg.<n>` published as `ghcr.io/thefabfab/opencode:<upstream>-documentor-pg.<n>`.

- [ ] **Step 1: Read the smoke script**

`documentor/scripts/binary-smoke.sh` is committed beside this plan:

```bash
#!/usr/bin/env bash
# Proves a compiled opencode binary serves from Postgres as a scope role and
# never touches SQLite. Needs OPENCODE_TEST_DATABASE_URL (a superuser).
set -euo pipefail

binary="$(realpath "$1")"
admin="${OPENCODE_TEST_DATABASE_URL:?set OPENCODE_TEST_DATABASE_URL}"
scope="smoke_$(date +%s)_$$"
home="$(mktemp -d)"
port=47190
server=""
trap '[ -z "$server" ] || kill "$server" 2>/dev/null || true; rm -rf "$home"' EXIT

mkdir "$home/proj" && git -C "$home/proj" init -q
export HOME="$home" XDG_DATA_HOME="$home/data" XDG_CONFIG_HOME="$home/config" \
  XDG_CACHE_HOME="$home/cache" XDG_STATE_HOME="$home/state" \
  OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1

# As the administrator: create the scope, then its tables.
OPENCODE_DATABASE_URL="$admin" OPENCODE_DATABASE_ROLE_PASSWORD=smoke-only \
  "$binary" db provision --schema "$scope" --role "$scope"
OPENCODE_DATABASE_URL="$admin" OPENCODE_DATABASE_SCHEMA="$scope" "$binary" db migrate

# As the scope role: serve.
role_url="$(node -e 'const u=new URL(process.argv[1]);u.username=process.argv[2];u.password="smoke-only";console.log(u.toString())' "$admin" "$scope")"
OPENCODE_DATABASE_URL="$role_url" OPENCODE_DATABASE_SCHEMA="$scope" \
  "$binary" serve --port "$port" --hostname 127.0.0.1 >"$home/serve.log" 2>&1 &
server=$!

# Each probe has its own timeout: a request that arrives in the instant the
# server starts listening can be accepted and never answered.
ready=""
for _ in $(seq 1 100); do
  if [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/session?directory=$home/proj")" = 200 ]; then
    ready=1
    break
  fi
  kill -0 "$server" 2>/dev/null || { cat "$home/serve.log" >&2; echo "server exited" >&2; exit 1; }
  sleep 0.2
done
[ -n "$ready" ] || { cat "$home/serve.log" >&2; echo "server never answered" >&2; exit 1; }

created="$(curl -fsS -m 20 -X POST "http://127.0.0.1:$port/session?directory=$home/proj" \
  -H 'content-type: application/json' -d '{"title":"12345"}')"
listed="$(curl -fsS -m 20 "http://127.0.0.1:$port/session?directory=$home/proj")"
node -e '
  const created = JSON.parse(process.argv[1]), listed = JSON.parse(process.argv[2])
  const found = listed.find((item) => item.id === created.id)
  if (!found || found.title !== "12345") { console.error("session did not round-trip", listed); process.exit(1) }
' "$created" "$listed"

stray="$(find "$home" -name '*.db' -o -name '*.db-wal' -o -name '*.sqlite')"
[ -z "$stray" ] || { echo "SQLite file created: $stray" >&2; exit 1; }

rows="$(OPENCODE_DATABASE_URL="$admin" OPENCODE_DATABASE_SCHEMA="$scope" \
  "$binary" db "select count(*) as n from \"$scope\".session" --format json)"
node -e 'if (JSON.parse(process.argv[1])[0].n != 1) { console.error("expected one session row"); process.exit(1) }' "$rows"

OPENCODE_DATABASE_URL="$admin" "$binary" db "drop schema \"$scope\" cascade" >/dev/null
OPENCODE_DATABASE_URL="$admin" "$binary" db "drop role \"$scope\"" >/dev/null
echo "binary smoke passed for $scope"
```

- [ ] **Step 2: Run it locally**

```bash
(cd packages/opencode && OPENCODE_VERSION=1.18.34 bun run script/build.ts --single)
documentor/scripts/binary-smoke.sh packages/opencode/dist/opencode-linux-x64/bin/opencode
```

Expected: `binary smoke passed for smoke_…`.

- [ ] **Step 3: Add the CI job**

In `.github/workflows/documentor-ci.yml` add a `binary` job with the same `services` and `env` blocks as `unit`:

```yaml
binary:
  runs-on: ubuntu-24.04
  steps:
    - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1

    - uses: ./.github/actions/setup-bun

    - name: Build
      working-directory: packages/opencode
      run: bun run script/build.ts --single
      env:
        OPENCODE_VERSION: "1.18.34"

    - name: Serve from Postgres as a scope role
      run: documentor/scripts/binary-smoke.sh packages/opencode/dist/opencode-linux-x64/bin/opencode
```

- [ ] **Step 4: Let the release workflow accept the new line's tags**

In `.github/workflows/documentor-release.yml` change the tag filter to:

```yaml
tags:
  - "v*-documentor.*"
  - "v*-documentor-pg.*"
```

and the version check's pattern to `^v([0-9]+\.[0-9]+\.[0-9]+)-documentor(-pg)?\.([0-9]+)$`.

- [ ] **Step 5: Commit, push, watch**

```bash
git add -A
git commit -m "ci: prove the compiled binary serves from Postgres as a scope role

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push --no-verify
gh run watch --repo TheFabFab/opencode --exit-status "$(gh run list --repo TheFabFab/opencode --branch documentor-pg --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Expected: `typecheck`, `unit` and `binary` green.

---

### Task 10: The fork record

**Files:**

- Create: `documentor/FORK.md`
- Modify: `documentor/specs/2026-10-06-postgres-core-design.md` (only if the implementation departed from it)

**Interfaces:**

- Produces: the document a rebase onto a newer upstream tag starts from.

- [ ] **Step 1: Write `documentor/FORK.md`**

Sections, each filled from the branch as it stands (`git diff --stat v1.18.34 -- packages .github`):

1. **What this branch is** — two sentences and a link to the design.
2. **Upstream files changed** — a table of every upstream file `git diff --name-only --diff-filter=M v1.18.34 -- packages` lists, with one line each on what differs and why. The 11 table files share one row that names `documentor/scripts/convert-schema.py`.
3. **Upstream files deleted** — from `--diff-filter=D`, each with its row in `documentor/upstream-test-exceptions.md`.
4. **Rebasing onto a newer tag** — the procedure:
   - rebase; a conflict in a table file means upstream changed the schema: take upstream's version of the file, rerun `documentor/scripts/convert-schema.py`, regenerate the baseline (Task 3 Step 7), and set `DatabaseMigration.BASELINE` to upstream's newest migration id;
   - a red `every upstream migration is either in the baseline or ported` test with no conflict means upstream added a migration: for a schema already in use, write its Postgres version into `DatabaseMigration.ported`; then regenerate the baseline as above;
   - `bun turbo typecheck` — a new error in upstream query code means upstream used something SQLite-specific; fix it in `effect-drizzle-pg` if it is an API difference, in the call site only as a last resort, and add a row to section 2;
   - `bun turbo test`, then `documentor/scripts/binary-smoke.sh`.
5. **Settings** — the table from the design, plus `OPENCODE_DATABASE_ROLE_PASSWORD`, `OPENCODE_TEST_DATABASE_URL` and `OPENCODE_DATABASE_EPHEMERAL`.
6. **Operating a scope** — the three commands in order (`db provision`, `db migrate`, `db grant-read`), which role runs each, and that a server never migrates.

- [ ] **Step 2: Check the design still describes the code**

Read `documentor/specs/2026-10-06-postgres-core-design.md` against the branch. Where they differ, correct the design to describe what is.

- [ ] **Step 3: Final verification**

```bash
bun turbo typecheck
GITHUB_ACTIONS=false bun turbo test --force
(cd packages/opencode && OPENCODE_VERSION=1.18.34 bun run script/build.ts --single)
documentor/scripts/binary-smoke.sh packages/opencode/dist/opencode-linux-x64/bin/opencode
grep -rnE 'drizzle-orm/sqlite-core|bun:sqlite|effect-drizzle-sqlite|OPENCODE_DB\b' packages/core/src packages/opencode/src packages/server/src | grep -v 'packages/core/src/database/sqlite'
```

Expected: clean type check, green suite, `binary smoke passed`, and no output from `grep`.

- [ ] **Step 4: Commit and push**

```bash
git add -A
git commit -m "docs: record what the documentor-pg branch changes and how to rebase it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push --no-verify
```
