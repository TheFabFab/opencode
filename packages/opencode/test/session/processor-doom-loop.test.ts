import { describe, expect, test } from "bun:test"
import { sameToolInput } from "../../src/session/processor"

describe("doom loop detection", () => {
  test("recognises a repeated input whose keys come back from the database in another order", () => {
    // jsonb stores object keys sorted by length, then bytes.
    const stored = JSON.parse('{"limit":10,"offset":0,"filePath":"/a/b.ts","nested":{"y":2,"x":1}}')
    const fresh = { filePath: "/a/b.ts", offset: 0, limit: 10, nested: { x: 1, y: 2 } }
    expect(sameToolInput(stored, fresh)).toBe(true)
  })

  test("distinguishes inputs that differ in a value", () => {
    expect(sameToolInput({ filePath: "/a/b.ts", offset: 0 }, { filePath: "/a/b.ts", offset: 1 })).toBe(false)
    expect(sameToolInput({ filePath: "/a/b.ts" }, { filePath: "/a/b.ts", offset: 0 })).toBe(false)
  })
})
