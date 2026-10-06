import { customType } from "drizzle-orm/pg-core"

/** A `text` column. Postgres cannot store NUL in text, so it is stored as U+FFFD. */
export const text = customType<{ data: string; driverData: string }>({
  dataType() {
    return "text"
  },
  toDriver(value) {
    return typeof value === "string" && value.includes("\u0000") ? value.replaceAll("\u0000", "�") : value
  },
})

/**
 * A `bigint` column read as a JS number, for counts and sequence numbers.
 * SQLite stored whatever number it was given; here a fraction is rounded and
 * anything that is not a finite number is refused.
 */
export const count = customType<{ data: number; driverData: string }>({
  dataType() {
    return "bigint"
  },
  toDriver(value) {
    if (!Number.isFinite(value)) throw new Error(`${value} is not a finite number`)
    return String(Math.round(value))
  },
  fromDriver(value) {
    return Number(value)
  },
})
