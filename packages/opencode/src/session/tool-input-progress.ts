/** How long a tool's streaming arguments are held back between two progress deltas. */
export const TOOL_INPUT_PROGRESS_MS = 5_000

/** The argument text of one tool call that has streamed in but not yet been published. */
export type ToolInputProgress = {
  inputText?: string
  /** When the last progress delta was published, in epoch ms. */
  inputSentAt?: number
}

/**
 * Takes the held argument text when it is due: the first piece at once, then
 * at most one batch per {@link TOOL_INPUT_PROGRESS_MS}, and whatever is left
 * when `force` marks the end of the input. Returns undefined while it holds.
 */
export function takeToolInput(progress: ToolInputProgress, now: number, force: boolean): string | undefined {
  if (!progress.inputText) return undefined
  if (!force && progress.inputSentAt !== undefined && now - progress.inputSentAt < TOOL_INPUT_PROGRESS_MS) {
    return undefined
  }
  const text = progress.inputText
  progress.inputText = ""
  progress.inputSentAt = now
  return text
}
