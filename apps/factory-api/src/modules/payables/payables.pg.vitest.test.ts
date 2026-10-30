import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { supplierInvoiceXml } from '@nexus/factory-domain/payables/testing'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAccounting, type AccountingSeed } from '../../../../../packages/factory-db/seed/accounting'
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../packages/factory-db/seed/email'
import { seed as seedIntegration } from '../../../../../packages/factory-db/seed/integration'
import { seed as seedInventory, type InventorySeed } from '../../../../../packages/factory-db/seed/inventory'
import { seed as seedSubcontract, type SubcontractSeed } from '../../../../../packages/factory-db/seed/subcontract'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { FakeSdi } from '../../adapters/sdi/fake'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { startHarness, type Harness } from '../../platform/auth/sessions/testing/harness'
import { createGateway } from '../../platform/gateway/gateway'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { systemContext } from '../../platform/outbox/system'
import { createPayablesSdi, payablesHandlers, runPickupTick, usePayablesSdi, type PayablesSdi } from './sdi'

/**
 * Supplier and subcontractor invoices (B-W2a-62; FIN-136, FIN-137) on the local stack, through the app's real routes: a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the grants and the
 * …_money_w2a_guards supplier-invoice triggers are real), the factory-db seeds (PO1 SEED-PO-0001 of the supplier P2:
 * 420 ft² of black leather at 4.20 and 24 protectors at 6.50; R1 posted 105 ft² of the leather; P2's SDI invoice
 * 2026/0412 with its price difference; September 2026 HARD-locked), the FAKE SDI intermediary behind the real gateway,
 * the auth harness's file store, sessions from the test authenticator, and the worker emulated by running the payables
 * handlers on the outbox's new events. Every name, VAT number and amount is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/payables`.
 */

let h: Harness
let app: FastifyInstance
let fake: FakeSdi
let runtime: PayablesSdi
let inventory: InventorySeed
let accounting: AccountingSeed
let subcontract: SubcontractSeed

const ns = { a: 'payables-a', b: 'payables-b' } as const
const idOf = (key: string) => seedUuid(ns.a, key)
const A = { tenant: idOf('tenant'), company: idOf('company:A'), P1: idOf('party:P1'), P2: idOf('party:P2'), sdi: idOf('integration:account:sdi') }
const FAKE_VAT = { company: '00000003038', P2: '00000002022', stranger: '00000004044' } as const
const FOREIGN = newId()
const TODAY = businessDate(new Date())

