import { PrismaClient } from '@prisma/client'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lockSetConfigSql, policySql, runtimeRoleSql, type PolicyModel } from './policy-sql'
import type { ScopeDefinition } from './scope'
import { TenantPg } from './tenant-adapter'
import { throwawayDatabase, type ThrowawayDatabase } from './testing/throwaway-database'

/**
 * The generated policy SQL on real PostgreSQL 17 (the local factory stack): applied twice it changes nothing; tenant A's
 * rows are invisible to tenant B; an empty setting matches no row; a floor-like role cannot read a hidden column, a
 * partner-like role sees only its party; the owner obeys the policies (FORCE); a newer model removes what an older one
 * or a hand-made policy granted. Queries run through TenantPg and a real Prisma client.
 */
const TENANT_A = '00000000-0000-7000-8000-00000000000a'
const TENANT_B = '00000000-0000-7000-8000-00000000000b'
const SITE_1 = '00000000-0000-7000-8000-000000000051'
const SITE_2 = '00000000-0000-7000-8000-000000000052'
const PARTY_1 = '00000000-0000-7000-8000-0000000000a1'
const PARTY_2 = '00000000-0000-7000-8000-0000000000a2'

describe('policySql on real PostgreSQL', () => {
  let db: ThrowawayDatabase
  let office = ''
  let floor = ''
  let partner = ''
  let owner = ''
  let login = ''
  let model: PolicyModel
  let pool: pg.Pool
  const clients: PrismaClient[] = []
  const settings = {
    tenantId: { setting: 'dbkit.tenant_id', required: true },
    actorId: { setting: 'dbkit.actor_id', required: true },
  } as const
  const definitions = () => ({
    office: { role: office, settings } satisfies ScopeDefinition,
    floor: { role: floor, settings: { ...settings, siteId: { setting: 'dbkit.site_id', required: true } } } satisfies ScopeDefinition,
    partner: { role: partner, settings: { ...settings, partyId: { setting: 'dbkit.party_id', required: true } } } satisfies ScopeDefinition,
  })
  const client = (definition: ScopeDefinition, values: Record<string, string | null>): PrismaClient => {
    const created = new PrismaClient({ adapter: new TenantPg(pool, definition, values), log: [] })
    clients.push(created)
    return created
  }
  const officeOf = (tenantId: string) => client(definitions().office, { tenantId, actorId: 'user_1' })
  const floorOf = (tenantId: string, siteId: string) => client(definitions().floor, { tenantId, actorId: 'user_1', siteId })
  const partnerOf = (tenantId: string, partyId: string) => client(definitions().partner, { tenantId, actorId: 'user_1', partyId })
  const apply = (sql: string) => db.admin.query(sql)
  /** Everything the generated SQL controls: RLS flags, policies, table and column ACLs. */
  const snapshot = async () =>
    (
      await db.admin.query<{ state: unknown }>(`
        SELECT json_build_object(
          'tables', (SELECT json_agg(json_build_array(relname, relrowsecurity, relforcerowsecurity, relacl::text) ORDER BY relname)
                     FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'),
          'columns', (SELECT json_agg(json_build_array(c.relname, a.attname, a.attacl::text) ORDER BY c.relname, a.attname)
                      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND a.attacl IS NOT NULL),
          'policies', (SELECT json_agg(json_build_array(tablename, policyname, permissive, roles::text, cmd, qual, with_check)
                       ORDER BY tablename, policyname) FROM pg_policies WHERE schemaname = 'public')
        ) AS state`)
    ).rows[0]!.state

  beforeAll(async () => {
    db = await throwawayDatabase('policy')
    office = db.role('office')
    floor = db.role('floor')
    partner = db.role('partner')
    owner = db.role('owner')
    login = db.role('login')
    model = {
      roles: [office, floor, partner],
      keys: {
        tenant: { setting: 'dbkit.tenant_id', type: 'uuid' },
        site: { setting: 'dbkit.site_id', type: 'uuid' },
        party: { setting: 'dbkit.party_id', type: 'uuid' },
      },
      alwaysScopedBy: ['tenant'],
      tables: [
        {
          table: 'StockMove',
          columns: ['id', 'tenantId', 'siteId', 'qty', 'unitCost'],
          keyColumns: { tenant: 'tenantId', site: 'siteId' },
          access: {
            [office]: { privileges: ['select', 'insert', 'update'] },
            [floor]: { privileges: ['select', 'insert'], scopedBy: ['site'], hiddenColumns: ['unitCost'] },
          },
        },
        {
          table: 'Quote',
          columns: ['id', 'tenantId', 'partyId', 'total', 'margin', 'note'],
          keyColumns: { tenant: 'tenantId', party: 'partyId' },
          access: {
            [office]: { privileges: ['select', 'insert', 'update', 'delete'] },
            [partner]: { privileges: ['select'], scopedBy: ['party'], hiddenColumns: ['margin', 'note'] },
          },
        },
      ],
    }
    await apply(runtimeRoleSql(model.roles))
    await apply(`
      CREATE ROLE ${owner} NOLOGIN;
      CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
      GRANT ${office}, ${floor}, ${partner} TO ${login} WITH INHERIT FALSE, SET TRUE;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      CREATE TABLE public."StockMove" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL DEFAULT (current_setting('dbkit.tenant_id'))::uuid,
        "siteId" uuid NOT NULL, qty integer NOT NULL, "unitCost" integer);
      CREATE TABLE public."Quote" (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" uuid NOT NULL DEFAULT (current_setting('dbkit.tenant_id'))::uuid,
        "partyId" uuid NOT NULL, total integer NOT NULL, margin integer, note text);
      ALTER TABLE public."StockMove" OWNER TO ${owner};
      ALTER TABLE public."Quote" OWNER TO ${owner};
      INSERT INTO public."StockMove" ("tenantId", "siteId", qty, "unitCost") VALUES
        ('${TENANT_A}', '${SITE_1}', 1, 100), ('${TENANT_A}', '${SITE_2}', 2, 200), ('${TENANT_B}', '${SITE_1}', 3, 300);
      INSERT INTO public."Quote" ("tenantId", "partyId", total, margin, note) VALUES
        ('${TENANT_A}', '${PARTY_1}', 1000, 400, 'internal'), ('${TENANT_A}', '${PARTY_2}', 2000, 800, 'internal'),
        ('${TENANT_B}', '${PARTY_1}', 3000, 900, 'internal');
    `)
    await apply(policySql(model))
    pool = new pg.Pool(db.config(login, { max: 4 }))
    // Each Prisma client (one per scope) adds an error listener to the shared pool.
    pool.setMaxListeners(50)
  }, 60_000)

  afterAll(async () => {
    await Promise.allSettled(clients.map((c) => c.$disconnect()))
    await pool?.end()
    await db?.close()
  }, 60_000)

  it('is idempotent: applying the same SQL again changes nothing', async () => {
    const before = await snapshot()
    await apply(policySql(model))
    await apply(runtimeRoleSql(model.roles))
    expect(await snapshot()).toEqual(before)
    expect(before).toMatchObject({
      tables: [
        ['Quote', true, true, expect.any(String)],
        ['StockMove', true, true, expect.any(String)],
      ],
    })
  })

  it('keeps tenant A and tenant B apart for reads and writes', async () => {
    const a = officeOf(TENANT_A)
    const b = officeOf(TENANT_B)
    expect(await a.$queryRawUnsafe('SELECT qty FROM public."StockMove" ORDER BY qty')).toEqual([{ qty: 1 }, { qty: 2 }])
    expect(await b.$queryRawUnsafe('SELECT qty FROM public."StockMove" ORDER BY qty')).toEqual([{ qty: 3 }])
    expect(await a.$executeRawUnsafe('UPDATE public."StockMove" SET qty = qty WHERE "tenantId" = $1::uuid', TENANT_B)).toBe(0)
    await expect(
      a.$executeRawUnsafe('INSERT INTO public."StockMove" ("tenantId", "siteId", qty) VALUES ($1::uuid, $2::uuid, 9)', TENANT_B, SITE_1),
    ).rejects.toThrow(/row-level security/)
    // The tenant column's default comes from the setting: a row written without it lands in the writer's tenant.
    expect(await a.$executeRawUnsafe('INSERT INTO public."StockMove" ("siteId", qty) VALUES ($1::uuid, 7)', SITE_1)).toBe(1)
    expect(await b.$queryRawUnsafe('SELECT qty FROM public."StockMove" WHERE qty = 7')).toEqual([])
    expect(await a.$queryRawUnsafe('SELECT qty FROM public."StockMove" WHERE qty = 7')).toEqual([{ qty: 7 }])
    await db.admin.query('DELETE FROM public."StockMove" WHERE qty = 7')
  })

  it('an empty or unset setting matches no row (default deny)', async () => {
    const empty = client({ role: office, settings: { tenantId: { setting: 'dbkit.tenant_id', required: false } } }, {})
    expect(await empty.$queryRawUnsafe('SELECT qty FROM public."StockMove"')).toEqual([])
    // Even without the adapter: the runtime role inside a bare transaction, no setting at all.
    const raw = await pool.connect()
    try {
      await raw.query('BEGIN')
      await raw.query(`SET LOCAL ROLE ${office}`)
      expect((await raw.query('SELECT qty FROM public."StockMove"')).rows).toEqual([])
    } finally {
      await raw.query('ROLLBACK')
      raw.release()
    }
  })

  it('a role without a policy on the table, the table owner included, sees nothing (RLS forced)', async () => {
    await db.admin.query('BEGIN')
    try {
      await db.admin.query(`SET LOCAL ROLE ${owner}`)
      await db.admin.query("SELECT set_config('dbkit.tenant_id', $1, true)", [TENANT_A])
      expect((await db.admin.query('SELECT qty FROM public."StockMove"')).rows).toEqual([])
    } finally {
      await db.admin.query('ROLLBACK')
    }
  })

  it('a floor-like role sees only its site and cannot read or write a hidden column', async () => {
    const site1 = floorOf(TENANT_A, SITE_1)
    expect(await site1.$queryRawUnsafe('SELECT qty FROM public."StockMove"')).toEqual([{ qty: 1 }])
    expect(await floorOf(TENANT_A, SITE_2).$queryRawUnsafe('SELECT qty FROM public."StockMove"')).toEqual([{ qty: 2 }])
    await expect(site1.$queryRawUnsafe('SELECT * FROM public."StockMove"')).rejects.toThrow(/permission denied/)
    await expect(site1.$queryRawUnsafe('SELECT "unitCost" FROM public."StockMove"')).rejects.toThrow(/permission denied/)
    await expect(
      site1.$executeRawUnsafe('INSERT INTO public."StockMove" ("siteId", qty, "unitCost") VALUES ($1::uuid, 5, 1)', SITE_1),
    ).rejects.toThrow(/permission denied/)
    await expect(site1.$executeRawUnsafe('INSERT INTO public."StockMove" ("siteId", qty) VALUES ($1::uuid, 5)', SITE_2)).rejects.toThrow(
      /row-level security/,
    )
    expect(await site1.$executeRawUnsafe('INSERT INTO public."StockMove" ("siteId", qty) VALUES ($1::uuid, 5)', SITE_1)).toBe(1)
    // It was given no UPDATE and no access to Quote.
    await expect(site1.$executeRawUnsafe('UPDATE public."StockMove" SET qty = 6 WHERE qty = 5')).rejects.toThrow(/permission denied/)
    await expect(site1.$queryRawUnsafe('SELECT total FROM public."Quote"')).rejects.toThrow(/permission denied/)
    await db.admin.query('DELETE FROM public."StockMove" WHERE qty = 5')
  })

  it("a partner-like role sees only its party's rows, without margin or notes", async () => {
    expect(await partnerOf(TENANT_A, PARTY_1).$queryRawUnsafe('SELECT total FROM public."Quote"')).toEqual([{ total: 1000 }])
    expect(await partnerOf(TENANT_A, PARTY_2).$queryRawUnsafe('SELECT total FROM public."Quote"')).toEqual([{ total: 2000 }])
    expect(await partnerOf(TENANT_B, PARTY_1).$queryRawUnsafe('SELECT total FROM public."Quote"')).toEqual([{ total: 3000 }])
    await expect(partnerOf(TENANT_A, PARTY_1).$queryRawUnsafe('SELECT margin FROM public."Quote"')).rejects.toThrow(/permission denied/)
    await expect(partnerOf(TENANT_A, PARTY_1).$queryRawUnsafe('SELECT note FROM public."Quote"')).rejects.toThrow(/permission denied/)
    await expect(partnerOf(TENANT_A, PARTY_1).$queryRawUnsafe('SELECT qty FROM public."StockMove"')).rejects.toThrow(/permission denied/)
  })

  it('a newer model removes what an older model or a hand-made policy granted', async () => {
    await apply(`
      CREATE POLICY "stray_open" ON public."StockMove" AS PERMISSIVE FOR SELECT TO ${floor} USING (true);
      GRANT SELECT ON public."StockMove" TO ${floor};
      GRANT SELECT ON public."Quote" TO PUBLIC;
    `)
    const site1 = floorOf(TENANT_A, SITE_1)
    // The damage: every row of every tenant, and the hidden column.
    expect(await site1.$queryRawUnsafe('SELECT count(*)::int AS n FROM public."StockMove" WHERE "unitCost" > 0')).toEqual([{ n: 3 }])
    const tables = model.tables
    const newer: PolicyModel = {
      ...model,
      tables: [
        { ...tables[0]!, access: { ...tables[0]!.access, [floor]: { privileges: ['select'], scopedBy: ['site'], hiddenColumns: ['unitCost', 'qty'] } } },
        { ...tables[1]!, access: { [office]: tables[1]!.access[office]! } },
      ],
    }
    await apply(policySql(newer))
    const policies = await db.admin.query<{ policyname: string }>("SELECT policyname FROM pg_policies WHERE tablename = 'StockMove' ORDER BY 1")
    expect(policies.rows.map((row) => row.policyname)).toEqual([`${floor}_select`, `${office}_insert`, `${office}_select`, `${office}_update`])
    expect(await site1.$queryRawUnsafe('SELECT "siteId"::text AS site FROM public."StockMove"')).toEqual([{ site: SITE_1 }])
    await expect(site1.$queryRawUnsafe('SELECT qty FROM public."StockMove"')).rejects.toThrow(/permission denied/)
    await expect(site1.$queryRawUnsafe('SELECT "unitCost" FROM public."StockMove"')).rejects.toThrow(/permission denied/)
    await expect(site1.$executeRawUnsafe('INSERT INTO public."StockMove" ("siteId") VALUES ($1::uuid)', SITE_1)).rejects.toThrow(/permission denied/)
    await expect(partnerOf(TENANT_A, PARTY_1).$queryRawUnsafe('SELECT total FROM public."Quote"')).rejects.toThrow(/permission denied/)
    // Back to the original model: the same state as the first application.
    const reference = await snapshot()
    await apply(policySql(model))
    await apply(policySql(newer))
    expect(await snapshot()).toEqual(reference)
    await apply(policySql(model))
  })

  it('with set_config locked, the adapter still works and SQL as a runtime role cannot change the scope', async () => {
    await apply(lockSetConfigSql([login], model.roles))
    try {
      expect(await officeOf(TENANT_B).$queryRawUnsafe('SELECT qty FROM public."StockMove"')).toEqual([{ qty: 3 }])
      // The database wall alone, without the adapter's statement guard: a bare transaction as the runtime role.
      const raw = await pool.connect()
      try {
        await raw.query('BEGIN')
        await raw.query('SELECT set_config($1, $2, true), set_config($3, $4, true)', ['role', office, 'dbkit.tenant_id', TENANT_A])
        await raw.query('SAVEPOINT probe')
        await expect(raw.query("SELECT set_config('dbkit.tenant_id', $1, true)", [TENANT_B])).rejects.toThrow(/permission denied for function set_config/)
        await raw.query('ROLLBACK TO SAVEPOINT probe')
        await expect(
          raw.query(`SELECT query_to_xml('SELECT set_config(''dbkit.tenant_id'', ''${TENANT_B}'', true)', true, true, '')`),
        ).rejects.toThrow(/permission denied for function set_config/)
        await raw.query('ROLLBACK TO SAVEPOINT probe')
        expect((await raw.query("SELECT current_setting('dbkit.tenant_id') AS tenant")).rows).toEqual([{ tenant: TENANT_A }])
      } finally {
        await raw.query('ROLLBACK')
        raw.release()
      }
    } finally {
      await apply('GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO PUBLIC')
    }
  })

  it('runtimeRoleSql refuses a role of that name that can log in', async () => {
    await expect(apply(runtimeRoleSql([login]))).rejects.toThrow(/must be NOLOGIN/)
  })
})
