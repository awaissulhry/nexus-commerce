import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { readMigrations, type Migration } from '../policies'
import { MIGRATIONS_DIR } from '../tools'
import { MIGRATION_LOCK, migratedDatabase, testServerUrl, type MigratedDatabase } from './database'
import { testKitApplicationName } from './migration-lock'
import { createFromTemplate, migrationsHash, templateBuiltAt, templateName, templateSwitch, TEMPLATE_PREFIX } from './template'

/**
 * The migrated template of the test databases (B-W2b-F27): copies of one template hold exactly the schema a database
 * migrated from zero holds and nothing of each other; a second copy does not build again; copies made at the same time,
 * and builds asked for at the same time, all succeed; a crash's leftovers and templates over 24 hours old are dropped
 * when a new template is built, and nothing else; FACTORY_PG_TEST_TEMPLATE=off migrates from zero as before. The real
 * template is only used, never dropped; the made-up migration sets below build templates of their own, dropped here.
 */
const RUN = process.env.FACTORY_PG_TEST_RUN ?? 'adhoc'
if (!/^[a-z0-9]{1,16}$/.test(RUN)) throw new Error(`Bad FACTORY_PG_TEST_RUN: ${JSON.stringify(RUN)}.`)
const server = testServerUrl()
const migrations = readMigrations(MIGRATIONS_DIR)
const template = templateName(migrations)
const hex = (): string => randomBytes(4).toString('hex')
// This file is about the template: it starts with the switch at its default (on), whatever the shell set.
const SWITCH = process.env.FACTORY_PG_TEST_TEMPLATE
delete process.env.FACTORY_PG_TEST_TEMPLATE

let root: pg.Client
const opened = new Set<MigratedDatabase>()
/** Databases this file made by hand (made-up templates, leftovers, a bystander), dropped in afterAll. */
const mine = new Set<string>()

async function open(label: string): Promise<MigratedDatabase> {
  const db = await migratedDatabase(label)
  opened.add(db)
  return db
}

async function close(...dbs: MigratedDatabase[]): Promise<void> {
  for (const db of dbs) {
    opened.delete(db)
    await db.close()
  }
}

const exists = async (database: string): Promise<boolean> =>
  (await root.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rowCount === 1

async function dropMine(database: string): Promise<void> {
  if (!/^factory_(tpl|test)_/.test(database) || database === template) throw new Error(`Refused to drop ${database}.`)
  if (!(await exists(database))) return
  await root.query(`ALTER DATABASE "${database}" WITH IS_TEMPLATE false`)
  await root.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
}

/** A client of its own on the server's `postgres` database (each build or copy below runs on one). */
async function rootClient(tag: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: server.href, application_name: testKitApplicationName('root', tag) })
  await client.connect()
  return client
}

/** A made-up migration set of its own (a fresh hash, so a template nobody else has). */
const madeUp = (): Migration[] => [
  { folder: '000000000001_probe', sql: `CREATE TABLE "Probe" (id int PRIMARY KEY); -- ${hex()}` },
  { folder: '000000000002_probe_rows', sql: `INSERT INTO "Probe" (id) VALUES (1), (2);` },
]

/** What a migrated database holds: tables and their walls, columns, constraints, indexes, policies, triggers, functions, grants, rows. */
async function catalog(client: pg.Client) {
  const list = async (sql: string): Promise<string[]> => (await client.query<{ line: string }>(sql)).rows.map((row) => row.line)
  return {
    tables: await list(`SELECT format('%s rls=%s forced=%s acl=%s', relname, relrowsecurity, relforcerowsecurity, relacl) AS line
      FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') ORDER BY 1`),
    columns: await list(`SELECT format('%s.%s %s %s %s', table_name, column_name, data_type, is_nullable, column_default) AS line
      FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`),
    constraints: await list(`SELECT format('%s %s %s', conrelid::regclass, conname, pg_get_constraintdef(oid)) AS line
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1`),
    indexes: await list(`SELECT indexdef AS line FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`),
    policies: await list(`SELECT format('%s %s %s %s %s %s %s', tablename, policyname, permissive, roles, cmd, qual, with_check) AS line
      FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`),
    triggers: await list(`SELECT pg_get_triggerdef(t.oid) AS line FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal ORDER BY 1`),
    functions: await list(`SELECT format('%s(%s) %s acl=%s', p.proname, pg_get_function_identity_arguments(p.oid), md5(p.prosrc), p.proacl) AS line
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`),
    types: await list(`SELECT format('%s %s', t.typname, coalesce(string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder), '')) AS line
      FROM pg_type t LEFT JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typnamespace = 'public'::regnamespace GROUP BY t.typname ORDER BY 1`),
    schemas: await list(`SELECT format('%s acl=%s', nspname, nspacl) AS line FROM pg_namespace
      WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1`),
    defaults: await list(`SELECT format('%s %s %s', pg_get_userbyid(defaclrole), defaclobjtype, defaclacl) AS line FROM pg_default_acl ORDER BY 1`),
    extensions: await list(`SELECT format('%s %s', extname, extversion) AS line FROM pg_extension ORDER BY 1`),
    // The rows the migrations wrote (the admin login skips row-level security).
    rows: await list(`SELECT format('%s %s', relname,
        (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', relname), false, true, '')))[1]::text) AS line
      FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') ORDER BY 1`),
  }
}

