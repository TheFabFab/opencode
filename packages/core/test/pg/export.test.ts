import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { captureSql } from "../../../../documentor/scripts/export-schema"

describe("schema export", () => {
  test("writes the baseline, its ids and the ported migrations as files", async () => {
    const out = mkdtempSync(path.join(tmpdir(), "schema-export-"))
    execFileSync("bash", [path.resolve(import.meta.dir, "../../../../documentor/scripts/export-schema.sh"), out])
    const baseline = readFileSync(path.join(out, "baseline.sql"), "utf8")
    expect(baseline).toContain('CREATE TABLE "session"')
    expect(baseline.trim().endsWith(";")).toBe(true)
    expect(JSON.parse(readFileSync(path.join(out, "baseline-ids.json"), "utf8"))).toEqual([...DatabaseMigration.BASELINE_IDS].sort())
    const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"))
    expect(manifest.migrationIds).toEqual([...DatabaseMigration.registry.ids].sort())
    expect(readdirSync(path.join(out, "ported")).sort()).toEqual(Object.keys(DatabaseMigration.ported).sort().map((id) => `${id}.sql`))
    for (const [id, up] of Object.entries(DatabaseMigration.ported))
      expect(readFileSync(path.join(out, "ported", `${id}.sql`), "utf8")).toBe(await captureSql(up))
  })
})

describe("captureSql", () => {
  test("returns the statements an up function runs, each terminated by a semicolon", async () => {
    const up = (tx: any) =>
      Effect.gen(function* () {
        yield* tx.run("CREATE TABLE a (id text)")
        yield* tx.run("CREATE INDEX a_id ON a (id);")
      })
    expect(await captureSql(up)).toBe("CREATE TABLE a (id text);\nCREATE INDEX a_id ON a (id);\n")
  })

  test("refuses an up function that reads a result back", async () => {
    const up = (tx: any) =>
      Effect.gen(function* () {
        yield* tx.all("SELECT 1")
      })
    await expect(captureSql(up)).rejects.toThrow("tx.all")
  })
})
