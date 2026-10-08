/**
 * Step 4 Send to FBA (Part C) — "Mark shipped" and the box labels.
 *
 *   shipped    one transaction per Amazon shipment: per SKU the hold is released and what other shipments still take is
 *              held again; FBA_TRANSFER_OUT of the shipped units at the From WAREHOUSE with casesChange = −(its sealed case
 *              boxes, per case size: 2×12 + 1×6 here) — sealed cases leave sealed, loose units leave loose; `shippedQuantity` grows; the plan goes to
 *              TRACKING (SHIPPED when every shipment is). `available` does not move (the units were held). The FBA level
 *              is never written.
 *   twice      a second "Mark shipped" of the same shipment is a no-op that answers the plan: no second movement.
 *   refusals   one tracking number per box (unknown, missing, twice, empty); only when the plan is ready to ship.
 *   guard      FBA_TRANSFER_OUT / FBA_TRANSFER_IN are refused at an AMAZON_FBA and a SHOPIFY_LOCATION location.
 *   labels     v0 getLabels with the FBA15… id, A4 four per page, one UNIQUE label per box; no boxes / no link → 409.
 *
 * Real SQL (PGlite with the production schema and row-level security); Amazon's label call and Part B's dispatch are spies.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextWorkingDay, type FbaShipmentBox } from '@nexus/shared/fba-send'
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
vi.mock('../product-read-cache.service.js', () => ({ productReadCacheService: { refresh: vi.fn(async () => undefined), refreshMany: vi.fn(async () => undefined), refreshInTransaction: vi.fn(async () => undefined) } }))
const s = vi.hoisted(() => ({ account: '', labels: [] as unknown[], labelError: null as string | null }))
vi.mock('../../lib/amazon-sp-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/amazon-sp-client.js')>()),
  amazonAccount: vi.fn(async () => { if (!s.account) throw new Error('no Amazon account'); return { id: s.account } }),
}))
vi.mock('../fba-inbound.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fba-inbound.service.js')>()),
  getInboundShipmentLabels: vi.fn(async (args: unknown) => {
    s.labels.push(args)
    if (s.labelError) throw new Error(s.labelError)
    return { downloadUrl: 'https://labels.example.test/fresh.pdf' }
  }),
}))
vi.mock('../stock-movement.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stock-movement.service.js')>()),
  recascadeProduct: vi.fn(async () => ({ ok: true })),
}))
vi.mock('./contract.js', () => {
  const HTTP: Record<string, number> = { NOT_FOUND: 404, REFUSED: 400, WRONG_STATE: 409, OPTION_UNKNOWN: 400, OPTIONS_EXPIRED: 409, NEEDS_PERSON: 403, TRACKING_INVALID: 400, LABELS_UNAVAILABLE: 409, NOT_BUILT: 501 }
  class FbaSendError extends Error {
    constructor(readonly code: string, message: string, readonly problems: unknown[] = []) { super(message); this.name = 'FbaSendError' }
    get httpStatus() { return HTTP[this.code] }
  }
  return { FbaSendError, dispatchFbaPlan: vi.fn(async () => 'inline') }
})

import { dispatchFbaPlan } from './contract.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
const ids = { main: '', fba: '', shopify: '', a: '', b: '', account: '', plan: '', s1: '', s2: '' }
const person = { actor: 'owner@example.test', userId: 'u-owner' }
let ship: typeof import('./ship.service.js')
let send: typeof import('./send.service.js')

const level = (productId: string, locationId = ids.main) => inside(() => db().stockLevel.findFirstOrThrow({ where: { productId, locationId }, select: { id: true, quantity: true, reserved: true, available: true } }))
/** The stored sealed cases at From, per case size (biggest first). */
const sealed = async (productId: string) => {
  const l = await level(productId)
  const rows = await inside(() => db().stockCaseCount.findMany({ where: { stockLevelId: l.id }, select: { cases: true, caseSize: { select: { unitsPerCase: true } } } }))
  return rows.map((r) => ({ unitsPerCase: r.caseSize.unitsPerCase, cases: r.cases })).sort((x, y) => y.unitsPerCase - x.unitsPerCase)
}
const movements = (productId: string) => inside(() => db().stockMovement.findMany({ where: { productId, reason: 'FBA_TRANSFER_OUT' }, select: { change: true, locationId: true, referenceType: true, referenceId: true, actor: true, notes: true } }))
const lineOf = (productId: string) => inside(() => db().fbaInboundPlanLine.findFirstOrThrow({ where: { planRowId: ids.plan, productId }, select: { shippedQuantity: true, reservationId: true } }))
const caught = async (work: () => Promise<unknown>) => { try { await work(); return null } catch (error) { return error as { code: string; message: string } } }

