import { afterEach, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Auth.node))

const file = path.join(Global.Path.data, "auth.json")
const ticket = "ticket-sentinel-3f9a"
const proxied = {
  "documentor-openai": {
    type: "oauth",
    access: ticket,
    refresh: ticket,
    expires: 4102444800000,
    proxyBaseURL: "http://127.0.0.1:9/provider/documentor-openai",
  },
}

const previous = process.env.OPENCODE_AUTH_CONTENT

beforeEach(async () => {
  await fs.rm(file, { force: true })
})

afterEach(async () => {
  if (previous === undefined) delete process.env.OPENCODE_AUTH_CONTENT
  else process.env.OPENCODE_AUTH_CONTENT = previous
  await fs.rm(file, { force: true })
})

const exists = () => Effect.promise(() => Bun.file(file).exists())

describe("Auth with proxied entries", () => {
  it.instance("set is a no-op for a key whose entry is proxied", () =>
    Effect.gen(function* () {
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(proxied)
      const auth = yield* Auth.Service
      yield* auth.set("documentor-openai", {
        type: "oauth",
        access: "refreshed",
        refresh: "refreshed",
        expires: Date.now() + 3_600_000,
      })
      expect(yield* exists()).toBe(false)
    }),
  )

  it.instance("set is a no-op for a trailing-slash key whose entry is proxied", () =>
    Effect.gen(function* () {
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(proxied)
      const auth = yield* Auth.Service
      yield* auth.set("documentor-openai/", { type: "api", key: "sk-other" })
      expect(yield* exists()).toBe(false)
    }),
  )

  it.instance("remove is a no-op for a proxied key", () =>
    Effect.gen(function* () {
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(proxied)
      const auth = yield* Auth.Service
      yield* auth.remove("documentor-openai")
      expect(yield* exists()).toBe(false)
    }),
  )

  it.instance("set never writes a proxied entry it is given", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("documentor-openai", { ...proxied["documentor-openai"], type: "oauth" })
      expect(yield* exists()).toBe(false)
    }),
  )

  it.instance("an unproxied write never carries a proxied entry to disk", () =>
    Effect.gen(function* () {
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify(proxied)
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", { type: "api", key: "sk-test" })
      const written = yield* Effect.promise(() => Bun.file(file).text())
      expect(written).not.toContain(ticket)
      expect(JSON.parse(written)).toEqual({ anthropic: { type: "api", key: "sk-test" } })
    }),
  )

  it.instance("an unproxied remove never carries a proxied entry to disk", () =>
    Effect.gen(function* () {
      process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ ...proxied, anthropic: { type: "api", key: "sk-test" } })
      const auth = yield* Auth.Service
      yield* auth.remove("anthropic")
      const written = yield* Effect.promise(() => Bun.file(file).text())
      expect(written).not.toContain(ticket)
    }),
  )

  it.instance("set still writes for an unproxied key", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("openai", { type: "api", key: "sk-test" })
      expect(yield* exists()).toBe(true)
      expect((yield* auth.get("openai"))?.type).toBe("api")
    }),
  )
})
