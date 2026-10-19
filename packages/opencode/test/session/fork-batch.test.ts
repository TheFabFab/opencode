import { describe, expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([SessionNs.node, MessageV2.node, SessionProjector.node, Database.node, EventV2.node]),
  ),
)

/** Writes `count` messages, alternating user and assistant, each assistant reply with three parts. */
const seed = (sessionID: SessionID, count: number) =>
  Effect.gen(function* () {
    const session = yield* SessionNs.Service
    let parent: MessageID | undefined
    for (let index = 0; index < count; index++) {
      const id = MessageID.ascending()
      const user = index % 2 === 0
      const info = user
        ? {
            id,
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: "test",
            model: { providerID: "test", modelID: "test" },
            tools: {},
            mode: "",
          }
        : {
            id,
            sessionID,
            role: "assistant",
            time: { created: Date.now() },
            parentID: parent,
            modelID: "test",
            providerID: "test",
            mode: "",
            agent: "default",
            path: { cwd: "/", root: "/" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          }
      const parts = Array.from({ length: user ? 1 : 3 }, (_, part) => ({
        id: PartID.ascending(),
        sessionID,
        messageID: id,
        type: "text" as const,
        text: `message ${index} part ${part}`,
      }))
      yield* session.saveMessage(info as unknown as SessionV1.Info, parts)
      if (user) parent = id
    }
  })

const currentSchema = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return (yield* db.get<{ name: string }>(sql`select current_schema() as name`))!.name
})

/** Aggregates whose sequence numbers are not exactly 0..n. Empty means every log is gap-free. */
const broken = (schema: string) =>
  sql.raw(`
    select aggregate_id from "${schema}".event group by aggregate_id
    having count(*) <> max(seq) + 1 or count(distinct seq) <> count(*)
  `)

describe("documentor: fork publishes its copy as one batch", () => {
  it.instance("copies every message and part with a gap-free event log", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const { db } = yield* Database.Service
      const origin = yield* session.create({})
      yield* seed(origin.id, 10)

      const fork = yield* session.fork({ sessionID: origin.id })

      const source = yield* session.messages({ sessionID: origin.id })
      const copied = yield* session.messages({ sessionID: fork.id })
      const text = (msgs: typeof source) =>
        msgs.map((msg) => [msg.info.role, msg.parts.map((part) => (part as { text?: string }).text)])
      expect(text(copied)).toEqual(text(source))
      const byID = new Map(copied.map((msg) => [msg.info.id, msg]))
      for (const msg of copied) {
        if (msg.info.role === "assistant") expect(byID.get(msg.info.parentID)?.info.role).toBe("user")
      }
      const forkEvents = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, fork.id)).all()
      expect(forkEvents.length).toBeGreaterThanOrEqual(1 + 10 + 20)
      expect(yield* db.all(broken(yield* currentSchema))).toEqual([])
    }),
  )

  it.instance("lets another chat in the same schema write while a fork is copying", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const origin = yield* session.create({})
      const other = yield* session.create({})
      yield* seed(origin.id, 60)

      const [fork] = yield* Effect.all(
        [
          session.fork({ sessionID: origin.id }),
          Effect.all(
            Array.from({ length: 10 }, (_, index) =>
              session.setTitle({ sessionID: other.id, title: `title ${index}` }),
            ),
            { concurrency: 4 },
          ),
        ],
        { concurrency: "unbounded" },
      )

      expect((yield* session.messages({ sessionID: fork.id })).length).toBe(60)
      expect((yield* session.get(other.id)).title).toMatch(/^title \d$/)
      const { db } = yield* Database.Service
      expect(yield* db.all(broken(yield* currentSchema))).toEqual([])
    }),
  )

  it.instance("removes the forked session again when the copy cannot commit", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const origin = yield* session.create({})
      yield* seed(origin.id, 4)
      yield* events.project(SessionV1.Event.PartUpdated, (event) =>
        event.data.sessionID === origin.id ? Effect.void : Effect.die("projector failed"),
      )
      const sessionsBefore = (yield* db.select({ id: SessionTable.id }).from(SessionTable).all()).length

      const exit = yield* session.fork({ sessionID: origin.id }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBeTrue()
      expect((yield* db.select({ id: SessionTable.id }).from(SessionTable).all()).length).toBe(sessionsBefore)
      expect((yield* session.messages({ sessionID: origin.id })).length).toBe(4)
    }),
  )
})
