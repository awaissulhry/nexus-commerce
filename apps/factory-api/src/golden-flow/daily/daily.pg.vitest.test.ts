import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lockPhrases, monthLabel, monthOfDay } from '@nexus/factory-domain/accounting/periods'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { SHEET_TYPES } from '@nexus/factory-domain/imports/job'
import { fifteenthOfNextMonth } from '@nexus/factory-domain/invoicing/fatturapa/format'
import { supplierInvoiceXml } from '@nexus/factory-domain/payables/testing'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { dueDateOf } from '@nexus/factory-domain/sales/terms/terms'
import { textOf } from '../../adapters/ses/fake'
import { callerFor } from '../../core/command'
import { runSdiPoll } from '../../modules/invoicing/sdi/poll'
import { processCarrier } from '../../modules/shipping/labels/carrier'
import { pollShipment, runTrackingPoll } from '../../modules/shipping/labels/poll'
import { runAlertEvaluation } from '../../platform/alerts/engine'
import type { Browser } from '../../platform/auth/sessions/testing/harness'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { systemContext } from '../../platform/outbox/system'
import { standardReasonsForNewTenants } from '../../platform/reasons/standard'
import type { SearchIndexer } from '../../platform/search/indexer'
import { indexNewTenants } from '../../platform/search/indexing'
import { fireDueTimers } from '../../platform/timers/fire'
import { admin, announce, call, floorWorker, linkBrowser, linkTokenSentTo, ok, pdf, person, putBytes, QUIET, sha256, signOn, startWorld, stepped, tablet, type FloorWorker, type Person, type World } from '../testing/world'
import { assertEveryHandler, everyHandler, searchIndexers, settler } from './testing/day'

/**
 * The W2a golden flow (B-W2a-82; design check I1): a factory day after the first order, THROUGH THE HTTP ROUTES, each act
 * by the role that does it, in stages:
 *
 *   S  a second order typed by hand for a repeat customer at its price list (no quote), amended
 *   M  its work order: the release check with its blockers (material expected from a sent PO, a hold on the draft), the
 *      floor (pick, cut per hide, bundles of whole garments, scans, garment labels), a FAILED final inspection, the hold
 *      from it, the NCR with a rework order, the re-inspection, the releases; the trace; standard vs actual
 *   T  a partial shipment with its backorder, the freight line on the first invoice, the rest shipped and invoiced
 *      (TD24), part payment, the customer's statement; the reminder ladder stays off (the Owner's switch)
 *   R  a return with grading and its credit note (the worker's TD04 draft, issue, SDI), the refund; a repair through
 *      its repair work order and safety check; a SAFETY complaint the owner acknowledges
 *   B  buying every day: a supplier item, PO revisions confirmed by link, close short, Send n, a reminder, a receipt
 *      discrepancy and its report, a hide-list import, a return to the supplier, a claim, supplier invoices from the
 *      FAKE SDI inbox matched (one after the goods, by the worker), approved by another person, paid, a credit note
 *   K  stock every day: a write-off with its reason, a reservation, a count with an applied difference, a subcontract
 *      kit out and back with its DDT, the stock value
 *   H  planning (the plan with a firm order, exceptions, a reorder point, capacity and a closed day), the schedule
 *      published to the floor, an unsafe machine signed safe by a technician, an alert and the seeded NCR finished,
 *      followers, mentions and tasks, a style copy whose second release opens a type-change review
 *   X  the month-end export (numbered) and the period lock
 *   Z  the end checks: nothing finished waits on Home, every audit action and event, no worker retry, an empty outbox
 *
 * World: the W1 golden world (../testing/world.ts: a throwaway PostgreSQL 17 database from the migrations, EVERY base
 * seed plus the W1 golden scenario, the real app with the real sign-in, every outside provider FAKE) and the worker of
 * the day (./testing/day.ts: EVERY handler list of background.ts, run in-process by the real outbox relay after each
 * step). The scheduler's crons run as their ticks with a moved clock where a step needs one. Each step is one test, in
 * order; a step a merged step's gap still keeps out of reach is an `it.todo` naming the reason and the step. Dates are
 * today's (the seeded story is in November 2026: a few checks name the day until which they hold). Every name and
 * number is made up. Run with `node scripts/factory/golden-flow.mjs daily`.
 */

let w: World
let handlers: readonly EventHandler[]
let indexers: readonly SearchIndexer[]
let settle: () => Promise<string[]>
type Role = 'sales' | 'finance' | 'finance2' | 'planner' | 'buyer' | 'warehouse' | 'manager' | 'inspector' | 'inspector2' | 'supervisor' | 'admin' | 'maintenance'
const P = {} as Record<Role, Person>
type Json = Record<string, any>
/** What the day made, step by step (ids, versions, documents). */
const G = {} as Record<string, any>
/** Every record the day made: the end checks look for their audit rows and events. */
const made = new Set<string>()
const keep = (...ids: (string | undefined | null)[]) => ids.forEach((id) => id && made.add(id))
/** The records the day finished: none of them may wait on anyone's Home at the end. */
const finished = new Set<string>()
const done = (...ids: (string | undefined | null)[]) => ids.forEach((id) => id && finished.add(id))
const today = () => businessDate(new Date())
const id = (key: string) => w.id(key)
const siteA1 = () => id('site:A1')
const companyA = () => id('company:A')
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []

beforeAll(async () => {
  w = await startWorld()
  indexers = await searchIndexers()
  handlers = everyHandler(indexers)
  settle = settler(w, handlers)
  for (const [key, role] of [
    ['sales', 'sales'],
    ['finance', 'finance'],
    ['finance2', 'finance'],
    ['planner', 'planner'],
    ['buyer', 'buyer'],
    ['warehouse', 'warehouse'],
    ['manager', 'production_manager'],
    ['inspector', 'quality_inspector'],
    ['inspector2', 'quality_inspector'],
    ['supervisor', 'floor_supervisor'],
    ['admin', 'admin'],
    ['maintenance', 'maintenance'],
  ] as const) {
    P[key] = await person(w, key, role)
  }
}, 600_000)

afterAll(async () => {
  await w?.close()
}, 60_000)

