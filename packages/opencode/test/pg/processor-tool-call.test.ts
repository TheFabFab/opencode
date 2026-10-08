import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent } from "@opencode-ai/llm"
import { expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// A tool call's arguments stream as one delta per chunk the provider sends:
// thousands for a large edit. The processor keeps the call in memory from
// tool-input-start on, so a delta must not read the stored part — on Postgres
// each read is a round trip.

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: { apiKey: "test-key", baseURL: "http://localhost:1/v1" },
    },
  },
}

const DELTAS = 2000

// What kpg-agent-tools returns when it refuses a batch of proposals; the MCP
// client turns an isError result into an Error carrying this text.
const REFUSAL = JSON.stringify({
  success: false,
  error: "Invalid document proposals. Revise the listed changes and call this tool again; do not apply them directly.",
  errors: Array.from(
    { length: 9 },
    (_, index) =>
      `workspace:notes.md: files[0].changes[${index * 2 + 1}] and files[0].changes[${index * 2 + 2}] overlap. Use separate non-overlapping original passages, or combine dependent edits into one suggestion.`,
  ),
  checkedFiles: ["workspace:notes.md"],
  uncheckedFiles: [],
})

const scripted = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-1", name: "propose_document_changes" }),
        ...Array.from({ length: DELTAS }, () =>
          LLMEvent.toolInputDelta({ id: "call-1", name: "propose_document_changes", text: "x" }),
        ),
        LLMEvent.toolInputEnd({ id: "call-1", name: "propose_document_changes" }),
        LLMEvent.toolCall({ id: "call-1", name: "propose_document_changes", input: { files: [] } }),
        LLMEvent.toolError({
          id: "call-1",
          name: "propose_document_changes",
          message: REFUSAL,
          error: new Error(REFUSAL),
        }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ),
  }),
)

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      SessionProcessor.node,
      Session.node,
      SessionProjector.node,
      Provider.node,
      Database.node,
      EventV2Bridge.node,
      SessionStatus.node,
      CrossSpawnSpawner.node,
    ]),
    [
      [SessionSummary.node, summary],
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
      [LLM.node, scripted],
    ],
  ),
)

const agent: Agent.Info = {
  name: "build",
  mode: "primary",
  options: {},
  permission: [{ permission: "*", pattern: "*", action: "allow" }],
}

it.live("a streamed tool call reads its part a bounded number of times, and its error reaches the model whole", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const processors = yield* SessionProcessor.Service
        const session = yield* Session.Service
        const provider = yield* Provider.Service

        const chat = yield* session.create({})
        const parent = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          messageID: parent.id,
          sessionID: chat.id,
          type: "text",
          text: "revise the notes",
        })
        const msg = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: chat.id,
          mode: "build",
          agent: "build",
          path: { cwd: path.resolve(dir), root: path.resolve(dir) },
          cost: 0,
          tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: parent.id,
          time: { created: Date.now() },
          finish: "end_turn",
        } satisfies SessionV1.Assistant)
        const model = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model })

        // The processor holds this same service object, so wrapping the method counts its reads.
        const getPart = session.getPart
        let reads = 0
        Object.assign(session, {
          getPart: (input: Parameters<typeof getPart>[0]) => {
            reads++
            return getPart(input)
          },
        })
        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: ref,
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model,
          agent,
          system: [],
          messages: [{ role: "user", content: "revise the notes" }],
          tools: {},
        })
        Object.assign(session, { getPart })

        expect(reads).toBeLessThan(10)

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") expect(call.state.error).toBe(REFUSAL)

        const userParts = yield* MessageV2.parts(parent.id)
        const messages = yield* Effect.promise(() =>
          MessageV2.toModelMessages(
            [
              { info: parent, parts: userParts },
              { info: msg, parts },
            ],
            model,
          ),
        )
        const results = messages.flatMap((message) =>
          message.role === "tool" ? message.content.filter((content) => content.type === "tool-result") : [],
        )
        expect(results).toHaveLength(1)
        expect(results[0].output).toEqual({ type: "error-text", value: REFUSAL })
      }),
    { config: cfg },
  ),
)
