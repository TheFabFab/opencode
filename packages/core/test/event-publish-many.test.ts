import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Schema, Stream } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { asc, eq } from "drizzle-orm"
import { SessionV1 } from "@opencode-ai/schema/session-v1"
import { Session } from "@opencode-ai/schema/session"
import { testEffect } from "./lib/effect"

const Note = EventV2.define({
  type: "test.batch.note",
  durable: { version: 1, aggregate: "id" },
  schema: { id: Schema.String, text: Schema.String },
})

const Tag = EventV2.define({
  type: "test.batch.tag",
  durable: { version: 2, aggregate: "id" },
  schema: { id: Schema.String, label: Schema.String },
})

const Live = EventV2.define({
  type: "test.batch.live",
  schema: { id: Schema.String },
})

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])))

const rowsOf = (aggregateID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, aggregateID))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
  })

const batch = (aggregateID: string, count: number) =>
  Array.from({ length: count }, (_, index) =>
    index % 3 === 2
      ? EventV2.publication(Tag, { id: aggregateID, label: `tag ${index}` })
      : EventV2.publication(Note, { id: aggregateID, text: `note ${index}` }),
  )

describe("documentor: EventV2.publishMany", () => {
  it.effect("stores the same rows as publishing the events one by one", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const batched = EventV2.ID.create()
      const sequential = EventV2.ID.create()

      yield* events.publishMany(batch(batched, 7))
      for (const { definition, data } of batch(sequential, 7)) {
        yield* events.publish(definition, data as never)
      }

      const shape = (rows: (typeof EventTable.$inferSelect)[], aggregateID: string) =>
        rows.map((row) => ({ seq: row.seq, type: row.type, data: { ...row.data, id: row.data.id === aggregateID } }))
      expect(shape(yield* rowsOf(batched), batched)).toEqual(shape(yield* rowsOf(sequential), sequential))
      expect((yield* rowsOf(batched)).map((row) => row.seq)).toEqual([0, 1, 2, 3, 4, 5, 6])
    }),
  )

  it.effect("continues the aggregate's sequence and is followed by single publishes", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publish(Note, { id: aggregateID, text: "before" })
      const published = yield* events.publishMany(batch(aggregateID, 3))
      yield* events.publish(Note, { id: aggregateID, text: "after" })

      expect(published.map((event) => event.durable?.seq)).toEqual([1, 2, 3])
      expect((yield* rowsOf(aggregateID)).map((row) => row.seq)).toEqual([0, 1, 2, 3, 4])
      const sequence = yield* db
        .select()
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, aggregateID))
        .get()
        .pipe(Effect.orDie)
      expect(sequence?.seq).toBe(4)
    }),
  )

  it.effect("projects every event in order, then notifies each one after the commit", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()
      const order = new Array<string>()
      yield* events.project(Note, (event) => Effect.sync(() => order.push(`project ${event.data.text}`)))
      yield* events.listen((event) =>
        Effect.sync(() => {
          if ((event.data as { id?: string }).id === aggregateID) order.push(`notify ${event.durable?.seq}`)
        }),
      )
      const typed = yield* events.subscribe(Note).pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* events.publishMany([
        EventV2.publication(Note, { id: aggregateID, text: "a" }),
        EventV2.publication(Note, { id: aggregateID, text: "b" }),
      ])

      expect(order).toEqual(["project a", "project b", "notify 0", "notify 1"])
      expect(Array.from(yield* Fiber.join(typed)).map((event) => event.data.text)).toEqual(["a", "b"])
    }),
  )

  it.effect("commits nothing and notifies no one when a projector fails mid-batch", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const aggregateID = EventV2.ID.create()
      const notified = new Array<string>()
      yield* db.run("CREATE TABLE IF NOT EXISTS publish_many_probe (value text NOT NULL)")
      yield* db.run("DELETE FROM publish_many_probe")
      yield* events.project(Note, (event) =>
        event.data.text === "boom"
          ? Effect.die("projector failed")
          : db
              .run(`INSERT INTO publish_many_probe (value) VALUES ('${event.data.text}')`)
              .pipe(Effect.orDie, Effect.asVoid),
      )
      yield* events.listen((event) => Effect.sync(() => notified.push(event.id)))

      const exit = yield* events
        .publishMany([
          EventV2.publication(Note, { id: aggregateID, text: "kept?" }),
          EventV2.publication(Note, { id: aggregateID, text: "boom" }),
        ])
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBeTrue()
      expect(yield* db.all("SELECT value FROM publish_many_probe")).toEqual([])
      expect(yield* rowsOf(aggregateID)).toEqual([])
      expect(
        yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).all(),
      ).toEqual([])
      expect(notified).toEqual([])
    }),
  )

  it.effect("refuses a batch that spans aggregates or holds a live-only event", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const first = EventV2.ID.create()
      const second = EventV2.ID.create()

      const mixed = yield* events
        .publishMany([
          EventV2.publication(Note, { id: first, text: "a" }),
          EventV2.publication(Note, { id: second, text: "b" }),
        ])
        .pipe(Effect.exit)
      const live = yield* events.publishMany([EventV2.publication(Live, { id: first })]).pipe(Effect.exit)

      expect(String(mixed)).toContain("Aggregate mismatch")
      expect(String(live)).toContain("durable events")
      expect(yield* rowsOf(first)).toEqual([])
      expect(yield* events.publishMany([])).toEqual([])
    }),
  )

  it.effect("wakes a durable aggregate stream that is tailing", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      // The stream decodes through the durable manifest, which knows real event types only.
      const aggregateID = Session.ID.create()
      const fiber = yield* events.durable({ aggregateID }).pipe(Stream.take(4), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* events.publishMany(
        Array.from({ length: 4 }, (_, index) =>
          EventV2.publication(SessionV1.Event.MessageRemoved, {
            sessionID: aggregateID,
            messageID: SessionV1.MessageID.ascending(`msg_${index}`),
          }),
        ),
      )

      expect(Array.from(yield* Fiber.join(fiber)).map((event) => event.durable?.seq)).toEqual([0, 1, 2, 3])
    }),
  )

  it.effect("writes a batch larger than one insert chunk", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const aggregateID = EventV2.ID.create()

      yield* events.publishMany(batch(aggregateID, 450))

      const rows = yield* rowsOf(aggregateID)
      expect(rows).toHaveLength(450)
      expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 450 }, (_, index) => index))
    }),
  )
})