/** S1: A as 2 sealed case boxes of 12, 1 sealed case box of 6 + one mixed box (A 3, B 2). S2: one mixed box (B 2). */
const S1_BOXES: FbaShipmentBox[] = [
  { boxId: 'FBA15TEST1U000001', kind: 'case', lengthCm: 40, widthCm: 30, heightCm: 30, weightKg: 7, items: [{ msku: 'A-IT', quantity: 12 }] },
  { boxId: 'FBA15TEST1U000002', kind: 'case', lengthCm: 40, widthCm: 30, heightCm: 30, weightKg: 7, items: [{ msku: 'A-IT', quantity: 12 }] },
  { boxId: 'FBA15TEST1U000004', kind: 'case', lengthCm: 30, widthCm: 20, heightCm: 30, weightKg: 3.6, items: [{ msku: 'A-IT', quantity: 6 }] },
  { boxId: 'FBA15TEST1U000003', kind: 'mixed', lengthCm: 60, widthCm: 40, heightCm: 40, weightKg: 4.7, items: [{ msku: 'A-IT', quantity: 3 }, { msku: 'TEST-SHIP-B', quantity: 2 }] },
]
const S2_BOXES: FbaShipmentBox[] = [{ boxId: 'FBA15TEST2U000001', kind: 'mixed', lengthCm: 60, widthCm: 40, heightCm: 40, weightKg: 3.2, items: [{ msku: 'TEST-SHIP-B', quantity: 2 }] }]
const tracking = (boxes: FbaShipmentBox[]) => ({ tracking: boxes.map((box, i) => ({ boxId: box.boxId, trackingId: `TRK-${i + 1}` })) })

