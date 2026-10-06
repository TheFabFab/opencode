import path from "path"

process.env.OPENCODE_DATABASE_URL =
  process.env.OPENCODE_TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5432/postgres"
process.env.OPENCODE_DATABASE_EPHEMERAL = "1"
delete process.env.OPENCODE_DATABASE_SCHEMA
process.env.NPM_CONFIG_AUDIT = "false"
process.env.OPENCODE_MODELS_PATH = path.join(import.meta.dir, "plugin", "fixtures", "models-dev.json")
process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"
