/**
 * MCP full control 07 O17 — `schedule-pickup`, `sync-orders-now` and the Etsy branch of the tracking pushback, on a real
 * PostgreSQL with the production schema and policies (PGlite). Sendcloud, the order syncs and Etsy are MOCKED: nothing
 * leaves the machine.
 *
 *   schedule-pickup  — a one-time pickup today up to 30 days ahead, from a warehouse; one per carrier, warehouse and
 *                      day; Sendcloud's dry run said; a Sendcloud refusal said; never auto; cannot be undone.
 *   sync-orders-now  — once per channel every 10 minutes per business (two at once: one runs); one account or all;
 *                      another channel's account refused; another business's account not found.
 *   Etsy pushback    — a confirmed Etsy shipment's tracking goes to Etsy's createReceiptShipment on the order's own
 *                      account, as an order action; switched off, nothing is sent and the row says why.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FEATURES, FIELDS } from '@nexus/shared/permissions'
import { formulaDatabase } from '../../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
vi.mock('../../../lib/queue.js', () => ({
  outboundSyncQueue: null, channelSyncQueue: null, bulkJobQueue: null, redis: null,
  searchIndexQueue: null, readCacheQueue: null, readinessQueue: null,
  addJobSafely: vi.fn(async () => ({ enqueued: false })),
}))
const mocks = vi.hoisted(() => ({ pickups: [] as unknown[], refusePickup: false, ebaySyncs: [] as string[], amazonSyncs: 0, etsy: [] as Array<{ accountId: string; input: Record<string, unknown> }> }))
vi.mock('../../sendcloud/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveCredentials: vi.fn(async () => ({ publicKey: 'test', secretKey: 'test' })),
  listSenderAddresses: vi.fn(async () => [{ id: 5, isDefault: true }]),
  requestPickup: vi.fn(async (_creds: unknown, input: Record<string, unknown>) => {
    mocks.pickups.push(input)
    return mocks.refusePickup ? { ok: false, reason: 'Test: no pickup that day' } : { ok: true, externalRef: `TEST-PU-${mocks.pickups.length}`, scheduledFor: input.pickupDate, status: 'Scheduled' }
  }),
}))
vi.mock('../../ebay-orders.service.js', () => ({
  ebayOrdersService: {
    syncEbayOrders: vi.fn(async (connectionId: string) => {
      mocks.ebaySyncs.push(connectionId)
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { syncId: 's', status: 'SUCCESS', ordersFetched: 3, ordersCreated: 2, ordersUpdated: 1, itemsProcessed: 3, itemsLinked: 3, inventoryDeducted: 2, errors: [], startedAt: new Date(), completedAt: new Date() }
    }),
  },
}))
vi.mock('../../amazon-orders.service.js', () => ({
  getActiveMarketplaceIdsFromDb: vi.fn(async () => ['APJ6JRA9NG5V4']),
  amazonOrdersService: {
    isConfigured: vi.fn(async () => true),
    getLatestPurchaseDate: vi.fn(async () => new Date('2026-09-30T00:00:00Z')),
    syncNewOrders: vi.fn(async () => { mocks.amazonSyncs += 1; return { ordersFetched: 4, ordersUpserted: 4, ordersFailed: 0, itemsFailed: 0 } }),
    syncAllOrders: vi.fn(),
  },
}))
vi.mock('../../etsy/write-client.js', () => ({
  etsyWriter: vi.fn(async (accountId: string) => ({
    shopId: '424242',
    send: vi.fn(async (input: Record<string, unknown>) => { mocks.etsy.push({ accountId, input }); return { receipt_id: 1 } }),
  })),
}))
vi.mock('../../outbound-events.service.js', () => ({ publishOutboundEvent: vi.fn() }))

import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'

const SECOND = 'test_o17_second_business'
const principal = (workspaceId = LEGACY_WORKSPACE_ID): UserPrincipal => ({
  kind: 'user', userId: 'u-o17', label: '07 O17 test', permissions: { isOwner: false, permissions: new Set([...Object.values(FEATURES), ...Object.values(FIELDS)]) },
  workspace: { workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, via: 'claude',
})
const inside = <T>(work: () => Promise<T>, workspaceId = LEGACY_WORKSPACE_ID) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
type Out = { ok: boolean; error?: string; preview?: any; data?: any }
const dryRun = async (tool: string, args: Record<string, unknown>, who = principal()) => (await callTool(who, tool, args)).raw as Out
const run = async (tool: string, args: Record<string, unknown>, approvedPreview: unknown, who = principal()) => (await executeTool(who, tool, args, { approvedPreview })).raw as Out
const approved = async (tool: string, args: Record<string, unknown>, who = principal()) => {
  const asked = await dryRun(tool, args, who)
  expect(asked.ok, asked.error).toBe(true)
  return run(tool, args, asked.preview, who)
}
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
const ids: Record<string, string> = {}

beforeAll(async () => {
  database = await formulaDatabase()
  await database.client.workspace.create({ data: { id: SECOND, name: 'Second test business', createdByUserId: 'test', creationKey: 'test-o17-second' } })
  await inside(async () => {
    await database.client.carrier.create({ data: { code: 'SENDCLOUD', name: 'Sendcloud', isActive: true } as never })
    await database.client.carrier.create({ data: { code: 'MANUAL', name: 'Manual', isActive: true } as never })
    ids.warehouse = (await database.client.warehouse.create({ data: { code: 'TEST-O17-WH', name: 'Test warehouse', isDefault: true, sendcloudSenderId: 9, addressLine1: 'Via Magazzino 1', city: 'Testville', postalCode: '00100', country: 'IT' } as never })).id
    ids.ebayA = (await database.client.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, externalAccountId: 'test-seller-a' } as never })).id
    ids.ebayB = (await database.client.channelConnection.create({ data: { channelType: 'EBAY', isActive: true, externalAccountId: 'test-seller-b' } as never })).id
    ids.amazon = (await database.client.channelConnection.create({ data: { channelType: 'AMAZON', isActive: true, externalAccountId: 'TESTSELLER' } as never })).id
    ids.etsy = (await database.client.channelConnection.create({ data: { channelType: 'ETSY', isActive: true, externalAccountId: 'test-shop' } as never })).id
  })
  ids.otherAccount = await inside(async () => (await database.client.channelConnection.create({ data: { channelType: 'EBAY', isActive: true } as never })).id, SECOND)
}, 180_000)
afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('schedule-pickup (07 O17)', () => {
  it('books a Sendcloud pickup (dry run said) from the default warehouse; a second one that day is refused', async () => {
    const args = { carrier: 'SENDCLOUD', date: inDays(2), windowStart: '09:00', windowEnd: '12:00', notes: 'Two parcels' }
    const asked = await dryRun('schedule-pickup', args)
    expect(asked.preview).toMatchObject({ pickup: { carrier: 'SENDCLOUD', date: inDays(2), warehouse: { code: 'TEST-O17-WH' } }, mode: expect.stringMatching(/^dry run: Sendcloud is not asked/) })
    const done = await run('schedule-pickup', args, asked.preview)
    expect(done.ok, done.error).toBe(true)
    expect(done.data).toMatchObject({ externalRef: 'TEST-PU-1' })
    expect(mocks.pickups).toEqual([expect.objectContaining({ senderAddressId: 9, pickupDate: inDays(2) })])
    expect((await dryRun('schedule-pickup', args)).error).toMatch(/A SENDCLOUD pickup is booked for .* already \(TEST-PU-1\)/)
  })

  it('a MANUAL pickup is recorded only; dates outside today..30 days, an unknown warehouse and Sendcloud\'s refusal are said', async () => {
    const manual = await approved('schedule-pickup', { carrier: 'MANUAL', date: inDays(1) })
    expect(manual.ok, manual.error).toBe(true)
    expect(mocks.pickups).toHaveLength(1)
    expect((await dryRun('schedule-pickup', { carrier: 'MANUAL', date: inDays(-1) })).error).toMatch(/today up to 30 days ahead/)
    expect((await dryRun('schedule-pickup', { carrier: 'MANUAL', date: inDays(31) })).error).toMatch(/today up to 30 days ahead/)
    expect((await dryRun('schedule-pickup', { carrier: 'MANUAL', date: inDays(3), warehouseId: 'test-wh-none' })).error).toMatch(/^Warehouse not found: test-wh-none/)
    mocks.refusePickup = true
    const refused = await approved('schedule-pickup', { carrier: 'SENDCLOUD', date: inDays(4) })
    mocks.refusePickup = false
    expect(refused.ok).toBe(false)
    expect(refused.error).toMatch(/^Sendcloud did not book it: Test: no pickup that day/)
    expect(getTool('schedule-pickup')).toMatchObject({ alwaysAsk: true, maxClaudeTrust: 'ask', reversibility: 'none' })
  })
})

describe('sync-orders-now (07 O17)', () => {
  it('one eBay account; again within 10 minutes is refused; two at once, only one runs', async () => {
    const one = await approved('sync-orders-now', { channel: 'EBAY', accountId: ids.ebayA })
    expect(one.ok, one.error).toBe(true)
    expect(one.data).toMatchObject({ accounts: 1, ordersFetched: 3, ordersCreatedOrUpdated: 3 })
    expect(mocks.ebaySyncs).toEqual([ids.ebayA])
    expect((await dryRun('sync-orders-now', { channel: 'EBAY' })).error).toMatch(/the next sync now is allowed from .* \(once every 10 minutes\)/)
    const asked = await dryRun('sync-orders-now', { channel: 'AMAZON' })
    expect(asked.ok, asked.error).toBe(true)
    const both = await Promise.all([run('sync-orders-now', { channel: 'AMAZON' }, asked.preview), run('sync-orders-now', { channel: 'AMAZON' }, asked.preview)])
    expect(both.filter((r) => r.ok)).toHaveLength(1)
    expect(mocks.amazonSyncs).toBe(1)
  })

  it('another channel\'s account is refused; another business\'s account is not found; it runs in its own business', async () => {
    expect((await dryRun('sync-orders-now', { channel: 'AMAZON', accountId: ids.etsy })).error).toMatch(/is a ETSY account, not AMAZON/)
    expect((await dryRun('sync-orders-now', { channel: 'EBAY', accountId: ids.otherAccount })).error).toBe(`Account not found: ${ids.otherAccount}. Nothing was queued.`)
    const second = await approved('sync-orders-now', { channel: 'EBAY' }, principal(SECOND))
    expect(second.ok, second.error).toBe(true)
    expect(mocks.ebaySyncs.at(-1)).toBe(ids.otherAccount)
  })
})

describe('the Etsy branch of the tracking pushback (07 O17)', () => {
  const shipped = async (key: string) => inside(async () => {
    const order = await database.client.order.create({ data: {
      channel: 'ETSY', channelOrderId: `31000000${key}`, marketplace: 'IT', status: 'SHIPPED', currencyCode: 'EUR', totalPrice: '20.00',
      customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: { city: 'Testville' }, channelConnectionId: ids.etsy,
    } as never })
    const shipment = await database.client.shipment.create({ data: { orderId: order.id, carrierCode: 'MANUAL', serviceName: 'GLS', status: 'SHIPPED', trackingNumber: `TEST-ETSY-${key}` } as never })
    const { enqueueTrackingUpload } = await import('../../fulfillment/tracking-upload.service.js')
    expect(await enqueueTrackingUpload(shipment.id, { shippedAt: new Date(), trackingNumber: `TEST-ETSY-${key}`, carrierCode: 'MANUAL' }, { explicit: true })).toMatchObject({ queued: true })
    return shipment.id
  })
  const logOf = (shipmentId: string) => inside(() => database.client.trackingMessageLog.findFirstOrThrow({ where: { shipmentId }, select: { status: true, lastErrorCode: true } }))

  it('switched off: nothing is sent and the row says why; on: createReceiptShipment on the order\'s own Etsy account', async () => {
    const { runTrackingPushbackSweep } = await import('../../../jobs/tracking-pushback.job.js')
    const off = await shipped('1')
    await inside(() => runTrackingPushbackSweep())
    expect(await logOf(off)).toEqual({ status: 'FAILED', lastErrorCode: 'SHIP_CONFIRM_OFF' })
    expect(mocks.etsy).toEqual([])
    vi.stubEnv('NEXUS_ENABLE_ETSY_SHIP_CONFIRM', 'true')
    const on = await shipped('2')
    await inside(() => runTrackingPushbackSweep())
    expect(await logOf(on)).toEqual({ status: 'SUCCESS', lastErrorCode: null })
    expect(mocks.etsy).toEqual([{ accountId: ids.etsy, input: expect.objectContaining({ path: '/shops/424242/receipts/310000002/tracking', method: 'POST', kind: 'action', form: { tracking_code: 'TEST-ETSY-2', carrier_name: 'gls' } }) }])
    vi.unstubAllEnvs()
  })
})
