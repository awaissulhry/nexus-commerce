import { workspacePrisma } from '@nexus/database/workspace-router'
import { workspacePolicySql } from '../../../../packages/database/scripts/workspace-policies.mjs'
import { Pool } from 'pg'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { auditRuntimeRole } from '@nexus/database/runtime-role'

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
  const schemaSql = execFileSync(`${root}/node_modules/.bin/prisma`, ['migrate', 'diff', '--config', `${root}/packages/database/prisma.config.ts`, '--from-empty', '--to-schema', `${root}/packages/database/prisma/schema.prisma`, '--script'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })

  const name = `ae_test_${randomBytes(6).toString('hex')}`
  const runtimeLogin = `runtime_${name}`
  const runtimePassword = randomBytes(24).toString('hex')
  const admin = new Pool({ connectionString: server.toString(), max: 1 })
  const target = new URL(server.toString())
  target.pathname = `/${name}`
  const pool = new Pool({ connectionString: target.toString(), max: options.maxConnections ?? 12, connectionTimeoutMillis: 10_000 })
  const runtimeTarget = new URL(target.toString())
  runtimeTarget.username = runtimeLogin
  runtimeTarget.password = runtimePassword
  const runtimePool = new Pool({ connectionString: runtimeTarget.toString(), max: options.maxConnections ?? 12, connectionTimeoutMillis: 10_000 })
  const client = workspacePrisma(runtimePool)
  let databaseCreated = false, roleCreated = false, closing = false
  // Only teardown termination of this disposable database is an expected idle error.
  for (const connectionPool of [pool, runtimePool]) connectionPool.on('error', (error: Error & { code?: string }) => {
    if (closing && error.code === '57P01') return
    throw error
  })
  const close = async () => {
    if (closing) return
    closing = true
    try {
      await client.$disconnect()
      await Promise.all([runtimePool.end(), pool.end()])
      if (databaseCreated) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      if (roleCreated) await admin.query(`DROP ROLE IF EXISTS ${runtimeLogin}`)
    } finally { await admin.end() }
  }
  try {
    await admin.query(`CREATE DATABASE ${name}`)
    databaseCreated = true
    await pool.query(schemaSql)
    // Same deployed-only column formulaDatabase() adds; see the note there.
    await pool.query('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "variationExcluded" boolean NOT NULL DEFAULT false')
    await pool.query(`INSERT INTO "Workspace" (id, name, status, "isLegacy", "createdByUserId", "creationKey", "updatedAt")
      VALUES ('nexus_legacy_workspace', 'Test business', 'active', true, 'test-bootstrap', 'test-bootstrap', CURRENT_TIMESTAMP)`)
    await pool.query(workspacePolicySql())
    // Identifiers and password are generated hexadecimal, never caller input or logged.
    await pool.query(`CREATE ROLE ${runtimeLogin} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${runtimePassword}'`)
    roleCreated = true
    await pool.query(`GRANT nexus_workspace_runtime TO ${runtimeLogin}`)
    // The fixture owner observes/terminates only its own child login's sessions.
    // Membership points owner -> runtime login, never runtime login -> owner.
    await pool.query(`GRANT ${runtimeLogin} TO CURRENT_USER WITH INHERIT TRUE`)
    const probe = await runtimePool.connect()
    try { await auditRuntimeRole(probe) } finally { probe.release() }
    const identity = await client.$queryRaw<Array<{ login: string; role: string }>>`SELECT session_user::text AS login, current_user::text AS role`
    if (identity[0]?.login !== runtimeLogin || identity[0]?.role !== 'nexus_workspace_runtime') {
      throw new Error('Concurrent fixture application client is not using the restricted login and runtime role')
    }
    return { client, pool, name, close }
  } catch (error) {
    try { await close() } catch (cleanupError) { throw Object.assign(new Error('Disposable database setup and cleanup failed'), { errors: [error, cleanupError] }) }
    throw error
  }
}
