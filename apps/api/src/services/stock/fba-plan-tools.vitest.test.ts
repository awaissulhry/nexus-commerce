/**
 * MCP full control 08 S13 — plan-fba-shipment and fba-shipment-options (decided S-3: Claude plans the shipment; confirming
 * where it goes, with Amazon's fees, stays a person's click in Nexus). Step 4 (2026-10-07): both run on the Matrix's
 * Send to FBA services. Drafts (Owner 2026-10-08): the plan tool fills the ONE open draft for the warehouse and market.
 *
 *   plan-fba-shipment   the dry run shows the lines, boxes and what "Send to Amazon" would refuse today (owners not set →
 *                       "set them in the Matrix Case column", more than free, a case size the SKU lacks) and writes
 *                       nothing; refused only when nothing can be drafted (no Amazon account in the market, a plain case
 *                       count for a SKU without one case size). On approval the SKUs go into the draft (source claude, the
 *                       approver as actor): nothing is held, nothing dispatched, no quantity moves. A person's "Send to
 *                       Amazon" then holds the units and starts the job.
 *   fba-shipment-options reads the plan's stored status, steps and options (Amazon is not called; nothing is written).
 *
 * Real SQL (PGlite with the production schema); the job (dispatchFbaPlan) is a spy: nothing reaches Amazon.
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
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
const s = vi.hoisted(() => ({ account: '' }))
vi.mock('../../lib/amazon-sp-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/amazon-sp-client.js')>()),
  amazonAccount: vi.fn(async () => { if (!s.account) throw new Error('no Amazon account'); return { id: s.account } }),
}))
vi.mock('../stock-movement.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stock-movement.service.js')>()),
  recascadeProduct: vi.fn(async () => ({ ok: true })),
}))
/** The contract with the real Part C services behind it (loaded at call time) and Part B's job as a spy. */
vi.mock('../fba-inbound/contract.js', () => {
  const HTTP: Record<string, number> = { NOT_FOUND: 404, REFUSED: 400, WRONG_STATE: 409, OPTION_UNKNOWN: 400, OPTIONS_EXPIRED: 409, NEEDS_PERSON: 403, TRACKING_INVALID: 400, LABELS_UNAVAILABLE: 409, DRAFT_EXISTS: 409, NOT_BUILT: 501 }
  class FbaSendError extends Error {
    constructor(readonly code: string, message: string, readonly problems: unknown[] = []) { super(message); this.name = 'FbaSendError' }
    get httpStatus() { return HTTP[this.code] }
  }
  const sendFn = (name: string) => async (...args: unknown[]) => ((await import('../fba-inbound/send.service.js')) as any)[name](...args)
  const readFn = (name: string) => async (...args: unknown[]) => ((await import('../fba-inbound/read.service.js')) as any)[name](...args)
  const draftFn = (name: string) => async (...args: unknown[]) => ((await import('../fba-inbound/draft.service.js')) as any)[name](...args)
  return {
    FbaSendError, dispatchFbaPlan: vi.fn(async () => 'inline'),
    readSendDraft: sendFn('readSendDraft'), createSendPlan: sendFn('createSendPlan'), readPlan: readFn('readPlan'), readPlans: readFn('readPlans'),
    addToDraft: draftFn('addToDraft'), sendDraft: draftFn('sendDraft'),
  }
})

import { dispatchFbaPlan } from '../fba-inbound/contract.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const ids = { jacket: '', boots: '', main: '', fba: '', account: '' }

