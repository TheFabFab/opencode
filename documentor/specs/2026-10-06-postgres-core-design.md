# Postgres core — design

6 October 2026 · status: approved

This is the first of the pieces that make up "opencode agent pods". It covers
where opencode keeps its database state and how users and their projects are
kept apart. The
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
3. One user cannot read or write another's rows, and a project's process
   cannot read another project's, enforced by Postgres privileges rather than
   by opencode's code.
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
| `integer` holding a millisecond timestamp | `double precision` | SQLite stores a fractional value in an integer column unchanged, and upstream relies on it: its pagination tests write `1000.5` as a message time. `double precision` holds every JS number exactly as SQLite did |
| `integer` holding a count, a sequence number or an id | `bigint`, read as a JS number | A 32-bit `integer` is too small. A fraction is rounded and a non-finite number is refused, where SQLite stored either as given |
| `text` in JSON mode (14 columns) | `jsonb` | The web tier reads these directly |
| `integer` in boolean mode (2 columns) | `boolean` | |
| `real` (session cost) | `double precision` | Postgres `real` is 4 bytes and would lose precision |
| `text`, and the path column types | `text`, same custom types | |

Postgres rejects the NUL character in `text`, and its escaped form (`\u0000`)
inside `jsonb` strings. Tool output can contain it. The text and JSON column
types replace it with U+FFFD on write.

### Text ordering

Upstream pages through sessions and messages by ordering and comparing their
text ids, which are built to sort by creation time in byte order. SQLite
compares text byte by byte. Postgres uses the database's collation, and a
locale collation such as `en_US.UTF-8` orders mixed-case ids differently, which
would silently break paging.

The database is therefore created with byte-order collation (`C` or
`C.UTF-8`). The migration command and the server's start-up check both refuse a
database with any other collation.

### 3. Query API: a typed extension, not a proxy

A new package, `packages/effect-drizzle-pg`, adds `.get()`, `.all()` and
`.run()` to Drizzle's Effect Postgres builders and to the database and
transaction objects. It is typed, it does not rewrite rows, and it mirrors what
`effect-drizzle-sqlite` gives upstream. With it, the 256 call sites compile
unchanged against Postgres types, and the type checker reports every place
where SQLite and Postgres really differ.

Two call sites open a transaction with SQLite's `behavior: "immediate"`, which
means "one writer at a time". The extension keeps that meaning: an immediate
transaction first takes a transaction-scoped advisory lock. Within a scope
this serialises writers exactly as SQLite did, including two processes that
are wrongly running for the same scope.

### 4. Isolation: one schema and one role per user scope

The starter spec asks for shared tables with row-level security. This design
uses a Postgres schema and a login role per **scope** instead.

A scope is what DocuMentor already isolates today: one of a user's projects,
or that user's account-wide `global` scope. DocuMentor runs one opencode
process per scope, each with its own data directory and its own SQLite file,
and sandboxes a project's process to that project's files. The Postgres layout
keeps that unit:

| Role | Its own schema | Other schemas |
| --- | --- | --- |
| A user's project scope | Read and write | None |
| A user's `global` scope | Read and write | Read-only on every project schema of the same user |
| Web tier | — | Read-only on all schemas |

A project chat therefore cannot reach outside its project, and a global chat
can read all of that user's chats. Nothing crosses from one user to another.

opencode is given a URL and a schema name and uses unqualified table names, as
upstream does. It contains no tenant or scope logic at all.

Three facts from the code led here:

1. **The pod is not trusted.** The shell tool runs arbitrary commands as the
   same user as opencode, so anything opencode can reach, the agent can reach.
   Row-level security keyed on a session variable is therefore not a boundary;
   the credential itself must be limited to one scope.
2. **Seven tables have keys that collide between scopes.** Every scope has a
   project with the id `global`, an `account_state` row with id 1, and so on.
   In shared tables these keys must gain a scope column, which changes
   conflict targets in upstream call sites such as `project.ts`. That is a
   permanent merge cost in code upstream changes often.
3. **Tests need the same mechanism.** A fresh schema per test is the Postgres
   equivalent of `:memory:`, so every test run exercises the isolation path.

Costs of this choice:

