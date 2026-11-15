import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { ErrorReport } from '@nexus/factory-domain/observability/report'
import { supplierInvoiceXml } from '@nexus/factory-domain/payables/testing'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { createErrorTracker, useErrorTracker } from '../../observability/tracker'
import type { Browser } from '../../platform/auth/sessions/testing/harness'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { standardReasonsForNewTenants } from '../../platform/reasons/standard'
import type { SearchIndexer } from '../../platform/search/indexer'
import { indexNewTenants } from '../../platform/search/indexing'
import { runSdiPoll } from '../../modules/invoicing/sdi/poll'
import { runTrackingPoll } from '../../modules/shipping/labels/poll'
import { admin, announce, floorWorker, linkBrowser, linkTokenSentTo, ok, pdf, person, putBytes, QUIET, sha256, signOn, startWorld, stepped, tablet, type FloorWorker, type Person, type World } from '../testing/world'
import { assertEveryHandler, everyHandler, searchIndexers, settler } from '../daily/testing/day'

/**
 * The W2b-6 golden flow (B-W2b-436; design check I13): money, logistics and the platform cross every module of W1 to W2b-5;
 * the flow proves they agree, THROUGH THE HTTP ROUTES, each act by the person who does it, on the seeded factory:
 *
 *   C  a cost sheet from the jacket's components (leather by its yield, labour by the routing's minutes, the season's size mix
 *      and its weighted cost), the configurable jacket's option deltas; sent for its yes, the person who asked may not decide,
 *      another person approves: locked; a mass cost update shows its effect on margins before anything is written.
 *   M  an order on terms with a balance before shipping; its work order made on the floor (the leather and protectors bought,
 *      received and released, cut per hide, bundles, scans tracing the protectors' lot), each garment numbered by serial at the
 *      final operation, inspected and released.
 *   S  the shipment held by the system for the balance (a scan refused), split in two; the balance paid by a bank line matched
 *      to its request with its reasons (the statement imported twice: the duplicate refused), its deposit invoice issued by the
 *      worker (B-W2b-F48), the holds lifted by the system; packed by scanning serials into cartons with marks, labelled in test
 *      mode, a label reprinted with a reason, a pickup booked, shipped; the site taken live, the rest shipped with the carrier's
 *      label, the day's manifest closed; delivered with proof (typed with its signer, and by the carrier): the order DELIVERED.
 *   I  the month's invoice run (one TD24 of both DDTs, the balance's deposit invoice deducted) in the order's currency; a return
 *      label for one jacket back; an invoice with a declaration of intent and its stamp duty, rejected by SDI and corrected (the
 *      stamp duty kept, counted once); a self-invoice behind the accountant's switch; e-invoice test mode.
 *   B  the TD24 paid by a bank line short by a few cents: matched with its reasons, the difference written off within tolerance;
 *      a Ri.Ba. batch with an unpaid return and the debit note of its fee; the supplier's invoices through the FAKE SDI inbox,
 *      approved by another person; the week's payment proposal approved by another person to the verified account.
 *   W  the work order closed outside tolerance with its reason and variances, undone and closed again; a cost after the close
 *      waits for a reopen.
 *   K  purchase price variance at the invoice (company A takes it there), cost of goods sold at shipment, landed cost over the
 *      lots; the accountant's export with mapped accounts, a re-export of a document changed after it, flagged by the checks.
 *   P  a person's data package and an erasure that keeps the customer record its invoices refer to.
 *   Q  a KPI read the same on the Owner's dashboard and in the KPI library.
 *   F  the W2b-5 follow-ups: a quote approval refused to its requester; a made-to-measure order released to the floor.

 * World: the W1 golden world (../testing/world.ts: a throwaway PostgreSQL 17 database from the migrations, EVERY base seed plus
 * the W1 golden scenario, the real app with the real sign-in, every outside provider FAKE: mail, SDI, Sendcloud, the ECB, the
 * broker) and the W2a day's worker (../daily/testing/day.ts: EVERY handler list of background.ts, run in-process by the real
 * outbox relay). SQL only reads ids and asserts: no step is made by SQL. Every Owner switch the flow needs is switched on inside
 * the flow through its route with a fresh code (and switched off again where the flow only needs it for one act). The days the
 * flow types are fixed far-future days or today's business day (a document is never dated ahead). Every name, address and
 * figure is made up. Run with `node scripts/factory/golden-flow.mjs money-depth`.
 */

let w: World
let handlers: readonly EventHandler[]
let indexers: readonly SearchIndexer[]
let settle: () => Promise<string[]>
type Json = Record<string, any>
type Role = 'owner' | 'admin' | 'sales' | 'finance' | 'finance2' | 'planner' | 'buyer' | 'warehouse' | 'manager' | 'inspector' | 'supervisor'
const P = {} as Record<Role, Person>
/** What the flow made, step by step. */
const G = {} as Record<string, any>
/** What the API reported as unexpected (a 500) during the flow: none at the end. */
const unexpected: ErrorReport[] = []
/** Every record the flow made: the end checks look for their audit rows. */
const made = new Set<string>()
const keep = (...ids: (string | undefined | null)[]) => ids.forEach((recordId) => recordId && made.add(recordId))
const id = (key: string) => w.id(key)
const today = () => businessDate(new Date())
const companyA = () => id('company:A')
const siteA1 = () => id('site:A1')
const P1 = () => id('party:P1')
/** A seed row written with the seeds' firstId (ids that start with eight zeros). */
const first = (key: string) => `00000000${w.id(key).slice(8)}`
const pathsOf = (error: Json): string[] => ((error?.error?.issues ?? []) as Json[]).map((issue) => String(issue.path))
const refusalOf = (error: Json): string | undefined => pathsOf(error).find((path) => path.startsWith('refusal/'))

// ---- the order and its work order (SEED-JKT-01 BLK, numbered by serial) -----------------------------------------------------------
const SIZES = { '50': 2, '52': 4, '54': 2 } as const
const PIECES = Object.values(SIZES).reduce((sum, n) => sum + n, 0)
const CHECKS = ['EN17092_CLASS_LABEL', 'SIZE_LABEL', 'CE_MARK', 'CARE_LABEL', 'FIBRE_COMPOSITION', 'ANIMAL_ORIGIN_PHRASE', 'ZIPS', 'REFLECTIVES', 'ARMOUR_FITTED', 'HANGTAGS', 'USER_INFORMATION', 'PACKAGING']
const PLAN = { inspectionLevel: 'II', aqlMajor: '2.5', aqlMinor: '4.0', acceptMajor: 0, acceptMinor: 1 } as const
const jacket = () => id('product:style:JKT-01')
const black = () => id('product:colourway:JKT-01:BLK')
const leather = () => id('product:item:leather')
const leatherBlk = () => id('product:item-colour:leather:BLK')
const protector = () => id('product:item:protector')
const ops = (): Json[] => (G.wo.spec.operations as Json[]).filter((op) => op.scanRequired).sort((a, b) => a.seq - b.seq)

