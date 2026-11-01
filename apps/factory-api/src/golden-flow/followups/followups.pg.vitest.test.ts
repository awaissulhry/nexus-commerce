import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lockPhrases, monthLabel, monthOfDay } from '@nexus/factory-domain/accounting/periods'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { textOf } from '../../adapters/ses/fake'
import type { ErrorReport } from '@nexus/factory-domain/observability/report'
import { createErrorTracker, useErrorTracker } from '../../observability/tracker'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { EXPORT_SOURCES } from '../../platform/exports/sources'
import { standardReasonsForNewTenants } from '../../platform/reasons/standard'
import type { SearchIndexer } from '../../platform/search/indexer'
import { indexNewTenants } from '../../platform/search/indexing'
import { admin, announce, call, ok, pdf, person, putBytes, QUIET, startWorld, stepped, type Person, type World } from '../testing/world'
import { assertEveryHandler, everyHandler, searchIndexers, settler } from '../daily/testing/day'

/**
 * The W2b-0 golden flow (B-W2b-36; design check I1): the W2a follow-ups of W2b-0 THROUGH THE HTTP ROUTES, each act by the
 * role that does it, on the seeded factory:
 *
 *   T  a garment reported finished to stock leaves on a shipment: ONE SHIPMENT move per shipment line × place naming the
 *      line (never reversed on its own), the packing list kept as a numbered version, the freight decided by the rule at
 *      leaving, the carrier's freight cost recorded by finance (a cost: the warehouse may not)        (B-W2b-01, -19)
 *   R  the customer sends it back: an RMA from the order line, received, graded, decided — the garment re-enters as a
 *      CUSTOMER_RETURN move naming the RMA line and its customer; closing warns of the replacement not ordered (B-W2b-16)
 *   K  a write-off with a code of the WRITE_OFF list: the code is the move's own column               (B-W2b-01, -15)
 *   B  a claim to the supplier with its letter kept as a version and sent with the mail; the goods go back as SUPPLIER_RETURN
 *      moves carrying the claim's code                                                                 (B-W2b-01, -14)
 *   D  a caparra (no deposit invoice: NONE) asked on a typed order and paid; carried onto the order's invoice in one command
 *      once the invoice is issued                                                                       (B-W2b-02, -21)
 *   Q  a hold numbered from its company's HOLD series, found by its number; an NCR raised from the defect lines picked on an
 *      inspection                                                                                       (B-W2b-02, -17)
 *   S  every record the flow made is found by global search, and the lists that hold them export with them (B-W2b-23, -11)
 *   L  a SOFT lock of the month: the invoice's checks name it, a stock adjustment goes in only with a reason; then the month
 *      closed for good (HARD): refused even with a reason                                              (B-W2a-F8, B-W2b-22)
 *   Z  the end checks: every record made has its audit rows and events, the worker never retried, the outbox is empty
 *
 * World: the W1 golden world (../testing/world.ts: a throwaway PostgreSQL 17 database from the migrations, EVERY base seed
 * plus the W1 golden scenario, the real app with the real sign-in, every outside provider FAKE) and the W2a day's worker
 * (../daily/testing/day.ts: EVERY handler list of background.ts, run in-process by the real outbox relay after each step).
 * The W1 and W2a flows stay as they are (their own suites). Each step is one test, in order. Dates are today's. Every name
 * and number is made up. Run with `node scripts/factory/golden-flow.mjs followups`.
 */

let w: World
let handlers: readonly EventHandler[]
let indexers: readonly SearchIndexer[]
let settle: () => Promise<string[]>
type Role = 'sales' | 'finance' | 'buyer' | 'warehouse' | 'inspector' | 'inspector2'
const P = {} as Record<Role, Person>
type Json = Record<string, any>
/** What the flow made, step by step (ids, versions, documents). */
const G = {} as Record<string, any>
/** What the API reported as unexpected (a 500) during the flow: none at the end. */
const unexpected: ErrorReport[] = []
/** Every record the flow made: the end checks look for their audit rows and events. */
const made = new Set<string>()
const keep = (...ids: (string | undefined | null)[]) => ids.forEach((id) => id && made.add(id))
const today = () => businessDate(new Date())
const id = (key: string) => w.id(key)
const siteA1 = () => id('site:A1')
const companyA = () => id('company:A')

/** The seeded records the flow starts from. */
const S = () => ({
  p1: id('party:P1'),
  p2: id('party:P2'),
  p2Orders: id('party-contact:P2:orders'),
  lining: id('product:item:lining'),
  liningLot: id('inventory:lot:LIN-01'),
  bin: id('inventory:location:A1-STORE-01'),
  // SEED-SO-0002 and its work order WO-0001 (the production seed's SEED-JKT-02): one BLK 52 released, on no shipment.
  so2: id('production:sales-order:SO-0002'),
  wo1: id('production:work-order:WO-0001'),
  blk52: id('production:WO-0001:cell:BLK:52'),
  jkt02: id('production:style:JKT-02'),
  jkt02Revision: `ffffffff${id('production:revision:JKT-02:1').slice(8)}`,
  jkt02Blk52: id('production:variant:JKT-02:BLK:52'),
  // SEED-INS-0002: WO-0001's OPEN inspection (quality seed).
  inspection: `00000000${id('quality:inspection:WO-0001:1').slice(8)}`,
})
/** The fake mail of an outbound e-mail. */
const mailOf = (emailId: string) => w.h.ses.mails.find((entry) => entry.outboundId === emailId)
/** What lies of a lot at one location of A1 (not a hide). */
async function onHand(who: Person, lotId: string, locationId: string): Promise<number> {
  const rows = ((await ok(who, 'GET', `/inventory/stock?siteId=${siteA1()}&lotId=${lotId}&locationId=${locationId}`)).rows as Json[]).filter((row) => row.location.id === locationId && row.hide === null)
  return rows.length === 0 ? 0 : Number(rows[0]!.onHand)
}
/** The moves of a lot, newest first, as the warehouse reads them (GET /inventory/moves). */
async function movesOf(who: Person, query: string): Promise<Json[]> {
  return (await ok(who, 'GET', `/inventory/moves?siteId=${siteA1()}&${query}&limit=500`)).moves as Json[]
}

