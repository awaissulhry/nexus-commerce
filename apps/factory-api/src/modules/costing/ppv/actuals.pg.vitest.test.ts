import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { ACCOUNTANT_WAITS } from '@nexus/factory-domain/costing/ppv/settings'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAccounting } from '../../../../../../packages/factory-db/seed/accounting'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { SYSTEM_ACTOR_ID, testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { costOfSalesHandlers } from '../cost-of-sales/handlers'
import { ppvHandlers } from './handlers'
import { saveActualSettings } from './settings'

/**
 * The actual-cost figures on the local stack (B-W2b-407; FIN-031, FIN-043, FIN-044, FIN-045; GATE-ACCOUNTANT) with the
 * app's real routes and the worker's handlers: a throwaway PostgreSQL 17 database from the migrations (the runtime login:
 * row-level security and the …_cost_actuals_w2b_guards are real), the factory-db seeds up to accounting:
 *
 *   purchase  SEED-GR-0001 (POSTED): PO1's leather, 105 ft² at 4.20, lot SEED-LOT-LEA-01 (hides 53.2 + 51.8 ft²: 441.00);
 *             the leather's FROZEN standard 4.20 from 2026-10-01; P2's invoice 2026/0412 (RECEIVED, a difference not
 *             accepted): the leather 105 ft² for 451.50 (4.30) and 15.00 of freight
 *   stock     H1 issued to SEED-WO-0001 at 4.20 (−223.44): the lot holds 51.8 ft² worth 217.56
 *   shipment  SEED-SH-0001 (SHIPPED): one jacket BLK 50 and one RED 52, straight from the release (no stock move)
 *
 * Company A's figures for the accountant start OFF (no ActualCostSettings row). Every figure is made up and worked out by
 * hand. Run with `node scripts/factory/run-pg-tests.mjs modules/costing`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'costing-actuals'
const id = (key: string) => seedUuid(NS, key)
const tenant = id('tenant')
const companyA = id('company:A')
const companyB = id('company:B')
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `t-${run}-${++keys}`

const grain = (permissions: readonly string[], companies: Grant['companies'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext & { actorId: string } => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants })
const fromTemplate = (name: string): SessionContext & { actorId: string } => {
  const role = templateOf(name)!
  return office([grain([...role.permissions, ...role.grains.map((g) => `money.${g}`)])])
}
const SESSIONS: Record<string, SessionContext & { actorId: string }> = {
  finance: fromTemplate('finance'),
  approver: fromTemplate('finance'),
  sales: fromTemplate('sales'),
  blind: office([grain(['costing.view'])]),
  companyB: office([grain(['costing.view', 'costing.ledger.manage', 'costing.landed.manage', 'money.cost'], [companyB])]),
  receiver: office([grain(['inventory.receive', 'inventory.locations.view', 'inventory.stock.view', 'parties.view'])]),
}
const callerOf = (session: string) => callerFor(database, { ...SESSIONS[session]!, requestId: newId() } as never)
const system = () => callerFor(database, { audience: 'system', tenantId: tenant, actorId: SYSTEM_ACTOR_ID, grants: [], requestId: newId() })

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refusal(session: string, method: Method, url: string, payload: unknown, code: string): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(409)
  const error = response.json().error
  expect(error.issues?.[0]?.path, response.body).toBe(`refusal/${code}`)
  return error
}
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : []

/** A handler on a made-up envelope (the payload the event names). */
async function handle(handlers: ReturnType<typeof ppvHandlers>, type: string, payload: Json, eventId = newId()) {
  const envelope = { eventId, type, version: 1, tenantId: tenant, payload, occurredAt: new Date().toISOString() } as unknown as EventEnvelope
  await handlers[0]!.handle(envelope, { caller: system(), attempt: 1 })
}
async function switchTo(body: Json) {
  return saveActualSettings(callerOf('finance'), { companyId: companyA, ...body } as never)
}

const one = async <T = Json>(sql: string, values: unknown[] = []) => (await admin<T>(sql, values))[0]!
let receiptId: string
let invoiceId: string
let leatherLineId: string
let freightLineId: string
let shipmentId: string
let leatherLot: { id: string; siteId: string; itemId: string }

beforeAll(async () => {
  db = await migratedDatabase('costing_actuals')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  await seedPrivacy({ db: database, namespace: NS })
  const seeded = await seedAccounting({ db: database, namespace: NS })
  invoiceId = seeded.supplierInvoiceId
  leatherLineId = seeded.supplierLineIds.leather
  freightLineId = seeded.supplierLineIds.freight
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  receiptId = (await one<{ id: string }>('SELECT id FROM "GoodsReceipt" WHERE number = $1', ['SEED-GR-0001'])).id
  shipmentId = (await one<{ id: string }>('SELECT id FROM "Shipment" WHERE number = $1', ['SEED-SH-0001'])).id
  leatherLot = await one('SELECT id, "siteId", "itemId" FROM "Lot" WHERE code = $1', ['SEED-LOT-LEA-01'])
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe("the company's switch for the accountant's figures (GATE-ACCOUNTANT)", () => {
  it('is off by default: every figure waits for the accountant, in words', async () => {
    const { settings } = await ok('finance', 'GET', `/costing/actuals/settings?companyId=${companyA}`)
    expect(settings).toMatchObject({ companyId: companyA, settingsId: null, postingsOn: false, ppvAt: 'RECEIPT', ppvAtFrom: 'DEFAULT', closeTolerancePct: '5', waits: ACCOUNTANT_WAITS, can: { manage: true, changePpvAt: true } })
    await refusal('finance', 'POST', '/costing/ppv/post', { receiptId }, 'WAITS_FOR_ACCOUNTANT')
    await refusal('finance', 'POST', '/costing/cost-of-sales/post', { shipmentId }, 'WAITS_FOR_ACCOUNTANT')
    expect((await ok('finance', 'GET', `/costing/ppv?companyId=${companyA}`)).waits).toBe(ACCOUNTANT_WAITS)
    // The worker writes nothing while it is off.
    await handle(ppvHandlers(), 'inventory.receipt_posted', { receiptId })
    expect((await admin('SELECT id FROM "PurchasePriceVariance"')).length).toBe(0)
  })

  it('is switched on by a person with a fresh step-up; where the variance is taken changes only while off', async () => {
    // Without a real session's fresh step-up the route refuses and writes nothing (the screens ask for a code first).
    expect((await call('finance', 'PUT', '/costing/actuals/settings', { companyId: companyA, postingsOn: true })).statusCode).not.toBe(200)
    expect(await admin('SELECT id FROM "ActualCostSettings"')).toEqual([])
    const on = await switchTo({ postingsOn: true, reason: 'The accountant confirmed the rules (made up).' })
    expect(on.settings).toMatchObject({ settingsId: companyA, postingsOn: true, ppvAtFrom: 'COMPANY', waits: null, postingsOnBy: { id: SESSIONS.finance!.actorId }, can: { changePpvAt: false } })
    await expect(switchTo({ ppvAt: 'INVOICE' })).rejects.toMatchObject({ issues: [{ path: 'refusal/PPV_AT_WHILE_ON' }] })
    await expect(switchTo({ postingsOn: true })).rejects.toMatchObject({ issues: [{ path: 'refusal/NOTHING_CHANGES' }] })
    await expect(saveActualSettings(callerOf('sales'), { companyId: companyA, postingsOn: false })).rejects.toMatchObject({ code: 'forbidden' })
    expect((await ok('sales', 'GET', `/costing/actuals/settings?companyId=${companyA}`)).settings.can).toEqual({ manage: false, changePpvAt: false })
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'actual_cost_settings.changed'`)
    expect(events.map((row) => row.payload)).toEqual([{ settingsId: companyA, companyId: companyA, fields: ['postingsOn'], postingsOn: true }])
    expect((await ok('companyB', 'GET', `/costing/actuals/settings?companyId=${companyA}`, undefined, 404)).error.code).toBe('not_found')
  })
})

describe('purchase price variance at the receipt (FIN-031)', () => {
  let varianceId: string

  it("takes each line's whole base quantity at the order's price against the frozen standard", async () => {
    const posted = await ok('finance', 'POST', '/costing/ppv/post', { receiptId }, 201)
    expect(posted.posted).toHaveLength(1)
    expect(posted.posted[0]).toMatchObject({
      companyId: companyA,
      source: { at: 'RECEIPT', documentId: receiptId, number: 'SEED-GR-0001', seq: 10 },
      quantity: '105.0000',
      standardUnitCost: '4.200000',
      paidUnitCost: '4.200000',
      differenceAmount: 0,
      currency: 'EUR',
      reversalOfId: null,
      words: '105 at 4.2 against 4.2 EUR: paid the standard (0.00 EUR).',
    })
    varianceId = posted.posted[0].id
    // Again: nothing more (one variance per line).
    const again = await ok('finance', 'POST', '/costing/ppv/post', { receiptId })
    expect(again).toMatchObject({ posted: [], skipped: [{ seq: 10, code: 'TAKEN' }] })
    const list = await ok('finance', 'GET', `/costing/ppv?companyId=${companyA}`)
    expect(list).toMatchObject({ nextCursor: null, totals: [{ currency: 'EUR', differenceAmount: 0, rows: 1 }], waits: null })
    expect(list.rows.map((row: Json) => row.id)).toEqual([varianceId])
    expect((await admin<{ idempotencyKey: string }>('SELECT "idempotencyKey" FROM "PurchasePriceVariance"')).map((row) => row.idempotencyKey)).toEqual([expect.stringMatching(/^ppv:receipt-line:[0-9a-f-]+$/)])
  })

  it('shows no unit cost or difference without the cost grain; another company sees nothing', async () => {
    const blind = await ok('blind', 'GET', `/costing/ppv?companyId=${companyA}`)
    expect(blind.rows).toHaveLength(1)
    expect(keysOf(blind).filter((name) => /UnitCost|differenceAmount|words/.test(name))).toEqual([])
    expect((await ok('companyB', 'GET', '/costing/ppv')).rows).toEqual([])
    expect((await call('companyB', 'POST', '/costing/ppv/post', { receiptId })).statusCode).toBe(404)
    expect((await call('blind', 'POST', '/costing/ppv/post', { receiptId })).statusCode).toBe(403)
  })

  it('is reversed once with a reason; posting again takes a new key', async () => {
    const reversed = await ok('finance', 'POST', `/costing/ppv/${varianceId}/reverse`, { reason: 'Taken at the wrong standard (made up).' }, 201)
    expect(reversed.reversal).toMatchObject({ quantity: '-105.0000', differenceAmount: 0, reversalOfId: varianceId, reason: 'Taken at the wrong standard (made up).' })
    expect(reversed.variance.reversedBy).toMatchObject({ id: reversed.reversal.id })
    await refusal('finance', 'POST', `/costing/ppv/${varianceId}/reverse`, { reason: 'Once more (made up).' }, 'REVERSED_ALREADY')
    await refusal('finance', 'POST', `/costing/ppv/${reversed.reversal.id}/reverse`, { reason: 'Back again (made up).' }, 'IS_REVERSAL')
    const again = await ok('finance', 'POST', '/costing/ppv/post', { receiptId }, 201)
    expect((await one<{ idempotencyKey: string }>('SELECT "idempotencyKey" FROM "PurchasePriceVariance" WHERE id = $1', [again.posted[0].id])).idempotencyKey).toMatch(/:2$/)
  })

  it('the worker takes a reversed receipt\'s live variances back (no switch needed)', async () => {
    await switchTo({ postingsOn: false })
    await handle(ppvHandlers(), 'inventory.receipt_reversed', { receiptId })
    const rows = await admin<{ reason: string | null; differenceAmount: number; reversalOfId: string | null }>('SELECT reason, "differenceAmount", "reversalOfId" FROM "PurchasePriceVariance" ORDER BY "createdAt", id')
    expect(rows.filter((row) => row.reversalOfId !== null).map((row) => row.reason)).toEqual(['Taken at the wrong standard (made up).', 'The goods receipt was reversed.'])
    // A repeat of the event takes nothing twice.
    await handle(ppvHandlers(), 'inventory.receipt_reversed', { receiptId })
    expect((await admin('SELECT id FROM "PurchasePriceVariance"')).length).toBe(4)
  })
})

describe('purchase price variance at the invoice', () => {
  it("is taken once the invoice is approved, at its net amount per base unit: 105 ft² at 4.30 against 4.20 = 10.50", async () => {
    await switchTo({ ppvAt: 'INVOICE' })
    await switchTo({ postingsOn: true })
    await refusal('finance', 'POST', '/costing/ppv/post', { supplierInvoiceId: invoiceId }, 'NOT_READY')
    await refusal('finance', 'POST', '/costing/ppv/post', { receiptId }, 'OTHER_PLACE')
    // The buyer accepts the difference and finance approves the invoice (payables' own routes).
    const match = await one<{ id: string; version: number }>('SELECT id, version FROM "SupplierInvoiceMatch" WHERE "invoiceId" = $1', [invoiceId])
    const before = await one<{ version: number }>('SELECT version FROM "SupplierInvoice" WHERE id = $1', [invoiceId])
    const accepted = await ok('finance', 'POST', `/payables/invoices/${invoiceId}/matches/${match.id}/accept`, { version: before.version, note: 'The tannery raised its price list (made up).' })
    await ok('approver', 'POST', `/payables/invoices/${invoiceId}/approve`, { version: accepted.invoice.version })
    await handle(ppvHandlers(), 'supplier_invoice.approved', { supplierInvoiceId: invoiceId, partyId: newId(), status: 'APPROVED', matchStatus: 'MATCHED' })
    const list = await ok('finance', 'GET', `/costing/ppv?supplierInvoiceId=${invoiceId}`)
    expect(list.rows).toHaveLength(1)
    expect(list.rows[0]).toMatchObject({ source: { at: 'INVOICE', documentId: invoiceId, number: '2026/0412', lineId: leatherLineId, seq: 1 }, quantity: '105.0000', standardUnitCost: '4.200000', paidUnitCost: '4.300000', differenceAmount: 1_050 })
    expect(list.totals).toEqual([{ currency: 'EUR', differenceAmount: 1_050, rows: 1 }])
    const posted = await ok('finance', 'POST', '/costing/ppv/post', { supplierInvoiceId: invoiceId })
    expect(posted.skipped.map((row: Json) => row.code)).toEqual(['TAKEN', 'NOT_GOODS'])
    const event = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'purchase_price_variance.posted' AND payload->>'documentId' = $1`, [invoiceId])
    expect(event.map((row) => row.payload)).toEqual([{ at: 'INVOICE', documentId: invoiceId, varianceIds: [list.rows[0].id], reversals: 0 }])
  })
})

describe('cost of goods sold at shipment (FIN-043)', () => {
  let entryId: string

  it('waits, in words, for a garment with no finished item or standard', async () => {
    const posted = await ok('finance', 'POST', '/costing/cost-of-sales/post', { shipmentId })
    expect(posted.posted).toEqual([])
    expect(posted.waiting.map((row: Json) => [row.size, row.code])).toEqual(expect.arrayContaining([['50', 'NO_ITEM'], ['52', 'NO_ITEM']]))
  })

  it("posts a line straight from the release at the finished garment's frozen standard, split by its parts", async () => {
    const variant = await one<{ id: string }>(`SELECT id FROM "Variant" WHERE sku = 'SEED-JKT-02-BLK-50'`)
    const itemId = newId()
    await admin(
      `INSERT INTO "Item" (id, "tenantId", code, name, kind, sourcing, tracking, "baseUom", "purchaseUom", "consumptionUom", "variantId", "createdAt", "updatedAt")
       VALUES ($1, $2, 'ACT-JKT-02-BLK-50', 'Made-up finished jacket BLK 50', 'FINISHED', 'MAKE', 'NONE', 'PCS', 'PCS', 'PCS', $3, now(), now())`,
      [itemId, tenant, variant.id],
    )
    const draft = await ok('finance', 'POST', '/costing/standards', { companyId: companyA, itemId, validFrom: '2026-10-01', source: 'MANUAL', materialCost: '98', labourCost: '43', subcontractCost: '0', overheadCost: '7' }, 201)
    await ok('finance', 'POST', `/costing/standards/${draft.standard.id}/freeze`, { version: draft.standard.version })
    const posted = await ok('finance', 'POST', '/costing/cost-of-sales/post', { shipmentId }, 201)
    expect(posted.posted).toHaveLength(1)
    expect(posted.posted[0]).toMatchObject({ shipment: { id: shipmentId, number: 'SEED-SH-0001' }, line: { size: '50' }, stockMoveId: null, quantity: '1.0000', materialAmount: 9_800, labourAmount: 4_300, subcontractAmount: 0, overheadAmount: 700, amount: 14_800, unitCost: '148.000000', currency: 'EUR' })
    expect(posted.waiting.map((row: Json) => [row.size, row.code])).toEqual([['52', 'NO_ITEM']])
    entryId = posted.posted[0].id
    // The worker on the shipment's SHIPPED event takes nothing twice.
    await handle(costOfSalesHandlers(), 'shipment.status_changed', { shipmentId, number: 'SEED-SH-0001', from: 'PACKED', to: 'SHIPPED' })
    const list = await ok('finance', 'GET', `/costing/cost-of-sales?shipmentId=${shipmentId}`)
    expect(list.entries.map((row: Json) => row.id)).toEqual([entryId])
    expect(list.totals).toEqual([{ currency: 'EUR', materialAmount: 9_800, labourAmount: 4_300, subcontractAmount: 0, overheadAmount: 700, amount: 14_800, entries: 1 }])
    const blind = await ok('blind', 'GET', `/costing/cost-of-sales?shipmentId=${shipmentId}`)
    expect(keysOf(blind.entries).filter((name) => /Amount|amount|unitCost/.test(name))).toEqual([])
  })

  it("is reversed with a reason, posted again, and taken back when the carrier brings the shipment back", async () => {
    const reversed = await ok('finance', 'POST', `/costing/cost-of-sales/${entryId}/reverse`, { reason: 'Costed before the standard was corrected (made up).' }, 201)
    expect(reversed.reversal).toMatchObject({ quantity: '-1.0000', amount: -14_800, materialAmount: -9_800, reversalOfId: entryId })
    await refusal('finance', 'POST', `/costing/cost-of-sales/${entryId}/reverse`, { reason: 'Again (made up).' }, 'REVERSED_ALREADY')
    await ok('finance', 'POST', '/costing/cost-of-sales/post', { shipmentId }, 201)
    await handle(costOfSalesHandlers(), 'shipment.carrier_return_received', { shipmentId, number: 'SEED-SH-0001', garments: 2, locationId: newId() })
    const rows = await admin<{ amount: number; reason: string | null; idempotencyKey: string }>('SELECT amount, reason, "idempotencyKey" FROM "CostOfSalesEntry" ORDER BY "createdAt", id')
    expect(rows.map((row) => row.amount)).toEqual([14_800, -14_800, 14_800, -14_800])
    expect(rows[2]!.idempotencyKey).toMatch(/:2$/)
    expect(rows[3]!.reason).toBe('The carrier brought the shipment back: its garments are in finished goods again.')
  })
})

describe('landed cost over the received lots (FIN-044)', () => {
  let allocation: Json

  it("lists the invoices' charge lines and prepares a draft on the receipts the goods were matched to", async () => {
    const list = await ok('finance', 'GET', `/costing/landed?companyId=${companyA}`)
    expect(list.charges).toEqual([expect.objectContaining({ line: expect.objectContaining({ id: freightLineId, netAmount: 1_500 }), state: 'WAITING', allocation: null, reversed: 0 })])
    allocation = (await ok('finance', 'POST', '/costing/landed', { supplierInvoiceLineId: freightLineId, basis: 'VALUE' }, 201)).allocation
    expect(allocation).toMatchObject({ status: 'DRAFT', basis: 'VALUE', amount: 1_500, currency: 'EUR', invoice: { number: '2026/0412' }, can: { change: true, post: true, reverse: false, remove: true } })
    expect(allocation.shares).toEqual([expect.objectContaining({ lot: { id: leatherLot.id, code: 'SEED-LOT-LEA-01' }, receipt: expect.objectContaining({ number: 'SEED-GR-0001' }), receivedQuantity: '105.0000', basisAmount: '44100.0000', amount: 1_500 })])
    await refusal('finance', 'POST', '/costing/landed', { supplierInvoiceLineId: freightLineId, basis: 'QUANTITY' }, 'DRAFT_EXISTS')
    await refusal('finance', 'POST', '/costing/landed', { supplierInvoiceLineId: leatherLineId, basis: 'VALUE' }, 'NOT_A_CHARGE')
    expect((await call('companyB', 'POST', '/costing/landed', { supplierInvoiceLineId: freightLineId, basis: 'VALUE' })).statusCode).toBe(404)
  })

  it('changes a draft: by weight only with the kilograms typed (leather is counted in ft²), by quantity on the area', async () => {
    await refusal('finance', 'PATCH', `/costing/landed/${allocation.id}`, { version: allocation.version, basis: 'WEIGHT' }, 'NO_WEIGHT')
    allocation = (await ok('finance', 'PATCH', `/costing/landed/${allocation.id}`, { version: allocation.version, basis: 'WEIGHT', weights: [{ lotId: leatherLot.id, kilograms: '12.5' }] })).allocation
    expect(allocation.shares.map((row: Json) => [row.basisAmount, row.amount])).toEqual([['12.5000', 1_500]])
    allocation = (await ok('finance', 'PATCH', `/costing/landed/${allocation.id}`, { version: allocation.version, basis: 'QUANTITY', note: 'By area (made up).' })).allocation
    expect(allocation).toMatchObject({ basis: 'QUANTITY', note: 'By area (made up).', shares: [expect.objectContaining({ basisAmount: '105.0000', amount: 1_500 })] })
  })

  it("is posted only while the figures are on; the lot's value then carries it, and a reversal takes it off", async () => {
    await switchTo({ postingsOn: false })
    await refusal('finance', 'POST', `/costing/landed/${allocation.id}/post`, { version: allocation.version }, 'WAITS_FOR_ACCOUNTANT')
    await switchTo({ postingsOn: true })
    allocation = (await ok('finance', 'POST', `/costing/landed/${allocation.id}/post`, { version: allocation.version })).allocation
    expect(allocation).toMatchObject({ status: 'POSTED', postedBy: { id: SESSIONS.finance!.actorId }, can: { change: false, post: false, reverse: true, remove: false } })
    await refusal('finance', 'POST', `/costing/landed/${allocation.id}/post`, { version: allocation.version }, 'NOT_DRAFT')
    const valued = await ok('finance', 'GET', `/costing/valuation?lotId=${leatherLot.id}`)
    // 51.8 ft² worth 217.56 + the 15.00 of freight = 232.56.
    expect(valued.rows[0]).toMatchObject({ quantity: '51.8000', value: 23_256, customerOwned: null })
    expect(valued.words).toMatch(/landed cost/)
    expect((await ok('finance', 'GET', `/costing/landed?state=POSTED`)).charges.map((row: Json) => row.line.id)).toEqual([freightLineId])
    allocation = (await ok('finance', 'POST', `/costing/landed/${allocation.id}/reverse`, { version: allocation.version, reason: 'Landed on the wrong receipt (made up).' })).allocation
    expect(allocation).toMatchObject({ status: 'REVERSED', reverseReason: 'Landed on the wrong receipt (made up).' })
    expect((await ok('finance', 'GET', `/costing/valuation?lotId=${leatherLot.id}`)).rows[0].value).toBe(21_756)
    // A new draft after the reversal, removed again.
    const next = (await ok('finance', 'POST', '/costing/landed', { supplierInvoiceLineId: freightLineId, basis: 'QUANTITY', receiptIds: [receiptId] }, 201)).allocation
    expect((await ok('finance', 'DELETE', `/costing/landed/${next.id}?version=${next.version}`)).removed).toBe(true)
    expect((await call('finance', 'GET', `/costing/landed/${next.id}`)).statusCode).toBe(404)
    const changes = await admin<{ change: string }>(`SELECT payload->>'change' AS change FROM "OutboxEvent" WHERE type = 'landed_cost.changed' ORDER BY "occurredAt", id`)
    expect(changes.map((row) => row.change)).toEqual(['prepared', 'changed', 'changed', 'posted', 'reversed', 'prepared', 'removed'])
  })
})

describe("a customer's own material is never valued (FIN-045)", () => {
  it('is counted by quantity in the valuation, takes no landed cost and no purchase price variance', async () => {
    const site = await one<{ id: string }>('SELECT "siteId" AS id FROM "Lot" WHERE id = $1', [leatherLot.id])
    const location = await one<{ id: string }>(`SELECT id FROM "Location" WHERE "siteId" = $1 AND kind = 'RECEIVING' ORDER BY code LIMIT 1`, [site.id])
    const party = await one<{ id: string }>(`SELECT id FROM "Party" WHERE code = 'SEED-C1'`)
    const lining = await one<{ id: string }>(`SELECT id FROM "Item" WHERE code = 'SEED-LIN-200'`)
    const received = await ok('receiver', 'POST', '/inventory/receipts/customer', { siteId: site.id, partyId: party.id, locationId: location.id, lines: [{ itemId: lining.id, quantity: '30' }] }, 201)
    const ownReceiptId = received.receipt.id
    const lot = await one<{ id: string }>('SELECT l.id FROM "Lot" l JOIN "GoodsReceiptLine" g ON g.id = l."receiptLineId" WHERE g."receiptId" = $1', [ownReceiptId])
    const valued = await ok('finance', 'GET', `/costing/valuation?lotId=${lot.id}`)
    expect(valued.rows[0]).toMatchObject({ quantity: '30.0000', value: 0, unitCost: null, unvaluedMoves: 0, customerOwned: { id: party.id }, words: expect.stringMatching(/own material.*never valued/) })
    expect(valued).toMatchObject({ unvaluedMoves: 0, words: expect.stringMatching(/customers' own material/) })
    await refusal('finance', 'POST', '/costing/landed', { supplierInvoiceLineId: freightLineId, basis: 'QUANTITY', receiptIds: [ownReceiptId] }, 'CUSTOMER_OWNED')
    await switchTo({ postingsOn: false })
    await switchTo({ ppvAt: 'RECEIPT' })
    await switchTo({ postingsOn: true })
    const ppv = await ok('finance', 'POST', '/costing/ppv/post', { receiptId: ownReceiptId })
    expect(ppv).toMatchObject({ posted: [], skipped: [{ code: 'CUSTOMER_OWNED' }] })
  })
})
