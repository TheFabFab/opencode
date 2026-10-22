import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Effect, Tracer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

// The prompt loop reads history back to the newest compaction, a page at a time. These cases
// hold it to the full read it replaces (`filterCompacted` over `stream`) and count the pages.

const it = testEffect(LayerNode.compile(LayerNode.group([SessionNs.node, MessageV2.node, SessionProjector.node])))

const withSession = <A, E, R>(fn: (sessionID: SessionID) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      return (yield* session.create({})).id
    }),
    fn,
    (sessionID) => SessionNs.Service.use((session) => session.remove(sessionID)).pipe(Effect.ignore),
  )

let clock = Date.now()

const addUser = Effect.fn("Test.addUser")(function* (sessionID: SessionID) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: clock++ },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
  } as unknown as SessionV1.Info)
  yield* session.updatePart({ id: PartID.ascending(), sessionID, messageID: id, type: "text", text: id })
  return id
})

const addUsers = Effect.fn("Test.addUsers")(function* (sessionID: SessionID, count: number) {
  const ids = [] as MessageID[]
  for (let i = 0; i < count; i++) ids.push(yield* addUser(sessionID))
  return ids
})

const addSummary = Effect.fn("Test.addSummary")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  finished: boolean,
) {
  const session = yield* SessionNs.Service
  yield* session.updateMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "assistant",
    time: { created: clock++ },
    parentID,
    modelID: ModelV2.ID.make("test"),
    providerID: ProviderV2.ID.make("test"),
    mode: "",
    agent: "default",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    summary: true,
    finish: finished ? "end_turn" : undefined,
  } as unknown as SessionV1.Info)
})

/** A user message carrying a compaction part, answered by its summary. */
const addCompaction = Effect.fn("Test.addCompaction")(function* (
  sessionID: SessionID,
  options: { tail?: MessageID; finished?: boolean } = {},
) {
  const session = yield* SessionNs.Service
  const id = yield* addUser(sessionID)
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID: id,
    type: "compaction",
    auto: true,
    tail_start_id: options.tail,
  } as any)
  yield* addSummary(sessionID, id, options.finished ?? true)
  return id
})

/** Runs `effect` and counts the history pages it reads. */
const countingPages = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const native = yield* Effect.tracer
    let pages = 0
    const tracer = Tracer.make({
      span(options) {
        if (options.name === "MessageV2.page") pages++
        return native.span(options)
      },
    })
    const result = yield* effect.pipe(Effect.withTracer(tracer))
    return { result, pages }
  })

// Each case writes up to a hundred messages through the event log; a loaded runner needs longer than the default.
const TIMEOUT = 60_000

const ids = (messages: readonly SessionV1.WithParts[]) => messages.map((message) => message.info.id)

/** The bounded read matches the full one, and reads `pages` pages where the full read needs `fullPages`. */
const expectBounded = (sessionID: SessionID) =>
  Effect.gen(function* () {
    const bounded = yield* countingPages(MessageV2.filterCompactedEffect(sessionID))
    const full = yield* countingPages(
      MessageV2.stream(sessionID).pipe(Effect.map((all) => MessageV2.filterCompacted(all))),
    )
    expect(ids(bounded.result)).toEqual(ids(full.result))
    return { pages: bounded.pages, fullPages: full.pages, kept: bounded.result.length }
  })

describe("documentor: MessageV2.filterCompactedEffect reads back to the newest compaction", () => {
  it.instance(
    "reads every page of a session without a compaction",
    () =>
      withSession((sessionID) =>
        Effect.gen(function* () {
          yield* addUsers(sessionID, 60)
          const { pages, fullPages, kept } = yield* expectBounded(sessionID)
          expect(kept).toBe(60)
          expect(pages).toBe(fullPages)
        }),
      ),
    TIMEOUT,
  )

  it.instance(
    "stops at a compaction that retains no tail",
    () =>
      withSession((sessionID) =>
        Effect.gen(function* () {
          yield* addUsers(sessionID, 60)
          yield* addCompaction(sessionID)
          yield* addUsers(sessionID, 3)
          const { pages, fullPages, kept } = yield* expectBounded(sessionID)
          expect(kept).toBe(5)
          expect(pages).toBe(1)
          expect(fullPages).toBe(2)
        }),
      ),
    TIMEOUT,
  )

  it.instance(
    "keeps a retained tail that spans a page boundary",
    () =>
      withSession((sessionID) =>
        Effect.gen(function* () {
          yield* addUsers(sessionID, 40)
          const tail = yield* addUsers(sessionID, 60)
          yield* addCompaction(sessionID, { tail: tail[0] })
          yield* addUsers(sessionID, 3)
          const { pages, fullPages, kept } = yield* expectBounded(sessionID)
          expect(kept).toBe(65)
          expect(pages).toBe(2)
          expect(fullPages).toBe(3)
        }),
      ),
    TIMEOUT,
  )

  it.instance(
    "stops at the newer of two compactions",
    () =>
      withSession((sessionID) =>
        Effect.gen(function* () {
          yield* addUsers(sessionID, 40)
          yield* addCompaction(sessionID)
          yield* addUsers(sessionID, 40)
          yield* addCompaction(sessionID)
          yield* addUsers(sessionID, 2)
          const { pages, fullPages, kept } = yield* expectBounded(sessionID)
          expect(kept).toBe(4)
          expect(pages).toBe(1)
          expect(fullPages).toBe(2)
        }),
      ),
    TIMEOUT,
  )

  it.instance(
    "reads past a compaction whose summary never finished",
    () =>
      withSession((sessionID) =>
        Effect.gen(function* () {
          yield* addUsers(sessionID, 60)
          yield* addCompaction(sessionID, { finished: false })
          yield* addUsers(sessionID, 2)
          const { pages, fullPages, kept } = yield* expectBounded(sessionID)
          expect(kept).toBe(64)
          expect(pages).toBe(fullPages)
        }),
      ),
    TIMEOUT,
  )

  it.instance("returns nothing for a session that does not exist", () =>
    Effect.gen(function* () {
      expect(yield* MessageV2.filterCompactedEffect("ses_missing" as SessionID)).toEqual([])
    }),
  )
})

describe("documentor: Session.scanNewestFirst", () => {
  it.instance(
    "stops reading pages where the visitor stops",
    () =>
      withSession((sessionID) =>
        Effect.gen(function* () {
          const written = yield* addUsers(sessionID, 70)
          const session = yield* SessionNs.Service
          const seen = [] as MessageID[]
          const { pages } = yield* countingPages(
            session.scanNewestFirst({
              sessionID,
              visit: (message) => {
                seen.push(message.info.id)
                return seen.length < 10
              },
            }),
          )
          expect(seen).toEqual(written.slice(-10).reverse())
          expect(pages).toBe(1)
        }),
      ),
    TIMEOUT,
  )
})