- The catalog grows by 19 tables and 17 indexes per scope, and a user has one
  scope per project plus one. This is comfortable into the low thousands of
  schemas and should be revisited before about 5,000, which is roughly 1,000
  to 1,500 users with a few projects each.
- The migration Job loops over schemas.
- The web tier addresses a scope's data by schema name, and a query across
  scopes needs a union.

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
- Separate commands do the schema work: `opencode db migrate` for one schema or,
  with `--all`, every schema, under an advisory lock so two Jobs cannot run at
  once; `opencode db provision` to create a scope's schema and role; and
  `opencode db grant-read` to give a user's `global` role read access to that
  user's project schemas. They run outside the application runtime, which
  refuses an unmigrated schema.

### 6. Configuration

| Setting | Meaning |
| --- | --- |
| `OPENCODE_DATABASE_URL` | Required. The server refuses to start without it, and refuses a non-local host unless the URL asks for verified TLS (`sslmode=verify-full`) |
| `OPENCODE_DATABASE_SCHEMA` | The scope's schema; sent as `search_path` on every connection |
| `OPENCODE_DATABASE_POOL_MAX` | Connections per process, default 4 |

`OPENCODE_DB`, the SQLite file path logic and the `opencode db` command, which
opens the `sqlite3` shell, are removed.

## Testing

| Gate | What it proves |
| --- | --- |
| Type check of every package | Call sites are compatible with Postgres types |
| Upstream unit suite on Postgres in CI, one fresh schema per database layer | Behaviour matches upstream |
| Column round-trip tests | All-digit strings stay strings; millisecond timestamps fit every time column; cost keeps full precision; NUL in JSON is accepted |
| Collation test | A database with a locale collation is refused; mixed-case ids page in creation order |
| Transport test | A non-local URL without verified TLS is refused |
| Migration tests | Unknown upstream migration fails the build; server refuses an unmigrated schema; two migration Jobs racing apply once |
| Isolation test | A project role cannot read or write another schema; a `global` role can read its own user's project schemas, cannot write them, and cannot read another user's |
| Writer test | Two connections appending to one session produce gap-free, ordered sequence numbers |
| Compiled-binary test | The built binary, connected as a scope role, serves sessions from Postgres and creates no SQLite file. Prompts on Postgres are covered by upstream's subprocess tests, which run from source |

CI adds a Postgres 18 service container, the current stable major and the one
production will run. SQLite-specific upstream tests, such as
the legacy migration journal import, are deleted and listed in
`documentor/upstream-test-exceptions.md` with the reason for each.

## Branching

Work happens on `documentor-pg`, cut from `v1.18.34`, with the two CI
workflows from `documentor` carried over. `documentor` stays on unmodified
1.18.18 and remains the line DocuMentor would consume today.

## Consequences for the later pieces

- **Warm pool.** A warm pod does not know its user, so it cannot hold a scope's
  connection before it is claimed. The claim has to deliver the credentials,
  and each opencode process has to connect at that moment. This adds one
  connection setup to the claim-to-first-response budget.
- **Processes in a pod.** A user's pod runs one opencode process per scope, as
  today. Each holds only its own scope's credential, so the pod's sandbox has
  to keep a project process from reading another process's environment.
- **Encryption at rest.** Postgres has no built-in data encryption, so the
  volume under Postgres is encrypted, and so are its backups. DocuMentor's
  privacy notice already promises encrypted backups. Both are hosting
  decisions and change nothing in this design.
- **Connections.** One pool per opencode process means the total is running
  scopes × pool size. A
  pooler in front of Postgres is likely before a few hundred concurrent pods.
- **Web tier reads.** The views the web tier reads live in each scope's schema
  and are created by the same migration command.
- **DocuMentor today reads opencode's SQLite file** for chat history, paging
  and search, and its backup inventory names that file. Both change at
  integration.

## Decisions taken in review (6 October 2026)

1. Schema and role per scope, not shared tables with row-level security.
2. The isolation boundary between people is the user. Inside a user, each
   project is its own scope and the `global` scope can read all of them.
3. Production runs the current stable Postgres major, 18.

4. The `global` scope reads project chats but does not write to them.
