/**
 * MCP full control 08 S13 — plan-fba-shipment and fba-shipment-options (decided S-3: Claude creates the plan; confirming
 * packing, placement and transport with Amazon's fees stays a person's click in Nexus).
 *
 *   The plan is created at Amazon (client mocked: nothing leaves the machine) with the products' SKUs, the market's
 *   Amazon id and the address given; it writes NO quantity — every StockLevel, the products' totals and every listing's
 *   quantity are unchanged. A non-FBA inbound shipment cannot be linked. The options are read without writing the plan
 *   row; transport needs one of the plan's Amazon shipments; a plan not created at Amazon yet is said so.
 *
 * Real SQL (PGlite with the production schema); the FBA Inbound v2024-03-20 client is mocked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return {
    default: new Proxy({}, {
      get: (_target, property) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), property),
    }),
  }
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
const amazon = vi.hoisted(() => ({ created: [] as any[], reads: [] as string[] }))
vi.mock('../../clients/amazon-fba-inbound-v2.client.js', () => ({
  createInboundPlan: vi.fn(async (input: unknown) => { amazon.created.push(input); return { operationId: 'TEST-OP-1' } }),
  getInboundOperation: vi.fn(async () => ({ operationId: 'TEST-OP-1', operationStatus: 'SUCCESS', operationProblems: [], planId: 'TEST-PLAN-1' })),
  listPackingOptions: vi.fn(async (planId: string) => {
    amazon.reads.push(`packing:${planId}`)
    return { packingOptions: [{ packingOptionId: 'TEST-PACK-1', status: 'OFFERED', packingGroups: ['g1', 'g2'], packingFeatures: [], fees: [{ type: 'FBA_PREP', value: { amount: 12.5, currencyCode: 'EUR' } }] }] }
  }),
  listPlacementOptions: vi.fn(async () => ({ placementOptions: [{ placementOptionId: 'TEST-PLACE-1', status: 'OFFERED', shipmentIds: ['TEST-SHIP-1'], fees: [] }] })),
  listTransportationOptions: vi.fn(async () => ({ transportationOptions: [{ transportationOptionId: 'TEST-TR-1', carrier: { name: 'TEST carrier' }, shippingMode: 'SMALL_PARCEL', quote: { cost: { amount: 40, currencyCode: 'EUR' } } }] })),
  confirmPackingOption: vi.fn(), confirmPlacementOption: vi.fn(), confirmTransportationOptions: vi.fn(), getShipmentLabels: vi.fn(),
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const ids = { jacket: '', location: '', supplierShipment: '' }
const ADDRESS = { name: 'Test Sender', addressLine1: 'Via Test 1', city: 'Testville', stateOrProvinceCode: 'TS', postalCode: '00000', countryCode: 'it', email: 'ship@example.test' }

type Tool = import('../agents/tool-types.js').AgentTool
const tools: Record<string, Tool> = {}
const person = { userId: 'u-approver', can: () => true, via: 'claude' as const }
const run = (name: string, raw: Record<string, unknown>, mode: 'handler' | 'execute' = 'handler') => {
  const args = tools[name].input.parse(raw) as Record<string, unknown>
  return inside(() => (mode === 'handler' ? tools[name].handler(args, person) : tools[name].execute!(args, person)))
}
/** Every quantity Nexus holds for the product: stock levels, its total, its listings. */
const quantities = () => inside(async () => ({
  levels: (await database.client.stockLevel.findMany({ orderBy: { id: 'asc' }, select: { quantity: true, reserved: true, available: true } })),
  total: (await database.client.product.findUniqueOrThrow({ where: { id: ids.jacket }, select: { totalStock: true } })).totalStock,
  listings: (await database.client.channelListing.findMany({ orderBy: { id: 'asc' }, select: { quantity: true } })),
}))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    await db.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'TEST-MKT-IT' } as never })
    ids.jacket = (await db.product.create({ data: { sku: 'TEST-SKU-S13-FBA', name: 'Test jacket', basePrice: '100.00', totalStock: 12 } })).id
    ids.location = (await db.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'AMAZON-EU-FBA', name: 'Amazon FBA' } })).id
    await db.stockLevel.create({ data: { productId: ids.jacket, locationId: ids.location, quantity: 4, reserved: 0, available: 4 } })
    await db.channelListing.create({ data: { productId: ids.jacket, channelMarket: 'AMAZON_IT', channel: 'AMAZON', region: 'IT', marketplace: 'IT', price: '100.00', quantity: 4, listingStatus: 'ACTIVE', fulfillmentMethod: 'FBA' } as never })
    ids.supplierShipment = (await db.inboundShipment.create({ data: { type: 'SUPPLIER', status: 'IN_TRANSIT', reference: 'TEST-SUPPLIER-DELIVERY' } })).id
  })
  const { getTool } = await import('../agents/tool-registry.js')
  for (const name of ['plan-fba-shipment', 'fba-shipment-options']) tools[name] = getTool(name)!
}, 180_000)

