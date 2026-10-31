import { afterAll, afterEach, beforeAll, expect } from "bun:test"
import { Effect, Stream } from "effect"
import fs from "fs/promises"
import http from "node:http"
import https from "node:https"
import os from "os"
import path from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import type { ModelsDev } from "@opencode-ai/core/models-dev"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Provider } from "@/provider/provider"
import { LLM } from "../../src/session/llm"
import type { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import catalogue from "../tool/fixtures/models-api.json"

const ticket = "ticket-sentinel-no-egress"

const openai = (catalogue as unknown as Record<string, ModelsDev.Provider>).openai
const modelsDir = await fs.mkdtemp(path.join(os.tmpdir(), "proxy-no-egress-"))
const modelsPath = path.join(modelsDir, "models.json")
await Bun.write(modelsPath, JSON.stringify({ "documentor-openai": { ...openai, id: "documentor-openai", env: [] } }))

const previous = {
  auth: process.env.OPENCODE_AUTH_CONTENT,
  modelsPath: Flag.OPENCODE_MODELS_PATH,
  noFetch: Flag.OPENCODE_DISABLE_MODELS_FETCH,
}

const seen: { hosts: string[]; authorization: string[]; paths: string[] } = { hosts: [], authorization: [], paths: [] }
const originalFetch = globalThis.fetch
const originalHttpRequest = http.request
const originalHttpsRequest = https.request

const hostOf = (input: unknown) => {
  if (typeof input === "string") return new URL(input).hostname
  if (input instanceof URL) return input.hostname
  if (input instanceof Request) return new URL(input.url).hostname
  const options = input as { hostname?: string; host?: string }
  return options.hostname ?? options.host ?? "localhost"
}

// Other test files in the same process may have written auth.json already; the turn must not touch it.
const authFile = () =>
  fs.readFile(path.join(process.env.XDG_DATA_HOME!, "opencode", "auth.json"), "utf8").catch(() => undefined)

let server: ReturnType<typeof Bun.serve>

beforeAll(() => {
  // The flags are read when the module loads, so the test sets them on the object.
  Flag.OPENCODE_MODELS_PATH = modelsPath
  Flag.OPENCODE_DISABLE_MODELS_FETCH = true
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.authorization.push(request.headers.get("authorization") ?? "")
      seen.paths.push(new URL(request.url).pathname)
      await request.text()
      const events = [
        { type: "response.created", response: { id: "resp_1", created_at: 1, model: "gpt-5.5" } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "msg_1", role: "assistant", content: [] },
        },
        {
          type: "response.content_part.added",
          item_id: "msg_1",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "" },
        },
        { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello" },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Hello" }] },
        },
        { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 1, output_tokens: 1 } } },
      ]
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "Content-Type": "text/event-stream" },
      })
    },
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.hosts.push(hostOf(input))
    return originalFetch(input, init)
  }) as typeof fetch
  http.request = ((...args: unknown[]) => {
    seen.hosts.push(hostOf(args[0]))
    return (originalHttpRequest as (...a: unknown[]) => http.ClientRequest)(...args)
  }) as typeof http.request
  https.request = ((...args: unknown[]) => {
    seen.hosts.push(hostOf(args[0]))
    return (originalHttpsRequest as (...a: unknown[]) => http.ClientRequest)(...args)
  }) as typeof https.request
})

afterEach(async () => {
  await disposeAllInstances()
})

afterAll(async () => {
  globalThis.fetch = originalFetch
  http.request = originalHttpRequest
  https.request = originalHttpsRequest
  Flag.OPENCODE_MODELS_PATH = previous.modelsPath
  Flag.OPENCODE_DISABLE_MODELS_FETCH = previous.noFetch
  if (previous.auth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = previous.auth
  server.stop(true)
  await fs.rm(modelsDir, { recursive: true, force: true })
})

const it = testEffect(AppNodeBuilder.build(LayerNode.group([LLM.node, Provider.node])))

it.instance(
  "in proxy mode a turn reaches no host but loopback and writes nothing under XDG_DATA_HOME",
  () =>
    Effect.gen(function* () {
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
        "documentor-openai": {
          type: "oauth",
          access: ticket,
          refresh: ticket,
          expires: 4102444800000,
          proxyBaseURL: `http://127.0.0.1:${server.port}/provider/documentor-openai`,
        },
      })
      const before = yield* Effect.promise(() => authFile())
      const model = yield* Provider.use.getModel(ProviderV2.ID.make("documentor-openai"), ModelV2.ID.make("gpt-5.5"))
      const sessionID = SessionID.make("session-no-egress")
      const agent = {
        name: "test",
        mode: "primary",
        options: {},
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      } satisfies Agent.Info
      const user = {
        id: MessageID.make("msg_user-no-egress"),
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: agent.name,
        model: { providerID: ProviderV2.ID.make("documentor-openai"), modelID: model.id },
      } satisfies SessionV1.User

      yield* LLM.Service.use((svc) =>
        svc
          .stream({
            user,
            sessionID,
            model,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "Hello" }],
            tools: {},
          })
          .pipe(Stream.runDrain),
      )

      expect(seen.authorization).toEqual([`Bearer ${ticket}`])
      expect(seen.paths).toEqual(["/provider/documentor-openai/codex/responses"])
      expect(seen.hosts.length).toBeGreaterThan(0)
      expect([...new Set(seen.hosts)]).toEqual(["127.0.0.1"])
      expect(yield* Effect.promise(() => authFile())).toBe(before)
    }),
  { config: { enabled_providers: ["documentor-openai"] } },
)
