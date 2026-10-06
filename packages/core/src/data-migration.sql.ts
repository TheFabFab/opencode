import { pgTable, text, doublePrecision } from "drizzle-orm/pg-core"

export const DataMigrationTable = pgTable("data_migration", {
  name: text().primaryKey(),
  time_completed: doublePrecision().notNull(),
})
