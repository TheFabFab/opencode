export * as DatabaseCollation from "./collation"

import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "./database"

export class CollationError extends Schema.TaggedErrorClass<CollationError>()("DatabaseCollationError", {
  message: Schema.String,
}) {}

/**
 * opencode pages through sessions and messages by comparing text ids, which
 * sort by creation time only in byte order. A locale collation reorders
 * mixed-case ids, so anything but byte order is refused.
 */
export function verify(db: Database.Client) {
  return Effect.gen(function* () {
    const row = yield* db
      .get<{ provider: string; collate: string | null; locale: string | null }>(
        sql`select datlocprovider as provider, datcollate as "collate", datlocale as locale
            from pg_database where datname = current_database()`,
      )
      .pipe(Effect.orDie)
    const effective = row?.provider === "c" ? row.collate : row?.locale
    if (effective === "C" || effective === "POSIX" || effective === "C.UTF-8") return
    return yield* new CollationError({
      message: `Database collation is ${effective ?? "unknown"} (provider ${row?.provider ?? "unknown"}). opencode needs byte-order collation: create the database with LOCALE 'C.UTF-8' and TEMPLATE template0.`,
    })
  })
}
