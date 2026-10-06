import { disposeAllInstances } from "./fixture"

/** Every database layer a test builds has a schema of its own, so disposing the instances is the whole reset. */
export async function resetDatabase() {
  await disposeAllInstances().catch(() => undefined)
}