beforeAll(async () => {
  root = await rootClient('tplkit')
}, 60_000)

afterEach(() => {
  delete process.env.FACTORY_PG_TEST_TEMPLATE
})

afterAll(async () => {
  for (const db of opened) await db.close().catch(() => {})
  for (const database of mine) await dropMine(database).catch(() => {})
  await root?.end()
  if (SWITCH === undefined) delete process.env.FACTORY_PG_TEST_TEMPLATE
  else process.env.FACTORY_PG_TEST_TEMPLATE = SWITCH
}, 600_000)

describe('the template name', () => {
  it('is factory_tpl_ and 16 hex of the migration set, and changes with any folder or its SQL', () => {
    const set: Migration[] = [
      { folder: '202610010000_a', sql: 'CREATE TABLE a (id int);' },
      { folder: '202610010001_b', sql: 'CREATE TABLE b (id int);' },
    ]
    expect(template).toMatch(/^factory_tpl_[0-9a-f]{16}$/)
    expect(migrationsHash(set)).toMatch(/^[0-9a-f]{16}$/)
    expect(migrationsHash(set.map((migration) => ({ ...migration })))).toBe(migrationsHash(set))
    const changed = [set[0]!, { ...set[1]!, sql: 'CREATE TABLE b (id bigint);' }]
    const added = [...set, { folder: '202610010002_c', sql: 'CREATE TABLE c (id int);' }]
    const renamed = [set[0]!, { ...set[1]!, folder: '202610010009_b' }]
    // A folder name running into its SQL never collides with another split of the same text.
    const split = [{ folder: '202610010000_ab', sql: 'c' }]
    const resplit = [{ folder: '202610010000_a', sql: 'bc' }]
    const hashes = [set, changed, added, renamed, set.slice(0, 1), split, resplit].map(migrationsHash)
    expect(new Set(hashes).size).toBe(hashes.length)
    expect(templateName(added)).toBe(`${TEMPLATE_PREFIX}${migrationsHash(added)}`)
  })

  it('reads the switch: on by default, off on FACTORY_PG_TEST_TEMPLATE=off, anything else refused', () => {
    expect(templateSwitch()).toBe(true)
    process.env.FACTORY_PG_TEST_TEMPLATE = ''
    expect(templateSwitch()).toBe(true)
    process.env.FACTORY_PG_TEST_TEMPLATE = 'on'
    expect(templateSwitch()).toBe(true)
    process.env.FACTORY_PG_TEST_TEMPLATE = 'off'
    expect(templateSwitch()).toBe(false)
    process.env.FACTORY_PG_TEST_TEMPLATE = 'false'
    expect(() => templateSwitch()).toThrow('FACTORY_PG_TEST_TEMPLATE must be "on" or "off", not "false".')
  })
})

