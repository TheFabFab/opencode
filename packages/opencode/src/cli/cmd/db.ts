import type { Argv } from "yargs"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { DatabaseCollation } from "@opencode-ai/core/database/collation"
import { DatabaseConnect } from "@opencode-ai/core/database/connect"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { DatabaseProvision } from "@opencode-ai/core/database/provision"
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
    const result = await run(
      DatabaseConnect.run(
        (db, target) =>
          Effect.gen(function* () {
            yield* DatabaseCollation.verify(db)
            if (args.all) return yield* DatabaseMigration.migrateAll(db)
            if (!target.schema)
              return yield* Effect.die("OPENCODE_DATABASE_SCHEMA is not set: name the schema to migrate, or pass --all")
            yield* DatabaseMigration.migrate(db)
            yield* DatabaseMigration.verify(db)
            return { done: [target.schema], failed: [] }
          }),
        { schema: !args.all },
      ),
    )
    console.log(`up to date: ${result.done.length === 0 ? "no schemas found" : result.done.join(", ")}`)
    for (const { schema, error } of result.failed)
      console.error(`failed: ${schema}: ${error instanceof Error ? error.message : String(error)}`)
    if (result.failed.length > 0) process.exitCode = 1
  },
})

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

export const DbCommand = cmd({
  command: "db",
  describe: "database tools",
  builder: (yargs: Argv) =>
    yargs
      .command(QueryCommand)
      .command(MigrateCommand)
      .command(ProvisionCommand)
      .command(GrantReadCommand)
      .demandCommand(),
  handler() {},
})
