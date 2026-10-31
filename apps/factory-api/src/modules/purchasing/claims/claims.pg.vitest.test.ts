import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedSourcing, type SourcingSeed } from '../../../../../../packages/factory-db/seed/sourcing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { pdfFlatText } from '../../../platform/documents/testing/pdf-text'

/**
 * Supplier claims and returns to the supplier (B-W2a-44; SCM-134) on the local stack, with the app's real routes: a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the grants and the
 * …_supply_w2a_guards claim triggers, the ledger, DDT and numbering guards are real), the factory-db seeds (R1's lot
 * SEED-LOT-LEA-01 of P2's black leather, RELEASED: SEED-HIDE-0001 issued to WO-0001, SEED-HIDE-0002 51.8 ft² in
 * A1-STORE-01; 120 m of grey lining SEED-LOT-LIN-01; the OPEN discrepancy on R1's leather line; SEED-CLM-0001 DRAFT), the
 * auth harness's FAKE SES and file store, sessions from the test authenticator. Every name, number and value is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/purchasing/claims`.
 */

let h: Harness
let app: FastifyInstance
let seed: SourcingSeed

const ns = { a: 'claims-a', b: 'claims-b' } as const
const idOf = (key: string) => seedUuid(ns.a, key)
const A = {
  tenant: idOf('tenant'),
  companyA: idOf('company:A'),
  siteA1: idOf('site:A1'),
  P1: idOf('party:P1'),
  P2: idOf('party:P2'),
  orderDesk: idOf('party-contact:P2:orders'),
  leather: idOf('product:item:leather'),
  lining: idOf('product:item:lining'),
}
const YEAR = businessDate(new Date()).slice(0, 4)

