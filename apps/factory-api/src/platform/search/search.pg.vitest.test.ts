import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { seedUuid, type SeedContext } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor, type CommandCaller } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import type { Log } from '../../core/queue'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { systemContext } from '../outbox/system'
import type { SearchIndexer } from './indexer'
import { INDEX_HANDLER, indexEvent, indexNewTenants, REBUILD_HANDLER, rebuildIndex, searchHandlers } from './indexing'
import { loadIndexers } from './registry'

/**
 * Global search (B-W2a-32; PLT-153) on a throwaway PostgreSQL 17 database from the migrations, with the base seeds (made-
 * up records of every W1 module): the indexers read the records into SearchEntry in the tenant's system scope, the
 * route finds them as the reader (row-level security and the reader's grants), events keep them current, a replay and a
 * second rebuild write nothing new. Run with `node scripts/factory/run-pg-tests.mjs platform/search`.
 */

const NAMESPACE = 'search'
const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed/', import.meta.url))
const id = (key: string): string => seedUuid(NAMESPACE, key)
const tenantId = id('tenant')
const companyA = id('company:A')
const companyB = id('company:B')
const siteA1 = id('site:A1')
const otherTenant = newId()
const ownerId = id('actor')

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let indexers: readonly SearchIndexer[]
let system: CommandCaller