beforeAll(async () => {
  useErrorTracker(createErrorTracker({ sink: { kind: 'fake', send: (report) => void unexpected.push(report) }, source: 'api' }))
  w = await startWorld()
  indexers = await searchIndexers()
  handlers = everyHandler(indexers)
  settle = settler(w, handlers)
  for (const [key, role] of [
    ['sales', 'sales'],
    ['finance', 'finance'],
    ['buyer', 'buyer'],
    ['warehouse', 'warehouse'],
    ['inspector', 'quality_inspector'],
    ['inspector2', 'quality_inspector'],
  ] as const) {
    P[key] = await person(w, key, role)
  }
}, 1_200_000)

afterAll(async () => {
  useErrorTracker(undefined)
  await w?.close()
}, 60_000)

// One step may take a while on a loaded machine (a step renders PDFs, runs the worker).
describe('the W2b-0 golden flow: the W2a follow-ups through the HTTP routes', { timeout: 180_000 }, () => {
  it('00 the world: the worker runs every handler list of background.ts; the worker’s start work and the seeds drain', async () => {
    G.start = new Date()
    assertEveryHandler()
    await standardReasonsForNewTenants({ database: w.h.database, log: QUIET })
    await indexNewTenants({ database: w.h.database, indexers, log: QUIET })
    await settle()
    expect((await ok(P.warehouse, 'GET', '/auth/office/me')).user.id).toBe(P.warehouse.id)
  })

  // ---- T: a shipment out of finished goods ---------------------------------------------------------------------------------

  it('T00 finance freezes the standard cost of SEED-JKT-02 BLK 52 from its cost sheet: the garment’s moves this month are valued at it', async () => {
    const body = { companyId: companyA(), validFrom: `${monthOfDay(today())}-01`, items: [{ variantId: S().jkt02Blk52 }], note: 'Season standard of the seeded jacket' }
    const prepared = await ok(P.finance, 'POST', '/costing/standards/prepare', body)
    expect(prepared.skipped).toEqual([])
    const [standard] = prepared.prepared as Json[]
    expect((await ok(P.finance, 'POST', `/costing/standards/${standard!.id}/freeze`, { version: standard!.version })).standard).toMatchObject({ status: 'FROZEN' })
    keep(standard!.id)
    await settle()
  })

  it('T01 the warehouse reports WO-0001’s released BLK 52 finished to stock and plans a shipment of SEED-SO-0002 with it (the style’s DoC and leaflet on file)', async () => {
    const s = S()
    // The production seed's SEED-JKT-02 is protective: its garments leave with the signed DoC and leaflet of the order's
    // language on file (W1 step 06): the inspector files them on the style's compliance tab.
    const revisionId = s.jkt02Revision
    for (const kind of ['DECLARATION_OF_CONFORMITY', 'USER_INFORMATION']) {
      const body = pdf(`${kind} it SEED-JKT-02`)
      const announced = await ok(P.inspector, 'POST', `/product/styles/${s.jkt02}/compliance/documents`, { revisionId, kind, language: 'it', ...announce(`${kind.toLowerCase()}-it.pdf`, body) }, 201)
      await putBytes(w, announced, body)
      expect((await ok(P.inspector, 'POST', `/product/styles/${s.jkt02}/compliance/documents/${announced.document.id}/files/${announced.file.id}/complete`)).document.status).toBe('ISSUED')
    }
    const report = await ok(P.warehouse, 'POST', `/production/work-orders/${s.wo1}/finished`, { cells: [{ cellId: s.blk52, quantity: 1 }] }, 201)
    expect(report.report.pieces).toBe(1)
    const ready = await ok(P.warehouse, 'GET', `/shipping/ready?salesOrderId=${s.so2}`)
    expect(ready.orders[0].cells.find((cell: Json) => cell.workOrderSizeId === s.blk52)).toMatchObject({ shippable: 1, inStock: 1 })
    const { shipment } = await ok(P.warehouse, 'POST', '/shipping/shipments', { salesOrderId: s.so2, lines: [{ workOrderSizeId: s.blk52, quantity: 1 }] }, 201)
    expect(shipment).toMatchObject({ status: 'DRAFT', salesOrderId: s.so2, garments: 1 })
    // Nothing decided of the freight yet: no basis.
    expect(await admin(w, `SELECT "freightBasis"::text AS basis FROM "Shipment" WHERE id = $1`, [shipment.id])).toEqual([{ basis: null }])
    G.shipment = shipment
    keep(shipment.id)
    await settle()
  })

  it('T02 packed; the packing list is kept as version 1 (a numbered document of the shipment) and printed again unchanged', async () => {
    const shipment = G.shipment
    const parcel = await ok(P.warehouse, 'POST', `/shipping/packing/${shipment.id}/parcels`, { grossWeightKg: '2.4' }, 201)
    await ok(P.warehouse, 'PUT', `/shipping/packing/${shipment.id}/lines/${shipment.lines[0].id}/parcel`, { parcelId: parcel.parcelId })
    expect((await ok(P.warehouse, 'POST', `/shipping/packing/${shipment.id}/pack`, {})).shipment.status).toBe('PACKED')
    const first = await ok(P.warehouse, 'POST', `/shipping/shipments/${shipment.id}/packing-list`, {}, 201)
    expect(first).toMatchObject({ version: 1, reused: false })
    const again = await ok(P.warehouse, 'POST', `/shipping/shipments/${shipment.id}/packing-list`, {}, 201)
    expect(again).toMatchObject({ version: 1, reused: true, file: { id: first.file.id } })
    expect(await admin(w, `SELECT version, kind::text AS kind, "recordType", "fileId" FROM "GeneratedDocument" WHERE "recordId" = $1`, [shipment.id])).toEqual([{ version: 1, kind: 'PACKING_LIST', recordType: 'Shipment', fileId: first.file.id }])
    const lists = await ok(P.warehouse, 'GET', `/shipping/shipments/${shipment.id}/packing-lists`)
    expect(lists.packingLists.map((entry: Json) => [entry.version, entry.current])).toEqual([[1, true]])
    await settle()
  })

  it('T03 the DDT is issued and the shipment leaves: ONE SHIPMENT move out of finished goods naming the shipment line, the freight by the rule; the move is never reversed on its own', async () => {
    const s = S()
    const left = await ok(P.warehouse, 'POST', `/shipping/shipments/${G.shipment.id}/ddt`, { ship: true }, 201)
    expect(left).toMatchObject({ ddt: { status: 'LIVE', documentDate: today(), shipmentId: G.shipment.id }, shipment: { status: 'SHIPPED' } })
    G.ddt = left.ddt
    keep(left.ddt.id)
    const moves = await admin<Json>(
      w,
      `SELECT id, reason::text AS reason, "shipmentLineId", "toLocationId", "workOrderId", reference, "baseQuantity"::text AS quantity FROM "StockMove" WHERE "idempotencyKey" LIKE $1`,
      [`shipping.fromStock:${G.shipment.id}:%`],
    )
    expect(moves).toEqual([{ id: expect.any(String), reason: 'SHIPMENT', shipmentLineId: G.shipment.lines[0].id, toLocationId: null, workOrderId: s.wo1, reference: left.shipment.number, quantity: '1.0000' }])
    G.shipmentMove = moves[0]!.id
    // Valued as it leaves, at the standard frozen in T00 (B-W2a-F7): the month closes in L02 with nothing unvalued.
    expect(await admin(w, `SELECT method::text AS method FROM "StockValuation" WHERE "moveId" = $1`, [G.shipmentMove])).toEqual([{ method: 'STANDARD_COST' }])
    // The warehouse's ledger read names the reason.
    expect((await movesOf(P.warehouse, `reason=SHIPMENT`)).map((move) => move.id)).toContain(G.shipmentMove)
    // The freight decided at leaving by the site's rule (nobody typed one): the basis is the rule.
    expect(await admin(w, `SELECT "freightBasis"::text AS basis FROM "Shipment" WHERE id = $1`, [G.shipment.id])).toEqual([{ basis: 'RULE' }])
    expect((await ok(P.finance, 'GET', `/shipping/shipments/${G.shipment.id}`)).shipment.freight).toMatchObject({ byHand: false })
    // REFUSAL in words: the garment left with the shipment (a carrier return brings it back).
    const reversed = await ok(P.warehouse, 'POST', `/inventory/moves/${G.shipmentMove}/reverse`, { note: 'Try to undo the shipment' }, 409)
    expect(reversed.error.message).toEqual(expect.any(String))
    expect(await settle()).toContain('shipment.status_changed')
  })

  it('T04 finance records the carrier’s freight cost (cost grain); the warehouse may not, and reads no figure', async () => {
    const before = (await ok(P.warehouse, 'GET', `/shipping/shipments/${G.shipment.id}`)).shipment
    const refused = await ok(P.warehouse, 'PUT', `/shipping/shipments/${G.shipment.id}/freight-cost`, { version: before.version, freightCost: 1_650, currency: 'EUR' }, 403)
    expect(refused.error.message).toEqual(expect.any(String))
    const recorded = await ok(P.finance, 'PUT', `/shipping/shipments/${G.shipment.id}/freight-cost`, { version: before.version, freightCost: 1_650, currency: 'EUR' })
    expect(recorded).toMatchObject({ shipmentId: G.shipment.id, status: 'SHIPPED', freight: { cost: { amount: 1_650, currency: 'EUR' } } })
    expect((await ok(P.finance, 'GET', `/shipping/shipments/${G.shipment.id}`)).shipment.freight.cost).toEqual({ amount: 1_650, currency: 'EUR' })
    expect((await ok(P.warehouse, 'GET', `/shipping/shipments/${G.shipment.id}`)).shipment.freight.cost ?? {}).not.toHaveProperty('amount')
    expect(await admin(w, `SELECT "freightCost", "freightCostCurrency" FROM "Shipment" WHERE id = $1`, [G.shipment.id])).toEqual([{ freightCost: 1_650, freightCostCurrency: 'EUR' }])
    expect(await settle()).toContain('shipment.freight_cost_changed')
  })

  // ---- R: the customer sends it back ---------------------------------------------------------------------------------------

  it('R01 sales opens an RMA for the shipped BLK 52 from its order line (wrong size): AUTHORISED and numbered', async () => {
    const s = S()
    const { lines } = await ok(P.sales, 'GET', `/sales/returns/returnable?companyId=${companyA()}&partyId=${s.p1}&salesOrderId=${s.so2}`)
    const row = (lines as Json[]).find((line) => line.kind === 'SHIPPED' && line.size === '52' && line.colourway?.code === 'BLK' && line.left > 0)
    expect(row, JSON.stringify(lines)).toBeTruthy()
    const made = await ok(
      P.sales,
      'POST',
      '/sales/returns',
      { companyId: companyA(), partyId: s.p1, customerRef: 'P1-RET-W2B0-1', lines: [{ salesOrderLineId: row!.salesOrderLineId, size: '52', quantity: 1, reasonCode: 'WRONG_SIZE', reasonNote: 'The rider needs a 54.' }] },
      201,
    )
    expect(made.return).toMatchObject({ number: expect.stringMatching(/^RMA-\d{4}-\d{4}$/), status: 'AUTHORISED', party: { id: s.p1 } })
    G.rma = { id: made.return.id, number: made.return.number, lineId: made.return.lines[0].id, version: made.return.version }
    keep(made.return.id)
    expect(await settle()).toContain('return.authorised')
  })

  it('R02 the warehouse receives it at the dock; the inspector grades it NEW, no fault', async () => {
    const found = (await ok(P.warehouse, 'GET', `/sales/returns/dock?code=${encodeURIComponent(G.rma.number)}`)).return
    const received = await ok(
      P.warehouse,
      'POST',
      `/sales/returns/${G.rma.id}/receipts`,
      { version: found.version, parcels: 1, parcelCondition: 'INTACT', carrierName: 'Corriere del cliente (made up)', customerDdtNumber: 'P1-DDT-W2B0-1', customerDdtDate: today(), lines: [{ lineId: G.rma.lineId, quantity: 1 }] },
      201,
    )
    expect(received.return.status).toBe('RECEIVED')
    const graded = await ok(P.inspector, 'POST', `/sales/returns/${G.rma.id}/grades`, { version: received.return.version, lines: [{ lineId: G.rma.lineId, grade: 'NEW', cause: 'NO_FAULT', conditionNote: 'Unworn, labels on.' }] })
    expect(graded.return.lines[0]).toMatchObject({ grade: 'NEW', suggestedOutcome: 'RESTOCK', restockHeld: null })
    G.rma = { ...G.rma, version: graded.return.version, finishedGoods: found.places.finishedGoods }
    expect(await settle()).toEqual(expect.arrayContaining(['return.received', 'return.graded']))
  })

  it('R03 sales decides a replacement with the garment back into finished goods: ONE CUSTOMER_RETURN move naming the RMA line and its customer; closing warns of the replacement not ordered yet', async () => {
    const s = S()
    const fg = G.rma.finishedGoods as { id: string; code: string }
    const decided = await ok(P.sales, 'POST', `/sales/returns/${G.rma.id}/decisions`, { version: G.rma.version, lines: [{ lineId: G.rma.lineId, disposition: 'REPLACE', goodsOutcome: 'RESTOCK', toLocationId: fg.id }] })
    expect(decided.return).toMatchObject({ status: 'INSPECTED', lines: [{ disposition: 'REPLACE', goodsOutcome: 'RESTOCK', followUp: 'REPLACEMENT_ORDER' }] })
    expect(decided.moves).toEqual([{ lineId: G.rma.lineId, moveId: expect.any(String), locationId: fg.id }])
    expect(await admin(w, `SELECT reason::text AS reason, "returnLineId", "returnPartyId", "toLocationId", "fromLocationId" FROM "StockMove" WHERE id = $1`, [decided.moves[0].moveId])).toEqual([
      { reason: 'CUSTOMER_RETURN', returnLineId: G.rma.lineId, returnPartyId: s.p1, toLocationId: fg.id, fromLocationId: null },
    ])
    expect((await movesOf(P.warehouse, 'reason=CUSTOMER_RETURN')).map((move) => move.id)).toContain(decided.moves[0].moveId)
    // The record says, before anyone presses Close, what the close would leave open.
    const record = (await ok(P.sales, 'GET', `/sales/returns/${G.rma.id}`)).return
    expect((record.closeWarnings as Json[]).map((warning) => warning.code)).toEqual(['REPLACE_WITHOUT_ORDER'])
    G.rma = { ...G.rma, version: record.version, moveId: decided.moves[0].moveId }
    expect(await settle()).toContain('return.decided')
  })

  // ---- K: a write-off with its reason code ---------------------------------------------------------------------------------

  it('K01 the warehouse writes damaged lining off with a code of the WRITE_OFF list: the code is the move’s own column', async () => {
    const s = S()
    const before = await onHand(P.warehouse, s.liningLot, s.bin)
    const { writeOff } = await ok(P.warehouse, 'POST', '/inventory/write-offs', { siteId: siteA1(), reasonCode: 'DAMAGED', note: 'Water stain on the end of the roll', reference: 'GF-W2B0-K01', lines: [{ lotId: s.liningLot, fromLocationId: s.bin, quantity: '1.5' }] }, 201)
    expect(writeOff).toMatchObject({ reasonCode: 'DAMAGED', reference: 'GF-W2B0-K01' })
    expect((writeOff.moves as Json[]).map((move) => [move.reason, move.reasonCode, move.baseQuantity])).toEqual([['SCRAP', 'DAMAGED', '1.5000']])
    const listed = (await movesOf(P.warehouse, `lotId=${s.liningLot}&reason=SCRAP`)).find((move) => move.id === writeOff.moves[0].id)
    expect(listed).toMatchObject({ reasonCode: 'DAMAGED' })
    expect(await admin(w, `SELECT "reasonCode" FROM "StockMove" WHERE id = $1`, [writeOff.moves[0].id])).toEqual([{ reasonCode: 'DAMAGED' }])
    expect(await onHand(P.warehouse, s.liningLot, s.bin)).toBeCloseTo(before - 1.5, 4)
    G.writeOff = writeOff
    keep(writeOff.id)
    await settle()
  })

  // ---- B: a claim with its letter, the goods back to the supplier ----------------------------------------------------------

  it('B01 the buyer asks P2 to take back 2 m of the lining roll (a return claim; the roll came without a receipt, so the buyer names the supplier); the code is the claim’s own column', async () => {
    const s = S()
    const unnamed = await ok(P.buyer, 'POST', '/purchasing/claims', { kind: 'RETURN', reasonCode: 'QUALITY', reasonNote: 'Colour runs when wet', lines: [{ lotId: s.liningLot, quantity: '2' }] }, 400)
    expect((unnamed.error.issues as Json[]).map((issue) => issue.path)).toContain('body/partyId')
    const { claim } = await ok(P.buyer, 'POST', '/purchasing/claims', { kind: 'RETURN', partyId: s.p2, siteId: siteA1(), reasonCode: 'QUALITY', reasonNote: 'Colour runs when wet', remedy: 'CREDIT', lines: [{ lotId: s.liningLot, quantity: '2' }] }, 201)
    expect(claim).toMatchObject({ kind: 'RETURN', status: 'DRAFT', supplier: { id: s.p2 }, number: expect.any(String) })
    expect(await admin(w, `SELECT "reasonCode" FROM "SupplierClaim" WHERE id = $1`, [claim.id])).toEqual([{ reasonCode: 'QUALITY' }])
    G.claim = claim
    keep(claim.id)
    expect(await settle()).toContain('supplier_claim.created')
  })

  it('B02 the claim letter: a preview PDF stored nowhere, then kept as version 1; the same contents again keep nothing', async () => {
    const preview = await call(P.buyer.browser, 'GET', `/purchasing/claims/${G.claim.id}/letter?language=it`)
    expect(preview.status, JSON.stringify(preview.body).slice(0, 300)).toBe(200)
    expect(String(preview.response.headers['content-type'])).toContain('application/pdf')
    expect(await admin(w, `SELECT 1 FROM "GeneratedDocument" WHERE "recordId" = $1`, [G.claim.id])).toEqual([])
    const kept = await ok(P.buyer, 'POST', `/purchasing/claims/${G.claim.id}/letter`, { language: 'it' }, 201)
    expect(kept).toMatchObject({ made: true })
    const again = await ok(P.buyer, 'POST', `/purchasing/claims/${G.claim.id}/letter`, { language: 'it' }, 201)
    expect(again).toMatchObject({ made: false })
    const rows = await admin<Json>(w, `SELECT version, kind::text AS kind, "recordType", language, "fileId" FROM "GeneratedDocument" WHERE "recordId" = $1`, [G.claim.id])
    expect(rows).toEqual([{ version: 1, kind: 'CLAIM_LETTER', recordType: 'SupplierClaim', language: 'it', fileId: expect.any(String) }])
    const record = (await ok(P.buyer, 'GET', `/purchasing/claims/${G.claim.id}`)).claim
    expect((record.letters as Json[]).map((letter) => letter.version)).toEqual([1])
    G.claim = record
    G.letterFile = rows[0]!.fileId
    expect(await settle()).toContain('supplier_claim.updated')
  })

  it('B03 the buyer sends the claim to P2’s orders contact: the letter goes with the mail (FAKE SES)', async () => {
    const check = await ok(P.buyer, 'GET', `/purchasing/claims/${G.claim.id}/send-check`)
    expect(check).toMatchObject({ ready: true, letter: { attached: true, problems: [] } })
    const sent = await ok(P.buyer, 'POST', `/purchasing/claims/${G.claim.id}/send`, { version: G.claim.version, mail: { contactIds: [S().p2Orders] } })
    expect(sent.claim).toMatchObject({ status: 'SENT' })
    expect(sent.letterId).toEqual(expect.any(String))
    expect(await settle()).toContain('supplier_claim.sent')
    const mail = mailOf(sent.emailId)
    expect(mail, 'the claim in the FAKE mailbox').toBeTruthy()
    expect(textOf(mail!.raw)).toEqual(expect.any(String))
    expect(mail!.raw).toMatch(/Content-Type: application\/pdf/)
    G.claim = sent.claim
  })

  it('B04 the warehouse sends the 2 m back on the claim with a RETURN DDT: SUPPLIER_RETURN moves carrying the claim’s code', async () => {
    const s = S()
    const before = await onHand(P.warehouse, s.liningLot, s.bin)
    const record = (await ok(P.warehouse, 'GET', `/purchasing/claims/${G.claim.id}`)).claim
    const returned = await ok(P.warehouse, 'POST', `/purchasing/claims/${G.claim.id}/return`, { version: record.version, ddt: { transportBy: 'SENDER', packages: 1, grossWeightKg: '1.2' } }, 201)
    expect(returned.moveIds).toHaveLength(1)
    expect(returned.ddt).toMatchObject({ number: expect.any(String), pdfProblem: null })
    expect(await admin(w, `SELECT reason::text AS reason, "reasonCode", "baseQuantity"::text AS quantity, "toLocationId" FROM "StockMove" WHERE id = ANY($1::uuid[])`, [returned.moveIds])).toEqual([
      { reason: 'SUPPLIER_RETURN', reasonCode: 'QUALITY', quantity: '2.0000', toLocationId: null },
    ])
    expect(await onHand(P.warehouse, s.liningLot, s.bin)).toBeCloseTo(before - 2, 4)
    G.returnDdt = returned.ddt
    keep(returned.ddt.id)
    expect(await settle()).toEqual(expect.arrayContaining(['supplier_claim.goods_returned']))
  })

  // ---- D: a caparra paid without a deposit invoice, carried onto the order's invoice -----------------------------------------

  it('D01 sales types an order for P1 with a 30 % caparra: its deposit request issues no deposit invoice (NONE)', async () => {
    const s = S()
    const body = {
      companyId: companyA(),
      partyId: s.p1,
      customerRef: 'PO-GOLDEN-W2B0-CAPARRA',
      promiseDate: addDays(today(), 42),
      depositPct: '30',
      depositKind: 'CAPARRA',
      lines: [{ styleId: id('product:style:JKT-01'), colourwayId: id('product:colourway:JKT-01:BLK'), sizes: [{ size: '50', quantity: 1 }] }],
    }
    const { order } = await ok(P.sales, 'POST', '/sales/orders/manual', body, 201)
    expect(order).toMatchObject({ status: 'CONFIRMED', depositRequired: true })
    const request = order.chain.depositRequests[0]
    expect(request).toBeTruthy()
    expect(await admin(w, `SELECT kind::text AS kind, "fiscalDocument"::text AS fiscal, "fiscalRule", amount, status::text AS status FROM "DepositRequest" WHERE id = $1`, [request.id])).toEqual([
      { kind: 'CAPARRA', fiscal: 'NONE', fiscalRule: 'CAPARRA_CONFIRMATORIA', amount: Math.round(order.grossAmount * 0.3), status: 'OPEN' },
    ])
    G.order = order
    G.deposit = { id: request.id, amount: Math.round(order.grossAmount * 0.3) }
    keep(order.id, request.id)
    expect(await settle()).toContain('deposit_request.created_for_order')
  })

  it('D02 finance records the caparra paid; with no invoice of the order yet nothing can be carried (refused in words)', async () => {
    const { payment } = await ok(P.finance, 'POST', '/payments', { companyId: companyA(), partyId: S().p1, amount: G.deposit.amount, receivedOn: today(), externalRef: 'CRO-GOLDEN-W2B0-CAPARRA', allocations: [{ depositRequestId: G.deposit.id }] }, 201)
    expect(await admin(w, `SELECT status::text AS status FROM "DepositRequest" WHERE id = $1`, [G.deposit.id])).toEqual([{ status: 'PAID' }])
    G.payment = payment
    keep(payment.id)
    const early = await ok(P.finance, 'POST', `/payments/deposit-requests/${G.deposit.id}/carry`, {}, 409)
    expect(early.error.message).toContain('has no issued invoice (TD01 or TD24) open yet')
    // A person's reverse of the caparra's allocation is refused: it is carried, not taken back.
    const reversal = await ok(P.finance, 'POST', `/payments/${payment.id}/allocations/${payment.allocations[0].id}/reverse`, { note: 'Try' }, 409)
    expect(reversal.error.message).toContain('carry it onto the order')
    await settle()
  })

  it('D03 finance invoices the order (an immediate TD01 typed from the order) and issues it; the open items name the caparra waiting to be carried', async () => {
    const draft = (
      await ok(
        P.finance,
        'POST',
        '/invoicing/invoices',
        { companyId: companyA(), buyerPartyId: S().p1, docType: 'TD01', salesOrderId: G.order.id, lines: [{ description: 'Giacca moto in pelle SEED-JKT-01, nero, taglia 50', itemCode: 'SEED-JKT-01-BLK-50', quantity: '1', uom: 'PZ', unitPrice: '420.00' }] },
        201,
      )
    ).invoice
    expect(draft).toMatchObject({ status: 'DRAFT', docType: 'TD01', salesOrderId: G.order.id })
    await stepped(w, P.finance)
    const issued = await ok(P.finance, 'POST', `/invoicing/invoices/${draft.id}/issue`, { version: draft.version })
    expect(issued.invoice).toMatchObject({ status: 'ISSUED', number: expect.stringMatching(/^FT-\d{4}-\d{5}$/) })
    G.invoice = issued.invoice
    keep(draft.id)
    await settle()
    const { items } = await ok(P.finance, 'GET', `/payments/open-items?companyId=${companyA()}&partyId=${S().p1}`)
    expect(items.find((item: Json) => item.id === G.invoice.id)).toMatchObject({ noInvoiceDepositAmount: G.deposit.amount, depositToCarry: [{ depositRequestId: G.deposit.id, amount: G.deposit.amount }], carriedDepositAmount: 0 })
  })

  it('D04 finance carries the caparra onto the invoice in ONE command: the allocation reversed and placed on the invoice; twice is refused', async () => {
    const carried = await ok(P.finance, 'POST', `/payments/deposit-requests/${G.deposit.id}/carry`, { invoiceId: G.invoice.id })
    expect(carried).toMatchObject({ depositRequestId: G.deposit.id, orderId: G.order.id, amount: G.deposit.amount, carried: [{ paymentId: G.payment.id, invoiceId: G.invoice.id, amount: G.deposit.amount }] })
    const rows = await admin<Json>(w, `SELECT amount, "invoiceId", "reversalOfId", "carriedFromId" FROM "PaymentAllocation" WHERE "paymentId" = $1 ORDER BY "createdAt", amount`, [G.payment.id])
    expect(rows).toHaveLength(3)
    expect(rows.find((row) => row.invoiceId === G.invoice.id)).toMatchObject({ amount: G.deposit.amount, carriedFromId: expect.any(String) })
    const { items } = await ok(P.finance, 'GET', `/payments/open-items?companyId=${companyA()}&partyId=${S().p1}`)
    expect(items.find((item: Json) => item.id === G.invoice.id)).toMatchObject({ noInvoiceDepositAmount: null, depositToCarry: [], carriedDepositAmount: G.deposit.amount })
    const again = await ok(P.finance, 'POST', `/payments/deposit-requests/${G.deposit.id}/carry`, { invoiceId: G.invoice.id }, 409)
    expect(again.error.message).toContain('carried onto the invoice already')
    expect(await settle()).toEqual(expect.arrayContaining(['payment.deposit_carried', 'payment.allocated', 'payment.allocation_reversed']))
  })

  // ---- Q: a numbered hold; an NCR from the defects picked -------------------------------------------------------------------

  it('Q01 the inspector holds the lining lot: the hold is numbered from company A’s HOLD series and found by its number; another inspector releases it', async () => {
    const s = S()
    const placed = await ok(P.inspector, 'POST', '/quality/holds', { subjectType: 'Lot', subjectIds: [s.liningLot], reasonCode: 'QUALITY_CHECK', reasonNote: 'Check the roll after the colour claim' }, 201)
    expect(placed.hold.number).toMatch(/^HLD-\d{4}-\d{4}$/)
    expect(await admin(w, `SELECT "recordType", kind::text AS kind FROM "NumberAllocation" WHERE "recordId" = $1`, [placed.hold.id])).toEqual([{ recordType: 'QualityHold', kind: 'HOLD' }])
    const found = await ok(P.inspector, 'GET', `/quality/holds?q=${encodeURIComponent(placed.hold.number)}`)
    expect(found.holds.map((row: Json) => row.id)).toEqual([placed.hold.id])
    keep(placed.hold.id)
    await settle()
    const record = await ok(P.inspector2, 'GET', `/quality/holds/${placed.hold.id}`)
    await stepped(w, P.inspector2)
    const freed = await ok(P.inspector2, 'POST', `/quality/holds/${placed.hold.id}/release`, { version: record.hold.version, note: 'Roll checked: the rest is fine.', notMakerStatement: true })
    expect(freed.hold).toMatchObject({ status: 'RELEASED', number: placed.hold.number })
    G.hold = freed.hold
    await settle()
  })

  it('Q02 two defect lines on WO-0001’s open inspection; the NCR is raised from the one picked, its title in parts', async () => {
    const s = S()
    const opened = (await ok(P.inspector, 'GET', `/quality/inspections/${s.inspection}`)).inspection
    const assigned = await ok(P.inspector, 'POST', '/quality/inspections/assign', { inspections: [{ id: opened.id, version: opened.version }], assigneeId: P.inspector2.id })
    const recorded = (
      await ok(P.inspector2, 'PUT', `/quality/inspections/${opened.id}/defects`, {
        version: assigned.inspections[0].version,
        defects: [
          { defectClass: 'MAJOR', code: 'SEAM-OPEN', quantity: 1, defectCodeId: id('holds:defect:SEAM-OPEN'), zone: 'CUFF', description: 'Cuff seam open' },
          { defectClass: 'MINOR', code: 'STITCH-SKIP', quantity: 2, zone: 'CUFF', description: 'Skipped stitches on the cuff' },
        ],
      })
    ).inspection
    const lines = (recorded.defects as Json[]).map((defect) => defect.id as string)
    expect(lines).toHaveLength(2)
    const both = (await ok(P.inspector, 'GET', `/quality/ncr/prefill?recordType=Inspection&recordId=${opened.id}&defectIds=${lines.join(',')}`)).prefill
    expect(both).toMatchObject({ titleParts: { key: 'INSPECTION_DEFECTS', values: { count: '2', inspection: 'SEED-INS-0002' } }, severity: 'MAJOR', zone: 'CUFF', defectIds: [...lines].sort() })
    const seam = (recorded.defects as Json[]).find((defect) => defect.code === 'SEAM-OPEN')!.id as string
    const { record } = await ok(P.inspector, 'POST', '/quality/ncr', { from: { recordType: 'Inspection', recordId: opened.id, defectIds: [seam] } }, 201)
    expect(record.ncr).toMatchObject({ number: expect.stringMatching(/^NCR-\d{4}-\d{4}$/), stage: 'OPEN', source: 'INSPECTION', severity: 'MAJOR', zone: 'CUFF' })
    expect(Number(record.ncr.quantityAffected)).toBe(1)
    G.ncr = record.ncr
    keep(record.ncr.id)
    await settle()
  })

  // ---- S: global search and the lists' exports ------------------------------------------------------------------------------

  it('S01 global search finds every record the flow made by its number, each for the role that reads it', async () => {
    const found = async (who: Person, q: string, recordType: string, recordId: string) => {
      const asked = await call(who.browser, 'GET', `/search?q=${encodeURIComponent(q)}&type=${recordType}`)
      expect(asked.status, `${recordType} ${q}: ${JSON.stringify(asked.body).slice(0, 300)} ${unexpected.map((report) => `${report.name}: ${report.message} ${report.stack.slice(0, 4).join(' | ')}`).join(' // ')}`).toBe(200)
      const answer = asked.body
      expect(
        (answer.results as Json[]).map((result) => result.recordId),
        `${recordType} ${q} for ${who.key}`,
      ).toContain(recordId)
    }
    await found(P.warehouse, G.shipment.number, 'Shipment', G.shipment.id)
    await found(P.warehouse, G.ddt.number, 'Ddt', G.ddt.id)
    await found(P.sales, G.rma.number, 'ReturnAuthorisation', G.rma.id)
    await found(P.buyer, G.claim.number, 'SupplierClaim', G.claim.id)
    await found(P.sales, G.order.number, 'SalesOrder', G.order.id)
    await found(P.finance, G.invoice.number, 'Invoice', G.invoice.id)
    await found(P.finance, 'CRO-GOLDEN-W2B0-CAPARRA', 'Payment', G.payment.id)
    await found(P.inspector, G.hold.number, 'QualityHold', G.hold.id)
    await found(P.inspector, G.ncr.number, 'Nonconformance', G.ncr.id)
  })

  it('S02 the lists that hold them export with them: one export per list through the worker, the record in the file', async () => {
    const columnsOf = (listKey: string) => Object.keys(EXPORT_SOURCES.find((source) => source.listKey === listKey)!.columns).map((key) => ({ key, label: key }))
    // Each list's own address terms (the screen's view the rows are in).
    const exported = async (who: Person, listKey: string, query: string, ids: string[], expected: string) => {
      const { job } = await ok(who, 'POST', '/exports', { listKey, format: 'CSV', query, columns: columnsOf(listKey), title: listKey, locale: 'it', ids }, 201)
      keep(job.id)
      await settle()
      const done = (await ok(who, 'GET', `/exports/${job.id}`)).job
      expect(done, `${listKey}: ${done.failureReason}`).toMatchObject({ status: 'DONE' })
      const { download } = await ok(who, 'GET', `/exports/${job.id}/download`)
      const got = await w.h.app.inject({ method: 'GET', url: download.url, headers: download.headers })
      expect(got.statusCode).toBe(200)
      expect(got.body, listKey).toContain(expected)
    }
    await exported(P.warehouse, 'warehouse.shipments', 'rows=all', [G.shipment.id], G.shipment.number)
    await exported(P.buyer, 'purchasing.claims', 'view=all', [G.claim.id], G.claim.number)
    await exported(P.sales, 'sales.orders', 'rows=all', [G.order.id], G.order.number)
    await exported(P.finance, 'finance.invoices.2', '', [G.invoice.id], G.invoice.number)
    await exported(P.finance, 'finance.payments', '', [G.payment.id], 'CRO-GOLDEN-W2B0-CAPARRA')
    await exported(P.inspector, 'quality.ncr', '', [G.ncr.id], G.ncr.number)
    await exported(P.warehouse, 'warehouse.moves', `lot=${S().liningLot}`, [G.writeOff.moves[0].id], 'GF-W2B0-K01')
  })

  // ---- L: the month locks -------------------------------------------------------------------------------------------------

  it('L01 finance soft-locks the month: the checks of an invoice draft name the lock; a stock adjustment goes in only with a reason (audited on the lock)', async () => {
    const s = S()
    const month = monthOfDay(today())
    const draft = (await ok(P.finance, 'POST', '/invoicing/invoices', { companyId: companyA(), buyerPartyId: s.p1, docType: 'TD01', causale: 'Campionario', lines: [{ description: 'Campione fodera', quantity: '1', uom: 'PZ', unitPrice: '10.00' }] }, 201)).invoice
    G.lockDraft = draft
    keep(draft.id)
    const soft = await ok(P.finance, 'POST', '/accounting/locks', { companyId: companyA(), month, level: 'SOFT', note: 'Month end of the W2b-0 golden flow.' })
    expect(soft.lock).toMatchObject({ level: 'SOFT', status: 'LOCKED', period: expect.objectContaining({ month }) })
    G.lock = soft.lock
    keep(soft.lock.id)
    const checks = await ok(P.finance, 'GET', `/invoicing/invoices/${draft.id}/checks`)
    expect(checks.periodLock).toMatchObject({ level: 'SOFT', needsReason: true })
    expect(checks.ready).toBe(true)
    const adjust = { siteId: siteA1(), itemId: s.lining, lotId: s.liningLot, locationId: s.bin, direction: 'OUT', quantity: '0.5', note: 'Counted short on the shelf', reasonCode: 'COUNT_ERROR' }
    const refused = await ok(P.warehouse, 'POST', '/inventory/adjustments', adjust, 409)
    expect((refused.error.issues as Json[]).map((issue) => issue.path)[0]).toBe('period/SOFT_LOCKED')
    expect(refused.error.message).toMatch(new RegExp(`^${monthLabel(month)} is soft-locked for `))
    const reason = 'The shelf was counted after the month was locked.'
    const { move } = await ok(P.warehouse, 'POST', '/inventory/adjustments', { ...adjust, periodLockOverride: { reason } }, 201)
    expect(move).toMatchObject({ reason: 'ADJUSTMENT', reasonCode: 'COUNT_ERROR', baseQuantity: '0.5000' })
    const audit = await admin<Json>(w, `SELECT reason, after FROM "AuditLog" WHERE action = 'accounting.softLockOverride' AND "recordId" = $1`, [soft.lock.id])
    expect(audit).toEqual([{ reason, after: expect.objectContaining({ level: 'SOFT', writes: [expect.objectContaining({ day: today(), record: { type: 'StockMove', id: move.id } })] }) }])
    await settle()
  })

  it('L02 the month closed for good (its phrase): the draft’s checks say PERIOD_LOCKED; the adjustment is refused even with a reason', async () => {
    const s = S()
    const month = monthOfDay(today())
    if (today().slice(5, 7) === '12') {
      // December closes company A's fiscal year: its HARD close waits for the year-end inventory (the W2a day covers it).
      return
    }
    const closed = await ok(P.finance, 'POST', '/accounting/locks', { companyId: companyA(), month, level: 'HARD', phrase: lockPhrases(month).en, version: G.lock.version })
    expect(closed.lock).toMatchObject({ id: G.lock.id, level: 'HARD', status: 'LOCKED' })
    const checks = await ok(P.finance, 'GET', `/invoicing/invoices/${G.lockDraft.id}/checks`)
    expect(checks.periodLock).toMatchObject({ level: 'HARD' })
    expect(checks.ready).toBe(false)
    expect((checks.problems as Json[]).map((problem) => problem.code)).toContain('PERIOD_LOCKED')
    const words = new RegExp(`^${monthLabel(month)} is closed for good for .+ \\(a hard lock since .+\\): `)
    const adjust = { siteId: siteA1(), itemId: s.lining, lotId: s.liningLot, locationId: s.bin, direction: 'OUT', quantity: '0.5', note: 'Counted short again', reasonCode: 'COUNT_ERROR', periodLockOverride: { reason: 'A reason does not open a closed month.' } }
    const refused = await ok(P.warehouse, 'POST', '/inventory/adjustments', adjust, 409)
    expect(refused.error.message).toMatch(words)
    await settle()
  })

  // ---- Z: the end checks ----------------------------------------------------------------------------------------------------

  it('Z1 every record the flow made has its audit rows and events; the worker never retried; the outbox is empty', async () => {
    const ids = [...made]
    const audited = new Set((await admin<{ recordId: string }>(w, 'SELECT DISTINCT "recordId"::text AS "recordId" FROM "AuditLog" WHERE "recordId" = ANY($1::uuid[])', [ids])).map((row) => row.recordId))
    expect(ids.filter((recordId) => !audited.has(recordId))).toEqual([])
    const events = new Set((await admin<{ type: string }>(w, 'SELECT DISTINCT type FROM "OutboxEvent" WHERE subject = ANY($1::text[])', [ids])).map((row) => row.type))
    for (const type of ['shipment.status_changed', 'shipment.freight_cost_changed', 'return.decided', 'supplier_claim.sent', 'supplier_claim.goods_returned', 'deposit_request.created_for_order', 'payment.deposit_carried', 'ncr.created', 'period_lock.locked']) {
      expect(events.has(type), type).toBe(true)
    }
    expect(w.retried).toEqual([])
    // No route answered 500 on the way.
    expect(unexpected.map((report) => `${report.context.method} ${report.context.route}: ${report.name}: ${report.message} ${report.stack.slice(0, 3).join(' | ')}`)).toEqual([])
    expect(await admin(w, `SELECT type, status::text AS status FROM "OutboxEvent" WHERE "tenantId" = $1 AND status <> 'PUBLISHED'`, [w.tenant.id])).toEqual([])
  })
})