beforeAll(async () => {
  vi.stubEnv('NEXUS_ISSUER_NAME', '')
  vi.stubEnv('NEXUS_ISSUER_PHONE', '')
  database = await formulaDatabase()
  await inside(async () => {
    const d = db()
    const warehouse = (await d.warehouse.create({ data: { code: 'TEST-MAIN', name: 'Main', addressLine1: 'Via Test 1', city: 'Testville', postalCode: '00000', country: 'IT', isDefault: true } })).id
    ids.main = (await d.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-MAIN', name: 'Main warehouse', warehouseId: warehouse } })).id
    ids.fba = (await d.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'TEST-FBA', name: 'Amazon FBA' } })).id
    ids.shopify = (await d.stockLocation.create({ data: { type: 'SHOPIFY_LOCATION', code: 'TEST-SHOPIFY', name: 'Shopify' } })).id
    await d.brandSettings.create({ data: { companyName: 'Test Company', contactPhone: '+39 000 000' } })
    ids.account = (await d.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'test-ship', externalAccountId: 'TEST-SELLER', isActive: true } as never })).id
    s.account = ids.account
    await d.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'TEST-MKT-IT' } as never })
    ids.a = (await d.product.create({ data: { sku: 'TEST-SHIP-A', name: 'A', basePrice: '10.00', weightValue: '0.5', weightUnit: 'kg', totalStock: 57 } as never })).id
    ids.b = (await d.product.create({ data: { sku: 'TEST-SHIP-B', name: 'B', basePrice: '10.00', weightValue: '1', weightUnit: 'kg', totalStock: 10 } as never })).id
    const levelA = await d.stockLevel.create({ data: { productId: ids.a, locationId: ids.main, quantity: 57, reserved: 0, available: 57 } })
    await d.stockLevel.create({ data: { productId: ids.b, locationId: ids.main, quantity: 10, reserved: 0, available: 10 } })
    await d.stockLevel.create({ data: { productId: ids.a, locationId: ids.fba, quantity: 5, reserved: 0, available: 5 } })
    await d.productPackage.create({ data: { productId: ids.a, fbaPrepOwner: 'SELLER', fbaLabelOwner: 'SELLER' } })
    await d.productPackage.create({ data: { productId: ids.b, fbaPrepOwner: 'SELLER', fbaLabelOwner: 'AMAZON' } })
    // A: 57 = 4×12 + 1×6 + 3 loose.
    const a12 = await d.productCaseSize.create({ data: { productId: ids.a, unitsPerCase: 12, caseLengthCm: '40', caseWidthCm: '30', caseHeightCm: '30', caseWeightKg: '7' } })
    const a6 = await d.productCaseSize.create({ data: { productId: ids.a, unitsPerCase: 6, caseLengthCm: '30', caseWidthCm: '20', caseHeightCm: '30', caseWeightKg: '3.6' } })
    await d.stockCaseCount.create({ data: { stockLevelId: levelA.id, caseSizeId: a12.id, cases: 4 } })
    await d.stockCaseCount.create({ data: { stockLevelId: levelA.id, caseSizeId: a6.id, cases: 1 } })
    const listing = (productId: string, data: Record<string, unknown> = {}) => d.channelListing.create({ data: {
      productId, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', channelConnectionId: ids.account, aliasKey: '',
      listingStatus: 'ACTIVE', isPublished: true, fulfillmentMethod: 'FBA', ...data } as never })
    await listing(ids.a, { liveChannelSku: 'A-IT' })
    await listing(ids.b)
  })
  ship = await import('./ship.service.js')
  send = await import('./send.service.js')
  // The plan as the Matrix creates it (holds A 33 = 2×12 + 1×6 + 3, B 4), then — as the job leaves it — confirmed, two
  // shipments, ready.
  ids.plan = (await inside(() => send.createSendPlan({ from: 'TEST-MAIN', market: 'IT', readyToShipOn: nextWorkingDay(send.romeToday()),
    lines: [{ productId: ids.a, cases: [{ unitsPerCase: 12, cases: 2 }, { unitsPerCase: 6, cases: 1 }], looseUnits: 3 }, { productId: ids.b, cases: [], looseUnits: 4 }] }, person, 'matrix'))).planId
  await inside(async () => {
    const d = db()
    const shipment = (shipmentId: string, boxes: FbaShipmentBox[], items: Array<[string, number]>) => d.fBAShipment.create({ data: {
      shipmentId, destinationFC: 'MXP5', planRowId: ids.plan, amazonShipmentId: `sh-${shipmentId}`, sourceLocationId: ids.main, boxes: boxes as never,
      items: { create: items.map(([productId, quantitySent]) => ({ productId, quantitySent })) } } }).then((row) => row.id)
    ids.s1 = await shipment('FBA15TEST1', S1_BOXES, [[ids.a, 33], [ids.b, 2]])
    ids.s2 = await shipment('FBA15TEST2', S2_BOXES, [[ids.b, 2]])
    await d.fbaInboundPlanV2.update({ where: { id: ids.plan }, data: { status: 'CONFIRMING', currentStep: 'LABELS', planId: 'wf-test-ship', confirmedBy: 'u-owner', confirmedAt: new Date() } })
  })
}, 180_000)

beforeEach(() => { vi.mocked(dispatchFbaPlan).mockClear(); s.labels.length = 0; s.labelError = null })
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() })

