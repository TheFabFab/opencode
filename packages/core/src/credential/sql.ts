import { pgTable, text, jsonb, boolean } from "drizzle-orm/pg-core"
import { Timestamps } from "../database/schema.sql"
import type { Credential } from "../credential"

export const CredentialTable = pgTable("credential", {
  id: text().$type<Credential.ID>().primaryKey(),
  integration_id: text().$type<Credential.Info["integrationID"]>(),
  label: text().notNull(),
  value: jsonb().$type<Credential.Value>().notNull(),
  connector_id: text(),
  method_id: text(),
  active: boolean(),
  ...Timestamps,
})
