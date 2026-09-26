/**
 * CX review 2026-09-26 — the master-price cascade's currency refusal, in real PostgreSQL (the cascade is one
 * transaction: product, listings, queue rows and audit commit or roll back together).
 *
 * A GBP market is not sent the EUR master number: its price stays, its snapshot moves, no queue row, the audit
 * names it, and one MASTER_PRICE_CURRENCY_REFUSED conflict lands once the service's own transaction committed.
 * Inside a caller's transaction the refusal rolls back with everything else.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

let database: Awaited<ReturnType<typeof import('../test-support/concurrent-database.js').concurrentDatabase>>
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => (database.client as any)[key] }) }))
vi.mock('../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn(async () => null) }))
vi.mock('./sync-health.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./sync-health.service.js')>()
  return { ...real, syncHealthService: { logConflict: (input: any) => new real.SyncHealthService(database.client).logConflict(input) } }
})

const { concurrentDatabase, concurrentDatabaseUrl, CONCURRENT_PG_ENV } = await import('../test-support/concurrent-database.js')
const { LEGACY_WORKSPACE_ID, withWorkspace } = await import('../lib/workspace-context.js')
const { MasterPriceService } = await import('./master-price.service.js')

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)

async function seed() {
  const id = randomUUID()
  const client = database.client as any
  await client.product.create({ data: { id, sku: `SKU-${id.slice(0, 8)}`, name: 'Currency refusal fixture', basePrice: 10 } })
  const it = await client.channelListing.create({ data: { productId: id, channel: 'EBAY', channelMarket: 'EBAY_IT', marketplace: 'IT', region: 'IT', price: 10, masterPrice: 10, followMasterPrice: true } })
  const uk = await client.channelListing.create({ data: { productId: id, channel: 'EBAY', channelMarket: 'EBAY_GB', marketplace: 'UK', region: 'GB', price: 9, masterPrice: 10, followMasterPrice: true } })
  return { id, it: it.id as string, uk: uk.id as string }
}
const listing = async (id: string) => (await database.pool.query(`SELECT price::text, "masterPrice"::text FROM "ChannelListing" WHERE id = $1`, [id])).rows[0]
const queueRows = async (productId: string) => (await database.pool.query(`SELECT "channelListingId", payload->>'price' AS price FROM "OutboundSyncQueue" WHERE "productId" = $1`, [productId])).rows
const conflicts = async (productId: string) => (await database.pool.query(
  `SELECT "workspaceId", "conflictData"->'remote'->>'listingId' AS listing, "conflictData"->'remote'->>'marketCurrency' AS currency FROM "SyncHealthLog" WHERE "productId" = $1 AND "conflictType" = 'MASTER_PRICE_CURRENCY_REFUSED'`, [productId])).rows
const audits = async (productId: string) => (await database.pool.query(`SELECT metadata->'currencyRefusedListingIds' AS refused FROM "AuditLog" WHERE "entityId" = $1`, [productId])).rows

describe.skipIf(!concurrentDatabaseUrl())(`master-price currency refusal in real PostgreSQL (needs ${CONCURRENT_PG_ENV})`, () => {
  beforeAll(async () => {
    database = await concurrentDatabase({ maxConnections: 4 })
    await scoped(async () => {
      await (database.client as any).marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
      await (database.client as any).marketplace.create({ data: { channel: 'EBAY', code: 'UK', name: 'United Kingdom', currency: 'GBP', region: 'EU', language: 'en', languages: ['en'] } })
    })
  }, 180_000)
  afterAll(async () => { await database?.close() }, 60_000)

  it('its own transaction: the EUR listing cascades and queues; the GBP listing is refused, snapshot only, audited and recorded once', () => scoped(async () => {
    const s = await seed()
    const result = await new MasterPriceService(database.client as any).update(s.id, 19.9)
    expect(result.currencyRefused).toEqual([{ listingId: s.uk, channel: 'EBAY', marketplace: 'UK', currency: 'GBP', masterCurrency: 'EUR' }])
    expect(await listing(s.it)).toEqual({ price: '19.90', masterPrice: '19.90' })
    expect(await listing(s.uk)).toEqual({ price: '9.00', masterPrice: '19.90' })
    expect(await queueRows(s.id)).toEqual([{ channelListingId: s.it, price: '19.9' }])
    expect(await audits(s.id)).toEqual([{ refused: [s.uk] }])
    expect(await conflicts(s.id)).toEqual([{ workspaceId: LEGACY_WORKSPACE_ID, listing: s.uk, currency: 'GBP' }])
  }), 60_000)

  it('inside a caller\'s transaction that rolls back: nothing lands — no price, no queue row, no audit, no conflict', () => scoped(async () => {
    const s = await seed()
    const client = database.client as any
    await expect(client.$transaction(async (tx: any) => {
      const result = await new MasterPriceService(client).update(s.id, 25, { tx })
      expect(result.currencyRefused.map((r: { listingId: string }) => r.listingId)).toEqual([s.uk])
      throw new Error('caller rolls back')
    })).rejects.toThrow('caller rolls back')
    expect(await listing(s.it)).toEqual({ price: '10.00', masterPrice: '10.00' })
    expect(await listing(s.uk)).toEqual({ price: '9.00', masterPrice: '10.00' })
    expect(await queueRows(s.id)).toEqual([])
    expect(await audits(s.id)).toEqual([])
    expect(await conflicts(s.id)).toEqual([])
  }), 60_000)

  it('inside a caller\'s transaction that commits: the refusal is in the committed audit row; no conflict is written outside it', () => scoped(async () => {
    const s = await seed()
    const client = database.client as any
    await client.$transaction(async (tx: any) => { await new MasterPriceService(client).update(s.id, 30, { tx }) })
    expect(await listing(s.uk)).toEqual({ price: '9.00', masterPrice: '30.00' })
    expect(await queueRows(s.id)).toEqual([{ channelListingId: s.it, price: '30' }])
    expect(await audits(s.id)).toEqual([{ refused: [s.uk] }])
    expect(await conflicts(s.id)).toEqual([])
  }), 60_000)
})