describe('markShipped — the units leave the From warehouse', () => {
  it('refused until the plan is ready to ship, and without exactly one tracking number per box', async () => {
    expect(await caught(() => inside(() => ship.markShipped(ids.s1, tracking(S1_BOXES), person)))).toMatchObject({ code: 'WRONG_STATE' })
    await inside(() => db().fbaInboundPlanV2.update({ where: { id: ids.plan }, data: { status: 'READY_TO_SHIP', currentStep: 'TRACKING' } }))
    const bad = async (body: unknown) => (await caught(() => inside(() => ship.markShipped(ids.s1, body as never, person))))?.code
    expect(await bad({})).toBe('TRACKING_INVALID')
    expect(await bad({ tracking: tracking(S1_BOXES).tracking.slice(0, 2) })).toBe('TRACKING_INVALID')
    expect(await bad({ tracking: [...tracking(S1_BOXES).tracking, { boxId: 'FBA15OTHER', trackingId: 'X' }] })).toBe('TRACKING_INVALID')
    expect(await bad({ tracking: [tracking(S1_BOXES).tracking[0], tracking(S1_BOXES).tracking[0], tracking(S1_BOXES).tracking[2]] })).toBe('TRACKING_INVALID')
    expect(await bad({ tracking: tracking(S1_BOXES).tracking.map((t) => ({ ...t, trackingId: ' ' })) })).toBe('TRACKING_INVALID')
    expect(await caught(() => inside(() => ship.markShipped('no-such-shipment', tracking(S1_BOXES), person)))).toMatchObject({ code: 'NOT_FOUND' })
    expect(await movements(ids.a)).toEqual([])
    expect(await level(ids.a)).toMatchObject({ quantity: 57, reserved: 33 })
  })

  it('shipment 1: sealed cases of each size leave sealed, loose units loose; holds released and the rest held again; available unchanged; FBA untouched', async () => {
    const fbaBefore = await level(ids.a, ids.fba)
    const view = await inside(() => ship.markShipped(ids.s1, tracking(S1_BOXES), person))
    // A: 33 of 57 left (2×12 + 1×6 + 3 loose) → 24 = 2×12 sealed + 0×6 + 0 loose; the hold of 33 released, nothing left to hold.
    expect(await level(ids.a)).toMatchObject({ quantity: 24, reserved: 0, available: 24 })
    expect(await sealed(ids.a)).toEqual([{ unitsPerCase: 12, cases: 2 }, { unitsPerCase: 6, cases: 0 }])
    // B: 2 of its 4 left in this shipment; 2 still held for shipment 2 → available stays 6.
    expect(await level(ids.b)).toMatchObject({ quantity: 8, reserved: 2, available: 6 })
    expect(await level(ids.a, ids.fba)).toEqual(fbaBefore)
    expect(await movements(ids.a)).toEqual([{ change: -33, locationId: ids.main, referenceType: 'FbaInboundShipment', referenceId: ids.s1, actor: 'owner@example.test',
      notes: expect.stringContaining('Sent to Amazon FBA: shipment FBA15TEST1 · sealed cases 2×12 + 1×6') }])
    expect(await movements(ids.b)).toEqual([expect.objectContaining({ change: -2, referenceId: ids.s1 })])
    expect(await lineOf(ids.a)).toEqual({ shippedQuantity: 33, reservationId: null })
    const lineB = await lineOf(ids.b)
    expect(lineB.shippedQuantity).toBe(2)
    expect(await inside(() => db().stockReservation.findUniqueOrThrow({ where: { id: lineB.reservationId! }, select: { quantity: true, reason: true, releasedAt: true } }))).toEqual({ quantity: 2, reason: 'FBA_SEND', releasedAt: null })
    // The shipment and the plan: TRACKING next, still READY_TO_SHIP (shipment 2 is not shipped); the job dispatched.
    const s1 = view.shipments.find((x) => x.id === ids.s1)!
    expect(s1).toMatchObject({ shippedBy: 'owner@example.test', tracking: { boxes: tracking(S1_BOXES).tracking, sentAt: null } })
    expect(s1.shippedAt).not.toBeNull()
    expect(view).toMatchObject({ status: 'READY_TO_SHIP', step: 'TRACKING', shippedUnits: 35, can: { cancel: false } })
    expect(view.lines.find((l) => l.productId === ids.a)).toMatchObject({ cases: [{ unitsPerCase: 12, cases: 2 }, { unitsPerCase: 6, cases: 1 }], looseUnits: 3 })
    expect(view.nextCheckAt).not.toBeNull()
    expect(dispatchFbaPlan).toHaveBeenCalledWith(ids.plan)
    const events = await inside(() => db().eventOutbox.findMany({ where: { type: 'fba.plan_changed' }, orderBy: { occurredAt: 'asc' } }))
    expect(events.at(-1)?.payload).toMatchObject({ planId: ids.plan, status: 'READY_TO_SHIP', step: 'TRACKING' })
  })

  it('twice = once: the same shipment again is a no-op that answers the plan (no second movement)', async () => {
    const again = await inside(() => ship.markShipped(ids.s1, tracking(S1_BOXES), { actor: 'second@example.test', userId: 'u-2' }))
    expect(again.shipments.find((x) => x.id === ids.s1)?.shippedBy).toBe('owner@example.test')
    expect(await movements(ids.a)).toHaveLength(1)
    expect(await level(ids.a)).toMatchObject({ quantity: 24, reserved: 0 })
    expect(dispatchFbaPlan).not.toHaveBeenCalled()
  })

  it('shipment 2: the last one → SHIPPED; the plan can no longer be cancelled', async () => {
    const view = await inside(() => ship.markShipped(ids.s2, tracking(S2_BOXES), person))
    expect(await level(ids.b)).toMatchObject({ quantity: 6, reserved: 0, available: 6 })
    expect(await lineOf(ids.b)).toEqual({ shippedQuantity: 4, reservationId: null })
    expect(view).toMatchObject({ status: 'SHIPPED', step: 'TRACKING', units: 37, shippedUnits: 37 })
    expect(await caught(() => inside(() => send.cancelPlan(ids.plan, person)))).toMatchObject({ code: 'WRONG_STATE' })
  })
})

