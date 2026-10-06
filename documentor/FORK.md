# The `documentor-pg` branch

This branch is upstream opencode `v1.18.34` with its database state kept in
Postgres. It has no SQLite path. The design is in
[`specs/2026-10-06-postgres-core-design.md`](specs/2026-10-06-postgres-core-design.md).

Everything the fork adds lives in `documentor/`, `packages/effect-drizzle-pg/`,
`packages/core/test/pg/`, `packages/opencode/test/pg/` and the two
`documentor-*` workflows. The rest of this document is about the upstream
files it changes, because those are what a rebase meets.

## Upstream files changed

| File                                                                                                                                                                                                                                   | What differs                                                                                                                                             | Why                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The 11 table files: `packages/core/src/{account,credential,event,permission,project,session,share}/sql.ts`, `control-plane/workspace.sql.ts`, `data-migration.sql.ts`, `database/schema.sql.ts`, `database/path.ts`                    | Postgres table builder; `count`, `jsonb` and `text` columns from `effect-drizzle-pg`; time columns are `double precision`                                | Written by `documentor/scripts/convert-schema.py`, never by hand                                                                                                                                                                                      |
| `packages/core/src/database/schema.gen.ts`, `packages/core/schema.json`, `packages/core/drizzle.config.ts`                                                                                                                             | The Postgres baseline, as one statement batch                                                                                                            | Generated; see "Regenerating the baseline"                                                                                                                                                                                                            |
| `packages/core/src/database/database.ts`                                                                                                                                                                                               | Connects with `@effect/sql-pg`; verifies collation and migrations and changes nothing; a throwaway schema per layer when `OPENCODE_DATABASE_EPHEMERAL=1` | The service itself                                                                                                                                                                                                                                    |
| `packages/core/src/database/migration.ts`                                                                                                                                                                                              | `migrate`, `migrateAll`, `verify`, `pending`, `BASELINE_IDS`, `ported`                                                                                   | Schema work is a command, not a start-up side effect                                                                                                                                                                                                  |
| `packages/core/src/project/directories.ts`                                                                                                                                                                                             | `Transaction` is `Database.Transaction`                                                                                                                  | It was typed against the SQLite client                                                                                                                                                                                                                |
| `packages/core/src/flag/flag.ts`                                                                                                                                                                                                       | No `OPENCODE_DB`                                                                                                                                         | Nothing reads it                                                                                                                                                                                                                                      |
| `packages/core/package.json`                                                                                                                                                                                                           | Depends on `@effect/sql-pg`, `pg`, `@opencode-ai/effect-drizzle-pg`; tests run with `--timeout 30000`                                                    | Each test database is a real schema, about 110 ms to build                                                                                                                                                                                            |
| `packages/opencode/src/cli/cmd/db.ts`                                                                                                                                                                                                  | `db <query>`, `db migrate [--all]`, `db provision`, `db grant-read`, all outside the application runtime                                                 | The runtime's database service refuses the schemas these commands exist to create and migrate                                                                                                                                                         |
| `packages/opencode/src/session/processor.ts`                                                                                                                                                                                           | One lock per processor around each read-then-write of a tool part                                                                                        | The processor and the running tool both update a tool part. SQLite made each update atomic; a network database lets them interleave, and the tool's metadata was lost                                                                                 |
| `packages/core/src/integration.ts`                                                                                                                                                                                                     | An OAuth attempt's credential is stored before the attempt reads as complete, inside one update of the attempts map                                      | The attempt was marked complete first and the credential written after. On SQLite nothing could look in between; on a network database a caller that saw "complete" could list no credential                                                          |
| `patches/effect@4.0.0-beta.83.patch`                                                                                                                                                                                                   | Adds Effect's own fix for re-entrant interruption, first released in `4.0.0-beta.100`                                                                    | A fiber that woke another fiber which interrupted it synchronously had its continuation stack corrupted once its cleanup awaited anything. With Postgres that leaked a pooled connection. Drop these hunks when upstream moves to `beta.100` or later |
| `turbo.json`                                                                                                                                                                                                                           | `OPENCODE_TEST_DATABASE_URL` passes through to every task; `@opencode-ai/effect-drizzle-pg#test` is a task                                               | turbo strips variables it is not told about                                                                                                                                                                                                           |
| Test helpers: `packages/core/test/preload.ts`, `packages/opencode/test/preload.ts`, `packages/opencode/test/fixture/db.ts`, `packages/opencode/test/server/httpapi-exercise/environment.ts`, `packages/sdk-next/test/embedded.test.ts` | Ask for a throwaway schema; no database file to delete                                                                                                   |                                                                                                                                                                                                                                                       |

Upstream tests that are changed or deleted are listed, with reasons, in
[`upstream-test-exceptions.md`](upstream-test-exceptions.md).

`packages/core/src/database/sqlite*.ts` and `packages/effect-drizzle-sqlite/`
are untouched and unreferenced. They stay so that a rebase does not meet a
modify/delete conflict, and `@effect/sql-sqlite-bun` stays a dependency of core
because those files still type-check against it.

## Settings

