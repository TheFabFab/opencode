import { describe, expect, it } from "bun:test"
import { TOOL_INPUT_PROGRESS_MS, takeToolInput, type ToolInputProgress } from "../../src/session/tool-input-progress"

describe("documentor: tool input progress", () => {
  it("publishes the first piece at once, then one batch per interval, then the rest at the end", () => {
    const progress: ToolInputProgress = {}
    const published: Array<string | undefined> = []
    const feed = (text: string, now: number, force = false) => {
      progress.inputText = (progress.inputText ?? "") + text
      published.push(takeToolInput(progress, now, force))
    }

    feed('{"patch', 1_000)
    feed("Text", 2_000)
    feed('":"a', 1_000 + TOOL_INPUT_PROGRESS_MS - 1)
    feed("b", 1_000 + TOOL_INPUT_PROGRESS_MS)
    feed("c", 1_000 + TOOL_INPUT_PROGRESS_MS + 1)
    published.push(takeToolInput(progress, 1_000 + TOOL_INPUT_PROGRESS_MS + 2, true))

    expect(published).toEqual(['{"patch', undefined, undefined, 'Text":"ab', undefined, "c"])
  })

  it("publishes nothing at the end when every piece already went out", () => {
    const progress: ToolInputProgress = { inputText: "{}" }
    expect(takeToolInput(progress, 0, false)).toBe("{}")
    expect(takeToolInput(progress, 1, true)).toBeUndefined()
  })
})
