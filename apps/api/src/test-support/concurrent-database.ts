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

/** A backend still in the disposable database when its DROP failed, as the owner sees it. */
export type TeardownBackend = {
  pid: number
  usename: string | null
  backend_type: string | null
  application_name: string | null
  state: string | null
  /** The owner has this backend's role's privileges, so DROP … WITH (FORCE) may terminate it. */
  terminable: boolean
}

/**
 * Whether a failed DROP of the disposable database is worth another attempt.
 *
 * DROP … WITH (FORCE) checks every backend in the database before it signals any, and the NOSUPERUSER owner
 * may terminate only roles whose privileges it has: itself and the runtime login granted to it. An autovacuum
 * worker has no role (usename NULL to us), so while one is inside, the DROP fails with 42501 and terminates
 * nothing. The worker leaves on its own, and by the time teardown looks it may already have gone, or be
 * starting or exiting (in the process array but not in pg_stat_activity). So a 42501 is retried unless its
 * cause is VISIBLE: a backend with a user whose privileges the owner lacks is a real leaked connection and
 * fails at once. The fixture's own backends, still exiting after the pools end, are terminable: not the cause.
 */
export function dropFailureVerdict(code: string | undefined, backends: TeardownBackend[] | null): 'retry' | 'fail' {
  if (code !== '42501' || backends === null) return 'fail'
  return backends.some(backend => backend.usename !== null && !backend.terminable) ? 'fail' : 'retry'
}

// The old bound was 40 × 250 ms. Past the deadline a still-blocked DROP fails and names what it saw.
const DROP_RETRY_DEADLINE_MS = 10_000
const DROP_RETRY_INTERVAL_MS = 250
const BACKENDS_SQL = `SELECT a.pid, a.usename, a.backend_type, a.application_name, a.state,
    COALESCE((SELECT pg_has_role(current_user, r.oid, 'USAGE') FROM pg_roles r WHERE r.oid = a.usesysid), false) AS terminable
  FROM pg_stat_activity a WHERE a.datname = $1`

async function dropDisposableDatabase(admin: Pool, name: string) {
  // One session for the DROP and the look: pg-pool discards a client whose query failed, and opening a new
  // connection between the two gives a blocking autovacuum worker time to leave unseen.
  const session = await admin.connect()
  try {
    const deadline = Date.now() + DROP_RETRY_DEADLINE_MS
    for (let attempt = 1; ; attempt++) {
      try { await session.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); return } catch (error) {
        const failure = error as { code?: string; detail?: string }
        const backends = await session.query<TeardownBackend>(BACKENDS_SQL, [name]).then(result => result.rows, () => null)
        if (dropFailureVerdict(failure.code, backends) === 'retry' && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, DROP_RETRY_INTERVAL_MS)); continue
        }
        // One line, so scripts/run-real-postgres-tests.mjs can print it in CI.
        console.error(`[real-pg] disposable database cleanup failed ${JSON.stringify({ database: name, code: failure.code, detail: failure.detail, attempts: attempt, backends: backends ?? 'unavailable' })}`)
        throw error
      }
    }
  } finally { session.release() }
}

/**
 * `timeZone` is set on the database right after CREATE DATABASE, before any session opens, so every
 * session of both pools inherits it (the pools stay open from setup to close).
 */
/**
 * Force a race on `ChannelListing` inserts: hold a SHARE lock (reads pass, inserts wait), start every call, wait until
 * PostgreSQL shows each of them blocked on a lock, then release the lock and return what each call did. Without the
 * wait the "race" may run one call after the other, so a call count that never blocks is an error (the positive
 * control).
 *
 * The lock is ALWAYS released before anything else, a failed check included. A SHARE lock left open on a pooled
 * connection blocks every caller for good, and `close()` then waits on those callers before it ends the pool that
 * holds the lock — so the whole real-PostgreSQL run stopped at its 10-minute limit with no report (CI, 2026-09-27).
 */
export async function raceChannelListingInserts<T>(
  db: { pool: Pool; name: string },
  calls: Array<() => Promise<T>>,
  options: { waitMs?: number } = {},
): Promise<Array<{ value: T } | { error: unknown }>> {
  const locker = await db.pool.connect()
  let running: Array<Promise<{ value: T } | { error: unknown }>> = []
  let released = false
  try {
    await locker.query('BEGIN')
    await locker.query('LOCK TABLE "ChannelListing" IN SHARE MODE')
    running = calls.map(call => call().then(value => ({ value }), error => ({ error })))
    let waiting = 0
    const deadline = Date.now() + (options.waitMs ?? 40_000)
    while (waiting < calls.length && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
      const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [db.name])
      waiting = rows[0].n
    }
    const forced = waiting === calls.length
    await locker.query(forced ? 'COMMIT' : 'ROLLBACK')
    released = true
    const settled = await Promise.all(running)
    if (!forced) throw new Error(`The race was not forced: ${waiting} of ${calls.length} calls were blocked on their insert before the lock was released.`)
    return settled
  } finally {
    if (!released) {
      await locker.query('ROLLBACK').catch(() => undefined)
      await Promise.all(running)
    }
    locker.release()
  }
}

export async function concurrentDatabase(options: { maxConnections?: number; timeZone?: string } = {}) {
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
      if (databaseCreated) await dropDisposableDatabase(admin, name)
      if (roleCreated) await admin.query(`DROP ROLE IF EXISTS ${runtimeLogin}`)
    } finally { await admin.end() }
  }
  try {
    await admin.query(`CREATE DATABASE ${name}`)
    databaseCreated = true
    if (options.timeZone !== undefined) {
      if (!/^[A-Za-z0-9_/+-]+$/.test(options.timeZone)) throw new Error('concurrentDatabase: timeZone must be an IANA zone name')
      await admin.query(`ALTER DATABASE ${name} SET timezone TO '${options.timeZone}'`)
    }
    await pool.query(schemaSql)
    // Same deployed-only column formulaDatabase() adds; see the note there.
    await pool.query('ALTER TABLE "ChannelListing" ADD COLUMN IF NOT EXISTS "variationExcluded" boolean NOT NULL DEFAULT false')
    await pool.query(`INSERT INTO "Workspace" (id, name, status, "isLegacy", "createdByUserId", "creationKey", "updatedAt")
      VALUES ('nexus_legacy_workspace', 'Test business', 'active', true, 'test-bootstrap', 'test-bootstrap', CURRENT_TIMESTAMP)`)
    await pool.query(workspacePolicySql())
    // Identifiers and password are generated hexadecimal, never caller input or logged.
    await pool.query(`CREATE ROLE ${runtimeLogin} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${runtimePassword}'`)
    roleCreated = true
    // The production grant (tasks/architecture-operations.md): inherited, because
    // connections that never SET ROLE (the web's session reader) need table access.
    await pool.query(`GRANT nexus_workspace_runtime TO ${runtimeLogin} WITH INHERIT TRUE, SET TRUE`)
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