describe('test databases copied from the migrated template', () => {
  it('gives two databases the full schema and nothing of each other', async () => {
    const a = await open('tpl_a')
    const b = await open('tpl_b')
    expect(await templateBuiltAt(root, template)).toMatchObject({ builtAt: expect.any(Date) })
    expect(a.name).not.toBe(b.name)
    expect(a.name).toMatch(new RegExp(`^factory_test_${RUN}_tpl_a_[0-9a-f]{8}$`))

    const tables = (await a.admin.query<{ relname: string; walled: boolean }>(
      `SELECT relname, relrowsecurity AND relforcerowsecurity AS walled FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') ORDER BY relname`,
    )).rows
    expect(tables.length).toBeGreaterThan(100)
    expect(tables.filter((table) => !table.walled)).toEqual([])
    expect(tables.map((table) => table.relname)).toContain('Tenant')

    const id = randomUUID()
    await a.admin.query(`INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, 'Template probe')`, [id, `tpl-${hex()}`])
    const seen = async (db: MigratedDatabase): Promise<number> => (await db.admin.query('SELECT 1 FROM "Tenant" WHERE id = $1', [id])).rowCount ?? 0
    expect(await seen(a)).toBe(1)
    expect(await seen(b)).toBe(0)
    expect(await catalog(b.admin)).toEqual(await catalogOfTemplate())
    await close(a, b)
  }, 900_000)

  /** The template's catalog, read through a fresh copy of it (nobody connects to the template). */
  let templateCatalog: Awaited<ReturnType<typeof catalog>> | undefined
  async function catalogOfTemplate(): Promise<Awaited<ReturnType<typeof catalog>>> {
    if (!templateCatalog) {
      const copy = await open('tpl_ref')
      templateCatalog = await catalog(copy.admin)
      await close(copy)
    }
    return templateCatalog
  }

  it('does not build again for a second database', async () => {
    const before = await templateBuiltAt(root, template)
    expect(before?.builtAt).toBeInstanceOf(Date)
    const started = performance.now()
    const again = await open('tpl_again')
    console.log(`[template test] a second copy of ${template} took ${((performance.now() - started) / 1000).toFixed(2)} s`)
    // The same template, built once: its oid and its build time are unchanged.
    expect(await templateBuiltAt(root, template)).toEqual(before)
    await close(again)
  }, 600_000)

  it('makes four databases at once', async () => {
    const before = await templateBuiltAt(root, template)
    const four = await Promise.all([1, 2, 3, 4].map((n) => open(`tpl_four${n}`)))
    expect(new Set(four.map((db) => db.name)).size).toBe(4)
    for (const db of four) {
      const { rows } = await db.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')`,
      )
      expect(rows[0]!.n).toBe((await catalogOfTemplate()).tables.length)
    }
    expect(await templateBuiltAt(root, template)).toEqual(before)
    await close(...four)
  }, 900_000)

  it('never lets anyone connect to the template', async () => {
    const url = new URL(server.href)
    url.pathname = `/${template}`
    const client = new pg.Client({ connectionString: url.href, application_name: testKitApplicationName('probe', 'tplkit') })
    await expect(client.connect()).rejects.toThrow(`database "${template}" is not currently accepting connections`)
    const { rows } = await root.query<{ datistemplate: boolean; datallowconn: boolean }>(
      'SELECT datistemplate, datallowconn FROM pg_database WHERE datname = $1',
      [template],
    )
    expect(rows).toEqual([{ datistemplate: true, datallowconn: false }])
  }, 60_000)

  it('migrates from zero with FACTORY_PG_TEST_TEMPLATE=off, to the same schema (a copy is the smaller: compacted catalogs)', async () => {
    const before = await templateBuiltAt(root, template)
    const size = async (db: MigratedDatabase): Promise<number> =>
      Number((await db.admin.query<{ size: string }>('SELECT pg_database_size(current_database()) AS size')).rows[0]!.size)
    const copy = await open('tpl_size')
    process.env.FACTORY_PG_TEST_TEMPLATE = 'off'
    const started = performance.now()
    const fresh = await open('tpl_off')
    console.log(`[template test] a database migrated from zero took ${((performance.now() - started) / 1000).toFixed(2)} s`)
    expect(await catalog(fresh.admin)).toEqual(await catalogOfTemplate())
    expect(await templateBuiltAt(root, template)).toEqual(before)
    // The same schema in far fewer pages: the migrations' dead catalog rows are not copied.
    expect(await size(copy)).toBeLessThan((await size(fresh)) / 2)
    await close(copy, fresh)

    process.env.FACTORY_PG_TEST_TEMPLATE = 'no'
    await expect(migratedDatabase('tpl_bad')).rejects.toThrow('FACTORY_PG_TEST_TEMPLATE must be "on" or "off", not "no".')
    const { rows } = await root.query('SELECT datname FROM pg_database WHERE starts_with(datname, $1)', [`factory_test_${RUN}_tpl_bad_`])
    expect(rows).toEqual([])
  }, 900_000)
})

