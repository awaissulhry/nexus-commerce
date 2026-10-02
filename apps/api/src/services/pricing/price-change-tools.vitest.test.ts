/**
 * MCP full control 08 S11 — set-price-bounds, bulk-listing-price-change and resend-prices, through the doors a person
 * uses (runOrQueueTool, then the Approvals page's schedule and commit), on the price door (`writeChannelPrices`), the
 * product writer and `/pricing`'s Push price.
 *
 * Proven: a listing price moved by a percent through the door, as the approver, and put back by undo (a listing that
 * followed the master follows it again); an Amazon FBA listing's price changes and its quantity fields do not; a price
 * outside the product's ceiling, a market in another currency and an unknown listing are refused before anything is
 * queued; .99 rounding; the auto limits (±10 %); a floor raised — the preview names the prices then outside — and put back;
 * a floor above the ceiling refused; a price sent again, a paused listing left out.
 *
 * Real SQL (PGlite with the production schema); nothing reaches a channel (the queue is stood in).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

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

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
type Json = any
const ids: Record<string, string> = {}
const EVERYTHING = new Set<string>([...Object.values(FEATURES), ...Object.values(FIELDS)])
const person = () => ({ kind: 'user' as const, userId: ids.approver, label: 'S11 Approver', permissions: { isOwner: false, permissions: EVERYTHING }, workspace: business, via: 'claude' as const })
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
const n = (value: unknown) => (value === null || value === undefined ? null : Number(value))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const c = db()
    ids.approver = (await c.userProfile.create({ data: { email: 's11-approver@example.test', status: 'active', displayName: 'S11 Approver' } })).id
    const role = await c.role.create({ data: { key: 'S11_APPROVER', name: 'S11 approver', description: 'test', isSystem: false, permissions: [...EVERYTHING] } })
    await c.userRole.create({ data: { userId: ids.approver, roleId: role.id } })
    const membership = await c.workspaceMembership.create({ data: { workspaceId: LEGACY_WORKSPACE_ID, userId: ids.approver, status: 'active' } })
    await c.workspaceMemberRole.create({ data: { membershipId: membership.id, roleId: role.id } })
    for (const [channel, code, currency] of [['EBAY', 'IT', 'EUR'], ['EBAY', 'UK', 'GBP'], ['AMAZON', 'IT', 'EUR']]) {
      await c.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, currency, region: 'EU', language: 'it', languages: ['it'] } as never })
    }
    ids.amazon = (await c.channelConnection.create({ data: { channelType: 'AMAZON', isActive: true, accountLabel: 'Test Amazon' } })).id
    ids.ebay = (await c.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, accountLabel: 'Test eBay' } })).id
    ids.jacket = (await c.product.create({ data: { sku: 'TEST-SKU-S11-JACKET', name: 'Jacket', basePrice: '20.00', minPrice: '15.00', maxPrice: '30.00' } })).id
    ids.gloves = (await c.product.create({ data: { sku: 'TEST-SKU-S11-GLOVES', name: 'Gloves', basePrice: '40.00' } })).id
    const list = async (key: string, productId: string, channel: string, market: string, data: Json = {}) => {
      ids[key] = (await c.channelListing.create({ data: {
        productId, channel, marketplace: market, region: market, channelMarket: `${channel}_${market}`, channelConnectionId: channel === 'AMAZON' ? ids.amazon : ids.ebay,
        listingStatus: 'ACTIVE', isPublished: true, externalListingId: `TEST-S11-${key}`, price: '20.00', quantity: 3, ...data,
      } as never })).id
    }
    await list('jacketIt', ids.jacket, 'EBAY', 'IT', { followMasterPrice: true })
    await list('jacketFba', ids.jacket, 'AMAZON', 'IT', { followMasterPrice: false, price: '22.00', priceOverride: '22.00', fulfillmentMethod: 'FBA', quantity: 7, quantityOverride: 7, followMasterQuantity: false })
    await list('jacketUk', ids.jacket, 'EBAY', 'UK', { followMasterPrice: false, price: '18.00', priceOverride: '18.00' })
    await list('glovesIt', ids.gloves, 'EBAY', 'IT', { followMasterPrice: true, price: '40.00', syncPaused: true })
  })
}, 180_000)

afterAll(async () => { await database?.close() }, 60_000)

describe('08 S11 — bulk-listing-price-change', { timeout: 60_000 }, () => {
  it('moves prices by a percent through the price door as the approver; FBA: its price only; undo puts them back', async () => {
    const fields = { quantity: true, quantityOverride: true, followMasterQuantity: true, fulfillmentMethod: true, stockBuffer: true }
    const fbaBefore = await inside(() => db().channelListing.findUniqueOrThrow({ where: { id: ids.jacketFba }, select: fields }))
    const args = { listingIds: [ids.jacketIt, ids.jacketFba], mode: 'percent', value: 10 }
    const shown = await preview('bulk-listing-price-change', args)
    expect(shown.ok, shown.error).toBe(true)
    expect(shown.preview).toMatchObject({
      totals: { listings: 2, up: 2, maxChangePct: 10 },
      changes: [
        { sku: 'TEST-SKU-S11-JACKET', channel: 'EBAY', market: 'IT', currency: 'EUR', from: 20, to: 22, changePct: 10 },
        { sku: 'TEST-SKU-S11-JACKET', channel: 'AMAZON', market: 'IT', from: 22, to: 24.2, changePct: 10, note: expect.stringContaining('price only') },
      ],
    })
    const { approvalId } = await askAndRun('bulk-listing-price-change', args)
    expect(await listing(ids.jacketIt)).toMatchObject({ followMasterPrice: false })
    expect(n((await listing(ids.jacketIt)).priceOverride)).toBe(22)
    expect(n((await listing(ids.jacketFba)).priceOverride)).toBe(24.2)
    expect(await inside(() => db().channelListing.findUniqueOrThrow({ where: { id: ids.jacketFba }, select: fields }))).toEqual(fbaBefore)
    const queued = await inside(() => db().outboundSyncQueue.findMany({ where: { channelListingId: { in: [ids.jacketIt, ids.jacketFba] }, syncType: 'PRICE_UPDATE' } }))
    expect(queued.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(queued.map((q) => q.payload))).not.toMatch(/quantity/)
    const timeline = await inside(() => db().priceChangeEvent.findFirst({ where: { productId: ids.jacket, channel: 'EBAY', marketplace: 'IT' }, orderBy: { changedAt: 'desc' } }))
    expect(timeline?.actor).toBe(ids.approver)

    const asked = await undo(approvalId)
    expect(asked.preview.changes).toEqual(expect.arrayContaining([expect.objectContaining({ market: 'IT', channel: 'EBAY', to: 'follows the master price' })]))
    expect((await listing(ids.jacketIt)).followMasterPrice).toBe(true)
    expect(n((await listing(ids.jacketFba)).priceOverride)).toBe(22)
    expect(await inside(() => db().channelListing.findUniqueOrThrow({ where: { id: ids.jacketFba }, select: fields }))).toEqual(fbaBefore)
  })

  it('refuses before anything is queued: outside the ceiling, another currency, a listing it cannot find', async () => {
    expect(await preview('bulk-listing-price-change', { listingIds: [ids.jacketIt], mode: 'percent', value: 60 })).toMatchObject({ ok: false, error: expect.stringContaining('above its pricing ceiling of 30.00') })
    expect(await preview('bulk-listing-price-change', { listingIds: [ids.jacketIt], mode: 'set', value: 10 })).toMatchObject({ ok: false, error: expect.stringContaining('below its pricing floor of 15.00') })
    expect(await preview('bulk-listing-price-change', { listingIds: [ids.jacketUk], mode: 'amount', value: 1 })).toMatchObject({ ok: false, error: expect.stringContaining('sells in GBP, not EUR') })
    expect(await preview('bulk-listing-price-change', { listingIds: ['no-such-listing'], mode: 'percent', value: 1 })).toEqual({ ok: false, error: 'Listing not found' })
    expect(await preview('bulk-listing-price-change', { listingIds: [ids.jacketIt] })).toMatchObject({ ok: false, error: expect.stringContaining('mode') })
    expect(n((await listing(ids.jacketUk)).priceOverride)).toBe(18)
  })

  it('.99 rounding, and the limits Claude may move prices within on its own', async () => {
    const rounded = await preview('bulk-listing-price-change', { listingIds: [ids.jacketIt], mode: 'set', value: 25.4, endIn99: true })
    expect(rounded.preview.changes[0]).toMatchObject({ from: 20, to: 24.99 })
    const { getTool } = await import('../agents/tool-registry.js')
    const tool = getTool('bulk-listing-price-change')!
    const limits = tool.limits!.parse({}) as Record<string, unknown>
    expect(limits).toEqual({ maxListings: 250, maxChangePct: 10 })
    expect(tool.withinLimits!((await preview('bulk-listing-price-change', { listingIds: [ids.jacketIt], mode: 'percent', value: 5 })).preview, limits)).toBeNull()
    expect(tool.withinLimits!((await preview('bulk-listing-price-change', { listingIds: [ids.jacketIt], mode: 'percent', value: 20 })).preview, limits)).toContain('20%')
  })
})

describe('08 S11 — set-price-bounds', { timeout: 60_000 }, () => {
  it('a floor raised names the prices then outside; run through the product writer; undo puts it back', async () => {
    const shown = await preview('set-price-bounds', { items: [{ productId: ids.jacket, minPrice: 21 }] })
    expect(shown.ok, shown.error).toBe(true)
    expect(shown.preview).toMatchObject({
      changes: [{ sku: 'TEST-SKU-S11-JACKET', floor: { from: '15.00', to: '21.00' }, ceiling: { from: '30.00', to: '30.00' }, listingsOutside: 1 }],
      totals: { products: 1, listingsOutside: 1, masterPricesOutside: 1 },
      warnings: [expect.stringContaining('TEST-SKU-S11-JACKET on EBAY IT at 20.00'), expect.stringContaining('master price of TEST-SKU-S11-JACKET (20.00)')],
    })
    const { approvalId } = await askAndRun('set-price-bounds', { items: [{ productId: ids.jacket, minPrice: 21 }] })
    expect(n((await inside(() => db().product.findUniqueOrThrow({ where: { id: ids.jacket } }))).minPrice)).toBe(21)
    await undo(approvalId)
    const after = await inside(() => db().product.findUniqueOrThrow({ where: { id: ids.jacket } }))
    expect([n(after.minPrice), n(after.maxPrice)]).toEqual([15, 30])
  })

  it('refuses a floor above the ceiling, a product it cannot find, and nothing to change', async () => {
    expect(await preview('set-price-bounds', { items: [{ productId: ids.jacket, minPrice: 40 }] })).toMatchObject({ ok: false, error: expect.stringContaining('above the ceiling 30.00') })
    expect(await preview('set-price-bounds', { items: [{ productId: 'no-such-product', minPrice: 1 }] })).toMatchObject({ ok: false, error: expect.stringContaining('not found') })
    expect(await preview('set-price-bounds', { items: [{ productId: ids.jacket, minPrice: 15 }] })).toMatchObject({ ok: false, error: expect.stringContaining('Nothing to change') })
    expect(await preview('set-price-bounds', { items: [{ productId: ids.jacket }] })).toMatchObject({ ok: false, error: expect.stringContaining('Name a floor') })
  })
})

describe('08 S11 — resend-prices', { timeout: 60_000 }, () => {
  it('sends the price a listing carries again through the door; a paused one is left out', async () => {
    const shown = await preview('resend-prices', { listingIds: [ids.jacketIt, ids.glovesIt] })
    expect(shown.ok, shown.error).toBe(true)
    expect(shown.preview).toMatchObject({
      send: [{ sku: 'TEST-SKU-S11-JACKET', channel: 'EBAY', market: 'IT', price: 20, currency: 'EUR' }],
      leftOut: [{ where: 'TEST-SKU-S11-GLOVES on EBAY IT', reason: expect.stringContaining('paused') }],
      totals: { listings: 1, leftOut: 1 },
    })
    const before = await inside(() => db().outboundSyncQueue.count({ where: { channelListingId: ids.jacketIt, syncType: 'PRICE_UPDATE' } }))
    await askAndRun('resend-prices', { listingIds: [ids.jacketIt, ids.glovesIt] })
    expect(await inside(() => db().outboundSyncQueue.count({ where: { channelListingId: ids.jacketIt, syncType: 'PRICE_UPDATE' } }))).toBeGreaterThan(before)
    expect(await inside(() => db().outboundSyncQueue.count({ where: { channelListingId: ids.glovesIt, syncType: 'PRICE_UPDATE' } }))).toBe(0)
    expect(await preview('resend-prices', { listingIds: [ids.glovesIt] })).toMatchObject({ ok: false, error: expect.stringContaining('Nothing to send') })
  })
})
