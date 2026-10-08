/**
 * Step 4 Send to FBA (Part C) — the dialog's facts, "Create plan", the Owner's choice, cancel and "Try again".
 *
 *   draft      a parent stands for its variations; From = the default warehouse; the Amazon SKU per market; free units,
 *              free sealed / loose (caseSplit), the case pack, unit weight and size, owners, units in open plans; the
 *              ship-from check names what is missing (warehouse address, company name and phone).
 *   create     refused by the shared rule (owners not set, no listing, more than free, no address) with nothing written;
 *              then ONE transaction: the plan (QUEUED, the frozen Amazon name), its lines, a FBA_SEND hold per line at
 *              From (45 days), the owners remembered for the SKUs that had none (owners only), `fba.plan_changed`, the
 *              job dispatched, the held products re-advertised. The FBA quantity is never touched.
 *   choice     only a person; every shipment of the option once, its transport and window; expired options refused;
 *              WAITING_FOR_CHOICE → CONFIRMING exactly once.
 *   cancel     the holds are released at the click; a plan Amazon never saw is CANCELLED, one Amazon has is CANCELLING.
 *   retry      FAILED → the failed step; expired options → PLACING; anything else refused.
 *
 * Real SQL (PGlite with the production schema and row-level security). The job (Part B's dispatchFbaPlan) is a spy:
 * nothing reaches Amazon.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FBA_SEND_COPY, MIXED_BOX_DEFAULT, nextWorkingDay, type FbaPlanOptions } from '@nexus/shared/fba-send'
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
const s = vi.hoisted(() => ({ account: '' }))
vi.mock('../../lib/amazon-sp-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/amazon-sp-client.js')>()),
  amazonAccount: vi.fn(async () => { if (!s.account) throw new Error('no Amazon account'); return { id: s.account } }),
}))
/** The re-advertise after a hold runs in the background; a spy here (the real one is the stock tests'). */
vi.mock('../stock-movement.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stock-movement.service.js')>()),
  recascadeProduct: vi.fn(async () => ({ ok: true })),
}))
/** Part B's job is not this part's: the contract's dispatch is a spy (the errors are the contract's own shape). */
vi.mock('./contract.js', () => {
  const HTTP: Record<string, number> = { NOT_FOUND: 404, REFUSED: 400, WRONG_STATE: 409, OPTION_UNKNOWN: 400, OPTIONS_EXPIRED: 409, NEEDS_PERSON: 403, TRACKING_INVALID: 400, LABELS_UNAVAILABLE: 409, NOT_BUILT: 501 }
  class FbaSendError extends Error {
    constructor(readonly code: string, message: string, readonly problems: unknown[] = []) { super(message); this.name = 'FbaSendError' }
    get httpStatus() { return HTTP[this.code] }
  }
  return { FbaSendError, dispatchFbaPlan: vi.fn(async () => 'inline') }
})

import { dispatchFbaPlan } from './contract.js'
import { recascadeProduct } from '../stock-movement.service.js'

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: ['OWNER'] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const db = () => database.client
const ids = { main: '', spare: '', fba: '', warehouse: '', parent: '', a: '', b: '', c: '', account: '', brand: '' }
const person = { actor: 'owner@example.test', userId: 'u-owner' }
type Send = typeof import('./send.service.js')
type Read = typeof import('./read.service.js')
let send: Send
let read: Read

const levelOf = (productId: string, locationId = ids.main) => inside(() => db().stockLevel.findFirstOrThrow({ where: { productId, locationId }, select: { quantity: true, reserved: true, available: true } }))
const holdsOf = (productId: string) => inside(() => db().stockReservation.findMany({ where: { stockLevel: { productId } }, select: { id: true, quantity: true, reason: true, kind: true, releasedAt: true, expiresAt: true }, orderBy: { createdAt: 'asc' } }))
const planCount = () => inside(() => db().fbaInboundPlanV2.count({ where: { source: { not: null } } }))
const caught = async (work: () => Promise<unknown>) => { try { await work(); return null } catch (error) { return error as { name: string; code: string; message: string; problems: Array<{ code: string; productId: string | null }> } } }
const company = (data: { companyName: string | null; contactPhone: string | null }) => inside(() => db().brandSettings.update({ where: { id: ids.brand }, data }))

