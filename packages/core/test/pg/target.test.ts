import { describe, expect, test } from "bun:test"
import { DatabaseTarget } from "@opencode-ai/core/database/target"

const read = (env: Record<string, string | undefined>) => DatabaseTarget.read(env)

describe("database target", () => {
  test("requires a URL", () => {
    expect(() => read({})).toThrow("OPENCODE_DATABASE_URL")
  })

  test("accepts a loopback host without TLS", () => {
    for (const host of ["127.0.0.1", "localhost", "[::1]"])
      expect(read({ OPENCODE_DATABASE_URL: `postgresql://u@${host}:5432/db` }).maxConnections).toBe(4)
  })

  test("refuses a remote host without verified TLS", () => {
    for (const suffix of ["", "?sslmode=require", "?sslmode=prefer", "?sslmode=verify-ca", "?sslmode=disable"])
      expect(() => read({ OPENCODE_DATABASE_URL: `postgresql://u@db.internal:5432/db${suffix}` })).toThrow(
        "sslmode=verify-full",
      )
  })

  test("accepts a remote host with sslmode=verify-full", () => {
    expect(
      read({ OPENCODE_DATABASE_URL: "postgresql://u@db.internal:5432/db?sslmode=verify-full" }).url,
    ).toContain("sslmode=verify-full")
  })

  test("sends the schema as the search path", () => {
    const target = read({ OPENCODE_DATABASE_URL: "postgresql://u@127.0.0.1/db", OPENCODE_DATABASE_SCHEMA: "scope_a" })
    expect(target.schema).toBe("scope_a")
    expect(new URL(target.url).searchParams.get("options")).toBe("-c search_path=scope_a")
  })

  test("refuses a schema name that is not a plain identifier", () => {
    for (const schema of ["a b", 'a"b', "a;drop", "A", "1a", "a".repeat(64), "public,other"])
      expect(() =>
        read({ OPENCODE_DATABASE_URL: "postgresql://u@127.0.0.1/db", OPENCODE_DATABASE_SCHEMA: schema }),
      ).toThrow("OPENCODE_DATABASE_SCHEMA")
  })

  test("an ephemeral target gets a fresh schema each time and ignores the configured one", () => {
    const env = {
      OPENCODE_DATABASE_URL: "postgresql://u@127.0.0.1/db",
      OPENCODE_DATABASE_EPHEMERAL: "1",
      OPENCODE_DATABASE_SCHEMA: "scope_a",
    }
    const first = read(env)
    expect(first.ephemeral).toBe(true)
    expect(first.schema).toMatch(/^t_[0-9a-f]{32}$/)
    expect(read(env).schema).not.toBe(first.schema)
  })

  test("reads the pool size and refuses a bad one", () => {
    const url = "postgresql://u@127.0.0.1/db"
    expect(read({ OPENCODE_DATABASE_URL: url, OPENCODE_DATABASE_POOL_MAX: "2" }).maxConnections).toBe(2)
    for (const bad of ["0", "-1", "1.5", "many", "101"])
      expect(() => read({ OPENCODE_DATABASE_URL: url, OPENCODE_DATABASE_POOL_MAX: bad })).toThrow(
        "OPENCODE_DATABASE_POOL_MAX",
      )
  })

  test("never puts the password in an error", () => {
    try {
      read({ OPENCODE_DATABASE_URL: "postgresql://u:hunter2@db.internal/db" })
      throw new Error("expected a refusal")
    } catch (error) {
      expect(String(error)).not.toContain("hunter2")
    }
  })
})
