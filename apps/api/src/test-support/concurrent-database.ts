import { workspacePrisma } from '@nexus/database/workspace-router'
import { workspacePolicySql } from '../../../../packages/database/scripts/workspace-policies.mjs'
import { Pool } from 'pg'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/**
 * AE.1 — a disposable MULTI-CONNECTION PostgreSQL for concurrency tests.
 *
 * `formulaDatabase()` runs PGlite behind one socket connection, so every transaction is
 * serialised before it reaches the database. A race cannot happen there, and a race test
 * run on it passes whether or not the code is safe. This helper exists so the arm that
 * would fail is the arm that runs.
 *
 * It never touches an existing database. It connects to the server named by
 * `NEXUS_TEST_CONCURRENT_PG_URL`, creates a new database with a random name, applies the
 * schema and the generated production policies, and drops that database on close.
 * The server must be on this machine (127.0.0.1 / localhost / ::1).
 */
export const CONCURRENT_PG_ENV = 'NEXUS_TEST_CONCURRENT_PG_URL'

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Null when the variable is unset. Throws when it is set to anything that is not a local server. */
export function concurrentDatabaseUrl(): URL | null {
  const raw = process.env[CONCURRENT_PG_ENV]?.trim()
  if (!raw) return null
  const url = new URL(raw)
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`${CONCURRENT_PG_ENV} must point at a PostgreSQL server on this machine; got host "${url.hostname}".`)
  }
  return url
}

export async function concurrentDatabase(options: { maxConnections?: number } = {}) {
  const server = concurrentDatabaseUrl()
  if (!server) throw new Error(`${CONCURRENT_PG_ENV} is not set.`)
  const root = fileURLToPath(new URL('../../../../', import.meta.url))
  const schemaSql = execFileSync(`${root}/node_modules/.bin/prisma`, ['migrate', 'diff', '--from-empty', '--to-schema-datamodel', `${root}/packages/database/prisma/schema.prisma`, '--script'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })

  const name = `ae_test_${randomBytes(6).toString('hex')}`
  const admin = new Pool({ connectionString: server.toString(), max: 1 })
  await admin.query(`CREATE DATABASE ${name}`)

  const target = new URL(server.toString())
  target.pathname = `/${name}`
  const setup = new Pool({ connectionString: target.toString(), max: 1 })
  try {
    await setup.query(schemaSql)
    // Same deployed-only column formulaDatabase() adds; see the note there.
    await setup.query('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "variationExcluded" boolean NOT NULL DEFAULT false')
    await setup.query(`INSERT INTO "Workspace" (id, name, status, "isLegacy", "createdByUserId", "creationKey", "updatedAt")
      VALUES ('nexus_legacy_workspace', 'Test business', 'active', true, 'test-bootstrap', 'test-bootstrap', CURRENT_TIMESTAMP)`)
    await setup.query(workspacePolicySql())
  } finally {
    await setup.end()
  }

  const pool = new Pool({ connectionString: target.toString(), max: options.maxConnections ?? 12, connectionTimeoutMillis: 10_000 })
  // Post-commit work under test is fire-and-forget (read-cache refresh, stockout hook), so a
  // connection can still be open when the suite ends. Dropping the database terminates it
  // (57P01); that one error, during close only, is the teardown and not a finding.
  let closing = false
  pool.on('error', (error: Error & { code?: string }) => {
    if (closing && error.code === '57P01') return
    throw error
  })
  const client = workspacePrisma(pool)
  return {
    client,
    /** Superuser access to the disposable database, for seeding and read-backs only. */
    pool,
    name,
    async close() {
      closing = true
      await client.$disconnect()
      await pool.end()
      try {
        for (let attempt = 0; ; attempt++) {
          try { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); break } catch (error) {
            const remaining = await admin.query('SELECT pid,usename,backend_type,application_name,state FROM pg_stat_activity WHERE datname=$1', [name]).catch(() => null)
            const failure = error as { code?: string; detail?: string }
            // An autovacuum worker runs with no role (usename NULL to us), so a NOSUPERUSER
            // owner may not terminate it (42501); it finishes on its own. Wait briefly for
            // that case only: any backend with a visible user is a real leaked connection.
            if (failure.code === '42501' && attempt < 40 && remaining?.rows.length && remaining.rows.every(row => row.usename === null)) {
              await new Promise(resolve => setTimeout(resolve, 250)); continue
            }
            console.error('[real-pg] disposable database cleanup failed', { code: failure.code, detail: failure.detail, attempts: attempt + 1, backends: remaining?.rows ?? 'unavailable' })
            throw error
          }
        }
      } finally { await admin.end() }
    },
  }
}