beforeAll(async () => {
  vi.stubEnv('NEXUS_ISSUER_NAME', '')
  vi.stubEnv('NEXUS_ISSUER_PHONE', '')
  database = await formulaDatabase()
  await inside(async () => {
    const d = db()
    ids.warehouse = (await d.warehouse.create({ data: { code: 'TEST-MAIN', name: 'Main', addressLine1: 'Via Test 1', city: 'Testville', postalCode: '00000', country: 'IT', isDefault: true } })).id
    ids.main = (await d.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-MAIN', name: 'Main warehouse', warehouseId: ids.warehouse } })).id
    ids.spare = (await d.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-SPARE', name: 'Spare (no address)' } })).id
    ids.fba = (await d.stockLocation.create({ data: { type: 'AMAZON_FBA', code: 'TEST-FBA', name: 'Amazon FBA' } })).id
    ids.brand = (await d.brandSettings.create({ data: { companyName: null, contactPhone: null } })).id
    ids.account = (await d.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'test-fba', externalAccountId: 'TEST-SELLER', isActive: true } as never })).id
    s.account = ids.account
    await d.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'TEST-MKT-IT' } as never })
    await d.marketplace.create({ data: { channel: 'AMAZON', code: 'DE', name: 'Amazon Germany', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'], marketplaceId: 'TEST-MKT-DE' } as never })
    ids.parent = (await d.product.create({ data: { sku: 'TEST-FBA-FAMILY', name: 'Family', basePrice: '10.00', isParent: true } })).id
    const child = (sku: string, data: Record<string, unknown>) => d.product.create({ data: { sku, name: sku, basePrice: '10.00', parentId: ids.parent, ...data } as never }).then((p) => p.id)
    ids.a = await child('TEST-FBA-A', { weightValue: '0.5', weightUnit: 'kg', dimLength: '30', dimWidth: '20', dimHeight: '10', dimUnit: 'cm', totalStock: 51 })
    ids.b = await child('TEST-FBA-B', { weightValue: '1000', weightUnit: 'g', totalStock: 10 })
    ids.c = await child('TEST-FBA-C', { weightValue: '1', weightUnit: 'kg', totalStock: 5 })
    const levelA = await d.stockLevel.create({ data: { productId: ids.a, locationId: ids.main, quantity: 51, reserved: 0, available: 51 } })
    await d.stockLevel.create({ data: { productId: ids.b, locationId: ids.main, quantity: 10, reserved: 0, available: 10 } })
    await d.stockLevel.create({ data: { productId: ids.c, locationId: ids.main, quantity: 5, reserved: 0, available: 5 } })
    await d.stockLevel.create({ data: { productId: ids.a, locationId: ids.fba, quantity: 5, reserved: 0, available: 5 } })
    await d.productPackage.create({ data: { productId: ids.a, fbaPrepOwner: 'SELLER', fbaLabelOwner: 'SELLER' } })
    const a12 = await d.productCaseSize.create({ data: { productId: ids.a, unitsPerCase: 12, caseLengthCm: '40', caseWidthCm: '30', caseHeightCm: '30', caseWeightKg: '7' } })
    await d.productCaseSize.create({ data: { productId: ids.a, unitsPerCase: 6, caseLengthCm: '30', caseWidthCm: '20', caseHeightCm: '30', caseWeightKg: '3.6' } })
    await d.stockCaseCount.create({ data: { stockLevelId: levelA.id, caseSizeId: a12.id, cases: 4 } })
    const listing = (productId: string, data: Record<string, unknown> = {}) => d.channelListing.create({ data: {
      productId, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', channelConnectionId: ids.account, aliasKey: '',
      listingStatus: 'ACTIVE', isPublished: true, fulfillmentMethod: 'FBA', ...data } as never })
    await listing(ids.a, { liveChannelSku: 'A-IT' })
    await listing(ids.b)
  })
  send = await import('./send.service.js')
  read = await import('./read.service.js')
}, 180_000)

beforeEach(() => { vi.mocked(dispatchFbaPlan).mockClear(); vi.mocked(recascadeProduct).mockClear() })
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() })

