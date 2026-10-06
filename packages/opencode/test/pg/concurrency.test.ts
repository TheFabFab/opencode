import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { EventTable } from "@opencode-ai/core/event/sql"
import { cliIt } from "../lib/cli-process"
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

/** Aggregates in `schema` whose sequence numbers are not exactly 0..n. Empty means every log is gap-free. */
const broken = (schema: string) =>
  sql.raw(`
    select aggregate_id from "${schema}".event group by aggregate_id
    having count(*) <> max(seq) + 1 or count(distinct seq) <> count(*)
  `)

describe("concurrent writers", () => {
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
        expect(
          yield* db.all(broken((yield* db.get<{ name: string }>(sql`select current_schema() as name`))!.name)),
        ).toEqual([])
        expect((yield* session.get(sessionID)).title).toMatch(/^title \d+$/)
      }),
    ),
  )

  it.instance("concurrent updates to different fields of one session both survive", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        // The title generator and the summariser both run after a turn, in
        // parallel, and each writes the whole session row.
        for (let round = 0; round < 10; round++) {
          yield* Effect.all(
            [
              session.setTitle({ sessionID, title: `title ${round}` }),
              session.setSummary({ sessionID, summary: { additions: round, deletions: 0, files: 0 } }),
            ],
            { concurrency: "unbounded" },
          )
          const info = yield* session.get(sessionID)
          expect(info.title).toBe(`title ${round}`)
          expect(info.summary).toMatchObject({ additions: round })
        }
      }),
    ),
  )

  cliIt.concurrent(
    "two processes on one scope",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        // This connection is the administrator's; the two processes below share one schema it creates.
        const { db } = yield* Database.Service
        const schema = `two_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`
        yield* db.run(`CREATE SCHEMA "${schema}"`)
        yield* Effect.addFinalizer(() => db.run(`DROP SCHEMA "${schema}" CASCADE`).pipe(Effect.ignore))
        yield* DatabaseMigration.migrate(db, { schema })

        yield* llm.text("first reply")
        yield* llm.text("second reply")
        const env = { OPENCODE_DATABASE_SCHEMA: schema, OPENCODE_DATABASE_EPHEMERAL: "0" }
        const [a, b] = yield* Effect.all([opencode.run("one", { env }), opencode.run("two", { env })], {
          concurrency: 2,
        })
        opencode.expectExit(a, 0)
        opencode.expectExit(b, 0)

        const counts = yield* db.get<{ sessions: number; events: number }>(
          sql.raw(
            `select (select count(*)::int from "${schema}".session) as sessions, (select count(*)::int from "${schema}".event) as events`,
          ),
        )
        expect(counts!.sessions).toBe(2)
        expect(counts!.events).toBeGreaterThan(2)
        expect(yield* db.all(broken(schema))).toEqual([])
      }).pipe(Effect.provide(LayerNode.compile(Database.node))),
    60_000,
  )
})
