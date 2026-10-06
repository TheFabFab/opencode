import { describe, expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { type SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([SessionNs.node, MessageV2.node, SessionProjector.node, Database.node])),
)

const withSession = <A, E, R>(
  fn: (input: { session: SessionNs.Interface; sessionID: SessionID }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      return { session, sessionID: created.id }
    }),
    fn,
    (input) => input.session.remove(input.sessionID).pipe(Effect.ignore),
  )

const broken = sql`
  select aggregate_id from event group by aggregate_id
  having count(*) <> max(seq) + 1 or count(distinct seq) <> count(*)
`

describe("values SQLite tolerated", () => {
  it.instance("all-digit strings stay strings", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        yield* session.setTitle({ sessionID, title: "12345" })
        const listed = yield* session.list()
        expect(listed.find((item) => item.id === sessionID)?.title).toBe("12345")
      }),
    ),
  )

  it.instance("NUL in a text column", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        yield* session.setTitle({ sessionID, title: "before\u0000after" })
        expect((yield* session.get(sessionID)).title).toBe("before�after")
      }),
    ),
  )

  it.instance("non-integer numbers in count columns", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.update(SessionTable).set({ tokens_input: 10.6 }).where(eq(SessionTable.id, sessionID)).run()
        expect((yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())!.tokens_input).toBe(11)
        const exit = yield* Effect.suspend(() =>
          db.update(SessionTable).set({ tokens_input: Number.NaN }).where(eq(SessionTable.id, sessionID)).run(),
        ).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        expect((yield* session.get(sessionID)).id).toBe(sessionID)
      }),
    ),
  )

  it.instance("cost keeps full double precision", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.update(SessionTable).set({ cost: 0.1 + 0.2 }).where(eq(SessionTable.id, sessionID)).run()
        expect((yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())!.cost).toBe(0.1 + 0.2)
      }),
    ),
  )

  it.instance("text compares in byte order, so mixed-case ids sort by creation", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const row = yield* db.get<{ sorted: string[]; below: boolean }>(sql`
        select array_agg(id order by id) as sorted, 'ses_B' < 'ses_a' as below
        from unnest(array['ses_b', 'ses_B', 'ses_a', 'ses_A', 'ses_0']) as id
      `)
      expect(row).toEqual({ sorted: ["ses_0", "ses_A", "ses_B", "ses_a", "ses_b"], below: true })
    }),
  )

  it.instance("concurrent appends to one session", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* Effect.all(
          Array.from({ length: 40 }, (_, index) => session.setTitle({ sessionID, title: `title ${index}` })),
          { concurrency: 8 },
        )
        const events = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()
        expect(events.length).toBeGreaterThanOrEqual(41)
        expect(yield* db.all(broken)).toEqual([])
        expect((yield* session.get(sessionID)).title).toMatch(/^title \d+$/)
      }),
    ),
  )
})
