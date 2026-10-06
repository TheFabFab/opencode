import { describe, expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
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

const fill = Effect.fn("Test.fill")(function* (sessionID: SessionID, count: number, time: (i: number) => number) {
  const session = yield* SessionNs.Service
  const ids = [] as MessageID[]
  for (let i = 0; i < count; i++) {
    const id = MessageID.ascending()
    ids.push(id)
    yield* session.updateMessage({
      id,
      sessionID,
      role: "user",
      time: { created: time(i) },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    } as unknown as SessionV1.Info)
    yield* session.updatePart({ id: PartID.ascending(), sessionID, messageID: id, type: "text", text: `m${i}` })
  }
  return ids
})

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
        const read = yield* session.get(sessionID)
        expect(read.title).toBe("before\uFFFDafter")
      }),
    ),
  )

  it.instance("message times keep fractions and page in order", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 4, (i: number) => 1000.5 + i)
        const first = yield* MessageV2.page({ sessionID, limit: 2 })
        const second = yield* MessageV2.page({ sessionID, limit: 2, before: first.cursor! })
        expect(first.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(second.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))
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

  it.instance("non-integer numbers in count columns", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db.update(SessionTable).set({ tokens_input: 10.6 }).where(eq(SessionTable.id, sessionID)).run()
        expect((yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())!.tokens_input).toBe(
          11,
        )
        const exit = yield* Effect.suspend(() =>
          db.update(SessionTable).set({ tokens_input: Number.NaN }).where(eq(SessionTable.id, sessionID)).run(),
        ).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
        const session = yield* SessionNs.Service
        expect((yield* session.get(sessionID)).id).toBe(sessionID)
      }),
    ),
  )

  it.instance("cost keeps full double precision", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        yield* db
          .update(SessionTable)
          .set({ cost: 0.1 + 0.2 })
          .where(eq(SessionTable.id, sessionID))
          .run()
        expect((yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get())!.cost).toBe(
          0.1 + 0.2,
        )
      }),
    ),
  )
})