const quiet: Log = { info: () => {}, warn: () => {}, error: () => {} }
const grant = (permissions: readonly Permission[], scope: Partial<Pick<Grant, 'companies' | 'sites' | 'parties'>> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (actorId: string, grants: Grant[], tenant = tenantId): SessionContext => ({ audience: 'office', tenantId: tenant, actorId, companyId: companyA, grants })
const EVERY_VIEW: Permission[] = ['parties.view', 'quotes.view', 'orders.view', 'product.styles.view', 'product.materials.view', 'purchasing.view', 'workorders.view', 'inventory.stock.view', 'shipping.view', 'invoices.view', 'search.rebuild']
const SESSIONS: Record<string, SessionContext> = {
  owner: office(ownerId, [grant(EVERY_VIEW)]),
  // Sales over company B only: company A's orders and quotes are not theirs; customers without a company are.
  salesB: office(newId(), [grant(['orders.view', 'quotes.view', 'parties.view'], { companies: [companyB] })]),
  // The warehouse of plant A1 only.
  warehouseA1: office(newId(), [grant(['inventory.stock.view'], { sites: [siteA1] })]),
  // One customer only (a grant limited to party P1).
  partyP1: office(newId(), [grant(['orders.view', 'parties.view'], { parties: [id('party:P1')] })]),
  nobody: office(newId(), []),
  // B-W2b-36: a session with no company chosen (no default company, no company asked).
  noCompany: { audience: 'office', tenantId, actorId: newId(), grants: [grant(EVERY_VIEW)] },
  other: office(newId(), [grant(EVERY_VIEW)], otherTenant),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function search(session: string, query: string): Promise<Json> {
  const response = await call(session, 'GET', `/search?${query}`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const entry = async (recordType: string, recordId: string): Promise<Json> => (await admin('SELECT * FROM "SearchEntry" WHERE "recordType" = $1 AND "recordId" = $2', [recordType, recordId]))[0]!
const entryCount = async () => Number((await admin<{ n: string }>('SELECT count(*) AS n FROM "SearchEntry" WHERE "tenantId" = $1', [tenantId]))[0]!.n)

function envelope(type: string, subject: string, payload: unknown = {}): EventEnvelope {
  return { eventId: newId(), type, version: 1, context: 'test', tenantId, companyId: null, siteId: null, subject, correlationId: `search-test-${newId()}`, causationId: null, source: 'test', occurredAt: new Date().toISOString(), payload }
}

beforeAll(async () => {
  db = await migratedDatabase('platform_search')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  const context: SeedContext = { db: database, namespace: NAMESPACE }
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(`${SEED_DIR}${file}`).href)) as { seed: (context: SeedContext) => Promise<unknown> }
    await module.seed(context)
  }
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [otherTenant, 'search-other'])
  // The search seed's sample entries are not the indexers': start from an empty index, as a database before search.
  await admin('DELETE FROM "SearchEntry"')
  indexers = await loadIndexers(fileURLToPath(new URL('../..', import.meta.url)))
  system = callerFor(database, systemContext(tenantId, 'search-pg-test'))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('the index (worker side)', () => {
  it('loads one indexer per record type from the folder, each following declared events', () => {
    expect(indexers.map((indexer) => indexer.recordType).sort()).toEqual([
      ...['Complaint', 'GoodsReceipt', 'Hide', 'Invoice', 'Item', 'Lot', 'Party', 'PurchaseOrder', 'Quote', 'RepairOrder', 'ReturnAuthorisation', 'SalesOrder', 'Shipment', 'Style', 'SupplierClaim', 'WorkOrder'],
      // B-W2b-23: every other W1 and W2a record type (indexers/every-record.pg.vitest.test.ts).
      ...['Certificate', 'Ddt', 'Inspection', 'LabelTemplate', 'Location', 'Machine', 'MaintenanceJob', 'Nonconformance', 'Operation', 'Payment', 'PpeRegisterEntry', 'QualityHold', 'SizeScale', 'StockCount', 'SubcontractOrder', 'SupplierInvoice'],
    ].sort())
    const handlers = searchHandlers(indexers)
    expect(handlers.map((handler) => handler.name)).toEqual([INDEX_HANDLER, REBUILD_HANDLER])
    expect(handlers[0]!.events).toEqual(expect.arrayContaining(['sales_order.created', 'party.updated', 'inventory.receipt_posted']))
    expect(handlers[1]!.events).toEqual(['search.rebuild_requested'])
  })

  it('the worker builds a tenant index never built at start; a tenant that has one is left as it is', async () => {
    // The search seed's sample entries do not count as a built index.
    await admin(`INSERT INTO "SearchEntry" (id, "tenantId", "recordType", "recordId", number, title, area, "viewPermission", "searchText", "indexedAt") VALUES ($1, $2, 'Party', $3, 'SEED-C1', 'Sample', 'sales', 'parties.view', 'seed-c1 sample', now())`, [newId(), tenantId, id('party:P1')])
    const first = await indexNewTenants({ database, indexers, log: quiet })
    expect(first).toMatchObject({ indexed: 1, failed: 0 })
    const built = await entryCount()
    expect(built).toBeGreaterThan(10)
    const types = await admin<{ recordType: string }>('SELECT DISTINCT "recordType" FROM "SearchEntry" WHERE "tenantId" = $1 ORDER BY 1', [tenantId])
    expect(types.map((row) => row.recordType)).toEqual(expect.arrayContaining(['Party', 'SalesOrder', 'Style', 'Item', 'WorkOrder', 'Lot', 'Hide']))
    expect(await indexNewTenants({ database, indexers, log: quiet })).toMatchObject({ indexed: 0, failed: 0 })
    expect(await entryCount()).toBe(built)
  })

  it('an entry holds the record as people type it, never money', async () => {
    const order = await entry('SalesOrder', id('sales:SO1'))
    // The customer as records show it: the trade name, the legal name among the words.
    expect(order).toMatchObject({ number: 'SEED-SO-0001', title: 'Seed Racing', area: 'sales', viewPermission: 'orders.view', companyId: companyA, partyId: id('party:P1'), siteId: null })
    expect(order.searchText).toMatch(/^seed-so-0001 seed racing .*seed-c1 .*customer one/)
    for (const row of await admin<{ id: string; netAmount: number; grossAmount: number; vatAmount: number }>('SELECT id, "netAmount", "grossAmount", "vatAmount" FROM "SalesOrder"')) {
      const text = (await entry('SalesOrder', row.id))?.searchText as string
      for (const amount of [row.netAmount, row.grossAmount, row.vatAmount].filter((value) => value > 0)) {
        expect(text.split(' ')).not.toContain(String(amount))
        expect(text).not.toContain((amount / 100).toFixed(2))
      }
    }
    const party = await entry('Party', id('party:P1'))
    expect(party).toMatchObject({ number: 'SEED-C1', title: 'Seed Racing', subtitle: 'Seed Customer One S.r.l.', partyId: id('party:P1'), area: 'sales' })
    const supplier = await entry('Party', id('party:P2'))
    expect(supplier.area).toBe('purchasing')
  })

  it('a second rebuild writes nothing new; a gone record loses its entry', async () => {
    const before = await admin<{ id: string; indexedAt: Date }>('SELECT id, "indexedAt" FROM "SearchEntry" ORDER BY id')
    const again = await rebuildIndex(system, indexers, { recordTypes: null, key: `search-rebuild-${newId()}` })
    expect(again).toMatchObject({ written: 0, removed: 0 })
    expect(again.unchanged).toBe(before.length)
    expect(await admin('SELECT id, "indexedAt" FROM "SearchEntry" ORDER BY id')).toEqual(before)

    const ghost = newId()
    await admin(`INSERT INTO "SearchEntry" (id, "tenantId", "recordType", "recordId", number, title, area, "viewPermission", "searchText", "indexedAt") VALUES ($1, $2, 'SalesOrder', $3, 'GHOST-1', 'Gone', 'sales', 'orders.view', 'ghost-1 gone', now())`, [newId(), tenantId, ghost])
    const swept = await rebuildIndex(system, indexers, { recordTypes: ['SalesOrder'], key: `search-rebuild-${newId()}` })
    expect(swept).toMatchObject({ written: 0, removed: 1, recordTypes: ['SalesOrder'] })
    expect(await entry('SalesOrder', ghost)).toBeUndefined()
  })

  it('an event re-indexes its record and the records that show its name; a replayed event writes nothing', async () => {
    const partyId = id('party:P1')
    await admin('UPDATE "Party" SET "legalName" = $2 WHERE id = $1', [partyId, 'Seed Società Pista Racing S.r.l.'])
    const event = envelope('party.updated', partyId, { partyId })
    const done = await indexEvent(system, indexers, event)
    expect(done.replayed).toBe(false)
    expect(done.written).toBeGreaterThanOrEqual(2)
    expect((await entry('Party', partyId)).subtitle).toBe('Seed Società Pista Racing S.r.l.')
    expect((await entry('Party', partyId)).searchText).toContain('societa pista')
    expect((await entry('SalesOrder', id('sales:SO1'))).searchText).toContain('pista')
    const audit = await admin('SELECT action, "recordType", after FROM "AuditLog" WHERE "recordId" = $1', [event.eventId])
    expect(audit).toEqual([expect.objectContaining({ action: 'search.index', recordType: 'OutboxEvent' })])
    expect(JSON.stringify(audit[0]!.after)).not.toMatch(/pista/i)
    const count = await entryCount()
    expect(await indexEvent(system, indexers, event)).toMatchObject({ replayed: true })
    expect(await entryCount()).toBe(count)
    // An event no indexer follows does nothing (no command, no audit row).
    expect(await indexEvent(system, indexers, envelope('calendar.changed', partyId))).toMatchObject({ written: 0, replayed: false })
  })

  it('two events that index the same new record at once write one entry, without an error (an upsert: no retry, B-W2a-32)', async () => {
    const parties = indexers.find((indexer) => indexer.recordType === 'Party')!
    const partyId = id('party:P2')
    // A record without an entry yet: what two events of a record made a moment ago both find.
    await admin('DELETE FROM "SearchEntry" WHERE "recordType" = $1 AND "recordId" = $2', ['Party', partyId])
    // Both commands read the record, then wait for each other: neither has written when the other reads the index.
    let arrived = 0
    let together!: () => void
    const both = new Promise<void>((resolve) => (together = resolve))
    const gated: SearchIndexer = {
      ...parties,
      async read(tx, filter, take) {
        const documents = await parties.read(tx, filter, take)
        if (++arrived === 2) together()
        await both
        return documents
      },
    }
    const [one, two] = await Promise.all([indexEvent(system, [gated], envelope('party.updated', partyId, { partyId })), indexEvent(system, [gated], envelope('party.updated', partyId, { partyId }))])
    expect([one.written + two.written, one.unchanged + two.unchanged]).toEqual([1, 1])
    const rows = await admin<{ title: string }>('SELECT title FROM "SearchEntry" WHERE "recordType" = $1 AND "recordId" = $2', ['Party', partyId])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.title).toEqual(expect.any(String))
  })

  it('an event naming a record that is gone removes its entry', async () => {
    const ghost = newId()
    await admin(`INSERT INTO "SearchEntry" (id, "tenantId", "recordType", "recordId", number, title, area, "viewPermission", "searchText", "indexedAt") VALUES ($1, $2, 'Invoice', $3, NULL, 'Draft', 'finance', 'invoices.view', 'draft', now())`, [newId(), tenantId, ghost])
    expect(await indexEvent(system, indexers, envelope('invoice.draft_deleted', ghost))).toMatchObject({ removed: 1 })
    expect(await entry('Invoice', ghost)).toBeUndefined()
  })
})

describe('GET /search (the reader side)', () => {
  it('finds a record by its number typed whole first, then by every word, then by a similar word', async () => {
    const exact = await search('owner', 'q=seed-so-0001')
    expect(exact.results[0]).toMatchObject({ recordType: 'SalesOrder', recordId: id('sales:SO1'), number: 'SEED-SO-0001', match: 'number', companyId: companyA })
    expect(exact.results[0]).not.toHaveProperty('searchText')
    const named = await search('owner', 'q=Pista%20Racing')
    expect(named.results.map((row: Json) => row.recordType)).toEqual(expect.arrayContaining(['Party', 'SalesOrder']))
    expect(named.results[0].match).toBe('words')
    expect(named.words).toEqual(['pista', 'racing'])
    const typo = await search('owner', 'q=pisra%20racin')
    expect(typo.results.map((row: Json) => row.recordId)).toContain(id('party:P1'))
    expect(typo.results.find((row: Json) => row.recordId === id('party:P1')).match).toBe('similar')
    const accents = await search('owner', `q=${encodeURIComponent('SOCIETÀ')}`)
    expect(accents.results.map((row: Json) => row.recordId)).toContain(id('party:P1'))
    expect(accents.asOf).toEqual(expect.any(String))
  })

  it('answers a session with no company chosen too, with or without a type (B-W2b-36: never a 500)', async () => {
    const all = await search('noCompany', 'q=seed-so-0001')
    expect(all.results[0]).toMatchObject({ recordType: 'SalesOrder', recordId: id('sales:SO1'), match: 'number' })
    const typed = await search('noCompany', 'q=seed&type=SalesOrder&limit=100')
    expect(typed.results.length).toBeGreaterThan(0)
    expect(typed.results.every((row: Json) => row.recordType === 'SalesOrder')).toBe(true)
  })

  it('counts per record type, filters by one type and pages', async () => {
    const all = await search('owner', 'q=seed&limit=5')
    expect(all.results).toHaveLength(5)
    expect(all.total).toBeGreaterThan(5)
    expect(all.nextOffset).toBe(5)
    expect(all.counts.reduce((sum: number, row: Json) => sum + row.count, 0)).toBe(all.total)
    const orders = await search('owner', 'q=seed&type=SalesOrder&limit=100')
    expect(orders.results.every((row: Json) => row.recordType === 'SalesOrder')).toBe(true)
    expect(orders.total).toBe(all.counts.find((row: Json) => row.recordType === 'SalesOrder').count)
    expect(orders.counts).toEqual(all.counts)
    const next = await search('owner', 'q=seed&limit=5&offset=5')
    expect(next.results[0].recordId).not.toBe(all.results[0].recordId)
  })

  it('shows only what the reader may open: their view permissions over their companies, sites and parties', async () => {
    const salesB = await search('salesB', 'q=seed&limit=100')
    expect(salesB.results.every((row: Json) => ['SalesOrder', 'Quote', 'Party'].includes(row.recordType))).toBe(true)
    expect(salesB.results.filter((row: Json) => row.recordType !== 'Party').every((row: Json) => row.companyId === companyB)).toBe(true)
    expect(salesB.results.map((row: Json) => row.recordId)).not.toContain(id('sales:SO1'))
    const warehouse = await search('warehouseA1', 'q=seed&limit=100')
    expect(warehouse.results.length).toBeGreaterThan(0)
    expect(warehouse.results.every((row: Json) => ['Lot', 'Hide', 'GoodsReceipt'].includes(row.recordType) && (row.siteId === siteA1 || row.siteId === null))).toBe(true)
    const p1 = await search('partyP1', 'q=seed&limit=100')
    expect(p1.results.length).toBeGreaterThan(0)
    expect(p1.results.every((row: Json) => row.recordId === id('party:P1') || row.recordType === 'SalesOrder')).toBe(true)
    expect((await search('nobody', 'q=seed')).results).toEqual([])
    const other = await search('other', 'q=seed')
    expect(other).toMatchObject({ results: [], total: 0, asOf: null })
  })

  it('a query under two characters finds nothing; a query that matches nothing is empty', async () => {
    expect(await search('owner', 'q=s')).toMatchObject({ tooShort: true, results: [], total: 0 })
    expect(await search('owner', 'q=zzzzqqqq')).toMatchObject({ tooShort: false, results: [], total: 0, nextOffset: null })
    expect((await call('owner', 'GET', '/search?q=seed&limit=500')).statusCode).toBe(400)
  })
})

describe('POST /search/rebuild', () => {
  it('asks the worker for a rebuild (search.rebuild): one audit row and the event; a repeated key asks nothing again', async () => {
    const response = await call('owner', 'POST', '/search/rebuild', { recordTypes: ['SalesOrder', 'Party'] }, 'search-rebuild-ask-0001')
    expect(response.statusCode, response.body).toBe(202)
    expect(response.json()).toEqual({ requested: true, recordTypes: ['Party', 'SalesOrder'] })
    expect((await call('owner', 'POST', '/search/rebuild', { recordTypes: ['SalesOrder', 'Party'] }, 'search-rebuild-ask-0001')).statusCode).toBe(202)
    const events = await admin<{ type: string; payload: Json }>(`SELECT type, payload FROM "OutboxEvent" WHERE type = 'search.rebuild_requested'`)
    expect(events).toEqual([{ type: 'search.rebuild_requested', payload: { recordTypes: ['Party', 'SalesOrder'], requestedById: ownerId } }])
    // The worker's handler runs the rebuild: nothing changed since the last one.
    const handler = searchHandlers(indexers).find((entry) => entry.name === REBUILD_HANDLER)!
    const before = await entryCount()
    await handler.handle({ ...envelope('search.rebuild_requested', tenantId, events[0]!.payload) }, { caller: system, attempt: 1 })
    expect(await entryCount()).toBe(before)
  })

  it('is refused without search.rebuild, and to a floor or another audience', async () => {
    expect((await call('salesB', 'POST', '/search/rebuild', {})).statusCode).toBe(403)
    expect((await call('nobody', 'POST', '/search/rebuild', {})).statusCode).toBe(403)
    expect((await call('owner', 'POST', '/search/rebuild', { recordTypes: ['not a type'] })).statusCode).toBe(400)
  })
})
