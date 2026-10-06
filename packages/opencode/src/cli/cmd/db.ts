import type { Argv } from "yargs"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { DatabaseCollation } from "@opencode-ai/core/database/collation"
import { DatabaseConnect } from "@opencode-ai/core/database/connect"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { DatabaseProvision } from "@opencode-ai/core/database/provision"
import { effectCmd } from "../effect-cmd"

const QueryCommand = effectCmd({
  command: "$0 <query>",
  describe: "run a SQL query",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        demandOption: true,
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: Effect.fn("Cli.db.query")(function* (args: { query: string; format: string }) {
    const result = yield* DatabaseConnect.run((db) => db.all<Record<string, unknown>>(sql.raw(args.query))).pipe(Effect.orDie)
    if (args.format === "json") console.log(JSON.stringify(result, null, 2))
    else if (result.length > 0) {
      const keys = Object.keys(result[0])
      console.log(keys.join("\t"))
      for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
    }
  }),
})

const MigrateCommand = effectCmd({
  command: "migrate",
  describe: "bring the schema named by OPENCODE_DATABASE_SCHEMA, or every schema with --all, up to date",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.option("all", {
      type: "boolean",
      default: false,
      describe: "migrate every schema that holds opencode's tables",
    }),
  handler: Effect.fn("Cli.db.migrate")(function* (args: { all: boolean }) {
    const done = yield* DatabaseConnect.run(
      (db, target) =>
        Effect.gen(function* () {
          yield* DatabaseCollation.verify(db)
          if (args.all) return yield* DatabaseMigration.migrateAll(db)
          yield* DatabaseMigration.migrate(db)
          yield* DatabaseMigration.verify(db)
          return [target.schema ?? "(default)"]
        }),
      { schema: !args.all },
    ).pipe(Effect.orDie)
    console.log(`up to date: ${done.length === 0 ? "no schemas found" : done.join(", ")}`)
  }),
})

const names = (yargs: Argv) =>
  yargs
    .option("schema", { type: "string", demandOption: true, describe: "the scope's schema" })
    .option("role", { type: "string", demandOption: true, describe: "the role to grant" })

const ProvisionCommand = effectCmd({
  command: "provision",
  describe: "create a scope's schema and role; the role's password is read from OPENCODE_DATABASE_ROLE_PASSWORD",
  instance: false,
  builder: names,
  handler: Effect.fn("Cli.db.provision")(function* (args: { schema: string; role: string }) {
    yield* DatabaseConnect.run(
      (db) =>
        DatabaseProvision.scope(db, {
          schema: args.schema,
          role: args.role,
          password: process.env.OPENCODE_DATABASE_ROLE_PASSWORD,
        }),
      { schema: false },
    )
    console.log(`scope ${args.schema} is provisioned for role ${args.role}`)
  }),
})

const GrantReadCommand = effectCmd({
  command: "grant-read",
  describe: "let a role read a scope's schema",
  instance: false,
  builder: names,
  handler: Effect.fn("Cli.db.grantRead")(function* (args: { schema: string; role: string }) {
    yield* DatabaseConnect.run((db) => DatabaseProvision.reader(db, args), { schema: false })
    console.log(`role ${args.role} can read ${args.schema}`)
  }),
})

export const DbCommand = effectCmd({
  command: "db",
  describe: "database tools",
  instance: false,
  builder: (yargs: Argv) => {
    return yargs
      .command(QueryCommand)
      .command(MigrateCommand)
      .command(ProvisionCommand)
      .command(GrantReadCommand)
      .demandCommand()
  },
  handler: () => Effect.void,
})
