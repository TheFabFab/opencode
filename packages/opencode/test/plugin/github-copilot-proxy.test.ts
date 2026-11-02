import { afterEach, describe, expect, test } from "bun:test"
import { CopilotAuthPlugin } from "@/plugin/github-copilot/copilot"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const ticket = "ticket-sentinel-c0p1"
const base = "http://127.0.0.1:9/provider/github-copilot"
const placeholder = { type: "oauth", access: ticket, refresh: ticket, expires: 0, proxyBaseURL: base }

function record() {
  const seen: { url: string; authorization: string | null; method: string; body: string }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    seen.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      method: request.method,
      body: await request.text(),
    })
    return new Response(JSON.stringify({ data: [] }), { status: 200 })
  }) as typeof fetch
  return seen
}

async function plugin() {
  return CopilotAuthPlugin({
    directory: "",
    project: {} as never,
    worktree: "",
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://localhost"),
    $: {} as never,
    client: {} as never,
  })
}

const model = {
  id: "gpt-4o",
  providerID: "github-copilot",
  api: { id: "gpt-4o", url: "https://api.githubcopilot.com", npm: "@ai-sdk/github-copilot" },
}

describe("plugin.github-copilot proxy mode", () => {
  test("models() asks proxyBaseURL/models, not api.githubcopilot.com", async () => {
    const seen = record()
    const hooks = await plugin()
    await hooks.provider!.models!({ models: {} } as never, { auth: placeholder } as never)

    expect(seen.map((item) => item.url)).toEqual([`${base}/models`])
    expect(seen[0]?.authorization).toBe(`Bearer ${ticket}`)
  })

  test("models() falls back to models that point at proxyBaseURL", async () => {
    globalThis.fetch = (async () => new Response("down", { status: 500 })) as unknown as typeof fetch
    const hooks = await plugin()
    const models = await hooks.provider!.models!(
      { models: { "gpt-4o": model } } as never,
      { auth: placeholder } as never,
    )

    expect(models["gpt-4o"]?.api.url).toBe(base)
  })

  test("the loader's fetch rewrites the host to proxyBaseURL and keeps the path", async () => {
    const seen = record()
    const hooks = await plugin()
    const loaded = await hooks.auth!.loader!(async () => placeholder as never, {} as never)

    await loaded.fetch!("https://api.githubcopilot.com/chat/completions?x=1", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    })
    await loaded.fetch!(`${base}/responses`, { method: "POST", body: "{}" })
    await loaded.fetch!(
      new Request("https://copilot-api.example.ghe.com/v1/messages", { method: "POST", body: '{"messages":[]}' }),
    )

    expect(seen.map((item) => item.url)).toEqual([
      `${base}/chat/completions?x=1`,
      `${base}/responses`,
      `${base}/v1/messages`,
    ])
    expect(seen.map((item) => item.method)).toEqual(["POST", "POST", "POST"])
    expect(seen[2]?.body).toBe('{"messages":[]}')
    expect(seen.every((item) => item.authorization === `Bearer ${ticket}`)).toBe(true)
  })
})