type Tool = import('../agents/tool-types.js').AgentTool
const tools: Record<string, Tool> = {}
const person = { userId: 'u-approver', can: () => true, via: 'claude' as const }
const run = (name: string, raw: Record<string, unknown>, mode: 'handler' | 'execute' = 'handler') => {
  const args = tools[name].input.parse(raw) as Record<string, unknown>
  return inside(() => (mode === 'handler' ? tools[name].handler(args, person as never) : tools[name].execute!(args, person as never)))
}
/** Every quantity Nexus holds for the jacket: stock levels, its total, its listings. */
const quantities = () => inside(async () => ({
  levels: (await database.client.stockLevel.findMany({ where: { productId: ids.jacket }, orderBy: { id: 'asc' }, select: { locationId: true, quantity: true } })),
  total: (await database.client.product.findUniqueOrThrow({ where: { id: ids.jacket }, select: { totalStock: true } })).totalStock,
  listings: (await database.client.channelListing.findMany({ where: { productId: ids.jacket }, orderBy: { id: 'asc' }, select: { quantity: true } })),
}))

beforeAll(async () => {
  vi.stubEnv('NEXUS_ISSUER_NAME', '')
  vi.stubEnv('NEXUS_ISSUER_PHONE', '')
  database = await formulaDatabase()
  await inside(async () => {
    const db = database.client
    const warehouse = (await db.warehouse.create({ data: { code: 'TEST-MAIN', name: 'Main', addressLine1: 'Via Test 1', city: 'Testville', postalCode: '00000', country: 'IT', isDefault: true } })).id
    ids.main = (await db.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-MAIN', name: 'Main warehouse', warehouseId: warehouse } })).id
    ids.fba = (await db.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'AMAZON-EU-FBA', name: 'Amazon FBA' } })).id
    await db.brandSettings.create({ data: { companyName: 'Test Company', contactPhone: '+39 000 000' } })
    ids.account = (await db.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'test-s13', externalAccountId: 'TEST-SELLER', isActive: true } as never })).id
    s.account = ids.account
    await db.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'TEST-MKT-IT' } as never })
    ids.jacket = (await db.product.create({ data: { sku: 'TEST-SKU-S13-FBA', name: 'Test jacket', basePrice: '100.00', totalStock: 12, weightValue: '1.2', weightUnit: 'kg' } as never })).id
    ids.boots = (await db.product.create({ data: { sku: 'TEST-SKU-S13-BOOTS', name: 'Test boots', basePrice: '80.00', totalStock: 6, weightValue: '2', weightUnit: 'kg' } as never })).id
    await db.productPackage.create({ data: { productId: ids.jacket, fbaPrepOwner: 'SELLER', fbaLabelOwner: 'SELLER' } })
    await db.stockLevel.create({ data: { productId: ids.jacket, locationId: ids.main, quantity: 12, reserved: 0, available: 12 } })
    await db.stockLevel.create({ data: { productId: ids.boots, locationId: ids.main, quantity: 6, reserved: 0, available: 6 } })
    await db.stockLevel.create({ data: { productId: ids.jacket, locationId: ids.fba, quantity: 4, reserved: 0, available: 4 } })
    for (const productId of [ids.jacket, ids.boots]) {
      await db.channelListing.create({ data: { productId, channelMarket: 'AMAZON_IT', channel: 'AMAZON', region: 'IT', marketplace: 'IT', channelConnectionId: ids.account, aliasKey: '', price: '100.00', quantity: 4, listingStatus: 'ACTIVE', fulfillmentMethod: 'FBA' } as never })
    }
  })
  const { getTool } = await import('../agents/tool-registry.js')
  for (const name of ['plan-fba-shipment', 'fba-shipment-options']) tools[name] = getTool(name)!
}, 180_000)

afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
})

