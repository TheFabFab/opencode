export * as DatabaseTarget from "./target"

export class InvalidTargetError extends Error {
  override readonly name = "DatabaseInvalidTargetError"
}

export interface Target {
  /** Connection URL, with the schema folded in as the search path. Holds the password. */
  readonly url: string
  readonly schema: string | undefined
  /** The schema is created for this layer and dropped when it closes. Tests only. */
  readonly ephemeral: boolean
  readonly maxConnections: number
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/

/** Reads where this process connects. Throws `InvalidTargetError` naming the setting at fault. */
export function read(env: Record<string, string | undefined> = process.env): Target {
  const address = env.OPENCODE_DATABASE_URL
  if (!address) throw new InvalidTargetError("OPENCODE_DATABASE_URL is not set")
  const url = (() => {
    try {
      return new URL(address)
    } catch {
      throw new InvalidTargetError("OPENCODE_DATABASE_URL is not a valid URL")
    }
  })()
  if (!LOOPBACK.has(url.hostname) && url.searchParams.get("sslmode") !== "verify-full")
    throw new InvalidTargetError(
      `OPENCODE_DATABASE_URL names the remote host ${url.hostname} without sslmode=verify-full`,
    )

  const ephemeral = env.OPENCODE_DATABASE_EPHEMERAL === "1"
  const schema = ephemeral ? `t_${crypto.randomUUID().replaceAll("-", "")}` : env.OPENCODE_DATABASE_SCHEMA || undefined
  if (schema !== undefined && !IDENTIFIER.test(schema))
    throw new InvalidTargetError(
      "OPENCODE_DATABASE_SCHEMA must be 1 to 63 characters of a-z, 0-9 and _, not starting with a digit",
    )
  if (schema) url.searchParams.set("options", `-c search_path=${schema}`)

  const pool = env.OPENCODE_DATABASE_POOL_MAX
  const maxConnections = pool === undefined || pool === "" ? 4 : Number(pool)
  if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 100)
    throw new InvalidTargetError("OPENCODE_DATABASE_POOL_MAX must be a whole number from 1 to 100")

  return { url: url.toString(), schema, ephemeral, maxConnections }
}
