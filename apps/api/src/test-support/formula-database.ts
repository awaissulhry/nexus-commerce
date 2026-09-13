import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { workspacePrisma } from '@nexus/database/workspace-router'
import { workspacePolicySql } from '../../../../packages/database/scripts/workspace-policies.mjs'
import { Pool } from 'pg'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Disposable real PostgreSQL + the generated production Prisma client. No catalog connection. */
export async function formulaDatabase(options: { maxConnections?: number; port?: number } = {}) {
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const sql = execFileSync(`${root}/node_modules/.bin/prisma`, ['migrate', 'diff', '--from-empty', '--to-schema-datamodel', `${root}/packages/database/prisma/schema.prisma`, '--script'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  const db = await PGlite.create()
  await db.exec(sql)
  // LX.F P3-22 — the deployed databases carry columns `schema.prisma` does not.
  // `ChannelListing.variationExcluded` is DELIBERATELY absent from the schema
  // (`family-projection.service.ts:385-398`: "a database ahead of the schema is
  // inert; a schema ahead of a database is an outage") and is read/written there
  // through narrow raw SQL. Without it this disposable database is BEHIND every
  // deployed one, and 12 LX integration assertions could not execute at all —
  // the arm that would have failed was the one never run. Keep this tied to that
  // service: if it stops using the column, delete this line with it.
  await db.exec('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "variationExcluded" boolean NOT NULL DEFAULT false')
  await db.exec(`INSERT INTO "Workspace" (id, name, status, "isLegacy", "createdByUserId", "creationKey", "updatedAt")
    VALUES ('nexus_legacy_workspace', 'Test business', 'active', true, 'test-bootstrap', 'test-bootstrap', CURRENT_TIMESTAMP)`)
  await db.exec(workspacePolicySql())
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: options.port ?? 0, maxConnections: options.maxConnections ?? 1 })
  let port = 0
  server.addEventListener('listening', (event: any) => { port = event.detail.port })
  await Promise.race([server.start(), new Promise<never>((_, reject) => server.addEventListener('error', (event: any) => reject(event.detail)))])
  const pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'template1', max: 1, connectionTimeoutMillis: 5_000 })
  const client = workspacePrisma(pool)
  return { client, db, connectionString: `postgresql://postgres@127.0.0.1:${port}/template1`, async close() { await client.$disconnect(); await pool.end(); await server.stop(); await db.close() } }
}