| Setting                           | Meaning                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `OPENCODE_DATABASE_URL`           | Required. A host that is not loopback must carry `sslmode=verify-full`                                  |
| `OPENCODE_DATABASE_SCHEMA`        | The scope's schema, sent as the search path. 1 to 63 characters of `a-z`, `0-9`, `_`                    |
| `OPENCODE_DATABASE_POOL_MAX`      | Connections per process, 1 to 100, default 4                                                            |
| `OPENCODE_DATABASE_ROLE_PASSWORD` | Read by `db provision` when it has to create the role                                                   |
| `OPENCODE_DATABASE_EPHEMERAL=1`   | Tests only: each database layer creates a schema `t_<32 hex>`, migrates it, and drops it when it closes |
| `OPENCODE_TEST_DATABASE_URL`      | Tests only: a superuser on a Postgres 18 whose database collation is `C.UTF-8`                          |

The database must use byte-order collation (`C`, `POSIX` or `C.UTF-8`).
opencode pages by comparing text ids, and a locale collation reorders them.
The server and `db migrate` both refuse anything else.

## Operating a scope

A scope is one of a user's projects, or that user's `global` scope. Each has a
schema and a role of the same purpose. Run as the administrator, in this order:

```bash
export OPENCODE_DATABASE_URL=postgresql://admin@db.internal/opencode?sslmode=verify-full

# 1. The schema and its role. The role can read and write rows and nothing else.
OPENCODE_DATABASE_ROLE_PASSWORD=… opencode db provision --schema <scope> --role <scope>

# 2. The tables.
OPENCODE_DATABASE_SCHEMA=<scope> opencode db migrate

# 3. Only for a user's global scope: read access to each of that user's project scopes.
opencode db grant-read --schema <project scope> --role <global scope>
```

Run all three as the same administrator role. `ALTER DEFAULT PRIVILEGES`
binds to the role that executes it, so tables that a later `db migrate` adds
are visible to the scope roles only when the same role provisioned them.

A server then runs as the scope's role with `OPENCODE_DATABASE_SCHEMA=<scope>`.
It never creates, alters or drops anything: if the schema is not migrated for
the build, it refuses to start and names `opencode db migrate`. After a
release that changes the schema, `opencode db migrate --all` brings every
schema that holds both a `session` and a `migration` table up to date, reports
any schema that fails and exits non-zero if one did; it is safe to run twice
and safe to run concurrently. `db migrate` without `--all` refuses to run when
`OPENCODE_DATABASE_SCHEMA` is not set.

## Rebasing onto a newer upstream tag

1. Rebase. A conflict in one of the 11 table files means upstream changed the
   schema: take upstream's version of that file, then run
   `python3 documentor/scripts/convert-schema.py` and regenerate the baseline.
2. Run `bun test test/pg/migration.test.ts` in `packages/core`. A failure in
   "every upstream migration is either in the baseline or ported" names an
   upstream migration added since the baseline. For schemas already in use,
   write its Postgres version into `DatabaseMigration.ported`, keyed by
   upstream's migration id. Then regenerate the baseline and add the id to
   `DatabaseMigration.BASELINE_IDS`.
3. Run `bun turbo typecheck`. A new error in upstream query code means it used
   something only the SQLite client has. Add it to `effect-drizzle-pg` if it is
   an API difference; change the call site only as a last resort, and add a row
   to the table above.
4. If upstream's `effect` version is `4.0.0-beta.100` or later, remove the
   `dist/internal/effect.js` hunks from the Effect patch. Otherwise rename the
   patch to the new version and check that
   `grep -c _deferredInterrupt node_modules/.bun/effect@*/node_modules/effect/dist/internal/effect.js`
   is not zero after `bun install`.
5. Run `bun turbo test` twice, then build and run
   `documentor/scripts/binary-smoke.sh`.
6. Read `upstream-test-exceptions.md` against the rebased tests. A test that
   upstream rewrote may no longer need its exception.

A new upstream test that fails only on Postgres is most often one of two
things. Either it reads state the instant a call returns, before a background
fiber has finished a database round trip; or the product reads a row and
writes it back with nothing holding the two together. The first is a test
assumption and the test should wait for the state it asserts. The second is a
lost update that SQLite hid, and the product needs a lock or a transaction.
Decide which before adding a wait: a wait can hide the second.

### Regenerating the baseline

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
bunx prettier --write src/database/schema.gen.ts
```

## Running the tests

```bash
export OPENCODE_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres
bun turbo typecheck
GITHUB_ACTIONS=false bun turbo test
```

Four upstream tests need a directory the process cannot write to, and fail
when the suite runs as root: `util.flock` and `util.effect-flock` "unwritable
lock roots", `tool.write` "throws error when OS denies write access", and
"continues loading tui config when legacy source cannot be stripped". They
pass as a normal user, which is how CI runs.

A test process that is killed leaves its `t_…` schemas behind. They hold no
data anyone needs and can be dropped.

## Gaps to close before multi-tenant deployment

- **Advisory locks are database-wide.** Every transaction and every migration
  takes `pg_advisory_xact_lock` keyed on the schema name, and any role can
  call those functions. A hostile process in one pod could hold another
  scope's key and stall that scope's writes, or stall the migration Job. Data
  isolation is unaffected. The replacement is a lock on a row in the scope's
  own schema, which only its role can reach; it belongs with the pod
  packaging design, which owns the "pod is not trusted" boundary.
- **Scope roles can read other scopes' names.** `pg_namespace`, `pg_roles`
  and `pg_stat_activity` show every schema and role name, though no row data.
  Opaque schema names close this.

## Known upstream behaviour

A request that arrives in the instant `opencode serve` starts listening can be
accepted and never answered. Stock 1.18.18 on SQLite does it too. Anything
that probes a server for readiness must put a timeout on each attempt.