describe('building a template', () => {
  const options = (client: pg.Client, set: readonly Migration[], tag: string) => ({ root: client, server, migrations: set, lockKey: MIGRATION_LOCK, tag })

  it('builds a new set once when four ask at once, and gives each its own copy', async () => {
    const set = madeUp()
    const fake = templateName(set)
    mine.add(fake)
    const clients = await Promise.all([1, 2, 3, 4].map((n) => rootClient(`tplbuild${n}`)))
    try {
      const names = [1, 2, 3, 4].map((n) => `factory_test_${RUN}_tplbuild${n}_${hex()}`)
      for (const name of names) mine.add(name)
      const results = await Promise.all(clients.map((client, i) => createFromTemplate(options(client, set, `tplbuild${i + 1}`), names[i]!)))
      expect(results.map((result) => result.template)).toEqual([fake, fake, fake, fake])
      expect(results.filter((result) => result.built)).toHaveLength(1)
      for (const name of names) {
        const url = new URL(server.href)
        url.pathname = `/${name}`
        const copy = new pg.Client({ connectionString: url.href, application_name: testKitApplicationName('probe', 'tplbuild') })
        await copy.connect()
        try {
          expect((await copy.query('SELECT id FROM "Probe" ORDER BY id')).rows).toEqual([{ id: 1 }, { id: 2 }])
        } finally {
          await copy.end()
        }
      }
      const { rows } = await root.query('SELECT datistemplate, datallowconn FROM pg_database WHERE datname = $1', [fake])
      expect(rows).toEqual([{ datistemplate: true, datallowconn: false }])
      expect(await templateBuiltAt(root, fake)).toMatchObject({ builtAt: expect.any(Date) })
    } finally {
      for (const client of clients) await client.end()
    }
  }, 900_000)

  it('drops what a crashed build left (a _b… database, our name never marked) before it builds', async () => {
    const set = madeUp()
    const fake = templateName(set)
    const leftover = `${fake}_b${hex()}`
    mine.add(fake).add(leftover)
    await root.query(`CREATE DATABASE "${leftover}"`)
    await root.query(`CREATE DATABASE "${fake}"`)
    const name = `factory_test_${RUN}_tplcrash_${hex()}`
    mine.add(name)
    expect(await createFromTemplate(options(root, set, 'tplcrash'), name)).toEqual({ template: fake, built: true })
    expect(await exists(leftover)).toBe(false)
    const { rows } = await root.query('SELECT datistemplate, datallowconn FROM pg_database WHERE datname = $1', [fake])
    expect(rows).toEqual([{ datistemplate: true, datallowconn: false }])
  }, 900_000)

  it('drops the templates built over 24 hours ago when it builds a new one, and nothing else', async () => {
    const make = async (database: string, comment: string, asTemplate: boolean): Promise<void> => {
      mine.add(database)
      await root.query(`CREATE DATABASE "${database}"`)
      await root.query(`COMMENT ON DATABASE "${database}" IS ${root.escapeLiteral(comment)}`)
      if (asTemplate) await root.query(`ALTER DATABASE "${database}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`)
    }
    const old = templateName(madeUp())
    const recent = templateName(madeUp())
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    await make(old, `nexus factory test template: 1 migration(s), the newest x; built ${longAgo}`, true)
    await make(recent, `nexus factory test template: 1 migration(s), the newest x; built ${new Date(Date.now() - 60 * 60 * 1000).toISOString()}`, true)
    // Not a template name: never dropped, however old its comment says it is.
    const bystander = `factory_test_${RUN}_tplkeep_${hex()}`
    await make(bystander, `built ${longAgo}`, false)

    // Using a ready template cleans nothing.
    const reuse = `factory_test_${RUN}_tplreuse_${hex()}`
    mine.add(reuse)
    expect(await createFromTemplate(options(root, migrations, 'tplreuse'), reuse)).toEqual({ template, built: false })
    expect(await exists(old)).toBe(true)

    const set = madeUp()
    mine.add(templateName(set))
    const name = `factory_test_${RUN}_tplclean_${hex()}`
    mine.add(name)
    expect(await createFromTemplate(options(root, set, 'tplclean'), name)).toMatchObject({ built: true })
    expect(await exists(old)).toBe(false)
    expect(await exists(recent)).toBe(true)
    expect(await exists(bystander)).toBe(true)
    expect(await exists(template)).toBe(true)
  }, 900_000)
})