const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const office = (tenantId: string, grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId, actorId, grants })
const CLERK = newId()
const APPROVER = newId()
const SESSIONS: Record<string, SessionContext> = {
  /** Finance's registering hand: registers, maps, disputes; sees costs. */
  clerk: office(A.tenant, [grant(['payables.view', 'payables.manage', 'payables.differences.accept', 'payables.approve', 'money.cost', 'files.read', 'files.upload', 'threads.read', 'threads.post'])], CLERK),
  /** Another finance person: approves and pays. */
  approver: office(A.tenant, [grant(['payables.view', 'payables.approve', 'payables.pay', 'payables.manage', 'money.cost', 'threads.read'])], APPROVER),
  /** The buyer: maps lines, accepts differences, never approves. */
  buyer: office(A.tenant, [grant(['payables.view', 'payables.manage', 'payables.differences.accept', 'money.cost', 'purchasing.view', 'purchasing.claims.manage'])]),
  /** Reads without the cost grain: no amount, no price, no XML. */
  viewer: office(A.tenant, [grant(['payables.view'])]),
  /** Reaches the supplier P1 only. */
  otherSupplier: office(A.tenant, [grant(['payables.view', 'payables.manage', 'money.cost'], [A.P1])]),
  /** The buyer's subcontracting hand: issues a subcontract order. */
  subcontracts: office(A.tenant, [grant(['purchasing.view', 'purchasing.subcontract.manage', 'money.cost'])]),
  /** The warehouse: receives goods. */
  dock: office(A.tenant, [grant(['inventory.receive', 'inventory.stock.view', 'purchasing.view', 'money.cost'])]),
  otherTenant: office(seedUuid(ns.b, 'tenant'), [grant(['payables.view', 'payables.manage', 'money.cost'])]),
  floor: { audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: newId(), deviceId: newId(), grants: [grant(['payables.view'])] } as SessionContext,
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `payables-test-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const url = (id: string, rest = '') => `/payables/invoices/${id}${rest}`
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : [])

// ---- the worker, emulated -------------------------------------------------------------------------------------------------

const seen = new Set<string>()
let handlers: EventHandler[] = []
async function drain(): Promise<void> {
  for (let round = 0; round < 10; round++) {
    const rows = await admin<{ id: string; type: string; version: number; payload: unknown; tenantId: string; companyId: string | null }>(`SELECT id, type, version, payload, "tenantId", "companyId" FROM "OutboxEvent" ORDER BY "occurredAt", id`)
    const fresh = rows.filter((row) => !seen.has(row.id))
    if (fresh.length === 0) return
    for (const row of fresh) {
      seen.add(row.id)
      for (const handler of handlers.filter((entry) => entry.events.includes(row.type))) {
        await handler.handle({ eventId: row.id, type: row.type, version: row.version, tenantId: row.tenantId, companyId: row.companyId, payload: row.payload } as never, { caller: callerFor(h.database, systemContext(row.tenantId, newId())), attempt: 1 })
      }
    }
  }
}

/** P2's invoice through SDI to company A (the FAKE intermediary's inbox). */
function deliver(input: { number: string; lines: { description: string; quantity: string; uom?: string; unitPrice: string; itemCode?: string }[]; orders?: { number: string }[]; supplierVat?: string; documentType?: 'TD01' | 'TD04'; relatedInvoices?: { number: string; date?: string }[]; progressive?: string }) {
  const { xml, fileName } = supplierInvoiceXml({ supplierVat: input.supplierVat ?? FAKE_VAT.P2, buyerVat: FAKE_VAT.company, number: input.number, date: TODAY, lines: input.lines, ...(input.orders ? { orders: input.orders } : {}), ...(input.documentType ? { documentType: input.documentType } : {}), ...(input.relatedInvoices ? { relatedInvoices: input.relatedInvoices } : {}), dueDate: TODAY, progressive: input.progressive ?? String(++keys).padStart(5, '0') })
  return fake.deliver({ tenantId: A.tenant, accountId: A.sdi, xml, fileName })
}

beforeAll(async () => {
  h = await startHarness('payables')
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: h.database, namespace })
  inventory = await seedInventory({ db: h.database, namespace: ns.a })
  accounting = await seedAccounting({ db: h.database, namespace: ns.a })
  subcontract = await seedSubcontract({ db: h.database, namespace: ns.a })
  for (const seedOf of [seedEmail, seedIntegration]) await seedOf({ db: h.database, namespace: ns.a })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000, "callTimeoutMs" = 2000, "circuitFailureThreshold" = 1000 WHERE provider IN ('R2', 'SDI')`)
  await admin(`UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3 WHERE id = $1`, [A.company, `IT${FAKE_VAT.company}`, FAKE_VAT.company])
  await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1`, [A.tenant])
  // A foreign supplier (a German workshop's invoices are typed in from their PDF).
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles, status, country, currency) VALUES ($1, $2, NULL, 'DE-SUP', 'ORGANISATION', 'Beispiel Leder GmbH', '{SUPPLIER}', 'ACTIVE', 'DE', 'EUR')`, [FOREIGN, A.tenant])

  fake = new FakeSdi()
  const gateway = createGateway({ environment: 'test', redis: h.redis, prefix: h.redisPrefix, secrets: h.secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  runtime = createPayablesSdi({ gateway, fake })
  usePayablesSdi(runtime)
  handlers = payablesHandlers(() => runtime)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 240_000)

afterAll(async () => {
  usePayablesSdi(undefined)
  await app?.close()
  await h?.close()
}, 60_000)

beforeEach(async () => {
  for (const row of await admin<{ id: string }>('SELECT id FROM "OutboxEvent"')) seen.add(row.id)
})

describe('the list and its tiles (design finance.payables "To handle")', () => {
  it('shows the seeded SDI invoice under "Differences to check", amounts only with the cost grain, suppliers only where reached', async () => {
    const counts = await ok('clerk', 'GET', `/payables/invoices/counts?companyId=${A.company}`)
    expect(counts).toMatchObject({ differences: 1, toApprove: 0 })
    const listed = await ok('clerk', 'GET', '/payables/invoices?tile=DIFFERENCES')
    expect(listed.items.map((row: Json) => row.number)).toEqual(['2026/0412'])
    expect(listed.items[0]).toMatchObject({ source: 'SDI', matchStatus: 'DIFFERENCES', differencesToCheck: 1, netTotal: 46_650 })
    const blind = await ok('viewer', 'GET', '/payables/invoices?tile=DIFFERENCES')
    expect(keysOf(blind)).not.toContain('netTotal')
    expect((await ok('otherSupplier', 'GET', '/payables/invoices')).items).toEqual([])
    expect((await call('otherSupplier', 'GET', url(accounting.supplierInvoiceId))).statusCode).toBe(404)
  })
  it('walls: no floor, no other tenant', async () => {
    expect((await call('floor', 'GET', '/payables/invoices')).statusCode).toBe(403)
    expect((await call('otherTenant', 'GET', url(accounting.supplierInvoiceId))).statusCode).toBe(404)
  })
})

describe('from SDI: picked up, mapped to the order, matched when the goods arrive, approved, paid (FIN-136, FIN-137)', () => {
  let invoiceId = ''

  it('a pickup records the delivered invoice as SDI said it, by nobody of the office, its line on the order it names', async () => {
    deliver({ number: 'P2-2026-0501', lines: [{ description: 'Paraspalla livello 2', quantity: '24', uom: 'PZ', unitPrice: '6.50', itemCode: 'SEED-ART-300' }], orders: [{ number: 'SEED-PO-0001' }] })
    const pickup = await ok('clerk', 'POST', '/payables/sdi/pickup', { companyId: A.company })
    expect(pickup).toMatchObject({ listed: 1, known: 0, waiting: [] })
    expect(pickup.recorded).toHaveLength(1)
    invoiceId = pickup.recorded[0].invoiceId
    const { invoice } = await ok('clerk', 'GET', url(invoiceId))
    expect(invoice).toMatchObject({ source: 'SDI', kind: 'INVOICE', docType: 'TD01', number: 'P2-2026-0501', status: 'RECEIVED', registeredBy: null, netTotal: 15_600, vatTotal: 3_432, grossTotal: 19_032, dueDate: TODAY, receivedOn: TODAY })
    expect(invoice.lines[0]).toMatchObject({ kind: 'GOODS', quantity: '24', unitPrice: '6.5', netAmount: 15_600, purchaseOrderLine: { orderNumber: 'SEED-PO-0001', seq: 20 } })
    expect(invoice.files.xml).toMatchObject({ kind: 'FISCAL_ARCHIVE', contentType: 'application/xml' })
    // The protectors are at the dock (an OPEN receipt): not received yet.
    expect(invoice.matchStatus).toBe('WAITING_GOODS')
    expect(invoice.matches[0]).toMatchObject({ verdict: 'WAITING', receivedQuantity: '0', invoicedQuantity: '24', withinTolerance: false })
    expect(invoice.approval).toMatchObject({ ready: false })
    expect(invoice.approval.problems.map((problem: Json) => problem.code)).toEqual(['WAITING_GOODS'])
    expect(invoice.actions).toMatchObject({ edit: expect.stringContaining('SDI'), void: expect.stringContaining('never voided'), map: null })
    const row = (await admin('SELECT "createdById", "sdiIdentifier" FROM "SupplierInvoice" WHERE id = $1', [invoiceId]))[0]!
    expect(row.createdById).toBeNull()
  })

  it('a second pickup records nothing twice; the XML as received only with the cost grain', async () => {
    const again = await ok('clerk', 'POST', '/payables/sdi/pickup', { companyId: A.company })
    expect(again).toMatchObject({ listed: 1, known: 1, recorded: [], waiting: [] })
    const xml = await ok('clerk', 'GET', url(invoiceId, '/xml'))
    expect(xml.xml).toContain('<Numero>P2-2026-0501</Numero>')
    expect(xml.read.documents[0].orders[0].document).toBe('SEED-PO-0001')
    expect(keysOf(await ok('viewer', 'GET', url(invoiceId, '/xml')))).not.toContain('xml')
    const status = await ok('clerk', 'GET', `/payables/sdi?companyId=${A.company}`)
    expect(status.companies[0]).toMatchObject({ account: { id: A.sdi, mode: 'FAKE' }, picksUp: true, lastPickup: { byPerson: true, listed: 1, recorded: 0 } })
  })

  it('what SDI said never changes: a line figure is refused, the mapping changes', async () => {
    const { invoice } = await ok('clerk', 'GET', url(invoiceId))
    const error = await refused('clerk', 'PATCH', url(invoiceId, `/lines/${invoice.lines[0].id}`), { version: invoice.version, netAmount: 1 }, 409)
    expect(error.issues).toEqual([{ path: 'refusal/FROM_SDI', message: expect.stringContaining('SDI') }])
    await refused('clerk', 'POST', url(invoiceId, '/void'), { version: invoice.version, reason: 'Typed by mistake' }, 409)
  })

  it('the goods arrive: the worker matches it again (WAITING_GOODS → MATCHED); it is approved and paid', async () => {
    const receipt = await ok('dock', 'POST', '/inventory/receipts', { purchaseOrderId: inventory.supply.purchaseOrderId, supplierDdtNumber: 'DDT-P2-0501', supplierDdtDate: TODAY, lines: [{ purchaseOrderLineId: inventory.supply.protectorLineId, lots: [{ quantity: '24', supplierLotRef: 'PROT-LOT-1' }] }] }, 201)
    expect(receipt.receipt.status).toBe('POSTED')
    await drain()
    let { invoice } = await ok('approver', 'GET', url(invoiceId))
    expect(invoice.matchStatus).toBe('MATCHED')
    expect(invoice.matches[0]).toMatchObject({ verdict: 'WITHIN', receivedQuantity: '24', withinTolerance: true, differenceAmount: 0, words: { en: 'Matched' } })
    expect(invoice.approval.ready).toBe(true)
    expect((await ok('clerk', 'GET', `/payables/invoices/counts?companyId=${A.company}`)).toApprove).toBe(1)
    ;({ invoice } = await ok('approver', 'POST', url(invoiceId, '/approve'), { version: invoice.version, note: 'Protectors received in full.' }))
    expect(invoice).toMatchObject({ status: 'APPROVED', approval: { approvedBy: { id: APPROVER }, note: 'Protectors received in full.' } })
    const future = await refused('approver', 'POST', url(invoiceId, '/pay'), { version: invoice.version, paidOn: '2099-01-01', paymentRef: 'BONIFICO-1' }, 400)
    expect(future.issues[0].path).toBe('body/paidOn')
    ;({ invoice } = await ok('approver', 'POST', url(invoiceId, '/pay'), { version: invoice.version, paidOn: TODAY, paymentRef: 'CRO 0000-FAKE-0001' }))
    expect(invoice).toMatchObject({ status: 'PAID', payment: { paidOn: TODAY, paymentRef: 'CRO 0000-FAKE-0001' } })
    await refused('approver', 'POST', url(invoiceId, '/withdraw-approval'), { version: invoice.version, reason: 'Too late' }, 409)
  })
})

describe('differences: accepted in words, or disputed (design Match "Accept difference with reason")', () => {
  it('the seeded price difference blocks approval until the buyer accepts it; the acceptance survives a match again', async () => {
    let { invoice } = await ok('approver', 'GET', url(accounting.supplierInvoiceId))
    expect(invoice.matchStatus).toBe('DIFFERENCES')
    const blocked = await refused('approver', 'POST', url(accounting.supplierInvoiceId, '/approve'), { version: invoice.version }, 409)
    expect(blocked.issues.map((issue: Json) => issue.path)).toEqual(['refusal/DIFFERENCES'])
    const match = invoice.matches.find((row: Json) => !row.withinTolerance)
    expect(match).toMatchObject({ differenceAmount: 1_050, orderedUnitPrice: '4.2', invoicedUnitPrice: '4.3' })
    expect(match.words.en).toContain('Price differs')
    expect((await call('viewer', 'POST', url(accounting.supplierInvoiceId, `/matches/${match.id}/accept`), { version: invoice.version, note: 'x' })).statusCode).toBe(403)
    ;({ invoice } = await ok('buyer', 'POST', url(accounting.supplierInvoiceId, `/matches/${match.id}/accept`), { version: invoice.version, note: 'The tannery’s November price list: agreed by phone.' }))
    expect(invoice.matches.find((row: Json) => !row.withinTolerance).accepted).toMatchObject({ note: 'The tannery’s November price list: agreed by phone.' })
    ;({ invoice } = await ok('clerk', 'POST', url(accounting.supplierInvoiceId, '/match'), { version: invoice.version }))
    expect(invoice.matches.find((row: Json) => !row.withinTolerance).accepted).not.toBeNull()
    expect(invoice.approval.ready).toBe(true)
    // Sent to the buyer: a note on the invoice's thread (no price in it).
    const sent = await ok('clerk', 'POST', url(accounting.supplierInvoiceId, '/send-to-buyer'), { version: invoice.version, message: 'Please confirm.' })
    const note = (await admin<{ bodyText: string }>(`SELECT m."bodyText" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'SupplierInvoice' AND t."recordId" = $1`, [accounting.supplierInvoiceId]))[0]!
    expect(note.bodyText).toContain('SEED-PO-0001 line 10')
    expect(note.bodyText).not.toMatch(/4[.,]3/)
    ;({ invoice } = await ok('approver', 'POST', url(accounting.supplierInvoiceId, '/approve'), { version: sent.invoice.version }))
    expect(invoice.status).toBe('APPROVED')
  })

  it('the same goods billed twice: the second invoice finds nothing left to bill, and is disputed then reopened', async () => {
    deliver({ number: 'P2-2026-0502', lines: [{ description: 'Pelle bovina nera', quantity: '105', uom: 'FT2', unitPrice: '4.20', itemCode: 'SEED-ART-100' }], orders: [{ number: 'SEED-PO-0001' }] })
    const pickup = await ok('clerk', 'POST', '/payables/sdi/pickup', { companyId: A.company })
    const invoiceId = pickup.recorded[0].invoiceId
    let { invoice } = await ok('clerk', 'GET', url(invoiceId))
    expect(invoice.matches[0]).toMatchObject({ receivedQuantity: '0', invoicedQuantity: '105', withinTolerance: false })
    ;({ invoice } = await ok('clerk', 'POST', url(invoiceId, '/dispute'), { version: invoice.version, reason: 'Billed twice: 2026/0412 bills the same 105 ft².' }))
    expect(invoice).toMatchObject({ status: 'DISPUTED', dispute: { reason: expect.stringContaining('Billed twice') } })
    ;({ invoice } = await ok('clerk', 'POST', url(invoiceId, '/reopen'), { version: invoice.version }))
    expect(invoice.status).toBe('RECEIVED')
  })
})

describe('typed from the PDF ("Add foreign invoice"), separation of duties', () => {
  let invoiceId = ''

  it('an Italian supplier’s invoice is never typed (it comes through SDI)', async () => {
    const error = await refused('clerk', 'POST', '/payables/invoices', { companyId: A.company, partyId: A.P2, source: 'EMAIL', number: 'X-1', issueDate: TODAY, lines: [{ description: 'Pelle', netAmount: 100, vatRatePct: '22' }] }, 409)
    expect(error.issues[0].path).toBe('refusal/COMES_THROUGH_SDI')
  })

  it('a foreign supplier’s invoice is registered, has no order (a service), and is approved by someone else only', async () => {
    let { invoice } = await ok(
      'clerk',
      'POST',
      '/payables/invoices',
      { companyId: A.company, partyId: FOREIGN, source: 'MANUAL', number: 'RE-2026-118', issueDate: TODAY, dueDate: TODAY, lines: [{ description: 'Lederprüfung (Labor)', quantity: '1', unitPrice: '120.00', netAmount: 12_000, vatRatePct: '0', vatNature: 'N2.1' }] },
      201,
    )
    invoiceId = invoice.id
    expect(invoice).toMatchObject({ source: 'MANUAL', status: 'RECEIVED', matchStatus: 'PENDING', netTotal: 12_000, vatTotal: 0, grossTotal: 12_000, registeredBy: { id: CLERK } })
    expect(invoice.vatSummary).toEqual([{ rate: '0.00', nature: 'N2.1', taxable: 12_000, vat: 0 }])
    ;({ invoice } = await ok('clerk', 'POST', url(invoiceId, '/without-order'), { version: invoice.version }))
    expect(invoice).toMatchObject({ matchStatus: 'NO_PO', lines: [{ kind: 'SERVICE' }] })
    const own = await refused('clerk', 'POST', url(invoiceId, '/approve'), { version: invoice.version }, 409)
    expect(own.issues).toEqual([{ path: 'refusal/OWN_INVOICE', message: 'You entered this invoice, so someone else approves it.' }])
    // The bulk approve answers per row.
    const bulk = await ok('clerk', 'POST', '/payables/invoices/approve', { items: [{ id: invoiceId, version: invoice.version }] })
    expect(bulk).toMatchObject({ approved: 0, refused: 1, results: [{ approved: false, refusals: [{ code: 'OWN_INVOICE' }] }] })
    const other = await ok('approver', 'POST', '/payables/invoices/approve', { items: [{ id: invoiceId, version: invoice.version }] })
    expect(other).toMatchObject({ approved: 1, results: [{ approved: true, status: 'APPROVED' }] })
    // The database holds the same rule.
    await expect(admin(`UPDATE "SupplierInvoice" SET "approvedById" = "createdById" WHERE id = $1`, [invoiceId])).rejects.toThrow(/separation of duties/)
  })

  it('a duplicate is refused; a typed one is corrected and voided; a closed month refuses it in words', async () => {
    const duplicate = await refused('clerk', 'POST', '/payables/invoices', { companyId: A.company, partyId: FOREIGN, source: 'MANUAL', number: 'RE-2026-118', issueDate: TODAY, lines: [{ description: 'Doppio', netAmount: 1, vatRatePct: '0', vatNature: 'N2.1' }] }, 409)
    expect(duplicate.issues[0].path).toBe('refusal/DUPLICATE')
    let { invoice } = await ok('clerk', 'POST', '/payables/invoices', { companyId: A.company, partyId: FOREIGN, source: 'EMAIL', number: 'RE-2026-119', issueDate: TODAY, lines: [{ description: 'Versand', netAmount: 2_500, vatRatePct: '0', vatNature: 'N2.1', kind: 'CHARGE' }] }, 201)
    expect(invoice.matchStatus).toBe('NO_PO')
    ;({ invoice } = await ok('clerk', 'PATCH', url(invoice.id, `/lines/${invoice.lines[0].id}`), { version: invoice.version, netAmount: 2_600 }))
    expect(invoice.vatSummary[0].taxable).toBe(2_600)
    ;({ invoice } = await ok('clerk', 'POST', url(invoice.id, '/void'), { version: invoice.version, reason: 'Sent twice by e-mail.' }))
    expect(invoice).toMatchObject({ status: 'VOIDED', voided: { reason: 'Sent twice by e-mail.' } })
    const locked = await refused('clerk', 'POST', '/payables/invoices', { companyId: A.company, partyId: FOREIGN, source: 'MANUAL', number: 'RE-2026-090', issueDate: '2026-09-10', receivedOn: '2026-09-15', lines: [{ description: 'Settembre', netAmount: 100, vatRatePct: '0', vatNature: 'N2.1' }] }, 409)
    expect(locked.message).toMatch(/closed for good/)
  })
})

describe('what waits for a person, and the scheduler', () => {
  it('a delivery from a supplier that is not among the parties waits, in words; the scheduler’s tick picks up through the worker', async () => {
    deliver({ number: 'UNK-1', supplierVat: FAKE_VAT.stranger, lines: [{ description: 'Filo', quantity: '1', unitPrice: '10.00' }] })
    await runPickupTick({ database: h.database, log: { info() {}, warn() {}, error() {} }, runtime })
    await drain()
    const status = await ok('clerk', 'GET', `/payables/sdi?companyId=${A.company}`)
    expect(status.companies[0].lastPickup).toMatchObject({ byPerson: false, recorded: 0 })
    expect(status.companies[0].lastPickup.waiting).toEqual([expect.objectContaining({ problem: expect.stringContaining('not a supplier among the parties') })])
    expect(await admin(`SELECT id FROM "SupplierInvoice" WHERE number = 'UNK-1'`)).toEqual([])
  })

  it('a credit note names the invoice it credits and is not matched against receipts', async () => {
    deliver({ number: 'NC-2026-0001', documentType: 'TD04', lines: [{ description: 'Storno prezzo', quantity: '1', unitPrice: '10.50' }], relatedInvoices: [{ number: '2026/0412' }] })
    const pickup = await ok('clerk', 'POST', '/payables/sdi/pickup', { companyId: A.company })
    const recorded = pickup.recorded.find((row: Json) => row.number === 'NC-2026-0001')
    const { invoice } = await ok('clerk', 'GET', url(recorded.invoiceId))
    expect(invoice).toMatchObject({ kind: 'CREDIT_NOTE', docType: 'TD04', matchStatus: 'NO_PO', creditOf: { id: accounting.supplierInvoiceId, number: '2026/0412' } })
    const notAnInvoice = await refused('clerk', 'POST', url(accounting.supplierInvoiceId, '/settle-claim'), { version: 1, claimId: newId() }, 409)
    expect(notAnInvoice.issues[0].path).toBe('refusal/NOT_A_CREDIT_NOTE')
    const unknownClaim = await refused('buyer', 'POST', url(recorded.invoiceId, '/settle-claim'), { version: invoice.version, claimId: newId() }, 404)
    expect(unknownClaim.message).toContain('claim')
  })
})

describe('a subcontractor’s invoice (terzista): mapped to its subcontract order, matched on the pieces back good', () => {
  it('is never mapped to a draft order; once issued, it waits for the pieces to come back', async () => {
    deliver({ number: 'P2-LAV-0007', lines: [{ description: 'Cucitura giacca SEED-JKT-01', quantity: '7', uom: 'PZ', unitPrice: '4.50' }], orders: [{ number: 'SEED-SC-0001' }] })
    const pickup = await ok('clerk', 'POST', '/payables/sdi/pickup', { companyId: A.company })
    const recorded = pickup.recorded.find((row: Json) => row.number === 'P2-LAV-0007')
    let { invoice } = await ok('clerk', 'GET', url(recorded.invoiceId))
    // The order is a draft: not suggested, and refused when chosen.
    expect(invoice).toMatchObject({ matchStatus: 'PENDING', lines: [{ kind: 'GOODS', subcontractOrder: null, purchaseOrderLine: null }] })
    const candidates = await ok('clerk', 'GET', url(invoice.id, '/candidates'))
    expect(candidates.subcontractOrders).toEqual([])
    const draft = await refused('clerk', 'PATCH', url(invoice.id, `/lines/${invoice.lines[0].id}`), { version: invoice.version, subcontractOrderId: subcontract.orderId }, 400)
    expect(draft.issues[0]).toMatchObject({ path: 'body/subcontractOrderId', message: expect.stringContaining('draft') })
    const order = await ok('subcontracts', 'GET', `/purchasing/subcontracting/orders/${subcontract.orderId}`)
    await ok('subcontracts', 'POST', `/purchasing/subcontracting/orders/${subcontract.orderId}/issue`, { version: order.order.version })
    ;({ invoice } = await ok('clerk', 'PATCH', url(invoice.id, `/lines/${invoice.lines[0].id}`), { version: invoice.version, subcontractOrderId: subcontract.orderId }))
    expect(invoice).toMatchObject({ matchStatus: 'WAITING_GOODS', lines: [{ kind: 'SUBCONTRACT', subcontractOrder: { id: subcontract.orderId } }] })
    expect(invoice.matches[0]).toMatchObject({ unit: 'PCS', orderedQuantity: '7.0000', receivedQuantity: '0', invoicedQuantity: '7', orderedUnitPrice: '4.5', verdict: 'WAITING' })
  })
})
