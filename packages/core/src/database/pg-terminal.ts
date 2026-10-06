import * as Effect from "effect/Effect"
import type { QueryEffectHKTBase } from "drizzle-orm/effect-core"
import type { ColumnsSelection, SQL, SQLWrapper } from "drizzle-orm"
import type { Subquery } from "drizzle-orm"
import type { Assume } from "drizzle-orm"
import type {
  PgTable,
  PgQueryResultHKT,
  PgQueryResultKind,
} from "drizzle-orm/pg-core"
import type { BuildSubquerySelection, JoinNullability, SelectMode, SelectResult } from "drizzle-orm/query-builders/select.types"
import type { Join } from "drizzle-orm/pg-core/query-builders/update"
import type { PgViewBase } from "drizzle-orm/pg-core/view-base"
import { PgEffectSelectBase } from "drizzle-orm/pg-core/effect/select"
import { PgEffectInsertBase } from "drizzle-orm/pg-core/effect/insert"
import { PgEffectUpdateBase } from "drizzle-orm/pg-core/effect/update"
import { PgEffectDeleteBase } from "drizzle-orm/pg-core/effect/delete"
import { PgEffectDatabase } from "drizzle-orm/pg-core/effect/db"
import type { PgEffectTransaction } from "drizzle-orm/pg-core/effect/session"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { sql } from "drizzle-orm"

type Rows<T> = T extends Effect.Effect<infer A, any, any> ? (A extends readonly unknown[] ? A : never) : never
type Err<T> = T extends Effect.Effect<any, infer E, any> ? E : never
type Ctx<T> = T extends Effect.Effect<any, any, infer R> ? R : never

interface Terminal {
  get(): Effect.Effect<Rows<this>[number] | undefined, Err<this>, Ctx<this>>
  all(): Effect.Effect<Rows<this>, Err<this>, Ctx<this>>
  run(): Effect.Effect<void, Err<this>, Ctx<this>>
}

declare module "drizzle-orm/pg-core/effect/select" {
  interface PgEffectSelectBase<
    TTableName extends string | undefined,
    TSelection extends ColumnsSelection | undefined,
    TSelectMode extends SelectMode,
    TNullabilityMap extends Record<string, JoinNullability> = TTableName extends string
      ? Record<TTableName, "not-null">
      : {},
    TDynamic extends boolean = false,
    TExcludedMethods extends string = never,
    TResult extends any[] = SelectResult<TSelection, TSelectMode, TNullabilityMap>[],
    TSelectedFields extends ColumnsSelection = BuildSubquerySelection<
      Assume<TSelection, ColumnsSelection>,
      TNullabilityMap
    >,
    TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
  > extends Terminal {}
}
declare module "drizzle-orm/pg-core/effect/insert" {
  interface PgEffectInsertBase<
    TTable extends PgTable,
    TQueryResult extends PgQueryResultHKT,
    TSelectedFields = undefined,
    TReturning = undefined,
    TDynamic extends boolean = false,
    TExcludedMethods extends string = never,
    TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
  > extends Terminal {}
}
declare module "drizzle-orm/pg-core/effect/update" {
  interface PgEffectUpdateBase<
    TTable extends PgTable,
    TQueryResult extends PgQueryResultHKT,
    TFrom extends PgTable | Subquery | PgViewBase | SQL | undefined = undefined,
    TSelectedFields extends ColumnsSelection | undefined = undefined,
    TReturning extends Record<string, unknown> | undefined = undefined,
    TNullabilityMap extends Record<string, JoinNullability> = Record<TTable["_"]["name"], "not-null">,
    TJoins extends Join[] = [],
    TDynamic extends boolean = false,
    TExcludedMethods extends string = never,
    TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
  > extends Terminal {}
}
declare module "drizzle-orm/pg-core/effect/delete" {
  interface PgEffectDeleteBase<
    TTable extends PgTable,
    TQueryResult extends PgQueryResultHKT,
    TSelectedFields extends ColumnsSelection | undefined = undefined,
    TReturning extends Record<string, unknown> | undefined = undefined,
    TDynamic extends boolean = false,
    TExcludedMethods extends string = never,
    TEffectHKT extends QueryEffectHKTBase = QueryEffectHKTBase,
  > extends Terminal {}
}
declare module "drizzle-orm/pg-core/effect/db" {
  interface PgEffectDatabase<TEffectHKT, TQueryResult, TRelations> {
    run(query: SQLWrapper | string): Effect.Effect<void, TEffectHKT["error"], TEffectHKT["context"]>
    all<T = unknown>(query: SQLWrapper | string): Effect.Effect<T[], TEffectHKT["error"], TEffectHKT["context"]>
    get<T = unknown>(query: SQLWrapper | string): Effect.Effect<T | undefined, TEffectHKT["error"], TEffectHKT["context"]>
    transaction<A, E, R>(
      transaction: (tx: PgEffectTransaction<TEffectHKT, TQueryResult, TRelations>) => Effect.Effect<A, E, R>,
      config: { readonly behavior?: "deferred" | "immediate" | "exclusive" },
    ): Effect.Effect<A, E | SqlError, R>
  }
}

for (const builder of [PgEffectSelectBase, PgEffectInsertBase, PgEffectUpdateBase, PgEffectDeleteBase]) {
  const proto = builder.prototype as any
  proto.get = function (this: Effect.Effect<readonly unknown[]>) {
    return Effect.map(this, (rows) => rows[0])
  }
  proto.all = function (this: Effect.Effect<readonly unknown[]>) {
    return this
  }
  proto.run = function (this: Effect.Effect<unknown>) {
    return Effect.asVoid(this)
  }
}
const database = PgEffectDatabase.prototype as any
database.run = function (query: SQLWrapper | string) {
  return Effect.asVoid(this.execute(query))
}
database.all = function (query: SQLWrapper | string) {
  return this.execute(query)
}
database.get = function (query: SQLWrapper | string) {
  return Effect.map(this.execute(query), (rows: readonly unknown[]) => rows[0])
}

const transaction = database.transaction
database.transaction = function (fn: (tx: any) => Effect.Effect<unknown, unknown, unknown>, config?: { behavior?: string }) {
  if (config?.behavior !== "immediate" && config?.behavior !== "exclusive") return transaction.call(this, fn)
  return transaction.call(this, (tx: any) =>
    Effect.flatMap(tx.execute(sql`select pg_advisory_xact_lock(7471, hashtext(current_schema()))`), () => fn(tx)),
  )
}
