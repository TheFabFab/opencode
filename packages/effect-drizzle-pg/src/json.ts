import { customType } from "drizzle-orm/pg-core"

const NUL = /\u0000/g

function scrubString(value: string) {
  const formed = value.isWellFormed() ? value : value.toWellFormed()
  return formed.includes("\u0000") ? formed.replace(NUL, "�") : formed
}

function scrub(value: unknown): unknown {
  if (typeof value === "string") return scrubString(value)
  if (Array.isArray(value)) return value.map(scrub)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrubString(key), scrub(item)]))
  return value
}

/**
 * A `jsonb` column that accepts any JSON value JavaScript can produce.
 * Postgres rejects two things JavaScript strings can hold: the escaped NUL
 * character, and a lone UTF-16 surrogate (a string cut in the middle of an
 * emoji). Both are stored as U+FFFD, which is what Postgres itself does for
 * a lone surrogate written to a `text` column.
 *
 * The driver hands jsonb values back already parsed, whatever their type.
 */
export const jsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return "jsonb"
  },
  toDriver(value) {
    return JSON.stringify(scrub(value))
  },
  fromDriver(value) {
    return value
  },
})