describe('08 S13 — FBA plans through the Send to FBA services', () => {
  it('plan-fba-shipment: the dry run shows the lines and what "Send to Amazon" would refuse, and writes nothing', async () => {
    expect((await run('plan-fba-shipment', { marketplace: 'DE', lines: [{ productId: ids.jacket, units: 6 }] })).error)
      .toBe('No Amazon account sells in DE. Nothing was changed.')
    // Cases name their size; a plain number stands for the SKU's one case size — the jacket has none.
    expect((await run('plan-fba-shipment', { marketplace: 'IT', lines: [{ productId: ids.jacket, cases: 1 }] })).error)
      .toBe('TEST-SKU-S13-FBA: No case size — set it in the Matrix (Case column). Nothing was changed.')
    const boots = await run('plan-fba-shipment', { marketplace: 'IT', lines: [{ productId: ids.boots, units: 2 }] })
    expect(boots, boots.error).toMatchObject({ ok: true, preview: { beforeSending: ['TEST-SKU-S13-BOOTS: choose who preps and labels (Prep by / Labels by) — Set Prep by / Labels by in the Matrix Case column first.'] } })
    const many = await run('plan-fba-shipment', { marketplace: 'IT', lines: [{ productId: ids.jacket, units: 20 }] })
    expect(many, many.error).toMatchObject({ ok: true, preview: { beforeSending: ['TEST-SKU-S13-FBA: 20 units asked; 12 free at TEST-MAIN.'] } })
    const size = await run('plan-fba-shipment', { marketplace: 'IT', lines: [{ productId: ids.jacket, cases: [{ unitsPerCase: 6, cases: 1 }] }] })
    expect(size, size.error).toMatchObject({ ok: true, preview: { beforeSending: ['TEST-SKU-S13-FBA: No 6 / case size — set it in the Matrix (Case column).'] } })
    const dry = await run('plan-fba-shipment', { marketplace: 'it', lines: [{ productId: ids.jacket, quantity: 6 }] })
    expect(dry, dry.error).toMatchObject({ ok: true, preview: {
      summary: 'Add 6 units of 1 SKUs to the FBA draft from TEST-MAIN to Amazon IT. Nothing is held or sent to Amazon.',
      marketplace: 'IT', from: { code: 'TEST-MAIN', town: 'Testville' }, draft: { existing: false },
      lines: [{ sku: 'TEST-SKU-S13-FBA', cases: [], units: 6, quantity: 6, freeNow: 12, prepBy: 'SELLER', labelsBy: 'SELLER' }],
      totals: { skus: 1, units: 6, boxes: 1, mixedBoxes: 1 }, note: expect.stringContaining('Claude cannot confirm'),
    } })
    expect((dry.preview as { note: string }).note).toContain('Send to Amazon')
    expect((dry.preview as Record<string, unknown>).beforeSending).toBeUndefined()
    expect(await inside(() => database.client.fbaInboundPlanV2.count())).toBe(0)
    expect(dispatchFbaPlan).not.toHaveBeenCalled()
  })

  it('on approval: the SKUs go into the ONE draft (source claude, the approver as actor), nothing held or dispatched; a person sends it', async () => {
    const before = await quantities()
    const ran = await run('plan-fba-shipment', { marketplace: 'IT', lines: [{ productId: ids.jacket, units: 6 }] }, 'execute')
    expect(ran, ran.error).toMatchObject({ ok: true, data: { planId: expect.any(String), draft: true, units: 6, next: expect.stringContaining('Send to Amazon') } })
    const planId = (ran.data as { planId: string }).planId
    expect(await inside(() => database.client.fbaInboundPlanV2.findUniqueOrThrow({ where: { id: planId }, select: { status: true, source: true, createdBy: true, planId: true, confirmedBy: true } })))
      .toEqual({ status: 'DRAFT', source: 'claude', createdBy: 'u-approver', planId: null, confirmedBy: null })
    // The same SKU again takes the new numbers in the same draft.
    const again = await run('plan-fba-shipment', { marketplace: 'IT', lines: [{ productId: ids.jacket, units: 4 }] }, 'execute')
    expect((again.data as { planId: string }).planId).toBe(planId)
    expect(await inside(() => database.client.fbaInboundPlanLine.findMany({ where: { planRowId: planId }, select: { productId: true, quantity: true, msku: true, reservationId: true } })))
      .toEqual([{ productId: ids.jacket, quantity: 4, msku: null, reservationId: null }])
    expect(dispatchFbaPlan).not.toHaveBeenCalled()
    expect(await inside(() => database.client.stockLevel.findFirstOrThrow({ where: { productId: ids.jacket, locationId: ids.main }, select: { quantity: true, reserved: true, available: true } })))
      .toEqual({ quantity: 12, reserved: 0, available: 12 })
    expect(await quantities()).toEqual(before)

    // A person's "Send to Amazon" (the FBA shipments page): the units are held, the job starts.
    const { sendDraft } = await import('../fba-inbound/draft.service.js')
    expect(await inside(() => sendDraft(planId, {}, { actor: 'owner@example.test', userId: 'u-owner' }))).toEqual({ planId })
    expect(await inside(() => database.client.fbaInboundPlanV2.findUniqueOrThrow({ where: { id: planId }, select: { status: true, source: true } }))).toEqual({ status: 'QUEUED', source: 'claude' })
    expect(dispatchFbaPlan).toHaveBeenCalledWith(planId)
    expect(await inside(() => database.client.stockLevel.findFirstOrThrow({ where: { productId: ids.jacket, locationId: ids.main }, select: { quantity: true, reserved: true, available: true } })))
      .toEqual({ quantity: 12, reserved: 4, available: 8 })
  })

  it('fba-shipment-options: reads the stored status, steps and options (Amazon not called, nothing written); an unknown plan is said so', async () => {
    const plan = await inside(() => database.client.fbaInboundPlanV2.findFirstOrThrow({ where: { source: 'claude' } }))
    const queued = await run('fba-shipment-options', { planId: plan.id })
    expect(queued, queued.error).toMatchObject({ ok: true, data: { plan: { id: plan.id, status: 'QUEUED', statusText: 'Queued', market: 'IT', from: 'TEST-MAIN', units: 4 }, options: null, can: { cancel: true, choose: false } } })
    const options = {
      readAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      placements: [{ placementOptionId: 'po-1', status: 'OFFERED', expiresAt: null, fees: [{ type: 'FEE', target: 'Placement Services', description: null, value: { amount: 0, currency: 'EUR' } }], discounts: [],
        shipments: [{ shipmentId: 'sh-1', destinationFc: 'MXP5', destinationTown: null, deliveryWindows: [{ deliveryWindowOptionId: 'dw-1', start: '2026-10-14', end: '2026-10-21', availabilityType: null, validUntil: null }],
          transport: [{ transportationOptionId: 'to-1', shipmentId: 'sh-1', carrierName: 'BRT', carrierCode: 'BRT', shippingMode: 'GROUND_SMALL_PARCEL', shippingSolution: 'USE_YOUR_OWN_CARRIER', quote: null, preconditions: [] }] }] }],
    }
    await inside(() => database.client.fbaInboundPlanV2.update({ where: { id: plan.id }, data: { status: 'WAITING_FOR_CHOICE', currentStep: 'CONFIRM', options: options as never } }))
    const waiting = await run('fba-shipment-options', { planId: plan.id })
    expect(waiting, waiting.error).toMatchObject({ ok: true, data: {
      plan: { status: 'WAITING_FOR_CHOICE' }, can: { choose: true },
      options: { placements: [{ placementOptionId: 'po-1', fees: [{ type: 'FEE' }], shipments: [{ shipmentId: 'sh-1', fulfilmentCentre: 'MXP5', transport: [{ transportationOptionId: 'to-1', carrier: 'BRT' }], deliveryWindows: [{ deliveryWindowOptionId: 'dw-1' }] }] }] },
    } })
    expect(await inside(() => database.client.fbaInboundPlanV2.findUniqueOrThrow({ where: { id: plan.id }, select: { status: true, confirmedBy: true } }))).toEqual({ status: 'WAITING_FOR_CHOICE', confirmedBy: null })
    expect(await run('fba-shipment-options', { planId: 'nope' })).toEqual({ ok: false, error: 'FBA plan not found' })
  })
})