describe('the FBA quantity is never written: FBA transfers are refused at Amazon\'s and Shopify\'s locations', () => {
  it('FBA_TRANSFER_OUT / FBA_TRANSFER_IN at AMAZON_FBA or SHOPIFY_LOCATION → ProtectedLocationError; at a warehouse → allowed', async () => {
    const { applyStockMovement, protectedLocationRefusal } = await import('../stock-movement.service.js')
    expect(protectedLocationRefusal('FBA_TRANSFER_OUT', ids.fba, 'AMAZON_FBA')?.message).toBe('FBA stock cannot be changed by an FBA transfer: Amazon is the source of truth, and only the FBA inventory sync writes it.')
    expect(protectedLocationRefusal('FBA_TRANSFER_IN', ids.shopify, 'SHOPIFY_LOCATION')?.code).toBe('PROTECTED_LOCATION')
    expect(protectedLocationRefusal('FBA_TRANSFER_OUT', ids.main, 'WAREHOUSE')).toBeNull()
    const before = await level(ids.a, ids.fba)
    await expect(inside(() => applyStockMovement({ productId: ids.a, locationId: ids.fba, change: 3, reason: 'FBA_TRANSFER_IN' }))).rejects.toMatchObject({ name: 'ProtectedLocationError' })
    await expect(inside(() => applyStockMovement({ productId: ids.a, locationId: ids.fba, change: -1, reason: 'FBA_TRANSFER_OUT' }))).rejects.toMatchObject({ name: 'ProtectedLocationError' })
    expect(await level(ids.a, ids.fba)).toEqual(before)
  })
})

describe('labelsFor — a fresh link per click', () => {
  it('v0 getLabels with the FBA15… id, A4 four per page, one UNIQUE label per box; no boxes or no link → LABELS_UNAVAILABLE', async () => {
    expect(await inside(() => ship.labelsFor(ids.s1))).toEqual({ downloadUrl: 'https://labels.example.test/fresh.pdf' })
    expect(s.labels).toEqual([{ shipmentId: 'FBA15TEST1', pageType: 'PackageLabel_A4_4', labelType: 'UNIQUE', packageLabelsToPrint: S1_BOXES.map((b) => b.boxId) }])
    s.labelError = 'SP-API getLabels 400: bad'
    expect(await caught(() => inside(() => ship.labelsFor(ids.s1)))).toMatchObject({ code: 'LABELS_UNAVAILABLE', message: 'Amazon gave no labels for FBA15TEST1: SP-API getLabels 400: bad' })
    const empty = await inside(() => db().fBAShipment.create({ data: { shipmentId: 'FBA15TEST3', destinationFC: 'MXP5', planRowId: ids.plan } }))
    expect(await caught(() => inside(() => ship.labelsFor(empty.id)))).toMatchObject({ code: 'LABELS_UNAVAILABLE' })
    expect(await caught(() => inside(() => ship.labelsFor('nope')))).toMatchObject({ code: 'NOT_FOUND' })
  })
})
