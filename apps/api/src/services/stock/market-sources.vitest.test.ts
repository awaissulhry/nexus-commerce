/**
 * Step 2 "Sells from" — the business default per market: POST /api/stock/sync-control/market-sources
 * (`setMarketSources`, services/stock/sync-control-actions.service.ts).
 *
 * Proven on real SQL (PGlite with the production schema): the refusals (unknown channel or market, one Amazon EU market,
 * a code that is not an active warehouse of this business, twice, none); a dry run counts and writes nothing; Amazon EU
 * writes ONE list on all nine EU markets in one transaction, audited per market under POLICY, and the loader then
 * follows it (sum, sale order); a listing with its own list is counted as an exception and not re-pushed; eBay's market
 * is normalised; saving the same list again is a no-op; a pause and a resume of that market keep the list, and a
 * channel-wide pause still reaches it; [] removes the list (back to the routes).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

const stand = vi.hoisted(() => ({ recascaded: [] as string[][], announced: [] as Array<{ ids: string[]; fields: string[] }> }))

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property) }) }
})
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'disabled' }),
    resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
// The re-push runs in the background after a change; here it records which products (its own suites prove it).
vi.mock('../stock-movement.service.js', async (original) => ({
  ...(await original<object>()),
  recascadeAfterSyncControlChange: vi.fn(async (productIds: string[]) => { stand.recascaded.push([...productIds].sort()); return { ok: productIds.length, noLedger: 0, failed: 0, heldPricesSent: 0 } }),
}))
vi.mock('../listing-values-events.js', () => ({
  announceListingValues: vi.fn((ids: string[], fields: string[]) => { stand.announced.push({ ids: [...ids].sort(), fields }) }),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
const ids: Record<string, string> = {}
const EU = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'PL', 'SE', 'IE']
let app: FastifyInstance

async function save(body: Record<string, unknown>) {
  const { setMarketSources } = await import('./sync-control-actions.service.js')
  return inside(() => setMarketSources(body, 'person:test')) as Promise<{ status: number; body: any }>
}
const policyRows = (channel: string) => inside(() => db().syncChannelPolicy.findMany({ where: { channel }, orderBy: { marketplace: 'asc' } }))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const c = db()
    ids.main = (await c.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-MS-MAIN', name: 'Main', syncRoutes: [] } })).id
    ids.tpl = (await c.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-MS-3PL', name: 'Third party', syncRoutes: ['EBAY'] } })).id
    ids.off = (await c.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-MS-OFF', name: 'Closed', isActive: false } })).id
    ids.fbaLoc = (await c.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'TEST-MS-FBA', name: 'FBA' } })).id
    const product = async (key: string, sku: string) => { ids[key] = (await c.product.create({ data: { sku, name: sku, basePrice: '10.00' } })).id }
    const list = async (key: string, productKey: string, channel: string, market: string, data: Record<string, unknown> = {}) => {
      ids[key] = (await c.channelListing.create({ data: {
        productId: ids[productKey], channel, marketplace: market, region: market, channelMarket: `${channel}_${market}`,
        listingStatus: 'ACTIVE', isPublished: true, quantity: 4, followMasterQuantity: true, fulfillmentMethod: channel === 'AMAZON' ? 'FBM' : null, ...data,
      } as never })).id
    }
    await product('jacket', 'TEST-SKU-MS-JACKET')
    await c.stockLevel.create({ data: { productId: ids.jacket, locationId: ids.main, quantity: 4, reserved: 0, available: 4 } })
    await c.stockLevel.create({ data: { productId: ids.jacket, locationId: ids.tpl, quantity: 6, reserved: 0, available: 6 } })
    await list('jacketIt', 'jacket', 'AMAZON', 'IT')
    await list('jacketDe', 'jacket', 'AMAZON', 'DE')
    await list('jacketGb', 'jacket', 'AMAZON', 'GB')
    await list('jacketEbay', 'jacket', 'EBAY', 'EBAY_IT')
    await product('gloves', 'TEST-SKU-MS-GLOVES')
    await c.stockLevel.create({ data: { productId: ids.gloves, locationId: ids.main, quantity: 2, reserved: 0, available: 2 } })
    await list('glovesIt', 'gloves', 'AMAZON', 'IT', { sourceLocationCodes: ['TEST-MS-MAIN'] })
    await product('fba', 'TEST-SKU-MS-FBA')
    await list('fbaIt', 'fba', 'AMAZON', 'IT', { fulfillmentMethod: 'FBA', followMasterQuantity: false, quantityOverride: 7 })
    await list('endedDe', 'gloves', 'AMAZON', 'DE', { listingStatus: 'ENDED' })
  })
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    Object.assign(request, { authUser: { id: 'u-test', email: 'ms@example.test' } })
    withWorkspace(business, done)
  })
  await app.register((await import('@fastify/multipart')).default)
  await app.register((await import('../../routes/sync-control.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
}, 60_000)

beforeEach(() => {
  stand.recascaded = []
  stand.announced = []
})

describe('Step 2 — POST /api/stock/sync-control/market-sources', () => {
  it('refuses what cannot be a market list, and writes nothing', async () => {
    const post = async (payload: unknown) => {
      const response = await app.inject({ method: 'POST', url: '/api/stock/sync-control/market-sources', payload: payload as never })
      return { status: response.statusCode, body: response.json() }
    }
    expect(await post({ channel: 'NOPE', marketplace: 'IT', codes: [] })).toEqual({ status: 400, body: { error: "unknown channel 'NOPE'" } })
    expect((await post({ channel: 'AMAZON', marketplace: '*', codes: [] })).status).toBe(400)
    expect(await post({ channel: 'AMAZON', marketplace: 'IT', codes: ['TEST-MS-MAIN'] })).toMatchObject({ status: 400, body: { code: 'AMAZON_EU_GROUP', error: expect.stringContaining('Amazon EU markets share one choice') } })
    expect((await post({ channel: 'EBAY', marketplace: 'EU', codes: [] })).status).toBe(400)
    expect(await post({ channel: 'AMAZON', marketplace: 'GB' })).toMatchObject({ status: 400, body: { error: expect.stringContaining('codes[] required') } })
    expect(await post({ channel: 'AMAZON', marketplace: 'GB', codes: ['TEST-MS-FBA'] })).toMatchObject({ status: 400, body: { code: 'UNKNOWN_LOCATION', error: 'Not a warehouse of this business: TEST-MS-FBA.' } })
    expect(await post({ channel: 'AMAZON', marketplace: 'GB', codes: ['NOPE'] })).toMatchObject({ status: 400, body: { code: 'UNKNOWN_LOCATION' } })
    expect(await post({ channel: 'AMAZON', marketplace: 'GB', codes: ['TEST-MS-OFF'] })).toMatchObject({ status: 400, body: { code: 'INACTIVE_LOCATION', error: expect.stringContaining('Switched off: TEST-MS-OFF') } })
    expect(await post({ channel: 'AMAZON', marketplace: 'GB', codes: ['TEST-MS-MAIN', 'test-ms-main'] })).toMatchObject({ status: 400, body: { error: 'Named twice: test-ms-main.' } })
    expect(await post({ channel: 'AMAZON', marketplace: 'GB', codes: [''] })).toMatchObject({ status: 400, body: { error: 'A warehouse code is empty.' } })
    expect(await policyRows('AMAZON')).toEqual([])
    expect(stand.recascaded).toEqual([])
  })

  it('a dry run counts the listings that follow the market, and the products that keep their own list; nothing is written', async () => {
    const out = await save({ channel: 'AMAZON', marketplace: 'EU', codes: ['TEST-MS-3PL'], dryRun: true })
    // jacket IT + DE follow the market; gloves IT keeps its own list; the FBA and the ENDED listings do not count.
    expect(out).toEqual({ status: 200, body: {
      ok: true, dryRun: true, channel: 'AMAZON', marketplace: 'EU', markets: EU, codes: ['TEST-MS-3PL'],
      before: Object.fromEntries(EU.map((m) => [m, []])), listings: 2, products: 1, exceptions: 1,
    } })
    expect(await policyRows('AMAZON')).toEqual([])
    expect(stand.recascaded).toEqual([])
  })

  it('Amazon EU: one list on all nine markets, audited per market, re-pushed; the loader then sells from it in its order', async () => {
    const out = await save({ channel: 'AMAZON', marketplace: 'EU', codes: ['test-ms-3pl', 'TEST-MS-MAIN'] })
    expect(out).toMatchObject({ status: 200, body: { ok: true, marketplace: 'EU', codes: ['TEST-MS-3PL', 'TEST-MS-MAIN'], listings: 2, products: 1, exceptions: 1, recascadeQueued: 1 } })
    const rows = await policyRows('AMAZON')
    expect(rows.map((r) => r.marketplace).sort()).toEqual([...EU].sort())
    for (const row of rows) expect(row).toMatchObject({ channelConnectionId: null, pushesPaused: false, newListingDefaultMode: 'FOLLOW', sourceLocationCodes: ['TEST-MS-3PL', 'TEST-MS-MAIN'] })
    const audit = await inside(() => db().syncControlAudit.findMany({ where: { field: 'sourceLocationCodes' } }))
    expect(audit).toHaveLength(9)
    expect(audit[0]).toMatchObject({ actor: 'person:test', scopeType: 'POLICY', before: { sourceLocationCodes: [] }, after: { sourceLocationCodes: ['TEST-MS-3PL', 'TEST-MS-MAIN'] } })
    // Re-pushed: only the product whose listings follow the market (gloves keeps its own list).
    await vi.waitFor(() => expect(stand.recascaded).toEqual([[ids.jacket]]))
    expect(stand.announced[0]).toEqual({ ids: [ids.jacketDe, ids.jacketIt].sort(), fields: ['stockSource', 'quantity'] })

    const { loadSyncLedgers, ledgerInputs } = await import('../stock-pool/sync-ledgers.js')
    const { resolveIntendedQuantity, sellsFrom } = await import('../sync-control-core.js')
    const ledgers = await inside(() => loadSyncLedgers(db() as never, [ids.jacket, ids.gloves]))
    const jacket = ledgers.get(ids.jacket)!
    expect(sellsFrom({ ledger: jacket.ledger, channel: 'AMAZON', marketplace: 'DE', sourceLocationCodes: [] })).toMatchObject({ origin: 'market', codes: ['TEST-MS-3PL', 'TEST-MS-MAIN'] })
    // TEST-MS-3PL routes only to eBay, and the market's list still sells from it: the list replaces the routes.
    const follow = (productLedger: typeof jacket, marketplace: string, own: string[] = []) => resolveIntendedQuantity({
      channel: 'AMAZON', marketplace, isFba: false, followMasterQuantity: true, syncPaused: false, pinnedQuantity: null, stockBuffer: 1, channelPolicy: null,
      ...ledgerInputs(productLedger, own),
    })
    expect(follow(jacket, 'IT')).toEqual({ kind: 'FOLLOW', quantity: 9, routedAvailable: 10, routedLocations: ['TEST-MS-3PL', 'TEST-MS-MAIN'] })
    // Amazon GB is not in the EU group: no list there, the routes decide (TEST-MS-3PL does not route to Amazon).
    expect(follow(jacket, 'GB')).toMatchObject({ quantity: 3, routedLocations: ['TEST-MS-MAIN'] })
    // A listing's own list beats the market's.
    expect(follow(ledgers.get(ids.gloves)!, 'IT', ['TEST-MS-MAIN'])).toMatchObject({ quantity: 1, routedLocations: ['TEST-MS-MAIN'] })
  })

  it('saving the same list again changes nothing', async () => {
    expect(await save({ channel: 'AMAZON', marketplace: 'EU', codes: ['TEST-MS-3PL', 'TEST-MS-MAIN'] })).toMatchObject({ status: 200, body: { noop: true, recascadeQueued: 0 } })
    expect(stand.recascaded).toEqual([])
  })

  it('a pause and a resume of the market keep its list; a list-only row never hides a channel-wide pause', async () => {
    const { setSyncPolicy } = await import('./sync-control-actions.service.js')
    const { loadChannelPolicies, policyFor } = await import('../sync-control-policy.service.js')
    expect((await inside(() => setSyncPolicy({ channel: 'AMAZON', marketplace: 'IT', pushesPaused: true }, 'person:test'))).status).toBe(200)
    expect((await inside(() => setSyncPolicy({ channel: 'AMAZON', marketplace: 'IT', pushesPaused: false }, 'person:test'))).status).toBe(200)
    const it = (await policyRows('AMAZON')).find((r) => r.marketplace === 'IT')!
    expect(it).toMatchObject({ pushesPaused: false, sourceLocationCodes: ['TEST-MS-3PL', 'TEST-MS-MAIN'] })
    expect(await inside(() => setSyncPolicy({ channel: 'AMAZON', marketplace: '*', pushesPaused: true }, 'person:test'))).toMatchObject({ status: 200 })
    const policies = await inside(() => loadChannelPolicies())
    expect(policyFor(policies, 'AMAZON', 'IT')).toMatchObject({ pushesPaused: true })
    await inside(() => setSyncPolicy({ channel: 'AMAZON', marketplace: '*', pushesPaused: false }, 'person:test'))
  })

  it('eBay: the market is normalised (EBAY_IT is IT) and the shared lane is re-pushed with the listings', async () => {
    const out = await save({ channel: 'EBAY', marketplace: 'EBAY_IT', codes: ['TEST-MS-3PL'] })
    expect(out).toMatchObject({ status: 200, body: { marketplace: 'IT', markets: ['IT'], listings: 1, products: 1, exceptions: 0, recascadeQueued: 1 } })
    expect((await policyRows('EBAY')).map((r) => [r.marketplace, r.sourceLocationCodes])).toEqual([['IT', ['TEST-MS-3PL']]])
  })

  it('[] removes the list: the row goes when it held nothing else, and the routes decide again', async () => {
    expect(await save({ channel: 'AMAZON', marketplace: 'EU', codes: [] })).toMatchObject({ status: 200, body: { codes: [], recascadeQueued: 1 } })
    expect(await policyRows('AMAZON')).toEqual([])
    const audit = await inside(() => db().syncControlAudit.findMany({ where: { field: 'sourceLocationCodes', after: { equals: { sourceLocationCodes: [] } } } }))
    expect(audit).toHaveLength(9)
  })
})