// ---- the bank -----------------------------------------------------------------------------------------------------------------
const CSV_HEADER = 'Data contabile;Data valuta;Importo;Causale;Ordinante;IBAN ordinante;Riferimento banca'
/** P1's made-up IBAN (bank and branch code 00000: no real bank). */
const PAYER = 'IT27X0000000000000000370003'
const dmy = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`
/** Minor units in the statement's Italian way (1219,70). */
const euro = (minor: number) => (minor / 100).toFixed(2).replace('.', ',')
/** P2's FatturaPA through the FAKE SDI inbox of company A (the payables runtime reads the invoicing SDI runtime's fake = w.sdi). */
function deliverFromP2(input: { number: string; progressive: string; lines: { description: string; quantity: string; uom?: string; unitPrice: string; itemCode?: string }[]; orders?: { number: string }[] }) {
  const { xml, fileName } = supplierInvoiceXml({ supplierVat: P2_VAT, buyerVat: COMPANY_A_VAT, number: input.number, date: today(), dueDate: today(), progressive: input.progressive, lines: input.lines, ...(input.orders ? { orders: input.orders } : {}) })
  return w.sdi.deliver({ tenantId: w.tenant.id, accountId: id('integration:account:sdi'), xml, fileName })
}
/** The made-up VAT numbers of P2 and company A (seed/parties.ts, seed/_core.ts). */
const P2_VAT = '00000002022'
const COMPANY_A_VAT = '12345670009'
/** A statement file announced, sent to the store and completed, as the bank's import screen does. */
async function statementFile(name: string, content: string): Promise<string> {
  const body = Buffer.from(content, 'utf8')
  const announced = await ok(P.finance, 'POST', '/payments/bank/statements/uploads', { companyId: companyA(), originalName: name, sizeBytes: body.length, sha256: sha256(body) }, 201)
  await putBytes(w, announced, body)
  await ok(P.finance, 'POST', `/files/${announced.file.id}/complete`)
  keep(announced.file.id)
  return announced.file.id as string
}

// ---- the event types the flow must leave behind (Z1) --------------------------------------------------------------------------
const EVENTS = [
  // C: cost sheets
  'cost_sheet.version_changed',
  'cost_sheet.approved',
  'approval.requested',
  'approval.decided',
  // M: the order and its garments
  'sales_order.created',
  'workorder.created',
  'workorder.released',
  'purchase_order.sent',
  'inventory.receipt_posted',
  'lot.released',
  'inventory.issued',
  'workorder.status_changed',
  // S: holds, split, the bank, packing, labels, pickups, the day's close, delivery
  'shipment.created',
  'shipment.hold_placed',
  'shipment.hold_released',
  'shipment.split',
  'bank_statement.imported',
  'bank_match.accepted',
  'payment.recorded',
  'shipping.test_mode_changed',
  'shipping.carton_packed',
  'shipping.label_reprinted',
  'shipping.pickup_changed',
  'shipping.day_sheet_closed',
  'shipment.pod_recorded',
  'shipment.status_changed',
  // I: invoices
  'invoice_run.changed',
  'invoice.issued',
  'tax_settings.changed',
  'e_invoicing.settings_changed',
  'self_invoice.changed',
  'return_label.changed',
  // B: the bank, Ri.Ba., payables
  'payment.written_off',
  'collections_settings.changed',
  'riba_batch.changed',
  'riba_item.settled',
  'payment_proposal.changed',
  'supplier_invoice.received',
  'supplier_invoice.approved',
  // W, K: the close, costs, the accountant
  'work_order_close.changed',
  'purchase_price_variance.posted',
  'cost_of_sales.posted',
  'landed_cost.changed',
  'account_mapping.changed',
  'accounting_settings.changed',
  'integrity_checks.ran',
  // P: privacy
  'privacy.person_erased',
]

beforeAll(async () => {
  useErrorTracker(createErrorTracker({ sink: { kind: 'fake', send: (report) => void unexpected.push(report) }, source: 'api' }))
  w = await startWorld()
  indexers = await searchIndexers()
  handlers = everyHandler(indexers)
  settle = settler(w, handlers)
  for (const [key, role] of [
    ['owner', 'owner'],
    ['admin', 'admin'],
    ['sales', 'sales'],
    ['finance', 'finance'],
    ['finance2', 'finance'],
    ['planner', 'planner'],
    ['buyer', 'buyer'],
    ['warehouse', 'warehouse'],
    ['manager', 'production_manager'],
    ['inspector', 'quality_inspector'],
    ['supervisor', 'floor_supervisor'],
  ] as const) {
    P[key] = await person(w, key, role)
  }
}, 1_200_000)

afterAll(async () => {
  useErrorTracker(undefined)
  await w?.close()
}, 60_000)

describe('the W2b-6 golden flow: a cost sheet approved, an order packed by scan into cartons, held and released, shipped with a pickup and the day’s manifest, delivered with proof, invoiced with stamp duty, paid by a matched bank line and a Ri.Ba. batch, a work order closed with its variances, cost of goods sold and the accountant’s export, a person’s data exported and erased, through the HTTP routes', { timeout: 180_000 }, () => {
  it('00 the world: the worker runs every handler list of background.ts; the seeds drain', async () => {
    assertEveryHandler()
    await standardReasonsForNewTenants({ database: w.h.database, log: QUIET })
    await indexNewTenants({ database: w.h.database, indexers, log: QUIET })
    await settle()
  })

  // ---- C: the cost sheet --------------------------------------------------------------------------------------------------------

  it('C01 finance writes the jacket’s cost sheet from its components: the leather by its yield per size, labour by the routing’s minutes, the season’s size mix and its weighted cost; the configurable jacket’s options carry their own cost', async () => {
    const before = (await ok(P.finance, 'GET', `/costing/cost-sheets?styleId=${jacket()}&companyId=${companyA()}`)).versions as Json[]
    const approved = before.find((row) => row.state === 'APPROVED')!
    expect(approved).toBeDefined()
    G.sheetApprovedBefore = approved
    const created = (
      await ok(P.finance, 'POST', '/costing/cost-sheets', {
        styleId: jacket(),
        from: 'COMPONENTS',
        revisionId: id('product:revision:JKT-01:1'),
        companyId: companyA(),
        seasonId: approved.season?.id ?? null,
        piecesPerCarton: 12,
        targetPrice: '520',
        targetMarginPct: '40',
        note: 'Golden W2b-6: the season’s sheet from the components (made up)',
      }, 201)
    ).sheet
    keep(created.id)
    expect(created).toMatchObject({ state: 'DRAFT', sheetVersion: approved.sheetVersion + 2 })
    const record = await ok(P.finance, 'GET', `/costing/cost-sheets/${created.id}`)
    G.sheet = record.sheet
    const lines = record.lines as Json[]
    // The leather is costed per size from the BOM by its yield; labour from the routing's minutes (not by the piece).
    const leatherLines = lines.filter((line) => line.category === 'LEATHER')
    expect(leatherLines.length, JSON.stringify(lines.map((line) => [line.category, line.source, line.size]))).toBeGreaterThan(0)
    expect(new Set(leatherLines.map((line) => line.size)).size).toBeGreaterThan(1)
    // Piece-rate labour is off: every labour line is the routing's minutes at the rate (never a PIECE_RATE line).
    const labour = lines.filter((line) => line.category === 'LABOUR')
    expect(labour.length).toBeGreaterThan(0)
    expect(labour.every((line) => line.source === 'ROUTING'), JSON.stringify(labour.map((line) => line.source))).toBe(true)
    expect(record.leftOut ?? []).toEqual([])
    // The season's size mix and the weighted cost it gives.
    expect(record.weights).toMatchObject({ weighted: expect.any(String), missing: [] })
    const bySize = await ok(P.finance, 'GET', `/costing/cost-sheets/${created.id}/by-size`)
    expect(bySize.weights).toMatchObject({ source: 'SEASON', weighted: record.weights.weighted })
    // The configurable jacket's options carry their own cost (typed or worked out), never counted in the garment's sheet.
    const options = await ok(P.finance, 'GET', `/costing/styles/${id('options:style:JKT-05')}/option-costs?companyId=${companyA()}`)
    expect((options.values as Json[]).some((value) => value.material?.source === 'TYPED' || value.making?.source === 'TYPED'), JSON.stringify(options.values?.[0])).toBe(true)
    await settle()
  })

  it('C02 finance sends it for its yes: finance’s request may not be decided by the same person (refused), the second finance person approves: version locked, the earlier approved version frozen', async () => {
    const submitted = (await ok(P.finance, 'POST', `/costing/cost-sheets/${G.sheet.id}/submit`, { version: G.sheet.version, note: 'The season’s sheet (made up).' })).sheet
    expect(submitted.approval).toMatchObject({ status: 'PENDING', taskId: expect.any(String) })
    const task = (await ok(P.finance2, 'GET', `/approvals/tasks/${submitted.approval.taskId}`)).task
    keep(task.id)
    // REFUSAL: the person who asked never decides.
    await ok(P.finance, 'POST', `/approvals/tasks/${task.id}/approve`, { version: task.version, comment: null }, 403)
    await ok(P.finance2, 'POST', `/approvals/tasks/${task.id}/approve`, { version: task.version, comment: 'Checked against the tannery’s list (made up).' })
    const locked = await ok(P.finance, 'GET', `/costing/cost-sheets/${G.sheet.id}`)
    expect(locked.sheet).toMatchObject({ state: 'APPROVED', approvedBy: { id: P.finance2.id } })
    expect(locked.can).toMatchObject({ edit: false, submit: false })
    const edited = await ok(P.finance, 'PATCH', `/costing/cost-sheets/${G.sheet.id}`, { version: locked.sheet.version, targetPrice: '1' }, 409)
    expect(refusalOf(edited)).toBe('refusal/LOCKED')
    const earlier = await ok(P.finance, 'GET', `/costing/cost-sheets/${G.sheetApprovedBefore.id}`)
    expect(earlier.sheet).toMatchObject({ state: 'FROZEN' })
    await settle()
  })

  it('C03 a mass cost update (the lining 10 % dearer) shows its effect on the list margins and the open order lines before anything is written; applying it asks a fresh code', async () => {
    const lining = id('product:item:lining')
    const { material } = await ok(P.finance, 'GET', `/product/materials/${lining}`)
    const newPrice = (Number(material.standardCost) * 1.1).toFixed(4)
    const preview = await ok(P.finance, 'POST', '/costing/mass-updates/preview', { changes: [{ itemId: lining, newPrice }] })
    expect(preview.previewHash).toEqual(expect.any(String))
    const entry = (preview.priceLists as Json[])[0]!
    expect(entry, JSON.stringify(preview.priceLists)).toBeDefined()
    expect(Number(entry.marginAfter)).toBeLessThan(Number(entry.marginBefore))
    // Nothing is written by a preview; the apply asks a fresh code first.
    expect((await ok(P.finance, 'GET', `/product/materials/${lining}`)).material.standardCost).toBe(material.standardCost)
    const refused = await ok(P.finance, 'POST', '/costing/mass-updates/apply', { changes: [{ itemId: lining, newPrice }], previewHash: preview.previewHash }, 403)
    expect(JSON.stringify(refused)).toMatch(/stepUp|step-up|fresh/i)
  })

  // ---- M: the order and its garments ------------------------------------------------------------------------------------------

  it('M01 finance keeps the terms “40 % before shipping, 60 % at 30 days”; sales types P1’s order of the black jacket on them: CONFIRMED, its balance before shipping a step with its own request', async () => {
    const { terms } = await ok(P.finance, 'POST', '/sales/payment-terms', {
      code: 'GF6-40BS-60',
      name: '40% prima della spedizione, 60% a 30 gg data fattura',
      nameI18n: { en: '40% before shipping, 60% 30 days from the invoice' },
      method: 'MP05',
      instalments: [
        { sharePct: '40', from: 'BEFORE_SHIPPING', days: 0 },
        { sharePct: '60', from: 'INVOICE', days: 30 },
      ],
    }, 201)
    keep(terms.id)
    G.terms = terms
    const { order } = await ok(P.sales, 'POST', '/sales/orders/manual', {
      companyId: companyA(),
      partyId: P1(),
      customerRef: 'PO-GOLDEN-W2B6-01',
      promiseDate: '2030-03-15',
      paymentTermsId: terms.id,
      depositPct: null,
      lines: [{ styleId: jacket(), colourwayId: black(), sizes: Object.entries(SIZES).map(([size, quantity]) => ({ size, quantity })) }],
    }, 201)
    keep(order.id)
    expect(order).toMatchObject({ status: 'CONFIRMED', currency: 'EUR', paymentTermsId: terms.id })
    G.order = order
    await settle()
    const schedule = await ok(P.sales, 'GET', `/sales/orders/${order.id}/schedule`)
    const balance = (schedule.steps as Json[]).find((step) => step.kind === 'BEFORE_SHIPPING')
    expect(balance, JSON.stringify(schedule.steps)).toMatchObject({ status: 'OPEN' })
    G.balanceStep = balance
  })

  it('M02 the production manager releases the jacket’s revision (DoC and leaflet filed, the seeded type change decided) and numbers its garments by serial', async () => {
    const path = `/product/styles/${jacket()}/revisions/${id('product:revision:JKT-01:1')}`
    const bom = (await ok(P.manager, 'GET', `${path}/bom`)).bom
    expect(bom).toMatchObject({ releasable: true, revision: { status: 'DRAFT' } })
    const released = (await ok(P.manager, 'POST', `${path}/release`, { version: bom.revision.version, changeNote: 'Seeded jacket, first release for production (W2b-6)' })).bom
    expect(released).toMatchObject({ revision: { status: 'RELEASED' } })
    for (const kind of ['DECLARATION_OF_CONFORMITY', 'USER_INFORMATION']) {
      for (const language of ['it', 'en']) {
        const body = pdf(`${kind} ${language} SEED-JKT-01 rev 1 (W2b-6)`)
        const announced = await ok(P.inspector, 'POST', `/product/styles/${jacket()}/compliance/documents`, { revisionId: id('product:revision:JKT-01:1'), kind, language, ...announce(`${kind.toLowerCase()}-${language}.pdf`, body) }, 201)
        await putBytes(w, announced, body)
        const confirmed = await ok(P.inspector, 'POST', `/product/styles/${jacket()}/compliance/documents/${announced.document.id}/files/${announced.file.id}/complete`)
        expect(confirmed.document.status).toBe('ISSUED')
        keep(announced.document.id)
      }
    }
    const seeded = (await ok(P.inspector, 'GET', `/compliance/type-changes/${id('compliance:type-change:JKT-01:1')}`)).review
    await ok(P.inspector, 'POST', `/compliance/type-changes/${seeded.id}/not-needed`, { version: seeded.version, reason: 'Same polyester lining, a lighter weave of the same fabric: no change to the protection examined.' })
    // Q31 (b): each garment of the jacket gets a serial (PPE traceability), chosen before any label is printed.
    const { style } = await ok(P.manager, 'GET', `/product/styles/${jacket()}`)
    const tracked = await ok(P.manager, 'PUT', `/product/styles/${jacket()}/garment-tracking`, { version: style.version, tracking: 'SERIAL' })
    expect(tracked.style ?? tracked).toMatchObject({ garmentTracking: 'SERIAL' })
    await settle()
  })

  it('M03 finance freezes the standard cost of the black sizes (the cost of goods sold and the variances read it); the planner makes the work order; the buyer orders leather and protectors, the supplier confirms; the work order is released', async () => {
    // The leather and the protectors too: the purchase price variance compares what is paid with them.
    const body = { companyId: companyA(), validFrom: `${today().slice(0, 7)}-01`, items: [...Object.keys(SIZES).map((size) => ({ variantId: id(`product:variant:JKT-01:BLK:${size}`) })), { itemId: leather() }, { itemId: protector() }], note: 'Season standard from the released cost sheet (W2b-6)' }
    const prepared = await ok(P.finance, 'POST', '/costing/standards/prepare', body)
    expect(prepared.skipped, JSON.stringify(prepared.skipped)).toEqual([])
    for (const standard of prepared.prepared as Json[]) {
      await ok(P.finance, 'POST', `/costing/standards/${standard.id}/freeze`, { version: standard.version })
      keep(standard.id)
    }
    const { workOrder } = await ok(P.planner, 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: G.order.lines[0].id }] }, 201)
    keep(workOrder.id)
    G.draft = workOrder
    const needDate = addDays(today(), 14)
    let po = (await ok(P.buyer, 'POST', '/purchasing/orders', { companyId: companyA(), siteId: siteA1(), partyId: id('party:P2'), requestedDate: needDate, note: 'Black leather for the W2b-6 order' }, 201)).order
    keep(po.id)
    po = (await ok(P.buyer, 'POST', `/purchasing/orders/${po.id}/lines`, { version: po.version, itemId: leather(), itemColourId: leatherBlk(), quantity: '1120', uom: 'FT2', needDate }, 201)).order
    po = (await ok(P.buyer, 'POST', `/purchasing/orders/${po.id}/lines`, { version: po.version, itemId: protector(), quantity: '36', uom: 'PCS', needDate }, 201)).order
    const sent = await ok(P.buyer, 'POST', `/purchasing/orders/${po.id}/send`, { version: po.version })
    expect(sent).toMatchObject({ order: { status: 'SENT' } })
    await settle()
    const supplier = linkBrowser(w, linkTokenSentTo(w, sent.sent.to))
    const page = await supplier.send('GET', '/link/purchase-order')
    expect(await supplier.send('POST', '/link/purchase-order/confirm', { version: page.order.version, mode: 'ALL_AS_ASKED', typedName: 'Mario Fornitore', supplierRef: 'OC-GF6-M' })).toMatchObject({ outcome: 'CONFIRMED' })
    G.po = (await ok(P.buyer, 'GET', `/purchasing/orders/${po.id}`)).order
    await settle()
    const check = await ok(P.planner, 'GET', `/production/work-orders/${workOrder.id}/release-check`)
    const blocked = (check.checks as Json[]).filter((entry) => entry.state === 'BLOCKED').map((entry) => entry.code)
    expect(blocked.filter((code) => code !== 'MATERIAL'), JSON.stringify(check.checks)).toEqual([])
    const current = (await ok(P.planner, 'GET', `/production/work-orders/${workOrder.id}`)).workOrder
    const wo = (await ok(P.planner, 'POST', `/production/work-orders/${workOrder.id}/release`, { version: current.version, ...(blocked.includes('MATERIAL') ? { materialOverride: { reason: 'The black hides are confirmed by the supplier; cutting waits for them (made up).' } } : {}) })).workOrder
    expect(wo).toMatchObject({ status: 'RELEASED', batchNumber: expect.any(String) })
    G.wo = wo
    await settle()
  })

  it('M04 the warehouse receives ten black hides of the order (quarantine for the Cr VI test); the inspector, not the receiver, records the result and releases the lot', async () => {
    const lineOf = (itemId: string) => (G.po.lines as Json[]).find((entry) => (entry.item?.id ?? entry.itemId) === itemId)!
    const [hidesLine, protectorsLine] = [lineOf(leather()), lineOf(protector())]
    const received = await ok(P.warehouse, 'POST', '/inventory/receipts', {
      purchaseOrderId: G.po.id,
      supplierDdtNumber: 'DDT-GF6-M1',
      supplierDdtDate: today(),
      lines: [
        { purchaseOrderLineId: hidesLine.id, lots: [{ supplierLotRef: 'TAN-GF6-BLK', dyeBatch: 'DB-GF6-01', shade: 'Nero 01', hides: Array.from({ length: 10 }, (_, n) => ({ supplierCode: `TG6-${n + 1}`, area: '56.0', grade: 'A', thicknessMm: '1.2' })) }] },
        { purchaseOrderLineId: protectorsLine.id, lots: [{ supplierLotRef: 'PRO-GF6', quantity: String(Number(protectorsLine.confirmedQuantity ?? protectorsLine.quantity)) }] },
      ],
    }, 201)
    expect(received.receipt).toMatchObject({ status: 'POSTED' })
    G.receipt = received.receipt
    const lotOf = (line: Json) => (received.receipt.lines as Json[]).find((entry) => entry.orderLine?.id === line.id || entry.purchaseOrderLineId === line.id)!.lots[0]
    const lot = lotOf(hidesLine)
    G.lot = lot
    G.protectorLot = lotOf(protectorsLine)
    expect(G.protectorLot).toMatchObject({ qualityStatus: 'QUARANTINE', holds: ['PPE_CERTIFICATE'] })
    G.hides = ((await ok(P.warehouse, 'GET', `/inventory/receipts/${received.receipt.id}/lots`)).lots as Json[]).find((entry) => entry.id === lot.id)!.hides
    keep(received.receipt.id, lot.id, G.protectorLot.id)
    await settle()
    const base = `/quality/lots/${lot.id}`
    let record = (await ok(P.inspector, 'GET', base)).lot
    const report = pdf('Cr VI test report TL-GF6-M1')
    const announced = await ok(P.inspector, 'POST', `${base}/results/report`, announce('cr6-gf6.pdf', report), 201)
    await putBytes(w, announced, report)
    record = (await ok(P.inspector, 'POST', `${base}/results`, { version: record.version, test: 'CR_VI', method: 'EN ISO 17075-1', valueMgKg: '1.1', lab: 'Test Lab One (made up)', reportNumber: 'TL-GF6-M1', testedOn: today(), evidence: 'LOT_REPORT', fileId: announced.file.id }, 201)).lot
    const released = (await ok(P.inspector, 'POST', `${base}/release`, { version: record.version, confirmCode: record.code })).lot
    expect(released.qualityStatus).toBe('RELEASED')
    // The protectors' lot: its PPE certificate on file, then released (a serial-numbered garment traces it at sewing).
    const protectors = `/quality/lots/${G.protectorLot.id}`
    const certificate = pdf('EN 1621-1 certificate of the shoulder protector lot PRO-GF6')
    const upload = await ok(P.inspector, 'POST', `${protectors}/documents/upload`, announce('ppe-certificate-gf6.pdf', certificate), 201)
    await putBytes(w, upload, certificate)
    await ok(P.inspector, 'POST', `${protectors}/documents`, { fileId: upload.file.id, kind: 'PPE_CERTIFICATE', validTo: '2030-05-31' }, 201)
    const check = await ok(P.inspector, 'GET', `${protectors}/release-check`)
    expect(check.checklist).toMatchObject({ ready: true, open: [] })
    G.protectorLot = (await ok(P.inspector, 'POST', `${protectors}/release`, { version: check.lot.version, confirmCode: check.lot.code })).lot
    expect(G.protectorLot.qualityStatus).toBe('RELEASED')
    await settle()
  })

  it('M05 the floor: a tablet per station and a worker each; the hides issued to the work order, cut one set per hide, bundled, every bundle through every operation', async () => {
    G.tablets = {} as Record<string, Browser>
    G.workers = {} as Record<string, FloorWorker>
    const pins = { CUTTING: '481537', SEWING: '592648', INSPECTION: '603759', PACKING: '714860' } as const
    for (const [kind, station] of [
      ['CUTTING', 'CUT-01'],
      ['SEWING', 'SEW-01'],
      ['INSPECTION', 'QC-01'],
      ['PACKING', 'PACK-01'],
    ] as const) {
      const device = await tablet(w, P.supervisor, siteA1(), id(`site:A1:station:${station}`), `W2b-6 tablet ${station}`)
      const worker = await floorWorker(w, P.supervisor, siteA1(), `W2b-6 ${kind.toLowerCase()} worker`, id('role:operator'))
      await signOn(device, worker, pins[kind])
      G.tablets[kind] = device
      G.workers[kind] = worker
      keep(worker.id)
    }
    const { printer } = await ok(P.admin, 'POST', '/print/printers', { siteId: siteA1(), code: 'LBL-GF6', name: 'W2b-6 label printer', kind: 'LABEL_ZPL', relay: 'FAKE', relayTarget: 'gf6-label:9100', dpi: 203, labelWidthMm: 100, labelHeightMm: 150 }, 201)
    G.labelPrinter = printer.id
    const cutting = G.tablets.CUTTING as Browser
    G.cutHides = (G.hides as Json[]).slice(0, PIECES)
    for (const hide of G.cutHides as Json[]) await ok(cutting, 'POST', `/inventory/picking/work-orders/${G.wo.id}/issue`, { code: hide.code }, 201)
    await settle()
    expect((await ok(P.planner, 'GET', `/production/work-orders/${G.wo.id}`)).workOrder.status).toBe('IN_PROGRESS')
    const sets = (G.wo.cells as Json[]).flatMap((cell) => Array.from({ length: cell.quantity }, () => cell))
    for (const [n, hide] of (G.cutHides as Json[]).entries()) {
      const cut = await ok(cutting, 'POST', `/production/cutting/work-orders/${G.wo.id}/cuts`, { clientEventId: `gf6-cut-${hide.code}`, code: hide.code, lines: [{ workOrderSizeId: sets[n]!.id, sets: 1 }], done: { remnant: null } }, 201)
      expect(cut.hide.state).toBe('CONSUMED')
    }
    await settle()
    const bundles = await ok(cutting, 'POST', `/production/bundles/work-orders/${G.wo.id}/bundles`, { bundleSize: 10, printerId: id('print:printer:A1:LBL') }, 201)
    G.bundles = bundles.bundles
    keep(...(bundles.bundles as Json[]).map((bundle) => bundle.id))
    let n = 0
    for (const bundle of G.bundles as Json[]) {
      for (const op of ops()) {
        const clientScanId = `gf6-scan-${++n}-${bundle.code}`
        // A serial-numbered garment traces its protectors' lot where they go in (sewing).
        const components = op.workCentreKind === 'SEWING' ? { components: [{ code: G.protectorLot.code, garments: bundle.quantity }] } : {}
        await ok(G.tablets[op.workCentreKind], 'POST', '/production/scans', { clientScanId, code: bundle.code, workOrderOperationId: op.id, good: bundle.quantity, ...components }, 201, { 'idempotency-key': clientScanId })
      }
    }
    expect(await ok(P.planner, 'GET', `/production/scans/work-orders/${G.wo.id}/wip`)).toMatchObject({ allFinished: true })
    // The warehouse issues the protectors the sewing traced, two each, and two spare for the bench (an over-issue says why).
    await ok(P.warehouse, 'POST', `/inventory/picking/work-orders/${G.wo.id}/issue`, { lotId: G.protectorLot.id, quantity: String(PIECES * 2 + 2), overIssueReason: 'Two spare protectors for the bench (made up).' }, 201)
    await settle()
  })

  it('M06 the garment labels at the packing bench give each jacket its serial; the final inspection passes and the inspector releases every cell naming its serials; the planner completes the work order', async () => {
    const printed = await ok(G.tablets.PACKING, 'POST', `/production/serials/work-orders/${G.wo.id}/labels`, { printerId: G.labelPrinter }, 201)
    expect(printed).toMatchObject({ tracking: 'SERIAL', refused: [] })
    G.serials = {} as Record<string, Json[]>
    for (const entry of printed.printed as Json[]) G.serials[entry.workOrderSizeId] = [...(G.serials[entry.workOrderSizeId] ?? []), ...(entry.serials as Json[])]
    expect(Object.values(G.serials as Record<string, Json[]>).flat().length).toBe(PIECES)
    await settle()
    const opened = (await ok(P.inspector, 'POST', '/quality/inspections', { workOrderId: G.wo.id, lotSize: PIECES, sampleSize: PIECES, ...PLAN }, 201)).inspection
    keep(opened.id)
    await stepped(w, P.inspector)
    const decided = (await ok(P.inspector, 'POST', `/quality/inspections/${opened.id}/decide`, { version: opened.version, result: 'PASS', checklist: CHECKS.map((code) => ({ code, ok: true })) })).inspection
    expect(decided).toMatchObject({ status: 'PASSED' })
    for (const cell of G.wo.cells as Json[]) {
      await stepped(w, P.inspector)
      const serialIds = (G.serials[cell.id] as Json[]).map((serial) => serial.id)
      const { release } = await ok(P.inspector, 'POST', '/quality/releases', { inspectionId: decided.id, workOrderSizeId: cell.id, quantity: cell.quantity, serialIds }, 201)
      keep(release.id)
    }
    await settle()
    const completed = (await ok(P.planner, 'POST', `/production/work-orders/${G.wo.id}/complete`, {})).workOrder
    expect(completed.status).toBe('COMPLETED')
    G.wo = { ...G.wo, ...completed, spec: G.wo.spec }
    await settle()
  })

  // ---- S: held, paid, packed, shipped, delivered --------------------------------------------------------------------------------

  it('S01 the warehouse ships the eight released jackets: the system holds the shipment for the balance before shipping (the queue reads it held), and a scan into its carton is refused in words', async () => {
    const ready = await ok(P.warehouse, 'GET', `/shipping/ready?salesOrderId=${G.order.id}`)
    const cells = (ready.orders as Json[]).flatMap((order) => order.cells as Json[])
    expect(cells.reduce((sum, cell) => sum + cell.shippable, 0)).toBe(PIECES)
    const { shipment } = await ok(P.warehouse, 'POST', '/shipping/shipments', { salesOrderId: G.order.id, lines: cells.filter((cell) => cell.shippable > 0).map((cell) => ({ workOrderSizeId: cell.workOrderSizeId, quantity: cell.shippable })) }, 201)
    keep(shipment.id)
    expect(shipment).toMatchObject({ status: 'DRAFT', garments: PIECES })
    G.shipA = shipment
    await settle()
    const holds = await ok(P.warehouse, 'GET', `/shipping/shipments/${shipment.id}/holds`)
    expect(holds.holds.reasons).toEqual(['BALANCE_UNPAID'])
    const hold = (holds.holds.holds as Json[]).find((row) => row.inForce)!
    expect(hold).toMatchObject({ bySystem: true, mayRelease: false })
    const queue = await ok(P.warehouse, 'GET', `/shipping/holds?siteId=${siteA1()}`)
    expect(JSON.stringify(queue)).toContain(shipment.id)
    const cell52 = (G.wo.cells as Json[]).find((cell) => cell.size === '52')!
    const refused = await ok(P.warehouse, 'POST', `/shipping/packing/${shipment.id}/scan`, { code: G.serials[cell52.id][0].serial }, 409)
    expect(refusalOf(refused)).toBe('refusal/ON_HOLD')
  })

  it('S02 the customer wants the 54s apart: the shipment is split (its hold comes along), something stays on the first', async () => {
    const preview = await ok(P.warehouse, 'GET', `/shipping/shipments/${G.shipA.id}/split`)
    const line54 = (preview.lines as Json[]).find((row) => row.size === '54')!
    expect(line54.movable).toBe(SIZES['54'])
    const split = await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipA.id}/split`, { version: preview.version, reason: 'CUSTOMER_REQUEST', lines: [{ lineId: line54.id, quantity: SIZES['54'] }] }, 201)
    expect(split.shipment.lines.map((line: Json) => [line.size, line.quantity])).toEqual([['54', SIZES['54']]])
    expect(split.from.lines.map((line: Json) => line.size).sort()).toEqual(['50', '52'])
    G.shipB = split.shipment
    keep(split.shipment.id)
    await settle()
    expect((await ok(P.warehouse, 'GET', `/shipping/shipments/${G.shipB.id}/holds`)).holds.reasons).toEqual(['BALANCE_UNPAID'])
  })

  it('S03 the balance comes in: finance imports the bank statement (dry run, then import); the same lines again are refused; the line’s suggestion names the balance’s request with how sure and why; accepted: the request is paid, its deposit invoice made by itself, and the system lifts both holds', async () => {
    const accounts = (await ok(P.finance, 'GET', `/payments/bank/accounts?companyId=${companyA()}`)).accounts as Json[]
    G.bankAccount = accounts.find((account) => account.active !== false)!
    const schedule = await ok(P.finance, 'GET', `/sales/orders/${G.order.id}/schedule`)
    G.balanceStep = (schedule.steps as Json[]).find((step) => step.kind === 'BEFORE_SHIPPING')!
    expect(G.balanceStep.depositRequestId, JSON.stringify(G.balanceStep)).toEqual(expect.any(String))
    const amount = G.balanceStep.amount as number
    const csv = [CSV_HEADER, `${dmy(today())};${dmy(today())};${euro(amount)};Saldo prima della spedizione ordine ${G.order.number};Seed Customer One S.r.l.;${PAYER};BNK-GF6-0001`].join('\n')
    const fileId = await statementFile('estratto-conto-gf6-1.csv', csv)
    const dry = await ok(P.finance, 'POST', '/payments/bank/statements/dry-run', { fileId, bankAccountId: G.bankAccount.id })
    expect(dry).toMatchObject({ format: 'CSV', ready: true, counts: { new: 1, duplicate: 0, error: 0 } })
    const imported = await ok(P.finance, 'POST', '/payments/bank/statements', { fileId, bankAccountId: G.bankAccount.id, expectNew: 1 }, 201)
    keep(imported.statementId ?? imported.statement?.id)
    G.balanceLine = imported.lineIds[0]
    await settle()
    // REFUSAL: the same statement again (another upload of the same lines) brings nothing new.
    const again = await statementFile('estratto-conto-gf6-1-bis.csv', csv)
    const twice = await ok(P.finance, 'POST', '/payments/bank/statements', { fileId: again, bankAccountId: G.bankAccount.id }, 409)
    expect(pathsOf(twice)).toContain('import/NOTHING_NEW')
    const line = (await ok(P.finance, 'GET', `/payments/bank/lines/${G.balanceLine}`)).line
    const best = line.suggestions[0]
    expect(best, JSON.stringify(line)).toMatchObject({ confidence: 'HIGH', partyId: P1() })
    expect((best.reasons as Json[]).map((reason) => reason.code)).toEqual(expect.arrayContaining(['NUMBER_IN_REFERENCE']))
    const accepted = await ok(P.finance, 'POST', `/payments/bank/matches/${best.id}/accept`, { version: best.version })
    expect(accepted).toMatchObject({ recorded: true })
    G.balancePayment = accepted.paymentId
    keep(accepted.paymentId)
    await settle()
    const paid = (await ok(P.finance, 'GET', `/sales/orders/${G.order.id}/schedule`)).steps as Json[]
    expect(paid.find((step) => step.kind === 'BEFORE_SHIPPING')).toMatchObject({ status: 'PAID' })
    // Paid before the goods leave (DPR 633/1972 art. 6 c.4): the balance's deposit invoice. B-W2b-F48: made by the worker after
    // the match, as for a deposit paid online or received by the office: exactly one, for the amount received, on the order.
    const made = (await ok(P.finance, 'GET', `/invoicing/invoices?companyId=${companyA()}&docType=TD02&depositRequestId=${G.balanceStep.depositRequestId}`)).invoices as Json[]
    expect(made, JSON.stringify(made)).toHaveLength(1)
    expect(made[0]).toMatchObject({ docType: 'TD02', status: 'ISSUED', grossTotal: amount, depositRequestId: G.balanceStep.depositRequestId, salesOrderId: G.order.id, filesPending: false })
    G.td02 = (await ok(P.finance, 'GET', `/invoicing/invoices/${made[0]!.id}`)).invoice
    expect(G.td02).toMatchObject({ docType: 'TD02', status: 'ISSUED', grossTotal: amount })
    // REFUSAL: nothing is left for a person to invoice by hand (no second TD02 for the same money).
    const twiceTd02 = await ok(P.finance, 'POST', '/invoicing/invoices/deposit-draft', { depositRequestId: G.balanceStep.depositRequestId }, 409)
    expect(twiceTd02.error.message).toContain('Nothing paid on this deposit request is waiting for a deposit invoice')
    keep(G.td02.id)
    await stepped(w, P.finance)
    await ok(P.finance, 'POST', `/invoicing/invoices/${G.td02.id}/sdi/send`, {})
    for (const shipment of [G.shipA, G.shipB]) {
      const holds = (await ok(P.warehouse, 'GET', `/shipping/shipments/${shipment.id}/holds`)).holds
      expect(holds.held, JSON.stringify(holds)).toBe(false)
      expect((holds.holds as Json[]).find((row) => row.reason === 'BALANCE_UNPAID')).toMatchObject({ inForce: false, releasedBySystem: true })
    }
  })

  it('S04 the dispatch desk puts the site in test mode; the packer scans each jacket’s serial into its carton (a serial scanned twice refused), closes two cartons with their marks, and packs the shipment', async () => {
    // The packing station's label printer named in the site's shipping settings (the carrier labels print on it).
    const { settings } = await ok(P.warehouse, 'GET', `/shipping/settings/${siteA1()}`)
    const fields = ['version', 'senderAddress', 'returnAddress', 'integrationAccountId', 'defaultCarrierCode', 'defaultServiceCode', 'defaultTransportBy', 'defaultGoodsAppearance', 'documentPrinterId', 'cutOffTime'] as const
    await ok(P.warehouse, 'PUT', `/shipping/settings/${siteA1()}`, { ...Object.fromEntries(fields.map((field) => [field, settings[field]])), labelPrinterId: G.labelPrinter })
    const mode = await ok(P.warehouse, 'GET', `/shipping/test-mode?siteId=${siteA1()}`)
    const site = (mode.sites as Json[]).find((entry) => entry.siteId === siteA1())!
    if (!site.testMode) await ok(P.warehouse, 'PUT', `/shipping/sites/${siteA1()}/test-mode`, { testMode: true, version: site.version })
    const serialsOf = (size: string): Json[] => G.serials[(G.wo.cells as Json[]).find((cell) => cell.size === size)!.id]
    const url = `/shipping/packing/${G.shipA.id}`
    const scan = async (serial: string) => (await ok(P.warehouse, 'POST', `${url}/scan`, { code: serial })).scan as Json
    const first = [...serialsOf('50'), serialsOf('52')[0]!]
    let carton = ''
    for (const serial of first) carton = (await scan(serial.serial)).parcelId
    const twice = await ok(P.warehouse, 'POST', `${url}/scan`, { code: first[0]!.serial }, 409)
    expect(refusalOf(twice)).toBe('refusal/ALREADY_PACKED')
    const closed1 = await ok(P.warehouse, 'POST', `${url}/cartons/${carton}/close`, { grossWeightKg: '6.5', printerId: G.labelPrinter })
    expect(closed1.marks).toMatchObject({ printed: true })
    for (const serial of serialsOf('52').slice(1)) carton = (await scan(serial.serial)).parcelId
    const closed2 = await ok(P.warehouse, 'POST', `${url}/cartons/${carton}/close`, { grossWeightKg: '6.4', printerId: G.labelPrinter })
    expect(closed2.marks).toMatchObject({ printed: true })
    // The second carton made the first "1 of 2": its marks are due again (the bench says so) and print once more.
    let bench = await ok(P.warehouse, 'GET', `${url}/cartons`)
    expect((bench.cartons as Json[]).map((entry) => entry.marksCurrent)).toEqual([false, true])
    expect(JSON.stringify(bench.problems)).toContain('MARKS_NOT_PRINTED')
    await ok(P.warehouse, 'POST', `${url}/cartons/marks/print`, { printerId: G.labelPrinter }, 201)
    bench = await ok(P.warehouse, 'GET', `${url}/cartons`)
    expect((bench.cartons as Json[]).map((entry) => [entry.closed, entry.marksCurrent])).toEqual([
      [true, true],
      [true, true],
    ])
    expect(bench.problems).toEqual([])
    const packed = (await ok(P.warehouse, 'POST', `${url}/pack`, {})).shipment
    expect(packed).toMatchObject({ status: 'PACKED', packingProblems: [] })
    await settle()
  })

  it('S05 the DDT is issued; the carrier labels print in test mode (nothing bought, a TEST number); a torn label is reprinted with its reason', async () => {
    const issued = await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipA.id}/ddt`, {}, 201)
    expect(issued.ddt).toMatchObject({ status: 'LIVE' })
    G.ddtA = issued.ddt
    keep(issued.ddt.id)
    const bought = await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipA.id}/labels`, {}, 201)
    expect(bought.problem ?? null).toBeNull()
    expect((bought.parcels as Json[]).every((parcel) => parcel.test === true), JSON.stringify(bought.parcels)).toBe(true)
    // The carrier labels printed at the packing station's printer (a TEST label says so, no barcode).
    const printed = await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipA.id}/labels/print`, { printerId: G.labelPrinter }, 201)
    expect(printed.jobs).toHaveLength(2)
    const jobs = await ok(P.warehouse, 'GET', `/shipping/shipments/${G.shipA.id}/label-jobs`)
    const carrierJob = (jobs.parcels as Json[]).flatMap((parcel) => parcel.jobs as Json[]).find((job) => job.kind === 'CARRIER')!
    expect(carrierJob, JSON.stringify(jobs.parcels)).toMatchObject({ test: true, scanId: expect.stringMatching(/^TEST-/) })
    const reprinted = await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipA.id}/label-jobs/reprint`, { jobIds: [carrierJob.jobId], reason: 'The label tore on the carton (made up).' }, 201)
    expect(reprinted.jobs).toEqual([expect.objectContaining({ reprintOfId: carrierJob.jobId, test: true, status: 'QUEUED' })])
    await settle()
  })

  it('S06 a pickup is booked for the cartons (test mode: the TEST pickup answers, nothing sent); the shipment leaves; delivered by a typed status with the signer and time of the proof', async () => {
    const draft = await ok(P.warehouse, 'GET', `/shipping/pickups/draft?siteId=${siteA1()}&shipmentIds=${G.shipA.id}`)
    expect(draft).toMatchObject({ testMode: true, vias: { SENDCLOUD: { allowed: true, test: true } } })
    const booked = await ok(P.warehouse, 'POST', '/shipping/pickups', { siteId: siteA1(), via: 'SENDCLOUD', carrierCode: draft.carrierCode, readyAt: draft.readyAt, parcels: 2, pallets: 0 }, 201)
    expect(booked.pickup).toMatchObject({ status: 'CONFIRMED', test: true, providerReference: expect.stringMatching(/^TEST-PU-/) })
    keep(booked.pickup.id)
    expect((await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipA.id}/ship`, {})).shipment.status).toBe('SHIPPED')
    await settle()
    const delivered = await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipA.id}/own-transport/events`, { status: 'DELIVERED', description: 'Handed over at the customer’s dock (made up)' }, 201)
    expect(JSON.stringify(delivered)).toContain('DELIVERED')
    await settle()
    const pod = await ok(P.warehouse, 'GET', `/shipping/shipments/${G.shipA.id}/pod`)
    const signedAt = pod.deliveredAt
    const recorded = await ok(P.warehouse, 'PUT', `/shipping/shipments/${G.shipA.id}/pod`, { signedBy: 'Made-up Receiver', signedAt })
    expect(recorded.pod ?? recorded).toMatchObject({ signedBy: 'Made-up Receiver' })
    const kept = await ok(P.warehouse, 'PUT', `/shipping/shipments/${G.shipA.id}/pod`, { signedBy: 'Someone else' }, 409)
    expect(refusalOf(kept)).toBe('refusal/KEPT')
    await settle()
  })

  it('S07 the desk takes the site live (a fresh code); the 54s are packed in one carton by serial, their DDT, the carrier’s label bought through Sendcloud (FAKE), shipped; the day’s manifest closes with both shipments and its PDF', async () => {
    const mode = (await ok(P.warehouse, 'GET', `/shipping/test-mode?siteId=${siteA1()}`)).sites.find((entry: Json) => entry.siteId === siteA1())
    await stepped(w, P.warehouse)
    await ok(P.warehouse, 'PUT', `/shipping/sites/${siteA1()}/test-mode`, { testMode: false, version: mode.version })
    const url = `/shipping/packing/${G.shipB.id}`
    const serials = G.serials[(G.wo.cells as Json[]).find((cell) => cell.size === '54')!.id] as Json[]
    let carton = ''
    for (const serial of serials) carton = (await ok(P.warehouse, 'POST', `${url}/scan`, { code: serial.serial })).scan.parcelId
    expect((await ok(P.warehouse, 'POST', `${url}/cartons/${carton}/close`, { grossWeightKg: '4.3', printerId: G.labelPrinter })).marks).toMatchObject({ printed: true })
    expect((await ok(P.warehouse, 'POST', `${url}/pack`, {})).shipment.status).toBe('PACKED')
    G.ddtB = (await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipB.id}/ddt`, {}, 201)).ddt
    keep(G.ddtB.id)
    const bought = await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipB.id}/labels`, {}, 201)
    expect(bought.problem ?? null).toBeNull()
    G.trackingB = bought.parcels[0].trackingNumber
    expect(bought.parcels[0].test).not.toBe(true)
    expect((await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipB.id}/ship`, {})).shipment.status).toBe('SHIPPED')
    await settle()
    const day = await ok(P.warehouse, 'GET', `/shipping/end-of-day?siteId=${siteA1()}`)
    const ours = (day.carriers as Json[]).find((entry) => (entry.shipments as Json[]).some((row) => row.id === G.shipB.id))!
    expect((ours.shipments as Json[]).map((row) => row.id)).toEqual(expect.arrayContaining([G.shipA.id, G.shipB.id]))
    const closed = await ok(P.warehouse, 'POST', '/shipping/end-of-day/close', { siteId: siteA1(), carrierCodes: [ours.carrierCode] })
    const outcome = (closed.outcomes as Json[]).find((row) => row.carrierCode === ours.carrierCode)!
    expect(outcome).toMatchObject({ closed: true })
    G.manifest = outcome.manifestId
    keep(outcome.manifestId)
    const sheet = (await ok(P.warehouse, 'GET', `/shipping/manifests/${G.manifest}`)).manifest
    expect(sheet).toMatchObject({ state: 'CLOSED', closedBy: 'PERSON' })
    const file = await ok(P.warehouse, 'GET', `/shipping/manifests/${G.manifest}/pdf`)
    expect(file.file).toMatchObject({ contentType: 'application/pdf' })
    const again = await ok(P.warehouse, 'POST', '/shipping/end-of-day/close', { siteId: siteA1(), carrierCodes: [ours.carrierCode] })
    expect((again.outcomes as Json[]).find((row) => row.carrierCode === ours.carrierCode)).toMatchObject({ closed: false, refusal: { code: 'ALREADY_CLOSED' } })
    await settle()
  })

  it('S08 the carrier delivers the 54s: the scheduler’s tracking poll records it, the worker asks the carrier for its proof of delivery; every shipment arrived: the order is DELIVERED', async () => {
    const after = Math.max(Date.now(), w.h.clock.now().getTime())
    w.sendcloud.advance(G.trackingB, 'IN_TRANSIT', 'unused', new Date(after + 60_000))
    w.sendcloud.advance(G.trackingB, 'DELIVERED', 'unused', new Date(after + 120_000))
    const tick = await runTrackingPoll({ database: w.h.database, log: QUIET, clock: { now: () => new Date(Date.now() + 12 * 3_600_000 + 5 * 60_000) } })
    expect(tick.failed).toBe(0)
    await settle()
    const pod = await ok(P.warehouse, 'GET', `/shipping/shipments/${G.shipB.id}/pod`)
    expect(pod).toMatchObject({ deliveredVia: 'CARRIER', pod: { signedBy: expect.any(String) } })
    const deliveries = await ok(P.sales, 'GET', `/sales/orders/${G.order.id}/deliveries`)
    expect(deliveries.order).toMatchObject({ status: 'DELIVERED', deliveredAt: expect.any(String) })
    expect((deliveries.shipments as Json[]).map((row) => row.deliveredVia).sort()).toEqual(['CARRIER', 'TYPED'])
  })

  // ---- I: invoices -------------------------------------------------------------------------------------------------------------

  it('I01 finance runs the month’s invoices for P1 (invoiced monthly): one TD24 of both DDTs, the balance’s deposit invoice deducted, in the order’s currency; issued and sent with a fresh code, SDI (FAKE) delivers it', async () => {
    const month = today().slice(0, 7)
    const candidates = await ok(P.finance, 'GET', `/invoicing/runs/candidates?companyId=${companyA()}&month=${month}`)
    expect((candidates.customers as Json[]).find((entry) => entry.partyId === P1())).toMatchObject({ invoiceTiming: 'MONTHLY' })
    // A preview of the month made before today's DDTs (the seeds keep one for November) is deleted first (its drafts let go).
    const previews = (await ok(P.finance, 'GET', `/invoicing/runs?companyId=${companyA()}&month=${month}&status=PREVIEW`)).runs as Json[]
    for (const row of previews) {
      const detail = (await ok(P.finance, 'GET', `/invoicing/runs/${row.id}`)).run
      if ((detail.customers as Json[]).some((entry) => entry.partyId === P1())) await ok(P.finance, 'DELETE', `/invoicing/runs/${row.id}?version=${detail.version}`)
    }
    const run = (await ok(P.finance, 'POST', '/invoicing/runs', { companyId: companyA(), month, partyIds: [P1()] }, 201)).run as Json
    keep(run.id)
    const customer = (run.customers as Json[]).find((entry) => entry.partyId === P1())!
    expect(customer.invoice, JSON.stringify(customer)).toMatchObject({ docType: 'TD24', status: 'DRAFT', ready: true, problems: [] })
    const draft = (await ok(P.finance, 'GET', `/invoicing/invoices/${customer.invoice.id}`)).invoice
    const ddtIds = new Set((draft.lines as Json[]).map((line) => line.ddtId).filter(Boolean))
    expect([...ddtIds]).toEqual(expect.arrayContaining([G.ddtA.id, G.ddtB.id]))
    expect((draft.lines as Json[]).some((line) => line.kind === 'DEPOSIT_DEDUCTION' && line.netAmount < 0), JSON.stringify(draft.lines.map((line: Json) => [line.kind, line.netAmount]))).toBe(true)
    // In the order's currency (euro: no rate to keep); its language decided from the customer.
    const panel = (await ok(P.finance, 'GET', `/invoicing/invoices/${draft.id}/language-currency`)).languageCurrency
    expect(panel).toMatchObject({ currency: { code: G.order.currency, euro: true }, rate: null, waits: null })
    await stepped(w, P.finance)
    const issued = await ok(P.finance, 'POST', `/invoicing/runs/${run.id}/issue`, { version: run.version, send: true })
    expect(issued.issued).toEqual([expect.objectContaining({ invoiceId: draft.id, number: expect.any(String), sent: true, sendProblem: null })])
    expect(issued.run).toMatchObject({ status: 'ISSUED' })
    await settle()
    await runSdiPoll({ database: w.h.database, log: QUIET, clock: { now: () => new Date(Date.now() + 3_600_000) } })
    await settle()
    G.td24 = (await ok(P.finance, 'GET', `/invoicing/invoices/${draft.id}`)).invoice
    expect(G.td24).toMatchObject({ docType: 'TD24', status: 'DELIVERED', currency: 'EUR' })
    keep(G.td24.id)
  })

  it('I02 one 54 comes back the wrong size: sales makes the RMA from the TD24; the return label is booked with the carrier (FAKE) for the customer', async () => {
    const { lines } = await ok(P.sales, 'GET', `/sales/returns/returnable?companyId=${companyA()}&partyId=${P1()}&invoiceId=${G.td24.id}`)
    const row = (lines as Json[]).find((line) => line.invoice?.id === G.td24.id && line.size === '54')!
    expect(row).toMatchObject({ left: SIZES['54'] })
    const made = await ok(P.sales, 'POST', '/sales/returns', { companyId: companyA(), partyId: P1(), customerRef: 'P1-RET-GF6-1', lines: [{ invoiceLineId: row.invoiceLineId, quantity: 1, reasonCode: 'WRONG_SIZE', reasonNote: 'One 54 too big: the rider needs a 52 (made up).' }] }, 201)
    G.rma = made.return
    keep(made.return.id)
    const offer = await ok(P.sales, 'GET', `/sales/returns/${G.rma.id}/return-labels`)
    expect(offer.make.held ?? null, JSON.stringify(offer.make)).toBeNull()
    const label = await ok(P.sales, 'POST', `/sales/returns/${G.rma.id}/return-labels`, { mode: 'LABEL', shipmentId: G.shipB.id }, 201)
    expect(JSON.stringify(label)).toContain('BOOKED')
    await settle()
  })

  it('I03 finance switches on the stamp duty and the declarations of intent (a fresh code); a TD01 to P1 naming its checked declaration: the lines N3.5 with the declaration’s law, the stamp duty line added by itself; issued, sent, rejected by SDI, corrected with new lines (still one stamp duty line), sent again and delivered; the quarter counts it once', async () => {
    const settings = ((await ok(P.finance, 'GET', '/invoicing/tax/settings')).companies as Json[]).find((entry) => entry.companyId === companyA())!
    await stepped(w, P.finance)
    const switched = await ok(P.finance, 'PUT', `/invoicing/tax/settings/${companyA()}`, { version: settings.version, stampDutyOn: true, declarationsOfIntentOn: true })
    expect(switched.company.switches).toMatchObject({ stampDutyOn: true, declarationsOfIntentOn: true })
    const declaration = ((await ok(P.finance, 'GET', `/invoicing/declarations-of-intent?companyId=${companyA()}&partyId=${P1()}`)).declarations as Json[]).find((entry) => entry.state === 'CHECKED')!
    expect(declaration).toBeDefined()
    let draft = (
      await ok(P.finance, 'POST', '/invoicing/invoices', {
        companyId: companyA(),
        buyerPartyId: P1(),
        docType: 'TD01',
        causale: 'Sviluppo modello giacca 2027 (made up)',
        payment: { method: 'MP12', dueDate: today() },
        lines: [{ description: 'Sviluppo modello e prototipo, giacca touring 2027', quantity: '1', uom: 'PZ', unitPrice: '450.00' }],
      }, 201)
    ).invoice
    keep(draft.id)
    draft = (await ok(P.finance, 'PUT', `/invoicing/invoices/${draft.id}/declaration-of-intent`, { version: draft.version, declarationOfIntentId: declaration.id })).invoice
    const goods = (draft.lines as Json[]).filter((line) => line.chargeKind !== 'STAMP_DUTY')
    expect(goods.every((line) => line.vatNature === 'N3.5'), JSON.stringify(goods)).toBe(true)
    expect((draft.lines as Json[]).filter((line) => line.chargeKind === 'STAMP_DUTY')).toEqual([expect.objectContaining({ kind: 'CHARGE', netAmount: 200, vatNature: 'N1' })])
    const tax = await ok(P.finance, 'GET', `/invoicing/invoices/${draft.id}/tax`)
    expect(tax.stampDuty).toMatchObject({ reason: 'DUE' })
    expect(tax.problems).toEqual([])
    const year = today().slice(0, 4)
    const quarterOf = async () => ((await ok(P.finance, 'GET', `/invoicing/stamp-duty/quarters?companyId=${companyA()}&year=${year}`)).quarters as Json[]).find((quarter) => quarter.quarterStart <= today() && quarter.quarterEnd >= today())!
    const before = await quarterOf()
    await stepped(w, P.finance)
    const issued = (await ok(P.finance, 'POST', `/invoicing/invoices/${draft.id}/issue`, { version: draft.version })).invoice
    expect(issued).toMatchObject({ status: 'ISSUED', stampDutyAmount: 200, vatTotal: 0 })
    // SDI (FAKE) rejects the first file (a made-up 00423): the office corrects it with new lines and sends it again.
    w.sdi.scriptNext({ kind: 'NS', code: '00423' })
    await stepped(w, P.finance)
    await ok(P.finance, 'POST', `/invoicing/invoices/${issued.id}/sdi/send`, {})
    await settle()
    await runSdiPoll({ database: w.h.database, log: QUIET, clock: { now: () => new Date(Date.now() + 3_600_000) } })
    await settle()
    const rejected = (await ok(P.finance, 'GET', `/invoicing/invoices/${issued.id}/sdi`)).sdi
    expect(rejected).toMatchObject({ invoiceStatus: 'REJECTED' })
    await stepped(w, P.finance)
    const corrected = await ok(P.finance, 'PUT', `/invoicing/invoices/${issued.id}/sdi/correction`, { version: rejected.version, lines: [{ description: 'Sviluppo modello e prototipo, giacca touring 2027 (corretto)', quantity: '1', uom: 'PZ', unitPrice: '480.00', vatRatePct: '0', vatNature: 'N3.5', vatLegalRef: 'Art. 8 c.1 lett. c) DPR 633/1972' }] })
    expect(corrected.invoice).toMatchObject({ status: 'REJECTED', number: issued.number, stampDutyAmount: 200 })
    expect((corrected.invoice.lines as Json[]).filter((line) => line.chargeKind === 'STAMP_DUTY')).toHaveLength(1)
    await stepped(w, P.finance)
    await ok(P.finance, 'POST', `/invoicing/invoices/${issued.id}/sdi/send`, {})
    await settle()
    await runSdiPoll({ database: w.h.database, log: QUIET, clock: { now: () => new Date(Date.now() + 2 * 3_600_000) } })
    await settle()
    G.intentInvoice = (await ok(P.finance, 'GET', `/invoicing/invoices/${issued.id}`)).invoice
    expect(G.intentInvoice).toMatchObject({ status: 'DELIVERED', stampDutyAmount: 200 })
    // Counted at the issue, recounted by the correction and the resend from the invoices as they stand: once, nothing stale.
    const after = await quarterOf()
    expect(after.liveCount).toBe(before.liveCount + 1)
    expect(after).toMatchObject({ invoiceCount: after.liveCount, total: after.liveTotal, stale: false })
  })

  it('I04 e-invoicing is in test mode (the banner says so); finance switches on the accountant’s rules (a fresh code) and makes P3’s pending self-invoice: TD17 issued and sent', async () => {
    const settings = ((await ok(P.finance, 'GET', '/invoicing/e-invoicing/settings')).companies as Json[]).find((entry) => entry.companyId === companyA())!
    expect(settings.testMode).toBe(true)
    expect(settings.state.banner).toEqual(expect.any(String))
    await stepped(w, P.finance)
    const on = (await ok(P.finance, 'PUT', `/invoicing/e-invoicing/settings/${companyA()}/rules`, { version: settings.version, selfInvoicesOn: true })).company
    expect(on.rules).toMatchObject({ selfInvoicesOn: true })
    const pending = ((await ok(P.finance, 'GET', `/invoicing/self-invoices?companyId=${companyA()}&status=PENDING`)).selfInvoices as Json[])[0]!
    expect(pending, 'the seeds keep P3’s service invoice waiting for its TD17').toBeDefined()
    const made = (await ok(P.finance, 'POST', '/invoicing/self-invoices', { supplierInvoiceId: pending.supplierInvoice.id, kind: 'TD17' }, 201)).selfInvoice
    expect(made).toMatchObject({ kind: 'TD17', invoice: { docType: 'TD17', status: 'DRAFT' } })
    await stepped(w, P.finance)
    const issued = await ok(P.finance, 'POST', `/invoicing/invoices/${made.invoice.id}/issue`, {})
    expect(issued.invoice).toMatchObject({ docType: 'TD17', status: 'ISSUED' })
    keep(made.invoice.id)
    await stepped(w, P.finance)
    await ok(P.finance, 'POST', `/invoicing/invoices/${made.invoice.id}/sdi/send`, {})
    await settle()
    expect((await ok(P.finance, 'GET', `/invoicing/self-invoices/${made.id}`)).selfInvoice).toMatchObject({ status: 'ISSUED' })
  })

  // ---- B: the bank, Ri.Ba., payables -------------------------------------------------------------------------------------------

  it('B01 P1 pays the TD24 forty cents short: the statement’s line is matched with its reasons, the difference written off within the tolerance; the invoice is paid and the order settled', async () => {
    const amount = (G.td24.grossTotal as number) - 40
    const csv = [CSV_HEADER, `${dmy(today())};${dmy(today())};${euro(amount)};Saldo fattura ${G.td24.number};Seed Customer One S.r.l.;${PAYER};BNK-GF6-0002`].join('\n')
    const fileId = await statementFile('estratto-conto-gf6-2.csv', csv)
    const imported = await ok(P.finance, 'POST', '/payments/bank/statements', { fileId, bankAccountId: G.bankAccount.id }, 201)
    await settle()
    const line = (await ok(P.finance, 'GET', `/payments/bank/lines/${imported.lineIds[0]}`)).line
    const best = line.suggestions[0]
    expect(best, JSON.stringify(line.suggestions)).toMatchObject({ confidence: 'HIGH', items: [expect.objectContaining({ id: G.td24.id })], difference: { kind: 'UNDERPAYMENT', amount: 40, writable: true } })
    expect((best.reasons as Json[]).map((reason) => reason.code)).toEqual(expect.arrayContaining(['NUMBER_IN_REFERENCE', 'IBAN_KNOWN']))
    const accepted = await ok(P.finance, 'POST', `/payments/bank/matches/${best.id}/accept`, { version: best.version, writeOff: { reason: 'ROUNDING' } })
    G.td24Payment = accepted.paymentId
    keep(accepted.paymentId)
    const writeOffs = await ok(P.finance, 'GET', `/payments/${accepted.paymentId}/write-offs`)
    expect(writeOffs.writeOffs).toEqual([expect.objectContaining({ kind: 'UNDERPAYMENT', amount: 40, reason: 'ROUNDING' })])
    await settle()
    const open = await ok(P.finance, 'GET', `/payments/open-items?companyId=${companyA()}&partyId=${P1()}`)
    expect((open.items as Json[]).find((item) => item.id === G.td24.id)).toBeUndefined()
  })

  it('B02 the Owner switches Ri.Ba. on (a fresh code); finance presents the stamp-duty invoice’s instalment in a batch (its CBI file); the bank returns it unpaid with a fee: the invoice is open again, the unpaid tile counts it, and finance charges the fee with a debit note (TD05) issued and sent', async () => {
    const settings = await ok(P.owner, 'GET', `/receivables/collections/settings?companyId=${companyA()}`)
    await stepped(w, P.owner)
    await ok(P.owner, 'PUT', '/receivables/collections/settings', { companyId: null, ribaOn: true, version: settings.version })
    const candidates = await ok(P.finance, 'GET', `/receivables/riba/candidates?companyId=${companyA()}&dueFrom=${today()}&dueTo=${today()}`)
    expect(JSON.stringify(candidates)).toContain(G.intentInvoice.id)
    let batch = (await ok(P.finance, 'POST', '/receivables/riba/batches', { companyId: companyA(), dueFrom: today(), dueTo: today(), items: [{ invoiceId: G.intentInvoice.id, instalment: 1 }] }, 201)).batch
    keep(batch.id)
    batch = (await ok(P.finance, 'POST', `/receivables/riba/batches/${batch.id}/issue`, { version: batch.version, siaCode: 'A0000', banks: [{ partyId: P1(), abi: '00000', cab: '00000', name: 'Banca di Prova (made up)' }] })).batch
    expect(batch).toMatchObject({ status: 'ISSUED', file: { id: expect.any(String) } })
    const item = (batch.items as Json[])[0]!
    batch = (await ok(P.finance, 'POST', `/receivables/riba/batches/${batch.id}/settle`, { version: batch.version, items: [{ itemId: item.id, status: 'UNPAID', settledOn: today(), unpaidFee: 350 }] })).batch
    expect((batch.items as Json[])[0]).toMatchObject({ status: 'UNPAID', unpaidFee: 350 })
    const unpaid = await ok(P.finance, 'GET', `/receivables/riba/unpaid?companyId=${companyA()}`)
    expect(JSON.stringify(unpaid)).toContain(G.intentInvoice.id)
    await settle()
    const note = (await ok(P.finance, 'POST', `/invoicing/invoices/${G.intentInvoice.id}/debit-note`, { causale: 'Spese di insoluto Ri.Ba. (made up)', lines: [{ description: 'Spese di insoluto Ri.Ba.', quantity: '1', uom: 'PZ', unitPrice: '3.50', vatRatePct: '22' }] }, 201)).invoice
    expect(note).toMatchObject({ docType: 'TD05', status: 'DRAFT' })
    keep(note.id)
    await stepped(w, P.finance)
    expect((await ok(P.finance, 'POST', `/invoicing/invoices/${note.id}/issue`, { version: note.version })).invoice).toMatchObject({ docType: 'TD05', status: 'ISSUED' })
    await stepped(w, P.finance)
    await ok(P.finance, 'POST', `/invoicing/invoices/${note.id}/sdi/send`, {})
    await settle()
  })

  it('B03 P2’s invoices arrive through the FAKE SDI inbox: the hides and protectors (mapped to the order, matched to the receipt) and the hides’ freight (a charge); the second finance person approves the goods invoice', async () => {
    const lineOf = (itemId: string) => (G.po.lines as Json[]).find((entry) => (entry.item?.id ?? entry.itemId) === itemId)!
    const [hides, protectors] = [lineOf(leather()), lineOf(protector())]
    deliverFromP2({
      number: 'GF6-PEL-0001',
      progressive: 'GF601',
      orders: [{ number: G.po.number }],
      lines: [
        { description: 'Pelle bovina nera', quantity: '560', uom: 'FT2', unitPrice: hides.unitPrice, itemCode: hides.supplierArticleCode },
        { description: 'Protezione spalla livello 2', quantity: String(Number(protectors.confirmedQuantity ?? protectors.quantity)), uom: 'PZ', unitPrice: protectors.unitPrice, itemCode: protectors.supplierArticleCode },
      ],
    })
    deliverFromP2({ number: 'GF6-TR-0001', progressive: 'GF602', lines: [{ description: 'Trasporto pelli DDT-GF6-M1', quantity: '1', unitPrice: '45.00' }] })
    const pickup = await ok(P.finance, 'POST', '/payables/sdi/pickup', { companyId: companyA() })
    const goods = (pickup.recorded as Json[]).find((entry) => entry.number === 'GF6-PEL-0001')!
    const freight = (pickup.recorded as Json[]).find((entry) => entry.number === 'GF6-TR-0001')!
    expect(goods, JSON.stringify(pickup)).toMatchObject({ matchStatus: 'MATCHED' })
    keep(goods.invoiceId, freight.invoiceId)
    await settle()
    let invoice = (await ok(P.finance2, 'GET', `/payables/invoices/${goods.invoiceId}`)).invoice
    expect(invoice.approval.ready, JSON.stringify(invoice.approval)).toBe(true)
    invoice = (await ok(P.finance2, 'POST', `/payables/invoices/${invoice.id}/approve`, { version: invoice.version, note: 'Hides and protectors received as ordered (made up).' })).invoice
    expect(invoice).toMatchObject({ status: 'APPROVED' })
    G.goodsInvoice = invoice
    // The freight line is a charge (the office maps it): it lands on the lots below.
    const tr = (await ok(P.finance, 'GET', `/payables/invoices/${freight.invoiceId}`)).invoice
    const mapped = (await ok(P.finance, 'PATCH', `/payables/invoices/${tr.id}/lines/${tr.lines[0].id}`, { version: tr.version, kind: 'CHARGE' })).invoice
    G.freightLine = (mapped.lines as Json[])[0]
    expect(G.freightLine).toMatchObject({ kind: 'CHARGE' })
    await settle()
  })

  it('B04 the week’s payment proposal: finance makes it (the seeded draft cancelled first), may not approve its own (refused), the second finance person approves it with a fresh code to the supplier’s verified account', async () => {
    for (const row of (await ok(P.finance, 'GET', `/payables/proposals?companyId=${companyA()}&status=DRAFT`)).items as Json[]) {
      await ok(P.finance, 'POST', `/payables/proposals/${row.id}/cancel`, { version: row.version, reason: 'Made again for this week (made up).' })
    }
    const made = (await ok(P.finance, 'POST', '/payables/proposals', { companyId: companyA() }, 201)).proposal
    keep(made.id)
    const record = (await ok(P.finance, 'GET', `/payables/proposals/${made.id}`)).proposal
    const ours = (record.lines as Json[]).find((line) => line.invoice?.id === G.goodsInvoice.id || line.invoiceId === G.goodsInvoice.id)
    expect(ours, JSON.stringify(record.lines)).toBeDefined()
    expect((record.lines as Json[]).every((line) => line.account?.usable === true), JSON.stringify(record.lines)).toBe(true)
    const own = await ok(P.finance, 'POST', `/payables/proposals/${made.id}/approve`, { version: record.version }, 409)
    expect(refusalOf(own) ?? pathsOf(own).join(' ')).toMatch(/OWN_PROPOSAL/)
    await stepped(w, P.finance2)
    const approved = await ok(P.finance2, 'POST', `/payables/proposals/${made.id}/approve`, { version: record.version })
    expect(approved.proposal).toMatchObject({ status: 'APPROVED' })
    await settle()
  })

  // ---- W: the work order closed ------------------------------------------------------------------------------------------------

  it('W01 the planner closes the work order: outside the tolerance a reason is asked (refused without one), closed with it and its variances split; undone by the closer within the minute, closed again', async () => {
    const url = `/production/work-orders/${G.wo.id}`
    const check = await ok(P.planner, 'GET', `${url}/close-check`)
    expect(check, JSON.stringify(check.beyond)).toMatchObject({ closable: true, reasonNeeded: true })
    const without = await ok(P.planner, 'POST', `${url}/close`, {}, 409)
    expect(refusalOf(without)).toBe('refusal/REASON_NEEDED')
    const closed = await ok(P.planner, 'POST', `${url}/close`, { reasonCode: 'LEATHER_YIELD', reasonNote: 'Whole hides cut one set each: more leather than the standard (made up).' })
    expect(JSON.stringify(closed)).toContain('CLOSED')
    const first = await ok(P.finance, 'GET', `/costing/work-orders/${G.wo.id}/close`)
    expect((first.closes as Json[])[0], JSON.stringify(first.closes?.[0])).toMatchObject({ lines: expect.any(Array) })
    expect(((first.closes as Json[])[0]!.lines as Json[]).length).toBeGreaterThan(0)
    await settle()
    await ok(P.planner, 'POST', `${url}/close/undo`, {})
    expect((await ok(P.planner, 'GET', url)).workOrder.status).toBe('COMPLETED')
    await settle()
    await ok(P.planner, 'POST', `${url}/close`, { reasonCode: 'LEATHER_YIELD', reasonNote: 'Whole hides cut one set each: more leather than the standard (made up).' })
    expect((await ok(P.planner, 'GET', url)).workOrder.status).toBe('CLOSED')
    const variances = await ok(P.finance, 'GET', `/costing/variances?workOrderId=${G.wo.id}`)
    expect((variances.rows as Json[]).length).toBeGreaterThan(0)
    await settle()
  })

  it('W02 two spare protectors come back to the shelf after the close: the cost waits for a reopen, in words (the worker writes nothing and never fails)', async () => {
    await ok(P.warehouse, 'POST', `/inventory/picking/work-orders/${G.wo.id}/return`, { lotId: G.protectorLot.id, quantity: '2' }, 201)
    await settle()
    const check = await ok(P.planner, 'GET', `/production/work-orders/${G.wo.id}/close-check`)
    expect(check.afterClose).toMatchObject({ count: 1, words: expect.stringMatching(/after the close/) })
  })

  // ---- K: cost of goods sold, PPV, landed cost, the accountant's export -------------------------------------------------------------

  it('K01 the purchase price variance of the hides and protectors at their invoice (company A takes it there), and the cost of goods sold of both shipments by part, posted by the worker', async () => {
    const ppv = await ok(P.finance, 'GET', `/costing/ppv?companyId=${companyA()}&supplierInvoiceId=${G.goodsInvoice.id}`)
    expect((ppv.rows as Json[]).length, JSON.stringify(ppv)).toBeGreaterThan(0)
    for (const shipment of [G.shipA, G.shipB]) {
      const cogs = await ok(P.finance, 'GET', `/costing/cost-of-sales?shipmentId=${shipment.id}`)
      expect((cogs.entries as Json[]).length, JSON.stringify(cogs)).toBeGreaterThan(0)
      expect((cogs.entries as Json[]).every((entry) => entry.amount > 0)).toBe(true)
    }
  })

  it('K02 P2’s freight for the hides lands on the received lots: its charge line allocated by value and posted (the lots’ value carries it)', async () => {
    let allocation = (await ok(P.finance, 'POST', '/costing/landed', { supplierInvoiceLineId: G.freightLine.id, basis: 'VALUE', receiptIds: [G.receipt.id] }, 201)).allocation
    keep(allocation.id)
    expect((allocation.shares as Json[]).reduce((sum, share) => sum + share.amount, 0)).toBe(G.freightLine.netAmount)
    allocation = (await ok(P.finance, 'POST', `/costing/landed/${allocation.id}/post`, { version: allocation.version })).allocation
    expect(allocation).toMatchObject({ status: 'POSTED' })
    await settle()
  })

  it('K03 the accountant’s export: every key Nexus posts mapped to an account, the journals switched on (a fresh code), the month exported with its entries; the supplier renamed afterwards is flagged by the checks, the re-export hands it over as CHANGED and the check passes again', async () => {
    const year = today().slice(0, 4)
    const month = today().slice(0, 7)
    const mapping = await ok(P.finance, 'GET', `/accounting/mapping?companyId=${companyA()}`)
    let n = 0
    for (const entry of (mapping.keys as Json[]).filter((key) => key.posted && key.current === null)) {
      const row = await ok(P.finance, 'POST', '/accounting/mapping', { companyId: companyA(), kind: entry.kind, key: entry.key, accountCode: `GF${String(++n).padStart(4, '0')}`, validFrom: `${year}-01-01` }, 201)
      keep(row.mapping?.id)
    }
    expect((await ok(P.finance, 'GET', `/accounting/mapping?companyId=${companyA()}`)).unmapped).toBe(0)
    const settings = (await ok(P.finance, 'GET', `/accounting/settings?companyId=${companyA()}`)).settings
    await stepped(w, P.finance)
    await ok(P.finance, 'PUT', '/accounting/settings', { companyId: companyA(), journalsOn: true, ...(settings.version === null ? {} : { version: settings.version }), reason: 'The accountant confirmed the chart (made up).' })
    const packages = ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'COST_OF_SALES', 'VAT_REGISTERS']
    const read = await ok(P.finance, 'GET', `/accounting/periods/${month}?companyId=${companyA()}&packages=${packages.join(',')}`)
    const explain = (checks: Json[]) => checks.filter((check) => !check.passed).map((check) => ({ code: check.code, explanation: `Known on the golden day: ${check.code} (made up).` }))
    const batch = (await ok(P.finance, 'POST', '/accounting/exports', { companyId: companyA(), month, packages, explanations: explain(read.checks), language: 'en' }, 201)).export
    keep(batch.id)
    expect((batch.files as Json[]).map((file) => file.file.name).join(' ')).toMatch(/_entries\.csv/)
    const { party } = await ok(P.buyer, 'GET', `/parties/${id('party:P2')}`)
    await ok(P.buyer, 'PATCH', `/parties/${id('party:P2')}`, { version: party.version, legalName: `${party.legalName} (renamed, made up)` })
    const flagged = await ok(P.finance, 'POST', '/accounting/integrity/run', { companyId: companyA() }, 201)
    expect((flagged.checks as Json[]).find((check) => check.code === 'EXPORTED_DOCUMENTS_UNCHANGED')).toMatchObject({ result: 'FAILED' })
    const again = await ok(P.finance, 'GET', `/accounting/periods/${month}?companyId=${companyA()}&packages=${packages.join(',')}`)
    const second = (await ok(P.finance, 'POST', '/accounting/exports', { companyId: companyA(), month, packages, supersedesId: batch.id, explanations: explain(again.checks), language: 'en' }, 201)).export
    keep(second.id)
    expect((await admin<{ change: string }>(w, 'SELECT DISTINCT change::text AS change FROM "ExportedDocument" WHERE "exportId" = $1', [second.id])).map((row) => row.change)).toContain('CHANGED')
    const passed = await ok(P.finance, 'POST', '/accounting/integrity/run', { companyId: companyA() }, 201)
    expect((passed.checks as Json[]).find((check) => check.code === 'EXPORTED_DOCUMENTS_UNCHANGED')).toMatchObject({ result: 'PASSED' })
    await settle()
  })

  // ---- P: a person's data --------------------------------------------------------------------------------------------------------

  it('P01 a rider asks for their data: the privacy desk records the request, checks the identity, the worker collects the package (data and files), it is downloaded and the request done', async () => {
    const contact = (await admin<{ id: string }>(w, `SELECT id FROM "PartyContact" WHERE "tenantId" = $1 AND email = 'rider.p4@example.com'`, [w.tenant.id]))[0]!
    G.riderContact = contact.id
    let request = (await ok(P.admin, 'POST', '/privacy/requests', { companyId: companyA(), personKind: 'CONTACT', personRecordId: contact.id, kind: 'ACCESS', note: 'Asked by mail (made up).' }, 201)).request
    keep(request.id)
    const early = await ok(P.admin, 'POST', `/privacy/requests/${request.id}/collect`, undefined, 409)
    expect(JSON.stringify(early)).toMatch(/identity/i)
    request = (await ok(P.admin, 'POST', `/privacy/requests/${request.id}/identity`, { version: request.version, how: 'Replied from the address we hold (made up).' })).request
    request = (await ok(P.admin, 'POST', `/privacy/requests/${request.id}/collect`, undefined, 202)).request
    await settle()
    const ready = (await ok(P.admin, 'GET', `/privacy/requests/${request.id}`)).request
    expect(ready.collect ?? ready, JSON.stringify(ready.collect)).toMatchObject({ state: 'READY' })
    const download = await ok(P.admin, 'GET', `/privacy/requests/${request.id}/package`)
    expect(download.download.url).toEqual(expect.any(String))
    expect((await ok(P.admin, 'POST', `/privacy/requests/${request.id}/done`, { version: ready.version })).request.status).toBe('DONE')
  })

  it('P02 the rider then asks to be erased: the preview keeps the customer record the orders and invoices refer to (the law’s why); refused without a fresh code, erased with the typed name; the invoices are kept', async () => {
    let request = (await ok(P.admin, 'POST', '/privacy/requests', { companyId: companyA(), personKind: 'CONTACT', personRecordId: G.riderContact, kind: 'ERASURE' }, 201)).request
    keep(request.id)
    request = (await ok(P.admin, 'POST', `/privacy/requests/${request.id}/identity`, { version: request.version, how: 'Called back on the number we hold (made up).' })).request
    const preview = await ok(P.admin, 'GET', `/privacy/requests/${request.id}/erasure`)
    expect(preview.blocked).toBeNull()
    expect(preview.kept).toContainEqual(expect.objectContaining({ recordType: 'Party', why: expect.objectContaining({ code: 'CUSTOMER', words: expect.stringMatching(/invoices/) }) }))
    const noCode = await ok(P.admin, 'POST', `/privacy/requests/${request.id}/erase`, { version: request.version, reason: 'Asked by letter (made up).', confirmName: preview.person.name }, 403)
    expect(pathsOf(noCode)).toContain('stepUp')
    await stepped(w, P.admin)
    const erased = await ok(P.admin, 'POST', `/privacy/requests/${request.id}/erase`, { version: request.version, reason: 'Asked by letter (made up).', confirmName: preview.person.name })
    expect(erased.request).toMatchObject({ person: { erased: true } })
    expect((await ok(P.admin, 'POST', `/privacy/requests/${request.id}/done`, { version: erased.request.version })).request.status).toBe('DONE')
    expect(await admin(w, `SELECT name, email FROM "PartyContact" WHERE id = $1`, [G.riderContact])).toEqual([{ name: '', email: null }])
  })

  // ---- Q: one number everywhere; F: the W2b-5 follow-ups --------------------------------------------------------------------------

  it('Q01 the Owner’s group dashboard reads its five KPIs through the one calculation: each number and its twelve periods are the KPI library’s own reading', async () => {
    const answer = await ok(P.owner, 'GET', '/insights/dashboards/owner-group/numbers?period=MONTH')
    expect((answer.numbers as Json[]).length).toBeGreaterThan(0)
    for (const number of answer.numbers as Json[]) {
      const library = await ok(P.owner, 'GET', `/insights/kpis/${number.kpiKey}/value?period=MONTH&periods=12`)
      expect(number.value, number.kpiKey).toEqual(library.value)
      expect((number.periods as Json[]).map((period) => period.value), number.kpiKey).toEqual((library.periods as Json[]).map((period) => period.value))
    }
  })

  it('F01 a quote approval is never decided by the person who asked: the Owner quotes P1 with a launch discount over the limit and asks for the yes; the Owner’s own yes is refused in words, finance decides', async () => {
    let { quote } = await ok(P.owner, 'POST', '/sales/quotes', { companyId: companyA(), partyId: P1(), customerRef: 'RFQ-GF6-1', promiseDate: '2030-04-30' }, 201)
    keep(quote.id)
    ;({ quote } = await ok(P.owner, 'POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId: jacket(), colourwayId: black(), sizes: Object.entries(SIZES).map(([size, quantity]) => ({ size, quantity })), listUnitPrice: '500', discountPct: '20' }, 201))
    expect(quote.approval.needed).toBe(true)
    ;({ quote } = await ok(P.owner, 'POST', `/sales/quotes/${quote.id}/approval`, { version: quote.version, note: 'Launch discount for the 2027 season (made up)' }))
    expect(quote.status).toBe('PENDING_APPROVAL')
    const own = await ok(P.owner, 'POST', `/sales/quotes/${quote.id}/approval/approve`, { version: quote.version }, 403)
    expect(refusalOf(own)).toBe('refusal/OWN_REQUEST')
    const decided = await ok(P.finance, 'POST', `/sales/quotes/${quote.id}/approval/approve`, { version: quote.version, note: 'Approved for the launch (made up)' })
    expect(decided.decision.status).toEqual({ from: 'PENDING_APPROVAL', to: 'APPROVED' })
    await settle()
  })

  it('F02 a made-to-measure jacket released to the floor: the Owner switches the jacket template’s made-to-measure on (GATE-MTM, a fresh code); the rider measured again (with the height) and the measures confirmed by the reviewer; sales quotes the unit, sent and accepted by link; its own work order is released; the Owner switches made-to-measure off again', async () => {
    const templateUrl = `/product/measurement-templates/${id('product:measurement-template:JACKET')}`
    const template = (await ok(P.owner, 'GET', templateUrl)).template
    await stepped(w, P.owner)
    const on = await ok(P.owner, 'PUT', `${templateUrl}/mtm-rules/switch`, { version: template.version, on: true, reason: 'The first made-to-measure jacket of the season (made up).' })
    let { quote } = await ok(P.sales, 'POST', '/sales/quotes', { companyId: companyA(), partyId: P1(), customerRef: 'RFQ-GF6-MTM-1', promiseDate: '2030-05-31', paymentTermsId: id('pricing:terms:BB30FM'), depositPct: null }, 201)
    keep(quote.id)
    // The rider is measured again in the showroom with the height (the certified range is checked on it), and the factory's
    // reviewer (not the one who measured) confirms the new revision.
    const measured = await ok(P.sales, 'POST', `/sales/mtm/profiles/${first('portal-sales:measurement:P1:rider:JACKET:2')}/revisions`, { measurements: { chest: '101.0', waist: '85.0', sleeve: '65.0', height: '178' }, takenAt: new Date(Date.now() - 60_000).toISOString(), measuredByUserId: P.sales.id, measuredPlace: 'Showroom (made up)', privacyNoticeRef: 'Informativa misure 2026 (made up)', privacyNoticeAt: new Date(Date.now() - 120_000).toISOString() }, 201)
    const profileId = measured.profile.id as string
    keep(profileId)
    await ok(P.owner, 'POST', `/sales/mtm/profiles/${profileId}/review`, { decision: 'CONFIRM', note: 'Measures checked against the base size (made up).', notify: false })
    ;({ quote } = await ok(P.sales, 'POST', `/sales/quotes/${quote.id}/lines/made-to-measure`, { version: quote.version, styleId: jacket(), colourwayId: black(), measurementProfileId: profileId, unitPrice: '680' }, 201))
    const check = await ok(P.sales, 'GET', `/sales/quotes/${quote.id}/send-check`)
    expect((check.checks as Json[]).filter((entry) => entry.severity === 'BLOCKS'), JSON.stringify(check.checks)).toEqual([])
    const sent = await ok(P.sales, 'POST', `/sales/quotes/${quote.id}/send`, { version: quote.version })
    await settle()
    const customer = linkBrowser(w, linkTokenSentTo(w, sent.sent.to))
    await customer.send('POST', '/link/quote/accept', { versionId: sent.sent.versionId, typedName: 'Anna Golden (made up)', email: sent.sent.to })
    await settle()
    const order = ((await ok(P.sales, 'GET', `/sales/orders?partyId=${P1()}&q=RFQ-GF6-MTM-1`)).orders as Json[])[0]!
    const record = (await ok(P.sales, 'GET', `/sales/orders/${order.id}`)).order
    expect(record.status).toBe('CONFIRMED')
    keep(record.id)
    expect(record.lines[0]).toMatchObject({ kind: 'MADE_TO_MEASURE' })
    const { workOrder } = await ok(P.planner, 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: record.lines[0].id }] }, 201)
    keep(workOrder.id)
    expect(workOrder).toMatchObject({ kind: 'MADE_TO_MEASURE' })
    const releaseCheck = await ok(P.planner, 'GET', `/production/work-orders/${workOrder.id}/release-check`)
    const blocked = (releaseCheck.checks as Json[]).filter((entry) => entry.state === 'BLOCKED').map((entry) => entry.code)
    expect(blocked.filter((code) => code !== 'MATERIAL'), JSON.stringify(releaseCheck.checks)).toEqual([])
    const current = (await ok(P.planner, 'GET', `/production/work-orders/${workOrder.id}`)).workOrder
    const released = (await ok(P.planner, 'POST', `/production/work-orders/${workOrder.id}/release`, { version: current.version, ...(blocked.includes('MATERIAL') ? { materialOverride: { reason: 'The leather for the unit comes with the next delivery (made up).' } } : {}) })).workOrder
    expect(released).toMatchObject({ status: 'RELEASED', kind: 'MADE_TO_MEASURE' })
    await settle()
    const back = (await ok(P.owner, 'GET', templateUrl)).template
    await stepped(w, P.owner)
    await ok(P.owner, 'PUT', `${templateUrl}/mtm-rules/switch`, { version: back.version, on: false, reason: 'Back off until the next made-to-measure order (made up).' })
    expect(on).toBeDefined()
    await settle()
  })

  // ---- Z: the end checks ---------------------------------------------------------------------------------------------------------

  it('Z1 every record the flow made has its audit rows; the W2b-6 events fired; the worker never retried; no route answered 500; the outbox is empty', async () => {
    await settle()
    const ids = [...made]
    const audited = new Set((await admin<{ recordId: string }>(w, 'SELECT DISTINCT "recordId"::text AS "recordId" FROM "AuditLog" WHERE "recordId" = ANY($1::uuid[])', [ids])).map((row) => row.recordId))
    const named = (recordId: string) => `${recordId} (${Object.entries(G).filter(([, value]) => JSON.stringify(value ?? null).includes(recordId)).map(([key]) => `G.${key}`).join(', ')})`
    expect(ids.filter((recordId) => !audited.has(recordId)).map(named)).toEqual([])
    const events = new Set((await admin<{ type: string }>(w, 'SELECT DISTINCT type FROM "OutboxEvent" WHERE "tenantId" = $1', [w.tenant.id])).map((row) => row.type))
    expect(EVENTS.filter((type) => !events.has(type)), `seen: ${[...events].sort().join(' ')}`).toEqual([])
    expect(w.retried).toEqual([])
    expect(unexpected.map((report) => `${report.context.method} ${report.context.route}: ${report.name}: ${report.message} ${report.stack.slice(0, 3).join(' | ')}`)).toEqual([])
    expect(await admin(w, `SELECT type, status::text AS status FROM "OutboxEvent" WHERE "tenantId" = $1 AND status <> 'PUBLISHED'`, [w.tenant.id])).toEqual([])
  })
})
