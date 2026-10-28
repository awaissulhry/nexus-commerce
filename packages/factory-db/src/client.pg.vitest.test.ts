import { randomBytes, randomUUID } from 'node:crypto'
import { TenantScopeError, UnsafeRuntimeLoginError } from '@nexus/db-kit'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed, type CoreSeed } from '../seed/_core'
import { openFactoryDatabase, scopedClients, type FactoryDatabase, type FactoryScope } from './client'
import { OFFICE_ROLE, RUNTIME_LOGIN, RUNTIME_ROLES } from './roles'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The factory client and the database walls around it, on a database built from the migrations: the login audit at
 * boot, the checked scopes, the per-scope client cache, what a connection without a scope can do (nothing), the
 * tenantId default, the tenant-safe references, and the seed.
 */
let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let b: CoreSeed
const pools: pg.Pool[] = []
const roles: string[] = []
const pool = (user = RUNTIME_LOGIN, max = 2): pg.Pool => {
  const created = new pg.Pool({ connectionString: db.url(user), max })
  pools.push(created)
  return created
}
const office = (seeded: CoreSeed): FactoryScope => ({ audience: 'office', tenantId: seeded.tenantId, actorId: seeded.actorId })
const count = async (table: string, tenantId: string): Promise<number> =>
  (await db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" = $1`, [tenantId])).rows[0]!.n
const counts = async (tenantId: string): Promise<number[]> => {
  const out: number[] = []
  for (const table of ['Company', 'Site', 'Line', 'WorkCentre', 'Station']) out.push(await count(table, tenantId))
  return out
}

beforeAll(async () => {
  db = await migratedDatabase('client')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seed({ db: factory, namespace: 'client-a' })
  b = await seed({ db: factory, namespace: 'client-b' })
}, 60_000)

afterAll(async () => {
  await factory?.close()
  await Promise.allSettled(pools.map((p) => p.end()))
  for (const role of roles) await db?.admin.query(`DROP ROLE IF EXISTS "${role}"`)
  await db?.close()
}, 60_000)

describe('the runtime login', () => {
  it('passes the audit: no admin attribute, owns nothing, enters every runtime role without inheriting it, set_config locked', async () => {
    const opened = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 1 } })
    await opened.close()
  })

  it('refuses a superuser login at boot, before any query', async () => {
    const error = await openFactoryDatabase({ connectionString: db.url('postgres') }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UnsafeRuntimeLoginError)
    expect((error as UnsafeRuntimeLoginError).failures.join('; ')).toMatch(/superuser/)
  })

  it('refuses a login that inherits the runtime roles', async () => {
    const role = `w009_${randomBytes(4).toString('hex')}_inherits`
    roles.push(role)
    // Cluster-wide: a random name, dropped after the file.
    await db.admin.query(`CREATE ROLE "${role}" LOGIN; GRANT ${RUNTIME_ROLES.map((r) => `"${r}"`).join(', ')} TO "${role}" WITH INHERIT TRUE, SET TRUE`)
    const error = await openFactoryDatabase({ connectionString: db.url(role) }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UnsafeRuntimeLoginError)
    expect((error as UnsafeRuntimeLoginError).failures).toContain(`the login inherits ${OFFICE_ROLE}: grant it WITH INHERIT FALSE`)
  })

  it('reads no table outside a runtime role', async () => {
    await expect(pool().query('SELECT count(*) FROM "Company"')).rejects.toThrow(/permission denied for table Company/)
  })

  it('in a runtime role but without a scope, sees no row and cannot insert one', async () => {
    const client = await pool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL ROLE ${OFFICE_ROLE}`)
      expect((await client.query('SELECT count(*)::int AS n FROM "Company"')).rows[0].n).toBe(0)
      await expect(
        client.query(`INSERT INTO "Line" (id, "companyId", "siteId", code, name) VALUES ($1, $2, $3, 'X', 'X')`, [randomUUID(), a.companies[0]!.id, a.sites[0]!.id]),
        // The insert policy refuses it first; without the policy the NULL tenantId default would.
      ).rejects.toThrow(/new row violates row-level security policy for table "Line"/)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
    expect(await count('Company', a.tenantId)).toBe(2)
  })

  it('cannot change its own scope as a runtime role: set_config is the login\'s only', async () => {
    const client = await pool().connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL ROLE ${OFFICE_ROLE}`)
      await expect(client.query("SELECT set_config('factory.tenant_id', $1, true)", [b.tenantId])).rejects.toThrow(/permission denied for function set_config/)
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})

