import { createHash, randomBytes } from 'node:crypto'
import pg from 'pg'
import type { Migration } from '../policies'
import { testKitApplicationName, withMigrationLock } from './migration-lock'

/**
 * The migrated template of the test databases (B-W2b-F27). Applying every migration to every test file's database, one
 * file at a time under MIGRATION_LOCK, kept files waiting so long that their set-up timed out. Now the migrations are
 * applied once per migration set, to a template database, and each test file's database is a copy of it.
 *
 *   name     factory_tpl_<hash>: <hash> is the first 16 hex of the sha256 of every migration folder's name and SQL, in
 *            order (after TEMPLATE_RECIPE). A changed, added or removed migration gives a new name, so a template never
 *            holds an older schema; so does a change to how a template is built (raise TEMPLATE_RECIPE).
 *   ready    datistemplate AND NOT datallowconn. Nobody connects to a ready template (a copy needs it unused).
 *   use      a ready template is copied (CREATE DATABASE … TEMPLATE) without the lock: copies of one template run at
 *            the same time, and only a build needs the lock. A template dropped between the look and the copy (the
 *            clean-up below) is looked for again, under the lock, and built anew.
 *   build    under MIGRATION_LOCK, where it is looked for again: factory_tpl_<hash>_b<hex> is created, every migration
 *            applied to it, its catalogs compacted (below), its connection closed, its build time written with COMMENT ON
 *            DATABASE, renamed to factory_tpl_<hash>, then marked IS_TEMPLATE true ALLOW_CONNECTIONS false. Only a holder
 *            of the lock builds, so a _b… database seen under the lock was left by a crashed build: it is dropped first,
 *            and so is a factory_tpl_<hash> that a crash left unmarked. A build that fails drops its own _b… database.
 *   compact  the policy migrations drop and create every policy again, so the catalogs end up mostly dead rows (a
 *            migrated database is ~175 MB, pg_policy alone ~115 MB). Every copy writes all of it again (WAL and data),
 *            and on the shared local server that I/O is what every test pays for. So the build ends with VACUUM FULL of
 *            each of the template's own catalogs (pg_catalog, not the cluster-wide ones): ~45 MB to copy, no dead rows.
 *            The tables of the schema are not touched: their statistics stay those of a database migrated from zero.
 *   clean    only while a new template is built: every other factory_tpl_<hash> built more than 24 hours ago is unmarked
 *            (IS_TEMPLATE false) and dropped. Nothing but factory_tpl_… is ever dropped here, and a leftover or an old
 *            template never WITH (FORCE): one someone is connected to is left alone.
 */

