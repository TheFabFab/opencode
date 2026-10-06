# Postgres core — design

6 October 2026 · status: draft for review

This is the first of the pieces that make up "opencode agent pods". It covers
where opencode keeps its database state and how tenants are kept apart. The
writer lease across pods, the web tier's read views, the slim server build and
pod packaging each get their own design.

## Goal

The fork's opencode keeps all of its database state in Postgres and none in
SQLite, with the smallest possible difference from upstream, and upstream's
own test suite passes against it.

Success means:

1. A server started with a Postgres URL creates no SQLite file and serves
   sessions, messages, parts and events from Postgres.
2. Upstream's unit suite passes against Postgres in the fork's CI, with every
   exception listed by name in this repository.
3. Two tenants cannot read or write each other's rows, enforced by Postgres
   privileges rather than by opencode's code.
4. A pod does no schema work when it starts.

Out of scope: moving existing SQLite data, keeping SQLite working, the TUI and
desktop app, and any change to DocuMentor.

## What the code looks like today (v1.18.34)

- All tables are declared in 11 files under `packages/core/src` using Drizzle's
  SQLite table builder: 19 tables, 13 foreign keys, 17 indexes.
- About 30 source files issue queries through one service, `Database.Service`.
  They use roughly 256 calls to three SQLite-style terminal methods: `.get()`,
  `.all()` and `.run()`.
- There is almost no hand-written SQL in the runtime: eight expressions, all
  portable arithmetic.
- Upstream wrote its own Effect wrapper for Drizzle SQLite
  (`packages/effect-drizzle-sqlite`). Drizzle ships the equivalent for Postgres
  (`drizzle-orm/effect-postgres`), but its builders lack those three methods.
- Tests set `OPENCODE_DB=:memory:` in a preload file, so each database layer a
  test builds is a fresh empty database.
- The storage layer is stable. Between 1 July and 30 September upstream changed
  37 lines in it and added no migration; the newest migration is from 22 June.
- Every session already writes an ordered event log: an `event` table, one
  `event_sequence` row per session, and a unique index on (session, sequence).

## Decisions

### 1. Postgres only, replaced in place

The 11 schema files are rewritten with Drizzle's Postgres table builder,
keeping every exported name and every column name. SQLite support is removed
from the fork rather than kept behind a switch.

The alternative is to add Postgres files beside the SQLite ones and choose at
build time. It is rejected because an upstream schema change would then merge
cleanly and leave the Postgres schema silently behind. Replaced in place, the
same change is a merge conflict in a file we own, which is the signal we want.

### 2. Column types

| SQLite today | Postgres | Reason |
| --- | --- | --- |
| `integer` holding a millisecond timestamp or a count | `bigint`, read as a JS number | A 32-bit `integer` cannot hold a millisecond timestamp |
| `text` in JSON mode (14 columns) | `jsonb` | The web tier reads these directly |
| `integer` in boolean mode (2 columns) | `boolean` | |
| `real` (session cost) | `double precision` | Postgres `real` is 4 bytes and would lose precision |
| `text`, and the path column types | `text`, same custom types | |

`jsonb` rejects the escaped NUL character (`\u0000`) inside strings, and tool
output can contain it. The JSON column type replaces it with U+FFFD on write.

### 3. Query API: a typed extension, not a proxy

A new package, `packages/effect-drizzle-pg`, adds `.get()`, `.all()` and
`.run()` to Drizzle's Effect Postgres builders and to the database and
transaction objects. It is typed, it does not rewrite rows, and it mirrors what
`effect-drizzle-sqlite` gives upstream. With it, the 256 call sites compile
unchanged against Postgres types, and the type checker reports every place
where SQLite and Postgres really differ.

Two call sites open a transaction with SQLite's `behavior: "immediate"`, which
means "one writer at a time". The extension keeps that meaning: an immediate
transaction first takes a transaction-scoped advisory lock. Within a tenant
this serialises writers exactly as SQLite did, including two pods that are
wrongly running for the same tenant.

### 4. Tenant isolation: one schema and one role per tenant

**This departs from the starter spec, which asks for shared tables with
row-level security. It needs your decision.**

Each tenant gets a Postgres schema holding the 19 tables and a login role that
can use only that schema. opencode is given a URL and a schema name and uses
unqualified table names, as upstream does. It contains no tenant logic at all.

