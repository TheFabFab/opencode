import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { Hooks } from "@opencode-ai/plugin"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { CodexAuthPlugin } from "../../src/plugin/openai/codex"
import { disposeAllInstances, provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import catalogue from "../tool/fixtures/models-api.json"

const originalFetch = globalThis.fetch
const previousAuth = process.env.OPENCODE_AUTH_CONTENT

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (previousAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = previousAuth
  await disposeAllInstances()
})

const ticket = "ticket-sentinel-7c21"

function createTestJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

type Seen = { url: string; authorization: string | null; accountId: string | null; residency: string | null }

// A stand-in for the credential proxy. Every request the plugin sends through
// the global fetch is recorded, whatever host it was meant for.
function proxy() {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      return new Response("{}")
    },
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    // The models.dev catalogue refresh runs in the background of the test process.
    if (new URL(request.url).host === "models.opencode.ai") return originalFetch(request)
    seen.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      accountId: request.headers.get("ChatGPT-Account-Id"),
      residency: request.headers.get("x-openai-internal-codex-residency"),
    })
    if (new URL(request.url).host !== server.url.host) return new Response("not the proxy", { status: 599 })
    return originalFetch(request)
  }) as typeof fetch
  return {
    seen,
    base: (id: string) => new URL(`/provider/${id}`, server.url).toString(),
    [Symbol.dispose]: () => server.stop(true),
  }
}

function pluginInput(authSet: unknown[] = []) {
  return {
    client: {
      auth: {
        async set(input: unknown) {
          authSet.push(input)
        },
      },
    } as never,
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: { register() {} },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  }
}

function placeholder(proxyBaseURL: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "oauth",
    access: ticket,
    refresh: ticket,
    expires: 4102444800000,
    proxyBaseURL,
    ...overrides,
  }
}

describe("plugin.codex proxy mode", () => {
  test("sends a proxied entry's responses call to proxyBaseURL/codex/responses with the entry's access as bearer", async () => {
    using server = proxy()
    const base = server.base("documentor-openai")
    const hooks = await CodexAuthPlugin(pluginInput(), { providerID: "documentor-openai" })
    const loaded = await hooks.auth!.loader!(
      async () =>
        placeholder(base, {
          accountId: "acc-123",
          access: createTestJwt({ "https://api.openai.com/auth": { chatgpt_compute_residency: "eu" } }),
        }) as never,
      {} as never,
    )

    // What the SDK builds from options.baseURL, and the upstream default URL.
    await loaded.fetch!(`${base}/responses`, { method: "POST", body: "{}" })
    await loaded.fetch!("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })
    await loaded.fetch!("https://api.openai.com/v1/chat/completions", { method: "POST", body: "{}" })

    expect(server.seen.map((item) => item.url)).toEqual([
      `${base}/codex/responses`,
      `${base}/codex/responses`,
      `${base}/codex/responses`,
    ])
    expect(server.seen.every((item) => item.authorization?.startsWith("Bearer ey"))).toBe(true)
    expect(server.seen.every((item) => item.accountId === null && item.residency === null)).toBe(true)
  })

  test("never calls the token endpoint for a proxied entry, even when expires is past", async () => {
    using server = proxy()
    const base = server.base("documentor-openai")
    const hooks = await CodexAuthPlugin(pluginInput(), { providerID: "documentor-openai" })
    const loaded = await hooks.auth!.loader!(async () => placeholder(base, { expires: 0 }) as never, {} as never)

    const response = await loaded.fetch!("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })

    expect(response.status).toBe(200)
    expect(server.seen.some((item) => item.url.includes("auth.openai.com"))).toBe(false)
    expect(server.seen.map((item) => item.url)).toEqual([`${base}/codex/responses`])
    expect(server.seen[0]?.authorization).toBe(`Bearer ${ticket}`)
  })

  test("never calls client.auth.set for a proxied entry", async () => {
    using server = proxy()
    const authSet: unknown[] = []
    const hooks = await CodexAuthPlugin(pluginInput(authSet), { providerID: "documentor-openai" })
    const loaded = await hooks.auth!.loader!(
      async () => placeholder(server.base("documentor-openai"), { access: "", expires: 0 }) as never,
      {} as never,
    )

    await loaded.fetch!("https://api.openai.com/v1/responses", { method: "POST", body: "{}" })

    expect(authSet).toEqual([])
  })

  test("sends no other path to a host but the proxy", async () => {
    using server = proxy()
    const base = server.base("documentor-openai")
    const hooks = await CodexAuthPlugin(pluginInput(), { providerID: "documentor-openai" })
    const loaded = await hooks.auth!.loader!(async () => placeholder(base) as never, {} as never)

    await loaded.fetch!("https://api.openai.com/v1/models?limit=1")
    await loaded.fetch!(new URL(`${base}/other`))

    expect(server.seen.map((item) => item.url)).toEqual([`${base}/v1/models?limit=1`, `${base}/other`])
  })

  test("a proxied entry goes over HTTP even with WebSockets enabled", async () => {
    using server = proxy()
    const base = server.base("documentor-openai")
    const hooks = await CodexAuthPlugin(pluginInput(), {
      providerID: "documentor-openai",
      experimentalWebSockets: true,
    })
    const loaded = await hooks.auth!.loader!(async () => placeholder(base) as never, {} as never)

    const response = await loaded.fetch!("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "session-id": "session-1" },
      body: JSON.stringify({ stream: true, input: "hi" }),
    })

    expect(response.status).toBe(200)
    expect(server.seen.map((item) => item.url)).toEqual([`${base}/codex/responses`])
    await hooks.dispose?.()
  })

  test("chat.headers and chat.params apply to documentor-openai", async () => {
    const hooks = await CodexAuthPlugin(pluginInput(), { providerID: "documentor-openai" })
    const model = { providerID: "documentor-openai" }
    const headers = { headers: {} as Record<string, string> }
    await hooks["chat.headers"]!(
      { sessionID: "ses_1", agent: "build", model } as Parameters<NonNullable<Hooks["chat.headers"]>>[0],
      headers,
    )
    const params = { maxOutputTokens: 1000 } as Parameters<NonNullable<Hooks["chat.params"]>>[1]
    await hooks["chat.params"]!({ model } as Parameters<NonNullable<Hooks["chat.params"]>>[0], params)

    expect(headers.headers.originator).toBe("opencode")
    expect(headers.headers["session-id"]).toBe("ses_1")
    expect(params.maxOutputTokens).toBeUndefined()
  })
})

// The chat process's catalogue carries documentor-openai as a copy of openai
// under the new id, which is what makes the provider present when plugin
// model filters run.
const openai = (catalogue as unknown as Record<string, ModelsDev.Provider>).openai
const documentorCatalogue = {
  ...(catalogue as unknown as Record<string, ModelsDev.Provider>),
  "documentor-openai": {
    ...openai,
    id: "documentor-openai",
    env: [],
    models: { ...openai.models, "gpt-5.5-pro": { ...openai.models["gpt-5.5"], id: "gpt-5.5-pro" } },
  },
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

const withAuth = <A, E, R>(content: Record<string, unknown>, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(content)
    }),
    () => self,
    () => Effect.void,
  )

