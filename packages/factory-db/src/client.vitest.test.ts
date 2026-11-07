import { randomUUID } from 'node:crypto'
import v8 from 'node:v8'
import vm from 'node:vm'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { clientKey, DEFAULT_CLIENT_CAPACITY, scopedClients, type FactoryScope } from './client'
import { readMigrations } from './policies'
import { SCOPE_DEFINITIONS } from './roles'
import { MIGRATIONS_DIR } from './tools'

/**
 * The per-scope client cache without a database (B-W2b-F9): the key holds exactly what the SQL reads, and what one
 * client costs. Clients are made but never connected: the pool below points nowhere and no query runs.
 *
 * Measured on 11-07 with Prisma 7.10 (main 8daff8c4b): a new client takes 85.5 MB of heap and about 95 ms the moment it
 * is made — Prisma decodes the generated parameterization graph (5.9 MB of base64) into objects of its own for every
 * client — and 10-25 MB of query-compiler memory outside the heap at its first query. The graph grows with each schema
 * wave (about 91 MB with wave 22). CLIENT_HEAP_BOUND_MB leaves room for a few more waves: when it fails, measure again
 * (the notes of B-W2b-F9 hold the script) and lower FACTORY_DATABASE_CLIENTS before raising the bound.
 */
const CLIENT_HEAP_BOUND_MB = 130

v8.setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc') as () => void
const heapMb = (): number => {
  gc()
  gc()
  return v8.getHeapStatistics().used_heap_size / 1048576
}

// Never connects: no test here runs a query.
const nowhere = new pg.Pool({ connectionString: 'postgresql://factory_app@127.0.0.1:9/factory_test_none', max: 1 })
afterAll(() => nowhere.end())

const office = (tenantId: string, actorId: string): FactoryScope => ({ audience: 'office', tenantId, actorId })

describe('the cache key', () => {
  it('holds every setting the migrations read, and nothing reads a setting by a computed name', () => {
    const keyed = new Set<string>(Object.values(SCOPE_DEFINITIONS).flatMap((definition) => Object.values<{ setting: string }>(definition.settings).map((entry) => entry.setting)))
    const read = new Map<string, number>()
    const problems: string[] = []
    for (const { folder, sql } of readMigrations(MIGRATIONS_DIR)) {
      for (const match of sql.matchAll(/current_setting\s*\(\s*([^,)]*)/gi)) {
        const literal = /^'([a-z_]+\.[a-z_]+)'(?:::text)?$/.exec(match[1]!.trim())
        if (!literal) {
          problems.push(`${folder}: current_setting(${match[1]!.trim()}…) is not a literal setting name`)
          continue
        }
        read.set(literal[1]!, (read.get(literal[1]!) ?? 0) + 1)
      }
      if (/\bpg_settings\b|\bshow\s+factory\./i.test(sql)) problems.push(`${folder}: reads a setting through pg_settings or SHOW`)
    }
    for (const setting of read.keys()) {
      if (!keyed.has(setting)) {
        problems.push(`the SQL reads ${setting}, which no scope sets: add it to SCOPE_DEFINITIONS (roles.ts), and with it to the client key`)
      }
    }
    expect(problems).toEqual([])
    // The walls are read; the actor is not (it is no setting any more).
    expect([...read.keys()].sort()).toEqual(['factory.party_id', 'factory.site_id', 'factory.tenant_id'])
  })

  it('is the role and its settings, never the actor', () => {
    const [tenant, other, site, otherSite, party, otherParty] = Array.from({ length: 6 }, () => randomUUID())
    expect(clientKey(office(tenant!, 'anna'))).toBe(clientKey(office(tenant!, 'bruno')))
    expect(clientKey({ audience: 'floor', tenantId: tenant!, siteId: site!, actorId: 'w1' })).toBe(clientKey({ audience: 'floor', tenantId: tenant!, siteId: site!, actorId: 'w2' }))
    expect(clientKey({ audience: 'partner', tenantId: tenant!, partyId: party!, actorId: 'u1' })).toBe(clientKey({ audience: 'partner', tenantId: tenant!, partyId: party!, actorId: 'link-9' }))
    const distinct = [
      clientKey(office(tenant!, 'anna')),
      clientKey(office(other!, 'anna')),
      clientKey({ audience: 'floor', tenantId: tenant!, siteId: site!, actorId: 'anna' }),
      clientKey({ audience: 'floor', tenantId: tenant!, siteId: otherSite!, actorId: 'anna' }),
      clientKey({ audience: 'partner', tenantId: tenant!, partyId: party!, actorId: 'anna' }),
      clientKey({ audience: 'partner', tenantId: tenant!, partyId: otherParty!, actorId: 'anna' }),
      clientKey({ audience: 'platform' }),
    ]
    expect(new Set(distinct).size).toBe(distinct.length)
    expect(distinct.join(' ')).not.toContain('anna')
  })

  it('still needs an actor wherever one acts, and refuses one on the platform scope', () => {
    expect(() => clientKey({ audience: 'office', tenantId: randomUUID() } as FactoryScope)).toThrow(/actorId/)
    expect(() => clientKey({ audience: 'floor', tenantId: randomUUID(), siteId: randomUUID(), actorId: '' })).toThrow(/actorId/)
    expect(() => clientKey({ audience: 'office', tenantId: randomUUID(), actorId: 7 } as unknown as FactoryScope)).toThrow(/actorId must be a string/)
    expect(() => clientKey({ audience: 'platform', actorId: 'x' } as unknown as FactoryScope)).toThrow(/Unknown scope key: actorId/)
  })
})

describe('what a client costs', () => {
  it('one more scope costs at most CLIENT_HEAP_BOUND_MB of heap', async () => {
    const clients = scopedClients(nowhere, 4)
    // The first client also loads what every client shares (modules, the runtime data model): measure the next two.
    await clients.withScope(office(randomUUID(), 'warm-up'), async () => 0)
    const before = heapMb()
    for (const actor of ['second', 'third']) await clients.withScope(office(randomUUID(), actor), async () => 0)
    const perClient = (heapMb() - before) / 2
    await clients.close()
    expect(perClient).toBeGreaterThan(1)
    expect(perClient).toBeLessThan(CLIENT_HEAP_BOUND_MB)
  }, 60_000)

  it('one more actor of a known tenant, site or party costs no client', async () => {
    const clients = scopedClients(nowhere, 4)
    const tenantId = randomUUID()
    const first = await clients.withScope(office(tenantId, 'actor-0'), async (client) => client)
    const before = heapMb()
    for (let i = 1; i <= 50; i++) expect(await clients.withScope(office(tenantId, `actor-${i}`), async (client) => client)).toBe(first)
    const grown = heapMb() - before
    await clients.close()
    expect(grown).toBeLessThan(5)
  }, 60_000)

  it('an evicted client gives its heap back: six tenants through two places hold two clients', async () => {
    const before = heapMb()
    const clients = scopedClients(nowhere, 2)
    for (let i = 0; i < 6; i++) await clients.withScope(office(randomUUID(), `tenant-${i}`), async () => 0)
    const held = heapMb() - before
    await clients.close()
    expect(held).toBeLessThan(2 * CLIENT_HEAP_BOUND_MB)
  }, 60_000)

  it('keeps sixteen clients by default', () => {
    expect(DEFAULT_CLIENT_CAPACITY).toBe(16)
  })
})
