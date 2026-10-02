/**
 * MCP full control 07 O8 — `create-shipments`, `update-shipment`, `buy-shipping-label`, `void-shipping-label` through
 * the one door (call-tool.ts): the dry run and the run a person's approval starts, on a real PostgreSQL with the
 * production schema and policies (PGlite). The carriers are MOCKED (Sendcloud and Amazon Buy Shipping answer the same
 * every run; nothing leaves the machine).
 *
 *   - FBA refused: no shipment and no label for an order Amazon ships, before any carrier is asked
 *   - 40 labels as one plan step: one approved call buys 40 labels (40 carrier calls), records the change, and its undo
 *     asks to void those 40 — and 40 is above the default limits, so a person approves it in Nexus
 *   - € limits: inside the limits → may be confirmed in Claude; above (per label, in total, unknown price) → ask
 *   - the preview gives each label's estimated price and each carrier's live/dry-run mode; a flip to live after the
 *     approval refuses the run (stale)
 *   - update-shipment: hold ↔ release, service and back (to none), cancel (its undo refused); create's undo cancels
 *   - a return label; refused without returns.process
 *   - confirm-shipment (O9): a MANUAL shipment's tracking set, shipped and uploaded once; a Sendcloud parcel waits for
 *     its scan; FBA refused; a channel switch flipping to live after the approval refuses the run
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
const carrier = vi.hoisted(() => ({ parcels: [] as Array<Record<string, unknown>>, voided: [] as number[], rateReads: 0, next: 9000, price: 4.2 }))
vi.mock('../../sendcloud/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveCredentials: vi.fn(async () => ({ publicKey: 'test', secretKey: 'test' })),
  resolveServiceMap: vi.fn(async () => null),
  getSendcloudMode: vi.fn(() => ({ dryRun: true, env: 'test' })),
  listShippingMethods: vi.fn(async () => {
    carrier.rateReads++
    return [{ id: 2001, name: 'Test Standard', carrier: 'BRT', price: carrier.price, minWeightKg: 0, maxWeightKg: 5 }]
  }),
  createParcel: vi.fn(async (_creds: unknown, input: Record<string, unknown>) => {
    carrier.parcels.push(input)
    const n = ++carrier.next
    return { id: n, tracking_number: `TEST-SC-${n}`, tracking_url: null, label: { normal_printer: [`https://label.example.test/${n}.pdf`] }, shipment: { name: 'Test Standard' }, status: { id: 1000 } }
  }),
  voidParcel: vi.fn(async (_creds: unknown, parcelId: number) => {
    carrier.voided.push(parcelId)
    return { ok: true }
  }),
}))
vi.mock('../../amazon-pushback/buy-shipping.js', () => ({
  getEligibleShippingServices: vi.fn(async () => []),
  createShipment: vi.fn(async () => { throw new Error('not expected in this suite') }),
}))

import { callTool, executeTool, type UserPrincipal } from '../call-tool.js'
import { getTool } from '../tool-registry.js'
import type { ToolChange } from '../tool-types.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const principal = (permissions: string[]): UserPrincipal => ({
  kind: 'user', userId: 'u-o8', label: '07 O8 test', permissions: { isOwner: false, permissions: new Set(permissions) }, workspace: business, via: 'claude',
})
const everything = principal([...Object.values(FEATURES), ...Object.values(FIELDS)])
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
type Out = { ok: boolean; error?: string; preview?: any; data?: any; change?: ToolChange }
const dryRun = async (tool: string, args: Record<string, unknown>, who = everything) => (await callTool(who, tool, args)).raw as Out
const run = async (tool: string, args: Record<string, unknown>, approvedPreview: unknown) => (await executeTool(everything, tool, args, { approvedPreview })).raw as Out
async function approveAndRun(tool: string, args: Record<string, unknown>) {
  const asked = await dryRun(tool, args)
  expect(asked.ok, asked.error).toBe(true)
  const done = await run(tool, args, asked.preview)
  expect(done.ok, done.error).toBe(true)
  return { asked, done }
}
async function undoOf(tool: string, change: ToolChange) {
  const definition = getTool(tool)!
  expect(await inside(() => definition.undo!.current(change))).toEqual(change.after)
  return definition.undo!.request(change)
}
const statuses = (shipmentIds: string[]) => inside(async () => (await database.client.shipment.findMany({ where: { id: { in: shipmentIds } }, select: { status: true } })).map((s) => s.status))
const ADDRESS = { AddressLine1: 'Via Test 1', City: 'Testville', PostalCode: '00100', CountryCode: 'IT' }
const orders: string[] = []
const ids: Record<string, string> = {}

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    ids.warehouse = (await db.warehouse.create({ data: { code: 'TEST-WH', name: 'Test warehouse', isDefault: true, addressLine1: 'Via Magazzino 1', city: 'Testville', postalCode: '00100', country: 'IT' } as never })).id
    const order = async (key: string, data: Record<string, unknown> = {}) => (await db.order.create({
      data: {
        channel: 'EBAY', channelOrderId: `TEST-O8-${key}`, marketplace: 'IT', status: 'PROCESSING', currencyCode: 'EUR', totalPrice: '20.00',
        customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: ADDRESS, fulfillmentMethod: 'MFN',
        items: { create: [{ sku: `TEST-O8-SKU-${key}`, quantity: 1, price: '20.00' }] }, ...data,
      } as never,
    })).id
    for (let i = 0; i < 40; i++) orders.push(await order(`PLAN-${i}`))
    ids.fba = await order('FBA', { channel: 'AMAZON', fulfillmentMethod: 'FBA' })
    ids.mcf = await order('MCF')
    await db.mCFShipment.create({ data: { orderId: ids.mcf, amazonFulfillmentOrderId: 'TEST-O8-MCF-1', status: 'PROCESSING' } })
    ids.fbaShipped = await order('FBA-OLD', { channel: 'AMAZON', fulfillmentMethod: 'FBA', status: 'SHIPPED' })
    ids.fbaShipment = (await db.shipment.create({ data: { orderId: ids.fbaShipped, warehouseId: ids.warehouse, carrierCode: 'SENDCLOUD', status: 'PACKED' } as never })).id
    ids.spare = await order('SPARE')
    ids.spareShipment = (await db.shipment.create({ data: { orderId: ids.spare, warehouseId: ids.warehouse, carrierCode: 'SENDCLOUD', status: 'DRAFT' } as never })).id
    ids.returned = await order('RETURNED', { status: 'DELIVERED' })
    ids.ret = (await db.return.create({ data: { orderId: ids.returned, channel: 'EBAY', rmaNumber: 'TEST-O8-RMA' } as never })).id
  })
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
}, 30_000)

describe('create-shipments', () => {
  it('FBA and MCF orders are skipped (never a shipment); only those named are refused when nothing is left', async () => {
    expect((await dryRun('create-shipments', { orderIds: [ids.fba, ids.mcf] })).error).toMatch(/No shipment to make.*Amazon ships this order/)
    const asked = await dryRun('create-shipments', { orderIds: [orders[0], ids.fba] })
    expect(asked.preview.create.map((c: { orderId: string }) => c.orderId)).toEqual([orders[0]])
    expect(asked.preview.skipped).toEqual([{ orderId: ids.fba, reason: expect.stringContaining('Amazon ships this order') }])
  })

  it('makes 40 shipments in one approved run; undo asks to cancel them; the limit asks a person above 20', async () => {
    const { asked, done } = await approveAndRun('create-shipments', { orderIds: orders, warehouseId: ids.warehouse, carrierCode: 'SENDCLOUD' })
    const tool = getTool('create-shipments')!
    expect(tool.withinLimits!(asked.preview, tool.limits!.parse({}))).toMatch(/40 shipments, more than the 20/)
    expect(done.data.created).toBe(40)
    const shipmentIds = (done.change!.after as { shipmentIds: string[] }).shipmentIds
    expect(shipmentIds).toHaveLength(40)
    ids.shipments = JSON.stringify(shipmentIds)
    const undo = await undoOf('create-shipments', done.change!)
    expect(undo).toEqual({ tool: 'update-shipment', args: { shipments: shipmentIds.map((shipmentId) => ({ shipmentId, action: 'cancel' })) } })
  })
})

describe('buy-shipping-label', () => {
  it('refuses a shipment of an order Amazon ships before any carrier is asked', async () => {
    const reads = carrier.rateReads
    expect((await dryRun('buy-shipping-label', { shipmentIds: [ids.fbaShipment] })).error).toMatch(/Amazon ships this order/)
    expect(carrier.rateReads).toBe(reads)
    expect(carrier.parcels).toHaveLength(0)
  })

  it('40 labels as one plan step: estimated prices and modes in the preview; 40 carrier calls; undo asks to void the 40', async () => {
    const shipmentIds = JSON.parse(ids.shipments) as string[]
    const asked = await dryRun('buy-shipping-label', { shipmentIds })
    expect(asked.preview).toMatchObject({ count: 40, totalEur: 168, unknownPrices: 0, modes: { sendcloud: expect.stringMatching(/^dry run/) } })
    expect(asked.preview.labels[0]).toMatchObject({ carrier: 'SENDCLOUD', estimatedEur: 4.2, destination: 'IT' })
    const tool = getTool('buy-shipping-label')!
    expect(tool.withinLimits!(asked.preview, tool.limits!.parse({}))).toMatch(/40 labels, more than the 10/)
    expect(tool.withinLimits!(asked.preview, tool.limits!.parse({ maxLabels: 50, maxEurTotal: 200 }))).toBeNull()
    const done = await run('buy-shipping-label', { shipmentIds }, asked.preview)
    expect(done.ok, done.error).toBe(true)
    expect(done.data).toMatchObject({ bought: 40, failed: [] })
    expect(carrier.parcels).toHaveLength(40)
    expect(new Set(await statuses(shipmentIds))).toEqual(new Set(['LABEL_PRINTED']))
    expect(await undoOf('buy-shipping-label', done.change!)).toEqual({ tool: 'void-shipping-label', args: { shipmentIds } })
  })

  it('€ limits: a label above the per-label price, or an unknown price, asks a person', async () => {
    const tool = getTool('buy-shipping-label')!
    const limits = tool.limits!.parse({})
    const line = (eur: number | null) => ({ shipmentId: 's', estimatedEur: eur })
    expect(tool.withinLimits!({ labels: [line(4.2)], returnLabels: [], count: 1, totalEur: 4.2, unknownPrices: 0 }, limits)).toBeNull()
    expect(tool.withinLimits!({ labels: [line(19)], returnLabels: [], count: 1, totalEur: 19, unknownPrices: 0 }, limits)).toMatch(/€19, more than the €15/)
    expect(tool.withinLimits!({ labels: new Array(10).fill(line(14.9)), returnLabels: [], count: 10, totalEur: 149, unknownPrices: 0 }, { ...limits, maxEurTotal: 100 })).toMatch(/€149, more than the €100 allowed in total/)
    expect(tool.withinLimits!({ labels: [line(null)], returnLabels: [], count: 1, totalEur: 0, unknownPrices: 1 }, limits)).toMatch(/not known before buying/)
  })

  it('stale refused: Sendcloud went live after the approval, so nothing is bought', async () => {
    const asked = await dryRun('buy-shipping-label', { shipmentIds: [ids.spareShipment] })
    vi.stubEnv('NEXUS_ENABLE_SENDCLOUD_REAL', 'true')
    const parcels = carrier.parcels.length
    const done = await run('buy-shipping-label', { shipmentIds: [ids.spareShipment] }, asked.preview)
    vi.unstubAllEnvs()
    expect(done).toEqual({ ok: false, error: expect.stringMatching(/changed since you approved it \(modes\)/) })
    expect(carrier.parcels).toHaveLength(parcels)
  })

  it('a return label (price unknown: a person approves); refused without returns.process', async () => {
    const without = principal([...Object.values(FEATURES), ...Object.values(FIELDS)].filter((p) => p !== FEATURES.returnsProcess))
    expect((await dryRun('buy-shipping-label', { returnIds: [ids.ret] }, without)).error).toMatch(/returns.process/)
    const { asked, done } = await approveAndRun('buy-shipping-label', { returnIds: [ids.ret] })
    expect(asked.preview).toMatchObject({ returnLabels: [{ rmaNumber: 'TEST-O8-RMA', estimatedEur: null }], unknownPrices: 1 })
    expect(done.data).toMatchObject({ returnLabels: 1 })
    expect(carrier.parcels.at(-1)).toMatchObject({ is_return: true })
    const ret = await inside(() => database.client.return.findUniqueOrThrow({ where: { id: ids.ret }, select: { returnLabelCarrier: true } }))
    expect(ret.returnLabelCarrier).toBe('SENDCLOUD')
  })

  it('without orders.fulfill the label tools are refused', async () => {
    const without = principal(Object.values(FEATURES).filter((p) => p !== FEATURES.ordersFulfill))
    await expect(callTool(without, 'buy-shipping-label', { shipmentIds: [ids.spareShipment] })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(callTool(without, 'void-shipping-label', { shipmentIds: [ids.spareShipment] })).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('void-shipping-label', () => {
  it('voids two Sendcloud labels; the shipments go back for a new label; undo asks to buy again', async () => {
    const two = (JSON.parse(ids.shipments) as string[]).slice(0, 2)
    const { done } = await approveAndRun('void-shipping-label', { shipmentIds: two })
    expect(carrier.voided).toHaveLength(2)
    expect(await statuses(two)).toEqual(['DRAFT', 'DRAFT'])
    expect(await undoOf('void-shipping-label', done.change!)).toEqual({ tool: 'buy-shipping-label', args: { shipmentIds: two } })
    expect((await dryRun('void-shipping-label', { shipmentIds: [ids.spareShipment] })).error).toMatch(/only a printed label/)
  })
})

describe('update-shipment', () => {
  it('hold and its undo (release); service and its undo (back to none); cancel and its undo refused', async () => {
    const [a, b] = (JSON.parse(ids.shipments) as string[]).slice(0, 2)
    const held = await approveAndRun('update-shipment', { shipments: [{ shipmentId: a, action: 'hold', reason: 'Check the address' }, { shipmentId: b, action: 'service', serviceCode: '2001', serviceName: 'Test Standard' }] })
    expect(await statuses([a])).toEqual(['ON_HOLD'])
    const undo = await undoOf('update-shipment', held.done.change!)
    expect(undo).toEqual({ tool: 'update-shipment', args: { shipments: [{ shipmentId: a, action: 'release' }, { shipmentId: b, action: 'service', carrierCode: 'SENDCLOUD', serviceCode: null, serviceName: null }] } })
    if ('refusal' in undo) throw new Error(undo.refusal)
    await approveAndRun(undo.tool, undo.args)
    const back = await inside(() => database.client.shipment.findMany({ where: { id: { in: [a, b] } }, orderBy: { id: 'asc' }, select: { id: true, status: true, serviceCode: true, heldReason: true } }))
    expect(back.find((s) => s.id === a)).toMatchObject({ status: 'DRAFT', heldReason: null })
    expect(back.find((s) => s.id === b)).toMatchObject({ serviceCode: null })
    const cancelled = await approveAndRun('update-shipment', { shipments: [{ shipmentId: a, action: 'cancel' }] })
    expect(await statuses([a])).toEqual(['CANCELLED'])
    expect(await undoOf('update-shipment', cancelled.done.change!)).toEqual({ refusal: expect.stringMatching(/not brought back/) })
  })
})

describe('confirm-shipment (07 O9)', () => {
  const make = (key: string, carrierCode: string, data: Record<string, unknown> = {}) => inside(async () => {
    const order = await database.client.order.create({
      data: { channel: 'EBAY', channelOrderId: `TEST-O9-${key}`, marketplace: 'IT', status: 'PROCESSING', currencyCode: 'EUR', totalPrice: '9.00', customerName: 'Test Buyer', customerEmail: 'buyer@example.test', shippingAddress: ADDRESS, fulfillmentMethod: 'MFN', ...data } as never,
    })
    return (await database.client.shipment.create({ data: { orderId: order.id, carrierCode, status: 'LABEL_PRINTED' } as never })).id
  })
  const uploads = (shipmentId: string) => inside(() => database.client.trackingMessageLog.count({ where: { shipmentId } }))

  it('a MANUAL shipment: its tracking number set, shipped, one upload queued (the mode said); cannot be confirmed twice', async () => {
    const id = await make('MANUAL', 'MANUAL')
    const args = { shipments: [{ shipmentId: id, trackingNumber: 'TEST-O9-TRACK', carrierName: 'GLS' }] }
    const { asked } = await approveAndRun('confirm-shipment', args)
    expect(asked.preview.shipments[0]).toMatchObject({ channel: 'EBAY', trackingNumber: 'TEST-O9-TRACK', upload: 'uploaded to EBAY: dry run (NEXUS_ENABLE_EBAY_SHIP_CONFIRM off)' })
    expect(await statuses([id])).toEqual(['SHIPPED'])
    expect(await uploads(id)).toBe(1)
    expect((await dryRun('confirm-shipment', args)).error).toMatch(/is SHIPPED/)
  })

  it("a Sendcloud parcel: shipped; its upload waits for the carrier's scan", async () => {
    const id = await make('SENDCLOUD', 'SENDCLOUD')
    const { asked } = await approveAndRun('confirm-shipment', { shipments: [{ shipmentId: id }] })
    expect(asked.preview.shipments[0].upload).toMatch(/first scan/)
    expect(await uploads(id)).toBe(0)
  })

  it('refused for an order Amazon ships; stale when a channel switch flips to live after the approval', async () => {
    const fba = await make('FBA', 'MANUAL', { channel: 'AMAZON', fulfillmentMethod: 'FBA' })
    expect((await dryRun('confirm-shipment', { shipments: [{ shipmentId: fba, trackingNumber: 'X' }] })).error).toMatch(/Amazon ships this order/)
    const id = await make('STALE', 'MANUAL')
    const args = { shipments: [{ shipmentId: id, trackingNumber: 'TEST-O9-STALE' }] }
    const asked = await dryRun('confirm-shipment', args)
    vi.stubEnv('NEXUS_ENABLE_EBAY_SHIP_CONFIRM', 'true')
    const done = await run('confirm-shipment', args, asked.preview)
    vi.unstubAllEnvs()
    expect(done.error).toMatch(/changed since you approved it \(shipments\)/)
    expect(await statuses([id])).toEqual(['LABEL_PRINTED'])
  })
})

