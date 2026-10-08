/**
 * FBA shipment drafts (Owner 2026-10-08) — "Add to draft" (the Matrix dialog, Claude's tool), the FBA shipments page's
 * edit / delete / "Send to Amazon", its list and its facts.
 *
 *   add      ONE open draft per From + To: made when none (DRAFT, its source, a name, no hold, no job); a SKU already in it
 *            takes the new numbers; a 0-unit line takes it out; `lines: []` only makes or finds it; a parent with no units
 *            stands for its variations, with units it is refused; owners given are remembered at once; shape refusals.
 *   edit     DRAFT only; `lines` replaces every line and keeps a 0-unit one; another open draft on the new From + To →
 *            DRAFT_EXISTS; the day and the box; a sent plan → WRONG_STATE.
 *   delete   DRAFT only: the row and its lines go; `fba.plan_changed` says CANCELLED.
 *   send     the shared rule on the draft's lines with units (refusals write nothing); then the holds, the lines with the
 *            Amazon SKU and owners (0-unit lines gone), QUEUED, the frozen name, the job; a second send answers the same
 *            plan and holds nothing more; a draft changed between the check and the lock → WRONG_STATE.
 *   list     tabs (drafts / active / done) with every tab's count, newest change first, a cursor; send-draft with
 *            `planId` (the draft's own facts and lines) and with SKUs (the open draft's lines for them); units in a draft
 *            never count as "in an open plan" (runner.vitest holds that the job never claims a DRAFT).
 *
 * Real SQL (PGlite with the production schema and row-level security). The job (dispatchFbaPlan) is a spy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FBA_SEND_COPY, MIXED_BOX_DEFAULT, nextWorkingDay } from '@nexus/shared/fba-send'
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
vi.mock('../stock-movement.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stock-movement.service.js')>()),
  recascadeProduct: vi.fn(async () => ({ ok: true })),
}))
vi.mock('./contract.js', () => {
  const HTTP: Record<string, number> = { NOT_FOUND: 404, REFUSED: 400, WRONG_STATE: 409, OPTION_UNKNOWN: 400, OPTIONS_EXPIRED: 409, NEEDS_PERSON: 403, TRACKING_INVALID: 400, LABELS_UNAVAILABLE: 409, DRAFT_EXISTS: 409, NOT_BUILT: 501 }
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
const ids = { main: '', spare: '', parent: '', a: '', b: '', c: '', account: '' }
const person = { actor: 'owner@example.test', userId: 'u-owner' }
type Draft = typeof import('./draft.service.js')
type Send = typeof import('./send.service.js')
type Read = typeof import('./read.service.js')
let draft: Draft
let send: Send
let read: Read

const caught = async (work: () => Promise<unknown>) => { try { await work(); return null } catch (error) { return error as { name: string; code: string; message: string; problems: Array<{ code: string }> } } }
const levelOf = (productId: string) => inside(() => db().stockLevel.findFirstOrThrow({ where: { productId, locationId: ids.main }, select: { quantity: true, reserved: true, available: true } }))
const rowOf = (id: string) => inside(() => db().fbaInboundPlanV2.findUnique({ where: { id }, select: { status: true, source: true, name: true, createdBy: true, sourceLocationId: true, marketplaceId: true, readyToShipOn: true, mixedBox: true, currentStep: true } }))
const linesOf = (planRowId: string) => inside(() => db().fbaInboundPlanLine.findMany({
  where: { planRowId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  select: { productId: true, quantity: true, caseCounts: true, looseUnits: true, msku: true, prepOwner: true, labelOwner: true, reservationId: true },
}))
const events = () => inside(() => db().eventOutbox.findMany({ where: { type: 'fba.plan_changed' }, orderBy: { createdAt: 'asc' } }))
const drafts = () => inside(() => db().fbaInboundPlanV2.findMany({ where: { status: 'DRAFT', source: { not: null } }, select: { id: true } }))
const add = (body: Record<string, unknown>, source: 'matrix' | 'claude' = 'matrix') => inside(() => draft.addToDraft({ from: 'TEST-MAIN', market: 'IT', lines: [], ...body } as never, person, source))

beforeAll(async () => {
  vi.stubEnv('NEXUS_ISSUER_NAME', '')
  vi.stubEnv('NEXUS_ISSUER_PHONE', '')
  database = await formulaDatabase()
  await inside(async () => {
    const d = db()
    const warehouse = (await d.warehouse.create({ data: { code: 'TEST-MAIN', name: 'Main', addressLine1: 'Via Test 1', city: 'Testville', postalCode: '00000', country: 'IT', isDefault: true } })).id
    ids.main = (await d.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-MAIN', name: 'Main warehouse', warehouseId: warehouse } })).id
    ids.spare = (await d.stockLocation.create({ data: { type: 'WAREHOUSE', code: 'TEST-SPARE', name: 'Spare' } })).id
    await d.brandSettings.create({ data: { companyName: 'Test Company', contactPhone: '+39 000 000' } })
    ids.account = (await d.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'test-drafts', externalAccountId: 'TEST-SELLER', isActive: true } as never })).id
    s.account = ids.account
    await d.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'], marketplaceId: 'TEST-MKT-IT' } as never })
    await d.marketplace.create({ data: { channel: 'AMAZON', code: 'DE', name: 'Amazon Germany', currency: 'EUR', region: 'EU', language: 'de', languages: ['de'], marketplaceId: 'TEST-MKT-DE' } as never })
    ids.parent = (await d.product.create({ data: { sku: 'TEST-DRAFT-FAMILY', name: 'Family', basePrice: '10.00', isParent: true } })).id
    const child = (sku: string) => d.product.create({ data: { sku, name: sku, basePrice: '10.00', parentId: ids.parent, weightValue: '0.5', weightUnit: 'kg' } as never }).then((p) => p.id)
    ids.a = await child('TEST-DRAFT-A')
    ids.b = await child('TEST-DRAFT-B')
    ids.c = await child('TEST-DRAFT-C')
    const levelA = await d.stockLevel.create({ data: { productId: ids.a, locationId: ids.main, quantity: 40, reserved: 0, available: 40 } })
    await d.stockLevel.create({ data: { productId: ids.b, locationId: ids.main, quantity: 10, reserved: 0, available: 10 } })
    await d.stockLevel.create({ data: { productId: ids.c, locationId: ids.main, quantity: 5, reserved: 0, available: 5 } })
    await d.productPackage.create({ data: { productId: ids.a, fbaPrepOwner: 'SELLER', fbaLabelOwner: 'SELLER' } })
    const a12 = await d.productCaseSize.create({ data: { productId: ids.a, unitsPerCase: 12, caseLengthCm: '40', caseWidthCm: '30', caseHeightCm: '30', caseWeightKg: '7' } })
    await d.stockCaseCount.create({ data: { stockLevelId: levelA.id, caseSizeId: a12.id, cases: 2 } })
    for (const productId of [ids.a, ids.b, ids.c]) {
      await d.channelListing.create({ data: { productId, channel: 'AMAZON', marketplace: 'IT', region: 'IT', channelMarket: 'AMAZON_IT', channelConnectionId: ids.account, aliasKey: '', listingStatus: 'ACTIVE', isPublished: true, fulfillmentMethod: 'FBA' } as never })
    }
  })
  draft = await import('./draft.service.js')
  send = await import('./send.service.js')
  read = await import('./read.service.js')
}, 180_000)

beforeEach(() => { vi.mocked(dispatchFbaPlan).mockClear() })
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() })

describe('addToDraft — "Add to draft"', () => {
  it('makes the ONE draft for From + To: DRAFT, its source and name, the lines as given, no hold, no job; the same pair finds it again', async () => {
    const { planId } = await add({ lines: [{ productId: ids.a, cases: [{ unitsPerCase: 12, cases: 1 }], looseUnits: 2 }, { productId: ids.b, looseUnits: 3 }] })
    expect(await rowOf(planId)).toMatchObject({ status: 'DRAFT', source: 'matrix', name: 'Draft TEST-MAIN → Amazon IT', createdBy: 'owner@example.test', sourceLocationId: ids.main, marketplaceId: 'TEST-MKT-IT' })
    expect(await linesOf(planId)).toEqual([
      { productId: ids.a, quantity: 14, caseCounts: [{ unitsPerCase: 12, cases: 1 }], looseUnits: 2, msku: null, prepOwner: null, labelOwner: null, reservationId: null },
      { productId: ids.b, quantity: 3, caseCounts: [], looseUnits: 3, msku: null, prepOwner: null, labelOwner: null, reservationId: null },
    ])
    expect(await levelOf(ids.a)).toEqual({ quantity: 40, reserved: 0, available: 40 })
    expect(dispatchFbaPlan).not.toHaveBeenCalled()
    expect((await events()).at(-1)?.payload).toMatchObject({ planId, status: 'DRAFT', step: null, productIds: [ids.a, ids.b] })

    // The same From + To: the same draft; a SKU in it takes the new numbers; a 0-unit line takes it out; a new SKU joins.
    const again = await add({ lines: [{ productId: ids.a, looseUnits: 5 }, { productId: ids.b, looseUnits: 0 }, { productId: ids.c, looseUnits: 1 }] }, 'claude')
    expect(again.planId).toBe(planId)
    expect((await linesOf(planId)).map((l) => [l.productId, l.quantity])).toEqual([[ids.a, 5], [ids.c, 1]])
    expect((await rowOf(planId))?.source).toBe('matrix')
    expect(await drafts()).toHaveLength(1)
    // `lines: []` finds it; another To makes its own.
    expect((await add({})).planId).toBe(planId)
    const de = await add({ market: 'de' })
    expect(de.planId).not.toBe(planId)
    expect(await rowOf(de.planId)).toMatchObject({ status: 'DRAFT', name: 'Draft TEST-MAIN → Amazon DE', marketplaceId: 'TEST-MKT-DE' })
    await inside(() => draft.deleteDraft(de.planId, person))
  })

  it('a parent with no units stands for its variations (here: takes them all out); with units it is refused; shape refusals write nothing; owners are remembered at once', async () => {
    const { planId } = await add({ lines: [{ productId: ids.parent }] })
    expect(await linesOf(planId)).toEqual([])
    await add({ lines: [{ productId: ids.a, looseUnits: 5 }, { productId: ids.c, looseUnits: 1 }] })
    expect(await caught(() => add({ lines: [{ productId: ids.parent, looseUnits: 2 }] }))).toMatchObject({ code: 'REFUSED', message: 'TEST-DRAFT-FAMILY: a parent is never sent — name its variations' })
    expect(await caught(() => add({ lines: [{ productId: ids.a, cases: [{ unitsPerCase: 12, cases: 1.5 }] }] }))).toMatchObject({ code: 'REFUSED', message: FBA_SEND_COPY.problem.invalidQuantity('TEST-DRAFT-A') })
    expect(await caught(() => add({ lines: [{ productId: ids.a, cases: [{ unitsPerCase: 6, cases: 1 }, { unitsPerCase: 6, cases: 1 }] }] }))).toMatchObject({ code: 'REFUSED' })
    expect(await caught(() => add({ lines: [{ productId: ids.a, looseUnits: -1 }] }))).toMatchObject({ code: 'REFUSED' })
    expect(await caught(() => add({ lines: [{ productId: ids.a, looseUnits: 1 }, { productId: ids.a, looseUnits: 2 }] }))).toMatchObject({ code: 'REFUSED' })
    expect(await caught(() => add({ lines: [{ productId: 'missing', looseUnits: 1 }] }))).toMatchObject({ code: 'NOT_FOUND' })
    expect(await caught(() => add({ from: 'NOPE' }))).toMatchObject({ code: 'REFUSED', message: FBA_SEND_COPY.problem.notWarehouse })
    expect(await caught(() => add({ market: 'FR' }))).toMatchObject({ code: 'REFUSED', message: FBA_SEND_COPY.problem.noAccount('FR') })
    expect(await caught(() => add({ readyToShipOn: '2026-02-30' }))).toMatchObject({ code: 'REFUSED' })
    expect((await linesOf(planId)).map((l) => [l.productId, l.quantity])).toEqual([[ids.a, 5], [ids.c, 1]])

    await add({ lines: [{ productId: ids.b, looseUnits: 2 }], owners: { prepOwner: 'AMAZON', labelOwner: 'SELLER' } })
    expect(await inside(() => db().productPackage.findFirst({ where: { productId: ids.b }, select: { fbaPrepOwner: true, fbaLabelOwner: true } }))).toEqual({ fbaPrepOwner: 'AMAZON', fbaLabelOwner: 'SELLER' })
    // A SKU whose owners were set keeps them.
    expect(await inside(() => db().productPackage.findFirst({ where: { productId: ids.a }, select: { fbaPrepOwner: true } }))).toEqual({ fbaPrepOwner: 'SELLER' })
  })
})

describe('updateDraft / deleteDraft — the page', () => {
  it('lines replace every line and keep a 0-unit one; the day and the box; another open draft on the new From + To → DRAFT_EXISTS', async () => {
    const { planId } = await add({})
    const day = nextWorkingDay(send.romeToday())
    const view = await inside(() => draft.updateDraft(planId, {
      readyToShipOn: day, mixedBox: { ...MIXED_BOX_DEFAULT, maxKg: 15 },
      lines: [{ productId: ids.a, cases: [{ unitsPerCase: 12, cases: 2 }], looseUnits: 0 }, { productId: ids.b, cases: [], looseUnits: 0 }],
    }, person))
    expect(view).toMatchObject({ id: planId, status: 'DRAFT', readyToShipOn: day, mixedBox: { maxKg: 15 }, skus: 2, units: 24, can: { edit: true, send: true, discard: true, cancel: false } })
    expect(view.lines.map((l) => [l.sku, l.quantity, l.msku])).toEqual([['TEST-DRAFT-A', 24, null], ['TEST-DRAFT-B', 0, null]])
    await inside(() => draft.updateDraft(planId, { mixedBox: null }, person))
    expect((await rowOf(planId))?.mixedBox).toBeNull()

    // Moving it to DE: free (no DE draft); back to IT while another IT draft exists → DRAFT_EXISTS.
    expect((await inside(() => draft.updateDraft(planId, { market: 'DE' }, person))).market).toBe('DE')
    const other = await add({ lines: [{ productId: ids.c, looseUnits: 1 }] })
    expect(other.planId).not.toBe(planId)
    expect(await caught(() => inside(() => draft.updateDraft(planId, { market: 'IT' }, person)))).toMatchObject({ code: 'DRAFT_EXISTS', message: FBA_SEND_COPY.draftExists('TEST-MAIN', 'IT') })
    expect(await caught(() => inside(() => draft.updateDraft('nope', {}, person)))).toMatchObject({ code: 'NOT_FOUND' })

    // Delete: the row and its lines go; the event says CANCELLED.
    expect(await inside(() => draft.deleteDraft(planId, person))).toEqual({ planId, deleted: true })
    expect(await rowOf(planId)).toBeNull()
    expect(await linesOf(planId)).toEqual([])
    expect((await events()).at(-1)?.payload).toMatchObject({ planId, status: 'CANCELLED', step: null, productIds: [ids.a, ids.b] })
    expect(await caught(() => inside(() => draft.deleteDraft(planId, person)))).toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('sendDraft — "Send to Amazon"', () => {
  it('the shared rule refuses and writes nothing; then holds, lines with the Amazon SKU and owners, QUEUED, the job; a second send holds nothing more; a sent plan cannot be edited or deleted', async () => {
    const { planId } = await add({})
    await inside(() => draft.updateDraft(planId, { lines: [{ productId: ids.a, cases: [{ unitsPerCase: 12, cases: 1 }], looseUnits: 3 }, { productId: ids.c, cases: [], looseUnits: 6 }, { productId: ids.b, cases: [], looseUnits: 0 }] }, person))
    // C: no owners and more than free (5).
    const refused = await caught(() => inside(() => draft.sendDraft(planId, {}, person)))
    expect(refused).toMatchObject({ code: 'REFUSED' })
    expect(refused!.problems.map((p) => p.code).sort()).toEqual(['NO_OWNERS', 'OVER_FREE'])
    expect((await rowOf(planId))?.status).toBe('DRAFT')
    expect(await levelOf(ids.c)).toEqual({ quantity: 5, reserved: 0, available: 5 })

    await inside(() => draft.updateDraft(planId, { lines: [{ productId: ids.a, cases: [{ unitsPerCase: 12, cases: 1 }], looseUnits: 3 }, { productId: ids.c, cases: [], looseUnits: 2 }, { productId: ids.b, cases: [], looseUnits: 0 }] }, person))
    expect(await inside(() => draft.sendDraft(planId, { owners: { prepOwner: 'SELLER', labelOwner: 'AMAZON' } }, person))).toEqual({ planId })
    const row = await rowOf(planId)
    expect(row).toMatchObject({ status: 'QUEUED', currentStep: 'CREATE', source: 'matrix' })
    expect(row?.name).toMatch(/^Nexus IT \d{4}-\d{2}-\d{2} #/)
    const lines = (await linesOf(planId)).sort((x, y) => (x.msku ?? '').localeCompare(y.msku ?? ''))
    expect(lines.map((l) => [l.productId, l.quantity, l.msku, l.prepOwner, l.labelOwner, !!l.reservationId])).toEqual([
      [ids.a, 15, 'TEST-DRAFT-A', 'SELLER', 'SELLER', true],
      [ids.c, 2, 'TEST-DRAFT-C', 'SELLER', 'AMAZON', true],
    ])
    expect(await levelOf(ids.a)).toEqual({ quantity: 40, reserved: 15, available: 25 })
    expect(await levelOf(ids.c)).toEqual({ quantity: 5, reserved: 2, available: 3 })
    expect(dispatchFbaPlan).toHaveBeenCalledWith(planId)
    expect((await events()).at(-1)?.payload).toMatchObject({ planId, status: 'QUEUED', step: 'CREATE' })
    expect((await events()).at(-1)?.payload.productIds).toEqual(expect.arrayContaining([ids.a, ids.b, ids.c]))

    // A second click: the same plan, no second hold.
    expect(await inside(() => draft.sendDraft(planId, {}, person))).toEqual({ planId })
    expect(await levelOf(ids.a)).toEqual({ quantity: 40, reserved: 15, available: 25 })
    expect(await caught(() => inside(() => draft.updateDraft(planId, { lines: [] }, person)))).toMatchObject({ code: 'WRONG_STATE' })
    expect(await caught(() => inside(() => draft.deleteDraft(planId, person)))).toMatchObject({ code: 'WRONG_STATE' })
    // A new draft for the same pair is made now (the sent one is no longer a draft).
    const next = await add({})
    expect(next.planId).not.toBe(planId)
    expect(await caught(() => inside(() => draft.sendDraft(next.planId, {}, person)))).toMatchObject({ code: 'REFUSED', message: FBA_SEND_COPY.problem.noUnits })
  })
})

describe('the reads — list, facts, open units, the job', () => {
  it('tabs with counts, newest change first, a cursor; with productId the family; a bad cursor is refused', async () => {
    await add({ market: 'DE', lines: [{ productId: ids.b, looseUnits: 1 }] })
    const all = await inside(() => read.readPlanList({}))
    const counts = all.counts
    expect(counts.drafts).toBe((await drafts()).length)
    expect(counts.active).toBeGreaterThanOrEqual(1)
    const draftsTab = await inside(() => read.readPlanList({ view: 'drafts' }))
    expect(draftsTab.plans.every((p) => p.status === 'DRAFT')).toBe(true)
    expect(draftsTab.counts).toEqual(counts)
    const active = await inside(() => read.readPlanList({ view: 'active' }))
    expect(active.plans.every((p) => p.status !== 'DRAFT')).toBe(true)
    const page1 = await inside(() => read.readPlanList({ limit: 1 }))
    expect(page1.plans).toHaveLength(1)
    expect(page1.next).not.toBeNull()
    const page2 = await inside(() => read.readPlanList({ limit: 1, cursor: page1.next }))
    expect(page2.plans[0].id).not.toBe(page1.plans[0].id)
    expect(Date.parse(page2.plans[0].createdAt)).not.toBeNaN()
    const open = await inside(() => read.readPlanList({ open: true, productId: ids.parent }))
    expect(open.plans.length).toBeGreaterThanOrEqual(1)
    expect(await caught(() => inside(() => read.readPlanList({ cursor: 'not-a-cursor' })))).toMatchObject({ code: 'REFUSED' })
  })

  it('send-draft: with planId the draft\'s own facts and lines; with SKUs the open draft\'s lines for them; a draft never counts as "in an open plan"', async () => {
    const { planId } = await add({ lines: [{ productId: ids.b, looseUnits: 4 }] })
    const own = await inside(() => send.readSendDraft({ productIds: [], planId }))
    expect(own).toMatchObject({ draftId: planId, market: 'IT', from: { code: 'TEST-MAIN' } })
    expect(own.lines).toEqual([{ productId: ids.b, cases: [], looseUnits: 4 }])
    expect(own.skus.map((sku) => [sku.sku, sku.openPlanUnits])).toEqual([['TEST-DRAFT-B', 0]])
    const fromMatrix = await inside(() => send.readSendDraft({ productIds: [ids.parent] }))
    expect(fromMatrix.draftId).toBe(planId)
    expect(fromMatrix.lines).toEqual([{ productId: ids.b, cases: [], looseUnits: 4 }])
    // A: 15 units in a plan under way (sent above); B's 4 in the draft do not count.
    expect(fromMatrix.skus.map((sku) => [sku.sku, sku.openPlanUnits])).toEqual([['TEST-DRAFT-A', 15], ['TEST-DRAFT-B', 0], ['TEST-DRAFT-C', 2]])
    const sent = (await inside(() => read.readPlanList({ view: 'active' }))).plans[0]
    expect(await caught(() => inside(() => send.readSendDraft({ productIds: [], planId: sent.id })))).toMatchObject({ code: 'WRONG_STATE' })
    // An empty draft still has its From, To, day and box.
    await inside(() => draft.updateDraft(planId, { lines: [] }, person))
    expect(await inside(() => send.readSendDraft({ productIds: [], planId }))).toMatchObject({ draftId: planId, skus: [], lines: [], mixedBox: MIXED_BOX_DEFAULT })
  })
})
