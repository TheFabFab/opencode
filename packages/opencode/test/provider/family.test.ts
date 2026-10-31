import { afterEach, describe, expect, test } from "bun:test"
import { APICallError, jsonSchema } from "ai"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { ProviderError } from "@/provider/error"
import { isOpenAIFamily, providerFamily } from "@/provider/family"
import { LLMRequestPrep } from "@/session/llm/request"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

describe("providerFamily", () => {
  test.each([
    ["openai", "openai"],
    ["documentor-openai", "openai"],
    ["anthropic", "anthropic"],
    ["documentor-anthropic", "anthropic"],
    ["opencode", "opencode"],
    ["github-copilot", "github-copilot"],
  ])("%s -> %s", (id, family) => {
    expect(providerFamily(id)).toBe(family)
  })

  test("isOpenAIFamily", () => {
    expect(isOpenAIFamily("documentor-openai")).toBe(true)
    expect(isOpenAIFamily("openai")).toBe(true)
    expect(isOpenAIFamily("documentor-anthropic")).toBe(false)
  })
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node])),
)

const modelConfig = {
  id: "gpt-5-mini",
  name: "GPT-5 Mini",
  attachment: false,
  reasoning: false,
  temperature: false,
  tool_call: true,
  release_date: "2025-01-01",
  limit: { context: 100_000, output: 10_000 },
  cost: { input: 0, output: 0 },
  options: {},
}

// The custom loaders run before config providers merge, so a stored API key is
// what makes the provider present when they run.
const withStoredKey = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_AUTH_CONTENT
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ "documentor-openai": { type: "api", key: "sk-proxy" } })
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
        else process.env.OPENCODE_AUTH_CONTENT = previous
      }),
  )

it.live("a documentor-openai model gets the openai custom loader", () =>
  withStoredKey(
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const configured = yield* provider.getProvider(ProviderV2.ID.make("documentor-openai"))
          expect(configured.options.headerTimeout).toBe(300_000)
          const model = yield* provider.getModel(ProviderV2.ID.make("documentor-openai"), ModelV2.ID.make("gpt-5-mini"))
          const language = yield* provider.getLanguage(model)
          expect(language.provider).toEndWith(".responses")
        }),
      {
        config: {
          formatter: false,
          lsp: false,
          provider: {
            "documentor-openai": {
              name: "DocuMentor OpenAI",
              env: [],
              npm: "@ai-sdk/openai",
              models: { "gpt-5-mini": modelConfig },
              options: { apiKey: "proxy-key", baseURL: "http://127.0.0.1:1/v1" },
            },
          },
        },
      },
    ),
  ),
)

const openaiModel = {
  id: "gpt-5-mini",
  providerID: "documentor-openai",
  api: { id: "gpt-5-mini", url: "https://proxy.test/v1", npm: "@ai-sdk/openai" },
  name: "GPT-5 Mini",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, output: 10_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2025-01-01",
  variants: {},
} as any

const oauth = { type: "oauth", refresh: "refresh", access: "access", expires: 1 } as const

test("native runtime supports documentor-openai with oauth and a fetch override", () => {
  const provider = (options: Record<string, unknown>) =>
    ({
      id: ProviderV2.ID.make("documentor-openai"),
      name: "DocuMentor OpenAI",
      source: "config",
      env: [],
      options,
      models: {},
    }) as any
  expect(
    LLMNativeRuntime.status({
      model: openaiModel,
      provider: provider({ apiKey: "k", fetch: async () => new Response() }),
      auth: oauth,
    }),
  ).toMatchObject({ type: "supported" })
  expect(LLMNativeRuntime.status({ model: openaiModel, provider: provider({ apiKey: "k" }), auth: oauth })).toEqual({
    type: "unsupported",
    reason: "OAuth auth requires a provider fetch override",
  })
  expect(
    LLMNativeRuntime.status({
      model: {
        ...openaiModel,
        providerID: "documentor-anthropic",
        api: { ...openaiModel.api, npm: "@ai-sdk/anthropic" },
      },
      provider: { ...provider({ apiKey: "k" }), id: ProviderV2.ID.make("documentor-anthropic") },
      auth: undefined,
    }),
  ).toMatchObject({ type: "supported" })
})

test("request prep treats documentor-openai oauth as isOpenaiOauth", async () => {
  const prepare = (providerID: string) =>
    Effect.runPromise(
      LLMRequestPrep.prepare({
        user: {
          id: "msg_user-test",
          sessionID: "ses_test",
          role: "user",
          time: { created: Date.now() },
          agent: "test",
          model: { providerID, modelID: "gpt-5-mini" },
        } as any,
        sessionID: "ses_test",
        model: { ...openaiModel, providerID },
        agent: { name: "test", mode: "primary", options: {}, permission: [] } as any,
        system: ["be brief"],
        messages: [{ role: "user", content: "Hello" }],
        tools: { lookup: { description: "x", inputSchema: jsonSchema({ type: "object", properties: {} }) } },
        provider: { id: providerID, options: {} } as any,
        auth: oauth,
        plugin: {
          trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
          list: () => Effect.succeed([]),
          init: () => Effect.void,
        } as any,
        flags: { outputTokenMax: 32_000, client: "test" } as any,
        isWorkflow: false,
      }),
    )
  const proxied = await prepare("documentor-openai")
  const direct = await prepare("openai")
  expect(proxied.params.options.instructions).toContain("be brief")
  expect(proxied.messages.some((m) => m.role === "system")).toBe(false)
  expect(proxied.params.options.instructions).toBe(direct.params.options.instructions)
})

test("a documentor-openai provider error is retried as an openai one", () => {
  const error = new APICallError({
    message: "Not Found",
    url: "https://proxy.test/v1/responses",
    requestBodyValues: {},
    statusCode: 404,
    isRetryable: false,
  })
  const retryable = (id: string) => {
    const parsed = ProviderError.parseAPICallError({ providerID: ProviderV2.ID.make(id), error })
    return parsed.type === "api_error" && parsed.isRetryable
  }
  expect(retryable("openai")).toBe(true)
  expect(retryable("documentor-openai")).toBe(true)
  expect(retryable("other")).toBe(false)
})
