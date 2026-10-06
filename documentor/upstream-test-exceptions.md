# Upstream tests the fork does not run

Each entry is an upstream test file or case that is absent or changed on
`documentor-pg`, with the reason. A rebase that brings one back must either
make it pass on Postgres or keep it listed here.

| Upstream test                                   | State   | Reason                                                                         | Replaced by                               |
| ----------------------------------------------- | ------- | ------------------------------------------------------------------------------ | ----------------------------------------- |
| `packages/core/test/database-migration.test.ts` | Deleted | Tests SQLite's file journal and the import of Drizzle's SQLite migration table | `packages/core/test/pg/migration.test.ts` |