const instanceConfig = { config: { formatter: false, lsp: false } } as const

describe("plugin.codex proxy mode through the provider service", () => {
  it.live("the provider models() filter runs for documentor-openai", () => {
    const server = proxy()
    return withAuth(
      { "documentor-openai": placeholder(server.base("documentor-openai")) },
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            const info = yield* provider.getProvider(ProviderV2.ID.make("documentor-openai"))
            expect(info.models["gpt-5.5-pro"]).toBeUndefined()
            expect(info.models["gpt-5.2-pro"]).toBeUndefined()
            const model = info.models["gpt-5.5"]
            expect(model).toBeDefined()
            expect(model?.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
            expect(model?.limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
          }),
        instanceConfig,
      ),
    ).pipe(Effect.ensuring(Effect.sync(() => server[Symbol.dispose]())))
  })

  it.live("one plugin per OpenAI-family id: documentor-openai and openai each reach their own baseURL", () => {
    const server = proxy()
    return withAuth(
      {
        openai: placeholder(server.base("openai")),
        "documentor-openai": placeholder(server.base("documentor-openai")),
      },
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const provider = yield* Provider.Service
            for (const id of ["documentor-openai", "openai"]) {
              const info = yield* provider.getProvider(ProviderV2.ID.make(id))
              const send = info.options.fetch as typeof fetch
              expect(send).toBeFunction()
              yield* Effect.promise(() =>
                send("https://api.openai.com/v1/responses", { method: "POST", body: JSON.stringify({ input: "hi" }) }),
              )
            }
            expect(server.seen.map((item) => item.url)).toEqual([
              `${server.base("documentor-openai")}/codex/responses`,
              `${server.base("openai")}/codex/responses`,
            ])
          }),
        instanceConfig,
      ),
    ).pipe(Effect.ensuring(Effect.sync(() => server[Symbol.dispose]())))
  })
})

describe("plugin.codex login methods", () => {
  test("only the openai instance offers interactive login", async () => {
    const openai = await CodexAuthPlugin(pluginInput())
    const proxied = await CodexAuthPlugin(pluginInput(), { providerID: "documentor-openai" })

    expect(openai.auth!.methods.length).toBeGreaterThan(0)
    expect(proxied.auth!.methods).toEqual([])
  })
})