// One step may take a while on a loaded machine (a step signs in tablets, renders PDFs, runs the worker).
describe('the W2a golden flow: a factory day through the HTTP routes', { timeout: 180_000 }, () => {
  it('00 the world: the worker of the day runs every handler list of background.ts; the worker’s start work and the seeds drain', async () => {
    G.dayStart = new Date()
    assertEveryHandler()
    // What the worker does when it starts (background.ts): the standard reasons for empty lists, the search index.
    await standardReasonsForNewTenants({ database: w.h.database, log: QUIET })
    await indexNewTenants({ database: w.h.database, indexers, log: QUIET })
    await settle()
    expect((await ok(P.maintenance, 'GET', '/auth/office/me')).user.id).toBe(P.maintenance.id)
  })

  // ---- S and T constants (prefixed st / ST_) ------------------------------------------------------------------------------
  type STJson = Record<string, any>
  /** The repeat order: one line SEED-JKT-01 BLK, 8 pieces at P1's list 420.00 (base list 450.00). */
  const ST_SIZES = [
    { size: '50', quantity: 2 },
    { size: '52', quantity: 4 },
    { size: '54', quantity: 2 },
  ] as const
  const ST_PIECES = 8
  const ST_NET = 336_000 // 8 × 420.00
  const ST_VAT = 73_920 // 22 %
  const ST_GROSS = 409_920
  /** Shipment 1: sizes 50 and 52 (6 garments) and the freight finance types; shipment 2: size 54 (2). */
  const ST_FIRST = ['50', '52']
  const ST_FREIGHT = 1_500
  const ST_INV1 = { net: 252_000 + ST_FREIGHT, vat: 55_770, gross: 309_270 }
  const ST_INV2 = { net: 84_000, vat: 18_480, gross: 102_480 }
  const ST_PART = 100_000
  const ST_ORDERS_MAIL = 'buyer.p1@example.com'
  const ST_INVOICES_MAIL = 'accounts.p1@example.com'
  const stLine = () => ({ styleId: id('product:style:JKT-01'), colourwayId: id('product:colourway:JKT-01:BLK') })
  const stManual = (sizes: readonly { size: string; quantity: number }[] = ST_SIZES) => ({
    companyId: companyA(),
    partyId: id('party:P1'),
    customerRef: 'PO-GOLDEN-REPEAT-01',
    promiseDate: addDays(today(), 42),
    // Not P1's DEP30 / 30 %: bank transfer 30 days end of month, no deposit (nothing holds production at release).
    paymentTermsId: id('pricing:terms:BB30FM'),
    depositPct: null,
    // No unitPrice: P1's list price applies.
    lines: [{ ...stLine(), sizes: sizes.map((entry) => ({ size: entry.size, quantity: entry.quantity })) }],
  })
  const stSizeOf = (backorder: STJson, size: string) => (backorder.lines as STJson[])[0]!.sizes.find((entry: STJson) => entry.size === size)
  const stFreightWords = (ddt: STJson) => `Spese di trasporto DDT n. ${ddt.number} del ${String(ddt.documentDate).split('-').reverse().join('/')}`

  // ---- S: the second order, typed by hand at the customer's price list ---------------------------------------------------

  it('S01 sales types a repeat order for P1: the next number, P1’s list price while typing, no deposit; a size the style does not make is refused in words', async () => {
    const { party } = await ok(P.sales, 'GET', `/parties/${id('party:P1')}`)
    expect(party).toMatchObject({ code: 'SEED-C1', legalName: 'Seed Customer One S.r.l.' })
    G.party = party
    const { number } = await ok(P.sales, 'GET', `/sales/order-numbers/next?companyId=${companyA()}`)
    expect(number).toMatch(/^SO-\d{4}-\d{4}$/)
    G.orderNumberPreview = number
    // While typing: the first size only, then the whole grid; nothing is written.
    const typing = await ok(P.sales, 'POST', '/sales/orders/manual/preview', stManual([{ size: '50', quantity: 2 }]))
    expect(typing).toMatchObject({ ok: true, number, problems: [] })
    expect(typing.order.netAmount).toBe(84_000)
    const preview = await ok(P.sales, 'POST', '/sales/orders/manual/preview', stManual())
    expect(preview).toMatchObject({ ok: true, number, problems: [] })
    // P1's list SEED-PL-P1: 420.00 for SEED-JKT-01 (the base list's would be 450.00).
    expect(preview.order).toMatchObject({ currency: 'EUR', taxMode: 'IT_B2B', priceBasis: 'NET', paymentTermsId: id('pricing:terms:BB30FM'), depositPct: null, depositAmount: null, netAmount: ST_NET, vatAmount: ST_VAT, grossAmount: ST_GROSS, schedule: [] })
    expect(preview.order.lines.map((line: STJson) => [line.seq, line.unitPrice, line.quantity, line.netAmount])).toEqual([[10, '420', ST_PIECES, ST_NET]])
    // Sales holds the price and margin grains, never the cost.
    expect(preview.order).not.toHaveProperty('costAmount')
    expect(preview.order.lines[0]).not.toHaveProperty('costAmount')
    // Refused in words: a size outside the style's range (SEED-JKT-01 makes 50, 52, 54).
    const wrong = await ok(P.sales, 'POST', '/sales/orders/manual/preview', stManual([{ size: '60', quantity: 1 }]))
    expect(wrong).toMatchObject({ ok: false, order: null })
    expect(wrong.problems).toEqual([expect.objectContaining({ path: 'body/lines/0/sizes/0/size', message: expect.stringMatching(/Not a size/) })])
  })

  it('S02 sales confirms the order: CONFIRMED in one command, no deposit request, no payment milestones; finance sees the cost, sales does not', async () => {
    const { order } = await ok(P.sales, 'POST', '/sales/orders/manual', stManual(), 201)
    keep(order.id)
    expect(order).toMatchObject({
      number: G.orderNumberPreview,
      status: 'CONFIRMED',
      partyId: id('party:P1'),
      customerRef: 'PO-GOLDEN-REPEAT-01',
      orderDate: today(),
      paymentTermsId: id('pricing:terms:BB30FM'),
      depositRequired: false,
      netAmount: ST_NET,
      vatAmount: ST_VAT,
      grossAmount: ST_GROSS,
      locked: true,
      amendments: { count: 0, latestRevision: null },
      chain: { quote: null, depositRequests: [], workOrders: [], shipments: [], invoices: [] },
    })
    expect(order.lines.map((line: STJson) => [line.seq, line.style?.code, line.colourway?.code, line.unitPrice, line.quantity])).toEqual([[10, 'SEED-JKT-01', 'BLK', '420', ST_PIECES]])
    expect(order.lines[0].sizes.map((entry: STJson) => [entry.size, entry.quantity])).toEqual(ST_SIZES.map((entry) => [entry.size, entry.quantity]))
    expect(order.progress).toMatchObject({ ordered: ST_PIECES, shipped: 0, toShip: ST_PIECES })
    expect(order.billTo).toMatchObject({ taxMode: 'IT_B2B' })
    // The orders list: no deposit needed (nothing holds the work order's release on a deposit).
    const listed = (await ok(P.sales, 'GET', `/sales/orders?q=${order.number}`)).orders as STJson[]
    expect(listed.find((row) => row.id === order.id)).toMatchObject({ deposit: { state: 'NOT_NEEDED' }, units: ST_PIECES, shippedUnits: 0 })
    // Paid on invoice terms: no milestones.
    const schedule = await ok(P.sales, 'GET', `/sales/orders/${order.id}/schedule`)
    expect(schedule).toMatchObject({ steps: [], cancelled: [], grossAmount: ST_GROSS, openAmount: 0, paidAmount: 0 })
    // The grains: sales sees prices and margin %, no cost; finance sees the cost.
    expect(order).not.toHaveProperty('costAmount')
    expect(order.lines[0]).not.toHaveProperty('unitCost')
    expect(order).toHaveProperty('marginPct')
    const forFinance = (await ok(P.finance, 'GET', `/sales/orders/${order.id}`)).order
    expect(forFinance).toHaveProperty('costAmount')
    expect(forFinance.lines[0]).toHaveProperty('unitCost')
    // The order's margin read (B-W2a-29): the value for both, the estimate's cost for finance only.
    const margin = await ok(P.sales, 'GET', `/costing/margins/orders/${order.id}`)
    expect(margin.lines[0]).toMatchObject({ quantity: ST_PIECES, value: ST_NET })
    expect(margin.lines[0]).not.toHaveProperty('estimateCost')
    expect((await ok(P.finance, 'GET', `/costing/margins/orders/${order.id}`)).lines[0]).toHaveProperty('estimateCost')
    expect(await settle()).toContain('sales_order.created')
    G.order = (await ok(P.sales, 'GET', `/sales/orders/${order.id}`)).order
  })

  it('S03 the customer sends a new PO reference and a later requested date: sales reviews the amendment (no re-acceptance), a stale copy is refused, then it is applied', async () => {
    const change = { reason: 'The customer re-issued its purchase order with a new reference and date.', customerRef: 'PO-GOLDEN-REPEAT-01/B', requestedDate: addDays(today(), 35), lines: [{ id: G.order.lines[0].id }] }
    const review = await ok(P.sales, 'POST', `/sales/orders/${G.order.id}/amendments/preview`, { version: G.order.version, ...change })
    expect(review).toMatchObject({ ok: true, revision: 1, problems: [] })
    expect(review.diff).toMatchObject({ lines: [], netAmountBefore: ST_NET, netAmountAfter: ST_NET, reacceptanceNeeded: false })
    expect(review.diff.header.map((entry: STJson) => [entry.field, entry.after])).toEqual([
      ['customerRef', 'PO-GOLDEN-REPEAT-01/B'],
      ['requestedDate', change.requestedDate],
    ])
    // Refused: a copy of the order read before somebody else changed it (COL-078), in words.
    const stale = await ok(P.sales, 'POST', `/sales/orders/${G.order.id}/amendments`, { version: G.order.version + 3, ...change }, 409)
    expect(stale.error.message).toMatch(/changed since it was read .* Reload it and apply the change again\./)
    const applied = await ok(P.sales, 'POST', `/sales/orders/${G.order.id}/amendments`, { version: G.order.version, ...change }, 201)
    expect(applied.order).toMatchObject({ customerRef: 'PO-GOLDEN-REPEAT-01/B', requestedDate: change.requestedDate, netAmount: ST_NET, reapprovalNeededAt: null, amendments: { count: 1, latestRevision: 1 } })
    expect(applied.order.lines[0].quantity).toBe(ST_PIECES)
    expect(applied.amendment).toMatchObject({ revision: 1, reacceptance: 'NOT_NEEDED' })
    const list = await ok(P.sales, 'GET', `/sales/orders/${G.order.id}/amendments`)
    expect(list.amendments.map((entry: STJson) => [entry.revision, entry.reacceptance, entry.createdById])).toEqual([[1, 'NOT_NEEDED', P.sales.id]])
    expect(await settle()).toContain('sales_order.amended')
    G.order = (await ok(P.sales, 'GET', `/sales/orders/${G.order.id}`)).order
  })

  // ---- M helpers (prefixed m / M_) --------------------------------------------------
  const M_SIZES = { '50': 2, '52': 4, '54': 2 } as const
  const M_PIECES = Object.values(M_SIZES).reduce((sum, n) => sum + n, 0)
  const M_CHECKS = ['EN17092_CLASS_LABEL', 'SIZE_LABEL', 'CE_MARK', 'CARE_LABEL', 'FIBRE_COMPOSITION', 'ANIMAL_ORIGIN_PHRASE', 'ZIPS', 'REFLECTIVES', 'ARMOUR_FITTED', 'HANGTAGS', 'USER_INFORMATION', 'PACKAGING']
  const M_PLAN = { inspectionLevel: 'II', aqlMajor: '2.5', aqlMinor: '4.0', acceptMajor: 0, acceptMinor: 1 } as const
  const M_KINDS = ['CUTTING', 'SEWING', 'INSPECTION', 'PACKING'] as const
  const mCheckOf = (answer: Json, code: string): Json => (answer.checks as Json[]).find((check) => check.code === code)!
  const mBlocked = (answer: Json): string[] => (answer.checks as Json[]).filter((check) => check.state === 'BLOCKED').map((check) => check.code)
  /** The seeds' "first row" ids (holds.ts gives its first hold, first disposition … ids that start with eight zeros). */
  const mSeedFirstId = (key: string) => `00000000${id(key).slice(8)}`
  const mLeather = () => id('product:item:leather')
  const mBlk = () => id('product:item-colour:leather:BLK')
  const mProtector = () => id('product:item:protector')
  const mLeatherPath = () => `materials/${mLeather()}/${mBlk()}`
  const mOps = (): Json[] => (G.wo.spec.operations as Json[]).filter((op) => op.scanRequired).sort((a, b) => a.seq - b.seq)
  const mOpOf = (kind: (typeof M_KINDS)[number]): Json => mOps().find((op) => op.workCentreKind === kind)!
  const mCellOf = (size: string): Json => (G.wo.cells as Json[]).find((cell) => cell.size === size)!
  const mResign = (kind: (typeof M_KINDS)[number]) => ok(G.tablets[kind], 'POST', '/floor/sign-in', { badgeCode: G.workers[kind].badgeCode, pin: G.pins[kind] })
  const mDispositions = async (): Promise<Record<string, string>> =>
    Object.fromEntries(((await ok(P.inspector, 'GET', '/quality/dispositions')).dispositions as Json[]).map((code) => [code.code, code.id]))
  /** An NCR's close is an e-signature: a fresh step-up, the record's version read, then the close. */
  async function mNcrClose(who: Person, ncrId: string, note: string, status = 200): Promise<Json> {
    await stepped(w, who)
    const { record } = await ok(who, 'GET', `/quality/ncr/${ncrId}`)
    return ok(who, 'POST', `/quality/ncr/${ncrId}/close`, { version: record.ncr.version, note }, status)
  }

  // ---- M00-M06 the work order: released with its blockers, the leather bought and received ----------------------------------------

  it('M00 SEED-JKT-01 revision 1 is released, its signed DoC and leaflet filed, and compliance decides the seeded lining change needs no notified body', async () => {
    // The product seed leaves SEED-JKT-01's revision DRAFT (seed/product.ts): its first work order needs it RELEASED (release
    // check REVISION) and its garments' release needs the DoC and leaflet of the label's languages (quality/final facts.ts
    // DOCUMENTS).
    const styleId = id('product:style:JKT-01')
    const revisionId = id('product:revision:JKT-01:1')
    const path = `/product/styles/${styleId}/revisions/${revisionId}`
    const bom = (await ok(P.manager, 'GET', `${path}/bom`)).bom
    expect(bom).toMatchObject({ releasable: true, issues: [], revision: { status: 'DRAFT' } })
    const released = (await ok(P.manager, 'POST', `${path}/release`, { version: bom.revision.version, changeNote: 'Seeded jacket, first release for production' })).bom
    expect(released).toMatchObject({ revision: { status: 'RELEASED' }, style: { status: 'ACTIVE' } })
    // As W1 step 06; the seeded en DoC DRAFT (seed/compliance.ts) is the one the upload fills (documents.ts finds it).
    for (const kind of ['DECLARATION_OF_CONFORMITY', 'USER_INFORMATION']) {
      for (const language of ['it', 'en']) {
        const body = pdf(`${kind} ${language} SEED-JKT-01 rev 1`)
        const announced = await ok(P.inspector, 'POST', `/product/styles/${styleId}/compliance/documents`, { revisionId, kind, language, ...announce(`${kind.toLowerCase()}-${language}.pdf`, body) }, 201)
        await putBytes(w, announced, body)
        const confirmed = await ok(P.inspector, 'POST', `/product/styles/${styleId}/compliance/documents/${announced.document.id}/files/${announced.file.id}/complete`)
        expect(confirmed.document.status).toBe('ISSUED')
        keep(announced.document.id)
      }
    }
    expect((await ok(P.inspector, 'GET', `/product/styles/${styleId}/compliance?revisionId=${revisionId}`)).compliance.blockers ?? []).toEqual([])
    // B-W2a-66: the seeds' OPEN type-change review of revision 1 (a lighter lining weave than the certificate examined) holds
    // the class label of every garment of it until compliance decides; the inspector decides the notified body needs no word.
    const changes = (await ok(P.inspector, 'GET', `/compliance/type-changes/styles/${styleId}?revisionId=${revisionId}`)).changes
    expect(changes.certificates.map((entry: Json) => [entry.certificate.number, entry.labelHeld])).toEqual([['SEED-CERT-0001', true]])
    const seeded = (await ok(P.inspector, 'GET', `/compliance/type-changes/${id('compliance:type-change:JKT-01:1')}`)).review
    expect(seeded).toMatchObject({ status: 'OPEN', holdsLabel: true })
    const decided = (await ok(P.inspector, 'POST', `/compliance/type-changes/${seeded.id}/not-needed`, { version: seeded.version, reason: 'Same polyester lining, a lighter weave of the same fabric: no change to the protection examined.' })).review
    expect(decided).toMatchObject({ status: 'NOT_NEEDED', holdsLabel: false })
    await settle()
  })

  it('M00b finance freezes the standard cost of the jacket’s black sizes from its cost sheet: the month’s finished-goods moves are valued at it (the production manager may not)', async () => {
    const body = { companyId: companyA(), validFrom: `${monthOfDay(today())}-01`, items: ['50', '52', '54'].map((size) => ({ variantId: id(`product:variant:JKT-01:BLK:${size}`) })), note: 'Season standard from the released cost sheet' }
    await ok(P.manager, 'POST', '/costing/standards/prepare', body, 403)
    const prepared = await ok(P.finance, 'POST', '/costing/standards/prepare', body)
    expect(prepared.skipped).toEqual([])
    expect(prepared.prepared.map((standard: Json) => standard.status)).toEqual(['DRAFT', 'DRAFT', 'DRAFT'])
    for (const standard of prepared.prepared as Json[]) {
      const frozen = await ok(P.finance, 'POST', `/costing/standards/${standard.id}/freeze`, { version: standard.version })
      expect(frozen).toMatchObject({ standard: { status: 'FROZEN' }, ended: null })
      keep(standard.id)
    }
    await settle()
  })

  it('M01 the planner makes the work order from the order line: a DRAFT whose release check finds the black leather short at A1', async () => {
    const { workOrder } = await ok(P.planner, 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: G.order.lines[0].id }] }, 201)
    keep(workOrder.id)
    expect(workOrder.status).toBe('DRAFT')
    expect((workOrder.cells as Json[]).map((cell) => [cell.size, cell.quantity]).sort()).toEqual(Object.entries(M_SIZES))
    G.mDraft = workOrder
    // The seeds hold no usable black leather at A1: SEED-HIDE-0001 is issued to SEED-WO-0001 (seed/production.ts) and
    // SEED-HIDE-0002 is under the seeded ACTIVE hold of SEED-NCR-0002 (seed/holds.ts); the open rest of SEED-PO-0001 (315 ft²)
    // is the seeded order SO1's. The protectors: none on hand (SEED-GR-0002 is not posted). Only MATERIAL holds the release.
    const check = await ok(P.planner, 'GET', `/production/work-orders/${workOrder.id}/release-check`)
    expect(check.releasable).toBe(false)
    expect(mBlocked(check)).toEqual(['MATERIAL'])
    expect(mCheckOf(check, 'HOLDS')).toMatchObject({ state: 'OK', problems: [] })
    expect(mCheckOf(check, 'DEPOSIT').state).not.toBe('BLOCKED')
    expect((mCheckOf(check, 'MATERIAL').problems as Json[]).map((problem) => problem.path)).toContain(mLeatherPath())
    const blk = (check.readiness.materials as Json[]).find((entry) => entry.itemId === mLeather() && entry.itemColourId === mBlk())
    expect(blk!.word).not.toBe('EXPECTED')
  })

  it('M02 the buyer orders black leather and protectors from the supplier and sends the PO; the supplier confirms; the leather is now expected in time (B-W2a-46)', async () => {
    const needDate = addDays(today(), 14)
    let order = (await ok(P.buyer, 'POST', '/purchasing/orders', { companyId: companyA(), siteId: siteA1(), partyId: id('party:P2'), requestedDate: needDate, note: 'Black leather for the second order of the day' }, 201)).order
    keep(order.id)
    // Leather in ft² (any unit it converts): 1120 ft² cover this work order and every earlier black demand the live plan nets
    // first (SO1, SEED-WO-0001's rest, SEED-WO-0002); protectors in the supplier's steps of 12.
    order = (await ok(P.buyer, 'POST', `/purchasing/orders/${order.id}/lines`, { version: order.version, itemId: mLeather(), itemColourId: mBlk(), quantity: '1120', uom: 'FT2', needDate }, 201)).order
    order = (await ok(P.buyer, 'POST', `/purchasing/orders/${order.id}/lines`, { version: order.version, itemId: mProtector(), quantity: '36', uom: 'PCS', needDate }, 201)).order
    expect(order.lines.length).toBe(2)
    const sendCheck = await ok(P.buyer, 'GET', `/purchasing/orders/${order.id}/send-check`)
    expect((sendCheck.checks as Json[]).filter((entry) => entry.severity === 'BLOCKS')).toEqual([])
    const sent = await ok(P.buyer, 'POST', `/purchasing/orders/${order.id}/send`, { version: order.version })
    expect(sent).toMatchObject({ order: { status: 'SENT' }, delivery: 'sent' })
    G.mPoTo = sent.sent.to
    await settle()
    const supplier = linkBrowser(w, linkTokenSentTo(w, G.mPoTo))
    const page = await supplier.send('GET', '/link/purchase-order')
    expect(page).toMatchObject({ order: { id: order.id, status: 'SENT' }, canAnswer: true })
    expect(await supplier.send('POST', '/link/purchase-order/confirm', { version: page.order.version, mode: 'ALL_AS_ASKED', typedName: 'Mario Fornitore', supplierRef: 'OC-DAILY-M' })).toMatchObject({ outcome: 'CONFIRMED' })
    G.mPo = (await ok(P.buyer, 'GET', `/purchasing/orders/${order.id}`)).order
    await settle()

    // Still short on hand today (W1's numbers), but the plan expects the leather with the sent order before the need:
    // MATERIAL no longer names it (factory-domain production/work-orders/blockers materialReadinessCheck).
    const check = await ok(P.planner, 'GET', `/production/work-orders/${G.mDraft.id}/release-check`)
    const blk = (check.readiness.materials as Json[]).find((entry) => entry.itemId === mLeather() && entry.itemColourId === mBlk())
    expect(blk).toMatchObject({ word: 'EXPECTED', date: needDate })
    const material = mCheckOf(check, 'MATERIAL')
    expect((material.problems as Json[]).map((problem) => problem.path)).not.toContain(mLeatherPath())
    // Expected: OK for every material (the protectors ride on the same order). Recorded so M04 says honestly how it released.
    G.mMaterialOk = material.state === 'OK'
    expect(G.mMaterialOk).toBe(true)
  })

  it('M03 the inspector holds the DRAFT: its check names the hold, the release is refused with it (an override never lifts a hold), the placer may not release it', async () => {
    const placed = await ok(P.inspector, 'POST', '/quality/holds', { subjectType: 'WorkOrder', subjectIds: [G.mDraft.id], reasonCode: 'QUALITY_CHECK', reasonNote: 'Check the first black sample jacket before the release' }, 201)
    expect(placed.workOrdersHeld).toEqual([expect.objectContaining({ id: G.mDraft.id, from: 'DRAFT' })])
    G.mDraftHold = placed.hold
    keep(placed.hold.id)
    done(placed.hold.id)
    const check = await ok(P.planner, 'GET', `/production/work-orders/${G.mDraft.id}/release-check`)
    expect(check).toMatchObject({ status: 'ON_HOLD', frozen: false, releasable: false })
    expect(mCheckOf(check, 'HOLDS')).toMatchObject({ state: 'BLOCKED', problems: [{ path: `holds/${placed.hold.id}`, message: expect.stringMatching(/^On hold since \d{4}-\d{2}-\d{2}: .+\. Quality releases the hold first\.$/) }] })
    // Refusal in words: the release names the hold, even with the planner's material override (release.pg.vitest.test.ts).
    const refused = await ok(P.planner, 'POST', `/production/work-orders/${G.mDraft.id}/release`, { materialOverride: { reason: 'An override never lifts a hold' } }, 409)
    expect(refused.error.message).toMatch(/problem\(s\) to fix first \(holds\)/)
    expect(refused.error.issues).toEqual([{ path: `holds/${placed.hold.id}`, message: expect.stringMatching(/^On hold since/) }])
    // Four eyes: the one who placed the hold does not release it.
    await stepped(w, P.inspector)
    const { hold } = await ok(P.inspector, 'GET', `/quality/holds/${placed.hold.id}`)
    const own = await ok(P.inspector, 'POST', `/quality/holds/${placed.hold.id}/release`, { version: hold.version }, 409)
    expect((own.error.issues as Json[]).map((issue) => issue.path)).toContain('release/NOT_PLACER')
    await settle()
  })

  it('M04 the second inspector releases the hold (step-up); the planner releases the work order without a material override: the order goes IN_PRODUCTION', async () => {
    await stepped(w, P.inspector2)
    const record = await ok(P.inspector2, 'GET', `/quality/holds/${G.mDraftHold.id}`)
    expect(record.release.releasable).toBe(true)
    const freed = await ok(P.inspector2, 'POST', `/quality/holds/${G.mDraftHold.id}/release`, { version: record.hold.version, note: 'Sample jacket checked: stitching within tolerance', notMakerStatement: true })
    expect(freed.hold).toMatchObject({ status: 'RELEASED', releasedBy: { kind: 'USER', userId: P.inspector2.id } })
    expect(freed.workOrdersLifted).toEqual([expect.objectContaining({ id: G.mDraft.id, to: 'DRAFT' })])
    const current = (await ok(P.planner, 'GET', `/production/work-orders/${G.mDraft.id}`)).workOrder
    expect(current).toMatchObject({ status: 'DRAFT', hold: null })
    const check = await ok(P.planner, 'GET', `/production/work-orders/${G.mDraft.id}/release-check`)
    expect(mBlocked(check)).toEqual(G.mMaterialOk ? [] : ['MATERIAL'])
    const reason = 'The black hides are confirmed by the supplier for next week; cutting waits for them.'
    const wo = (await ok(P.planner, 'POST', `/production/work-orders/${G.mDraft.id}/release`, { version: current.version, ...(G.mMaterialOk ? {} : { materialOverride: { reason } }) })).workOrder
    expect(wo).toMatchObject({ status: 'RELEASED', batchNumber: expect.any(String) })
    expect(wo.release.materialOverride).toEqual(G.mMaterialOk ? null : expect.objectContaining({ reason }))
    G.wo = wo
    await settle()
    expect((await ok(P.sales, 'GET', `/sales/orders/${G.order.id}`)).order.status).toBe('IN_PRODUCTION')
  })

  it('M05 the warehouse receives ten black hides of the PO, hide by hide (the Cr VI test pending: quarantine)', async () => {
    const leather = (G.mPo.lines as Json[]).find((line) => (line.item?.id ?? line.itemId) === mLeather())!
    // Ten hides of 56 ft² (560 of the 1120 ordered: the rest comes later). A hide must hold one size-54 set: 47.5 ft² + 12%
    // wastage = 53.2 ft² (cutting refuses AREA_EXCEEDED below that).
    const received = await ok(
      P.warehouse,
      'POST',
      '/inventory/receipts',
      {
        purchaseOrderId: G.mPo.id,
        supplierDdtNumber: 'DDT-DAILY-M1',
        supplierDdtDate: today(),
        lines: [{ purchaseOrderLineId: leather.id, lots: [{ supplierLotRef: 'TAN-DAILY-BLK', dyeBatch: 'DB-DM-01', shade: 'Nero 01', hides: Array.from({ length: 10 }, (_, n) => ({ supplierCode: `TB-${n + 1}`, area: '56.0', grade: 'A', thicknessMm: '1.2' })) }] }],
      },
      201,
    )
    expect(received.receipt).toMatchObject({ status: 'POSTED', purchaseOrder: { status: 'PARTLY_RECEIVED' } })
    const lot = (received.receipt.lines as Json[]).find((entry) => entry.orderLine?.id === leather.id || entry.purchaseOrderLineId === leather.id)?.lots[0]
    expect(lot).toMatchObject({ qualityStatus: 'QUARANTINE', holds: ['CR_VI_TEST'], crViStatus: 'PENDING' })
    G.mLot = lot
    const lots = (await ok(P.warehouse, 'GET', `/inventory/receipts/${received.receipt.id}/lots`)).lots as Json[]
    G.mHides = lots.find((entry) => entry.id === lot.id)!.hides
    expect(G.mHides.length).toBe(10)
    keep(received.receipt.id, lot.id, ...G.mHides.map((hide: Json) => hide.id))
    await settle()
  })

  it('M06 the inspector (not the receiver) records the Cr VI result with the lab report and releases the black lot', async () => {
    const base = `/quality/lots/${G.mLot.id}`
    let lot = (await ok(P.inspector, 'GET', base)).lot
    expect(lot.receivedById).toBe(P.warehouse.id)
    const report = pdf('Cr VI test report TL-DAILY-M1')
    const announced = await ok(P.inspector, 'POST', `${base}/results/report`, announce('cr6-daily.pdf', report), 201)
    await putBytes(w, announced, report)
    const recorded = await ok(
      P.inspector,
      'POST',
      `${base}/results`,
      { version: lot.version, test: 'CR_VI', method: 'EN ISO 17075-1', valueMgKg: '1.1', lab: 'Test Lab One (made up)', reportNumber: 'TL-DAILY-M1', testedOn: today(), evidence: 'LOT_REPORT', fileId: announced.file.id },
      201,
    )
    expect(recorded).toMatchObject({ result: { verdict: 'PASS' }, checklist: { ready: true } })
    lot = recorded.lot
    const released = (await ok(P.inspector, 'POST', `${base}/release`, { version: lot.version, confirmCode: lot.code })).lot
    expect(released.qualityStatus).toBe('RELEASED')
    G.mLotCode = lot.code
    await settle()
  })

  // ---- M07-M12 the floor: tablets, pick and issue, cutting per hide, bundles of whole garments, scans, labels ----------------------

  it('M07 the supervisor enrols a tablet per station and four floor workers (badge, PIN, notice); the admin adds the garment label printer', async () => {
    const roleId = id('role:operator')
    G.tablets = {} as Record<string, Browser>
    G.workers = {} as Record<string, FloorWorker>
    const pins = { CUTTING: '481537', SEWING: '592648', INSPECTION: '603759', PACKING: '714860' } as const
    G.pins = pins
    for (const [kind, station] of [
      ['CUTTING', 'CUT-01'],
      ['SEWING', 'SEW-01'],
      ['INSPECTION', 'QC-01'],
      ['PACKING', 'PACK-01'],
    ] as const) {
      const device = await tablet(w, P.supervisor, siteA1(), id(`site:A1:station:${station}`), `Daily tablet ${station}`)
      const worker = await floorWorker(w, P.supervisor, siteA1(), `Daily ${kind.toLowerCase()} worker`, roleId)
      await signOn(device, worker, pins[kind])
      G.tablets[kind] = device
      G.workers[kind] = worker
      keep(worker.id)
    }
    const { printer } = await ok(
      P.admin,
      'POST',
      '/print/printers',
      { siteId: siteA1(), code: 'LBL-DAY', name: 'Daily garment label printer', kind: 'LABEL_ZPL', relay: 'FAKE', relayTarget: 'daily-label:9100', dpi: 203, labelWidthMm: 100, labelHeightMm: 100 },
      201,
    )
    G.garmentPrinter = printer.id
  })

  it('M08 pick and issue: the cutting tablet reads the pick list and issues eight of the new black hides to the work order', async () => {
    const cutting = G.tablets.CUTTING as Browser
    const pick = await ok(cutting, 'GET', `/inventory/picking/work-orders/${G.wo.id}`)
    const leather = (pick.lines as Json[]).find((line) => line.itemId === mLeather())
    const ours = new Set(G.mHides.map((hide: Json) => hide.code))
    expect(leather!.usable.candidates.some((candidate: Json) => ours.has(candidate.hideCode))).toBe(true)
    // Nothing of SEED-HIDE-0002 (held) is issued: the new hides only, one per jacket.
    G.mCutHides = G.mHides.slice(0, M_PIECES)
    for (const hide of G.mCutHides as Json[]) {
      const issued = await ok(cutting, 'POST', `/inventory/picking/work-orders/${G.wo.id}/issue`, { code: hide.code }, 201)
      expect(Number(issued.issue.baseQuantity)).toBeGreaterThan(0)
    }
    await settle()
    // The first issue starts the work order (inventory/issue start.ts, the worker's handler).
    expect((await ok(P.planner, 'GET', `/production/work-orders/${G.wo.id}`)).workOrder.status).toBe('IN_PROGRESS')
  })

  it('M09 cutting per hide on the floor: one whole set of one size per hide, each hide used up', async () => {
    const cutting = G.tablets.CUTTING as Browser
    // 50, 50, 52, 52, 52, 52, 54, 54: one jacket's set per 56 ft² hide (SEED-JKT-01 takes 43-47.5 ft² + 12%).
    const sets = (G.wo.cells as Json[]).flatMap((cell) => Array.from({ length: cell.quantity }, () => cell))
    expect(sets.length).toBe(G.mCutHides.length)
    for (const [n, hide] of (G.mCutHides as Json[]).entries()) {
      const cut = await ok(cutting, 'POST', `/production/cutting/work-orders/${G.wo.id}/cuts`, { clientEventId: `dm-cut-${hide.code}`, code: hide.code, lines: [{ workOrderSizeId: sets[n]!.id, sets: 1 }], done: { remnant: null } }, 201)
      expect(cut.hide.state).toBe('CONSUMED')
    }
    await settle()
  })

  it('M10 bundles of whole garments (one per size) and their tickets at the cutting table', async () => {
    // B-W2a-74: SEED-WO-0001's seeded bundles are sleeve PART bundles WIP never counts; these are whole garments.
    const made = await ok(G.tablets.CUTTING, 'POST', `/production/bundles/work-orders/${G.wo.id}/bundles`, { bundleSize: 10, printerId: id('print:printer:A1:LBL') }, 201)
    expect((made.bundles as Json[]).map((bundle) => [bundle.size, bundle.quantity]).sort()).toEqual(Object.entries(M_SIZES))
    expect((made.tickets as Json[]).every((ticket) => ticket.problem === null || ticket.problem === undefined)).toBe(true)
    G.mBundles = made.bundles
    keep(...(made.bundles as Json[]).map((bundle) => bundle.id))
    await settle()
  })

  it('M11 every bundle is reported through every operation, each at its own station: all garments finished', async () => {
    expect(mOps().map((op) => op.workCentreKind)).toEqual([...M_KINDS])
    let n = 0
    for (const bundle of G.mBundles as Json[]) {
      for (const op of mOps()) {
        const clientScanId = `dm-scan-${++n}-${bundle.code}`
        const scan = await ok(G.tablets[op.workCentreKind], 'POST', '/production/scans', { clientScanId, code: bundle.code, workOrderOperationId: op.id, good: bundle.quantity }, 201, { 'idempotency-key': clientScanId })
        expect(scan.scan.goodQuantity).toBe(bundle.quantity)
      }
    }
    const wip = await ok(P.planner, 'GET', `/production/scans/work-orders/${G.wo.id}/wip`)
    expect(wip).toMatchObject({ allFinished: true, readyToComplete: true })
    await settle()
  })

  it('M12 the garment labels (batch number) are printed at the packing bench on the 100x100 printer', async () => {
    const printed = await ok(G.tablets.PACKING, 'POST', `/production/serials/work-orders/${G.wo.id}/labels`, { printerId: G.garmentPrinter }, 201)
    expect(printed).toMatchObject({ tracking: 'BATCH', refused: [] })
    expect((printed.printed as Json[]).reduce((sum, entry) => sum + entry.count, 0)).toBe(M_PIECES)
    expect(new Set((printed.printed as Json[]).map((entry) => entry.batchNumber))).toEqual(new Set([G.wo.batchNumber]))
    await settle()
  })

  // ---- M13-M21 final inspection fails: hold, NCR, rework, re-inspection, releases, complete ----------------------------------------
  // The inspection comes before Complete: rework moves only while the work order is RELEASED / IN_PROGRESS (production/rework
  // rules REWORK_MOVE_STATUSES), and an IN_PROGRESS work order is inspected and released as in quality/final's PG test.

  it('M13 the final inspection, assigned to the second inspector (no maker): an open seam on a sleeve, signed FAIL; it waits in “Failed - not decided”', async () => {
    const before = await ok(P.inspector, 'GET', `/quality/final/work-orders/${G.wo.id}`)
    expect(before.maker?.made ?? false).toBe(false)
    const opened = (await ok(P.inspector, 'POST', '/quality/inspections', { workOrderId: G.wo.id, lotSize: M_PIECES, sampleSize: M_PIECES, ...M_PLAN }, 201)).inspection
    keep(opened.id)
    expect(opened).toMatchObject({ status: 'OPEN', assigned: null })
    const picker = await ok(P.inspector, 'GET', `/quality/inspections/inspectors?siteId=${siteA1()}&workOrderIds=${G.wo.id}`)
    expect((picker.inspectors as Json[]).find((entry) => entry.id === P.inspector2.id)).toMatchObject({ kind: 'USER', made: [] })
    const assigned = await ok(P.inspector, 'POST', '/quality/inspections/assign', { inspections: [{ id: opened.id, version: opened.version }], assigneeId: P.inspector2.id })
    expect(assigned.inspections).toEqual([expect.objectContaining({ id: opened.id, assigned: expect.objectContaining({ kind: 'USER', userId: P.inspector2.id }) })])
    // The assignee records from the library (B-W2a-26 seed: SEAM-OPEN, MAJOR) with the garment zone; Ac 0 for majors.
    const recorded = (
      await ok(P.inspector2, 'PUT', `/quality/inspections/${opened.id}/defects`, {
        version: assigned.inspections[0].version,
        defects: [{ defectClass: 'MAJOR', code: 'SEAM-OPEN', quantity: 1, defectCodeId: id('holds:defect:SEAM-OPEN'), zone: 'SLEEVE_L', workOrderSizeId: mCellOf('52').id, description: 'Left sleeve seam open at the cuff' }],
      })
    ).inspection
    expect(recorded.counts).toEqual({ critical: 0, major: 1, minor: 0 })
    expect(recorded.computed.result).toBe('FAIL')
    expect(recorded.defects).toEqual([expect.objectContaining({ code: 'SEAM-OPEN', defectCodeId: id('holds:defect:SEAM-OPEN'), zone: 'SLEEVE_L' })])
    await stepped(w, P.inspector2)
    const failed = (await ok(P.inspector2, 'POST', `/quality/inspections/${opened.id}/decide`, { version: recorded.version, result: 'FAIL', checklist: M_CHECKS.map((code) => ({ code, ok: true })) })).inspection
    expect(failed).toMatchObject({ status: 'FAILED', computed: { result: 'FAIL' }, overridden: false, inspector: { kind: 'OFFICE', userId: P.inspector2.id } })
    G.inspectionFailed = failed
    done(failed.id)
    const undecided = (await ok(P.inspector, 'GET', '/quality/inspections?failedUndecided=true')).inspections as Json[]
    expect(undecided.find((row) => row.id === opened.id)).toMatchObject({ status: 'FAILED', undecided: true, holds: 0, ncrs: 0 })
    await settle()
  })

  it('M14 a hold from the failed inspection puts the work order ON_HOLD: no new inspection while it holds, and its release asks a re-inspection', async () => {
    const placed = await ok(
      P.inspector,
      'POST',
      '/quality/holds',
      { subjectType: 'WorkOrder', subjectIds: [G.wo.id], reasonCode: 'QUALITY_CHECK', reasonNote: 'Open seam found at the final inspection', sourceType: 'Inspection', sourceId: G.inspectionFailed.id },
      201,
    )
    expect(placed.workOrdersHeld).toEqual([expect.objectContaining({ id: G.wo.id, from: 'IN_PROGRESS' })])
    G.mInspectionHold = placed.hold
    keep(placed.hold.id)
    done(placed.hold.id)
    // Decided for the tile: a hold from it.
    expect(((await ok(P.inspector, 'GET', '/quality/inspections?failedUndecided=true')).inspections as Json[]).map((row) => row.id)).not.toContain(G.inspectionFailed.id)
    // Refusal in words (B-W2a-F1 hook, Inspection_awaits_hold): a work order on hold gets no new inspection.
    const refused = await ok(P.inspector2, 'POST', '/quality/inspections', { workOrderId: G.wo.id, lotSize: M_PIECES, sampleSize: M_PIECES, ...M_PLAN }, 409)
    expect(refused.error.message).toMatch(new RegExp(`^Work order ${G.wo.number} is on hold \\(.+\\): its garments are not inspected until the hold is lifted\\.$`))
    // A hold from an inspection is released only after a re-inspection passed: its way out is the NCR (B-W2a-67).
    const record = await ok(P.inspector2, 'GET', `/quality/holds/${placed.hold.id}`)
    expect((record.release.checks as Json[]).find((check) => check.key === 'REINSPECTION')).toMatchObject({ ok: false })
    expect(record.release.releasable).toBe(false)
    await settle()
  })

  it('M15 the inspector raises the NCR from the failed inspection and contains it with the inspection’s hold (the NCR decides it)', async () => {
    const { prefill } = await ok(P.inspector, 'GET', `/quality/ncr/prefill?recordType=Inspection&recordId=${G.inspectionFailed.id}`)
    expect(prefill).toMatchObject({ source: 'INSPECTION', foundAt: 'FINAL', workOrderId: G.wo.id, uom: 'PCS', severity: 'MAJOR', defectCodeId: id('holds:defect:SEAM-OPEN'), zone: 'SLEEVE_L' })
    let { record } = await ok(P.inspector, 'POST', '/quality/ncr', { from: { recordType: 'Inspection', recordId: G.inspectionFailed.id }, title: 'Open seam on the left sleeve', quantityAffected: '1', severity: 'MAJOR' }, 201)
    keep(record.ncr.id)
    done(record.ncr.id)
    expect(record.ncr).toMatchObject({ number: expect.stringMatching(/^NCR-\d{4}-\d{4}$/), stage: 'OPEN', source: 'INSPECTION', foundAt: 'FINAL', sourceType: 'Inspection', sourceId: G.inspectionFailed.id, workOrder: { number: G.wo.number } })
    // A major in-house defect of a PPE style opens no PPE register entry (B-W2a-47 decision 4).
    expect(record.register).toBeNull()
    expect((record.links as Json[]).map((link) => link.recordType).sort()).toEqual(['Inspection', 'WorkOrder'])
    const url = `/quality/ncr/${record.ncr.id}`
    ;({ record } = await ok(P.inspector, 'POST', `${url}/containment`, { version: record.ncr.version, kind: 'HOLD_STOCK', holdId: G.mInspectionHold.id }, 201))
    expect(record.containment).toMatchObject([{ seq: 1, kind: 'HOLD_STOCK', status: 'DONE', hold: { id: G.mInspectionHold.id, status: 'ACTIVE' } }])
    expect(record.holds).toMatchObject([{ id: G.mInspectionHold.id, decidedHere: true }])
    ;({ record } = await ok(P.inspector, 'POST', `${url}/stage`, { version: record.ncr.version, to: 'CONTAINED' }))
    expect(record.ncr).toMatchObject({ stage: 'CONTAINED', containedAt: expect.any(String) })
    G.ncr = record
    await settle()
  })

  it('M16 the decision: REWORK of the one garment (no approval asked); the NCR is decided and lifts the work order (the hold it decides is closed)', async () => {
    const codes = await mDispositions()
    const url = `/quality/ncr/${G.ncr.ncr.id}`
    let { record } = await ok(P.inspector, 'POST', `${url}/decisions`, { version: G.ncr.ncr.version, dispositionCodeId: codes.REWORK, quantity: '1', note: 'Re-stitch the sleeve seam' }, 201)
    expect(record.decisions).toMatchObject([{ seq: 1, disposition: { code: 'REWORK' }, approvalRequired: false }])
    ;({ record } = await ok(P.inspector, 'POST', `${url}/stage`, { version: record.ncr.version, to: 'DECIDED' }))
    expect(record.ncr).toMatchObject({ stage: 'DECIDED', decided: { words: expect.stringMatching(/^All 1 PCS decided/) } })
    // "Decide in NCR (the NCR lifts the work order)": the hold the NCR decides is closed now, before the rework moves.
    const lifted = await ok(P.inspector, 'POST', `${url}/holds/${G.mInspectionHold.id}/close`, { version: record.ncr.version, note: 'Decided: the garment goes back to sewing' })
    expect(lifted.workOrdersLifted).toEqual([G.wo.id])
    G.ncr = lifted.record
    expect((await ok(P.planner, 'GET', `/production/work-orders/${G.wo.id}`)).workOrder).toMatchObject({ status: 'IN_PROGRESS', hold: null })
    await settle()
  })

  it('M17 the NCR creates the rework order (back to sewing, found at the final inspection); the sewing tablet starts and finishes it: the garment comes back good', async () => {
    const decision = G.ncr.decisions[0]
    // By cell, no bundle: every bundle was packed already, so a rework of a bundle found at Op 30 is refused (NEXT_REPORTED:
    // Op 40 took it), and one found at Op 40 would split a child bundle WIP never sees finished (scans/progress.ts counts a
    // child's own scans only). The garment is taken off the packing bench and re-stitched at sewing.
    const made = await ok(P.inspector, 'POST', `/quality/ncr/${G.ncr.ncr.id}/decisions/${decision.id}/rework`, {
      version: decision.version,
      reworkAtOperationId: mOpOf('SEWING').id,
      workOrderSizeId: mCellOf('52').id,
      bundleId: null,
      foundAtOperationId: mOpOf('INSPECTION').id,
      description: 'Re-stitch the left sleeve seam',
      printerId: null,
    })
    expect(made.record.decisions[0]).toMatchObject({ state: 'DONE', followUp: { type: 'ReworkOrder', id: made.reworkId, state: 'OPEN' } })
    expect((made.record.links as Json[]).map((link) => link.recordType)).toContain('ReworkOrder')
    G.ncr = made.record
    G.mReworkId = made.reworkId
    keep(made.reworkId)
    done(made.reworkId)
    await mResign('SEWING')
    const started = await ok(G.tablets.SEWING, 'POST', `/production/rework/${made.reworkId}/start`, { version: 1 }, 201)
    expect(started.rework).toMatchObject({ status: 'IN_PROGRESS' })
    const finishedRework = await ok(G.tablets.SEWING, 'POST', `/production/rework/${made.reworkId}/done`, { version: started.rework.version, good: 1, scrap: 0 }, 201)
    expect(finishedRework.rework).toMatchObject({ status: 'DONE', goodQuantity: 1, scrapQuantity: 0 })
    const wip = await ok(P.planner, 'GET', `/production/scans/work-orders/${G.wo.id}/wip`)
    expect(wip).toMatchObject({ allFinished: true, readyToComplete: true })
    await settle()
  })

  it('M18 the re-inspection after the rework: a new inspection of the work order, every check ok, signed PASS', async () => {
    const opened = (await ok(P.inspector, 'POST', '/quality/inspections', { workOrderId: G.wo.id, lotSize: M_PIECES, sampleSize: M_PIECES, ...M_PLAN }, 201)).inspection
    keep(opened.id)
    await stepped(w, P.inspector)
    const decided = (await ok(P.inspector, 'POST', `/quality/inspections/${opened.id}/decide`, { version: opened.version, result: 'PASS', checklist: M_CHECKS.map((code) => ({ code, ok: true })) })).inspection
    expect(decided).toMatchObject({ status: 'PASSED', computed: { result: 'PASS' }, overridden: false })
    G.reinspection = decided
    await settle()
  })

  it('M19 the NCR is closed with the inspector’s e-signature: decided, carried out with its rework order, its hold closed already', async () => {
    const { record } = await ok(P.inspector, 'GET', `/quality/ncr/${G.ncr.ncr.id}`)
    expect(record.closing).toMatchObject({ ready: true })
    const closed = await mNcrClose(P.inspector, G.ncr.ncr.id, 'Seam re-stitched and re-inspected: passed.')
    expect(closed.record.ncr).toMatchObject({ stage: 'CLOSED', closedById: P.inspector.id, closeSignatureSha256: closed.signature })
    expect(closed.signature).toMatch(/^[0-9a-f]{64}$/)
    expect(closed.holdsClosed).toEqual([])
    G.ncr = closed.record
    await settle()
  })

  it('M20 the inspector (who made none of the garments) releases every cell on the re-inspection, a fresh code each', async () => {
    G.releases = []
    for (const cell of G.wo.cells as Json[]) {
      await stepped(w, P.inspector)
      const { release } = await ok(P.inspector, 'POST', '/quality/releases', { inspectionId: G.reinspection.id, workOrderSizeId: cell.id, quantity: cell.quantity }, 201)
      expect(release).toMatchObject({ quantity: cell.quantity, releasedBy: { kind: 'OFFICE', userId: P.inspector.id } })
      G.releases.push(release)
      keep(release.id)
    }
    expect((G.releases as Json[]).reduce((sum, release) => sum + release.quantity, 0)).toBe(M_PIECES)
    await settle()
  })

  it('M21 the planner completes the work order', async () => {
    const completed = (await ok(P.planner, 'POST', `/production/work-orders/${G.wo.id}/complete`, {})).workOrder
    expect(completed.status).toBe('COMPLETED')
    G.wo = { ...G.wo, ...completed, spec: G.wo.spec }
    await settle()
  })

  // ---- M22 trace --------------------------------------------------------------------------------------------------------------------

  it('M22 the trace: the batch found by its number; backward to the black hides, their lot and supplier, forward to the cells and bundles', async () => {
    const found = await ok(P.inspector, 'GET', `/inventory/trace/find?code=${encodeURIComponent(G.wo.batchNumber)}`)
    expect(found.matches).toEqual([expect.objectContaining({ kind: 'WORK_ORDER', id: G.wo.id, code: G.wo.number, matchedBy: 'BATCH_NUMBER' })])
    const graph = await ok(P.inspector, 'GET', `/inventory/trace?kind=WORK_ORDER&id=${G.wo.id}&direction=BOTH`)
    const codes = (body: Json, kind: string) => (body.nodes as Json[]).filter((node) => node.kind === kind).map((node) => node.code).sort()
    expect(codes(graph, 'LOT')).toEqual([G.mLotCode])
    expect(codes(graph, 'HIDE')).toEqual((G.mCutHides as Json[]).map((hide) => hide.code).sort())
    expect(codes(graph, 'WORK_ORDER')).toEqual([G.wo.number])
    expect((graph.nodes as Json[]).filter((node) => node.kind === 'BUNDLE').length).toBe(G.mBundles.length)
    expect((graph.nodes as Json[]).filter((node) => node.kind === 'CELL').length).toBe(G.wo.cells.length)
    expect((graph.nodes as Json[]).find((node) => node.kind === 'SUPPLIER')).toMatchObject({ id: id('party:P2'), reach: 'EXACT' })
    // From one garment's hide: back to its lot, forward to this work order.
    const hide = (G.mCutHides as Json[])[0]!
    const fromHide = await ok(P.inspector, 'GET', `/inventory/trace?kind=HIDE&id=${hide.id}&direction=BOTH`)
    expect(codes(fromHide, 'LOT')).toEqual([G.mLotCode])
    expect(codes(fromHide, 'WORK_ORDER')).toEqual([G.wo.number])
  })

  // ---- M23 standard vs actual --------------------------------------------------------------------------------------------------

  it('M23 standard vs actual of the work order: finance reads the cost the worker posted (the issued hides, a bridge that adds up); the production manager reads no figure', async () => {
    const detail = (await ok(P.finance, 'GET', `/costing/work-orders/${G.wo.id}`)).detail
    expect(detail.actual.material).toBeGreaterThan(0)
    expect((detail.bridge as Json[]).reduce((sum, step) => sum + step.amount, 0)).toBe(detail.variance)
    const { entries } = await ok(P.finance, 'GET', `/costing/ledger?workOrderId=${G.wo.id}&limit=200`)
    expect((entries as Json[]).filter((entry) => entry.event === 'ISSUE').length).toBe(G.mCutHides.length)
    expect(keysOf(entries).filter((name) => /createdBy|worker|person/i.test(name))).toEqual([])
    // money.cost grain: the production manager (costing.view, no cost grain) reads the same detail without a figure.
    const blind = (await ok(P.manager, 'GET', `/costing/work-orders/${G.wo.id}`)).detail
    expect(JSON.stringify(blind)).not.toMatch(/"(amount|total|variance|material|labour|unitCost|standardUnitCost|planned|actual)":-?\d/)
  })

  // ---- T1: partial shipment and the backorder -------------------------------------------------------------------------------

  it('T01 the warehouse ships only part of what is ready (sizes 50 and 52): the shipment and the backorder per size', async () => {
    const ready = await ok(P.warehouse, 'GET', `/shipping/ready?salesOrderId=${G.order.id}`)
    const cells = (ready.orders as STJson[]).flatMap((order) => order.cells as STJson[])
    expect(cells.reduce((sum, cell) => sum + cell.shippable, 0)).toBe(ST_PIECES)
    const first = cells.filter((cell) => ST_FIRST.includes(cell.size) && cell.shippable > 0)
    const { shipment } = await ok(P.warehouse, 'POST', '/shipping/shipments', { salesOrderId: G.order.id, lines: first.map((cell) => ({ workOrderSizeId: cell.workOrderSizeId, quantity: cell.shippable })) }, 201)
    keep(shipment.id)
    expect(shipment).toMatchObject({ status: 'DRAFT', salesOrderId: G.order.id, garments: 6 })
    // What stays behind: size 54, released and ready for the next shipment.
    const backorder = await ok(P.warehouse, 'GET', `/shipping/orders/${G.order.id}/backorder?shipmentId=${shipment.id}`)
    expect(stSizeOf(backorder, '50')).toMatchObject({ ordered: 2, thisShipment: 2, backorder: 0 })
    expect(stSizeOf(backorder, '52')).toMatchObject({ ordered: 4, thisShipment: 4, backorder: 0 })
    expect(stSizeOf(backorder, '54')).toMatchObject({ ordered: 2, thisShipment: 0, shipped: 0, backorder: 2, readyNow: 2, inProduction: 0 })
    expect(backorder.totals).toMatchObject({ ordered: ST_PIECES, thisShipment: 6, backorder: 2, readyNow: 2 })
    expect(backorder.words).toBe('2 garments of the order stay on backorder; 2 released and ready for the next shipment.')
    G.shipment1 = shipment
    await settle()
  })

  it('T02 packed in one parcel; finance types the freight charged (the warehouse may not, and sees no figure)', async () => {
    let shipment = G.shipment1
    const parcel = await ok(P.warehouse, 'POST', `/shipping/packing/${shipment.id}/parcels`, { grossWeightKg: '11.0', lengthCm: '60', widthCm: '40', heightCm: '40' }, 201)
    keep(parcel.parcelId)
    for (const line of shipment.lines as STJson[]) {
      shipment = (await ok(P.warehouse, 'PUT', `/shipping/packing/${shipment.id}/lines/${line.id}/parcel`, { parcelId: parcel.parcelId })).shipment
    }
    shipment = (await ok(P.warehouse, 'POST', `/shipping/packing/${shipment.id}/pack`, {})).shipment
    expect(shipment).toMatchObject({ status: 'PACKED', packingProblems: [], garments: 6 })
    // The warehouse never reads a freight figure (price grain).
    expect(keysOf(shipment).filter((key) => ['charge', 'freightCharge'].includes(key))).toEqual([])
    // Refused: the freight charged is finance's (shipping.freight.manage, a price).
    const refused = await ok(P.warehouse, 'PUT', `/shipping/shipments/${shipment.id}/freight`, { version: shipment.version, freightCharge: ST_FREIGHT }, 403)
    expect(refused.error.message).toEqual(expect.any(String))
    // Finance: by the rule it ships free (order net above 500.00); the customer pays 15.00 for this part shipment.
    const before = (await ok(P.finance, 'GET', `/shipping/shipments/${shipment.id}`)).shipment
    expect(before.freight).toMatchObject({ charge: null, byHand: false, byRule: { charge: 0 } })
    const typed = await ok(P.finance, 'PUT', `/shipping/shipments/${shipment.id}/freight`, { version: before.version, freightCharge: ST_FREIGHT })
    expect(typed).toMatchObject({ status: 'PACKED', freight: { charge: ST_FREIGHT, currency: 'EUR', byHand: true } })
    expect(await settle()).toContain('shipment.freight_changed')
    G.shipment1 = (await ok(P.warehouse, 'GET', `/shipping/shipments/${shipment.id}`)).shipment
    G.parcel1 = parcel.parcelId
  })

  it('T03 the DDT of the part shipment (dated today) and the carrier label through Sendcloud (FAKE)', async () => {
    const preview = await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipment1.id}/ddt/preview`, {})
    expect(preview.problems).toEqual([])
    const issued = await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipment1.id}/ddt`, {}, 201)
    expect(issued).toMatchObject({ ddt: { status: 'LIVE', documentDate: today(), shipmentId: G.shipment1.id, fileId: expect.any(String) }, shipment: { status: 'PACKED' } })
    expect(issued.ddt.lines.map((line: STJson) => [line.size, line.quantity]).sort()).toEqual([
      ['50', expect.stringMatching(/^2(\.0+)?$/)],
      ['52', expect.stringMatching(/^4(\.0+)?$/)],
    ])
    G.ddt1 = issued.ddt
    keep(issued.ddt.id)
    // The DoC and the user information of the revision made are on file (filed in the M stages).
    expect((await ok(P.warehouse, 'GET', `/shipping/shipments/${G.shipment1.id}/documents`)).documents.blockers).toEqual([])
    const bought = await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipment1.id}/labels`, {}, 201)
    expect(bought.problem ?? null).toBeNull()
    G.tracking1 = bought.parcels[0].trackingNumber
    expect(G.tracking1).toEqual(expect.any(String))
    await settle()
  })

  it('T04 shipped: the order is PARTLY_SHIPPED, size 54 stays on backorder ready to go, the DoC link reaches the customer', async () => {
    const shipped = (await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipment1.id}/ship`, {})).shipment
    expect(shipped.status).toBe('SHIPPED')
    const before = w.h.ses.mails.length
    expect(await settle()).toContain('shipment.status_changed')
    // The typed freight stays (the rule is applied at leaving only when nobody typed one).
    expect((await ok(P.finance, 'GET', `/shipping/shipments/${G.shipment1.id}`)).shipment.freight).toMatchObject({ charge: ST_FREIGHT, byHand: true })
    const order = (await ok(P.sales, 'GET', `/sales/orders/${G.order.id}`)).order
    expect(order.status).toBe('PARTLY_SHIPPED')
    expect(order.progress).toMatchObject({ ordered: ST_PIECES, released: ST_PIECES, shipped: 6, toShip: 2 })
    expect(order.lines[0].sizes.map((entry: STJson) => [entry.size, entry.progress.shipped, entry.progress.toShip])).toEqual([
      ['50', 2, 0],
      ['52', 4, 0],
      ['54', 0, 2],
    ])
    const backorder = await ok(P.warehouse, 'GET', `/shipping/orders/${G.order.id}/backorder`)
    expect(stSizeOf(backorder, '54')).toMatchObject({ shipped: 0, backorder: 2, readyNow: 2 })
    expect(backorder.totals).toMatchObject({ shipped: 6, backorder: 2, readyNow: 2, inProduction: 0 })
    expect(backorder.shipments.map((entry: STJson) => [entry.id, entry.status])).toEqual([[G.shipment1.id, 'SHIPPED']])
    const open = (await ok(P.warehouse, 'GET', `/shipping/backorders?partyId=${id('party:P1')}`)).orders as STJson[]
    expect(open.find((row) => row.salesOrderId === G.order.id)).toMatchObject({ status: 'PARTLY_SHIPPED', totals: { backorder: 2 } })
    // As in W1 step 30: the worker sends the DoC and leaflet by link to the customer's orders contact.
    expect(w.h.ses.mails.slice(before).some((mail) => mail.to.includes(ST_ORDERS_MAIL))).toBe(true)
    G.order = order
  })

  it('T05 delivered: the scheduler’s tracking poll finds the carrier’s events, the worker records them', async () => {
    const after = Math.max(Date.now(), w.h.clock.now().getTime())
    w.sendcloud.advance(G.tracking1, 'IN_TRANSIT', 'unused', new Date(after + 60_000))
    w.sendcloud.advance(G.tracking1, 'DELIVERED', 'unused', new Date(after + 120_000))
    const tick = await runTrackingPoll({ database: w.h.database, log: QUIET, clock: { now: () => new Date(Date.now() + 12 * 3_600_000 + 5 * 60_000) } })
    expect(tick.failed).toBe(0)
    expect(tick.shipments).toBeGreaterThanOrEqual(1)
    expect(await settle()).toContain('shipment.tracking_poll_due')
    expect((await ok(P.warehouse, 'GET', `/shipping/shipments/${G.shipment1.id}/tracking`)).shipment.status).toBe('DELIVERED')
    // A delivered part shipment leaves the order PARTLY_SHIPPED.
    expect((await ok(P.sales, 'GET', `/sales/orders/${G.order.id}`)).order.status).toBe('PARTLY_SHIPPED')
    G.shipment1 = (await ok(P.warehouse, 'GET', `/shipping/shipments/${G.shipment1.id}`)).shipment
  })

  // ---- T2: finance invoices the first DDT ---------------------------------------------------------------------------------

  it('T06 finance invoices DDT 1 as an immediate TD01 (P1 is invoiced monthly: TD24 is the preset): the goods, the freight line, BB30FM due date; issued', async () => {
    const queue = await ok(P.finance, 'GET', `/invoicing/shipped-not-invoiced?partyId=${id('party:P1')}`)
    const customer = (queue.customers as STJson[]).find((entry) => entry.partyId === id('party:P1') && entry.companyId === companyA())!
    expect(customer).toMatchObject({ invoiceTiming: 'MONTHLY', preset: 'TD24' })
    const row = (customer.ddts as STJson[]).find((entry) => entry.ddtId === G.ddt1.id)!
    expect(row).toMatchObject({ shipmentId: G.shipment1.id, immediate: { docType: 'TD01' }, deadline: { docType: 'TD24', dueBy: fifteenthOfNextMonth(today()) }, freight: { amount: ST_FREIGHT, currency: 'EUR', billed: false }, drafts: [] })
    expect(row.valueAmount).toBe(252_000)
    expect(row.lines.map((line: STJson) => [line.size, Number(line.notInvoiced)]).sort()).toEqual([
      ['50', 2],
      ['52', 4],
    ])
    // Home tells finance the shipped goods wait for an invoice.
    const waiting = (await ok(P.finance, 'GET', '/home/today?limit=200')).items as STJson[]
    expect(waiting.some((item) => item.kind === 'INVOICE_TO_ISSUE' && item.record.id === id('party:P1'))).toBe(true)
    // The office's pick: this part is invoiced now (FIN-058), not with the month.
    const drafted = await ok(P.finance, 'POST', '/invoicing/invoices/from-ddts', { ddtIds: [G.ddt1.id], docType: 'TD01' }, 201)
    expect(drafted.choice).toMatchObject({ docType: 'TD01', suggested: 'TD24' })
    expect(drafted.choice.allowed).toContain('TD01')
    expect(drafted.deductions).toEqual([])
    expect(drafted.freight).toEqual([])
    const invoice = drafted.invoice
    expect(invoice).toMatchObject({ docType: 'TD01', status: 'DRAFT', buyerPartyId: id('party:P1'), salesOrderId: G.order.id, netTotal: ST_INV1.net, vatTotal: ST_INV1.vat, grossTotal: ST_INV1.gross })
    const goods = (invoice.lines as STJson[]).filter((line) => line.kind === 'GOODS')
    expect(goods.reduce((sum, line) => sum + line.netAmount, 0)).toBe(252_000)
    expect(goods.reduce((sum, line) => sum + Number(line.quantity), 0)).toBe(6)
    expect(goods.every((line) => line.ddtId === G.ddt1.id && line.salesOrderLineId === G.order.lines[0].id)).toBe(true)
    expect((invoice.lines as STJson[]).filter((line) => line.kind === 'CHARGE')).toEqual([
      expect.objectContaining({ chargeKind: 'FREIGHT', quantity: '1.0000', netAmount: ST_FREIGHT, ddtId: G.ddt1.id, vatRatePct: '22.00', description: stFreightWords(G.ddt1), salesOrderLineId: null, size: null }),
    ])
    expect((invoice.lines as STJson[]).some((line) => line.kind === 'DEPOSIT_DEDUCTION')).toBe(false)
    // The order's terms (one order): BB30FM, 30 days end of month from the invoice date.
    expect(invoice.paymentTerms).toMatchObject({ condition: 'TP02', installments: [{ method: 'MP05', amount: ST_INV1.gross, dueDate: dueDateOf(today(), { days: 30, endOfMonth: true }) }], source: { kind: 'TERMS', termsId: id('pricing:terms:BB30FM'), code: 'BB30FM' } })
    const checks = await ok(P.finance, 'GET', `/invoicing/invoices/${invoice.id}/checks`)
    expect(checks.problems.filter((problem: STJson) => problem.severity !== 'WARNING')).toEqual([])
    await stepped(w, P.finance)
    const issued = await ok(P.finance, 'POST', `/invoicing/invoices/${invoice.id}/issue`, { version: invoice.version })
    expect(issued).toMatchObject({ invoice: { docType: 'TD01', status: 'ISSUED', issueDate: today(), number: expect.stringMatching(/^FT-\d{4}-\d{5}$/), xmlFileId: expect.any(String), pdfFileId: expect.any(String) }, filesPending: false })
    expect(issued.invoice.paymentTerms.installments).toEqual([expect.objectContaining({ dueDate: dueDateOf(issued.invoice.issueDate, { days: 30, endOfMonth: true }), amount: ST_INV1.gross })])
    G.invoice1 = issued.invoice
    keep(G.invoice1.id)
    expect(await settle()).toContain('invoice.issued')
    // The freight is billed now: the queue says so.
    const after = (await ok(P.finance, 'GET', `/invoicing/shipped-not-invoiced?partyId=${id('party:P1')}`)).customers as STJson[]
    expect(after.flatMap((entry) => entry.ddts as STJson[]).some((entry) => entry.ddtId === G.ddt1.id)).toBe(false)
  })

  it('T07 the TD01 goes to SDI (FAKE): the scheduler’s poll and the worker record it DELIVERED; the order shows it, still to settle', async () => {
    await stepped(w, P.finance)
    const sent = await ok(P.finance, 'POST', `/invoicing/invoices/${G.invoice1.id}/sdi/send`, {})
    expect(sent.sdi.sends.at(-1).status).toBe('SENT')
    await settle()
    const tick = await runSdiPoll({ database: w.h.database, log: QUIET, clock: { now: () => new Date(Date.now() + 3_600_000) } })
    expect(tick.failed).toBe(0)
    expect(tick.due).toBeGreaterThanOrEqual(1)
    expect(await settle()).toContain('invoice.sdi_poll_due')
    G.invoice1 = (await ok(P.finance, 'GET', `/invoicing/invoices/${G.invoice1.id}`)).invoice
    expect(G.invoice1).toMatchObject({ status: 'DELIVERED', grossTotal: ST_INV1.gross, paidAmount: 0, openAmount: ST_INV1.gross })
    const order = (await ok(P.sales, 'GET', `/sales/orders/${G.order.id}`)).order
    expect(order.chain.invoices).toEqual([expect.objectContaining({ id: G.invoice1.id, docType: 'TD01', status: 'DELIVERED' })])
    expect(Number(order.progress.invoiced)).toBe(6)
    const settlement = (await ok(P.finance, 'GET', `/invoicing/orders/${G.order.id}/settlement`)).settlement
    expect(settlement).toMatchObject({ settled: false, fullyShipped: false, invoicedAmount: ST_INV1.gross, paidAmount: 0 })
  })

  // ---- T3: the rest ships and is invoiced ------------------------------------------------------------------------------------

  it('T08 the rest ships: size 54 on shipment 2 (packed, DDT, label, shipped), freight by the rule (free); the order is SHIPPED, nothing on backorder; delivered', async () => {
    const ready = await ok(P.warehouse, 'GET', `/shipping/ready?salesOrderId=${G.order.id}`)
    const cells = (ready.orders as STJson[]).flatMap((order) => order.cells as STJson[]).filter((cell) => cell.shippable > 0)
    expect(cells.map((cell) => [cell.size, cell.shippable])).toEqual([['54', 2]])
    let { shipment } = await ok(P.warehouse, 'POST', '/shipping/shipments', { salesOrderId: G.order.id, lines: cells.map((cell) => ({ workOrderSizeId: cell.workOrderSizeId, quantity: cell.shippable })) }, 201)
    keep(shipment.id)
    const parcel = await ok(P.warehouse, 'POST', `/shipping/packing/${shipment.id}/parcels`, { grossWeightKg: '4.0', lengthCm: '60', widthCm: '40', heightCm: '20' }, 201)
    keep(parcel.parcelId)
    for (const line of shipment.lines as STJson[]) shipment = (await ok(P.warehouse, 'PUT', `/shipping/packing/${shipment.id}/lines/${line.id}/parcel`, { parcelId: parcel.parcelId })).shipment
    shipment = (await ok(P.warehouse, 'POST', `/shipping/packing/${shipment.id}/pack`, {})).shipment
    expect(shipment).toMatchObject({ status: 'PACKED', packingProblems: [], garments: 2 })
    const issued = await ok(P.warehouse, 'POST', `/shipping/shipments/${shipment.id}/ddt`, {}, 201)
    expect(issued.ddt).toMatchObject({ status: 'LIVE', documentDate: today(), shipmentId: shipment.id })
    G.ddt2 = issued.ddt
    keep(issued.ddt.id)
    const bought = await ok(P.warehouse, 'POST', `/shipping/shipments/${shipment.id}/labels`, {}, 201)
    expect(bought.problem ?? null).toBeNull()
    G.tracking2 = bought.parcels[0].trackingNumber
    expect((await ok(P.warehouse, 'POST', `/shipping/shipments/${shipment.id}/ship`, {})).shipment.status).toBe('SHIPPED')
    await settle()
    // Nobody typed a freight: the rule's when the goods left — free from an order net of 500.00.
    expect((await ok(P.finance, 'GET', `/shipping/shipments/${shipment.id}`)).shipment.freight).toMatchObject({ charge: 0, byHand: false })
    const order = (await ok(P.sales, 'GET', `/sales/orders/${G.order.id}`)).order
    expect(order.status).toBe('SHIPPED')
    expect(order.progress).toMatchObject({ shipped: ST_PIECES, toShip: 0 })
    const backorder = await ok(P.warehouse, 'GET', `/shipping/orders/${G.order.id}/backorder`)
    expect(backorder.totals).toMatchObject({ shipped: ST_PIECES, backorder: 0 })
    expect(backorder.words).toBeNull()
    // Delivered: the worker's poll of this shipment, as its handler does on shipment.tracking_poll_due (W1 E05).
    const after = Math.max(Date.now(), w.h.clock.now().getTime())
    w.sendcloud.advance(G.tracking2, 'DELIVERED', 'unused', new Date(after + 60_000))
    expect(await pollShipment(processCarrier(), callerFor(w.h.database, systemContext(w.tenant.id, newId())), shipment.id)).toMatchObject({ moved: 'DELIVERED', failures: [] })
    await settle()
    expect((await ok(P.warehouse, 'GET', `/shipping/shipments/${shipment.id}/tracking`)).shipment.status).toBe('DELIVERED')
    G.shipment2 = (await ok(P.warehouse, 'GET', `/shipping/shipments/${shipment.id}`)).shipment
    G.order = order
  })

  it('T09 finance invoices DDT 2 by the customer’s monthly preset (TD24); DDT 1 again is refused; SDI delivers it; the order is fully shipped and invoiced, not paid', async () => {
    // Refused in words: shipped goods are invoiced once.
    const twice = await ok(P.finance, 'POST', '/invoicing/invoices/from-ddts', { ddtIds: [G.ddt1.id] }, 409)
    expect(twice.error.message).toBe(`DDT ${G.ddt1.number} is invoiced already (${G.invoice1.number}): shipped goods are invoiced once; a correction is a credit note.`)
    const drafted = await ok(P.finance, 'POST', '/invoicing/invoices/from-ddts', { ddtIds: [G.ddt2.id] }, 201)
    expect(drafted.choice).toMatchObject({ docType: 'TD24', suggested: 'TD24' })
    expect(drafted.choice.words).toContain('The customer is invoiced once a month')
    // The shipment carries no freight: no charge line (what `freight` names, if anything, is this DDT's).
    expect((drafted.freight as STJson[]).every((entry) => entry.ddtId === G.ddt2.id)).toBe(true)
    const invoice = drafted.invoice
    expect(invoice).toMatchObject({ docType: 'TD24', status: 'DRAFT', salesOrderId: G.order.id, netTotal: ST_INV2.net, vatTotal: ST_INV2.vat, grossTotal: ST_INV2.gross, deadline: { docType: 'TD24', dueBy: fifteenthOfNextMonth(today()) } })
    expect((invoice.lines as STJson[]).map((line) => [line.kind, line.size, Number(line.quantity), line.netAmount, line.ddtId])).toEqual([['GOODS', '54', 2, 84_000, G.ddt2.id]])
    expect(invoice.paymentTerms).toMatchObject({ source: { kind: 'TERMS', code: 'BB30FM' } })
    const checks = await ok(P.finance, 'GET', `/invoicing/invoices/${invoice.id}/checks`)
    expect(checks.problems.filter((problem: STJson) => problem.severity !== 'WARNING')).toEqual([])
    await stepped(w, P.finance)
    const issued = await ok(P.finance, 'POST', `/invoicing/invoices/${invoice.id}/issue`, { version: invoice.version })
    expect(issued).toMatchObject({ invoice: { docType: 'TD24', status: 'ISSUED', issueDate: today(), deadline: null }, filesPending: false })
    G.invoice2 = issued.invoice
    keep(G.invoice2.id)
    await settle()
    await stepped(w, P.finance)
    expect((await ok(P.finance, 'POST', `/invoicing/invoices/${G.invoice2.id}/sdi/send`, {})).sdi.sends.at(-1).status).toBe('SENT')
    await settle()
    expect((await runSdiPoll({ database: w.h.database, log: QUIET, clock: { now: () => new Date(Date.now() + 3_600_000) } })).failed).toBe(0)
    expect(await settle()).toContain('invoice.sdi_poll_due')
    G.invoice2 = (await ok(P.finance, 'GET', `/invoicing/invoices/${G.invoice2.id}`)).invoice
    expect(G.invoice2.status).toBe('DELIVERED')
    const settlement = (await ok(P.finance, 'GET', `/invoicing/orders/${G.order.id}/settlement`)).settlement
    expect(settlement).toMatchObject({ settled: false, fullyShipped: true, fullyInvoiced: true, invoicedAmount: ST_INV1.gross + ST_INV2.gross, paidAmount: 0, balanceDueAmount: ST_INV1.gross + ST_INV2.gross })
    expect((settlement.invoices as STJson[]).map((entry) => entry.id).sort()).toEqual([G.invoice1.id, G.invoice2.id].sort())
    G.order = (await ok(P.sales, 'GET', `/sales/orders/${G.order.id}`)).order
    expect(G.order.status).toBe('SHIPPED')
  })

  // ---- T4: receivables ----------------------------------------------------------------------------------------------------

  it('T10 the customer pays part of the first invoice: the payment is placed on it, the rest stays open', async () => {
    const paid = await ok(P.finance, 'POST', '/payments', { companyId: companyA(), partyId: id('party:P1'), amount: ST_PART, receivedOn: today(), externalRef: 'CRO-GOLDEN-W2A-0001', allocations: [{ invoiceId: G.invoice1.id, amount: ST_PART }] }, 201)
    expect(paid.payment).toMatchObject({ amount: ST_PART, allocated: ST_PART, unallocated: 0, status: 'RECEIVED' })
    expect(paid.payment.placedOn).toEqual([expect.objectContaining({ targetId: G.invoice1.id, amount: ST_PART })])
    G.payment1 = paid.payment
    keep(paid.payment.id)
    expect(await settle()).toEqual(expect.arrayContaining(['payment.recorded', 'payment.allocated']))
    G.invoice1 = (await ok(P.finance, 'GET', `/invoicing/invoices/${G.invoice1.id}`)).invoice
    expect(G.invoice1).toMatchObject({ status: 'DELIVERED', paidAmount: ST_PART, openAmount: ST_INV1.gross - ST_PART })
    const settlement = (await ok(P.finance, 'GET', `/invoicing/orders/${G.order.id}/settlement`)).settlement
    expect(settlement).toMatchObject({ settled: false, paidAmount: ST_PART, balanceDueAmount: ST_INV1.gross + ST_INV2.gross - ST_PART })
    // Not settled: the order stays SHIPPED (it closes only when paid in full).
    expect((await ok(P.sales, 'GET', `/sales/orders/${G.order.id}`)).order.status).toBe('SHIPPED')
  })

  it('T11 finance reads P1’s ledger: the statement (both invoices, the payment, the running balance), the open items not due yet, the ageing and the PDF; sales may not read receivables', async () => {
    const from = `${today().slice(0, 4)}-01-01`
    const statement = await ok(P.finance, 'GET', `/receivables/customers/${id('party:P1')}/statement?companyId=${companyA()}&from=${from}&to=${today()}&language=it`)
    expect(statement).toMatchObject({ currency: 'EUR', from, to: today(), customer: { id: id('party:P1') } })
    const balance = (statement.lines as STJson[]).reduce((sum, line) => sum + line.debit - line.credit, statement.opening)
    expect(statement.closing).toBe(balance)
    expect(statement.lines.at(-1).balance).toBe(statement.closing)
    const due1 = dueDateOf(G.invoice1.issueDate, { days: 30, endOfMonth: true })
    expect((statement.lines as STJson[]).find((line) => line.recordId === G.invoice1.id)).toMatchObject({ kind: 'INVOICE', reference: G.invoice1.number, docType: 'TD01', debit: ST_INV1.gross, credit: 0, dueDate: due1 })
    expect((statement.lines as STJson[]).find((line) => line.recordId === G.invoice2.id)).toMatchObject({ kind: 'INVOICE', reference: G.invoice2.number, docType: 'TD24', debit: ST_INV2.gross, credit: 0 })
    expect((statement.lines as STJson[]).find((line) => line.recordId === G.payment1.id)).toMatchObject({ kind: 'PAYMENT', reference: 'CRO-GOLDEN-W2A-0001', credit: ST_PART, debit: 0 })
    const items = (statement.openItems as STJson[]).filter((item) => [G.invoice1.id, G.invoice2.id].includes(item.invoiceId))
    expect(items.map((item) => [item.number, item.open, item.bucket, item.daysLate, item.dueDateKnown]).sort()).toEqual(
      [
        [G.invoice1.number, ST_INV1.gross - ST_PART, 'NOT_DUE', 0, true],
        [G.invoice2.number, ST_INV2.gross, 'NOT_DUE', 0, true],
      ].sort(),
    )
    expect(statement.recipients).toEqual([{ name: 'Seed Accounts One', email: ST_INVOICES_MAIL }])
    // The ageing: P1's row holds at least what these two invoices leave open (the seed's own invoices are on it too).
    const ageing = await ok(P.finance, 'GET', `/receivables/ageing?partyId=${id('party:P1')}&companyId=${companyA()}`)
    const row = (ageing.customers as STJson[]).find((entry) => entry.customer.id === id('party:P1'))!
    expect(row.open).toBeGreaterThanOrEqual(ST_INV1.gross + ST_INV2.gross - ST_PART)
    expect(row.invoices).toBeGreaterThanOrEqual(2)
    // (lastPaymentOn not asserted: the receivables seed's duplicate transfer is dated 2026-11-12, after an Oct run's today.)
    // The statement PDF (stored nowhere).
    const printed = await call(P.finance.browser, 'GET', `/receivables/customers/${id('party:P1')}/statement/pdf?companyId=${companyA()}&from=${from}&to=${today()}`)
    expect(printed.status, String(printed.response.body).slice(0, 300)).toBe(200)
    expect(printed.response.headers['content-type']).toContain('application/pdf')
    expect(printed.response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    // Refused: receivables are finance's (the sales template has no receivables.view).
    expect((await ok(P.sales, 'GET', `/receivables/customers/${id('party:P1')}/statement?companyId=${companyA()}`, undefined, 403)).error.message).toEqual(expect.any(String))
  })

  it('T12 the statement is e-mailed to P1’s invoice contact (FAKE SES); the reminder ladder stays OFF (the Owner’s switch): finance cannot switch it on, nothing is prepared for these invoices', async () => {
    const before = w.h.ses.mails.length
    const sent = await ok(P.finance, 'POST', `/receivables/customers/${id('party:P1')}/statement/send`, { companyId: companyA(), from: `${today().slice(0, 4)}-01-01`, to: today(), message: 'Restiamo a disposizione.' }, 201)
    expect(sent).toMatchObject({ to: [ST_INVOICES_MAIL], until: today(), fileId: expect.any(String), emailId: expect.any(String) })
    expect(await settle()).toContain('customer_statement.sent')
    expect(w.h.ses.mails.slice(before).some((mail) => mail.to.includes(ST_INVOICES_MAIL))).toBe(true)
    // The ladder: prepared only, never sent while switched off; the switch is the Owner's (and the interest rule the accountant's).
    const settings = await ok(P.finance, 'GET', `/receivables/settings?companyId=${companyA()}`)
    expect(settings.switch).toMatchObject({ on: false, mayChange: false })
    const refused = await ok(P.finance, 'PUT', '/receivables/settings/switch', { companyId: null, on: true }, 403)
    expect(refused.error.message).toEqual(expect.any(String))
    const reminders = (await ok(P.finance, 'GET', `/receivables/reminders?partyId=${id('party:P1')}&view=all&limit=200`)).reminders as STJson[]
    expect(reminders.filter((reminder) => (reminder.invoices as STJson[]).some((invoice) => [G.invoice1.id, G.invoice2.id].includes(invoice.id)))).toEqual([])
  })

  // ---- R: customer return → grading → credit note → refund; a repair; a complaint -----------------------------------------------

  const R_P1 = () => id('party:P1')
  const R_REPAIR = () => id('returns:REP-0001')
  /** The way back of a repaired garment: shipping's source-DDT body (modules/sales/repairs/repairs.pg.vitest.test.ts:77). */
  const R_DDT = { transportBy: 'SENDER', packages: 1, grossWeightKg: '1.8', appearance: 'Scatola di cartone' } as const
  /** A passed checklist (repairs.pg.vitest.test.ts:78; factory-domain sales/repairs/rules SafetyChecklist). */
  const R_PASSED = { seams: 'PASS', abrasionZones: 'PASS', closures: 'PASS', protectors: { result: 'PASS', replaced: false }, certificateCovers: true, note: 'Shoulder seam re-sewn and checked under load.' } as const
  const rSteps = (repair: Record<string, any>) => (repair.steps as Record<string, any>[]).map((step) => [step.stage, step.state])
  const rHeld = (record: Record<string, any>, action: string) => (record.actions as Record<string, any>[]).find((entry) => entry.action === action)?.held ?? null

  it('R01 sales finds what P1 can still return from the first invoice (four 52s); asking five back is refused in words, at the cell', async () => {
    const { lines } = await ok(P.sales, 'GET', `/sales/returns/returnable?companyId=${companyA()}&partyId=${R_P1()}&invoiceId=${G.invoice1.id}`)
    const ours = (lines as Record<string, any>[]).filter((line) => line.invoice?.id === G.invoice1.id)
    // from-ddts bills per DDT, order line and size: sizes 50 and 52 of shipment 1.
    expect(ours.map((line) => line.size).sort()).toEqual(['50', '52'])
    const row = ours.find((line) => line.size === '52')!
    expect(row).toMatchObject({ kind: 'INVOICED', sold: 4, taken: 0, left: 4, ppe: true, siteId: siteA1(), style: { code: 'SEED-JKT-01' }, colourway: { code: 'BLK' } })
    expect(row.batchNumbers).toContain(G.wo.batchNumber)
    expect(row.pieceValue).toBeGreaterThan(0)
    const tooMany = { companyId: companyA(), partyId: R_P1(), lines: [{ invoiceLineId: row.invoiceLineId, quantity: 5, reasonCode: 'WRONG_SIZE' }] }
    const preview = await ok(P.sales, 'POST', '/sales/returns/preview', tooMany)
    expect(preview).toMatchObject({ ok: false, problems: [{ path: 'body/lines/0/quantity', message: 'At most 4 can come back: 4 sold.' }] })
    expect((await ok(P.sales, 'POST', '/sales/returns', tooMany, 409)).error.issues).toEqual([{ path: 'body/lines/0/quantity', message: 'At most 4 can come back: 4 sold.' }])
    G.rma = { invoiceLineId: row.invoiceLineId, pieceValue: row.pieceValue }
  })

  it('R02 sales makes the RMA for one 52 (wrong size): AUTHORISED and numbered, the batch and site of its shipment, no PPE register entry (not a defect)', async () => {
    const body = {
      companyId: companyA(),
      partyId: R_P1(),
      customerRef: 'P1-RET-GOLDEN-1',
      lines: [{ invoiceLineId: G.rma.invoiceLineId, quantity: 1, reasonCode: 'WRONG_SIZE', reasonNote: 'One 52 too many: the rider needs a 54.' }],
    }
    const made = await ok(P.sales, 'POST', '/sales/returns', body, 201)
    const rma = made.return
    expect(rma).toMatchObject({ number: expect.stringMatching(/^RMA-\d{4}-\d{4}$/), status: 'AUTHORISED', siteId: siteA1(), party: { id: R_P1() }, salesOrder: { id: G.order.id }, customerRef: 'P1-RET-GOLDEN-1' })
    expect(rma.lines).toMatchObject([{ seq: 10, size: '52', quantity: 1, ppe: true, safety: false, batchNumber: G.wo.batchNumber, invoice: { id: G.invoice1.id }, reason: { code: 'WRONG_SIZE' } }])
    expect(rma.tracking.map((step: Record<string, any>) => [step.step, step.state])).toEqual([['REQUESTED', 'DONE'], ['AUTHORISED', 'DONE'], ['GOODS_BACK', 'CURRENT'], ['INSPECTED', 'WAITING'], ['OUTCOME', 'WAITING']])
    // A protective garment comes back only as a safety case when returned for a DEFECT (or found defective / misused).
    expect((made.registerEntries as Record<string, any>[]).filter((entry) => entry.opened)).toEqual([])
    G.rma = { ...G.rma, id: rma.id, number: rma.number, lineId: rma.lines[0].id, version: rma.version, status: rma.status }
    keep(rma.id, rma.lines[0].id)
    expect(await settle()).toContain('return.authorised')
  })

  it('R03 the warehouse finds it at the dock by its number (no price) and receives the parcel with the customer’s DDT: RECEIVED', async () => {
    const found = (await ok(P.warehouse, 'GET', `/sales/returns/dock?code=${encodeURIComponent(G.rma.number)}`)).return
    expect(found).toMatchObject({ id: G.rma.id, status: 'AUTHORISED', lines: [{ seq: 10, size: '52', expected: 1, receivedQuantity: 0, ppe: true, safety: false }] })
    expect(found.places.finishedGoods).toMatchObject({ id: expect.any(String), code: expect.any(String) })
    expect(JSON.stringify(found)).not.toMatch(/unitPrice|creditAmount|discountPct|internalNote/)
    const received = await ok(
      P.warehouse,
      'POST',
      `/sales/returns/${G.rma.id}/receipts`,
      { version: found.version, parcels: 1, parcelCondition: 'INTACT', carrierName: 'Corriere del cliente (made up)', customerDdtNumber: 'P1-DDT-R-01', customerDdtDate: today(), lines: [{ lineId: G.rma.lineId, quantity: 1 }] },
      201,
    )
    expect(received.return).toMatchObject({ status: 'RECEIVED', lines: [{ receivedQuantity: 1, expected: 0 }], receipts: [{ parcels: 1, parcelCondition: 'INTACT', customerDdtNumber: 'P1-DDT-R-01' }] })
    G.rma = { ...G.rma, version: received.return.version, status: 'RECEIVED', places: found.places, receiptId: received.receiptId }
    keep(received.receiptId)
    expect(await settle()).toEqual(expect.arrayContaining(['return.received', 'return.status_changed']))
  })

  it('R04 the quality inspector grades it NEW, no fault: the suggestion is RESTOCK and nothing holds it from stock', async () => {
    const graded = await ok(P.inspector, 'POST', `/sales/returns/${G.rma.id}/grades`, { version: G.rma.version, lines: [{ lineId: G.rma.lineId, grade: 'NEW', cause: 'NO_FAULT', conditionNote: 'Unworn, labels on, in its bag.' }] })
    expect(graded.return.lines[0]).toMatchObject({ grade: 'NEW', cause: 'NO_FAULT', suggestedOutcome: 'RESTOCK', restockHeld: null })
    G.rma = { ...G.rma, version: graded.return.version }
    expect(await settle()).toContain('return.graded')
  })

  it('R05 sales decides a CREDIT with the jacket back into finished goods (one ADJUSTMENT in): INSPECTED; the worker drafts the TD04 on return.credit_due', async () => {
    const record = (await ok(P.sales, 'GET', `/sales/returns/${G.rma.id}`)).return
    expect(record.lines[0]).toMatchObject({ grade: 'NEW', suggestedOutcome: 'RESTOCK', restockHeld: null, receivedValue: G.rma.pieceValue })
    const fg = G.rma.places.finishedGoods as { id: string; code: string }
    // No creditAmount: CREDIT_ONLY defaults to what came back is worth (the invoice line's net per piece × pieces received).
    const decision = { lineId: G.rma.lineId, disposition: 'CREDIT_ONLY', goodsOutcome: 'RESTOCK', toLocationId: fg.id }
    const preview = await ok(P.sales, 'POST', `/sales/returns/${G.rma.id}/decisions/preview`, { version: record.version, lines: [decision] })
    expect(preview).toMatchObject({ ok: true, problems: [], lines: [{ lineId: G.rma.lineId, disposition: 'CREDIT_ONLY', goodsOutcome: 'RESTOCK', creditAmount: G.rma.pieceValue, followUp: 'CREDIT_NOTE', place: { id: fg.id, code: fg.code } }] })
    const decided = await ok(P.sales, 'POST', `/sales/returns/${G.rma.id}/decisions`, { version: record.version, lines: [decision] })
    expect(decided.return).toMatchObject({
      status: 'INSPECTED',
      creditTotal: G.rma.pieceValue,
      lines: [{ disposition: 'CREDIT_ONLY', goodsOutcome: 'RESTOCK', creditAmount: G.rma.pieceValue, followUp: 'CREDIT_NOTE', stock: [{ locationId: fg.id, locationCode: fg.code, quantity: '1' }] }],
    })
    expect(decided.return.lines[0].effect).toContain(`at ${fg.code}; a credit note to make (Finance)`)
    expect(decided.moves).toEqual([{ lineId: G.rma.lineId, moveId: expect.any(String), locationId: fg.id }])
    G.rma = { ...G.rma, version: decided.return.version, status: 'INSPECTED', creditAmount: G.rma.pieceValue }

    // The worker (W2A_61 creditNoteHandlers): return.credit_due → the TD04 draft on invoice 1, the RMA line named on it.
    expect(await settle()).toEqual(expect.arrayContaining(['return.decided', 'return.credit_due', 'invoice.return_credit_drafted']))
    const view = await ok(P.finance, 'GET', `/invoicing/returns/${G.rma.id}/credit-notes`)
    expect(view).toMatchObject({ creditDecidedAmount: G.rma.creditAmount, creditNotedAmount: G.rma.creditAmount, toCredit: [], notCredited: [{ lineId: G.rma.lineId, code: 'ON_CREDIT_NOTE' }] })
    expect(view.creditNotes).toHaveLength(1)
    expect(view.creditNotes[0]).toMatchObject({
      status: 'DRAFT',
      number: null,
      creditOfId: G.invoice1.id,
      creditOfNumber: G.invoice1.number,
      netTotal: G.rma.creditAmount,
      lines: [{ returnLineId: G.rma.lineId, seq: 10, quantity: '1.0000', netAmount: G.rma.creditAmount }],
      refunds: [],
    })
    // A person cannot draft it a second time.
    expect((await ok(P.finance, 'POST', `/invoicing/returns/${G.rma.id}/credit-notes`, {}, 409)).error.message).toMatch(/^Line 10 is on credit note/)
    G.creditNote = { id: view.creditNotes[0].id }
    keep(G.creditNote.id)
  })

  it('R05b P1 pays the rest of the first invoice the same day, before the credit note is issued: invoice 1 is paid in full', async () => {
    const before = (await ok(P.finance, 'GET', `/invoicing/invoices/${G.invoice1.id}`)).invoice
    expect(before.openAmount).toBeGreaterThan(0)
    const paid = await ok(P.finance, 'POST', '/payments', { companyId: companyA(), partyId: R_P1(), amount: before.openAmount, receivedOn: today(), externalRef: 'CRO-GOLDEN-W2A-0002', allocations: [{ invoiceId: G.invoice1.id, amount: before.openAmount }] }, 201)
    expect(paid.payment).toMatchObject({ allocated: before.openAmount, unallocated: 0 })
    keep(paid.payment.id)
    expect((await ok(P.finance, 'GET', `/invoicing/invoices/${G.invoice1.id}`)).invoice).toMatchObject({ openAmount: 0, refundDueAmount: 0 })
    await settle()
  })

  it('R06 finance checks the drafted credit note (art. 26 causale, the RMA line) and issues it with a fresh step-up: TD04 ISSUED', async () => {
    G.invoice1Before = (await ok(P.finance, 'GET', `/invoicing/invoices/${G.invoice1.id}`)).invoice
    const draft = (await ok(P.finance, 'GET', `/invoicing/invoices/${G.creditNote.id}`)).invoice
    expect(draft).toMatchObject({ docType: 'TD04', status: 'DRAFT', priceBasis: 'NET', creditOfId: G.invoice1.id, salesOrderId: G.order.id, netTotal: G.rma.creditAmount })
    expect(draft.causale).toMatch(/^Nota di credito: Reso merce - RMA /)
    expect(draft.causale).toContain(`RMA ${G.rma.number} - rif. fattura n. ${G.invoice1.number} del `)
    expect(draft.causale).toContain('(art. 26 DPR 633/1972)')
    expect(draft.lines).toEqual([expect.objectContaining({ kind: 'GOODS', quantity: '1.0000', netAmount: G.rma.creditAmount, returnLineId: G.rma.lineId, description: expect.stringMatching(/^Reso .+ riga 10: /) })])
    expect(draft.grossTotal).toBeGreaterThan(draft.netTotal)
    const checks = await ok(P.finance, 'GET', `/invoicing/invoices/${draft.id}/checks`)
    expect(checks.problems.filter((problem: Record<string, any>) => problem.severity !== 'WARNING')).toEqual([])
    await stepped(w, P.finance)
    const issued = await ok(P.finance, 'POST', `/invoicing/invoices/${draft.id}/issue`, { version: draft.version })
    expect(issued).toMatchObject({ invoice: { docType: 'TD04', status: 'ISSUED', number: expect.stringMatching(/^FT-\d{4}-\d{5}$/), issueDate: today(), xmlFileId: expect.any(String), pdfFileId: expect.any(String) }, filesPending: false })
    G.creditNote = issued.invoice
    expect(await settle()).toContain('invoice.issued')
  })

  it('R07 the credit note goes to SDI (FAKE, step-up): the scheduler’s poll and the worker record it DELIVERED', async () => {
    await stepped(w, P.finance)
    const sent = await ok(P.finance, 'POST', `/invoicing/invoices/${G.creditNote.id}/sdi/send`, {})
    expect(sent.sdi.sends.at(-1).status).toBe('SENT')
    await settle()
    // The scheduler's tick an hour later (apps/factory-api/src/modules/invoicing/sdi/poll.ts runSdiPoll).
    const tick = await runSdiPoll({ database: w.h.database, log: QUIET, clock: { now: () => new Date(Date.now() + 3_600_000) } })
    expect(tick.failed).toBe(0)
    expect(tick.due).toBeGreaterThanOrEqual(1)
    expect(await settle()).toContain('invoice.sdi_poll_due')
    G.creditNote = (await ok(P.finance, 'GET', `/invoicing/invoices/${G.creditNote.id}`)).invoice
    expect(G.creditNote.status).toBe('DELIVERED')
  })

  it('R08 the money: invoice 1 was paid in full, so the credit note’s gross is due back: “Refunds to make” lists it; finance records the refund DUE, then PAID', async () => {
    // B-W2a-61 decided: no refund row is made by the system; what is refundable is computed on read
    // (paid − (gross − credited)); a person records each refund, DUE then PAID with the bank reference.
    const before = G.invoice1Before as Record<string, any>
    expect(before).toMatchObject({ openAmount: 0, refundDueAmount: 0 })
    const after = (await ok(P.finance, 'GET', `/invoicing/invoices/${G.invoice1.id}`)).invoice
    expect(after).toMatchObject({ creditedAmount: before.creditedAmount + G.creditNote.grossTotal, openAmount: 0, refundDueAmount: G.creditNote.grossTotal })
    const settlementOf = async () => (await ok(P.finance, 'GET', `/invoicing/orders/${G.order.id}/settlement`)).settlement
    expect((await settlementOf()).invoices.find((row: Record<string, any>) => row.id === G.invoice1.id)).toMatchObject({ creditedAmount: after.creditedAmount })
    const toRefund = await ok(P.finance, 'GET', `/payments/refunds/open?companyId=${companyA()}&partyId=${R_P1()}`)
    const row = (toRefund.creditNotesToRefund as Record<string, any>[]).find((entry) => entry.creditNoteId === G.creditNote.id)
    expect(row).toMatchObject({ number: G.creditNote.number, creditOfId: G.invoice1.id, refundableAmount: after.refundDueAmount, refundedAmount: 0 })
    expect((await settlementOf()).gaps).toContain('REFUND_DUE')
    const due = (await ok(P.finance, 'POST', '/payments/refunds', { creditNoteId: G.creditNote.id, dueDate: addDays(today(), 14), internalNote: 'Return of one 52: by bank transfer to the IBAN on file.' }, 201)).refund
    expect(due).toMatchObject({ status: 'DUE', source: 'CREDIT_NOTE', amount: after.refundDueAmount, dueDate: addDays(today(), 14), paidOn: null })
    const paid = (await ok(P.finance, 'POST', `/payments/refunds/${due.id}/paid`, { version: due.version, paidOn: today(), externalRef: 'CRO-GOLDEN-R-0001' })).refund
    expect(paid).toMatchObject({ status: 'PAID', paidOn: today(), externalRef: 'CRO-GOLDEN-R-0001', amount: after.refundDueAmount })
    G.refund = paid
    keep(paid.id)
    expect((await ok(P.finance, 'GET', `/invoicing/invoices/${G.invoice1.id}`)).invoice).toMatchObject({ refundDueAmount: 0, openAmount: 0 })
    expect((await settlementOf()).gaps).not.toContain('REFUND_DUE')
    expect((await ok(P.finance, 'GET', `/payments/refunds/open?companyId=${companyA()}&partyId=${R_P1()}`)).creditNotesToRefund.find((entry: Record<string, any>) => entry.creditNoteId === G.creditNote.id)).toBeUndefined()
    expect(await settle()).toEqual(expect.arrayContaining(['refund.recorded', 'refund.paid']))
  })

  it('R09 sales closes the RMA with its finish reason: CLOSED, every tracking step done, no warning', async () => {
    const record = (await ok(P.sales, 'GET', `/sales/returns/${G.rma.id}`)).return
    expect(rHeld(record, 'close')).toBeNull()
    const reason = 'Credited on the credit note; the jacket is back in finished goods.'
    const closed = await ok(P.sales, 'POST', `/sales/returns/${G.rma.id}/close`, { version: record.version, reason })
    expect(closed).toMatchObject({ return: { status: 'CLOSED', statusReason: reason }, warnings: [] })
    expect(closed.return.tracking.map((step: Record<string, any>) => step.state)).toEqual(['DONE', 'DONE', 'DONE', 'DONE', 'DONE'])
    G.rma = { ...G.rma, version: closed.return.version, status: 'CLOSED' }
    expect(await settle()).toContain('return.status_changed')
  })

  // ---- the repair: SEED-REP-0001 (a protective jacket received back on SEED-RMA-0002's line decided Repair) --------------------

  it('R10 sales estimates and the customer approves the seeded repair (each move with its words)', async () => {
    let repair = (await ok(P.sales, 'GET', `/sales/repairs/${R_REPAIR()}`)).repair
    expect(repair).toMatchObject({ number: 'SEED-REP-0001', stage: 'RECEIVED', safety: { required: true }, source: { returnLine: { returnNumber: 'SEED-RMA-0002' } }, garment: { size: '50', style: { code: 'SEED-JKT-02' } } })
    repair = (await ok(P.sales, 'POST', `/sales/repairs/${repair.id}/stage`, { version: repair.version, to: 'ESTIMATED', note: 'Re-sew the left shoulder seam, 40 minutes; told by phone.' })).repair
    expect(repair.stage).toBe('ESTIMATED')
    repair = (await ok(P.sales, 'POST', `/sales/repairs/${repair.id}/stage`, { version: repair.version, to: 'APPROVED', note: 'Approved by the customer by e-mail.' })).repair
    expect(repair.stage).toBe('APPROVED')
    expect((repair.stages as Record<string, any>[]).map((row) => row.to).slice(-2)).toEqual(['ESTIMATED', 'APPROVED'])
    G.repair = repair
    keep(repair.id)
    expect(await settle()).toContain('repair.stage_changed')
  })

  it('R11 the production manager makes its repair work order (step 20), checks and releases it; the repair goes IN_REPAIR', async () => {
    const options = await ok(P.manager, 'GET', `/production/work-orders/repair-options?repairOrderId=${G.repair.id}`)
    expect(options).toMatchObject({ repair: { id: G.repair.id, stage: 'APPROVED' }, workOrder: null, garment: { from: 'RETURN_LINE', size: '50' }, blockers: [] })
    expect((options.steps as Record<string, any>[]).find((step) => step.seq === 20)).toMatchObject({ available: true })
    const { workOrder } = await ok(P.manager, 'POST', '/production/work-orders/repairs', { repairOrderId: G.repair.id, version: G.repair.version, routingSeqs: [20] }, 201)
    expect(workOrder.status).toBe('DRAFT')
    keep(workOrder.id)
    const check = await ok(P.manager, 'GET', `/production/work-orders/${workOrder.id}/release-check`)
    expect(check).toMatchObject({ releasable: true, blockers: [] })
    const released = (await ok(P.manager, 'POST', `/production/work-orders/${workOrder.id}/release`, { version: workOrder.version })).workOrder
    expect(released.status).toBe('RELEASED')
    G.repairWorkOrder = released
    // The work order's make bumped the repair's version: read it again.
    let repair = (await ok(P.manager, 'GET', `/sales/repairs/${G.repair.id}`)).repair
    expect(repair.workOrder).toEqual({ id: workOrder.id, number: workOrder.number, status: 'RELEASED' })
    repair = (await ok(P.manager, 'POST', `/sales/repairs/${repair.id}/stage`, { version: repair.version, to: 'IN_REPAIR' })).repair
    expect(repair.stage).toBe('IN_REPAIR')
    G.repair = repair
    expect(await settle()).toEqual(expect.arrayContaining(['workorder.created', 'workorder.released', 'repair.stage_changed']))
  })

  it('R12 the repair work order is started and completed by hand (no bundles: B-W2a-12); the repair is REPAIRED, waiting for its check', async () => {
    await ok(P.manager, 'POST', `/production/work-orders/${G.repairWorkOrder.id}/start`, {})
    const done = (await ok(P.manager, 'POST', `/production/work-orders/${G.repairWorkOrder.id}/complete`, {})).workOrder
    expect(done.status).toBe('COMPLETED')
    const current = (await ok(P.manager, 'GET', `/sales/repairs/${G.repair.id}`)).repair
    const repair = (await ok(P.manager, 'POST', `/sales/repairs/${G.repair.id}/stage`, { version: current.version, to: 'REPAIRED' })).repair
    expect(repair).toMatchObject({ stage: 'REPAIRED', status: 'Repaired: waiting for its safety check', safety: { state: 'NOT_CHECKED' }, workOrder: { id: G.repairWorkOrder.id, status: 'COMPLETED' } })
    expect(repair.repairedAt).toEqual(expect.any(String))
    expect(rSteps(repair)).toEqual([['RECEIVED', 'DONE'], ['ESTIMATED', 'DONE'], ['APPROVED', 'DONE'], ['IN_REPAIR', 'DONE'], ['REPAIRED', 'CURRENT'], ['SHIPPED', 'WAITING']])
    G.repair = repair
    expect(await settle()).toContain('repair.stage_changed')
  })

  it('R13 the warehouse may not send it back before the safety check (refused in words); the inspector signs the check (step-up): PASS', async () => {
    const before = (await ok(P.warehouse, 'GET', `/sales/repairs/${G.repair.id}`)).repair
    const early = await ok(P.warehouse, 'POST', `/sales/repairs/${G.repair.id}/ship`, { version: before.version, ddt: R_DDT }, 409)
    expect(early.error.message).toBe('Repair SEED-REP-0001 is a protective garment: it goes back only after a passed safety check made after the repair (it is not checked yet).')
    await stepped(w, P.inspector)
    const checked = await ok(P.inspector, 'POST', `/sales/repairs/${G.repair.id}/safety-check`, { version: before.version, checklist: R_PASSED })
    expect(checked).toMatchObject({ result: 'PASS', failures: [], repair: { stage: 'REPAIRED', safety: { state: 'PASSED', result: 'PASS', checkedById: P.inspector.id } } })
    G.repair = checked.repair
    expect(await settle()).toContain('repair.safety_checked')
  })

  it('R14 the warehouse ships it back with its repair DDT, issued in the same step (DPR 472/1996): SHIPPED', async () => {
    const shipped = await ok(P.warehouse, 'POST', `/sales/repairs/${G.repair.id}/ship`, { version: G.repair.version, ddt: R_DDT })
    expect(shipped.ddt).toMatchObject({ reason: 'REPAIR', issuedNow: true, pdfProblem: null, number: expect.stringMatching(/^\d+\/\d{4}$/) })
    expect(shipped.repair).toMatchObject({ stage: 'SHIPPED', status: 'Repaired and shipped back', ddts: [{ number: shipped.ddt.number, reason: 'REPAIR', live: true }] })
    expect(shipped.warnings).toEqual([])
    expect(rSteps(shipped.repair).at(-1)).toEqual(['SHIPPED', 'CURRENT'])
    G.repair = { ...shipped.repair, ddt: shipped.ddt }
    keep(shipped.ddt.id)
    expect(await settle()).toEqual(expect.arrayContaining(['ddt.source_issued', 'repair.stage_changed']))
    // Shipped back: it changes no more.
    expect((await ok(P.warehouse, 'POST', `/sales/repairs/${G.repair.id}/ship`, { version: shipped.repair.version }, 409)).error.message).toBe('Repair SEED-REP-0001 is shipped back: it changes no more.')
  })

  // ---- a customer complaint: SAFETY, the PPE register entry with its trace, the owner's acknowledgement --------------------------

  it('R15 sales logs P1’s phone complaint about a size 50 of the first shipment (its batch): NEW, numbered, the evidence is the batch', async () => {
    // The owner (acknowledges safety alerts) — signed in before the triage so the alert reaches them.
    G.owner ??= await person(w, 'owner', 'owner')
    const body = {
      companyId: companyA(),
      partyId: R_P1(),
      channel: 'PHONE',
      customerRef: 'P1-CLAIM-GOLDEN-1',
      description: 'The left shoulder seam of a size 50 jacket opened after a slide on the first ride.',
      salesOrderId: G.order.id,
      shipmentId: G.shipment1.id,
      styleId: id('product:style:JKT-01'),
      size: '50',
      batchNumber: G.wo.batchNumber,
    }
    const preview = await ok(P.sales, 'POST', '/quality/complaints/preview', body)
    expect(preview).toMatchObject({ ok: true, problems: [] })
    // P1's other open complaint (a duplicate?): the seed's SAFETY complaint.
    expect((preview.others as Record<string, any>[]).map((row) => row.number)).toContain('SEED-CMP-0001')
    const made = await ok(P.sales, 'POST', '/quality/complaints', body, 201)
    expect(made.complaint).toMatchObject({
      number: expect.stringMatching(/^CMP-\d{4}-\d{4}$/),
      status: 'NEW',
      channel: 'PHONE',
      party: { id: R_P1() },
      order: { id: G.order.id },
      shipment: { id: G.shipment1.id },
      style: { code: 'SEED-JKT-01' },
      size: '50',
      batchNumber: G.wo.batchNumber,
      category: null,
      safety: { state: 'NONE' },
      evidence: { kind: 'batch', subject: G.wo.batchNumber },
    })
    // Triage is quality's, not sales'.
    expect(rHeld(made.complaint, 'triage')).toBe('NO_PERMISSION')
    G.complaint = made.complaint
    keep(made.complaint.id)
    expect(await settle()).toContain('complaint.received')
  })

  it('R16 the inspector triages it SAFETY: the alert is raised, the PPE register entry opens from the complaint with the batch’s trace, the owner is told', async () => {
    const triaged = await ok(P.inspector, 'POST', `/quality/complaints/${G.complaint.id}/triage`, {
      version: G.complaint.version,
      category: 'SAFETY',
      severity: 'MAJOR',
      ownerId: P.inspector.id,
      answerDueOn: addDays(today(), 10),
      risk: 'ASSESSING',
      note: 'A seam failure on a protective jacket: check the batch.',
    })
    expect(triaged.safetyRaised).toBe(true)
    expect(triaged.register).toMatchObject({ opened: true, reference: expect.stringMatching(/^REG-\d{4}-\d{4}$/) })
    expect(triaged.complaint).toMatchObject({ status: 'TRIAGED', category: 'SAFETY', severity: 'MAJOR', ownerId: P.inspector.id, safety: { state: 'RAISED' }, register: { id: triaged.register.entryId, risk: 'ASSESSING' } })
    // The register entry: source the complaint, the customer, the style, the batch, the shipment — and its trace to production.
    const { entry } = await ok(P.inspector, 'GET', `/compliance/register/${triaged.register.entryId}`)
    expect(entry).toMatchObject({ kind: 'COMPLAINT', source: { type: 'Complaint', id: G.complaint.id }, partyId: R_P1(), styleId: id('product:style:JKT-01'), batchNumbers: [G.wo.batchNumber] })
    expect(entry.shipmentIds).toContain(G.shipment1.id)
    expect((entry.trace.workOrders as Record<string, any>[]).map((row) => row.id)).toContain(G.wo.id)
    expect((entry.trace.shipments as Record<string, any>[]).map((row) => row.id)).toContain(G.shipment1.id)
    G.complaint = { ...triaged.complaint, registerEntryId: triaged.register.entryId }
    expect(await settle()).toEqual(expect.arrayContaining(['complaint.triaged', 'complaint.safety_raised', 'compliance.register_entry_opened']))
    // The worker's fan-out (W2A_20 notificationsHandler): an ALERT to the owner; the banner lists it.
    const told = (await ok(G.owner, 'GET', '/notifications?limit=100')).items as Record<string, any>[]
    expect(told.some((item) => item.record.type === 'Complaint' && item.record.id === G.complaint.id && item.messageKey === 'notifications.complaint.safety')).toBe(true)
    expect(((await ok(P.inspector, 'GET', '/quality/complaints/counts')).safetyAlerts as Record<string, any>[]).map((row) => row.id)).toContain(G.complaint.id)
  })

  it('R17 it closes only once the owner acknowledged the alert (refused in words before); then investigated, answered and closed by quality', async () => {
    const current = (await ok(P.inspector, 'GET', `/quality/complaints/${G.complaint.id}`)).complaint
    expect(rHeld(current, 'close')).toBe('SAFETY_NOT_ACKNOWLEDGED')
    const early = await ok(P.inspector, 'POST', `/quality/complaints/${G.complaint.id}/close`, { version: current.version, reason: 'Answered by phone.' }, 409)
    expect(early.error.issues).toEqual([expect.objectContaining({ path: 'held/SAFETY_NOT_ACKNOWLEDGED' })])
    // Quality may not acknowledge: the owner's alone.
    await ok(P.inspector, 'POST', `/quality/complaints/${G.complaint.id}/acknowledge`, { version: current.version }, 403)
    const acknowledged = (await ok(G.owner, 'POST', `/quality/complaints/${G.complaint.id}/acknowledge`, { version: current.version, note: 'Told by the quality inspector by phone; the batch is being checked.' })).complaint
    expect(acknowledged.safety).toMatchObject({ state: 'ACKNOWLEDGED', acknowledgedAt: expect.any(String), acknowledgedById: G.owner.id })
    const investigating = (await ok(P.inspector, 'POST', `/quality/complaints/${G.complaint.id}/status`, { version: acknowledged.version, to: 'INVESTIGATING', note: 'Seam strength of the batch’s retained jacket checked.' })).complaint
    expect(investigating.status).toBe('INVESTIGATING')
    const answered = (await ok(P.inspector, 'POST', `/quality/complaints/${G.complaint.id}/status`, { version: investigating.version, to: 'ANSWERED', note: 'Answered by e-mail: the jacket is repaired under warranty.' })).complaint
    expect(answered).toMatchObject({ status: 'ANSWERED', answeredAt: expect.any(String) })
    const reason = 'A single seam fault; the batch passed the check; repaired under warranty, the customer accepted.'
    const closed = (await ok(P.inspector, 'POST', `/quality/complaints/${G.complaint.id}/close`, { version: answered.version, reason })).complaint
    expect(closed).toMatchObject({ status: 'CLOSED', closeReason: reason, safety: { state: 'ACKNOWLEDGED' } })
    expect(rHeld(closed, 'edit')).toBe('CLOSED')
    G.complaint = { ...closed, registerEntryId: G.complaint.registerEntryId }
    expect(await settle()).toEqual(expect.arrayContaining(['complaint.safety_acknowledged', 'complaint.status_changed']))
    expect(((await ok(P.inspector, 'GET', '/quality/complaints/counts')).safetyAlerts as Record<string, any>[]).map((row) => row.id)).not.toContain(G.complaint.id)
  })

  // ---- B helpers (prefixed b / B_) --------------------------------------------------------------------------------------------
  type BJson = Record<string, any>
  const bP2 = () => id('party:P2')
  const bP2Orders = () => id('party-contact:P2:orders')
  /** parties seed FAKE_VAT.P2 (P2's identity is IT00000002022); the golden scenario's company A VAT is IT12345670009. */
  const B_P2_VAT = '00000002022'
  const B_COMPANY_A_VAT = '12345670009'
  const bDmy = (day: string) => day.split('-').reverse().join('/')
  const bOrder = async (orderId: string): Promise<BJson> => (await ok(P.buyer, 'GET', `/purchasing/orders/${orderId}`)).order
  /** The FAKE mailbox's mail of an outbound row (the worker delivered it: settle() first). */
  const bMail = (emailId: string) => w.h.ses.mails.find((entry) => entry.outboundId === emailId)
  /** The confirm link's token in the PO mail (the send delivers it; only the mail holds it). */
  const bLinkToken = (emailId: string): string => {
    const mail = bMail(emailId)
    if (!mail) throw new Error(`no mail ${emailId} in the FAKE mailbox`)
    const token = /#token=(\S+)/.exec(textOf(mail.raw))?.[1]
    if (!token) throw new Error(`mail ${emailId} holds no link`)
    return decodeURIComponent(token)
  }
  /** A draft PO of company A for A1 to P2 with these lines (the hand-added line defaults from P2's approved source). */
  async function bDraft(lines: readonly { itemKey: string; colourKey?: string; quantity: string; uom: string; days: number; areaTolerancePct?: string }[]): Promise<BJson> {
    let order = (await ok(P.buyer, 'POST', '/purchasing/orders', { companyId: companyA(), siteId: siteA1(), partyId: bP2(), incoterms: 'EXW Santa Croce' }, 201)).order
    for (const line of lines) {
      order = (
        await ok(
          P.buyer,
          'POST',
          `/purchasing/orders/${order.id}/lines`,
          { version: order.version, itemId: id(line.itemKey), ...(line.colourKey ? { itemColourId: id(line.colourKey) } : {}), quantity: line.quantity, uom: line.uom, needDate: addDays(today(), line.days), ...(line.areaTolerancePct ? { areaTolerancePct: line.areaTolerancePct } : {}) },
          201,
        )
      ).order
    }
    keep(order.id)
    return order
  }
  /** P2's FatturaPA through the FAKE SDI inbox of company A (the payables runtime reads the invoicing SDI runtime's fake = w.sdi). */
  function bDeliverFromP2(input: { number: string; progressive: string; documentType?: 'TD01' | 'TD04'; lines: { description: string; quantity: string; uom?: string; unitPrice: string; itemCode?: string }[]; orders?: { number: string }[]; relatedInvoices?: { number: string; date?: string }[] }) {
    const { xml, fileName } = supplierInvoiceXml({
      supplierVat: B_P2_VAT,
      buyerVat: B_COMPANY_A_VAT,
      number: input.number,
      date: today(),
      dueDate: today(),
      progressive: input.progressive,
      lines: input.lines,
      ...(input.documentType ? { documentType: input.documentType } : {}),
      ...(input.orders ? { orders: input.orders } : {}),
      ...(input.relatedInvoices ? { relatedInvoices: input.relatedInvoices } : {}),
    })
    // receivedAt defaults to the fake's clock (w.h.clock), the same clock its list filters on.
    return w.sdi.deliver({ tenantId: w.tenant.id, accountId: id('integration:account:sdi'), xml, fileName })
  }
  const bInvoice = async (who: Person, invoiceId: string): Promise<BJson> => (await ok(who, 'GET', `/payables/invoices/${invoiceId}`)).invoice
  const B_DDT = { transportBy: 'SENDER', packages: 1, grossWeightKg: '7.5' } as const

  // ---- B1 supplier items and prices -----------------------------------------------------------------------------------------

  it('B1.1 the buyer reads P2’s items and prices and keeps a new one: P2’s shoulder protectors at 6.40 in boxes of 12 (a second one refused)', async () => {
    const listed = (await ok(P.buyer, 'GET', `/purchasing/supplier-items?partyId=${bP2()}&companyId=${companyA()}`)).items as BJson[]
    // The seeded approved source: P2's black leather, 4.20 a ft², PRIMARY (the buyer sees the price: the cost grain).
    expect(listed.find((row) => row.id === id('sourcing:supplier-item:P2:leather:BLK'))).toMatchObject({ supplierArticleCode: 'SEED-ART-100', purchaseUom: 'FT2', unitPrice: '4.2', preference: 'PRIMARY', status: 'ACTIVE' })
    const created = await ok(
      P.buyer,
      'POST',
      '/purchasing/supplier-items',
      { companyId: companyA(), partyId: bP2(), itemId: id('product:item:protector'), purchaseUom: 'PCS', unitPrice: '6.40', minOrderQty: '12', orderMultiple: '12', leadTimeDays: 14, preference: 'PRIMARY', note: 'Golden flow: listino paraspalle 2026.' },
      201,
    )
    expect(created.demoted).toBeNull()
    expect(created.item).toMatchObject({ partyId: bP2(), item: { code: 'SEED-PRO-300' }, supplierArticleCode: 'SEED-ART-300', purchaseUom: 'PCS', unitPrice: '6.4', orderMultiple: '12', leadTimeDays: 14, preference: 'PRIMARY', status: 'ACTIVE' })
    G.source = created.item
    keep(created.item.id)
    // Refusal in words: one active source per supplier, company and material.
    const again = await ok(P.buyer, 'POST', '/purchasing/supplier-items', { companyId: companyA(), partyId: bP2(), itemId: id('product:item:protector') }, 409)
    expect(again.error.message).toMatch(/already has an approved source of SEED-PRO-300 .*change that one/)
    // The requests to buy (read only here: the queue is a live read of plan lines and reorder rules).
    const counts = await ok(P.buyer, 'GET', `/purchasing/requests/counts?siteId=${siteA1()}`)
    expect(typeof counts.open).toBe('number')
    expect(await settle()).toContain('supplier_item.created')
  })

  // ---- B2 PO changes and reminders ------------------------------------------------------------------------------------------

  it('B2.1 the buyer drafts a PO to P2 (100 ft² black leather, 24 protectors at the new source’s price) and sends it: revision 1, link to the supplier', async () => {
    let order = await bDraft([
      { itemKey: 'product:item:leather', colourKey: 'product:item-colour:leather:BLK', quantity: '100', uom: 'FT2', days: 40 },
      { itemKey: 'product:item:protector', quantity: '24', uom: 'PCS', days: 40 },
    ])
    expect(order.lines.map((line: BJson) => [line.seq, line.supplierArticleCode, Number(line.unitPrice)])).toEqual([
      [10, 'SEED-ART-100', 4.2],
      [20, 'SEED-ART-300', 6.4],
    ])
    const check = await ok(P.buyer, 'GET', `/purchasing/orders/${order.id}/send-check`)
    expect(check.checks.filter((entry: BJson) => entry.severity === 'BLOCKS')).toEqual([])
    expect(check).toMatchObject({ revision: 1, changes: null })
    const sent = await ok(P.buyer, 'POST', `/purchasing/orders/${order.id}/send`, { version: order.version })
    expect(sent).toMatchObject({ order: { status: 'SENT', revision: 1 }, sent: { revision: 1, to: 'orders.p2@example.com', changes: null }, delivery: 'sent' })
    order = sent.order
    G.po = order
    G.poMail1 = sent.sent.emailId
    await settle()
  })

  it('B2.2 the supplier opens the link and confirms every line as asked', async () => {
    const supplier = linkBrowser(w, bLinkToken(G.poMail1))
    const page = await supplier.send('GET', '/link/purchase-order')
    expect(page).toMatchObject({ order: { id: G.po.id, status: 'SENT', revision: 1 }, canAnswer: true })
    const answered = await supplier.send('POST', '/link/purchase-order/confirm', { version: page.order.version, mode: 'ALL_AS_ASKED', typedName: 'Mario Fornitore', supplierRef: 'OC-GB-1' })
    expect(answered).toMatchObject({ outcome: 'CONFIRMED', order: { status: 'CONFIRMED' } })
    G.po = await bOrder(G.po.id)
    expect(G.po.status).toBe('CONFIRMED')
    await settle()
  })

  it('B2.3 the buyer changes the confirmed PO: revision 2 draft, more leather later, the protectors cancelled (a draft is not changed again)', async () => {
    const changed = await ok(P.buyer, 'POST', `/purchasing/orders/${G.po.id}/change`, { version: G.po.version, note: 'Il cliente raddoppia il lotto di pelle.' })
    expect(changed).toMatchObject({ revision: 2, order: { status: 'DRAFT', revision: 2, confirmedAt: null } })
    let order = changed.order
    // Refusal in words: a draft is sent, not changed.
    expect((await ok(P.buyer, 'POST', `/purchasing/orders/${order.id}/change`, { version: order.version }, 409)).error.message).toBe('The order is a draft: change it and send it.')
    const [leather, protectors] = order.lines as BJson[]
    order = (await ok(P.buyer, 'PATCH', `/purchasing/orders/${order.id}/lines/${leather!.id}`, { version: order.version, quantity: '150', needDate: addDays(today(), 45) })).order
    const cancelled = await ok(P.buyer, 'POST', `/purchasing/orders/${order.id}/lines/cancel`, { version: order.version, lineIds: [protectors!.id], reason: 'Comprati altrove' })
    expect(cancelled.supplierTold).toBe(false)
    order = cancelled.order
    expect(order.lines[1]).toMatchObject({ ended: { kind: 'CANCELLED', reason: 'Comprati altrove' } })
    const revisions = await ok(P.buyer, 'GET', `/purchasing/orders/${order.id}/revisions`)
    expect(revisions.draft).toMatchObject({ revision: 2, changes: { count: 2, lines: [{ seq: 10, kind: 'CHANGED' }, { seq: 20, kind: 'CANCELLED' }] } })
    G.po = order
    await settle()
  })

  it('B2.4 the buyer sends revision 2 with its note; the supplier sees what changed and confirms the open line: revision rows 1 and 2', async () => {
    const check = await ok(P.buyer, 'GET', `/purchasing/orders/${G.po.id}/send-check`)
    expect(check.revision).toBe(2)
    expect(check.changes).toHaveLength(2)
    const sent = await ok(P.buyer, 'POST', `/purchasing/orders/${G.po.id}/send`, { version: G.po.version, changeNote: 'Il nostro cliente raddoppia la serie.' })
    expect(sent).toMatchObject({ order: { status: 'SENT', revision: 2 }, sent: { revision: 2, changes: check.changes } })
    await settle()
    const supplier = linkBrowser(w, bLinkToken(sent.sent.emailId))
    const page = await supplier.send('GET', '/link/purchase-order')
    expect(page.order).toMatchObject({ revision: 2, status: 'SENT' })
    expect(page.revision).toMatchObject({ revision: 2, changeNote: 'Il nostro cliente raddoppia la serie.', changes: check.changes })
    expect(page.lines.map((line: BJson) => line.ended)).toEqual([null, 'CANCELLED'])
    const answered = await supplier.send('POST', '/link/purchase-order/confirm', { version: page.order.version, mode: 'BY_LINE', lines: [{ lineId: page.lines[0].id, answer: 'AS_ASKED' }] })
    expect(answered).toMatchObject({ outcome: 'CONFIRMED' })
    const revisions = await ok(P.buyer, 'GET', `/purchasing/orders/${G.po.id}/revisions`)
    expect(revisions.revisions.map((entry: BJson) => [entry.revision, entry.answer])).toEqual([
      [1, 'CONFIRMED'],
      [2, 'CONFIRMED'],
    ])
    expect(await admin(w, 'SELECT revision, "changeNote" FROM "PurchaseOrderRevision" WHERE "purchaseOrderId" = $1 ORDER BY revision', [G.po.id])).toEqual([
      { revision: 1, changeNote: null },
      { revision: 2, changeNote: 'Il nostro cliente raddoppia la serie.' },
    ])
    G.po = await bOrder(G.po.id)
    expect(G.po).toMatchObject({ status: 'CONFIRMED', revision: 2 })
    expect(G.po.lines[0].confirmedQuantity).toBe('150.0000')
    await settle()
  })

  it('B2.5 the warehouse receives 100 of the 150 ft² (two hides, one dye batch): PARTLY_RECEIVED, the lot in quarantine for its Cr VI test', async () => {
    const leather = (G.po.lines as BJson[])[0]!
    const received = await ok(
      P.warehouse,
      'POST',
      '/inventory/receipts',
      {
        purchaseOrderId: G.po.id,
        supplierDdtNumber: 'DDT-GB-01',
        supplierDdtDate: today(),
        lines: [{ purchaseOrderLineId: leather.id, lots: [{ supplierLotRef: 'TAN-GB-1', dyeBatch: 'DB-GB-1', shade: 'Nero 01', hides: [{ supplierCode: 'GB-H-1', area: '52.5', grade: 'A', thicknessMm: '1.2' }, { supplierCode: 'GB-H-2', area: '47.5', grade: 'A', thicknessMm: '1.2' }] }] }],
      },
      201,
    )
    expect(received.receipt).toMatchObject({ status: 'POSTED', purchaseOrder: { status: 'PARTLY_RECEIVED' } })
    const lot = received.receipt.lines[0].lots[0]
    expect(lot).toMatchObject({ qualityStatus: 'QUARANTINE', holds: ['CR_VI_TEST'] })
    G.receiptB = received.receipt
    keep(received.receipt.id, lot.id)
    expect(await settle()).toContain('inventory.receipt_posted')
  })

  it('B2.6 the buyer closes the rest short (the tannery has no more of this batch): the supplier is told, the PO is RECEIVED', async () => {
    const order = await bOrder(G.po.id)
    const reach = await ok(P.buyer, 'GET', `/purchasing/orders/${order.id}/reach?action=CLOSE_SHORT&lineIds=${order.lines[0].id}`)
    expect(reach).toMatchObject({ allowed: true, supplierTold: true, lines: [{ seq: 10 }] })
    const closed = await ok(P.buyer, 'POST', `/purchasing/orders/${order.id}/lines/close-short`, { version: order.version, lineIds: [order.lines[0].id], reason: 'La conceria non ha altro di questo bagno' })
    expect(closed).toMatchObject({ supplierTold: true, order: { status: 'RECEIVED', lines: [{ ended: { kind: 'CLOSED_SHORT' } }, { ended: { kind: 'CANCELLED' } }] } })
    G.po = closed.order
    expect(await settle()).toContain('purchase_order.lines_closed_short')
  })

  it('B2.7 Send n: two new drafts go each with its own send; an empty one is refused alone, in words', async () => {
    const protectors = await bDraft([{ itemKey: 'product:item:protector', quantity: '24', uom: 'PCS', days: 40 }])
    const leather = await bDraft([{ itemKey: 'product:item:leather', colourKey: 'product:item-colour:leather:BLK', quantity: '100', uom: 'FT2', days: 40, areaTolerancePct: '5' }])
    const empty = (await ok(P.buyer, 'POST', '/purchasing/orders', { companyId: companyA(), siteId: siteA1(), partyId: bP2() }, 201)).order
    keep(empty.id)
    const cards = await ok(P.buyer, 'POST', '/purchasing/orders/send-checks', { orderIds: [protectors.id, leather.id, empty.id] })
    expect(cards).toMatchObject({ ready: 2, cards: [{ id: protectors.id, ready: true }, { id: leather.id, ready: true }, { id: empty.id, ready: false }] })
    const answer = await ok(P.buyer, 'POST', '/purchasing/orders/send-many', { orders: [protectors, leather, empty].map((order) => ({ id: order.id, version: order.version })) })
    expect(answer).toMatchObject({ sent: 2, refused: 1, outcomes: [{ id: protectors.id, outcome: 'SENT' }, { id: leather.id, outcome: 'SENT' }, { id: empty.id, outcome: 'REFUSED', refused: { code: 'conflict' } }] })
    expect(answer.outcomes[2].refused.message).toMatch(/^The order cannot be sent yet\. Add a line/)
    G.poSendN = { protectors: await bOrder(protectors.id), leather: await bOrder(leather.id) }
    expect(G.poSendN.protectors.status).toBe('SENT')
    await settle()
  })

  it('B2.8 the buyer reminds P2 by hand to confirm the protectors (a mail without a link); the automatic reminders stay off', async () => {
    const order = await bOrder(G.poSendN.protectors.id)
    const reminded = await ok(P.buyer, 'POST', `/purchasing/orders/${order.id}/remind`, { version: order.version, message: 'Vi preghiamo di confermare entro oggi.' })
    expect(reminded.reminder).toMatchObject({ revision: 1, automatic: false, to: 'orders.p2@example.com' })
    expect(await settle()).toContain('purchase_order.reminder_sent')
    const mail = bMail(reminded.reminder.emailId)
    expect(mail, 'the reminder in the FAKE mailbox').toBeTruthy()
    expect(textOf(mail!.raw)).toContain('Vi preghiamo di confermare entro oggi.')
    expect(textOf(mail!.raw)).not.toMatch(/#token=/)
    // The Owner's switch: no automatic reminder (purchasing/reminders/daily.ts automaticRemindersOn = OFF).
    expect(await ok(P.buyer, 'GET', `/purchasing/orders/${order.id}/reminders`)).toMatchObject({ automatic: false, reminders: [{ revision: 1, automatic: false }] })
    G.poSendN.protectors = reminded.order
  })

  // ---- B3 receiving every day -----------------------------------------------------------------------------------------------

  it('B3.1 the warehouse receives 20 of the 24 protectors and records what was wrong: 4 short, 2 damaged', async () => {
    const line = (G.poSendN.protectors.lines as BJson[])[0]!
    const received = await ok(
      P.warehouse,
      'POST',
      '/inventory/receipts',
      { purchaseOrderId: G.poSendN.protectors.id, supplierDdtNumber: 'DDT-GB-02', supplierDdtDate: today(), lines: [{ purchaseOrderLineId: line.id, lots: [{ supplierLotRef: 'PRO-GB-1', quantity: '20' }] }] },
      201,
    )
    expect(received.receipt).toMatchObject({ status: 'POSTED', purchaseOrder: { status: 'PARTLY_RECEIVED' } })
    expect(received.receipt.lines[0].lots[0]).toMatchObject({ qualityStatus: 'QUARANTINE', holds: ['PPE_CERTIFICATE'] })
    G.receiptShort = received.receipt
    keep(received.receipt.id, received.receipt.lines[0].lots[0].id)
    const base = `/inventory/receipts/${received.receipt.id}/discrepancies`
    const short = (await ok(P.warehouse, 'POST', base, { reasonCode: 'SHORT', receiptLineId: received.receipt.lines[0].id, quantity: '4', uom: 'PCS', note: 'Quattro paraspalle mancanti nella scatola.' }, 201)).discrepancy
    expect(short).toMatchObject({ seq: 10, status: 'OPEN', kind: 'SHORT', reasonCode: 'SHORT', quantity: '4.0000', uom: 'PCS' })
    const damaged = (await ok(P.warehouse, 'POST', base, { reasonCode: 'DAMAGED', receiptLineId: received.receipt.lines[0].id, quantity: '2', uom: 'PCS', note: 'Due gusci incrinati.' }, 201)).discrepancy
    expect(damaged).toMatchObject({ seq: 20, status: 'OPEN', kind: 'DAMAGED' })
    G.shortDiscrepancy = short
    G.discrepancy = damaged
    keep(short.id, damaged.id)
    await settle()
  })

  it('B3.2 the warehouse reports both to P2 (PDF on the receipt, FAKE SES); P2 agrees to send the 4 missing (closing needs words)', async () => {
    const receiptId = G.receiptShort.id
    const check = await ok(P.warehouse, 'GET', `/inventory/receipts/${receiptId}/discrepancy-report/check`)
    expect(check).toMatchObject({ ready: true, problems: [], language: 'it', recipients: [{ contactId: bP2Orders(), email: 'orders.p2@example.com', suggested: true }] })
    expect([...check.discrepancyIds].sort()).toEqual([G.shortDiscrepancy.id, G.discrepancy.id].sort())
    const sent = await ok(P.warehouse, 'POST', `/inventory/receipts/${receiptId}/discrepancy-report`, { contactIds: [bP2Orders()] }, 201)
    expect(sent.report).toMatchObject({ to: ['orders.p2@example.com'], language: 'it' })
    expect([...sent.report.sentIds].sort()).toEqual([G.shortDiscrepancy.id, G.discrepancy.id].sort())
    expect((sent.discrepancies as BJson[]).every((row) => row.status === 'SENT')).toBe(true)
    expect(await settle()).toContain('inventory.receipt_discrepancies_reported')
    expect(bMail(sent.report.emailId), 'the report in the FAKE mailbox').toBeTruthy()
    let short = (sent.discrepancies as BJson[]).find((row) => row.id === G.shortDiscrepancy.id)!
    short = (await ok(P.warehouse, 'POST', `/inventory/receipts/${receiptId}/discrepancies/${short.id}/status`, { version: short.version, to: 'AGREED', note: 'Il fornitore manda i 4 mancanti con la prossima consegna.' })).discrepancy
    expect(short.status).toBe('AGREED')
    // Refusal in words: a discrepancy is closed with what settled it.
    const refused = await ok(P.warehouse, 'POST', `/inventory/receipts/${receiptId}/discrepancies/${short.id}/status`, { version: short.version, to: 'CLOSED' }, 400)
    expect(refused.error.issues).toEqual([{ path: 'body/note', message: 'Say what settled it, or why it is not pursued.' }])
    G.shortDiscrepancy = short
    G.discrepancy = (sent.discrepancies as BJson[]).find((row) => row.id === G.discrepancy.id)!
    await settle()
  })

  it('B3.3 the tannery’s hide list for the Send-n leather order is imported (dry run, then apply): ONE receipt, its hides one by one', async () => {
    const order = G.poSendN.leather
    const body = Buffer.from(
      ['Ordine;Numero pelle;Superficie;UM;Bagno;Scelta;Spessore;DDT;Data DDT;Motivo differenza', `${order.number};GB-T-01;51,5;ft2;DB-GB-9;A;1,2;DDT-GB-HL;${bDmy(today())};`, `${order.number};GB-T-02;48,5;ft2;DB-GB-9;A;1,2;;;`].join('\r\n'),
      'utf8',
    )
    const started = await ok(P.warehouse, 'POST', '/imports', { importerKey: 'inventory.hideList', companyId: companyA(), file: { originalName: 'lista-pelli.csv', contentType: SHEET_TYPES.csv, sizeBytes: body.length, sha256: sha256(body) } }, 201)
    await putBytes(w, started, body)
    await ok(P.warehouse, 'POST', `/files/${started.job.fileId}/complete`)
    // The worker's dry run (imports.planUpload on file.available).
    await settle()
    let job = (await ok(P.warehouse, 'GET', `/imports/${started.job.id}`)).job
    expect(job).toMatchObject({ status: 'PLANNED', rowCount: 2, createCount: 2, errorCount: 0 })
    const planned = await ok(P.warehouse, 'GET', `/inventory/receipts/hide-lists/${job.id}`)
    expect(planned).toMatchObject({ status: 'PLANNED', counts: { rows: 2, toReceive: 2, errors: 0 }, order: { id: order.id, number: order.number }, receipt: null })
    await ok(P.warehouse, 'POST', `/imports/${job.id}/apply`, { version: job.version })
    // The worker's apply (import.apply_requested).
    await settle()
    job = (await ok(P.warehouse, 'GET', `/imports/${job.id}`)).job
    expect(job).toMatchObject({ status: 'APPLIED', appliedCount: 2 })
    const summary = await ok(P.warehouse, 'GET', `/inventory/receipts/hide-lists/${job.id}`)
    expect(summary.receipt).toMatchObject({ status: 'POSTED' })
    const receipt = (await ok(P.warehouse, 'GET', `/inventory/receipts/${summary.receipt.id}`)).receipt
    expect(receipt).toMatchObject({ supplierDdtNumber: 'DDT-GB-HL', supplierDdtDate: today(), purchaseOrder: { id: order.id, status: 'RECEIVED' }, summary: { lots: 1, hides: 2 } })
    const lots = (await ok(P.warehouse, 'GET', `/inventory/receipts/${receipt.id}/lots`)).lots as BJson[]
    expect(lots.map((lot) => [lot.dyeBatch, lot.hides.map((hide: BJson) => hide.supplierCode)])).toEqual([['DB-GB-9', ['GB-T-01', 'GB-T-02']]])
    G.hideListJob = job
    G.hideListReceipt = receipt
    G.hideListLot = lots[0]
    keep(job.id, receipt.id, lots[0]!.id, ...lots[0]!.hides.map((hide: BJson) => hide.id))
    await settle()
  })

  // ---- B4 return to supplier and supplier claims ----------------------------------------------------------------------------

  it('B4.1 the warehouse sends the hide-list lot back to the tannery in one go: a RETURN claim SENT, both hides out, the RETURN DDT (the lot again refused)', async () => {
    const returned = await ok(
      P.warehouse,
      'POST',
      '/purchasing/claims/returns',
      { from: { lotId: G.hideListLot.id }, reasonCode: 'QUALITY', reasonNote: 'Grana difettosa su tutto il bagno DB-GB-9', remedy: 'CREDIT', mail: { contactIds: [bP2Orders()] }, ddt: B_DDT },
      201,
    )
    expect(returned.claim).toMatchObject({ kind: 'RETURN', status: 'SENT', supplier: { id: bP2() }, foundAt: 'RECEIPT', returned: 2 })
    expect(returned.claim.lines).toHaveLength(2)
    expect(returned.claim.lines.every((line: BJson) => line.move?.reason === 'ADJUSTMENT' && line.ddt?.id === returned.ddt.id && line.lot?.qualityStatus === 'QUARANTINE')).toBe(true)
    expect(returned.moveIds).toHaveLength(2)
    expect(returned.ddt).toMatchObject({ number: expect.stringMatching(/\/\d{4}$/), pdfProblem: null })
    expect(returned.claim.ddts).toEqual([expect.objectContaining({ id: returned.ddt.id, reason: 'RETURN', cancelled: false })])
    G.supplierReturn = returned.claim
    G.returnDdt = returned.ddt
    keep(returned.claim.id, returned.ddt.id, ...returned.moveIds)
    expect(await settle()).toEqual(expect.arrayContaining(['supplier_claim.created', 'supplier_claim.sent', 'ddt.source_issued', 'supplier_claim.goods_returned']))
    // Refusal in words: nothing of the lot is left to send back.
    const again = await ok(P.warehouse, 'POST', '/purchasing/claims/returns', { from: { lotId: G.hideListLot.id }, reasonCode: 'QUALITY', ddt: B_DDT }, 400)
    expect(again.error.message).toBe(`Lot ${G.hideListLot.code} has no hide in stock at its site.`)
  })

  it('B4.2 the warehouse closes the return once the tannery took the hides back', async () => {
    const seen = (await ok(P.warehouse, 'GET', `/purchasing/claims/${G.supplierReturn.id}`)).claim
    const closed = (await ok(P.warehouse, 'POST', `/purchasing/claims/${seen.id}/close`, { version: seen.version, note: 'Pelli ritirate dalla conceria con il DDT di reso.' })).claim
    expect(closed).toMatchObject({ status: 'CLOSED', closeNote: 'Pelli ritirate dalla conceria con il DDT di reso.' })
    G.supplierReturn = closed
    expect(await settle()).toContain('supplier_claim.closed')
  })

  it('B4.3 the buyer claims a credit for the 2 damaged protectors from the reported discrepancy and sends the claim by mail', async () => {
    const made = (await ok(P.buyer, 'POST', '/purchasing/claims', { kind: 'CLAIM', from: { discrepancyIds: [G.discrepancy.id] }, reasonCode: 'QUALITY', reasonNote: 'Gusci incrinati alla consegna' }, 201)).claim
    expect(made).toMatchObject({ kind: 'CLAIM', status: 'DRAFT', remedy: 'CREDIT', foundAt: 'RECEIPT', supplier: { id: bP2() }, goodsReceipt: { id: G.receiptShort.id }, purchaseOrder: { id: G.poSendN.protectors.id }, quantity: { quantity: '2.0000', uom: 'PCS' } })
    expect(made.lines).toEqual([expect.objectContaining({ discrepancy: expect.objectContaining({ id: G.discrepancy.id, status: 'SENT' }), quantity: '2.0000' })])
    // The buyer sees the credit asked: the lot's cost (the order's 6.40) × 2.
    expect(made.expectedCreditAmount).toBe(1280)
    keep(made.id)
    const check = await ok(P.buyer, 'GET', `/purchasing/claims/${made.id}/send-check`)
    expect(check).toMatchObject({ ready: true, problems: [], language: 'it', recipients: [{ contactId: bP2Orders(), suggested: true }] })
    const sent = await ok(P.buyer, 'POST', `/purchasing/claims/${made.id}/send`, { version: made.version, mail: { contactIds: [bP2Orders()] } })
    expect(sent.claim).toMatchObject({ status: 'SENT', sentById: P.buyer.id })
    expect(await settle()).toContain('supplier_claim.sent')
    expect(bMail(sent.emailId), 'the claim in the FAKE mailbox').toBeTruthy()
    G.claim = sent.claim
  })

  it('B4.4 P2 accepts a credit: the buyer records the answer (the discrepancy AGREED); the claim waits for the credit note', async () => {
    const answered = (await ok(P.buyer, 'POST', `/purchasing/claims/${G.claim.id}/answer`, { version: G.claim.version, outcome: 'ACCEPTED', answer: 'Accreditiamo i due paraspalle con nota di credito.' })).claim
    expect(answered).toMatchObject({ status: 'ACCEPTED', remedy: 'CREDIT', expectedCreditAmount: 1280 })
    expect(answered.lines[0].discrepancy.status).toBe('AGREED')
    G.claim = answered
    expect(await settle()).toContain('supplier_claim.answered')
  })

  // ---- B5 supplier invoices matched -----------------------------------------------------------------------------------------

  it('B5.1 P2’s FatturaPA for the 100 ft² arrives through the FAKE SDI inbox; finance picks it up: mapped to the PO line, MATCHED', async () => {
    const leather = (G.po.lines as BJson[])[0]!
    bDeliverFromP2({ number: 'GB-2026-0001', progressive: 'GB001', orders: [{ number: G.po.number }], lines: [{ description: 'Pelle bovina nera', quantity: '100', uom: 'FT2', unitPrice: leather.unitPrice, itemCode: leather.supplierArticleCode }] })
    const pickup = await ok(P.finance, 'POST', '/payables/sdi/pickup', { companyId: companyA() })
    expect(pickup.waiting).toEqual([])
    expect(pickup.recorded).toEqual([expect.objectContaining({ number: 'GB-2026-0001', matchStatus: 'MATCHED' })])
    const invoice = await bInvoice(P.finance, pickup.recorded[0].invoiceId)
    // SDI's delivery is registered by nobody of the office (system context): any approver may approve it.
    expect(invoice).toMatchObject({ source: 'SDI', kind: 'INVOICE', docType: 'TD01', status: 'RECEIVED', registeredBy: null, netTotal: 42_000, vatTotal: 9_240, grossTotal: 51_240, matchStatus: 'MATCHED' })
    expect(invoice.lines[0]).toMatchObject({ kind: 'GOODS', purchaseOrderLine: { orderNumber: G.po.number, seq: 10 } })
    expect(invoice.matches[0]).toMatchObject({ verdict: 'WITHIN', withinTolerance: true, differenceAmount: 0 })
    expect(invoice.approval.ready).toBe(true)
    G.supplierInvoice = invoice
    keep(invoice.id)
    expect(await settle()).toContain('supplier_invoice.received')
  })

  it('B5.2 another finance person approves it (the buyer may not); finance records the transfer: PAID', async () => {
    let invoice = await bInvoice(P.finance2, G.supplierInvoice.id)
    // The buyer maps and accepts differences, never approves (no payables.approve).
    await ok(P.buyer, 'POST', `/payables/invoices/${invoice.id}/approve`, { version: invoice.version }, 403)
    invoice = (await ok(P.finance2, 'POST', `/payables/invoices/${invoice.id}/approve`, { version: invoice.version, note: 'Pelle ricevuta: 100 ft² di 150, resto chiuso.' })).invoice
    expect(invoice).toMatchObject({ status: 'APPROVED', approval: { approvedBy: { id: P.finance2.id } } })
    invoice = (await ok(P.finance, 'POST', `/payables/invoices/${invoice.id}/pay`, { version: invoice.version, paidOn: today(), paymentRef: 'CRO 0000-FAKE-GB01' })).invoice
    expect(invoice).toMatchObject({ status: 'PAID', payment: { paidOn: today(), paymentRef: 'CRO 0000-FAKE-GB01' } })
    G.supplierInvoice = invoice
    expect(await settle()).toEqual(expect.arrayContaining(['supplier_invoice.approved', 'supplier_invoice.paid']))
  })

  it('B5.3 P2 bills all 24 protectors while 4 are still coming: WAITING_GOODS (approval refused); the 4 arrive, the worker matches it again', async () => {
    const line = (G.poSendN.protectors.lines as BJson[])[0]!
    bDeliverFromP2({ number: 'GB-2026-0002', progressive: 'GB002', orders: [{ number: G.poSendN.protectors.number }], lines: [{ description: 'Paraspalla livello 2', quantity: '24', uom: 'PZ', unitPrice: line.unitPrice, itemCode: line.supplierArticleCode }] })
    const pickup = await ok(P.finance, 'POST', '/payables/sdi/pickup', { companyId: companyA() })
    expect(pickup.recorded).toEqual([expect.objectContaining({ number: 'GB-2026-0002', matchStatus: 'WAITING_GOODS' })])
    let invoice = await bInvoice(P.finance2, pickup.recorded[0].invoiceId)
    // The match view trims its quantities ('24', '20': payables.pg shows '24' and '0').
    expect(invoice.matches[0]).toMatchObject({ verdict: 'WAITING', withinTolerance: false })
    expect([Number(invoice.matches[0].invoicedQuantity), Number(invoice.matches[0].receivedQuantity)]).toEqual([24, 20])
    keep(invoice.id)
    // Refusal in words: not before the goods.
    const refused = await ok(P.finance2, 'POST', `/payables/invoices/${invoice.id}/approve`, { version: invoice.version }, 409)
    expect(refused.error.issues.map((issue: BJson) => issue.path)).toEqual(['refusal/WAITING_GOODS'])
    await settle()
    // The 4 missing protectors arrive (the SHORT discrepancy's agreement kept).
    const received = await ok(P.warehouse, 'POST', '/inventory/receipts', { purchaseOrderId: G.poSendN.protectors.id, supplierDdtNumber: 'DDT-GB-04', supplierDdtDate: today(), lines: [{ purchaseOrderLineId: line.id, lots: [{ supplierLotRef: 'PRO-GB-2', quantity: '4' }] }] }, 201)
    expect(received.receipt).toMatchObject({ status: 'POSTED', purchaseOrder: { status: 'RECEIVED' } })
    keep(received.receipt.id)
    // payables.rematch on inventory.receipt_posted (background.ts W2A_62_HANDLERS = payablesHandlers()).
    expect(await settle()).toEqual(expect.arrayContaining(['inventory.receipt_posted', 'supplier_invoice.matched']))
    invoice = await bInvoice(P.finance2, invoice.id)
    expect(invoice).toMatchObject({ matchStatus: 'MATCHED', approval: { ready: true } })
    expect(invoice.matches[0]).toMatchObject({ verdict: 'WITHIN', withinTolerance: true })
    expect(Number(invoice.matches[0].receivedQuantity)).toBe(24)
    const short = (await ok(P.warehouse, 'POST', `/inventory/receipts/${G.receiptShort.id}/discrepancies/${G.shortDiscrepancy.id}/status`, { version: G.shortDiscrepancy.version, to: 'CLOSED', note: 'Arrivati i 4 mancanti con il DDT-GB-04.' })).discrepancy
    expect(short).toMatchObject({ status: 'CLOSED' })
    G.shortDiscrepancy = short
    // The grid's bulk approve, by the other finance person.
    const bulk = await ok(P.finance2, 'POST', '/payables/invoices/approve', { items: [{ id: invoice.id, version: invoice.version }], note: 'Paraspalle ricevuti tutti.' })
    expect(bulk).toMatchObject({ approved: 1, refused: 0, results: [{ id: invoice.id, approved: true, status: 'APPROVED' }] })
    G.supplierInvoice2 = await bInvoice(P.finance, invoice.id)
    await settle()
  })

  it('B5.4 P2’s credit note for the 2 damaged protectors arrives; the discrepancy is CREDITED and the buyer settles the claim with it: CLOSED', async () => {
    const line = (G.poSendN.protectors.lines as BJson[])[0]!
    bDeliverFromP2({ number: 'GB-NC-0001', progressive: 'GB003', documentType: 'TD04', relatedInvoices: [{ number: 'GB-2026-0002', date: today() }], lines: [{ description: 'Storno 2 paraspalle danneggiati', quantity: '2', uom: 'PZ', unitPrice: line.unitPrice }] })
    const pickup = await ok(P.finance, 'POST', '/payables/sdi/pickup', { companyId: companyA() })
    expect(pickup.recorded).toEqual([expect.objectContaining({ number: 'GB-NC-0001', matchStatus: 'NO_PO' })])
    let note = await bInvoice(P.buyer, pickup.recorded[0].invoiceId)
    expect(note).toMatchObject({ kind: 'CREDIT_NOTE', docType: 'TD04', creditOf: { id: G.supplierInvoice2.id, number: 'GB-2026-0002' } })
    keep(note.id)
    await settle()
    // The discrepancy's state on record: AGREED (the claim's answer) → CREDITED (the credit note) → CLOSED (with the claim).
    const listed = (await ok(P.warehouse, 'GET', `/inventory/receipts/${G.receiptShort.id}/discrepancies`)).discrepancies as BJson[]
    const damaged = listed.find((row) => row.id === G.discrepancy.id)!
    expect(damaged.status).toBe('AGREED')
    const credited = (await ok(P.warehouse, 'POST', `/inventory/receipts/${G.receiptShort.id}/discrepancies/${damaged.id}/status`, { version: damaged.version, to: 'CREDITED', note: 'Nota di credito GB-NC-0001.' })).discrepancy
    expect(credited.status).toBe('CREDITED')
    const settled = await ok(P.buyer, 'POST', `/payables/invoices/${note.id}/settle-claim`, { version: note.version, claimId: G.claim.id })
    expect(settled.claim).toEqual({ id: G.claim.id, number: G.claim.number, status: 'CLOSED' })
    note = settled.invoice
    G.supplierCreditNote = note
    G.claim = (await ok(P.buyer, 'GET', `/purchasing/claims/${G.claim.id}`)).claim
    expect(G.claim).toMatchObject({ status: 'CLOSED', closeNote: expect.stringContaining('GB-NC-0001') })
    expect(G.claim.lines[0].discrepancy.status).toBe('CLOSED')
    expect(await settle()).toEqual(expect.arrayContaining(['supplier_invoice.claim_settled', 'supplier_claim.closed']))
  })

  // ---- K/X helpers ---------------------------------------------------------------------------------------------------------

  /** A seed id that sorts first (the seeds' `firstId`: eight zeros, then the namespace's uuid). */
  const kxFirst = (key: string) => `00000000${id(key).slice(8)}`
  /** The seeded records the K and X stages use. */
  const kx = () => ({
    lining: id('product:item:lining'),
    grey: id('product:item-colour:lining:GRY'),
    liningLot: id('inventory:lot:LIN-01'),
    bin: id('inventory:location:A1-STORE-01'),
    wo1: id('production:work-order:WO-0001'),
    sew: id('production:WO-0001:operation:20'),
    wo2: kxFirst('production:work-order:WO-0002'),
    p1: id('party:P1'),
    p2: id('party:P2'),
    workshopPlace: id('subcontract:location:A1-TERZ-P2'),
    seedOrder: id('subcontract:SC-0001'),
    octoberDraft: kxFirst('accounting:export:A:2026-10'),
  })
  const kxDec4 = (value: number) => value.toFixed(4)
  const kxPause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  /** What lies of a lot at one location of A1 (not a hide), now or as of an instant. */
  async function kxOnHand(who: Person, lotId: string, locationId: string, asOf?: string): Promise<string> {
    const url = `/inventory/stock?siteId=${siteA1()}&lotId=${lotId}&locationId=${locationId}${asOf ? `&asOf=${encodeURIComponent(asOf)}` : ''}`
    const rows = ((await ok(who, 'GET', url)).rows as Json[]).filter((row) => row.location.id === locationId && row.hide === null)
    return rows.length === 0 ? '0.0000' : (rows[0]!.onHand as string)
  }
  /** The three journals of a month (Intrastat only with an EU sale; the year-end pack only in December). */
  const KX_JOURNALS = ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS'] as const
  /** December is the fiscal year end (company A starts its year in January): a HARD close then needs the year-end inventory. */
  const KX_YEAR_END = today().slice(5, 7) === '12'
  const KX_EXPLAIN: Record<string, string> = {
    PERIOD_ENDED: 'Exported on the day of its documents for the VAT advance; a re-export brings what comes later in the month.',
    SHIPMENTS_INVOICED: 'The open shipments are invoiced in the next run; the accountant has the list.',
    PAYMENTS_PLACED: 'The unplaced transfers are placed against their invoices next month.',
  }

  // ---- K stock every day ------------------------------------------------------------------------------------------------------

  it('K1 the warehouse writes damaged lining off with a reason from the WRITE_OFF list; Other needs its note; the stock now and as it was before', async () => {
    const s = kx()
    // The picker's read (any signed-in session): the active WRITE_OFF reasons in tile order (step 00 ran the worker's start,
    // which gives standard reasons only to a list with no row: the seeded lists stay as they are).
    const { reasons } = await ok(P.warehouse, 'GET', '/reasons?list=WRITE_OFF')
    // The seeded standard list, in its tile order (a code another stage adds goes at the end).
    expect((reasons as Json[]).map((reason) => reason.code).slice(0, 5)).toEqual(['DAMAGED', 'EXPIRED', 'OBSOLETE', 'LOST', 'OTHER'])
    expect((reasons as Json[]).every((reason) => reason.list === 'WRITE_OFF')).toBe(true)
    expect((reasons as Json[]).find((reason) => reason.code === 'OTHER')).toMatchObject({ needsDetail: true })

    const before = await kxOnHand(P.warehouse, s.liningLot, s.bin)
    expect(Number(before)).toBeGreaterThan(20)
    const line = { lotId: s.liningLot, fromLocationId: s.bin, quantity: '1.5' }
    // REFUSAL: "Other" asks for words.
    const other = await ok(P.warehouse, 'POST', '/inventory/write-offs', { siteId: siteA1(), reasonCode: 'OTHER', lines: [line] }, 400)
    expect((other.error.issues as Json[]).map((issue) => issue.path)).toEqual(['body/note'])

    const asOf = toUtcIso(new Date())
    await kxPause(20)
    const { writeOff, overReserved } = await ok(P.warehouse, 'POST', '/inventory/write-offs', { siteId: siteA1(), reasonCode: 'DAMAGED', note: 'Water stain on the end of the roll', reference: 'GF-K1', lines: [line] }, 201)
    expect(writeOff).toMatchObject({ siteId: siteA1(), reasonCode: 'DAMAGED', reasonLabel: 'Damaged', note: 'Water stain on the end of the roll', reference: 'GF-K1', hideIds: [] })
    expect((writeOff.moves as Json[]).map((move) => [move.reason, move.lotId, move.fromLocationId, move.toLocationId, move.baseQuantity, move.note])).toEqual([
      ['SCRAP', s.liningLot, s.bin, null, '1.5000', 'DAMAGED: Water stain on the end of the roll'],
    ])
    // The warehouse has no cost grain: the value leaving stock is not in its answer.
    expect(writeOff).not.toHaveProperty('values')
    expect(overReserved).toEqual([])
    G.writeOff = writeOff
    keep(writeOff.id)

    const record = (await ok(P.warehouse, 'GET', `/inventory/write-offs/${writeOff.id}`)).writeOff
    expect(record).toMatchObject({ reasonCode: 'DAMAGED', reasonLabel: { en: 'Damaged', it: 'Danneggiato' }, photos: [] })
    expect(record.moves).toEqual([expect.objectContaining({ quantity: '1.5000', from: expect.objectContaining({ code: 'A1-STORE-01' }), reversedById: null })])
    const ledger = await ok(P.warehouse, 'GET', `/inventory/ledger?siteId=${siteA1()}&writeOffs=true`)
    expect((ledger.moves as Json[]).some((move) => move.writeOff?.id === writeOff.id && move.writeOff.reasonCode === 'DAMAGED')).toBe(true)

    // The stock now, and as it was just before (SCM-197).
    expect(await kxOnHand(P.warehouse, s.liningLot, s.bin)).toBe(kxDec4(Number(before) - 1.5))
    expect(await kxOnHand(P.warehouse, s.liningLot, s.bin, asOf)).toBe(before)
    await settle()
  })

  it('K2 the warehouse reserves lining for the draft work order SEED-WO-0002, sees it held, and releases it with the reason', async () => {
    const s = kx()
    const availability = async () => ((await ok(P.warehouse, 'GET', `/inventory/reservations/availability?siteId=${siteA1()}&itemId=${s.lining}&itemColourId=${s.grey}`)).lots as Json[]).find((lot) => lot.lot.id === s.liningLot)!
    const before = await availability()
    const { reservations } = await ok(P.warehouse, 'POST', '/inventory/reservations', { siteId: siteA1(), workOrderId: s.wo2, note: 'Lining for the second work order', lines: [{ lotId: s.liningLot, quantity: '1.8' }] }, 201)
    expect(reservations).toEqual([expect.objectContaining({ status: 'ACTIVE', quantity: '1.8000', open: '1.8000', lot: expect.objectContaining({ id: s.liningLot }), demand: expect.objectContaining({ type: 'WorkOrder', id: s.wo2, number: 'SEED-WO-0002' }), stale: false })])
    const held = await availability()
    expect(Number(held.reserved)).toBeCloseTo(Number(before.reserved) + 1.8, 4)
    expect(Number(held.available)).toBeCloseTo(Number(before.available) - 1.8, 4)

    const released = await ok(P.warehouse, 'POST', '/inventory/reservations/release', { reservations: [{ id: reservations[0].id, version: reservations[0].version }], reason: 'The work order takes the next roll.' })
    expect(released.reservations).toEqual([expect.objectContaining({ id: reservations[0].id, status: 'RELEASED', releaseReason: 'The work order takes the next roll.', open: '0.0000' })])
    expect((await availability()).reserved).toBe(before.reserved)
    G.reservation = released.reservations[0]
    keep(reservations[0].id, s.wo2)
    await settle()
  })

  it('K3 a count of the lining roll is refused while SEED-CNT-0001 holds it; the warehouse cancels the seeded count and starts its own', async () => {
    const s = kx()
    const scope = { siteId: siteA1(), kind: 'CYCLE', itemId: s.lining, lotId: s.liningLot, countTeam: 'Magazzino A1', note: 'The lining roll after the write-off.', start: true }
    // REFUSAL: one stock key is in one open count at a time.
    const held = await ok(P.warehouse, 'POST', '/inventory/stock-counts', scope, 409)
    expect(held.error.issues).toEqual([{ path: 'problem/HELD_BY_OTHER_COUNT', message: expect.stringContaining('SEED-CNT-0001') }])

    const { counts } = await ok(P.warehouse, 'GET', `/inventory/stock-counts?siteId=${siteA1()}&q=SEED-CNT-0001`)
    const seeded = (counts as Json[]).find((count) => count.number === 'SEED-CNT-0001')!
    expect(seeded).toMatchObject({ status: 'COUNTING', scope: { location: expect.objectContaining({ code: 'A1-STORE' }) } })
    const cancelled = await ok(P.warehouse, 'POST', `/inventory/stock-counts/${seeded.id}/cancel`, { version: seeded.version, reason: 'Replaced by a count of the lining roll.' })
    expect(cancelled.count).toMatchObject({ status: 'CANCELLED', cancelReason: 'Replaced by a count of the lining roll.' })

    const { count } = await ok(P.warehouse, 'POST', '/inventory/stock-counts', scope, 201)
    expect(count).toMatchObject({ kind: 'CYCLE', status: 'COUNTING', number: expect.stringMatching(/^CNT-\d{4}-\d{4}$/), scope: { item: expect.objectContaining({ id: s.lining }), lot: expect.objectContaining({ id: s.liningLot }) } })
    expect(count.lines.all).toBeGreaterThanOrEqual(1)
    G.count = count
    keep(count.id)
    await settle()
  })

  it('K4 the counter finds 0.5 m less on the shelf; submit says the difference needs a reason; reasoned, it is submitted under the approval limit', async () => {
    const s = kx()
    const { lines } = await ok(P.warehouse, 'GET', `/inventory/stock-counts/${G.count.id}/lines`)
    const shelf = (lines as Json[]).find((line) => line.location.id === s.bin && line.lot?.id === s.liningLot && line.hide === null)!
    expect(shelf).toMatchObject({ origin: 'SNAPSHOT', status: 'UNCOUNTED', expected: await kxOnHand(P.warehouse, s.liningLot, s.bin) })
    const counted = kxDec4(Number(shelf.expected) - 0.5)
    // Every other line of the lot (if an earlier stage moved some elsewhere at A1) is found as expected.
    const typed = await ok(P.warehouse, 'POST', `/inventory/stock-counts/${G.count.id}/lines/record`, {
      lines: (lines as Json[]).map((line) => ({ lineId: line.id, version: line.version, counted: line.id === shelf.id ? counted : line.expected })),
    })
    const mine = (typed.lines as Json[]).find((line) => line.id === shelf.id)!
    expect(mine).toMatchObject({ status: 'COUNTED', counted, countedByYou: true, move: { id: null, direction: 'OUT', baseQuantity: '0.5000' } })
    expect(Number(mine.difference)).toBe(-0.5)

    // REFUSAL: a difference without a reason is not submitted (the line version does not move the count's version).
    const unreasoned = await ok(P.warehouse, 'POST', `/inventory/stock-counts/${G.count.id}/submit`, { version: G.count.version }, 409)
    expect(unreasoned.error.issues).toEqual([{ path: 'problem/NO_REASON', message: expect.stringContaining('pick one from the adjustment reasons') }])

    const { reasons } = await ok(P.warehouse, 'GET', '/inventory/stock-counts/reasons')
    expect((reasons as Json[]).map((reason) => reason.code)).toContain('COUNT_ERROR')
    await ok(P.warehouse, 'POST', `/inventory/stock-counts/${G.count.id}/lines/record`, { lines: [{ lineId: shelf.id, version: mine.version, reasonCode: 'COUNT_ERROR', reasonNote: 'The end of the roll was measured short.' }] })
    const submitted = (await ok(P.warehouse, 'POST', `/inventory/stock-counts/${G.count.id}/submit`, { version: G.count.version })).count
    // 0.5 m at the lot's cost is far under the 500 EUR limit: no second person is needed (the apply approves it).
    expect(submitted).toMatchObject({ status: 'SUBMITTED', approvalRequired: false, lines: expect.objectContaining({ differing: 1 }) })
    expect(submitted.approval).toMatchObject({ required: false })
    expect(submitted.actions.apply).toEqual({ allowed: true, reason: null })
    // The warehouse has no cost grain: what the difference is worth is not in its answer.
    expect(submitted).not.toHaveProperty('differenceAmount')
    G.count = submitted
    G.countLine = { id: shelf.id, expected: shelf.expected }
    await settle()
  })

  it('K5 the difference is applied: one COUNT move out of the shelf, dated at the snapshot and named in the ledger; the on-hand changed', async () => {
    const s = kx()
    const applied = await ok(P.warehouse, 'POST', `/inventory/stock-counts/${G.count.id}/apply`, { version: G.count.version })
    expect(applied.count).toMatchObject({ status: 'APPLIED', appliedAt: expect.any(String) })
    // Under the limit the apply approves it in the same command, by the same person.
    expect(applied.count.people.approvedBy).toEqual(expect.any(String))
    expect(applied.count.people.approvedBy).toBe(applied.count.people.appliedBy)
    expect(applied.moves).toEqual([expect.objectContaining({ lineId: G.countLine.id, direction: 'OUT', baseQuantity: '0.5000' })])
    expect(await kxOnHand(P.warehouse, s.liningLot, s.bin)).toBe(kxDec4(Number(G.countLine.expected) - 0.5))
    const ledger = await ok(P.warehouse, 'GET', `/inventory/ledger?siteId=${siteA1()}&q=${encodeURIComponent(applied.count.number)}`)
    expect((ledger.moves as Json[]).map((move) => [move.id, move.reason, move.reference])).toEqual([[applied.moves[0].id, 'COUNT', applied.count.number]])
    // A done count cannot be cancelled any more.
    const late = await ok(P.warehouse, 'POST', `/inventory/stock-counts/${G.count.id}/cancel`, { version: applied.count.version, reason: 'Too late.' }, 409)
    expect(late.error.issues[0].path).toBe('problem/NOT_CANCELLABLE')
    G.count = applied.count
    done(applied.count.id)
    await settle()
  })

  it('K6 the buyer cannot send the sewing out while SEED-SC-0001 holds its 7 pieces; cancels the seeded draft, orders it from P2 with the lining kit and sends the order', async () => {
    const s = kx()
    const outside = await ok(P.buyer, 'GET', `/purchasing/subcontracting/work-orders/${s.wo1}/outside-operations`)
    expect((outside.operations as Json[]).find((operation) => operation.id === s.sew)).toMatchObject({ ordered: 7 })
    const back = addDays(today(), 10)
    // The sewing is an in-house step of the routing: the order names the workshop and its fee (the buyer has the cost grain).
    const body = { workOrderId: s.wo1, partyId: s.p2, expectedBackDate: back, note: 'Sew and assemble the 7 jackets; the lining comes with the kit.', operations: [{ workOrderOperationId: s.sew, pricePerPiece: '4.50', expectedBackDate: back }] }
    // REFUSAL: the pieces of an operation are on one live order at a time.
    const held = await ok(P.buyer, 'POST', '/purchasing/subcontracting/orders', body, 400)
    expect(held.error.issues[0]).toMatchObject({ path: 'body/operations/0/pieces', message: expect.stringContaining('7 piece(s) of operation') })

    const seeded = (await ok(P.buyer, 'GET', `/purchasing/subcontracting/orders/${s.seedOrder}`)).order
    expect(seeded).toMatchObject({ number: 'SEED-SC-0001', status: 'DRAFT' })
    const cancelled = (await ok(P.buyer, 'POST', `/purchasing/subcontracting/orders/${s.seedOrder}/cancel`, { version: seeded.version, reason: 'Ordered again from today’s plan' })).order
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Ordered again from today’s plan', kit: expect.objectContaining({ state: 'NONE', cancelled: 1 }) })

    let order = (await ok(P.buyer, 'POST', '/purchasing/subcontracting/orders', body, 201)).order
    expect(order).toMatchObject({
      status: 'DRAFT',
      number: expect.stringMatching(/^SC-\d{4}-\d{4}$/),
      workshop: expect.objectContaining({ id: s.p2 }),
      location: expect.objectContaining({ id: s.workshopPlace, code: 'A1-TERZ-P2' }),
      currency: 'EUR',
      netAmount: 3150,
      expectedBackDate: back,
      pieces: expect.objectContaining({ ordered: 7, sent: 0 }),
    })
    expect(order.operations).toEqual([expect.objectContaining({ seq: 10, pieces: 7, pricePerPiece: '4.500000', netAmount: 3150 })])
    order = (await ok(P.buyer, 'POST', `/purchasing/subcontracting/orders/${order.id}/kit`, { version: order.version, lines: [{ itemId: s.lining, itemColourId: s.grey, lotId: s.liningLot, quantity: '12.6', uom: 'M', note: 'Body lining for the 7 jackets.' }] }, 201)).order
    expect(order.kitLines).toEqual([expect.objectContaining({ status: 'PLANNED', lot: expect.objectContaining({ id: s.liningLot }), baseQuantity: '12.6000' })])
    expect(order.kit).toMatchObject({ state: 'TO_SEND' })
    order = (await ok(P.buyer, 'POST', `/purchasing/subcontracting/orders/${order.id}/issue`, { version: order.version })).order
    expect(order).toMatchObject({ status: 'ISSUED', issuedAt: expect.any(String), actions: expect.objectContaining({ send: null }) })
    G.subcontract = order
    keep(order.id, s.wo1)
    await settle()
  })

  it('K7 the warehouse sends the kit with its DDT for work on our behalf: the lining moves into the workshop’s place, one live DDT on the kit line; the line cannot come back while that DDT is live', async () => {
    const s = kx()
    let order = G.subcontract
    const line = order.kitLines[0]
    const before = await kxOnHand(P.warehouse, s.liningLot, s.bin)
    const sent = await ok(
      P.warehouse,
      'POST',
      `/purchasing/subcontracting/orders/${order.id}/kit/send`,
      {
        version: order.version,
        lines: [{ lineId: line.id, fromLocationId: s.bin }],
        pieces: [{ operationId: order.operations[0].id, pieces: 7 }],
        bundles: [],
        ddt: { transportBy: 'SENDER', packages: 1, grossWeightKg: '6.5', appearance: 'Scatola di cartone', remarks: 'Fodera per 7 giacche, in conto lavorazione.' },
      },
      201,
    )
    order = sent.order
    expect(order).toMatchObject({ status: 'AT_WORKSHOP', pieces: expect.objectContaining({ sent: 7, atWorkshop: 7 }), kit: expect.objectContaining({ state: 'SENT' }) })
    // The warehouse sees no fee.
    expect(order).not.toHaveProperty('netAmount')
    expect(sent.moveIds).toHaveLength(1)
    expect(sent.ddt).toMatchObject({ number: expect.stringMatching(/^\d+\/\d{4}$/), pdfProblem: null, file: expect.objectContaining({ id: expect.any(String) }) })
    expect(order.kitLines).toEqual([expect.objectContaining({ id: line.id, status: 'SENT', lot: expect.objectContaining({ id: s.liningLot }), moveId: sent.moveIds[0], ddt: expect.objectContaining({ id: sent.ddt.id, cancelled: false }) })])
    expect(order.ddts).toEqual([expect.objectContaining({ id: sent.ddt.id, number: sent.ddt.number, cancelled: false, kitLineIds: [line.id] })])
    // REFUSAL: a line that left with a live DDT does not come back by "never left".
    const back = await ok(P.warehouse, 'POST', `/purchasing/subcontracting/orders/${order.id}/kit/${line.id}/return`, { version: order.version, reason: 'Never left' }, 409)
    expect(back.error.message).toContain('Cancel the DDT first')

    expect(await kxOnHand(P.warehouse, s.liningLot, s.bin)).toBe(kxDec4(Number(before) - 12.6))
    const atWorkshop = await ok(P.warehouse, 'GET', `/purchasing/subcontracting/stock?partyId=${s.p2}`)
    expect(atWorkshop.rows).toEqual([expect.objectContaining({ location: expect.objectContaining({ id: s.workshopPlace }), lot: expect.objectContaining({ id: s.liningLot }), onHand: '12.6000' })])
    expect(atWorkshop.rows[0]).not.toHaveProperty('value')
    G.subcontract = order
    G.kitDdt = sent.ddt
    keep(sent.ddt.id)
    await settle()
  })

  it('K8 the jackets come back: 6 good, 1 with an open seam, 2 m of lining unused back on the shelf; the workshop’s fee is on the work order; the buyer closes the order', async () => {
    const s = kx()
    let order = G.subcontract
    const before = await kxOnHand(P.warehouse, s.liningLot, s.bin)
    const answer = await ok(
      P.warehouse,
      'POST',
      `/purchasing/subcontracting/orders/${order.id}/receive`,
      {
        version: order.version,
        lines: [{ operationId: order.operations[0].id, good: 6, defective: 1, scrapped: 0, reason: 'Seam open on one jacket' }],
        returns: [{ itemId: s.lining, itemColourId: s.grey, lotId: s.liningLot, quantity: '2', toLocationId: s.bin }],
        supplierDdt: { number: 'P2-GF-0001', date: today() },
        note: 'Back from P2 with its delivery note.',
      },
      201,
    )
    order = answer.order
    expect(order).toMatchObject({ status: 'RECEIVED', pieces: expect.objectContaining({ sent: 7, backGood: 6, backDefective: 1, atWorkshop: 0 }) })
    expect(answer.receipt).toMatchObject({
      supplierDdt: expect.objectContaining({ number: 'P2-GF-0001' }),
      lines: [expect.objectContaining({ good: 6, defective: 1, reason: 'Seam open on one jacket' })],
      returns: [expect.objectContaining({ quantity: '2', toLocation: expect.objectContaining({ id: s.bin }) })],
    })
    // The fee (6 good × 4.50) is posted on SEED-WO-0001's cost ledger in the same command (B-W2a-25; payables posts none, B-W2a-62).
    expect(answer.ledger).toEqual({ posted: 1, waiting: [] })
    expect(await kxOnHand(P.warehouse, s.liningLot, s.bin)).toBe(kxDec4(Number(before) + 2))
    // What the workshop sewed into the jackets stays our stock at its place: the material balance (consumption) is W2b.
    const atWorkshop = await ok(P.warehouse, 'GET', `/purchasing/subcontracting/stock?partyId=${s.p2}`)
    expect(atWorkshop.rows).toEqual([expect.objectContaining({ lot: expect.objectContaining({ id: s.liningLot }), onHand: '10.6000' })])

    order = (await ok(P.buyer, 'POST', `/purchasing/subcontracting/orders/${order.id}/close`, { version: order.version, note: 'All back; one jacket to repair in house.' })).order
    expect(order.status).toBe('CLOSED')
    const record = (await ok(P.warehouse, 'GET', `/purchasing/subcontracting/orders/${order.id}`)).order
    expect(record.receipts).toHaveLength(1)
    G.subcontract = order
    done(order.id)
    await settle()
  })

  it('K9 finance reads the lining’s value at A1 and the workshop’s fee on the work order; the production manager sees the same quantities and never a cost', async () => {
    const s = kx()
    const valuation = `/costing/valuation?siteId=${siteA1()}&lotId=${s.liningLot}`
    const priced = await ok(P.finance, 'GET', valuation)
    const row = (priced.rows as Json[]).find((entry) => entry.lot?.id === s.liningLot)!
    expect(row).toMatchObject({ item: expect.objectContaining({ id: s.lining }), currency: 'EUR', valued: 'FULL' })
    expect(row.value).toBeGreaterThan(0)
    // For X: stock moves without a value hold a HARD close (STOCK_NOT_VALUED); kept to explain a refusal there.
    G.unvaluedMoves = priced.unvaluedMoves
    const blind = await ok(P.manager, 'GET', valuation)
    const seen = (blind.rows as Json[]).find((entry) => entry.lot?.id === s.liningLot)!
    expect(seen.quantity).toBe(row.quantity)
    expect(seen).not.toHaveProperty('value')
    expect(seen).not.toHaveProperty('unitCost')
    expect(blind).not.toHaveProperty('value')

    const fee = `/costing/ledger?workOrderId=${s.wo1}&kind=SUBCONTRACT`
    const entries = (await ok(P.finance, 'GET', fee)).entries as Json[]
    expect(entries.length).toBeGreaterThanOrEqual(1)
    expect(entries.reduce((sum, entry) => sum + entry.amount, 0)).toBe(6 * 450)
    const hidden = (await ok(P.manager, 'GET', fee)).entries as Json[]
    expect(hidden).toHaveLength(entries.length)
    expect(hidden[0]).not.toHaveProperty('amount')
  })

  // ---- H: plant, planning and the shared daily tools ---------------------------------------------------------------------

  /** The seeds' ids this group reads (packages/factory-db/seed/*.ts). */
  const H = {
    leather: () => id('product:item:leather'),
    leatherRed: () => id('product:item-colour:leather:RED'),
    protectorPlanning: () => id('planning:item:A1:protector'),
    protector: () => id('product:item:protector'),
    line: () => id('site:A1:line:L1'),
    lineCalendar: () => id('calendar:line:A1:L1'),
    wo1: () => id('production:work-order:WO-0001'),
    /** The seeded WORKING plan's sewing bar of SEED-WO-0001 on L1 (seed/schedule.ts: 17 Nov 2026 09:00-17:00Z). */
    workingSewSlot: () => id('schedule:slot:A1:working:sew'),
    pressRequest: () => id('plant:request:CP-01:guard'),
    /** seed/holds.ts: the ACTIVE hold of SEED-HIDE-0002 is a "first" id (eight zeros, then the namespace's uuid). */
    seededHold: () => `00000000${id('holds:hold:HIDE-0002').slice(8)}`,
    jacket: () => id('product:style:JKT-01'),
    jacketCertificate: () => id('compliance:certificate:JKT-01'),
    jacketLabel: () => id('compliance:label:JKT-01:1'),
  }
  const TECHNICIAN_PIN = '825914'
  /** The same operator signs on the sewing tablet again (a floor session ends after 10 idle minutes of the harness clock). */
  const sewingAgain = async () => ok(G.tablets.SEWING as Browser, 'POST', '/floor/sign-in', { badgeCode: G.workers.SEWING.badgeCode, pin: G.pins.SEWING })
  const l1Cell = (answer: Json, key: string): Json | undefined => (answer.lanes as Json[]).find((lane) => lane.kind === 'LINE' && lane.id === H.line())?.cells.find((cell: Json) => cell.key === key)
  const capacityOn = (from: string, to: string = from) => ok(P.planner, 'GET', `/planning/capacity?siteId=${siteA1()}&from=${from}&to=${to}&bucket=DAY`)
  /** The L1 working day `days` working days after today (THE calendars service: L1's two shifts, the company holidays). */
  const l1WorkingDay = async (days: number): Promise<string> => (await ok(P.planner, 'GET', `/calendars/next-working-day?lineId=${H.line()}&after=${today()}&days=${days}`)).date as string

  // ---- H01-H04 planning every day ------------------------------------------------------------------------------------------

  it('H01 the planner runs the daily plan for A1: the seeds’ firm red order rides on it; the planner makes the red leather line firm', async () => {
    const { run } = await ok(P.planner, 'POST', '/planning/runs', { siteId: siteA1(), note: 'Golden daily plan' }, 201)
    expect(run).toMatchObject({ status: 'DONE', siteId: siteA1() })
    G.planRun = run
    keep(run.id)
    const plan = await ok(P.planner, 'GET', `/planning/runs/latest?siteId=${siteA1()}&itemId=${H.leather()}`)
    expect(plan.run.id).toBe(run.id)
    const red = (plan.lines as Json[]).find((line) => line.colour?.id === H.leatherRed())
    expect(red, 'the run has a red leather line (the seeded firm order, or the open orders’ need)').toBeDefined()
    // B-W2a-22: the seeds' run 1 has a firm red order (4 hides by 16 Nov 2026) and every new run carries it.
    expect(red!.firm).toMatchObject({ quantity: '4.0000', uom: 'HIDE', carried: true })
    // The planner makes the line firm at 4 of its unit three weeks from today (from the site's today: never in the past).
    const firmDate = addDays(today(), 21)
    const { line } = await ok(P.planner, 'POST', `/planning/requirements/${red!.id}/firm`, { version: red!.version, quantity: '4', date: firmDate })
    expect(line.firm).toMatchObject({ quantity: '4.0000', date: firmDate })
    expect(line.version).toBe(red!.version + 1)
    G.firmLine = line
    await settle()
  })

  it('H02 the next run carries the firm order; the planner acknowledges an exception of the run (twice is refused in words) and makes the line planned again', async () => {
    const { run } = await ok(P.planner, 'POST', '/planning/runs', { siteId: siteA1(), note: 'Golden daily plan, after the firm order' }, 201)
    expect(run.status).toBe('DONE')
    const plan = await ok(P.planner, 'GET', `/planning/runs/latest?siteId=${siteA1()}&itemId=${H.leather()}`)
    const red = (plan.lines as Json[]).find((line) => line.colour?.id === H.leatherRed())!
    expect(red.id).not.toBe(G.firmLine.id)
    expect(red.firm).toMatchObject({ quantity: '4.0000', date: G.firmLine.firm.date, carried: true })
    expect(plan.summary.firm).toBeGreaterThanOrEqual(1)
    // The run's exception list (PLN-193): the planner takes a NEW one (it becomes theirs).
    const list = await ok(P.planner, 'GET', `/planning/exceptions?siteId=${siteA1()}`)
    expect(list.latestRun.id).toBe(run.id)
    const fresh = (list.exceptions as Json[]).find((row) => row.status === 'NEW')
    expect(fresh, `a NEW exception in ${JSON.stringify((list.exceptions as Json[]).map((row) => [row.kind, row.status]))}`).toBeDefined()
    const acknowledged = await ok(P.planner, 'POST', '/planning/exceptions/acknowledge', { exceptions: [{ id: fresh!.id, version: fresh!.version }] })
    expect(acknowledged.exceptions[0]).toMatchObject({ id: fresh!.id, status: 'ACKNOWLEDGED', mine: true, owner: { id: P.planner.id } })
    // Refusal in words: an exception is acknowledged once.
    const twice = await ok(P.planner, 'POST', '/planning/exceptions/acknowledge', { exceptions: [{ id: fresh!.id, version: acknowledged.exceptions[0].version }] }, 409)
    expect(twice.error.message).toBe('The exception is acknowledged already.')
    // The firm order was a planner's what-if: made planned again, the next run plans the line freely.
    const { line } = await ok(P.planner, 'POST', `/planning/requirements/${red.id}/unfirm`, { version: red.version })
    expect(line.firm).toBeNull()
    await settle()
  })

  it('H03 the buyer raises the protectors’ reorder point at A1; a second row for the same item is refused in words; the reorder rules list it', async () => {
    const { parameters } = await ok(P.buyer, 'GET', `/planning/item-parameters/${H.protectorPlanning()}`)
    // seed/planning.ts: REORDER_POINT 24, lot 48, safety stock 12 (B-W2a-16).
    expect(parameters).toMatchObject({ method: 'REORDER_POINT', siteId: siteA1() })
    const changed = await ok(P.buyer, 'PATCH', `/planning/item-parameters/${H.protectorPlanning()}`, { version: parameters.version, reorderPoint: '36' })
    expect(Number(changed.parameters.reorderPoint)).toBe(36)
    expect(changed.parameters.version).toBe(parameters.version + 1)
    const again = await ok(P.buyer, 'POST', '/planning/item-parameters', { siteId: siteA1(), itemId: H.protector(), method: 'ORDERS' }, 409)
    expect(again.error.message).toMatch(/SEED-PRO-300|protector|already/i)
    const rules = await ok(P.buyer, 'GET', `/planning/reorder-rules?siteId=${siteA1()}`)
    expect((rules.rules as Json[]).find((rule) => rule.id === H.protectorPlanning())).toMatchObject({ method: 'REORDER_POINT' })
    await settle()
  })

  it('H04 capacity per line: the seeded week’s L1 load; a closed day on L1’s calendar takes its minutes away at once, and given back', async () => {
    // B-W2a-16: L1 on 17 Nov 2026 = 8 people × 930 min × 85 % = 6,324 min, booked 675.5 by SEED-WO-0001's sewing bar
    // (7 × 96.5 min). Holds while that day is not past (runs until 2026-11-16) and nobody moved the bar or scanned WO-0001.
    if (today() <= '2026-11-16') {
      const seeded = await capacityOn('2026-11-16', '2026-11-20')
      expect(l1Cell(seeded, '2026-11-17')).toMatchObject({ availableMinutes: '6324.0', bookedMinutes: '675.5', loadPct: '10.7', words: '8 people × 930 min × 85% efficiency × 1 day = 6,324 min.' })
    }
    // A closed day (B-W2a-08): the planner closes L1 on a working day ten working days out; capacity follows on the next read.
    const day = await l1WorkingDay(10)
    const before = l1Cell(await capacityOn(day), day)!
    expect(before.workingDays).toBe(1)
    expect(Number(before.availableMinutes)).toBeGreaterThan(0)
    await ok(P.planner, 'POST', `/calendars/${H.lineCalendar()}/days`, { from: day, kind: 'CLOSURE', name: 'Golden flow: line moved to the new hall', note: 'One day only' })
    const closed = l1Cell(await capacityOn(day), day)!
    expect(closed).toMatchObject({ workingDays: 0, availableMinutes: '0.0' })
    expect(closed.closedDays).toEqual([expect.objectContaining({ date: day, reason: 'CLOSURE' })])
    const removed = await ok(P.planner, 'POST', `/calendars/${H.lineCalendar()}/days/remove`, { from: day })
    expect(removed.removed).toEqual([day])
    expect(l1Cell(await capacityOn(day), day)!.availableMinutes).toBe(before.availableMinutes)
    await settle()
  })

  // ---- H05 schedule and publish (Owner answer P3) -------------------------------------------------------------------------

  it('H05 the planner moves the seeded sewing bar in the working plan: the floor sees nothing until Publish; then the line and the sewing tablet do', async () => {
    // Date-relative: the bar moves to L1's fifth working day from today, 08:30Z (in L1's first shift, 06:00-14:00 Rome,
    // summer or winter time; never v1's 08:00Z, so a run in the seeded week cannot mistake v1's bar for the move), and the
    // version published covers that one day from now.
    const day = await l1WorkingDay(5)
    const startAt = `${day}T08:30:00.000Z`
    const popover = await ok(P.planner, 'GET', `/planning/schedule/work-orders/${H.wo1()}`)
    const slot = (popover.slots as Json[]).find((entry) => entry.id === H.workingSewSlot())
    expect(slot, 'the seeded working sewing bar of SEED-WO-0001').toBeDefined()
    const moved = await ok(P.planner, 'PATCH', `/planning/schedule/slots/${slot!.id}`, { version: slot!.version, startAt })
    expect(moved.slot).toMatchObject({ id: slot!.id, version: slot!.version + 1, startAt, updatedBy: { id: P.planner.id } })
    G.slot = moved.slot
    const onIt = (answer: Json) => (answer.entries as Json[]).filter((entry) => entry.workOrder.id === H.wo1() && entry.startAt === startAt)
    // Not published yet: neither the office's list of L1 nor the sewing tablet shows the move.
    expect(onIt(await ok(P.planner, 'GET', `/production/dispatch?lineId=${H.line()}`))).toEqual([])
    await sewingAgain()
    const floorBefore = await ok(G.tablets.SEWING as Browser, 'GET', '/production/dispatch/station')
    expect(floorBefore.target).toMatchObject({ kind: 'STATION', code: 'SEW-01', line: { id: H.line() } })
    expect(onIt(floorBefore)).toEqual([])
    // The publish dialog: that one day, from now.
    const preview = await ok(P.planner, 'GET', `/planning/schedule/publish?siteId=${siteA1()}&coversFrom=${day}&coversTo=${day}&effectiveFrom=${encodeURIComponent(new Date().toISOString())}`)
    expect(preview).toMatchObject({ mayPublish: true, heldReason: null, range: { coversFrom: day, coversTo: day } })
    expect(preview.diff.moved + preview.diff.added).toBeGreaterThanOrEqual(1)
    // Refusal: a publish of a working plan older than the one reviewed.
    await ok(P.planner, 'POST', '/planning/schedule/publish', { siteId: siteA1(), version: preview.plan.version - 1, coversFrom: day, coversTo: day }, 409)
    const published = await ok(
      P.planner,
      'POST',
      '/planning/schedule/publish',
      { siteId: siteA1(), version: preview.plan.version, coversFrom: day, coversTo: day, effectiveFrom: new Date().toISOString(), note: 'Golden flow: sewing of SEED-WO-0001 moved.' },
      201,
    )
    expect(published.version).toMatchObject({ coversFrom: day, coversTo: day, publishedBy: { id: P.planner.id } })
    G.publishedPlan = published.version
    keep(published.version.id)
    const office = await ok(P.planner, 'GET', `/production/dispatch?lineId=${H.line()}`)
    expect(office.version.number).toBe(published.version.number)
    expect(onIt(office).map((entry) => entry.operation.code)).toEqual(['SEED-SEW-ASM'])
    const floor = await ok(G.tablets.SEWING as Browser, 'GET', '/production/dispatch/station')
    expect(floor.version.number).toBe(published.version.number)
    expect(onIt(floor).map((entry) => entry.operation.code)).toEqual(['SEED-SEW-ASM'])
    await settle()
  })

  // ---- H06-H09 the machine H1 path (Owner answer H1: anyone marks it unsafe; only a technician signs it safe) --------------

  it('H06 the sewing operator marks the station’s lockstitch unsafe on the tablet: DO_NOT_USE at once, the station blocked; maintenance is told', async () => {
    await sewingAgain()
    const sewing = G.tablets.SEWING as Browser
    const station = await ok(sewing, 'GET', '/plant/floor/machines')
    expect(station.station).toMatchObject({ code: 'SEW-01' })
    const machine = (station.machines as Json[]).find((row) => row.assetNumber === 'SEED-SEW-L1-01')!
    expect(machine).toBeDefined()
    expect(machine.purchaseCost ?? null).toBeNull()
    const guard = (machine.symptoms as Json[]).find((row) => row.code === 'GUARD_MISSING')!
    const sent = await ok(sewing, 'POST', '/plant/requests', { machineId: machine.id, symptomId: guard.id, description: 'The needle guard came off.', down: false }, 201)
    expect(sent).toMatchObject({ replayed: false, machine: { status: 'DO_NOT_USE', locked: true }, request: { unsafe: true, locking: true, status: 'NEW', station: { code: 'SEW-01' }, reportedBy: { kind: 'WORKER', id: null, name: null } } })
    expect(sent.words.message).toBe('Machine SEED-SEW-L1-01 is marked do not use (unsafe): do not work on it.')
    G.machineRequest = sent.request
    G.machine = sent.machine
    keep(sent.request.id)
    expect((await settle())).toEqual(expect.arrayContaining(['maintenance_request.reported', 'machine.status_changed']))
    // The people who triage at A1 are told (an ALERT in the bell); the office queue lists it, naming no worker.
    const told = await ok(P.maintenance, 'GET', '/notifications?tab=SYSTEM')
    expect((told.items as Json[]).find((item) => item.record?.type === 'Machine' && item.record?.id === machine.id)).toMatchObject({ category: 'ALERT' })
    const queue = await ok(P.maintenance, 'GET', '/plant/requests?open=true')
    expect((queue.requests as Json[]).find((entry) => entry.id === sent.request.id)).toMatchObject({ unsafe: true, reportedBy: { kind: 'WORKER', id: null, name: null } })
  })

  it('H07 the supervisor enrols a floor technician and a maintenance tablet; maintenance makes a P1 safety job of the report for them (closing it unsafe is refused in words)', async () => {
    G.technician = await floorWorker(w, P.supervisor, siteA1(), 'Golden technician', id('role:technician'))
    keep(G.technician.id)
    G.maintenanceTablet = await tablet(w, P.supervisor, siteA1(), id('site:A1:station:SEW-02'), 'Golden maintenance tablet')
    await signOn(G.maintenanceTablet, G.technician, TECHNICIAN_PIN)
    // Refusal (H1): the unsafe request is not closed before a technician signs the machine safe.
    const closing = await ok(P.maintenance, 'POST', `/plant/requests/${G.machineRequest.id}/close`, { version: G.machineRequest.version, reason: 'NOT_A_FAULT' }, 409)
    expect(closing.error.issues.map((issue: Json) => issue.path)).toEqual(['refusal/LOCKED_UNSAFE', 'fix'])
    const made = await ok(P.maintenance, 'POST', `/plant/requests/${G.machineRequest.id}/job`, { version: G.machineRequest.version, assigneeWorkerId: G.technician.id }, 201)
    expect(made.request).toMatchObject({ status: 'JOB_MADE', job: { id: made.job.id } })
    expect(made.job).toMatchObject({ status: 'NEW', priority: 'P1', type: 'SAFETY', source: 'REQUEST', number: expect.stringMatching(/^MJ-\d{4}-\d{4}$/), machine: { locked: true }, assignee: { kind: 'WORKER' } })
    G.machineRequest = made.request
    G.machineJob = made.job
    keep(made.job.id)
    await settle()
  })

  it('H08 the technician starts the job on the tablet (hand-back running refused while unsafe), signs it safe with a fresh PIN code, hands it back running; maintenance closes it', async () => {
    const device = G.maintenanceTablet as Browser
    const mine = await ok(device, 'GET', '/plant/floor/jobs')
    expect((mine.jobs as Json[]).find((entry) => entry.id === G.machineJob.id)).toMatchObject({ ownership: 'MINE', assignee: { kind: 'WORKER', id: null, name: null } })
    const started = await ok(device, 'POST', `/plant/jobs/${G.machineJob.id}/start`, { version: G.machineJob.version })
    expect(started).toMatchObject({ job: { status: 'IN_PROGRESS' }, machine: { status: 'DO_NOT_USE', locked: true } })
    // Refusal (H1): never back to running while the unsafe lock stands.
    const early = await ok(device, 'POST', `/plant/jobs/${G.machineJob.id}/hand-back`, { version: started.job.version, workDone: 'Refitted the needle guard.', machineAfter: 'RUNNING' }, 409)
    expect(early.error.issues.map((issue: Json) => issue.path)).toEqual(['refusal/LOCKED_UNSAFE', 'fix'])
    // The signing act on the floor asks the worker's PIN (requireFloorStepUp): the technician types it fresh, then signs.
    await ok(device, 'POST', '/floor/step-up', { pin: TECHNICIAN_PIN })
    const signed = await ok(device, 'POST', `/plant/requests/${G.machineRequest.id}/sign-safe`, { version: G.machineRequest.version, note: 'Guard refitted and tested at speed.' })
    expect(signed).toMatchObject({ request: { locking: false, signedSafe: { by: { kind: 'WORKER', id: null, name: null }, note: 'Guard refitted and tested at speed.' } }, machine: { status: 'UNDER_MAINTENANCE', locked: false } })
    const back = await ok(device, 'POST', `/plant/jobs/${G.machineJob.id}/hand-back`, { version: started.job.version, workDone: 'Replaced a part: needle guard.', machineAfter: 'RUNNING' })
    expect(back).toMatchObject({ job: { status: 'HANDED_BACK', handedBack: { machineAfter: 'RUNNING', by: { kind: 'WORKER' } } }, machine: { status: 'RUNNING' } })
    const closed = await ok(P.maintenance, 'POST', `/plant/jobs/${G.machineJob.id}/close`, { version: back.job.version })
    expect(closed.job).toMatchObject({ status: 'CLOSED', closedBy: { kind: 'USER', id: P.maintenance.id } })
    G.machineJob = closed.job
    // The office record names the technician; the database names who signed.
    const record = await ok(P.maintenance, 'GET', `/plant/jobs/${G.machineJob.id}`)
    expect(record.job.handedBack.by).toMatchObject({ kind: 'WORKER', id: G.technician.id, name: 'Golden technician' })
    expect(await admin(w, 'SELECT "signedSafeByWorkerId"::text AS by FROM "MaintenanceRequest" WHERE id = $1', [G.machineRequest.id])).toEqual([{ by: G.technician.id }])
    await settle()
  })

  it('H09 the seeded clicking press (locked, PLANNED job SEED-MJ-0001) is signed safe in the office by maintenance with a fresh code; the supervisor may not', async () => {
    const { request } = await ok(P.maintenance, 'GET', `/plant/requests/${H.pressRequest()}`)
    expect(request).toMatchObject({ unsafe: true, locking: true, status: 'JOB_MADE' })
    // Refusal (H1): the floor supervisor triages but is no technician.
    await ok(P.supervisor, 'POST', `/plant/requests/${H.pressRequest()}/sign-safe`, { version: request.version, note: 'Looks fine.' }, 403)
    await stepped(w, P.maintenance)
    const signed = await ok(P.maintenance, 'POST', `/plant/requests/${H.pressRequest()}/sign-safe`, { version: request.version, note: 'Guard checked, two-hand control tested.' })
    expect(signed).toMatchObject({ request: { status: 'JOB_MADE', signedSafe: { by: { kind: 'USER', id: P.maintenance.id } } }, machine: { assetNumber: 'SEED-CP-01', status: 'RUNNING', locked: false } })
    await settle()
  })

  // ---- H10-H11 alerts and timers (B-W2a-33), then SEED-NCR-0002 finished (B-W2a-47) ----------------------------------------

  it('H10 the scheduler’s alert pass finds the seeded hold of SEED-HIDE-0002 too long; the inspector is told, acknowledges it (twice refused) and resolves it', async () => {
    // The cron `alerts.evaluate` (platform/alerts/engine.ts runAlertEvaluation) on a clock 25 h past the hold's placing
    // (seed/holds.ts: 2026-11-21 09:10Z) or past now, whichever is later: the built-in rule (24 h at A1) finds it.
    const at = new Date(Math.max(Date.now(), Date.parse('2026-11-21T09:10:00.000Z')) + 25 * 3_600_000)
    const pass = await runAlertEvaluation({ database: w.h.database, log: QUIET, clock: { now: () => at } })
    expect(pass.failed).toBe(0)
    // The cron `timers.fire` (platform/timers/fire.ts fireDueTimers) on the same clock: the DATE rules' due timers fire.
    expect((await fireDueTimers({ database: w.h.database, log: QUIET, clock: { now: () => at } })).failed).toBe(0)
    await settle()
    const listed = await ok(P.inspector, 'GET', `/alerts?recordType=QualityHold&recordId=${H.seededHold()}`)
    const alert = (listed.items as Json[]).find((item) => item.ruleKind === 'HOLD_TOO_LONG')!
    expect(alert).toMatchObject({ state: 'OPEN', record: { type: 'QualityHold', id: H.seededHold() }, facts: { threshold: 24, subjectType: 'Hide' } })
    expect(alert.record.label).toMatch(/HIDE/)
    // The fan-out told the quality inspectors (the rule's role) in the bell.
    const bell = await ok(P.inspector, 'GET', '/notifications?tab=SYSTEM')
    expect((bell.items as Json[]).find((item) => item.anchor === `alert:${alert.id}`)).toMatchObject({ category: 'ALERT' })
    const acked = (await ok(P.inspector, 'POST', `/alerts/${alert.id}/acknowledge`, { version: alert.version })).alert
    expect(acked).toMatchObject({ state: 'ACKNOWLEDGED', acknowledged: { by: { id: P.inspector.id } } })
    // Refusal in words: acknowledged already.
    const twice = await ok(P.inspector, 'POST', `/alerts/${alert.id}/acknowledge`, { version: acked.version }, 409)
    expect(twice.error.issues.map((issue: Json) => issue.path)).toEqual(['alert/ALREADY_ACKNOWLEDGED'])
    const resolved = (await ok(P.inspector, 'POST', `/alerts/${alert.id}/resolve`, { version: acked.version, note: 'The hide goes to the lab on Monday; NCR SEED-NCR-0002 follows it.' })).alert
    expect(resolved).toMatchObject({ state: 'RESOLVED', resolved: { resolution: 'HANDLED', by: { id: P.inspector.id } } })
    G.alert = resolved
    keep(resolved.id)
    await settle()
  })

  it('H11 after the alert, SEED-NCR-0002 is finished: its seeded scrap of 12 ft² carried out, the other 39.8 ft² back to the supplier with the buyer’s claim, decided and closed (the hide’s seeded hold closes with it)', async () => {
    const ncrId = id('holds:ncr:NCR-0002')
    const seededHold = mSeedFirstId('holds:hold:HIDE-0002')
    const hideH2 = id('inventory:hide:H2')
    const url = `/quality/ncr/${ncrId}`
    const codes = await mDispositions()
    let { record } = await ok(P.inspector, 'GET', url)
    expect(record.ncr).toMatchObject({ number: 'SEED-NCR-0002', stage: 'CONTAINED' })
    ;({ record } = await ok(P.inspector, 'POST', `${url}/decisions`, { version: record.ncr.version, dispositionCodeId: codes.RETURN_TO_SUPPLIER, quantity: '39.8' }, 201))
    // The seeded SCRAP: 12 ft² cut out of the hide, from the rack it lies on (ncr.pg.vitest.test.ts).
    const scrap = (record.decisions as Json[]).find((row) => row.disposition.code === 'SCRAP')!
    ;({ record } = await ok(P.inspector, 'POST', `${url}/decisions/${scrap.id}/carry-out`, { version: scrap.version, stock: { lines: [{ hideId: hideH2, fromLocationId: id('inventory:location:A1-STORE-01'), quantity: '12' }] } }))
    let back = (record.decisions as Json[]).find((row) => row.disposition.code === 'RETURN_TO_SUPPLIER')!
    // Refusal in words: opening the supplier claim is purchasing's (the inspector holds no purchasing.claims.manage).
    const refused = await ok(P.inspector, 'POST', `${url}/decisions/${back.id}/carry-out`, { version: back.version, claim: { kind: 'CLAIM', reasonCode: 'QUALITY', reasonNote: 'Grain crack across the butt' } }, 403)
    expect(refused.error.message).toBe("Opening the supplier claim needs purchasing.claims.manage at the NCR's site.")
    // The buyer opens it from the lot (the rest of the hide), the inspector names it on the decision.
    const { claim } = await ok(
      P.buyer,
      'POST',
      '/purchasing/claims',
      { kind: 'CLAIM', from: { lotId: id('inventory:lot:LEA-01'), hideIds: [hideH2] }, reasonCode: 'QUALITY', reasonNote: 'Grain crack across the butt', internalNote: 'NCR SEED-NCR-0002: Grain crack on hide SEED-HIDE-0002' },
      201,
    )
    expect(claim).toMatchObject({ status: 'DRAFT' })
    G.mSeedClaim = claim
    keep(claim.id)
    ;({ record } = await ok(P.inspector, 'GET', url))
    back = (record.decisions as Json[]).find((row) => row.disposition.code === 'RETURN_TO_SUPPLIER')!
    const answer = await ok(P.inspector, 'POST', `${url}/decisions/${back.id}/carry-out`, { version: back.version, followUp: { type: 'SupplierClaim', id: claim.id } })
    expect(answer.followUp).toMatchObject({ type: 'SupplierClaim', id: claim.id })
    ;({ record } = await ok(P.inspector, 'POST', `${url}/stage`, { version: answer.record.ncr.version, to: 'DECIDED' }))
    expect(record.ncr).toMatchObject({ stage: 'DECIDED', decided: { words: 'All 51.8 FT2 decided' } })
    const closed = await mNcrClose(P.inspector, ncrId, 'Cracked area scrapped, the rest claimed from the tannery.')
    expect(closed.record.ncr.stage).toBe('CLOSED')
    expect(closed.holdsClosed).toEqual([seededHold])
    keep(ncrId)
    done(ncrId, seededHold)
    await settle()
  })

  // ---- H12-H13 followers, mentions, the notification centre, tasks (B-W2a-20) ---------------------------------------------

  it('H12 the production manager follows the work order; the planner’s note mentions the inspector; the fan-out tells both, each in their own tab', async () => {
    const followed = await ok(P.manager, 'PUT', `/threads/WorkOrder/${G.wo.id}/followers/me`, { following: true })
    expect(followed.me).toMatchObject({ following: true, muted: false })
    const posted = await ok(P.planner, 'POST', `/threads/WorkOrder/${G.wo.id}/notes`, { body: 'Inspector, the repaired garment of this order is on the QC rack.', mentions: [P.inspector.id] }, 201)
    G.note = posted.message
    expect(await settle()).toEqual(expect.arrayContaining(['thread.message_posted', 'thread.user_mentioned']))
    // The mentioned person: a MENTION at the message, on the work order.
    const mentions = await ok(P.inspector, 'GET', '/notifications?tab=MENTION')
    const mention = (mentions.items as Json[]).find((item) => item.anchor === `message:${G.note.id}`)!
    expect(mention).toMatchObject({ category: 'MENTION', record: { type: 'WorkOrder', id: G.wo.id }, read: false, state: 'OPEN', actor: { id: P.planner.id } })
    expect(mention.sentence).toMatch(/mentioned you on/)
    // The follower: the record's news (FOLLOWING, in All). The author is told nothing.
    const news = await ok(P.manager, 'GET', '/notifications?tab=ALL')
    expect((news.items as Json[]).find((item) => item.anchor === `message:${G.note.id}`)).toMatchObject({ category: 'FOLLOWING' })
    expect(((await ok(P.planner, 'GET', '/notifications?tab=ALL')).items as Json[]).some((item) => item.anchor === `message:${G.note.id}`)).toBe(false)
    expect(await ok(P.inspector, 'POST', '/notifications/done', { ids: [mention.id] })).toMatchObject({ changed: 1, unknown: [] })
    await settle()
  })

  it('H13 the planner gives the production manager a task on the work order; they are told, finish it, and a stale finish is refused', async () => {
    const made = await ok(
      P.planner,
      'POST',
      '/tasks',
      { title: 'Check the repaired garment before the next lot', record: { type: 'WorkOrder', id: G.wo.id }, assigneeId: P.manager.id, dueDate: today(), checklist: [{ text: 'Look at the seam' }] },
      201,
    )
    expect(made.task).toMatchObject({ status: 'OPEN', assignee: { id: P.manager.id }, record: { type: 'WorkOrder', id: G.wo.id }, relation: 'CREATOR' })
    G.task = made.task
    keep(made.task.id)
    expect(await settle()).toEqual(expect.arrayContaining(['task.created', 'task.assigned']))
    const told = await ok(P.manager, 'GET', '/notifications?tab=ASSIGNMENT')
    expect((told.items as Json[]).find((item) => item.anchor === `task:${G.task.id}`)).toMatchObject({ category: 'ASSIGNMENT' })
    expect(((await ok(P.manager, 'GET', '/tasks')).items as Json[]).map((task) => task.id)).toContain(G.task.id)
    const done = await ok(P.manager, 'POST', `/tasks/${G.task.id}/status`, { version: G.task.version, status: 'DONE' })
    expect(done.task).toMatchObject({ status: 'DONE', closedBy: { id: P.manager.id } })
    // Refusal: the version read before the finish is stale.
    await ok(P.manager, 'POST', `/tasks/${G.task.id}/status`, { version: G.task.version, status: 'OPEN' }, 409)
    G.task = done.task
    await settle()
  })

  // ---- H14-H17 copy a style, its second release and the change-to-approved-type control (B-W2a-09, B-W2a-66) ------------

  it('H14 the production manager copies SEED-JKT-01 into a new draft style with its BOM and routing', async () => {
    const { offer } = await ok(P.manager, 'GET', `/product/styles/${H.jacket()}/duplicate`)
    expect(offer.source).toMatchObject({ id: H.jacket(), code: 'SEED-JKT-01' })
    expect((offer.parts as Json[]).filter((part) => part.available).map((part) => part.part)).toEqual(expect.arrayContaining(['BOM', 'ROUTING']))
    const answer = await ok(P.manager, 'POST', `/product/styles/${H.jacket()}/duplicate`, { code: 'GFD-JKT-02', name: 'Golden daily jacket, summer copy', season: 'SS28', parts: ['BOM', 'ROUTING'], generateSkus: true }, 201)
    expect(answer.style).toMatchObject({ code: 'GFD-JKT-02', status: 'DRAFT', revisionState: 'DRAFT', draftRevision: 1 })
    expect(answer.revision).toMatchObject({ revision: 1, status: 'DRAFT', changeNote: expect.stringMatching(/^Copied from SEED-JKT-01 revision \d+\.$/) })
    expect(answer.copied).toMatchObject({ from: { styleId: H.jacket(), code: 'SEED-JKT-01' }, parts: ['BOM', 'ROUTING'] })
    expect(answer.copied.bomLines).toBeGreaterThan(0)
    G.styleCopy = answer.style
    G.copyRev1 = answer.revision
    keep(answer.style.id, answer.revision.id)
    expect(await settle()).toEqual(expect.arrayContaining(['style.created', 'style.duplicated']))
  })

  it('H15 the inspector covers the copy with the jacket’s certificate; the copy’s first release opens no type-change review', async () => {
    const { certificate } = await ok(P.inspector, 'GET', `/compliance/certificates/${H.jacketCertificate()}`)
    expect(certificate).toMatchObject({ number: 'SEED-CERT-0001', status: 'VALID' })
    await ok(P.inspector, 'POST', `/compliance/certificates/${H.jacketCertificate()}/coverage`, { version: certificate.version, styleId: G.styleCopy.id }, 201)
    const url = `/product/styles/${G.styleCopy.id}/revisions/${G.copyRev1.id}`
    const bom = (await ok(P.manager, 'GET', `${url}/bom`)).bom
    expect(bom.releasable).toBe(true)
    const released = (await ok(P.manager, 'POST', `${url}/release`, { version: bom.revision.version })).bom
    expect(released.revision.status).toBe('RELEASED')
    // B-W2a-66: "the first release changes nothing".
    expect((await ok(P.inspector, 'GET', `/compliance/type-changes?styleId=${G.styleCopy.id}&state=ALL`)).reviews).toEqual([])
    await settle()
  })

  it('H16 a second revision of the copy adds a seam thread: its release opens a type-change review and the garment label refuses the class label', async () => {
    // A new sewing thread in the materials library (the production manager keeps materials; no cost sent: no cost grain).
    const { material } = await ok(P.manager, 'POST', '/product/materials', { code: 'GFD-THR-40', name: 'Golden bonded thread 40', kind: 'THREAD', baseUom: 'M' }, 201)
    G.thread = material
    keep(material.id)
    const rev2 = (await ok(P.manager, 'POST', `/product/styles/${G.styleCopy.id}/revisions/${G.copyRev1.id}/copy`, {}, 201)).bom
    G.copyRev2 = rev2.revision
    keep(rev2.revision.id)
    const url = `/product/styles/${G.styleCopy.id}/revisions/${G.copyRev2.id}`
    await ok(P.manager, 'POST', `${url}/bom/lines`, { version: rev2.revision.version, itemId: material.id, placement: 'Main seams', uom: 'M', qty: '12' }, 201)
    const bom = (await ok(P.manager, 'GET', `${url}/bom`)).bom
    expect((await ok(P.manager, 'POST', `${url}/release`, { version: bom.revision.version })).bom.revision.status).toBe('RELEASED')
    expect(await settle()).toEqual(expect.arrayContaining(['style.revision_released', 'compliance.type_change_found']))
    const waiting = await ok(P.inspector, 'GET', `/compliance/type-changes?styleId=${G.styleCopy.id}&state=WAITING`)
    expect((waiting.reviews as Json[]).map((entry) => [entry.revision.revision, entry.status, entry.holdsLabel])).toEqual([[2, 'OPEN', true]])
    G.typeChangeReview = waiting.reviews[0]
    keep(G.typeChangeReview.id)
    const review = (await ok(P.inspector, 'GET', `/compliance/type-changes/${G.typeChangeReview.id}`)).review
    expect(review.changes).toEqual([expect.objectContaining({ kind: 'SEAMS', after: expect.stringContaining('GFD-THR-40') })])
    // The garment label of revision 2 (the label preview: the same cell the floor's label print reads) holds the class label.
    const preview = await ok(P.inspector, 'GET', `/compliance/labels/${H.jacketLabel()}/preview?styleRevisionId=${G.copyRev2.id}&size=52`)
    expect(preview.cell).toMatchObject({ styleId: G.styleCopy.id, revision: 2, certificate: { outcome: 'refused', number: 'SEED-CERT-0001' } })
    expect(preview.cell.certificate.reasons[0]).toMatch(/^Revision 2 changes the type certificate SEED-CERT-0001 approved \(seams \(thread\)\): .*so its class label is held/)
  })

  it('H17 the inspector decides the change needs no notified body (an answer before telling it is refused in words): the class label prints again', async () => {
    const url = `/compliance/type-changes/${G.typeChangeReview.id}`
    const early = await ok(P.inspector, 'POST', `${url}/answer`, { version: G.typeChangeReview.version, decision: 'APPROVED', answeredOn: today() }, 409)
    expect(early.error.issues.map((issue: Json) => issue.path)).toEqual(['refusal/NOT_NOTIFIED'])
    const decided = (await ok(P.inspector, 'POST', `${url}/not-needed`, { version: G.typeChangeReview.version, reason: 'The bonded thread is the approved seam construction; same tex and stitch density.' })).review
    expect(decided).toMatchObject({ status: 'NOT_NEEDED', holdsLabel: false })
    G.typeChangeReview = decided
    const preview = await ok(P.inspector, 'GET', `/compliance/labels/${H.jacketLabel()}/preview?styleRevisionId=${G.copyRev2.id}&size=52`)
    expect(preview.cell.certificate).toMatchObject({ outcome: 'covered', number: 'SEED-CERT-0001' })
    expect(await settle()).toEqual(expect.arrayContaining(['compliance.type_change_decided']))
  })

  // ---- X the month-end export and the period lock (the LAST stage before the end checks) --------------------------------------

  it('X1 finance reads the month of today’s documents: the checks, what each journal carries, and the number the batch will get', async () => {
    // Any month may be exported (PERIOD_ENDED is a check to explain, not a refusal) and the number is taken on today's date:
    // the month that holds the day's invoices, payments and supplier invoice is today's.
    const month = monthOfDay(today())
    const read = await ok(P.finance, 'GET', `/accounting/periods/${month}?companyId=${companyA()}&packages=${KX_JOURNALS.join(',')}`)
    expect(read).toMatchObject({ ended: false, yearEnd: KX_YEAR_END, reExportOf: null, layout: 'DEFAULT', period: expect.objectContaining({ month }) })
    expect(read.nextNumber).toMatch(new RegExp(`^EXP-${today().slice(0, 4)}-\\d{4}$`))
    // On an October run the seeded draft of October is open and EXP-2026-0001 (September) is the series' only number.
    if (month === '2026-10') expect(read).toMatchObject({ draft: expect.objectContaining({ id: kx().octoberDraft }), nextNumber: 'EXP-2026-0002' })
    const checks = Object.fromEntries((read.checks as Json[]).map((check) => [check.code, check]))
    expect(checks.PERIOD_ENDED).toMatchObject({ passed: false, count: 1 })
    expect(read.failing).toBe((read.checks as Json[]).filter((check) => !check.passed).length)
    const contents = Object.fromEntries((read.contents as Json[]).map((entry) => [entry.package, entry]))
    expect(contents.SALES_JOURNAL.documents.documents).toBeGreaterThanOrEqual(3)
    expect(contents.PURCHASES_JOURNAL.documents.documents).toBeGreaterThanOrEqual(1)
    expect(contents.PAYMENTS.documents.documents).toBeGreaterThanOrEqual(1)
    G.period = read
  })

  it('X2 the export is refused while a failing check is not explained in words', async () => {
    const month = monthOfDay(today())
    const failing = (G.period.checks as Json[]).filter((check) => !check.passed).map((check) => check.code as string)
    const refused = await ok(P.finance, 'POST', '/accounting/exports', { companyId: companyA(), month, packages: KX_JOURNALS }, 400)
    expect((refused.error.issues as Json[]).map((issue) => issue.path).sort()).toEqual(failing.map((code) => `body/explanations/${code}`).sort())
    expect((refused.error.issues as Json[]).find((issue) => issue.path === 'body/explanations/PERIOD_ENDED')!.message).toMatch(/fails: .* Explain it in words, or fix it first\.$/)
    // Nothing was exported.
    expect((await ok(P.finance, 'GET', `/accounting/periods/${month}?companyId=${companyA()}&packages=${KX_JOURNALS.join(',')}`)).nextNumber).toBe(G.period.nextNumber)
  })

  it('X3 finance exports the month as the next numbered batch: the day’s invoices, credit note, payments and supplier invoice are in its journals', async () => {
    const month = monthOfDay(today())
    const explanations = (G.period.checks as Json[]).filter((check) => !check.passed).map((check) => ({ code: check.code, explanation: KX_EXPLAIN[check.code] ?? 'Known at month end: the accountant has the list; a re-export carries the fix.' }))
    const made = (await ok(P.finance, 'POST', '/accounting/exports', { companyId: companyA(), month, packages: KX_JOURNALS, explanations, note: 'Month end of the golden day.' }, 201)).export
    expect(made).toMatchObject({ number: G.period.nextNumber, status: 'EXPORTED', layout: 'DEFAULT', supersedes: null, period: expect.objectContaining({ month }), exportedBy: expect.objectContaining({ id: P.finance.id }) })
    expect((made.files as Json[]).map((file) => [file.seq, file.package, file.format])).toEqual([
      [1, 'SALES_JOURNAL', 'CSV'],
      [2, 'PURCHASES_JOURNAL', 'CSV'],
      [3, 'PAYMENTS', 'CSV'],
    ])
    expect((made.checks as Json[]).filter((check) => !check.passed).every((check) => typeof check.explanation === 'string' && check.explanation.length > 0)).toBe(true)
    const carried = (pkg: string) => (made.manifest as Json[]).filter((entry) => entry.package === pkg).map((entry) => entry.recordId as string)
    expect(carried('SALES_JOURNAL')).toEqual(expect.arrayContaining([G.invoice1.id, G.invoice2.id, G.creditNote.id]))
    expect(carried('PURCHASES_JOURNAL')).toContain(G.supplierInvoice.id)
    const { payments } = await ok(P.finance, 'GET', `/payments?companyId=${companyA()}&status=RECEIVED&from=${today()}&to=${today()}&limit=200`)
    expect((payments as Json[]).length).toBeGreaterThan(0)
    expect(carried('PAYMENTS')).toEqual(expect.arrayContaining((payments as Json[]).map((payment) => payment.id)))

    // The sales journal as the accountant gets it (Italian layout: `;`, decimal comma), one row per VAT entry of each invoice.
    const salesFile = (made.files as Json[]).find((file) => file.package === 'SALES_JOURNAL')!
    const link = await ok(P.finance, 'GET', `/accounting/exports/${made.id}/files/${salesFile.id}/download`)
    const bytes = await w.h.app.inject({ method: 'GET', url: link.download.url })
    expect(bytes.statusCode).toBe(200)
    expect(bytes.body.split('\r\n')[0]).toContain('tracciato DEFAULT (da confermare con il commercialista)')
    for (const invoice of [G.invoice1, G.invoice2, G.creditNote]) expect(bytes.body).toContain(`${invoice.number};`)

    // On an October run the seeded draft of October is replaced by this batch.
    if (month === '2026-10') {
      const history = await ok(P.finance, 'GET', `/accounting/exports?companyId=${companyA()}&year=2026`)
      expect((history.rows as Json[]).find((row) => row.id === kx().octoberDraft)).toMatchObject({ status: 'CANCELLED', cancelReason: expect.stringContaining('Replaced') })
    }
    G.export = made
    keep(made.id)
    done(made.id)
    await settle()
  })

  it('X4 finance soft-locks the month naming the batch; every stock move the day made has its value, except the returned jacket put back into stock (X5b)', async () => {
    const month = monthOfDay(today())
    const soft = await ok(P.finance, 'POST', '/accounting/locks', { companyId: companyA(), month, level: 'SOFT', note: `Month end: exported as ${G.export.number}.` })
    // A SOFT lock names what a HARD one refuses (an SDI-rejected invoice, a stock move without its value, an open year-end
    // inventory; in December the missing year-end inventory). The day's issues, receipts, write-off, count, kit and returns
    // to the supplier are all valued; the one move without a value is the return's restock (R05): the gap of X5b.
    const unvalued = await admin<{ reason: string; reference: string | null }>(
      w,
      `SELECT m.reason, m.reference FROM "StockMove" m WHERE m."companyId" = $1 AND m."createdAt" BETWEEN $2 AND now() AND NOT EXISTS (SELECT 1 FROM "StockValuation" v WHERE v."moveId" = m.id)
         AND ((m."fromLocationId" IS NULL AND m."toLocationId" IS NOT NULL) OR (m."toLocationId" IS NULL AND m."fromLocationId" IS NOT NULL))`,
      [companyA(), G.dayStart],
    )
    expect(unvalued).toEqual([{ reason: 'ADJUSTMENT', reference: G.rma.number }])
    expect(soft.warnings.map((warning: Json) => warning.code)).toEqual(['STOCK_NOT_VALUED', ...(KX_YEAR_END ? ['YEAR_END_COUNT_MISSING'] : [])])
    expect(soft.lock).toMatchObject({ level: 'SOFT', status: 'LOCKED', period: expect.objectContaining({ month }), export: { id: G.export.id, number: G.export.number, status: 'EXPORTED' }, lockedBy: expect.objectContaining({ id: P.finance.id }), words: expect.stringContaining('Soft-locked') })
    G.lock = soft.lock
    keep(soft.lock.id)
    done(soft.lock.id)
    await settle()
  })

  it('X7 a write dated in the soft-locked month is refused without a reason, goes in with one, and the override is audited on the lock (B-W2a-F8)', async () => {
    // While the month is only soft-locked (X4), before it is closed for good: after a HARD lock nothing dated today is written.
    const month = monthOfDay(today())
    const body = { companyId: companyA(), partyId: kx().p1, amount: 100, receivedOn: today(), externalRef: 'CRO-GOLDEN-SOFT-MONTH' }
    const refused = await ok(P.finance, 'POST', '/payments', body, 409)
    expect((refused.error.issues as Json[]).map((issue) => issue.path)).toEqual(['period/SOFT_LOCKED', 'body/receivedOn'])
    expect(refused.error.message).toMatch(new RegExp(`^${monthLabel(month)} is soft-locked for .+ \\(since .+\\): the payment received on .+ \\(bank reference CRO-GOLDEN-SOFT-MONTH\\) is not recorded without a reason\\. `))
    const listed = async () => ((await ok(P.finance, 'GET', `/payments?companyId=${companyA()}&from=${today()}&to=${today()}&limit=200`)).payments as Json[]).filter((row) => row.externalRef === 'CRO-GOLDEN-SOFT-MONTH')
    expect(await listed()).toEqual([])
    const reason = 'The transfer of the last day showed on the bank statement after the export.'
    const made = (await ok(P.finance, 'POST', '/payments', { ...body, periodLockOverride: { reason } }, 201)).payment
    expect(made).toMatchObject({ status: 'RECEIVED', receivedOn: today(), externalRef: 'CRO-GOLDEN-SOFT-MONTH' })
    expect((await listed()).map((row) => row.id)).toEqual([made.id])
    const audit = await admin<Json>(w, `SELECT "recordType", "recordId", reason, "actorId", after FROM "AuditLog" WHERE action = 'accounting.softLockOverride'`, [])
    expect(audit).toEqual([
      {
        recordType: 'PeriodLock',
        recordId: G.lock.id,
        reason,
        actorId: P.finance.id,
        after: { periodStart: G.lock.period.start, periodEnd: G.lock.period.end, level: 'SOFT', writes: [{ day: today(), path: 'body/receivedOn', record: { type: 'Payment', id: made.id } }] },
      },
    ])
    keep(made.id)
    await settle()
  })

  it('X5 closing the month for good needs its typed phrase: refused in words without it', async () => {
    const month = monthOfDay(today())
    const phrases = lockPhrases(month)
    const wrong = await ok(P.finance, 'POST', '/accounting/locks', { companyId: companyA(), month, level: 'HARD', phrase: 'close it', version: G.lock.version }, 400)
    expect(wrong.error.issues).toEqual([{ path: 'body/phrase', message: `Type "${phrases.en}" (or "${phrases.it}").` }])
    expect(wrong.error.message).toBe(`Closing ${monthLabel(month)} for good needs its phrase typed.`)
  })

  it.todo('X5b the month is closed for good (HARD, with its phrase) — refused STOCK_NOT_VALUED: the returned jacket put back into stock (R05) is an ADJUSTMENT of its FINISHED item posted without a value: sales/returns/decide.ts sends postMoves no cost, postMoves reads only Item.standardCost (none on a FINISHED item), the FROZEN standard frozen in M00b is read only by finished-goods receipts (inventory/finished/post.ts), and a freeze values only PRODUCTION_RECEIPT moves afterwards (costing/standards/standards.ts); no route values the move later, so the month holding a restocked return can never be closed (B-W2a-43, with B-W2a-21)')

  it('X6 a month closed for good refuses what is dated in it, in words: a payment dated in September 2026 (seeded HARD lock) is not recorded', async () => {
    const s = kx()
    const september = '2026-09'
    const words = new RegExp(`^${monthLabel(september)} is closed for good for .+ \\(a hard lock since .+\\): `)
    const payment = await ok(P.finance, 'POST', '/payments', { companyId: companyA(), partyId: s.p1, amount: 100, receivedOn: '2026-09-30', externalRef: 'CRO-GOLDEN-CLOSED-MONTH' }, 409)
    expect(payment.error.issues).toEqual([{ path: 'body/receivedOn', message: 'Dated inside a month closed for good.' }])
    expect(payment.error.message).toMatch(words)
    expect(payment.error.message).toContain('(bank reference CRO-GOLDEN-CLOSED-MONTH) is not recorded. Only someone who may lift a hard lock (accounting.unlock: the owner, by default) reopens the month')
    const { payments } = await ok(P.finance, 'GET', `/payments?companyId=${companyA()}&from=2026-09-01&to=2026-09-30&limit=200`)
    expect((payments as Json[]).some((row) => row.externalRef === 'CRO-GOLDEN-CLOSED-MONTH')).toBe(false)
    expect((await ok(P.finance, 'GET', `/accounting/periods/${september}?companyId=${companyA()}`)).lock).toMatchObject({ level: 'HARD', status: 'LOCKED' })
    await settle()
  })

  // ---- Z the end checks -----------------------------------------------------------------------------------------------------

  it('Z1 nothing the day finished waits on Home for anyone; every step left its audit rows and events; the worker never retried; the outbox is empty', async () => {
    // What the day finished, beside what the steps marked: the order shipped and invoiced, its work order, the NCR, the return,
    // the repair, the complaint, the buying records, the machine job, the alert, the task and the type-change review.
    done(G.order?.id, G.wo?.id, G.ncr?.id, G.rma?.id, G.repair?.id, G.complaint?.id, G.po?.id, G.claim?.id, G.supplierReturn?.id, G.supplierInvoice?.id, G.machineJob?.id, G.machineRequest?.id, G.alert?.id, G.task?.id, G.typeChangeReview?.id)
    for (const who of Object.values(P)) {
      const items = ((await ok(who, 'GET', '/home/today?limit=200')).items ?? []) as Json[]
      expect(items.filter((item) => finished.has(item.record?.id)).map((item) => `${who.key}: ${item.kind} ${item.record.label}`), `Home of ${who.key}`).toEqual([])
    }
    const ids = [...made]
    const actions = new Set((await admin<{ action: string }>(w, 'SELECT DISTINCT action FROM "AuditLog" WHERE "recordId" = ANY($1::uuid[])', [ids])).map((row) => row.action))
    const events = new Set((await admin<{ type: string }>(w, 'SELECT DISTINCT type FROM "OutboxEvent" WHERE subject = ANY($1::text[])', [ids])).map((row) => row.type))
    expect({ missingActions: EXPECTED_ACTIONS.filter((action) => !actions.has(action)), missingEvents: EXPECTED_EVENTS.filter((type) => !events.has(type)) }).toEqual({ missingActions: [], missingEvents: [] })
    expect(w.retried).toEqual([])
    expect(await admin(w, `SELECT type FROM "OutboxEvent" WHERE "tenantId" = $1 AND status <> 'PUBLISHED'`, [w.tenant.id])).toEqual([])
  })
})