export const TEMPLATE_PREFIX = 'factory_tpl_'
const TEMPLATE = /^factory_tpl_[0-9a-f]{16}$/
const BUILD = /^factory_tpl_[0-9a-f]{16}_b[0-9a-f]{8}$/
/** A template built longer ago than this is dropped when a new one is built. */
export const TEMPLATE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const BUILT = /\bbuilt (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/
const UNDEFINED_DATABASE = '3D000'
/** How a template is built; part of its hash, so a template built another way is never reused. */
export const TEMPLATE_RECIPE = 'nexus factory test template 2 (catalogs compacted)'

/** The first 16 hex of the sha256 of TEMPLATE_RECIPE and every migration's folder name and SQL, in the order given. */
export function migrationsHash(migrations: readonly Migration[]): string {
  const hash = createHash('sha256').update(`${TEMPLATE_RECIPE}\0`)
  for (const { folder, sql } of migrations) hash.update(`${folder}\0${Buffer.byteLength(sql)}\0`).update(sql)
  return hash.digest('hex').slice(0, 16)
}

/** factory_tpl_<hash> of a migration set. */
export const templateName = (migrations: readonly Migration[]): string => `${TEMPLATE_PREFIX}${migrationsHash(migrations)}`

/** FACTORY_PG_TEST_TEMPLATE: unset, empty or `on` copies the template; `off` migrates every test database from zero. */
export function templateSwitch(): boolean {
  const value = process.env.FACTORY_PG_TEST_TEMPLATE
  if (value === undefined || value === '' || value === 'on') return true
  if (value === 'off') return false
  throw new Error(`FACTORY_PG_TEST_TEMPLATE must be "on" or "off", not ${JSON.stringify(value)}.`)
}

export interface TemplateOptions {
  /** Connected to the server's `postgres` database as its admin login; creates, renames and drops databases. */
  readonly root: pg.Client
  /** The server's URL (loopback, checked by the caller). */
  readonly server: URL
  readonly migrations: readonly Migration[]
  /** The migration lock's key (MIGRATION_LOCK). */
  readonly lockKey: string
  /** Who asks, for the lock holder's application_name (the test database's name without factory_test_). */
  readonly tag: string
}

/** The template's build time, read back from its comment (undefined when it has none). */
export async function templateBuiltAt(root: pg.Client, template: string): Promise<{ oid: number; builtAt: Date | undefined } | undefined> {
  const { rows } = await root.query<{ oid: number; comment: string | null }>(
    `SELECT oid::int AS oid, shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1`,
    [template],
  )
  const row = rows[0]
  if (!row) return undefined
  const built = BUILT.exec(row.comment ?? '')
  return { oid: row.oid, builtAt: built ? new Date(built[1]!) : undefined }
}

const isReady = async (root: pg.Client, template: string): Promise<boolean> =>
  (await root.query('SELECT 1 FROM pg_database WHERE datname = $1 AND datistemplate AND NOT datallowconn', [template])).rowCount === 1

const databaseUrl = (server: URL, database: string): string => {
  const url = new URL(server.href)
  url.username = decodeURIComponent(server.username) || 'postgres'
  url.password = ''
  url.pathname = `/${database}`
  return url.href
}

/** Drops a database of ours that nobody uses; one in use is left alone (and said so). */
async function dropUnused(root: pg.Client, database: string, why: string): Promise<boolean> {
  if (!TEMPLATE.test(database) && !BUILD.test(database)) throw new Error(`Refused to drop ${database}: not a factory_tpl_… database.`)
  try {
    await root.query(`ALTER DATABASE "${database}" WITH IS_TEMPLATE false`)
    await root.query(`DROP DATABASE IF EXISTS "${database}"`)
    console.log(`[factory-db tests] dropped ${database} (${why})`)
    return true
  } catch (error) {
    if ((error as { code?: string }).code === UNDEFINED_DATABASE) return true
    console.warn(`[factory-db tests] left ${database} (${why}) in place: ${(error as Error).message}`)
    return false
  }
}

/** Builds factory_tpl_<hash>; the caller holds the migration lock, and `signal` aborts when it is lost. */
async function buildTemplate(options: TemplateOptions, template: string, signal: AbortSignal): Promise<void> {
  const { root, server, migrations } = options
  const started = performance.now()
  const ours = (await root.query<{ datname: string; datistemplate: boolean }>(
    `SELECT datname, datistemplate FROM pg_database WHERE starts_with(datname, $1) ORDER BY 1`,
    [TEMPLATE_PREFIX],
  )).rows
  // Only a holder of the lock builds: a _b… database here is a crashed build's, and so is our name left unmarked.
  for (const { datname } of ours.filter((row) => BUILD.test(row.datname))) await dropUnused(root, datname, 'left by a build that stopped')
  const unmarked = ours.find((row) => row.datname === template && !row.datistemplate)
  if (unmarked && !(await dropUnused(root, template, 'renamed but never marked as a template'))) {
    throw new Error(`Cannot build ${template}: an unmarked database of that name is in use.`)
  }

  const build = `${template}_b${randomBytes(4).toString('hex')}`
  await root.query(`CREATE DATABASE "${build}"`)
  try {
    const builder = new pg.Client({
      connectionString: databaseUrl(server, build),
      application_name: testKitApplicationName('admin', build.slice('factory_'.length)),
    })
    // A session the server ends while the client is idle emits 'error'; the next query fails with it instead.
    builder.on('error', () => {})
    try {
      await builder.connect()
      for (const migration of migrations) {
        signal.throwIfAborted()
        try {
          await builder.query(migration.sql)
        } catch (error) {
          throw new Error(`Migration ${migration.folder} failed on ${build}: ${(error as Error).message}`)
        }
      }
      // Compact the catalogs: VACUUM FULL one at a time (it cannot run in a transaction block).
      const catalogs = await builder.query<{ relname: string }>(
        `SELECT relname FROM pg_class WHERE relnamespace = 'pg_catalog'::regnamespace AND relkind = 'r' AND NOT relisshared ORDER BY relname`,
      )
      for (const { relname } of catalogs.rows) {
        signal.throwIfAborted()
        await builder.query(`VACUUM FULL pg_catalog.${builder.escapeIdentifier(relname)}`)
      }
    } finally {
      await builder.end().catch(() => {})
    }
    signal.throwIfAborted()
    const comment = `nexus factory test template: ${migrations.length} migration(s), the newest ${migrations.at(-1)?.folder ?? 'none'}; built ${new Date().toISOString()}`
    await root.query(`COMMENT ON DATABASE "${build}" IS ${root.escapeLiteral(comment)}`)
    // RENAME waits (up to 5 s) for the builder's closed session to leave the server.
    await root.query(`ALTER DATABASE "${build}" RENAME TO "${template}"`)
  } catch (error) {
    await root.query(`DROP DATABASE IF EXISTS "${build}" WITH (FORCE)`).catch(() => {})
    throw error
  }
  await root.query(`ALTER DATABASE "${template}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`)
  console.log(`[factory-db tests] built ${template} from ${migrations.length} migration(s) in ${((performance.now() - started) / 1000).toFixed(1)} s`)

  // Clean-up, only now: every other template built more than 24 hours ago.
  for (const { datname } of ours.filter((row) => TEMPLATE.test(row.datname) && row.datname !== template)) {
    const builtAt = (await templateBuiltAt(root, datname))?.builtAt
    if (builtAt && Date.now() - builtAt.getTime() > TEMPLATE_MAX_AGE_MS) await dropUnused(root, datname, `built ${builtAt.toISOString()}, over 24 hours ago`)
  }
}

/**
 * The ready template of this migration set, built first when there is none. Returns its name and whether this call
 * built it. A ready one is found without the lock; otherwise it is looked for again under the lock, then built.
 */
export async function ensureTemplate(options: TemplateOptions): Promise<{ template: string; built: boolean }> {
  const template = templateName(options.migrations)
  if (await isReady(options.root, template)) return { template, built: false }
  return withMigrationLock({ url: options.server.href, key: options.lockKey, tag: options.tag }, async (signal) => {
    if (await isReady(options.root, template)) return { template, built: false }
    await buildTemplate(options, template, signal)
    return { template, built: true }
  })
}

/** Creates `database` as a copy of this migration set's template (built first when there is none). */
export async function createFromTemplate(options: TemplateOptions, database: string): Promise<{ template: string; built: boolean }> {
  for (let attempt = 1; ; attempt++) {
    const ensured = await ensureTemplate(options)
    try {
      await options.root.query(`CREATE DATABASE "${database}" TEMPLATE "${ensured.template}"`)
      return ensured
    } catch (error) {
      // Dropped by another build's clean-up between the look and the copy: look again (under the lock) and build it.
      if ((error as { code?: string }).code !== UNDEFINED_DATABASE || attempt >= 3) throw error
    }
  }
}
