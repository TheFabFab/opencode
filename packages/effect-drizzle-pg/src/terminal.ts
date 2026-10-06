import * as Effect from "effect/Effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { sql } from "drizzle-orm"
import type { Assume, ColumnsSelection, SQL, SQLWrapper, Subquery } from "drizzle-orm"
import type { QueryEffectHKTBase } from "drizzle-orm/effect-core"
import type { PgQueryResultHKT, PgTable } from "drizzle-orm/pg-core"
import type {
  BuildSubquerySelection,
  JoinNullability,
  SelectMode,
  SelectResult,
} from "drizzle-orm/query-builders/select.types"
import type { Join } from "drizzle-orm/pg-core/query-builders/update"
import type { PgViewBase } from "drizzle-orm/pg-core/view-base"
import { PgEffectDatabase } from "drizzle-orm/pg-core/effect/db"
import { PgEffectDeleteBase } from "drizzle-orm/pg-core/effect/delete"
import { PgEffectInsertBase } from "drizzle-orm/pg-core/effect/insert"
import { PgEffectSelectBase } from "drizzle-orm/pg-core/effect/select"
import type { PgEffectTransaction } from "drizzle-orm/pg-core/effect/session"
import { PgEffectUpdateBase } from "drizzle-orm/pg-core/effect/update"

type Rows<T> = T extends Effect.Effect<infer A, any, any> ? (A extends readonly unknown[] ? A : never) : never
type Err<T> = T extends Effect.Effect<any, infer E, any> ? E : never
type Ctx<T> = T extends Effect.Effect<any, any, infer R> ? R : never

/** The three ways opencode's query code ends a builder chain. */
interface Terminal {
  /** The first row, or `undefined` when there is none. */
  get(): Effect.Effect<Rows<this>[number] | undefined, Err<this>, Ctx<this>>
  /** Every row. */
  all(): Effect.Effect<Rows<this>, Err<this>, Ctx<this>>
  /** Runs the statement and discards its result. */
  run(): Effect.Effect<void, Err<this>, Ctx<this>>
}

// Each interface below repeats Drizzle's own type parameters exactly: TypeScript
// merges declarations only when the parameter lists are identical.
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
    get<T = unknown>(
      query: SQLWrapper | string,
    ): Effect.Effect<T | undefined, TEffectHKT["error"], TEffectHKT["context"]>
    /**
     * Every transaction waits for an advisory lock keyed on the current
     * schema before it runs, so two transactions on one schema never overlap.
     * That is what SQLite gave upstream's code through its single connection,
     * and what its read-then-write sequences rely on. `behavior` is accepted
     * for the two call sites that pass it and changes nothing.
     */
    transaction<A, E, R>(
      transaction: (tx: PgEffectTransaction<TEffectHKT, TQueryResult, TRelations>) => Effect.Effect<A, E, R>,
      config: { readonly behavior?: "deferred" | "immediate" | "exclusive" },
    ): Effect.Effect<A, E | SqlError, R>
  }
}

/** Arbitrary constant that namespaces opencode's advisory locks. */
const LOCK_CLASS = 7471

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
database.transaction = function (
  fn: (tx: any) => Effect.Effect<unknown, unknown, unknown>,
  _config?: { behavior?: string },
) {
  return transaction.call(this, (tx: any) =>
    Effect.flatMap(tx.execute(sql`select pg_advisory_xact_lock(${LOCK_CLASS}, hashtext(current_schema()))`), () =>
      fn(tx),
    ),
  )
}
