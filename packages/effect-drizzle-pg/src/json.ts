import { customType } from "drizzle-orm/pg-core"

const NUL = /\u0000/g

function scrub(value: unknown): unknown {
  if (typeof value === "string") return value.includes("\u0000") ? value.replace(NUL, "�") : value
  if (Array.isArray(value)) return value.map(scrub)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrub(key), scrub(item)]))
  return value
}

/**
 * A `jsonb` column that accepts any JSON value JavaScript can produce.
 * Postgres rejects the escaped NUL character inside `jsonb` strings, so it is
 * stored as U+FFFD.
 */
export const jsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType() {
    return "jsonb"
  },
  toDriver(value) {
    return JSON.stringify(scrub(value))
  },
  fromDriver(value) {
    return typeof value === "string" ? JSON.parse(value) : value
  },
})
