import { pgTable, index, uniqueIndex } from "drizzle-orm/pg-core"
import { count, jsonb, text } from "@opencode-ai/effect-drizzle-pg"
import type { EventV2 } from "../event"

export const EventSequenceTable = pgTable("event_sequence", {
  aggregate_id: text().notNull().primaryKey(),
  seq: count().notNull(),
  owner_id: text(),
})

export const EventTable = pgTable(
  "event",
  {
    id: text().$type<EventV2.ID>().primaryKey(),
    aggregate_id: text()
      .notNull()
      .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
    seq: count().notNull(),
    type: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    uniqueIndex("event_aggregate_seq_idx").on(table.aggregate_id, table.seq),
    index("event_aggregate_type_seq_idx").on(table.aggregate_id, table.type, table.seq),
  ],
)
