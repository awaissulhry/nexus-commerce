import type { PGlite } from '@electric-sql/pglite'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { workspacePolicySql } from '../../../../packages/database/scripts/workspace-policies.mjs'

/** Set by src/test-support/pglite-snapshot.global.ts for the whole vitest run. */
export const PGLITE_SNAPSHOT_ENV = 'NEXUS_PGLITE_SNAPSHOT'

/**
 * The statements every `formulaDatabase()` starts from, in order. One list, used both to build a
 * database per test file and to build the run's snapshot (pglite-snapshot.global.ts), so the two can
 * never disagree about what a fresh test database contains.
 */
export function formulaSchemaStatements(): string[] {
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const sql = execFileSync(`${root}/node_modules/.bin/prisma`, ['migrate', 'diff', '--from-empty', '--to-schema-datamodel', `${root}/packages/database/prisma/schema.prisma`, '--script'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return [
    sql,
    // LX.F P3-22 — the deployed databases carry columns `schema.prisma` does not.
    // `ChannelListing.variationExcluded` is DELIBERATELY absent from the schema
    // (`family-projection.service.ts:385-398`: "a database ahead of the schema is
    // inert; a schema ahead of a database is an outage") and is read/written there
    // through narrow raw SQL. Without it this disposable database is BEHIND every
    // deployed one, and 12 LX integration assertions could not execute at all —
    // the arm that would have failed was the one never run. Keep this tied to that
    // service: if it stops using the column, delete this line with it.
    'ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "variationExcluded" boolean NOT NULL DEFAULT false',
    `INSERT INTO "Workspace" (id, name, status, "isLegacy", "createdByUserId", "creationKey", "updatedAt")
    VALUES ('nexus_legacy_workspace', 'Test business', 'active', true, 'test-bootstrap', 'test-bootstrap', CURRENT_TIMESTAMP)`,
    workspacePolicySql(),
  ]
}

export async function applyFormulaSchema(db: PGlite, statements = formulaSchemaStatements()) {
  for (const statement of statements) await db.exec(statement)
}