describe('readSendDraft — the dialog\'s facts', () => {
  it('a parent stands for its variations; From = the default warehouse; per SKU the Amazon SKU, free units and cases per size, the case sizes, weight, size, owners', async () => {
    const draft = await inside(() => send.readSendDraft({ productIds: [ids.parent] }))
    expect(draft.from).toMatchObject({ id: ids.main, code: 'TEST-MAIN', town: 'Testville', country: 'IT', isDefault: true })
    expect(draft.locations.map((l) => l.code)).toEqual(['TEST-MAIN', 'TEST-SPARE'])
    expect(draft.markets).toEqual([
      { code: 'DE', marketplaceId: 'TEST-MKT-DE', name: 'Amazon Germany', accountId: ids.account },
      { code: 'IT', marketplaceId: 'TEST-MKT-IT', name: 'Amazon Italy', accountId: ids.account },
    ])
    expect(draft.market).toBe('IT')
    expect(draft.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(draft.readyToShipOn).toBe(nextWorkingDay(draft.today))
    expect(draft.mixedBox).toEqual(MIXED_BOX_DEFAULT)
    expect(draft.skus.map((sku) => sku.sku)).toEqual(['TEST-FBA-A', 'TEST-FBA-B', 'TEST-FBA-C'])
    const [a, b, c] = draft.skus
    expect(a).toMatchObject({
      productId: ids.a, msku: 'A-IT', unitWeightKg: 0.5,
      caseSizes: [
        { unitsPerCase: 12, case: { lengthCm: 40, widthCm: 30, heightCm: 30, weightKg: 7 } },
        { unitsPerCase: 6, case: { lengthCm: 30, widthCm: 20, heightCm: 30, weightKg: 3.6 } },
      ],
      unit: { lengthCm: 30, widthCm: 20, heightCm: 10 }, onHand: 51, free: 51, freeSealed: [{ unitsPerCase: 12, cases: 4 }, { unitsPerCase: 6, cases: 0 }], freeLoose: 3,
      prepOwner: 'SELLER', labelOwner: 'SELLER', openPlanUnits: 0,
    })
    expect(b).toMatchObject({ msku: 'TEST-FBA-B', caseSizes: [], unitWeightKg: 1, unit: null, free: 10, freeSealed: [], freeLoose: 10, prepOwner: null, labelOwner: null })
    expect(c).toMatchObject({ msku: null, free: 5 })
  })

  it('the ship-from check names what is missing and where; an unknown From is null; a market with no listing reads no Amazon SKU', async () => {
    const empty = await inside(() => send.readSendDraft({ productIds: [ids.a] }))
    expect(empty.address).toEqual({ missing: ['name', 'phoneNumber'], summary: 'Via Test 1, 00000 Testville, IT' })
    await company({ companyName: 'Test Company', contactPhone: '+39 000 000' })
    const full = await inside(() => send.readSendDraft({ productIds: [ids.a] }))
    expect(full.address).toEqual({ missing: [], summary: 'Test Company · Via Test 1, 00000 Testville, IT · +39 000 000' })
    const spare = await inside(() => send.readSendDraft({ productIds: [ids.a], from: 'TEST-SPARE', market: 'de' }))
    expect(spare.from?.code).toBe('TEST-SPARE')
    expect(spare.address.missing).toEqual(['addressLine1', 'city', 'postalCode', 'countryCode'])
    expect(spare.market).toBe('DE')
    expect(spare.skus[0]).toMatchObject({ msku: null, onHand: 0, free: 0 })
    expect((await inside(() => send.readSendDraft({ productIds: [ids.a], from: 'NOPE' }))).from).toBeNull()
    expect(await caught(() => inside(() => send.readSendDraft({ productIds: ['missing-product'] })))).toMatchObject({ name: 'FbaSendError', code: 'NOT_FOUND' })
  })
})

describe('createSendPlan — "Create plan"', () => {
  const request = () => ({ from: 'TEST-MAIN', market: 'IT', readyToShipOn: nextWorkingDay(send.romeToday()), lines: [{ productId: ids.a, cases: [{ unitsPerCase: 12, cases: 2 }], looseUnits: 3 }, { productId: ids.b, cases: [], looseUnits: 4 }] })

  it('refuses by the shared rule and writes nothing: owners not set, no listing, more than free, no ship-from address', async () => {
    await company({ companyName: 'Test Company', contactPhone: '+39 000 000' })
    const owners = await caught(() => inside(() => send.createSendPlan(request(), person, 'matrix')))
    expect(owners).toMatchObject({ name: 'FbaSendError', code: 'REFUSED', message: FBA_SEND_COPY.problem.noOwners('TEST-FBA-B') })
    expect(owners!.problems.map((p) => p.code)).toEqual(['NO_OWNERS'])
    const noListing = await caught(() => inside(() => send.createSendPlan({ ...request(), lines: [{ productId: ids.c, cases: [], looseUnits: 1 }], owners: { prepOwner: 'SELLER', labelOwner: 'SELLER' } }, person, 'matrix')))
    expect(noListing!.problems.map((p) => p.code)).toEqual(['NO_LISTING'])
    const tooMany = await caught(() => inside(() => send.createSendPlan({ ...request(), lines: [{ productId: ids.a, cases: [{ unitsPerCase: 12, cases: 5 }], looseUnits: 0 }] }, person, 'matrix')))
    expect(tooMany!.problems.map((p) => p.code)).toEqual(['OVER_FREE_CASES', 'OVER_FREE'])
    const noSix = await caught(() => inside(() => send.createSendPlan({ ...request(), lines: [{ productId: ids.a, cases: [{ unitsPerCase: 6, cases: 1 }], looseUnits: 0 }] }, person, 'matrix')))
    expect(noSix!.problems.map((p) => [p.code, p.message])).toEqual([['OVER_FREE_CASES', 'TEST-FBA-A: 1 sealed case of 6 asked; 0 free at TEST-MAIN']])
    const older = await caught(() => inside(() => send.createSendPlan({ ...request(), lines: [{ productId: ids.a, cases: 2 as never, looseUnits: 0 }] }, person, 'matrix')))
    expect(older!.problems.map((p) => p.code)).toEqual(['INVALID_QUANTITY', 'NO_UNITS']) // an older page's plain number is refused, never read as 0
    await company({ companyName: 'Test Company', contactPhone: null })
    const address = await caught(() => inside(() => send.createSendPlan({ ...request(), owners: { prepOwner: 'SELLER', labelOwner: 'AMAZON' } }, person, 'matrix')))
    expect(address).toMatchObject({ code: 'REFUSED', message: FBA_SEND_COPY.problem.noAddress(['phoneNumber'], 'TEST-MAIN') })
    expect(await caught(() => inside(() => send.createSendPlan({ ...request(), lines: 'x' } as never, person, 'matrix')))).toMatchObject({ code: 'REFUSED' })
    expect(await planCount()).toBe(0)
    expect(await holdsOf(ids.a)).toEqual([])
    expect(await inside(() => db().productPackage.findFirst({ where: { productId: ids.b } }))).toBeNull()
    expect(dispatchFbaPlan).not.toHaveBeenCalled()
  })

  it('creates the plan, its lines and one FBA_SEND hold per line at From in one transaction; owners remembered for the SKUs that had none', async () => {
    await company({ companyName: 'Test Company', contactPhone: '+39 000 000' })
    const before = { fba: await levelOf(ids.a, ids.fba) }
    const t0 = Date.now()
    const { planId } = await inside(() => send.createSendPlan({ ...request(), owners: { prepOwner: 'SELLER', labelOwner: 'AMAZON' } }, person, 'matrix'))
    const plan = await inside(() => db().fbaInboundPlanV2.findUniqueOrThrow({ where: { id: planId }, include: { lines: { orderBy: { createdAt: 'asc' } } } }))
    expect(plan).toMatchObject({
      status: 'QUEUED', currentStep: 'CREATE', source: 'matrix', createdBy: 'owner@example.test', planId: null,
      name: `Nexus IT ${send.romeToday()} #${planId.slice(-6)}`, channelConnectionId: ids.account, marketplaceId: 'TEST-MKT-IT', sourceLocationId: ids.main,
      mixedBox: MIXED_BOX_DEFAULT, steps: [], nextCheckAt: null, confirmedBy: null,
      sourceAddress: { name: 'Test Company', companyName: 'Test Company', addressLine1: 'Via Test 1', city: 'Testville', postalCode: '00000', countryCode: 'IT', phoneNumber: '+39 000 000' },
    })
    expect(plan.readyToShipOn?.toISOString().slice(0, 10)).toBe(nextWorkingDay(send.romeToday()))
    expect(plan.lines.map((l) => ({ productId: l.productId, msku: l.msku, quantity: l.quantity, caseCounts: l.caseCounts, looseUnits: l.looseUnits, prepOwner: l.prepOwner, labelOwner: l.labelOwner, shippedQuantity: l.shippedQuantity }))).toEqual([
      { productId: ids.a, msku: 'A-IT', quantity: 27, caseCounts: [{ unitsPerCase: 12, cases: 2 }], looseUnits: 3, prepOwner: 'SELLER', labelOwner: 'SELLER', shippedQuantity: 0 },
      { productId: ids.b, msku: 'TEST-FBA-B', quantity: 4, caseCounts: [], looseUnits: 4, prepOwner: 'SELLER', labelOwner: 'AMAZON', shippedQuantity: 0 },
    ])
    // The holds: at From, HARD, FBA_SEND, 45 days; available drops, units stay; the FBA level is untouched.
    const [holdA] = await holdsOf(ids.a)
    expect(holdA).toMatchObject({ id: plan.lines[0].reservationId, quantity: 27, reason: 'FBA_SEND', kind: 'HARD', releasedAt: null })
    expect(holdA.expiresAt.getTime() - t0).toBeGreaterThan(44.9 * 86_400_000)
    expect(await levelOf(ids.a)).toEqual({ quantity: 51, reserved: 27, available: 24 })
    expect(await levelOf(ids.b)).toEqual({ quantity: 10, reserved: 4, available: 6 })
    expect(await levelOf(ids.a, ids.fba)).toEqual(before.fba)
    // Owners: only B had none — it gets an owners row and no case size; A keeps its own.
    expect(await inside(() => db().productPackage.findFirst({ where: { productId: ids.b }, select: { fbaPrepOwner: true, fbaLabelOwner: true } })))
      .toEqual({ fbaPrepOwner: 'SELLER', fbaLabelOwner: 'AMAZON' })
    expect(await inside(() => db().productCaseSize.count({ where: { productId: ids.b } }))).toBe(0)
    expect(await inside(() => db().productPackage.findFirst({ where: { productId: ids.a }, select: { fbaPrepOwner: true, fbaLabelOwner: true } })))
      .toEqual({ fbaPrepOwner: 'SELLER', fbaLabelOwner: 'SELLER' })
    // The event in the same transaction; the job dispatched; the held products re-advertised.
    const events = await inside(() => db().eventOutbox.findMany({ where: { type: 'fba.plan_changed' } }))
    expect(events.map((e) => e.payload)).toContainEqual(expect.objectContaining({ planId, status: 'QUEUED', step: 'CREATE', productIds: [ids.a, ids.b] }))
    expect(dispatchFbaPlan).toHaveBeenCalledWith(planId)
    await vi.waitFor(() => expect(vi.mocked(recascadeProduct).mock.calls.map((c) => c[0])).toEqual([ids.a, ids.b]))
    // The dialog now sees the hold: free units and free sealed cases drop, the units count as in an open plan.
    const draft = await inside(() => send.readSendDraft({ productIds: [ids.a] }))
    expect(draft.skus[0]).toMatchObject({ onHand: 51, free: 24, freeSealed: [{ unitsPerCase: 12, cases: 2 }, { unitsPerCase: 6, cases: 0 }], freeLoose: 0, openPlanUnits: 27 })
  })

  it('readPlans / readPlan: the plan as the drawer reads it, by family root and open; an older wizard plan is not a Send-to-FBA plan', async () => {
    const [view] = await inside(() => read.readPlans({ productId: ids.parent, open: true }))
    expect(view).toMatchObject({
      status: 'QUEUED', step: 'CREATE', source: 'matrix', market: 'IT', marketplaceId: 'TEST-MKT-IT', from: { locationId: ids.main, code: 'TEST-MAIN' },
      skus: 2, units: 31, shippedUnits: 0, steps: [], options: null, choice: null, shipments: [], problems: [], message: null,
      can: { choose: false, newOptions: false, retry: false, cancel: true },
    })
    expect(view.lines.map((l) => [l.sku, l.quantity, l.held])).toEqual([['TEST-FBA-A', 27, true], ['TEST-FBA-B', 4, true]])
    expect(await inside(() => read.readPlan(view.id))).toEqual(view)
    expect(await inside(() => read.readPlans({ productId: ids.c }))).toEqual([])
    const wizard = await inside(() => db().fbaInboundPlanV2.create({ data: { name: 'TEST wizard', status: 'ACTIVE', currentStep: 'PACKING' } }))
    expect(await inside(() => read.readPlan(wizard.id))).toBeNull()
    expect((await inside(() => read.readPlans({}))).map((p) => p.id)).toEqual([view.id])
  })
})

describe('confirmChoice — the one door to Amazon\'s final confirms', () => {
  const OPTIONS = (expiresAt: string): FbaPlanOptions => ({
    readAt: new Date().toISOString(), expiresAt,
    placements: [{
      placementOptionId: 'po-1', status: 'OFFERED', expiresAt, fees: [], discounts: [],
      shipments: [
        { shipmentId: 'sh-1', destinationFc: 'MXP5', destinationTown: null, deliveryWindows: [{ deliveryWindowOptionId: 'dw-1', start: '2026-10-14', end: '2026-10-21', availabilityType: 'AVAILABLE', validUntil: null }],
          transport: [{ transportationOptionId: 'to-own-1', shipmentId: 'sh-1', carrierName: 'BRT', carrierCode: 'BRT', shippingMode: 'GROUND_SMALL_PARCEL', shippingSolution: 'USE_YOUR_OWN_CARRIER', quote: null, preconditions: [] }] },
        { shipmentId: 'sh-2', destinationFc: 'FCO1', destinationTown: null, deliveryWindows: [],
          transport: [{ transportationOptionId: 'to-pcp-2', shipmentId: 'sh-2', carrierName: 'UPS', carrierCode: 'UPS', shippingMode: 'GROUND_SMALL_PARCEL', shippingSolution: 'AMAZON_PARTNERED_CARRIER', quote: { cost: { amount: 12.5, currency: 'EUR' }, expiresAt: null, voidableUntil: null }, preconditions: [] }] },
      ],
    }],
  })
  const CHOICE = { placementOptionId: 'po-1', shipments: [{ shipmentId: 'sh-1', transportationOptionId: 'to-own-1', deliveryWindowOptionId: 'dw-1' }, { shipmentId: 'sh-2', transportationOptionId: 'to-pcp-2', deliveryWindowOptionId: null }] }
  const waiting = async (expiresAt = new Date(Date.now() + 3_600_000).toISOString()) => {
    const plan = await inside(() => db().fbaInboundPlanV2.findFirstOrThrow({ where: { source: 'matrix' } }))
    await inside(() => db().fbaInboundPlanV2.update({ where: { id: plan.id }, data: { status: 'WAITING_FOR_CHOICE', currentStep: 'CONFIRM', planId: 'wf-test-1', options: OPTIONS(expiresAt) as never } }))
    return plan.id
  }

  it('only a person; the pick must be Amazon\'s offer, every shipment once; expired options refused; WAITING_FOR_CHOICE → CONFIRMING once', async () => {
    const planId = await waiting()
    expect(await caught(() => inside(() => send.confirmChoice(planId, CHOICE, { actor: 'claude', userId: null as never })))).toMatchObject({ code: 'NEEDS_PERSON' })
    const unknown = async (choice: unknown) => (await caught(() => inside(() => send.confirmChoice(planId, choice as never, person))))?.code
    expect(await unknown({ ...CHOICE, placementOptionId: 'po-x' })).toBe('OPTION_UNKNOWN')
    expect(await unknown({ ...CHOICE, shipments: CHOICE.shipments.slice(0, 1) })).toBe('OPTION_UNKNOWN')
    expect(await unknown({ ...CHOICE, shipments: [CHOICE.shipments[0], CHOICE.shipments[0]] })).toBe('OPTION_UNKNOWN')
    expect(await unknown({ ...CHOICE, shipments: [{ ...CHOICE.shipments[0], transportationOptionId: 'to-x' }, CHOICE.shipments[1]] })).toBe('OPTION_UNKNOWN')
    expect(await unknown({ ...CHOICE, shipments: [{ ...CHOICE.shipments[0], deliveryWindowOptionId: null }, CHOICE.shipments[1]] })).toBe('OPTION_UNKNOWN')
    await waiting(new Date(Date.now() - 1_000).toISOString())
    expect(await caught(() => inside(() => send.confirmChoice(planId, CHOICE, person)))).toMatchObject({ code: 'OPTIONS_EXPIRED', message: FBA_SEND_COPY.optionsExpired })
    await waiting()
    expect(dispatchFbaPlan).not.toHaveBeenCalled()
    const view = await inside(() => send.confirmChoice(planId, CHOICE, person))
    expect(view).toMatchObject({ status: 'CONFIRMING', step: 'CONFIRM', choice: CHOICE, confirmedBy: 'u-owner' })
    expect(view.confirmedAt).not.toBeNull()
    expect(dispatchFbaPlan).toHaveBeenCalledWith(planId)
    expect(await caught(() => inside(() => send.confirmChoice(planId, CHOICE, person)))).toMatchObject({ code: 'WRONG_STATE' })
  })
})

describe('retryPlan and cancelPlan', () => {
  const planId = () => inside(() => db().fbaInboundPlanV2.findFirstOrThrow({ where: { source: 'matrix' } })).then((p) => p.id)
  const set = (id: string, data: Record<string, unknown>) => inside(() => db().fbaInboundPlanV2.update({ where: { id }, data: data as never }))

  it('"Try again": FAILED → the failed step; expired options → PLACING; anything else refused', async () => {
    const id = await planId()
    await set(id, { status: 'FAILED', currentStep: 'PACK', lastError: 'Amazon said no', lastErrorAt: new Date() })
    expect(await inside(() => send.retryPlan(id, person))).toMatchObject({ status: 'PACKING', step: 'PACK', message: null, nextCheckAt: null })
    expect(dispatchFbaPlan).toHaveBeenCalledWith(id)
    expect(await caught(() => inside(() => send.retryPlan(id, person)))).toMatchObject({ code: 'WRONG_STATE' })
    await set(id, { status: 'WAITING_FOR_CHOICE', currentStep: 'CONFIRM', options: { readAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), placements: [] } })
    expect(await caught(() => inside(() => send.retryPlan(id, person)))).toMatchObject({ code: 'WRONG_STATE' })
    await set(id, { options: { readAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString(), placements: [] } })
    expect(await inside(() => send.retryPlan(id, person))).toMatchObject({ status: 'PLACING', step: 'PLACE' })
  })

  it('cancel releases the holds at the click; a plan Amazon has → CANCELLING (the job cancels there), never twice; Amazon never saw it → CANCELLED', async () => {
    const id = await planId()
    await set(id, { status: 'WAITING_FOR_CHOICE', currentStep: 'CONFIRM', planId: 'wf-test-1' })
    const view = await inside(() => send.cancelPlan(id, person))
    expect(view).toMatchObject({ status: 'CANCELLING', step: 'CANCEL', can: { cancel: false } })
    expect(view.cancelledAt).not.toBeNull()
    expect(view.lines.every((l) => !l.held)).toBe(true)
    expect(await levelOf(ids.a)).toEqual({ quantity: 51, reserved: 0, available: 51 })
    expect(await levelOf(ids.b)).toEqual({ quantity: 10, reserved: 0, available: 10 })
    expect((await holdsOf(ids.a)).every((h) => h.releasedAt !== null)).toBe(true)
    expect(dispatchFbaPlan).toHaveBeenCalledWith(id)
    await vi.waitFor(() => expect(vi.mocked(recascadeProduct).mock.calls.map((c) => c[0]).sort()).toEqual([ids.a, ids.b].sort()))
    expect(await caught(() => inside(() => send.cancelPlan(id, person)))).toMatchObject({ code: 'WRONG_STATE' })

    // A new plan Amazon never saw (QUEUED, no Amazon id, no create call, no lease): CANCELLED at once, no job.
    vi.mocked(dispatchFbaPlan).mockClear()
    const { planId: fresh } = await inside(() => send.createSendPlan({ from: 'TEST-MAIN', market: 'IT', readyToShipOn: nextWorkingDay(send.romeToday()), lines: [{ productId: ids.b, cases: [], looseUnits: 2 }] }, person, 'claude'))
    expect(await levelOf(ids.b)).toEqual({ quantity: 10, reserved: 2, available: 8 })
    vi.mocked(dispatchFbaPlan).mockClear()
    expect(await inside(() => send.cancelPlan(fresh, person))).toMatchObject({ status: 'CANCELLED', source: 'claude', nextCheckAt: null })
    expect(dispatchFbaPlan).not.toHaveBeenCalled()
    expect(await levelOf(ids.b)).toEqual({ quantity: 10, reserved: 0, available: 10 })
    expect(await caught(() => inside(() => send.cancelPlan('no-such-plan', person)))).toMatchObject({ code: 'NOT_FOUND' })
  })
})
