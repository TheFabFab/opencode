import { doublePrecision } from "drizzle-orm/pg-core"

export const Timestamps = {
  time_created: doublePrecision()
    .notNull()
    .$default(() => Date.now()),
  time_updated: doublePrecision()
    .notNull()
    .$onUpdate(() => Date.now()),
}
