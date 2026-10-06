import { pgTable, doublePrecision } from "drizzle-orm/pg-core"
import { text } from "@opencode-ai/effect-drizzle-pg"

export const DataMigrationTable = pgTable("data_migration", {
  name: text().primaryKey(),
  time_completed: doublePrecision().notNull(),
})
