/**
 * MCP full control 08 S7 — Sync Control for Claude: bulk-listing-stock and set-stock-policy, through the doors a person
 * uses (runOrQueueTool, then the Approvals page's schedule and commit), on the page's own code
 * (services/stock/sync-control-actions.service.ts, moved out of the route; the route answers through it).
 *
 * Proven: the route still answers (its own refusals, and a pause through the service); a pause previewed, run and undone;
 * Amazon EU is ONE quantity — a pin on IT covers DE and FR, shown as one EU line, and its undo follows again; an FBA
 * listing is refused by name and left out of a product, its quantity untouched; a fixed number on a SKU that sells from
 * shared stock is refused; a zero & pin on eBay is refused while the account's out-of-stock option is OFF (the Matrix's
 * own check, read once per account and market) and runs when it is ON; a shared eBay variant excluded and included
 * again; a channel policy paused and put back; a location's feeds changed and put back; an FBA location refused.
 *
 * Real SQL (PGlite with the production schema); eBay's out-of-stock option and the shared-stock predicate are stood in.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { EBAY_ZERO_REFUSAL } from '@nexus/shared/matrix-preview'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

const stand = vi.hoisted(() => ({ outOfStock: 'OFF' as 'ON' | 'OFF' | 'UNKNOWN', asked: [] as Array<[string, string]>, pooled: new Set<string>() }))

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
vi.mock('../outbound-enqueue.js', async (original) => ({ ...(await original<object>()), fireOutboundJobs: vi.fn(async () => undefined) }))
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: vi.fn(), emitMany: vi.fn(), emitManyTx: vi.fn() } }))
// The recascade runs in the background after a change; here it is a no-op (its own suites prove it).
vi.mock('../stock-movement.service.js', async (original) => ({ ...(await original<object>()), recascadeAfterSyncControlChange: vi.fn(async () => ({})) }))
// eBay's out-of-stock option is read from eBay; here it is what the test says.
vi.mock('../channel-delist.service.js', async (original) => ({
  ...(await original<object>()),
  readEbayOutOfStockPreference: vi.fn(async (accountId: string, market: string) => { stand.asked.push([accountId, market]); return stand.outOfStock }),
}))
// Which products sell from another business's shared stock (the doors' predicate needs a second business and a grant).
vi.mock('../stock-pool/pool-guard.js', async (original) => ({
  ...(await original<object>()),
  pooledNow: vi.fn(async (_db: unknown, ids: string[]) => new Set(ids.filter((id) => stand.pooled.has(id)))),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
type Json = any
const ids: Record<string, string> = {}
let app: FastifyInstance
const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
const person = () => ({ kind: 'user' as const, userId: ids.approver, label: 'S7 Approver', permissions: { isOwner: false, permissions: EVERYTHING }, workspace: business, via: 'claude' as const })
const db = () => database.client

async function preview(tool: string, args: Record<string, unknown>) {
  const { callTool } = await import('../agents/call-tool.js')
  return (await inside(() => callTool(person(), tool, args))).raw as Json
}
async function ask(tool: string, args: Record<string, unknown>) {
  const { runOrQueueTool } = await import('../agents/approval-gate.service.js')
  const run = await inside(() => db().agentRun.create({ data: { agentKey: 'claude', trigger: 'manual', status: 'running', userId: ids.approver, via: 'claude' } }))
  return inside(() => runOrQueueTool(tool, args, person(), run.id, { forceAsk: true })) as Promise<Json>
}
async function approveAndRun(approvalId: string) {
  const { commitScheduledApproval, scheduleApproval } = await import('../agent-fleet/approval-inbox.service.js')
  const parked = await inside(() => scheduleApproval({ id: approvalId, actor: person() as never }))
  expect(parked, (parked as Json).error).toMatchObject({ ok: true, status: 'scheduled' })
  await inside(() => db().agentApproval.update({ where: { id: approvalId }, data: { executeAfter: new Date(Date.now() - 1000) } }))
  return inside(() => commitScheduledApproval(approvalId)) as Promise<Json>
}
async function askAndRun(tool: string, args: Record<string, unknown>) {
  const queued = await ask(tool, args)
  expect(queued, queued.error).toMatchObject({ ok: true, mode: 'queued' })
  const ran = await approveAndRun(queued.approvalId)
  expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
  return { approvalId: queued.approvalId as string, preview: queued.preview as Json }
}
async function undo(approvalId: string) {
  const change = await inside(() => db().agentChange.findFirstOrThrow({ where: { approvalId } }))
  const asked = await ask('undo-change', { changeId: change.id })
  expect(asked, asked.error).toMatchObject({ ok: true, mode: 'queued' })
  const ran = await approveAndRun(asked.approvalId)
  expect(ran, ran.error).toMatchObject({ ok: true, status: 'executed' })
  return asked
}
const listing = (id: string) => inside(() => db().channelListing.findUniqueOrThrow({ where: { id } }))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const c = db()
    ids.approver = (await c.userProfile.create({ data: { email: 's7-approver@example.test', status: 'active', displayName: 'S7 Approver' } })).id
    // The approver holds every permission in this business (the gate re-reads them when the approval runs).
    const role = await c.role.create({ data: { key: 'S7_APPROVER', name: 'S7 approver', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
    await c.userRole.create({ data: { userId: ids.approver, roleId: role.id } })
    const membership = await c.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: ids.approver, status: 'active' } })
    await c.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
    for (const [channel, code] of [['AMAZON', 'IT'], ['AMAZON', 'DE'], ['AMAZON', 'FR'], ['EBAY', 'IT']]) {
      await c.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } as never })
    }
    ids.amazon = (await c.channelConnection.create({ data: { channelType: 'AMAZON', isActive: true, accountLabel: 'Test Amazon' } })).id
    ids.ebay = (await c.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, accountLabel: 'Test eBay' } })).id
    ids.main = (await c.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-S7-MAIN', name: 'Main warehouse', syncRoutes: [] } })).id
    ids.fbaLocation = (await c.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'TEST-S7-FBA', name: 'Amazon FBA' } })).id
    const product = async (key: string, sku: string, data: Json = {}) => { ids[key] = (await c.product.create({ data: { sku, name: sku, basePrice: '10.00', ...data } })).id }
    const list = async (key: string, productKey: string, channel: string, market: string, data: Json = {}) => {
      ids[key] = (await c.channelListing.create({ data: {
        productId: ids[productKey], channel, marketplace: market, region: market, channelMarket: `${channel}_${market}`,
        channelConnectionId: channel === 'AMAZON' ? ids.amazon : ids.ebay, listingStatus: 'ACTIVE', isPublished: true,
        quantity: 4, followMasterQuantity: true, fulfillmentMethod: channel === 'AMAZON' ? 'FBM' : null, ...data,
      } as never })).id
    }
    await product('jacket', 'TEST-SKU-S7-JACKET', { totalStock: 4 })
    await c.stockLevel.create({ data: { productId: ids.jacket, locationId: ids.main, quantity: 4, reserved: 0, available: 4 } })
    await list('jacketEbay', 'jacket', 'EBAY', 'IT')
    await list('jacketIt', 'jacket', 'AMAZON', 'IT')
    await list('jacketDe', 'jacket', 'AMAZON', 'DE')
    await list('jacketFr', 'jacket', 'AMAZON', 'FR')
    await product('fba', 'TEST-SKU-S7-FBA', { fulfillmentMethod: 'FBA' })
    await list('fbaIt', 'fba', 'AMAZON', 'IT', { fulfillmentMethod: 'FBA', quantity: 7, quantityOverride: 7, followMasterQuantity: false })
    await product('pooled', 'TEST-SKU-S7-POOLED')
    await list('pooledEbay', 'pooled', 'EBAY', 'IT')
    await product('family', 'TEST-SKU-S7-FAM', { isParent: true })
    await product('variant', 'TEST-SKU-S7-FAM-M', { parentId: ids.family })
    ids.member = (await c.sharedListingMembership.create({ data: {
      marketplace: 'IT', sku: 'TEST-SKU-S7-FAM-M', itemId: 'TEST-ITEM-S7', parentSku: 'TEST-SKU-S7-FAM', productId: ids.variant,
      variationSpecifics: {}, channelConnectionId: ids.ebay, followPool: true, lastQtyPushed: 3,
    } })).id
  })
  app = Fastify()
  app.addHook('preHandler', (request, _reply, done) => {
    Object.assign(request, { authUser: { id: ids.approver, email: 's7-approver@example.test' } })
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
  stand.outOfStock = 'OFF'
  stand.asked = []
  stand.pooled = new Set()
})

describe('08 S7 — the Sync Control route answers through the moved service', () => {
  it('its own refusals, and a pause and a resume of one listing', async () => {
    const post = async (payload: unknown) => {
      const response = await app.inject({ method: 'POST', url: '/api/stock/sync-control/actions', payload: payload as never })
      return { status: response.statusCode, body: response.json() }
    }
    expect(await post({})).toEqual({ status: 400, body: { error: 'action required' } })
    expect(await post({ action: 'PAUSE' })).toEqual({ status: 400, body: { error: 'no targets' } })
    expect(await post({ action: 'BUFFER', until: '2020-01-01T00:00:00Z', listings: [] })).toEqual({ status: 400, body: { error: 'The end time must be at least one minute from now.' } })
    const coordinate = { productId: ids.jacket, channel: 'EBAY', marketplace: 'IT', channelConnectionId: ids.ebay, aliasKey: '' }
    expect(await post({ action: 'PAUSE', listings: [coordinate] })).toEqual({ status: 200, body: { updated: 1, skippedFba: 0, unchanged: 0, recascadeQueued: 0, skippedShared: 0, scopedOut: 0 } })
    expect((await listing(ids.jacketEbay)).syncPaused).toBe(true)
    expect(await post({ action: 'RESUME', listings: [coordinate] })).toEqual({ status: 200, body: { updated: 1, skippedFba: 0, unchanged: 0, recascadeQueued: 1, skippedShared: 0, scopedOut: 0 } })
    const policy = await app.inject({ method: 'POST', url: '/api/stock/sync-control/policies', payload: { channel: 'NOPE', marketplace: 'IT', pushesPaused: true } })
    expect({ status: policy.statusCode, body: policy.json() }).toEqual({ status: 400, body: { error: "unknown channel 'NOPE'" } })
    const routes = await app.inject({ method: 'POST', url: '/api/stock/sync-control/location-routes', payload: { code: 'NO-SUCH', syncRoutes: [] } })
    expect({ status: routes.statusCode, body: routes.json() }).toEqual({ status: 404, body: { error: 'location NO-SUCH not found' } })
  })
})

describe('the Sync Control page: a pin to 0 on eBay needs the account\'s out-of-stock option ON', () => {
  const post = async (payload: unknown) => {
    const response = await app.inject({ method: 'POST', url: '/api/stock/sync-control/actions', payload: payload as never })
    return { status: response.statusCode, body: response.json() }
  }
  const member = () => inside(() => db().sharedListingMembership.findUniqueOrThrow({ where: { id: ids.member } }))

  it('refuses a zero & pin, or a fixed 0 on a shared variant, while the option is OFF or unreadable: 409, nothing written', async () => {
    const coordinate = { productId: ids.jacket, channel: 'EBAY', marketplace: 'IT', channelConnectionId: ids.ebay, aliasKey: '' }
    const refused = { status: 409, body: { error: `TEST-SKU-S7-JACKET on eBay IT: ${EBAY_ZERO_REFUSAL} Nothing was changed.`, code: 'EBAY_ZERO_REFUSED', refused: [{ sku: 'TEST-SKU-S7-JACKET', marketplace: 'IT' }] } }
    expect(await post({ action: 'ZERO_PIN', listings: [coordinate] })).toEqual(refused)
    stand.outOfStock = 'UNKNOWN'
    expect(await post({ action: 'ZERO_PIN', listings: [coordinate] })).toEqual(refused)
    expect(await listing(ids.jacketEbay)).toMatchObject({ followMasterQuantity: true, quantity: 4, quantityOverride: null })
    const variant = { itemId: 'TEST-ITEM-S7', marketplace: 'IT', sku: 'TEST-SKU-S7-FAM-M' }
    expect(await post({ action: 'PIN', quantity: 0, memberships: [variant] })).toMatchObject({ status: 409, body: { code: 'EBAY_ZERO_REFUSED', refused: [{ sku: 'TEST-SKU-S7-FAM-M', marketplace: 'IT' }] } })
    expect((await member()).pinnedQuantity).toBeNull()
    // A fixed number above 0 is not a pin to 0: it goes through as before.
    expect(await post({ action: 'PIN', quantity: 2, memberships: [variant] })).toMatchObject({ status: 200, body: { updated: 1 } })
    expect(await post({ action: 'FOLLOW', memberships: [variant] })).toMatchObject({ status: 200, body: { updated: 1 } })
  })

  it('lets it through once the option is ON', async () => {
    stand.outOfStock = 'ON'
    const variant = { itemId: 'TEST-ITEM-S7', marketplace: 'IT', sku: 'TEST-SKU-S7-FAM-M' }
    expect(await post({ action: 'PIN', quantity: 0, memberships: [variant] })).toMatchObject({ status: 200, body: { updated: 1 } })
    expect((await member()).pinnedQuantity).toBe(0)
    expect(await post({ action: 'FOLLOW', memberships: [variant] })).toMatchObject({ status: 200, body: { updated: 1 } })
  })
})

describe('08 S7 — bulk-listing-stock', { timeout: 60_000 }, () => {
  it('pause previewed, approved and run as the page runs it; undo resumes it', async () => {
    const shown = await preview('bulk-listing-stock', { action: 'pause', listingIds: [ids.jacketEbay] })
    expect(shown.ok, shown.error).toBe(true)
    expect(shown.preview).toMatchObject({
      verb: 'PAUSE', totals: { listings: 1, sharedVariants: 0, unchanged: 0, leftOut: 0 },
      cells: [{ sku: 'TEST-SKU-S7-JACKET', channel: 'EBAY', market: 'IT', account: 'Test eBay', kind: 'listing', from: 'Follow', to: 'Follow, paused' }],
    })
    expect((await listing(ids.jacketEbay)).syncPaused).toBe(false)
    const { approvalId } = await askAndRun('bulk-listing-stock', { action: 'PAUSE', listingIds: [ids.jacketEbay] })
    expect((await listing(ids.jacketEbay)).syncPaused).toBe(true)
    const audit = await inside(() => db().syncControlAudit.findFirstOrThrow({ where: { scopeId: ids.jacketEbay, field: 'syncPaused' }, orderBy: { createdAt: 'desc' } }))
    expect(audit.actor).toBe(ids.approver)
    expect(await preview('bulk-listing-stock', { action: 'PAUSE', listingIds: [ids.jacketEbay] })).toMatchObject({ ok: false, error: expect.stringContaining('already is as asked') })
    const asked = await undo(approvalId)
    expect(asked.preview).toMatchObject({ verb: 'RESUME', cells: [{ sku: 'TEST-SKU-S7-JACKET', market: 'IT' }] })
    expect((await listing(ids.jacketEbay)).syncPaused).toBe(false)
  })

  it('Amazon EU is ONE quantity: a pin on IT covers DE and FR, shown as one EU line; undo follows again', async () => {
    const shown = await preview('bulk-listing-stock', { action: 'PIN', listingIds: [ids.jacketIt] })
    expect(shown.ok, shown.error).toBe(true)
    expect(shown.preview.cells).toEqual([{ sku: 'TEST-SKU-S7-JACKET', channel: 'AMAZON', market: 'EU (DE, FR, IT)', account: 'Test Amazon', kind: 'listing', from: 'Follow', to: 'Fixed 4' }])
    expect(shown.preview).toMatchObject({ euMarketsAdded: [{ sku: 'TEST-SKU-S7-JACKET', markets: ['DE', 'FR'] }], totals: { listings: 3 }, warning: expect.stringContaining('ONE quantity') })
    const { approvalId } = await askAndRun('bulk-listing-stock', { action: 'PIN', listingIds: [ids.jacketIt] })
    for (const id of [ids.jacketIt, ids.jacketDe, ids.jacketFr]) expect(await listing(id)).toMatchObject({ followMasterQuantity: false, quantity: 4, quantityOverride: 4 })
    // The eBay listing of the same SKU is not an EU market of Amazon: untouched.
    expect((await listing(ids.jacketEbay)).followMasterQuantity).toBe(true)
    await undo(approvalId)
    for (const id of [ids.jacketIt, ids.jacketDe, ids.jacketFr]) expect((await listing(id)).followMasterQuantity).toBe(true)
  })

  it('FBA: a named FBA listing is refused, a product\'s FBA listing is left out, and its quantity never changes', async () => {
    const fields = { quantity: true, quantityOverride: true, followMasterQuantity: true, syncPaused: true, stockBuffer: true }
    const before = await inside(() => db().channelListing.findUniqueOrThrow({ where: { id: ids.fbaIt }, select: fields }))
    for (const action of ['FOLLOW', 'ZERO_PIN', 'BUFFER', 'PAUSE']) {
      const out = await preview('bulk-listing-stock', { action, listingIds: [ids.fbaIt], ...(action === 'BUFFER' ? { buffer: 2 } : {}) })
      expect(out, action).toMatchObject({ ok: false, error: expect.stringContaining('fulfilled by Amazon (FBA)') })
    }
    expect(await preview('bulk-listing-stock', { action: 'FOLLOW', productIds: [ids.fba] })).toMatchObject({ ok: false, error: expect.stringContaining('every row named is left out') })
    expect(await inside(() => db().channelListing.findUniqueOrThrow({ where: { id: ids.fbaIt }, select: fields }))).toEqual(before)
  })

  it('a fixed number on a SKU that sells from shared stock is refused; a pause of it is not', async () => {
    stand.pooled = new Set([ids.pooled])
    expect(await preview('bulk-listing-stock', { action: 'PIN', listingIds: [ids.pooledEbay] })).toMatchObject({ ok: false, error: expect.stringContaining("TEST-SKU-S7-POOLED sells from another business's shared stock") })
    expect((await preview('bulk-listing-stock', { action: 'PAUSE', listingIds: [ids.pooledEbay] })).ok).toBe(true)
  })

  it('zero & pin on eBay: refused while the out-of-stock option is OFF or unknown (read once), run when it is ON', async () => {
    const args = { action: 'ZERO_PIN', productIds: [ids.jacket, ids.pooled], channel: 'EBAY' }
    const off = await preview('bulk-listing-stock', args)
    expect(off).toMatchObject({ ok: false, error: expect.stringContaining(EBAY_ZERO_REFUSAL) })
    expect(stand.asked).toEqual([[ids.ebay, 'IT']])
    stand.outOfStock = 'UNKNOWN'
    expect((await preview('bulk-listing-stock', args)).ok).toBe(false)
    stand.outOfStock = 'ON'
    const { preview: shown } = await askAndRun('bulk-listing-stock', { action: 'ZERO_PIN', listingIds: [ids.jacketEbay] })
    expect(shown.cells).toEqual([expect.objectContaining({ to: 'Fixed 0 (stops selling)' })])
    expect(await listing(ids.jacketEbay)).toMatchObject({ quantity: 0, quantityOverride: 0, followMasterQuantity: false })
    expect(await inside(() => db().outboundSyncQueue.count({ where: { channelListingId: ids.jacketEbay, syncType: 'QUANTITY_UPDATE' } }))).toBeGreaterThan(0)
  })

  it('a shared eBay variant excluded from the stock and included again (undo)', async () => {
    const shown = await preview('bulk-listing-stock', { action: 'EXCLUDE', productIds: [ids.family], only: 'shared' })
    expect(shown.ok, shown.error).toBe(true)
    expect(shown.preview).toMatchObject({ totals: { listings: 0, sharedVariants: 1 }, cells: [{ sku: 'TEST-SKU-S7-FAM-M', channel: 'EBAY', market: 'IT', kind: 'shared variant', from: 'Follow', to: 'Excluded' }] })
    expect(await preview('bulk-listing-stock', { action: 'EXCLUDE', listingIds: [ids.jacketEbay] })).toMatchObject({ ok: false, error: expect.stringContaining('shared eBay variants') })
    const { approvalId } = await askAndRun('bulk-listing-stock', { action: 'EXCLUDE', productIds: [ids.family], only: 'shared' })
    expect((await inside(() => db().sharedListingMembership.findUniqueOrThrow({ where: { id: ids.member } }))).followPool).toBe(false)
    const asked = await undo(approvalId)
    expect(asked.preview).toMatchObject({ verb: 'INCLUDE' })
    expect((await inside(() => db().sharedListingMembership.findUniqueOrThrow({ where: { id: ids.member } }))).followPool).toBe(true)
  })

  it('refuses what it cannot name or bound: an unknown listing, more than 250 rows, a buffer without BUFFER', async () => {
    expect(await preview('bulk-listing-stock', { action: 'PAUSE', listingIds: ['no-such-listing'] })).toEqual({ ok: false, error: 'Listing not found' })
    expect(await preview('bulk-listing-stock', { action: 'PAUSE', productIds: ['no-such-product'] })).toMatchObject({ ok: false })
    expect(await preview('bulk-listing-stock', { action: 'PAUSE', listingIds: [ids.jacketEbay], buffer: 2 })).toMatchObject({ ok: false, error: 'A buffer is given with BUFFER only.' })
    expect(await preview('bulk-listing-stock', { action: 'BUFFER', listingIds: [ids.jacketEbay] })).toMatchObject({ ok: false, error: expect.stringContaining('BUFFER needs') })
  })
})

describe('08 S7 — set-stock-policy', { timeout: 60_000 }, () => {
  it('a channel market\'s pushes paused for one account, then put back (undo)', async () => {
    const shown = await preview('set-stock-policy', { channel: 'ebay', marketplace: 'it', accountId: ids.ebay, pushesPaused: true })
    expect(shown.ok, shown.error).toBe(true)
    expect(shown.preview).toMatchObject({
      policy: { channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, account: 'Test eBay' },
      changes: { 'stock pushes': { from: 'on', to: 'paused' } }, warning: expect.stringContaining('can oversell'),
    })
    const { approvalId } = await askAndRun('set-stock-policy', { channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, pushesPaused: true })
    expect(await inside(() => db().syncChannelPolicy.findMany({ where: { channel: 'EBAY', marketplace: 'IT' } }))).toEqual([expect.objectContaining({ pushesPaused: true, channelConnectionId: ids.ebay })])
    await undo(approvalId)
    expect(await inside(() => db().syncChannelPolicy.count({ where: { channel: 'EBAY', marketplace: 'IT' } }))).toBe(0)
  })

  it('a location\'s feeds changed and put back; an FBA location and an unknown one refused', async () => {
    const shown = await preview('set-stock-policy', { locationCode: 'test-s7-main', feeds: ['ebay:it', 'SHOPIFY'] })
    expect(shown.ok, shown.error).toBe(true)
    expect(shown.preview).toMatchObject({ location: { code: 'TEST-S7-MAIN' }, changes: { feeds: { from: [], to: ['EBAY:IT', 'SHOPIFY'] } }, totals: { productsRecomputed: 1 } })
    const { approvalId } = await askAndRun('set-stock-policy', { locationCode: 'TEST-S7-MAIN', feeds: ['EBAY:IT', 'SHOPIFY'] })
    expect((await inside(() => db().stockLocation.findUniqueOrThrow({ where: { id: ids.main } }))).syncRoutes).toEqual(['EBAY:IT', 'SHOPIFY'])
    await undo(approvalId)
    expect((await inside(() => db().stockLocation.findUniqueOrThrow({ where: { id: ids.main } }))).syncRoutes).toEqual([])
    expect(await preview('set-stock-policy', { locationCode: 'TEST-S7-FBA', feeds: ['EBAY:IT'] })).toMatchObject({ ok: false, error: expect.stringContaining('Amazon FBA stock') })
    expect(await preview('set-stock-policy', { locationCode: 'NO-SUCH', feeds: [] })).toMatchObject({ ok: false, error: expect.stringContaining('Location not found') })
    expect(await preview('set-stock-policy', { locationCode: 'TEST-S7-MAIN', feeds: ['NOPE:IT'] })).toMatchObject({ ok: false, error: expect.stringContaining("unknown channel 'NOPE'") })
    expect(await preview('set-stock-policy', { locationCode: 'TEST-S7-MAIN', channel: 'EBAY', marketplace: 'IT', pushesPaused: true })).toMatchObject({ ok: false, error: expect.stringContaining('one per request') })
  })
})
