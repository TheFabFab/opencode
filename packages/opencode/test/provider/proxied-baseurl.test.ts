import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import catalogue from "../tool/fixtures/models-api.json"

const previousAuth = process.env.OPENCODE_AUTH_CONTENT

afterEach(async () => {
  if (previousAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = previousAuth
  await disposeAllInstances()
})

// The chat process's catalogue carries the documentor-* ids as copies of their
// family's entry, so the providers are present without a config section.
const providers = catalogue as unknown as Record<string, ModelsDev.Provider>
const documentorCatalogue = {
  ...providers,
  "documentor-openai": { ...providers.openai, id: "documentor-openai", env: [] },
  "documentor-anthropic": { ...providers.anthropic, id: "documentor-anthropic", env: [] },
}

const it = testEffect(
  LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node, CrossSpawnSpawner.node, ModelsDev.node]), [
    [
      ModelsDev.node,
      Layer.succeed(
        ModelsDev.Service,
        ModelsDev.Service.of({ get: () => Effect.succeed(documentorCatalogue), refresh: () => Effect.void }),
      ),
    ],
  ]),
)

const ticket = "ticket-sentinel-b4se"
const proxy = (id: string) => `http://127.0.0.1:9/provider/${id}`

// The URL the SDK would send a request to, read from the built language model.
type LanguageConfig = { config: { baseURL?: string; url?: (input: { path: string; modelId: string }) => string } }
const requestURL = (language: unknown, path: string) => {
  const config = (language as LanguageConfig).config
  return config.url ? config.url({ path, modelId: "m" }) : `${config.baseURL}${path}`
}

const resolve = (
  content: Record<string, unknown>,
  config: Record<string, unknown>,
  providerID: string,
  modelID: string,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(content)
    }),
    () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const info = yield* provider.getProvider(ProviderV2.ID.make(providerID))
            const model = yield* provider.getModel(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID))
            const language = yield* provider.getLanguage(model)
            return { baseURL: info.options.baseURL, language }
          }),
        { config: { formatter: false, lsp: false, ...config } },
      ),
    () => Effect.void,
  )

describe("a proxied auth entry decides the provider's baseURL", () => {
  it.live("a proxied api-type documentor-openai with no config baseURL resolves to the proxyBaseURL", () =>
    Effect.gen(function* () {
      const result = yield* resolve(
        { "documentor-openai": { type: "api", key: ticket, proxyBaseURL: proxy("documentor-openai") } },
        {},
        "documentor-openai",
        "gpt-5.5",
      )
      expect(result.baseURL).toBe(proxy("documentor-openai"))
      expect(requestURL(result.language, "/responses")).toBe(`${proxy("documentor-openai")}/responses`)
    }),
  )

  it.live("a proxied documentor-anthropic api entry resolves to the proxyBaseURL", () =>
    Effect.gen(function* () {
      const result = yield* resolve(
        { "documentor-anthropic": { type: "api", key: ticket, proxyBaseURL: proxy("documentor-anthropic") } },
        {},
        "documentor-anthropic",
        "claude-sonnet-4-5",
      )
      expect(result.baseURL).toBe(proxy("documentor-anthropic"))
      expect(requestURL(result.language, "/messages")).toStartWith(`${proxy("documentor-anthropic")}/`)
    }),
  )

  it.live("a config baseURL outside the proxy is replaced by the proxyBaseURL", () =>
    Effect.gen(function* () {
      const result = yield* resolve(
        { "documentor-openai": { type: "api", key: ticket, proxyBaseURL: proxy("documentor-openai") } },
        { provider: { "documentor-openai": { options: { baseURL: "https://api.openai.com/v1" } } } },
        "documentor-openai",
        "gpt-5.5",
      )
      expect(result.baseURL).toBe(proxy("documentor-openai"))
    }),
  )

  it.live("a config baseURL under the proxy is kept (documentor-anthropic's /v1)", () =>
    Effect.gen(function* () {
      const result = yield* resolve(
        { "documentor-anthropic": { type: "api", key: ticket, proxyBaseURL: proxy("documentor-anthropic") } },
        { provider: { "documentor-anthropic": { options: { baseURL: `${proxy("documentor-anthropic")}/v1` } } } },
        "documentor-anthropic",
        "claude-sonnet-4-5",
      )
      expect(result.baseURL).toBe(`${proxy("documentor-anthropic")}/v1`)
      expect(requestURL(result.language, "/messages")).toBe(`${proxy("documentor-anthropic")}/v1/messages`)
    }),
  )

  it.live("an unproxied provider's configured baseURL is unchanged", () =>
    Effect.gen(function* () {
      const result = yield* resolve(
        { openai: { type: "api", key: "sk-test" } },
        { provider: { openai: { options: { baseURL: "https://gateway.example.test/v1" } } } },
        "openai",
        "gpt-5.5",
      )
      expect(result.baseURL).toBe("https://gateway.example.test/v1")
      expect(requestURL(result.language, "/responses")).toBe("https://gateway.example.test/v1/responses")
    }),
  )
})
