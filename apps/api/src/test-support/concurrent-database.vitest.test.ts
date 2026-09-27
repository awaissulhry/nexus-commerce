/**
 * Teardown of the disposable database (concurrent-database.ts).
 *
 * An autovacuum worker in the database makes `DROP … WITH (FORCE)` fail with 42501 for the NOSUPERUSER owner, and
 * it can leave (or be exiting, not listed in pg_stat_activity) before teardown looks. That must be retried: it
 * failed the CI PostgreSQL job after suites whose tests had all passed. A connection teardown can SEE and may not
 * terminate is a real leak: it must still fail, at once, and be named.
 *
 * The leak arm needs NEXUS_TEST_CONCURRENT_PG_URL; run by scripts/run-real-postgres-tests.mjs.
 */
import { describe, expect, it, vi } from 'vitest'
import { Client, Pool } from 'pg'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl, dropFailureVerdict, type TeardownBackend } from './concurrent-database.js'

const server = concurrentDatabaseUrl()
const backend = (usename: string | null, terminable: boolean): TeardownBackend =>
  ({ pid: 1, usename, terminable, backend_type: null, application_name: null, state: null })

describe('a failed DROP of the disposable database', () => {
  it('is retried while nothing visible is a connection the owner may not terminate', () => {
    // The CI failure: the autovacuum worker had gone, or was exiting, when teardown looked.
    expect(dropFailureVerdict('42501', [])).toBe('retry')
    // An autovacuum worker still inside: no role, so usename is NULL to the owner.
    expect(dropFailureVerdict('42501', [backend(null, false)])).toBe('retry')
    // The same worker next to the fixture's own backends, still exiting after the pools ended.
    expect(dropFailureVerdict('42501', [backend(null, false), backend('runtime_ae_test_0', true), backend('nexus_owner', true)])).toBe('retry')
  })

  it('fails at once on a visible connection it may not terminate, on a look that failed, and on any other error', () => {
    expect(dropFailureVerdict('42501', [backend(null, false), backend('someone_else', false)])).toBe('fail')
    expect(dropFailureVerdict('42501', null)).toBe('fail')
    expect(dropFailureVerdict('55006', [])).toBe('fail')
    expect(dropFailureVerdict(undefined, [])).toBe('fail')
  })
})

describe.skipIf(!server)(`disposable database teardown on a real server (needs ${CONCURRENT_PG_ENV})`, () => {
  it('a leaked connection of a role the owner may not terminate fails teardown at once, names it, and survives', async () => {
    const database = await concurrentDatabase({ maxConnections: 2 })
    const admin = new Pool({ connectionString: server!.toString(), max: 1 })
    const intruder = `intruder_${database.name}`
    let leaked: Client | null = null
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      // Preconditions: the production-equivalent owner (a superuser could terminate anything, so nothing would
      // be a leak), and a login whose privileges it does not have. CREATEROLE grants ADMIN on the new role, not
      // its privileges.
      const [owner] = (await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows
      expect(owner.rolsuper, 'run as the NOSUPERUSER owner (run-real-postgres-tests.mjs --owner production)').toBe(false)
      await admin.query(`CREATE ROLE ${intruder} LOGIN`)
      expect((await admin.query(`SELECT pg_has_role(current_user, $1, 'USAGE') AS has`, [intruder])).rows[0].has).toBe(false)
      const target = new URL(server!.toString())
      target.pathname = `/${database.name}`
      target.username = intruder
      leaked = new Client({ connectionString: target.toString() })
      leaked.on('error', () => undefined)
      await leaked.connect()

      const started = Date.now()
      const failure = await database.close().then(() => null, (error: { code?: string }) => error)
      expect(failure?.code).toBe('42501')
      // At once: not after the retry deadline an autovacuum worker gets.
      expect(Date.now() - started).toBeLessThan(5_000)
      const line = errors.mock.calls.map(call => String(call[0])).find(text => text.startsWith('[real-pg] disposable database cleanup failed '))
      expect(line, 'the failure is logged on one line the runner prints').toBeDefined()
      const logged = JSON.parse(line!.slice('[real-pg] disposable database cleanup failed '.length))
      expect(logged).toMatchObject({ database: database.name, code: '42501', attempts: 1 })
      expect(logged.backends).toEqual(expect.arrayContaining([expect.objectContaining({ usename: intruder, terminable: false })]))
      // FORCE terminated nothing: the leaked session and the database are both still there.
      expect((await leaked.query('SELECT current_database() AS db')).rows[0].db).toBe(database.name)
    } finally {
      errors.mockRestore()
      await leaked?.end().catch(() => undefined)
      // The intruder's backend exits asynchronously after end(); until then the owner may not terminate it.
      for (let attempt = 0; ; attempt++) {
        try { await admin.query(`DROP DATABASE IF EXISTS ${database.name} WITH (FORCE)`); break } catch (error) {
          if (attempt >= 40) throw error
          await new Promise(resolve => setTimeout(resolve, 250))
        }
      }
      await admin.query(`DROP ROLE IF EXISTS runtime_${database.name}`)
      await admin.query(`DROP ROLE IF EXISTS ${intruder}`)
      await admin.end()
    }
  }, 120_000)
})
