import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { describeUrlHost, isLoopbackUrl } from '@nexus/db-kit/url-guard'
import { readMigrations } from '../policies'
import { assertTestDatabaseUrl } from '../test-database'
import { MIGRATIONS_DIR } from '../tools'
import { testKitApplicationName, withMigrationLock } from './migration-lock'
import { createFromTemplate, templateSwitch } from './template'

/**
 * Test support (`@nexus/factory-db/testing`): a throwaway database built from the checked-in migrations, one per test
 * file, on the local factory PostgreSQL 17. Nothing here reads a `.env`.
 *
 *   server   FACTORY_PG_TEST_SERVER_URL (shell only), else the local stack at 127.0.0.1:5442; loopback only
 *   name     factory_test_<run>_<label>_<hex>; <run> is FACTORY_PG_TEST_RUN (set by scripts/factory/run-pg-tests.mjs,
 *            which drops whatever a crashed file left behind) or "adhoc"
 *   made     a copy of factory_tpl_<hash> (./template, B-W2b-F27): the migrations are applied once per migration set,
 *            <hash> being the sha256 of every migration folder's name and SQL, to a template nobody connects to (its
 *            catalogs compacted); each test database is `CREATE DATABASE … TEMPLATE` of it, without the lock once it is
 *            built. A new migration set builds a new template (and drops the templates built over 24 hours ago).
 *            FACTORY_PG_TEST_TEMPLATE=off (shell only) migrates every test database from zero instead, as before.
 *
 * The migrations create the factory's roles, which are cluster-wide and shared with every worktree on the server.
 * Migrations are applied under MIGRATION_LOCK (an advisory lock in the server's `postgres` database, taken by
 * `withMigrationLock` in ./migration-lock: per transaction, on a connection of its own, freed by the server when its
 * process stops acting), so two builds never race on them. A test never drops or alters those roles. Every
 * connection opened here is named `factory-test <role> <pid> <database>` in pg_stat_activity.
 */

export const SERVER_URL = process.env.FACTORY_PG_TEST_SERVER_URL ?? 'postgresql://postgres@127.0.0.1:5442/postgres'

/** The advisory-lock key that serialises migrations on one server (also taken by check-migrations-replay.mjs). */
export const MIGRATION_LOCK = '7202610281201'

export interface MigratedDatabase {
  readonly name: string
  /** Connected to the throwaway database as the server's admin login (a superuser: it skips row-level security). */
  readonly admin: pg.Client
  /** The URL of the throwaway database for a login, e.g. `factory_app`. */
  url(user: string): string
  /** Drops the database, forcing out any connection left open. */
  close(): Promise<void>
}

/** The test server's URL, checked: loopback only. */
export function testServerUrl(): URL {
  if (!isLoopbackUrl(SERVER_URL)) {
    throw new Error(`Factory PostgreSQL tests refused to start: ${describeUrlHost(SERVER_URL)} is not a database on this machine (loopback only).`)
  }
  return new URL(SERVER_URL)
}

function runId(): string {
  const run = process.env.FACTORY_PG_TEST_RUN ?? 'adhoc'
  if (!/^[a-z0-9]{1,16}$/.test(run)) throw new Error(`FACTORY_PG_TEST_RUN must be 1-16 lower-case letters or digits, not ${JSON.stringify(run)}.`)
  return run
}

/** Creates `factory_test_<run>_<label>_<hex>`: a copy of the migrated template, or migrated from zero with the switch off. */
export async function migratedDatabase(label: string): Promise<MigratedDatabase> {
  if (!/^[a-z0-9_]{1,20}$/.test(label)) throw new Error(`Bad test database label: ${JSON.stringify(label)}.`)
  const server = testServerUrl()
  const name = `factory_test_${runId()}_${label}_${randomBytes(4).toString('hex')}`
  const at = (user: string): string => {
    const url = new URL(server.href)
    url.username = user
    url.password = ''
    url.pathname = `/${name}`
    return url.href
  }
  // The same guard every factory test run passes: loopback, and a factory_test… name.
  assertTestDatabaseUrl(at('postgres'), [])
  const tag = name.slice('factory_test_'.length)
  const root = new pg.Client({ connectionString: server.href, application_name: testKitApplicationName('root', tag) })
  await root.connect()
  const admin = new pg.Client({
    connectionString: at(decodeURIComponent(server.username) || 'postgres'),
    application_name: testKitApplicationName('admin', tag),
  })
  const drop = async (): Promise<void> => {
    await admin.end().catch(() => {})
    await root.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
  }
  try {
    const migrations = readMigrations(MIGRATIONS_DIR)
    if (templateSwitch()) {
      await createFromTemplate({ root, server, migrations, lockKey: MIGRATION_LOCK, tag }, name)
      await admin.connect()
    } else {
      await root.query(`CREATE DATABASE "${name}"`)
      await admin.connect()
      await withMigrationLock({ url: server.href, key: MIGRATION_LOCK, tag }, async (signal) => {
        for (const migration of migrations) {
          signal.throwIfAborted()
          try {
            await admin.query(migration.sql)
          } catch (error) {
            throw new Error(`Migration ${migration.folder} failed on ${name}: ${(error as Error).message}`)
          }
        }
      })
    }
  } catch (error) {
    await drop().catch(() => {})
    await root.end().catch(() => {})
    throw error
  }
  return {
    name,
    admin,
    url: at,
    async close() {
      try {
        await drop()
      } finally {
        await root.end()
      }
    },
  }
}
