import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"

describe("schema export", () => {
  test("writes the baseline, its ids and the ported migrations as files", () => {
    const out = mkdtempSync(path.join(tmpdir(), "schema-export-"))
    execFileSync("bash", [path.resolve(import.meta.dir, "../../../../documentor/scripts/export-schema.sh"), out])
    const baseline = readFileSync(path.join(out, "baseline.sql"), "utf8")
    expect(baseline).toContain('CREATE TABLE "session"')
    expect(baseline.trim().endsWith(";")).toBe(true)
    expect(JSON.parse(readFileSync(path.join(out, "baseline-ids.json"), "utf8"))).toEqual([...DatabaseMigration.BASELINE_IDS].sort())
    const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"))
    expect(manifest.migrationIds).toEqual([...DatabaseMigration.registry.ids].sort())
    expect(readdirSync(path.join(out, "ported")).sort()).toEqual(Object.keys(DatabaseMigration.ported).sort().map((id) => `${id}.sql`))
  })
})