/** Every audit action the day leaves on its own records (each stage's acts, the worker's and the scheduler's). */
const EXPECTED_ACTIONS: string[] = [
  'accounting.export', 'accounting.lock', 'accounting.prepareExport', 'alerts.acknowledge', 'alerts.raise',
  'alerts.resolve', 'complaints.acknowledge', 'complaints.close', 'complaints.log', 'complaints.move',
  'complaints.triage', 'compliance.typeChanges.found', 'compliance.typeChanges.notNeeded', 'costing.freezeStandard',
  'costing.postCosts', 'costing.prepareStandard', 'floor.changePin', 'imports.apply', 'imports.applyBatch',
  'imports.create', 'imports.finishApply', 'imports.finishPlan', 'imports.recordPlan', 'inventory.counts.apply',
  'inventory.counts.approve', 'inventory.counts.create', 'inventory.counts.snapshot', 'inventory.counts.start',
  'inventory.counts.submit', 'inventory.discrepancyRecorded', 'inventory.discrepancyReported',
  'inventory.discrepancySettled', 'inventory.hideListReceived', 'inventory.hideReceived', 'inventory.issue',
  'inventory.lotReceived', 'inventory.move', 'inventory.receive', 'inventory.releaseReservation',
  'inventory.reportDiscrepancies', 'inventory.reserve', 'inventory.writeOff', 'invoices.attachFiles',
  'invoices.createDraft', 'invoices.creditNoteFromReturn', 'invoices.fromDdts', 'invoices.issue', 'invoices.sdiArchive',
  'invoices.sdiStatus', 'orders.amend', 'orders.follow', 'orders.makeManual', 'payables.approve', 'payables.match',
  'payables.pay', 'payables.sdiReceive', 'payables.settleClaim', 'payments.payRefund', 'payments.record',
  'payments.recordRefund', 'planning.run', 'planning.schedule.publish', 'plant.closeJob', 'plant.createJob',
  'plant.handBackJob', 'plant.makeJobOfRequest', 'plant.report', 'plant.signSafe', 'plant.startJob',
  'product.bom.addLine', 'product.bom.copyRevision', 'product.bom.release', 'product.compliance.issueDocument',
  'product.compliance.prepareDocument', 'product.materials.create', 'product.styles.duplicate', 'production.cut',
  'production.doneRework', 'production.hideState', 'production.makeBundles', 'production.openRework',
  'production.printGarmentLabels', 'production.reportScan', 'production.startRework', 'purchasing.cancelLines',
  'purchasing.change', 'purchasing.claims.answer', 'purchasing.claims.close', 'purchasing.claims.create',
  'purchasing.claims.followDiscrepancy', 'purchasing.claims.returnGoods', 'purchasing.claims.returnToSupplier',
  'purchasing.claims.send', 'purchasing.closeShort', 'purchasing.confirmByLink', 'purchasing.create',
  'purchasing.lines.add', 'purchasing.lines.edit', 'purchasing.received', 'purchasing.remind', 'purchasing.send',
  'purchasing.sources.create', 'purchasing.subcontract.close', 'purchasing.subcontract.create',
  'purchasing.subcontract.issue', 'purchasing.subcontract.receiveBack', 'purchasing.subcontract.sendKit',
  'quality.closeNcr', 'quality.closeNcrHold', 'quality.decideHoldInNcr', 'quality.garments.release',
  'quality.holdWorkOrder', 'quality.inspection.assign', 'quality.inspection.decide', 'quality.inspection.defects',
  'quality.inspection.open', 'quality.liftWorkOrderHold', 'quality.lots.recordResult', 'quality.lots.release',
  'quality.moveNcr', 'quality.placeHold', 'quality.raiseNcr', 'quality.releaseHold', 'repairs.move',
  'repairs.safetyCheck', 'repairs.ship', 'returns.addLine', 'returns.close', 'returns.create', 'returns.decideLine',
  'returns.gradeLine', 'returns.receive', 'returns.receiveLine', 'returns.statusChanged', 'shipping.addParcel',
  'shipping.attachDocuments', 'shipping.buyLabel', 'shipping.buyLabels', 'shipping.create', 'shipping.freightByRule',
  'shipping.issueDdt', 'shipping.left', 'shipping.packShipment', 'shipping.pollTracking', 'shipping.requestTrackingPoll',
  'shipping.setFreight', 'shipping.ship', 'shipping.trackingMove', 'tasks.create', 'tasks.setStatus', 'workers.create',
  'workers.resetPin', 'workorders.complete', 'workorders.create', 'workorders.createRepair', 'workorders.release',
  'workorders.start',
  // X7 (B-W2a-F8): a payment written into the soft-locked month with its reason.
  'accounting.softLockOverride',
]