Three facts from the code led here:

1. **The pod is not trusted.** The shell tool runs arbitrary commands as the
   same user as opencode, so anything opencode can reach, the agent can reach.
   Row-level security keyed on a session variable is therefore not a boundary;
   the credential itself must be limited to one tenant. Both designs need a
   role per tenant.
2. **Seven tables have keys that collide between tenants.** Every tenant has a
   project with the id `global`, an `account_state` row with id 1, and so on.
   In shared tables these keys must gain a tenant column, which changes
   conflict targets in upstream call sites such as `project.ts`. That is a
   permanent merge cost in code upstream changes often.
3. **Tests need the same mechanism.** A fresh schema per test is the Postgres
   equivalent of `:memory:`, so every test run exercises the isolation path.

Costs of this choice:

- The catalog grows by 19 tables and 17 indexes per tenant. That is
  comfortable into the low thousands of tenants and should be revisited before
  about 5,000.
- The migration Job loops over schemas.
- The web tier addresses a tenant's data by schema name, and a query across
  all tenants needs a union.

The alternative, shared tables with row-level security keyed on the role, stays
possible later: it is a data move plus the key changes above.

### 5. Schema and migrations

- The Postgres baseline is generated by Drizzle from the new table files, by
  upstream's generation script pointed at Postgres.
- Upstream's 38 historical migration ids are recorded as applied in a new
  schema, as upstream does for a fresh database.
- A test fails when upstream's migration list contains an id the fork has
  neither ported nor declared a no-op. That is how a rebase tells us upstream
  changed the schema.
- Starting a server never changes a schema. It checks that the schema's applied
  migrations match what the binary expects and refuses to start otherwise.
- A separate command applies migrations to one schema or to all of them, under
  an advisory lock so two Jobs cannot run at once. It also creates a tenant's
  schema and role.

### 6. Configuration

| Setting | Meaning |
| --- | --- |
| `OPENCODE_DATABASE_URL` | Required. The server refuses to start without it |
| `OPENCODE_DATABASE_SCHEMA` | The tenant schema; sent as `search_path` on every connection |
| `OPENCODE_DATABASE_POOL_MAX` | Connections per process, default 4 |

`OPENCODE_DB`, the SQLite file path logic and the `opencode db` command, which
opens the `sqlite3` shell, are removed.

## Testing

| Gate | What it proves |
| --- | --- |
| Type check of every package | Call sites are compatible with Postgres types |
| Upstream unit suite on Postgres in CI, one fresh schema per database layer | Behaviour matches upstream |
| Column round-trip tests | All-digit strings stay strings; millisecond timestamps fit every time column; cost keeps full precision; NUL in JSON is accepted |
| Migration tests | Unknown upstream migration fails the build; server refuses an unmigrated schema; two migration Jobs racing apply once |
| Isolation test | Role A cannot read or write schema B |
| Writer test | Two connections appending to one session produce gap-free, ordered sequence numbers |
| Compiled-binary test | The built binary creates no SQLite file and serves a scripted prompt from Postgres |

CI adds a Postgres service container. SQLite-specific upstream tests, such as
the legacy migration journal import, are deleted and listed in
`documentor/upstream-test-exceptions.md` with the reason for each.

## Branching

Work happens on `documentor-pg`, cut from `v1.18.34`, with the two CI
workflows from `documentor` carried over. `documentor` stays on unmodified
1.18.18 and remains the line DocuMentor would consume today.

## Consequences for the later pieces

- **Warm pool.** A warm pod does not know its tenant, so it cannot hold a
  tenant connection before it is claimed. The claim has to deliver the tenant's
  credential, and the database layer has to connect at that moment. This adds
  one connection setup to the claim-to-first-response budget.
- **Connections.** One pool per pod means the total is pods × pool size. A
  pooler in front of Postgres is likely before a few hundred concurrent pods.
- **Web tier reads.** The views the web tier reads live in each tenant schema
  and are created by the same migration command.
- **DocuMentor today reads opencode's SQLite file** for chat history, paging
  and search, and its backup inventory names that file. Both change at
  integration.

## Open questions

1. Schema and role per tenant, as recommended, or shared tables with row-level
   security as in the starter spec?
2. Is a tenant a user, or a thesis project?
3. Which Postgres version and hosting will production use? The spike ran on
   18.4.