describe('scopes', () => {
  it.each<[string, unknown, string]>([
    ['no audience', { tenantId: randomUUID() }, 'scope_required'],
    ['an unknown audience', { audience: 'admin', tenantId: randomUUID() }, 'scope_required'],
    ['an office scope without a tenant', { audience: 'office', actorId: 'u' }, 'scope_required'],
    ['an office scope without an actor', { audience: 'office', tenantId: randomUUID() }, 'scope_required'],
    ['a floor scope without a site', { audience: 'floor', tenantId: randomUUID(), actorId: 'u' }, 'scope_required'],
    ['a partner scope without a party', { audience: 'partner', tenantId: randomUUID(), actorId: 'u' }, 'scope_required'],
    ['a tenant that is not a UUID', { audience: 'office', tenantId: "x' OR true --", actorId: 'u' }, 'scope_invalid'],
    ['a key of another audience', { audience: 'office', tenantId: randomUUID(), actorId: 'u', siteId: randomUUID() }, 'scope_invalid'],
    ['a platform scope with a tenant', { audience: 'platform', tenantId: randomUUID() }, 'scope_invalid'],
  ])('refuses %s before any query', async (_label, scope, code) => {
    let ran = false
    const error = await factory
      .withScope(scope as FactoryScope, async () => {
        ran = true
      })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TenantScopeError)
    expect((error as TenantScopeError).code).toBe(code)
    expect(ran).toBe(false)
  })

  it('fills tenantId from the scope; the app never sets it', async () => {
    const id = randomUUID()
    const line = await factory.withScope(office(a), (client) =>
      client.line.create({ data: { id, companyId: a.companies[0]!.id, siteId: a.sites[0]!.id, code: `T-${id.slice(0, 6)}`, name: 'Temporary' } }),
    )
    expect(line.tenantId).toBe(a.tenantId)
    await db.admin.query('DELETE FROM "Line" WHERE id = $1', [id])
  })
})

describe('tenant-safe references', () => {
  it('a site cannot belong to another tenant\'s company', async () => {
    const error = await factory
      .withScope(office(a), (client) =>
        client.site.create({ data: { id: randomUUID(), companyId: b.companies[0]!.id, code: 'X9', name: 'X', kind: 'PLANT' } }),
      )
      .catch((caught: unknown) => caught as Error)
    expect(String(error)).toMatch(/Site_tenantId_companyId_fkey|Foreign key constraint/)
  })

  it('a station cannot sit on a line of another site, nor in its work centre', async () => {
    const [here, there] = a.sites as [CoreSeed['sites'][0], CoreSeed['sites'][0]]
    const [lineThere] = (await db.admin.query<{ id: string }>('SELECT id FROM "Line" WHERE "siteId" = $1', [there.id])).rows
    const [centreHere] = (await db.admin.query<{ id: string }>('SELECT id FROM "WorkCentre" WHERE "siteId" = $1', [here.id])).rows
    const error = await factory
      .withScope(office(a), (client) =>
        client.station.create({
          data: { id: randomUUID(), companyId: here.companyId, siteId: here.id, lineId: lineThere!.id, workCentreId: centreHere!.id, code: 'X-01', name: 'X' },
        }),
      )
      .catch((caught: unknown) => caught as Error)
    expect(String(error)).toMatch(/Station_tenantId_siteId_lineId_fkey|Foreign key constraint/)
  })
})

describe('the per-scope client cache', () => {
  const scope = (tenantId: string): FactoryScope => ({ audience: 'office', tenantId, actorId: 'cache-test' })

  it('keeps one client per scope and raises the pool listener limit', async () => {
    const shared = pool()
    const clients = scopedClients(shared, 4)
    expect(shared.getMaxListeners()).toBeGreaterThanOrEqual(14)
    const first = await clients.withScope(scope(a.tenantId), async (client) => client)
    const again = await clients.withScope(scope(a.tenantId), async (client) => client)
    const other = await clients.withScope(scope(b.tenantId), async (client) => client)
    expect(again).toBe(first)
    expect(other).not.toBe(first)
    // Each client answers in its own tenant only.
    const names = await Promise.all([a, b].map((seeded) => clients.withScope(scope(seeded.tenantId), (client) => client.tenant.findMany({ select: { slug: true } }))))
    expect(names).toEqual([[{ slug: 'client-a' }], [{ slug: 'client-b' }]])
    await clients.close()
  })

  it('closes the least recently used idle client to make room, and waits while every client is busy', async () => {
    const clients = scopedClients(pool(), 1)
    const first = await clients.withScope(scope(a.tenantId), async (client) => client)
    const order: string[] = []
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const busy = clients.withScope(scope(a.tenantId), async () => {
      order.push('a starts')
      await held
      order.push('a ends')
    })
    const waiting = clients.withScope(scope(b.tenantId), async (client) => {
      order.push('b runs')
      return client.tenant.count()
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(order).toEqual(['a starts'])
    release()
    await busy
    expect(await waiting).toBe(1)
    expect(order).toEqual(['a starts', 'a ends', 'b runs'])
    // A was evicted for B; using A again makes a new client.
    expect(await clients.withScope(scope(a.tenantId), async (client) => client)).not.toBe(first)
    await clients.close()
    await expect(clients.withScope(scope(a.tenantId), async () => 1)).rejects.toThrow(TenantScopeError)
  })
})

describe('the seed', () => {
  it('is idempotent and writes nothing outside its tenant', async () => {
    const before = await counts(a.tenantId)
    expect(before).toEqual([2, 2, 2, 8, 10])
    const again = await seed({ db: factory, namespace: 'client-a' })
    expect(again).toEqual(a)
    expect(await counts(a.tenantId)).toEqual(before)
    expect(await count('Company', b.tenantId)).toBe(2)
  })
})