/** Every event type the day leaves on its own records (subject = one of them). */
const EXPECTED_EVENTS: string[] = [
  'accounting_export.exported', 'alert.acknowledged', 'alert.raised', 'alert.resolved', 'complaint.received',
  'complaint.safety_acknowledged', 'complaint.safety_raised', 'complaint.status_changed', 'complaint.triaged',
  'compliance.type_change_decided', 'compliance.type_change_found', 'ddt.issued', 'ddt.source_issued', 'import.applied',
  'import.apply_requested', 'import.planned', 'inventory.count_applied', 'inventory.count_changed',
  'inventory.count_recorded', 'inventory.issued', 'inventory.moved', 'inventory.receipt_discrepancies_reported',
  'inventory.receipt_discrepancy_changed', 'inventory.receipt_posted', 'inventory.reservations_released',
  'inventory.reserved', 'inventory.written_off', 'invoice.draft_saved', 'invoice.files_attached', 'invoice.issued',
  'invoice.refund_due', 'invoice.return_credit_drafted', 'invoice.sdi_archived', 'invoice.sdi_notification_received',
  'invoice.sdi_poll_due', 'invoice.sdi_status_changed', 'lot.released', 'lot.test_recorded', 'maintenance_job.assigned',
  'maintenance_job.created', 'maintenance_job.moved', 'maintenance_request.reported', 'maintenance_request.signed_safe',
  'maintenance_request.triaged', 'material.created', 'ncr.containment_changed', 'ncr.created', 'ncr.decision_changed',
  'ncr.hold_closed', 'ncr.stage_changed', 'payment.allocated', 'payment.recorded', 'period_lock.locked',
  'planning.exceptions_found', 'planning.requirement_firmed', 'planning.run_finished', 'planning.schedule_published',
  'production.bundle_created', 'production.cut_logged', 'production.garment_labels_printed', 'production.hide_closed',
  'production.rework_moved', 'production.rework_opened', 'production.scan_recorded', 'purchase_order.confirmed',
  'purchase_order.created', 'purchase_order.lines_cancelled', 'purchase_order.lines_changed',
  'purchase_order.lines_closed_short', 'purchase_order.reminder_sent', 'purchase_order.revision_started',
  'purchase_order.sent', 'quality.garments_released', 'quality.hold_placed', 'quality.hold_released',
  'quality.inspection_assigned', 'quality.inspection_decided', 'quality.inspection_opened', 'refund.paid',
  'refund.recorded', 'repair.safety_checked', 'repair.stage_changed', 'return.authorised', 'return.credit_due',
  'return.decided', 'return.graded', 'return.received', 'return.status_changed', 'sales_order.amended',
  'sales_order.created', 'sales_order.status_changed', 'shipment.created', 'shipment.documents_attached',
  'shipment.documents_link_sent', 'shipment.freight_changed', 'shipment.labels_bought', 'shipment.packing_changed',
  'shipment.status_changed', 'shipment.tracking_poll_due', 'shipment.tracking_recorded', 'standard_cost.changed',
  'style.bom_changed', 'style.compliance_document_issued', 'style.created', 'style.duplicated', 'style.revision_created',
  'style.revision_released', 'style.skus_changed', 'style.status_changed', 'subcontract_order.closed',
  'subcontract_order.created', 'subcontract_order.issued', 'subcontract_order.kit_sent', 'subcontract_order.received',
  'subcontract_order.updated', 'supplier_claim.answered', 'supplier_claim.closed', 'supplier_claim.created',
  'supplier_claim.goods_returned', 'supplier_claim.sent', 'supplier_invoice.approved', 'supplier_invoice.claim_settled',
  'supplier_invoice.matched', 'supplier_invoice.paid', 'supplier_invoice.received', 'supplier_item.created',
  'task.assigned', 'task.completed', 'task.created', 'thread.followers_changed', 'thread.message_posted',
  'thread.user_mentioned', 'work_order_cost.posted', 'workorder.created', 'workorder.released',
  'workorder.status_changed',
]