afterAll(async () => {
  await database?.close()
})

describe('08 S13 — FBA inbound plans', () => {
  it('plan-fba-shipment: creates the plan at Amazon and writes no quantity anywhere', async () => {
    expect((await run('plan-fba-shipment', { marketplace: 'DE', lines: [{ productId: ids.jacket, quantity: 6 }], sourceAddress: ADDRESS })).error).toBe('No Amazon marketplace DE in this business (see the Amazon markets in Nexus).')
    expect((await run('plan-fba-shipment', { marketplace: 'IT', lines: [{ productId: ids.jacket, quantity: 6 }], sourceAddress: ADDRESS, shipmentId: ids.supplierShipment })).error)
      .toBe('shipment "TEST-SUPPLIER-DELIVERY" is not an FBA shipment (it is SUPPLIER): link an FBA shipment, or none.')
    const dry = await run('plan-fba-shipment', { marketplace: 'it', lines: [{ productId: ids.jacket, quantity: 6 }], sourceAddress: ADDRESS, name: 'TEST plan' })
    expect(dry, dry.error).toMatchObject({ ok: true, preview: { marketplace: 'IT', name: 'TEST plan', lines: [{ sku: 'TEST-SKU-S13-FBA', quantity: 6, ownStockNow: 12 }], totals: { skus: 1, units: 6 }, note: expect.stringContaining('Claude cannot confirm') } })
    expect(amazon.created).toEqual([])
    const before = await quantities()
    const ran = await run('plan-fba-shipment', { marketplace: 'IT', lines: [{ productId: ids.jacket, quantity: 6 }], sourceAddress: ADDRESS, name: 'TEST plan' }, 'execute')
    expect(ran, ran.error).toMatchObject({ ok: true, data: { planId: expect.any(String) } })
    expect(amazon.created).toEqual([{
      name: 'TEST plan', destinationMarketplaces: ['TEST-MKT-IT'], msku: 'TEST-SKU-S13-FBA', items: [{ msku: 'TEST-SKU-S13-FBA', quantity: 6 }],
      sourceAddress: { name: 'Test Sender', addressLine1: 'Via Test 1', city: 'Testville', stateOrProvinceCode: 'TS', postalCode: '00000', countryCode: 'IT', email: 'ship@example.test' },
    }])
    expect(await inside(() => database.client.fbaInboundPlanV2.findUniqueOrThrow({ where: { id: (ran.data as { planId: string }).planId }, select: { planId: true, status: true, createdBy: true } })))
      .toEqual({ planId: 'TEST-PLAN-1', status: 'ACTIVE', createdBy: 'u-approver' })
    expect(await quantities()).toEqual(before)
  })

  it('fba-shipment-options: reads packing, placement and transport live, writing nothing; transport names a shipment', async () => {
    const plan = await inside(() => database.client.fbaInboundPlanV2.findFirstOrThrow({ where: { planId: 'TEST-PLAN-1' } }))
    const packing = await run('fba-shipment-options', { planId: plan.id })
    expect(packing, packing.error).toMatchObject({ ok: true, data: { packing: [{ packingOptionId: 'TEST-PACK-1', packingGroups: 2, fees: [{ type: 'FBA_PREP', amount: 12.5, currencyCode: 'EUR' }] }] } })
    expect(await inside(() => database.client.fbaInboundPlanV2.findUniqueOrThrow({ where: { id: plan.id }, select: { status: true, currentStep: true } }))).toEqual({ status: plan.status, currentStep: plan.currentStep })
    expect((await run('fba-shipment-options', { planId: plan.id, kind: 'transport' })).error).toBe('"TEST plan" has no Amazon shipments yet: placement is confirmed first, by a person in Nexus.')
    await inside(() => database.client.fbaInboundPlanV2.update({ where: { id: plan.id }, data: { shipmentIds: ['TEST-SHIP-1'] } }))
    const transport = await run('fba-shipment-options', { planId: plan.id, kind: 'transport', amazonShipment: 'TEST-SHIP-1' })
    expect(transport, transport.error).toMatchObject({ ok: true, data: { transport: [{ transportationOptionId: 'TEST-TR-1', carrier: 'TEST carrier', quote: { amount: 40, currencyCode: 'EUR' } }] } })
    const pending = await inside(() => database.client.fbaInboundPlanV2.create({ data: { name: 'TEST pending', status: 'CREATING', currentStep: 'CREATE' } }))
    expect(await run('fba-shipment-options', { planId: pending.id })).toEqual({ ok: false, error: '"TEST pending" is not created at Amazon yet (CREATING).' })
    expect(await run('fba-shipment-options', { planId: 'nope' })).toEqual({ ok: false, error: 'FBA plan not found' })
  })
})