const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const BUYER = newId()
const office = (tenantId: string, grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId, actorId, grants })
const DDT: Permission[] = ['shipping.view', 'shipping.ddt.issue', 'shipping.ddt.cancel', 'files.read']
const SESSIONS: Record<string, SessionContext> = {
  /** The buyer template's part: prepares, sends, answers and closes claims; sees costs. */
  buyer: office(A.tenant, [grant(['purchasing.view', 'purchasing.claims.manage', 'money.cost', 'threads.read', 'reasons.view'])], BUYER),
  /** The warehouse template's part: claims and the goods back with the DDT; no money. */
  warehouse: office(A.tenant, [grant(['purchasing.view', 'purchasing.claims.manage', 'purchasing.claims.return', ...DDT, 'inventory.stock.view'])]),
  /** Sends goods back but issues no DDT. */
  noDdt: office(A.tenant, [grant(['purchasing.view', 'purchasing.claims.manage', 'purchasing.claims.return'])]),
  viewer: office(A.tenant, [grant(['purchasing.view'])]),
  /** B-W2b-14: keeps claims and adds photos (files.upload), never removes a file. */
  photographer: office(A.tenant, [grant(['purchasing.view', 'purchasing.claims.manage', 'purchasing.claims.return', ...DDT, 'files.upload', 'inventory.stock.view', 'threads.read'])]),
  /** B-W2b-14: may remove a file too (files.delete). */
  fileAdmin: office(A.tenant, [grant(['purchasing.view', 'purchasing.claims.manage', 'files.read', 'files.upload', 'files.delete'])]),
  /** Reaches the supplier P1 only. */
  otherSupplier: office(A.tenant, [grant(['purchasing.view', 'purchasing.claims.manage', 'purchasing.claims.return', ...DDT], [A.P1])]),
  otherTenant: office(seedUuid(ns.b, 'tenant'), [grant(['purchasing.view', 'purchasing.claims.manage', 'purchasing.claims.return', ...DDT, 'money.cost'])]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `claims-test-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, idempotencyKey: string | undefined = method === 'GET' ? undefined : key()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const url = (id: string, rest = '') => `/purchasing/claims/${id}${rest}`
const eventsOf = async (subject: string) => (await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])).map((row) => row.type)
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : []
const TYPED_DDT = { transportBy: 'SENDER', packages: 1, grossWeightKg: '7.5', appearance: 'Rotolo' } as const
const onHand = async (filter: string, values: unknown[]) =>
  (
    await admin<{ n: string }>(
      `SELECT COALESCE(SUM(CASE WHEN "toLocationId" IS NOT NULL THEN "baseQuantity" ELSE 0 END) - SUM(CASE WHEN "fromLocationId" IS NOT NULL THEN "baseQuantity" ELSE 0 END), 0)::text AS n FROM "StockMove" WHERE "tenantId" = $1 AND ${filter}`,
      [A.tenant, ...values],
    )
  )[0]!.n

let leatherLot = ''
let liningLot = ''
let hide2 = ''
let store = ''

beforeAll(async () => {
  h = await startHarness('claims')
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: h.database, namespace })
  await seedProduction({ db: h.database, namespace: ns.a })
  seed = await seedSourcing({ db: h.database, namespace: ns.a })
  for (const seedOf of [seedNumbering, seedReasons, seedFiles, seedEmail]) await seedOf({ db: h.database, namespace: ns.a })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE provider = 'R2'`)
  // Made-up legal data (c.c. art. 2250) for the DDT; this year's series without a date ahead of today.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT00000003038', "fiscalCode" = '00000003038', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [A.companyA])
  await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1 AND kind IN ('DDT', 'CLAIM') AND "scopeKey" = $2`, [A.tenant, YEAR])
  leatherLot = (await admin<{ id: string }>(`SELECT id FROM "Lot" WHERE "tenantId" = $1 AND code = 'SEED-LOT-LEA-01'`, [A.tenant]))[0]!.id
  liningLot = (await admin<{ id: string }>(`SELECT id FROM "Lot" WHERE "tenantId" = $1 AND code = 'SEED-LOT-LIN-01'`, [A.tenant]))[0]!.id
  hide2 = (await admin<{ id: string }>(`SELECT id FROM "Hide" WHERE "tenantId" = $1 AND code = 'SEED-HIDE-0002'`, [A.tenant]))[0]!.id
  store = (await admin<{ id: string }>(`SELECT id FROM "Location" WHERE "tenantId" = $1 AND code = 'A1-STORE-01'`, [A.tenant]))[0]!.id
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

let claim: Json

describe('a claim for credit from a receipt discrepancy (SCM-134; the goods stay)', () => {
  it('makes a DRAFT from the discrepancy: its receipt line, lot, area and the lot cost, the receipt, order and supplier as header', async () => {
    const made = await ok('buyer', 'POST', '/purchasing/claims', { kind: 'CLAIM', from: { discrepancyIds: [seed.discrepancyId] }, reasonCode: 'QUALITY', reasonNote: 'A hole near the belly' }, 201)
    claim = made.claim
    expect(claim).toMatchObject({
      number: `CLM-${YEAR}-0001`,
      kind: 'CLAIM',
      status: 'DRAFT',
      supplier: { id: A.P2 },
      site: { id: A.siteA1 },
      foundAt: 'RECEIPT',
      remedy: 'CREDIT',
      reason: { code: 'QUALITY', labelEn: 'Quality defect', note: 'A hole near the belly' },
      goodsReceipt: { id: seed.inventory.receiptId },
      purchaseOrder: { id: seed.inventory.supply.purchaseOrderId },
      quantity: { quantity: '4.5000', uom: 'FT2' },
      lots: [{ id: leatherLot }],
    })
    expect(claim.lines).toEqual([expect.objectContaining({ seq: 10, discrepancy: expect.objectContaining({ id: seed.discrepancyId, status: 'OPEN' }), lot: expect.objectContaining({ id: leatherLot }), hide: null, quantity: '4.5000', move: null, ddt: null })])
    // The lot's cost (the receipt's purchase price per ft²) × 4.5 ft², rounded once.
    const [cost] = await admin<{ unitCost: string }>(`SELECT "unitCost"::text AS "unitCost" FROM "StockValuation" WHERE "lotId" = $1 ORDER BY id LIMIT 1`, [leatherLot])
    const expected = Math.round(Number(cost!.unitCost) * 4.5 * 100)
    expect(claim.lines[0]).toMatchObject({ unitCost: cost!.unitCost, creditAmount: expected })
    expect(claim).toMatchObject({ value: expected, expectedCreditAmount: expected, credit: { expected, value: expected, matched: null } })
    expect(claim.actions).toMatchObject({ edit: null, send: null, cancel: null, answer: expect.any(String), returnGoods: expect.stringContaining('keeps the goods') })
    expect(await eventsOf(claim.id)).toEqual(['supplier_claim.created'])
  })

  it('shows no cost to a role without the cost grain', async () => {
    const seen = (await ok('warehouse', 'GET', url(claim.id))).claim
    expect(keysOf(seen).filter((name) => /cost|value|amount|expected/i.test(name))).toEqual([])
    expect(seen.credit).toEqual({ currency: 'EUR', remedy: 'CREDIT', matched: null, difference: null })
    // …and refuses a cost sent by one.
    expect((await refused('warehouse', 'PATCH', url(claim.id), { version: seen.version, expectedCreditAmount: 100 }, 403)).message).toBeTruthy()
  })

  it("changes a draft's line and header; the credit follows the lines", async () => {
    // A line added (2 m of the grey lining, typed by its lot) and removed again: the credit follows.
    const added = (await ok('buyer', 'POST', url(claim.id, '/lines'), { version: claim.version, lines: [{ lotId: liningLot, quantity: '2' }] }, 201)).claim
    expect(added.lines.map((line: Json) => [line.seq, line.quantity, line.uom])).toEqual([[10, '4.5000', 'FT2'], [20, '2.0000', 'M']])
    expect(added.expectedCreditAmount).toBe(claim.expectedCreditAmount + (added.lines[1].creditAmount ?? 0))
    const removed = (await ok('buyer', 'DELETE', url(claim.id, `/lines/${added.lines[1].id}?version=${added.version}`))).claim
    expect(removed.lines).toHaveLength(1)
    expect(removed.expectedCreditAmount).toBe(claim.expectedCreditAmount)
    claim = removed
    const edited = (await ok('buyer', 'PATCH', url(claim.id, `/lines/${claim.lines[0].id}`), { version: claim.version, quantity: '6' })).claim
    expect(edited.lines[0]).toMatchObject({ quantity: '6.0000', baseQuantity: '6.0000' })
    expect(edited.expectedCreditAmount).toBe(Math.round(Number(edited.lines[0].unitCost) * 6 * 100))
    const replacement = (await ok('buyer', 'PATCH', url(claim.id), { version: edited.version, remedy: 'REPLACEMENT' })).claim
    expect(replacement).toMatchObject({ remedy: 'REPLACEMENT', expectedCreditAmount: null, value: edited.value })
    claim = (await ok('buyer', 'PATCH', url(claim.id), { version: replacement.version, remedy: 'CREDIT', internalNote: 'Ask for 6 ft².' })).claim
    expect(claim).toMatchObject({ remedy: 'CREDIT', expectedCreditAmount: edited.expectedCreditAmount, internalNote: 'Ask for 6 ft².' })
    expect((await refused('buyer', 'PATCH', url(claim.id), { version: claim.version - 1, remedy: 'CREDIT' }, 409)).message).toBeTruthy()
  })

  it("the send-check, then the claim by e-mail on its thread (no price), its discrepancy reported with it", async () => {
    const check = await ok('buyer', 'GET', url(claim.id, '/send-check'))
    expect(check).toMatchObject({ ready: true, problems: [], language: 'it', recipients: [{ contactId: A.orderDesk, email: 'orders.p2@example.com', suggested: true }] })
    expect(check.subject).toMatch(new RegExp(`^Reclamo ${claim.number}`))
    expect(check.message).toContain('Motivo: Difetto di qualità: A hole near the belly.')
    const sent = await ok('buyer', 'POST', url(claim.id, '/send'), { version: claim.version, mail: { contactIds: [A.orderDesk] } })
    claim = sent.claim
    expect(claim).toMatchObject({ status: 'SENT', sentById: BUYER })
    expect(claim.lines[0].discrepancy.status).toBe('SENT')
    const [mail] = await admin(`SELECT status::text AS status, "to", subject, "recordType", "recordId" FROM "EmailOutbound" WHERE id = $1`, [sent.emailId])
    expect(mail).toMatchObject({ status: 'QUEUED', to: ['orders.p2@example.com'], recordType: 'SupplierClaim', recordId: claim.id })
    const [message] = await admin<{ bodyText: string }>(`SELECT m."bodyText" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'SupplierClaim' AND t."recordId" = $1`, [claim.id])
    expect(message!.bodyText).toContain('SEED-LOT-LEA-01')
    expect(message!.bodyText).toContain('6 FT2')
    expect(message!.bodyText).not.toMatch(/EUR|€|\d+,\d{2}/)
    // The claim's thread is the record's Activity (records.ts: its company, site and supplier).
    const thread = await ok('buyer', 'GET', `/threads/SupplierClaim/${claim.id}`)
    expect(thread.thread).toMatchObject({ recordType: 'SupplierClaim', recordId: claim.id })
    const [discrepancy] = await admin(`SELECT status::text AS status, "sentAt" IS NOT NULL AS sent FROM "ReceiptDiscrepancy" WHERE id = $1`, [seed.discrepancyId])
    expect(discrepancy).toEqual({ status: 'SENT', sent: true })
  })

  it('refuses what a sent claim no longer takes, in words', async () => {
    expect((await refused('buyer', 'PATCH', url(claim.id, `/lines/${claim.lines[0].id}`), { version: claim.version, quantity: '2' }, 409)).message).toContain('only while it is a draft')
    expect((await refused('buyer', 'PATCH', url(claim.id), { version: claim.version, reasonCode: 'OTHER' }, 409)).message).toContain('only while it is a draft')
    expect((await refused('buyer', 'POST', url(claim.id, '/cancel'), { version: claim.version, reason: 'Not needed' }, 409)).message).toContain('close it instead')
    expect((await refused('warehouse', 'POST', url(claim.id, '/return'), { version: claim.version, ddt: TYPED_DDT }, 409)).message).toContain('keeps the goods')
  })

  it('records the supplier accepting a credit it agrees (its discrepancy AGREED), then closes the claim (its discrepancy CLOSED)', async () => {
    claim = (await ok('buyer', 'POST', url(claim.id, '/answer'), { version: claim.version, outcome: 'ACCEPTED', answer: 'We credit 6 ft² on our next invoice.', expectedCreditAmount: 2500 })).claim
    expect(claim).toMatchObject({ status: 'ACCEPTED', supplierAnswer: 'We credit 6 ft² on our next invoice.', expectedCreditAmount: 2500, credit: { expected: 2500 } })
    expect(claim.lines[0].discrepancy.status).toBe('AGREED')
    expect((await ok('viewer', 'GET', '/purchasing/claims/counts')).creditExpected).toBe(1)
    expect((await refused('buyer', 'POST', url(claim.id, '/close'), { version: claim.version, note: '' }, 400)).issues[0].path).toBe('body/note')
    claim = (await ok('buyer', 'POST', url(claim.id, '/close'), { version: claim.version, note: 'Credit note received.' })).claim
    expect(claim).toMatchObject({ status: 'CLOSED', closeNote: 'Credit note received.' })
    const [discrepancy] = await admin(`SELECT status::text AS status, "resolutionNote" FROM "ReceiptDiscrepancy" WHERE id = $1`, [seed.discrepancyId])
    expect(discrepancy).toEqual({ status: 'CLOSED', resolutionNote: `Claim ${claim.number}: Credit note received.` })
    expect((await refused('buyer', 'POST', url(claim.id, '/close'), { version: claim.version, note: 'Again' }, 409)).message).toContain('changes no more')
    // Closed: the internal note only.
    expect((await ok('buyer', 'PATCH', url(claim.id), { version: claim.version, internalNote: 'Filed.' })).claim.internalNote).toBe('Filed.')
    expect(await eventsOf(claim.id)).toEqual(['supplier_claim.created', 'supplier_claim.updated', 'supplier_claim.updated', 'supplier_claim.updated', 'supplier_claim.updated', 'supplier_claim.updated', 'thread.message_posted', 'supplier_claim.sent', 'supplier_claim.answered', 'supplier_claim.closed', 'supplier_claim.updated'])
  })
})

let returned: Json

describe('Return to supplier in one go (SCM-134; rule 2: rejected leather goes back to the tannery)', () => {
  it('refuses without the DDT permission, without claims.manage, and a hide-tracked line without its hide', async () => {
    const body = { from: { lotId: leatherLot }, reasonCode: 'QUALITY', ddt: TYPED_DDT }
    expect((await refused('noDdt', 'POST', '/purchasing/claims/returns', body, 403)).message).toContain('shipping.ddt.issue')
    const error = await refused('warehouse', 'POST', '/purchasing/claims/returns', { lines: [{ lotId: leatherLot, quantity: '3' }], reasonCode: 'QUALITY', ddt: TYPED_DDT }, 400)
    expect(error.issues[0]).toMatchObject({ path: 'body/lines/0/hideId' })
    expect(await admin(`SELECT count(*)::int AS n FROM "SupplierClaim" WHERE "tenantId" = $1 AND kind = 'RETURN'`, [A.tenant])).toEqual([{ n: 0 }])
  })

  it("from the lot: its hide in stock goes back — a RETURN claim, sent, the stock out (SUPPLIER_RETURN, B-W2b-14), the return DDT, the credit from what the stock left at", async () => {
    const before = await onHand(`"hideId" = $2`, [hide2])
    expect(Number(before)).toBeGreaterThan(0)
    const body = { from: { lotId: leatherLot }, reasonCode: 'QUALITY', reasonNote: 'Rejected at inspection', remedy: 'CREDIT', mail: { contactIds: [A.orderDesk] }, ddt: TYPED_DDT }
    const idempotencyKey = key()
    const first = await call('warehouse', 'POST', '/purchasing/claims/returns', body, idempotencyKey)
    expect(first.statusCode, first.body).toBe(201)
    returned = first.json()
    expect(returned.claim).toMatchObject({ number: `CLM-${YEAR}-0002`, kind: 'RETURN', status: 'SENT', supplier: { id: A.P2 }, foundAt: 'STOCK', lines: [expect.objectContaining({ hide: { id: hide2, code: 'SEED-HIDE-0002', state: 'RETURNED' } })], returned: 1 })
    expect(Number(returned.claim.lines[0].quantity)).toBe(Number(before))
    expect(returned.ddt).toMatchObject({ number: expect.stringMatching(new RegExp(`/${YEAR}$`)), pdfProblem: null })
    expect(returned.ddt.file).toMatchObject({ kind: 'FISCAL_ARCHIVE', status: 'AVAILABLE' })
    const [line] = returned.claim.lines
    expect(line.move).toMatchObject({ reason: 'SUPPLIER_RETURN', fromLocation: { id: store } })
    expect(line.ddt).toMatchObject({ id: returned.ddt.id, cancelled: false })
    expect(returned.claim.ddts).toEqual([expect.objectContaining({ id: returned.ddt.id, reason: 'RETURN', cancelled: false, lineIds: [line.id] })])
    expect(returned.moveIds).toEqual([line.move.id])
    // No cost for the warehouse; the stock is gone; the DDT is the claim's, to its supplier.
    expect(keysOf(returned).filter((name) => /unitCost|creditAmount|expectedCreditAmount|value/i.test(name))).toEqual([])
    expect(await onHand(`"hideId" = $2`, [hide2])).toBe('0.0000')
    expect(await admin(`SELECT "sourceType", "sourceId", "partyId", reason::text AS reason FROM "Ddt" WHERE id = $1`, [returned.ddt.id])).toEqual([{ sourceType: 'SupplierClaim', sourceId: returned.claim.id, partyId: A.P2, reason: 'RETURN' }])
    // The credit asked = the move's value (the lot's cost), seen by the buyer.
    const [valuation] = await admin<{ valueAmount: number; unitCost: string }>(`SELECT "valueAmount", "unitCost"::text AS "unitCost" FROM "StockValuation" WHERE "moveId" = $1`, [line.move.id])
    const seen = (await ok('buyer', 'GET', url(returned.claim.id))).claim
    expect(seen.lines[0]).toMatchObject({ unitCost: valuation!.unitCost, creditAmount: -valuation!.valueAmount })
    expect(seen).toMatchObject({ expectedCreditAmount: -valuation!.valueAmount, credit: { expected: -valuation!.valueAmount } })
    // The mail on the claim's thread; the events in order.
    expect(await admin(`SELECT "recordType" FROM "EmailOutbound" WHERE "recordId" = $1`, [returned.claim.id])).toEqual([{ recordType: 'SupplierClaim' }])
    expect(await eventsOf(returned.claim.id)).toEqual(['supplier_claim.created', 'thread.message_posted', 'supplier_claim.sent', 'ddt.source_issued', 'supplier_claim.goods_returned'])
    // The same Idempotency-Key answers the same return: no second claim, move or DDT.
    const again = await call('warehouse', 'POST', '/purchasing/claims/returns', body, idempotencyKey)
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json().claim.id).toBe(returned.claim.id)
    expect(await admin(`SELECT count(*)::int AS n FROM "Ddt" WHERE "sourceId" = $1`, [returned.claim.id])).toEqual([{ n: 1 }])
  })

  it('refuses a second return of what already went back, in words', async () => {
    const body = { from: { lotId: leatherLot }, reasonCode: 'QUALITY', ddt: TYPED_DDT }
    expect((await refused('warehouse', 'POST', '/purchasing/claims/returns', body, 400)).message).toBe('Lot SEED-LOT-LEA-01 has no hide in stock at its site.')
    const seen = (await ok('warehouse', 'GET', url(returned.claim.id))).claim
    expect((await refused('warehouse', 'POST', url(returned.claim.id, '/return'), { version: seen.version, ddt: TYPED_DDT }, 409)).message).toBe(`Every line of claim ${seen.number} went back already.`)
  })

  it('lists it with the lot, and the tiles count it', async () => {
    const list = await ok('viewer', 'GET', `/purchasing/claims?lotId=${leatherLot}&open=false`)
    // The seed's SEED-CLM-0001 names the same lot (ids in order: the seed's are no UUIDv7).
    expect(list.items.map((row: Json) => row.number).sort()).toEqual([claim.number, returned.claim.number, 'SEED-CLM-0001'].sort())
    const row = list.items.find((item: Json) => item.id === returned.claim.id)
    expect(row).toMatchObject({ kind: 'RETURN', status: 'SENT', lots: [{ id: leatherLot, code: 'SEED-LOT-LEA-01' }], lines: 1, returned: 1 })
    expect(row).not.toHaveProperty('value')
    const counts = await ok('viewer', 'GET', '/purchasing/claims/counts')
    // The seed's SEED-CLM-0001 (DRAFT) and this return are open; this one waits for the supplier; the first was closed.
    expect(counts).toEqual({ open: 2, waitingForSupplier: 1, creditExpected: 0, closedThisMonth: 1 })
    expect((await ok('viewer', 'GET', '/purchasing/claims?q=SEED-CLM')).items.map((row: Json) => row.number)).toEqual(['SEED-CLM-0001'])
  })
})

describe('a return prepared first, its goods back later (SCM-134)', () => {
  let draft: Json

  it('a DRAFT return of 10 m of lining (typed) cannot send goods until it is sent; mailless send; then the goods go back', async () => {
    const before = await onHand(`"lotId" = $2`, [liningLot])
    draft = (await ok('warehouse', 'POST', '/purchasing/claims', { kind: 'RETURN', partyId: A.P2, reasonCode: 'WRONG_ITEM', lines: [{ lotId: liningLot, quantity: '10', reason: 'Wrong shade of grey' }] }, 201)).claim
    expect(draft).toMatchObject({ status: 'DRAFT', kind: 'RETURN', goodsReceipt: null, lines: [expect.objectContaining({ lot: expect.objectContaining({ id: liningLot }), quantity: '10.0000', uom: 'M' })] })
    expect((await refused('warehouse', 'POST', url(draft.id, '/return'), { version: draft.version, ddt: TYPED_DDT }, 409)).message).toContain('send it to the supplier first')
    draft = (await ok('warehouse', 'POST', url(draft.id, '/send'), { version: draft.version, mail: null })).claim
    expect(draft.status).toBe('SENT')
    expect(await admin(`SELECT count(*)::int AS n FROM "EmailOutbound" WHERE "recordId" = $1`, [draft.id])).toEqual([{ n: 0 }])
    expect((await refused('noDdt', 'POST', url(draft.id, '/return'), { version: draft.version, ddt: TYPED_DDT }, 403)).message).toContain('shipping.ddt.issue')
    const back = await ok('warehouse', 'POST', url(draft.id, '/return'), { version: draft.version, lines: [{ lineId: draft.lines[0].id, fromLocationId: store }], ddt: TYPED_DDT }, 201)
    expect(back.claim.lines[0]).toMatchObject({ move: { reason: 'SUPPLIER_RETURN', quantity: '10.0000', fromLocation: { id: store } }, ddt: { id: back.ddt.id, cancelled: false } })
    expect(Number(await onHand(`"lotId" = $2`, [liningLot]))).toBe(Number(before) - 10)
    expect(back.overReserved).toEqual([])
    draft = back.claim
  })

  it('a stale version is a 409; another tenant and a role limited to another supplier find nothing', async () => {
    expect((await refused('warehouse', 'POST', url(draft.id, '/answer'), { version: draft.version - 1, outcome: 'REJECTED', answer: 'No.' }, 409)).message).toBeTruthy()
    await refused('otherTenant', 'GET', url(draft.id), undefined, 404)
    await refused('otherSupplier', 'GET', url(draft.id), undefined, 404)
    expect((await ok('otherSupplier', 'GET', '/purchasing/claims?open=false')).items).toEqual([])
  })

  it('a rejected claim goes again; the reason list counts its uses', async () => {
    draft = (await ok('warehouse', 'POST', url(draft.id, '/answer'), { version: draft.version, outcome: 'REJECTED', answer: 'The shade is within tolerance.' })).claim
    expect(draft).toMatchObject({ status: 'REJECTED', actions: { send: null, close: null } })
    draft = (await ok('warehouse', 'POST', url(draft.id, '/send'), { version: draft.version, mail: null })).claim
    expect(draft.status).toBe('SENT')
    const [list] = (await ok('buyer', 'GET', '/reasons/lists?list=CLAIM')).lists as Json[]
    const used = Object.fromEntries((list!.reasons as Json[]).map((reason) => [reason.code, reason.usedCount]))
    expect(used).toMatchObject({ QUALITY: 2, WRONG_ITEM: 1 })
  })

  it('cancels a draft with a reason', async () => {
    const seedClaim = (await ok('buyer', 'GET', url(seed.claimId))).claim
    expect(seedClaim.reason).toMatchObject({ code: null, note: expect.stringContaining('SEED-HIDE-0002') })
    const cancelled = (await ok('buyer', 'POST', url(seed.claimId, '/cancel'), { version: seedClaim.version, reason: 'Made again from the discrepancy' })).claim
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Made again from the discrepancy', actions: { cancel: expect.any(String), send: expect.any(String) } })
  })
})

// ---- B-W2b-14: claims follow-ups (the reason code as data, SUPPLIER_RETURN and RETURNED hides, a claim follows its
// replacement DDT, photos, the claim letter) --------------------------------------------------------------------------------

const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex')

/** A picture's bytes (made up) announced, sent to the local store and confirmed: the file. */
async function photo(session: string, path: string, name: string): Promise<Json> {
  const body = Buffer.from(`made-up jpeg bytes ${name} ${newId()}`)
  const announced = await ok(session, 'POST', path, { originalName: name, contentType: 'image/jpeg', sizeBytes: body.length, sha256: sha(body) }, 201)
  expect(announced.file).toMatchObject({ kind: 'PHOTO', status: 'PENDING_UPLOAD' })
  const sent = await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  return (await ok(session, 'POST', `${path}/${announced.file.id}/complete`)).file
}

describe('B-W2b-14 claims follow-ups (Z1:04 … Z1:08)', () => {
  let claim: Json
  let firstPhoto: Json

  it('Z1:04 the CLAIM reason code is its own column; reason keeps the words (the code when there are none); fixed once sent', async () => {
    claim = (await ok('photographer', 'POST', '/purchasing/claims', { kind: 'CLAIM', partyId: A.P2, foundAt: 'CUTTING', reasonCode: 'QUALITY', reasonNote: 'Macchie sulla fodera', lines: [{ lotId: liningLot, quantity: '4' }] }, 201)).claim
    expect(claim.reason).toMatchObject({ code: 'QUALITY', note: 'Macchie sulla fodera' })
    expect(await admin(`SELECT "reasonCode", reason FROM "SupplierClaim" WHERE id = $1`, [claim.id])).toEqual([{ reasonCode: 'QUALITY', reason: 'Macchie sulla fodera' }])
    claim = (await ok('photographer', 'PATCH', url(claim.id), { version: claim.version, reasonNote: null })).claim
    expect(claim.reason).toMatchObject({ code: 'QUALITY', note: null })
    expect(await admin(`SELECT "reasonCode", reason FROM "SupplierClaim" WHERE id = $1`, [claim.id])).toEqual([{ reasonCode: 'QUALITY', reason: 'QUALITY' }])
    claim = (await ok('photographer', 'PATCH', url(claim.id), { version: claim.version, reasonNote: 'Macchie sulla fodera, 4 m' })).claim
    expect(claim.reason).toMatchObject({ code: 'QUALITY', note: 'Macchie sulla fodera, 4 m' })
  })

  it('Z1:08 photos of what is wrong: PHOTO files of the claim, category CLAIM_PHOTO, through the claim only; removed only from a draft, with files.delete', async () => {
    const first = await photo('photographer', url(claim.id, '/photos'), 'macchia-1.jpg')
    expect(first).toMatchObject({ recordType: 'SupplierClaim', recordId: claim.id, visibility: ['OFFICE'] })
    expect(await admin(`SELECT category::text AS category FROM "StoredFile" WHERE id = $1`, [first.id])).toEqual([{ category: 'CLAIM_PHOTO' }])
    const second = await photo('photographer', url(claim.id, '/photos'), 'macchia-2.jpg')
    // The generic files route may not add one (the claims module owns them).
    const generic = await call('photographer', 'POST', '/files', { companyId: A.companyA, recordType: 'SupplierClaim', recordId: claim.id, kind: 'PHOTO', originalName: 'x.jpg', contentType: 'image/jpeg', sizeBytes: 10, sha256: 'a'.repeat(64) })
    expect(generic.statusCode, generic.body).toBe(409)
    expect((await refused('buyer', 'POST', url(claim.id, '/photos'), { originalName: 'x.jpg', contentType: 'image/jpeg', sizeBytes: 10, sha256: 'a'.repeat(64) }, 403)).message).toBe('Adding a photo needs files.upload over the company.')
    expect((await refused('photographer', 'DELETE', `${url(claim.id, '/photos')}/${second.id}?version=${second.version}`, undefined, 403)).message).toBe('Removing a photo needs files.delete over the company.')
    await ok('fileAdmin', 'DELETE', `${url(claim.id, '/photos')}/${second.id}?version=${second.version}`)
    claim = (await ok('photographer', 'GET', url(claim.id))).claim
    expect(claim.photos).toEqual([expect.objectContaining({ id: first.id, originalName: 'macchia-1.jpg', status: 'AVAILABLE' })])
    expect(claim.supplierContact).toMatchObject({ id: A.orderDesk })
    firstPhoto = first
  })

  it('Z1:08 the claim letter: a preview with its banner, no price; a version kept (GeneratedDocument CLAIM_LETTER); the same contents give it back; new contents a new version', async () => {
    const preview = await call('viewer', 'GET', url(claim.id, '/letter'))
    expect(preview.statusCode, preview.body.slice(0, 200)).toBe(200)
    expect(preview.headers['content-type']).toContain('application/pdf')
    const text = await pdfFlatText(preview.rawPayload)
    expect(text).toContain(claim.number)
    expect(text).toMatch(/ANTEPRIMA|PREVIEW/)
    expect(text).not.toMatch(/€|EUR\b|prezzo|price/i)
    const v1 = await ok('photographer', 'POST', url(claim.id, '/letter'), {}, 201)
    expect(v1).toMatchObject({ made: true, letter: { version: 1, number: claim.number } })
    const same = await ok('photographer', 'POST', url(claim.id, '/letter'), {}, 201)
    expect(same).toMatchObject({ made: false, letter: { id: v1.letter.id, version: 1 } })
    claim = (await ok('photographer', 'PATCH', url(claim.id), { version: claim.version, remedy: 'REPLACEMENT' })).claim
    const v2 = await ok('photographer', 'POST', url(claim.id, '/letter'), {}, 201)
    expect(v2).toMatchObject({ made: true, letter: { version: 2 } })
    const rows = await admin<{ version: number; kind: string; recordType: string; fileId: string }>(`SELECT version, kind::text AS kind, "recordType", "fileId" FROM "GeneratedDocument" WHERE "recordId" = $1 ORDER BY version`, [claim.id])
    expect(rows.map((row) => [row.version, row.kind, row.recordType])).toEqual([[1, 'CLAIM_LETTER', 'SupplierClaim'], [2, 'CLAIM_LETTER', 'SupplierClaim']])
    expect(await admin(`SELECT kind::text AS kind, visibility::text[] AS visibility, "partyId" FROM "StoredFile" WHERE id = $1`, [rows[1]!.fileId])).toEqual([{ kind: 'DOCUMENT', visibility: ['OFFICE', 'PARTNER'], partyId: A.P2 }])
    expect((await ok('viewer', 'GET', url(claim.id))).claim.letters.map((letter: Json) => letter.version)).toEqual([2, 1])
    // Back to the first contents: a new version naming version 1's file.
    claim = (await ok('photographer', 'PATCH', url(claim.id), { version: claim.version, remedy: 'CREDIT' })).claim
    const v3 = await ok('photographer', 'POST', url(claim.id, '/letter'), {}, 201)
    expect(v3).toMatchObject({ made: true, letter: { version: 3, fileId: v1.letter.fileId } })
  })

  it('Z1:08 the mail to the supplier carries the current letter; photos are kept after the send', async () => {
    const check = await ok('photographer', 'GET', url(claim.id, '/send-check'))
    expect(check.letter).toEqual({ attached: true, problems: [] })
    expect(check.message).toMatch(/lettera di reclamo|claim letter/)
    const sent = await ok('photographer', 'POST', url(claim.id, '/send'), { version: claim.version, mail: { contactIds: [A.orderDesk] } })
    expect(sent.claim.status).toBe('SENT')
    const current = (await admin<{ id: string; fileId: string }>(`SELECT id, "fileId" FROM "GeneratedDocument" WHERE "recordId" = $1 ORDER BY version DESC LIMIT 1`, [claim.id]))[0]!
    expect(sent.letterId).toBe(current.id)
    const messages = await admin<{ attachmentFileIds: string[] }>(`SELECT m."attachmentFileIds" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'SupplierClaim' AND t."recordId" = $1`, [claim.id])
    expect(messages).toEqual([{ attachmentFileIds: [current.fileId] }])
    expect((await refused('fileAdmin', 'DELETE', `${url(claim.id, '/photos')}/${firstPhoto.id}?version=${firstPhoto.version}`, undefined, 409)).message).toContain('removed only while it is a draft')
    // The reason code is fixed once sent (the database refuses it for every login).
    await expect(admin(`UPDATE "SupplierClaim" SET "reasonCode" = 'WRONG_ITEM' WHERE id = $1`, [claim.id])).rejects.toThrow(/fixed once it is sent/)
  })

  it('Z1:06 / Z1:07 goods back are SUPPLIER_RETURN moves with the CLAIM code; a hide sent back whole is RETURNED (its previous state kept by the database)', async () => {
    const moveId = returned.claim.lines[0].move.id
    expect(await admin(`SELECT reason::text AS reason, "reasonCode", "fromLocationId" FROM "StockMove" WHERE id = $1`, [moveId])).toEqual([{ reason: 'SUPPLIER_RETURN', reasonCode: 'QUALITY', fromLocationId: store }])
    expect(await admin(`SELECT state::text AS state, "previousState"::text AS "previousState" FROM "Hide" WHERE id = $1`, [hide2])).toEqual([{ state: 'RETURNED', previousState: 'FULL' }])
    expect(await admin(`SELECT after->>'state' AS state FROM "AuditLog" WHERE "recordType" = 'Hide' AND "recordId" = $1 AND action = 'purchasing.claims.hideReturned'`, [hide2])).toEqual([{ state: 'RETURNED' }])
    // A reversal of the return that leaves the hide RETURNED is refused at commit (the hide must come back with it).
    await expect(
      admin(
        `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", note, "reversalOfId", "idempotencyKey", "occurredAt")
         SELECT $1, m."tenantId", m."companyId", m."siteId", m.reason, m."itemId", m."itemColourId", m."lotId", m."hideId", m."fromLocationId", m.quantity, m.uom, m."baseQuantity", 'Undo', m.id, $2, now() FROM "StockMove" m WHERE m.id = $3`,
        [newId(), `test-undo-${run}`, moveId],
      ),
    ).rejects.toThrow(/which is still RETURNED/)
  })

  it('Z1:05 a claim line follows the replacement of its cancelled return DDT', async () => {
    const back = await ok('photographer', 'POST', '/purchasing/claims/returns', { partyId: A.P2, lines: [{ lotId: liningLot, quantity: '5', fromLocationId: store }], reasonCode: 'WRONG_ITEM', ddt: TYPED_DDT }, 201)
    const lineId = back.claim.lines[0].id
    expect(back.claim.lines[0]).toMatchObject({ move: { reason: 'SUPPLIER_RETURN' }, ddt: { id: back.ddt.id } })
    await ok('photographer', 'POST', `/shipping/ddts/${back.ddt.id}/cancel`, { reason: 'Wrong carrier' })
    const replacement = await ok('photographer', 'POST', `/shipping/ddt-sources/SupplierClaim/${back.claim.id}/ddt`, TYPED_DDT, 201)
    expect(replacement.claimLinesKeepingOldDdt).toEqual([])
    expect(await admin(`SELECT "ddtId" FROM "SupplierClaimLine" WHERE id = $1`, [lineId])).toEqual([{ ddtId: replacement.ddt.id }])
    const seen = (await ok('photographer', 'GET', url(back.claim.id))).claim
    expect(seen.lines[0]).toMatchObject({ ddt: { id: replacement.ddt.id, cancelled: false }, liveDdt: { id: replacement.ddt.id } })
    expect(await admin(`SELECT before->>'ddtId' AS "from", after->>'ddtId' AS "to" FROM "AuditLog" WHERE "recordType" = 'SupplierClaimLine' AND "recordId" = $1 AND action = 'shipping.ddtOnClaimLine' ORDER BY at, id`, [lineId])).toEqual([
      { from: null, to: back.ddt.id },
      { from: back.ddt.id, to: replacement.ddt.id },
    ])
  })
})
