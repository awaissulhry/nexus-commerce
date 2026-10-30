import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/invoicing/from-shipment/deadlines'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedReasons } from '../../../../../packages/factory-db/seed/reasons'
import { seed as seedReceivables, type ReceivablesSeed } from '../../../../../packages/factory-db/seed/receivables'
import { seed as seedReturns, type ReturnsSeed } from '../../../../../packages/factory-db/seed/returns'
import { seed as seedSchedule } from '../../../../../packages/factory-db/seed/schedule'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness } from '../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../platform/outbox/system'
import { creditNoteHandlers } from '../invoicing/credit-note/handlers'
import { orderHandlers } from '../sales/orders/handlers'

/**
 * B-W2a-61 — credit notes from returns (FIN-070), refunds (FIN-127), one payment to many invoices with a credit balance
 * (FIN-122), on the local stack: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security and the …_money_guards / …_money_w2a_guards triggers are real), the factory-db seeds of one tenant (P1's
 * FT-2026-00001 of two sample jackets 610.00, 200.00 paid by a 400.00 transfer on account; SEED-SO-0001's deposit and its
 * TD02 FT-2026-00003; a duplicate transfer of 100.00 with 50.00 to refund, DUE; SEED-RMA-0001 waiting for one sample
 * jacket), the real office sign-in of a finance person (step-up to issue), and a second app on the same database with
 * test sessions (sales decides the return and cancels the order; the walls). Files on the FAKE R2; no SDI send; no bank.
 * Every name, number and amount is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/payments/refunds`.
 */

let h: Harness
let walls: FastifyInstance
let finance: Browser
let secret: string
let seeded: ReturnsSeed
let receivables: ReceivablesSeed

const NS = 'w2a61-refunds-a'
const NS_B = 'w2a61-refunds-b'
const A = { tenant: seedUuid(NS, 'tenant'), company: seedUuid(NS, 'company:A'), site: seedUuid(NS, 'site:A1'), P1: seedUuid(NS, 'party:P1') }
const B = { tenant: seedUuid(NS_B, 'tenant') }
const TODAY = () => businessDate(new Date())
const YEAR = TODAY().slice(0, 4)
const ids = { balanceRequest: newId(), balanceStep: newId() }
const S: Record<string, any> = {}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const events = (type: string, subject?: string) => admin<{ subject: string; payload: Json }>(`SELECT subject, payload FROM "OutboxEvent" WHERE type = $1 ${subject ? 'AND subject = $2' : ''} ORDER BY "occurredAt", id`, subject ? [type, subject] : [type])

/** The finance person (real sign-in): invoices, payments, refunds. */
async function as(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await finance.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}))
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
const refused = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body: unknown, status: number): Promise<Json> => (await as(method, url, body, status)).error
async function issue(invoiceId: string): Promise<Json> {
  await stepUp(h, finance, secret)
  return (await as('POST', `/invoicing/invoices/${invoiceId}/issue`, {})).invoice
}
const invoice = async (invoiceId: string): Promise<Json> => (await as('GET', `/invoicing/invoices/${invoiceId}`)).invoice

const RETURNS: Permission[] = ['sales.returns.view', 'sales.returns.manage', 'sales.returns.decide', 'sales.returns.receive', 'sales.returns.inspect', 'orders.view', 'orders.manage', 'money.price']
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (tenantId: string, permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants: [grant(permissions)] })
const SESSIONS: Record<string, () => SessionContext> = {
  sales: () => office(A.tenant, RETURNS),
  viewer: () => office(A.tenant, ['payments.view', 'invoices.view']),
  recorder: () => office(A.tenant, ['payments.view', 'payments.record', 'money.price']),
  otherTenant: () => office(B.tenant, ['payments.view', 'payments.refund', 'invoices.view', 'invoices.manage', 'money.price']),
  floor: () => ({ audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: A.site, deviceId: newId(), grants: [grant(['payments.view', 'payments.refund', 'money.price'])] }),
  partner: () => ({ audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: A.P1, grants: [grant(['payments.view', 'payments.refund', 'money.price'])] }),
}
let counter = 0
async function wall(session: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, status = 200): Promise<Json> {
  const headers = { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `w2a61-${++counter}-${newId()}` }) }
  const response = await walls.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) })
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}

/** The worker's handler on return.credit_due (run here, as the system of the tenant). */
async function creditDue(payload: Json): Promise<void> {
  const handler = creditNoteHandlers().find((entry) => entry.name === 'invoicing.creditNoteFromReturn')!
  const envelope = { eventId: newId(), type: 'return.credit_due', version: 1, tenantId: A.tenant, payload } as never
  await handler.handle(envelope, { caller: callerFor(h.database, systemContext(A.tenant, newId())), attempt: 1 } as never)
}

/** The worker's handler on payment.deposit_paid (run here): the step that names the request becomes PAID. */
async function followDeposit(depositRequestId: string): Promise<void> {
  const handler = orderHandlers().find((entry) => entry.name === 'sales.ordersFollowDeposits')!
  const envelope = { eventId: newId(), type: 'payment.deposit_paid', version: 1, tenantId: A.tenant, payload: { depositRequestId, partyId: A.P1, orderId: seeded.money.sales.orderId } } as never
  await handler.handle(envelope, { caller: callerFor(h.database, systemContext(A.tenant, newId())), attempt: 1 } as never)
}

beforeAll(async () => {
  h = await startHarness('payments_refunds')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedCore({ db: h.database, namespace: NS_B })
  seeded = await seedReturns({ db: h.database, namespace: NS })
  receivables = await seedReceivables({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  await seedSchedule({ db: h.database, namespace: NS })
  // Made-up legal data (c.c. art. 2250, FatturaPA CedentePrestatore) and this year's series with no last date.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "regimeFiscale" = 'RF01', "reaOffice" = 'MI', "reaNumber" = '0000001', address = $2::jsonb WHERE id = $1`, [
    A.company,
    JSON.stringify({ line1: 'Via Esempio 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' }),
  ])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'INVOICE', 'MAIN', $4, 'YEARLY', 'FT-{YYYY}-{N:5}', true) ON CONFLICT DO NOTHING`, [newId(), A.tenant, A.company, YEAR])
  await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1 AND kind IN ('DDT', 'INVOICE')`, [A.tenant])
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1`, [A.tenant])
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))

  // SEED-SO-0001's balance before shipping (B-W2a-F2: its own deposit request, a TD02 when paid), as sales opens it.
  await admin(`INSERT INTO "DepositRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, "depositPct", currency, amount, "dueDate", "fiscalDocument", "fiscalRule") VALUES ($1, $2, $3, $4, $5, 'ACCONTO', 20, 'EUR', 50000, $6, 'TD02', 'DEPOSIT_INVOICE_IT')`, [
    ids.balanceRequest,
    A.tenant,
    A.company,
    A.P1,
    seeded.money.sales.orderId,
    addDays(TODAY(), 10),
  ])
  await admin(`INSERT INTO "SalesOrderMilestone" (id, "tenantId", "companyId", "orderId", "partyId", seq, kind, amount, "depositRequestId") VALUES ($1, $2, $3, $4, $5, 90, 'BEFORE_SHIPPING', 50000, $6)`, [
    ids.balanceStep,
    A.tenant,
    A.company,
    seeded.money.sales.orderId,
    A.P1,
    ids.balanceRequest,
  ])

  const user = await addUser(h, { id: A.tenant, slug: NS, companies: [{ id: A.company, code: 'SCA' }] }, { email: 'fina.refunds@w2a61-refunds-a.example.com', role: 'finance' })
  finance = new Browser(h.app)
  const signedIn = await finance.signIn(NS, user.email, user.password)
  expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200)
  secret = await enrolTotp(h, finance)
  walls = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null), logger: false },
  )
}, 300_000)

afterAll(async () => {
  await walls?.close()
  await h?.close()
}, 60_000)

const FT1 = () => seeded.money.sampleInvoiceId

describe('one payment to many invoices; what it leaves is the credit balance (FIN-122)', () => {
  it("the open items name the balance's step, suggest oldest first, and show the customer's credit balance", async () => {
    const open = await as('GET', `/payments/open-items?companyId=${A.company}&partyId=${A.P1}&amount=100000`)
    expect(open.items.map((item: Json) => [item.target, item.number ?? item.orderNumber, item.stepKind, item.openAmount, item.suggestedAmount])).toEqual([
      ['INVOICE', 'FT-2026-00001', null, 41000, 41000],
      ['DEPOSIT_REQUEST', 'SEED-SO-0001', 'BEFORE_SHIPPING', 50000, 50000],
    ])
    expect(open.left).toEqual({ amount: 100000, afterSuggestion: 9000 })
    // 200.00 of the transfer on account, 50.00 of the duplicate transfer (the other 50.00 is due to be refunded).
    expect(open.creditBalance).toEqual([{ currency: 'EUR', amount: 25000 }])
  })

  it('money held by a refund is neither placed nor voided: refused in words, not by the database', async () => {
    const overpayment = receivables.overpaymentId
    expect((await refused('POST', `/payments/${overpayment}/allocations`, { allocations: [{ invoiceId: FT1(), amount: 6000 }] }, 409)).message).toBe('The payment has 50.00 EUR left to allocate; allocate at most that.')
    expect((await refused('POST', `/payments/${overpayment}/void`, { reason: 'Typed twice.' }, 409)).message).toBe('Part of the payment is refunded or due to be: cancel or void the refund first, then void the payment.')
    expect((await as('GET', `/payments/${overpayment}`)).payment).toMatchObject({ amount: 10000, allocated: 0, refunded: 5000, unallocated: 5000, refunds: [{ id: receivables.refundId, status: 'DUE', amount: 5000 }] })
  })

  it('records one transfer placed on an invoice and a balance request; the rest stays on account', async () => {
    const recorded = await as('POST', '/payments', { companyId: A.company, partyId: A.P1, amount: 100000, receivedOn: TODAY(), externalRef: 'TRN-W2A61-0001', allocations: [{ invoiceId: FT1() }, { depositRequestId: ids.balanceRequest }] }, 201)
    S.payment = recorded.payment.id
    await followDeposit(ids.balanceRequest)
    expect(recorded.payment).toMatchObject({ allocated: 91000, unallocated: 9000, refunded: 0 })
    expect(recorded.payment.placedOn.map((chip: Json) => [chip.target, chip.amount])).toEqual([
      ['INVOICE', 41000],
      ['DEPOSIT_REQUEST', 50000],
    ])
    const balance = await as('GET', `/payments/credit-balance?companyId=${A.company}&partyId=${A.P1}`)
    expect(balance.balances).toEqual([{ currency: 'EUR', amount: 34000 }])
    expect(balance.payments.find((row: Json) => row.id === S.payment)).toMatchObject({ amount: 100000, allocated: 91000, refunded: 0, unplacedAmount: 9000 })
    expect((await invoice(FT1())).openAmount).toBe(0)
  })
})

describe('a balance before shipping paid, its TD02, the order cancelled: credit note and refund (B-W2a-F2 path)', () => {
  it('the balance TD02 behaves as the deposit TD02: credited in full, its money refunded, the settlement owes nothing back', async () => {
    const draft = (await as('POST', '/invoicing/invoices/deposit-draft', { depositRequestId: ids.balanceRequest }, 201)).invoice
    expect(draft).toMatchObject({ docType: 'TD02', grossTotal: 50000 })
    const td02 = await issue(draft.id)
    S.balanceTd02 = td02.id
    const cancelled = await wall('sales', 'POST', `/sales/orders/${seeded.money.sales.orderId}/cancel`, { version: (await wall('sales', 'GET', `/sales/orders/${seeded.money.sales.orderId}`)).order.version, reason: 'The brand stopped the line.' })
    expect(cancelled.paidDepositRequestIds).toEqual(expect.arrayContaining([seeded.money.sales.depositRequestId, ids.balanceRequest]))

    const note = (await as('POST', `/invoicing/invoices/${td02.id}/credit-note`, { reason: 'DEPOSIT_REFUND', full: true }, 201))
    expect(note).toMatchObject({ refundDueAmount: 50000, invoice: { docType: 'TD04', creditOfId: td02.id, grossTotal: 50000 } })
    const issued = await issue(note.invoice.id)
    expect((await events('invoice.refund_due', issued.id)).map((row) => row.payload)).toEqual([{ invoiceId: issued.id, creditOfId: td02.id, partyId: A.P1 }])
    const before = (await as('GET', `/invoicing/orders/${seeded.money.sales.orderId}/settlement`)).settlement
    expect(before.refundDueAmount).toBe(50000)
    expect(before.gaps).toContain('REFUND_DUE')

    const open = await as('GET', `/payments/refunds/open?partyId=${A.P1}`)
    expect(open.creditNotesToRefund.find((row: Json) => row.creditNoteId === issued.id)).toMatchObject({ creditOfId: td02.id, creditOfDocType: 'TD02', refundableAmount: 50000, refundedAmount: 0 })
    const refund = (await as('POST', '/payments/refunds', { creditNoteId: issued.id, paid: { paidOn: TODAY(), externalRef: 'rfd w2a61 0001' } }, 201)).refund
    expect(refund).toMatchObject({ source: 'CREDIT_NOTE', status: 'PAID', amount: 50000, externalRef: 'RFDW2A610001', creditNote: { id: issued.id, creditOfId: td02.id, creditOfDocType: 'TD02' } })
    const after = (await as('GET', `/invoicing/orders/${seeded.money.sales.orderId}/settlement`)).settlement
    expect(after.refundDueAmount).toBe(0)
    expect(after.gaps).not.toContain('REFUND_DUE')
    expect(after.gaps).toContain('ORDER_CANCELLED')
    expect((await invoice(td02.id)).refundDueAmount).toBe(0)
  })
})

describe('a credit note drafted from a customer return (FIN-070)', () => {
  it('the decision emits return.credit_due; the worker drafts the TD04 with the RMA line, the pieces, the credit and the billed VAT', async () => {
    const returnId = seeded.waitingReturnId
    let record = (await wall('sales', 'GET', `/sales/returns/${returnId}`)).return
    record = (await wall('sales', 'POST', `/sales/returns/${returnId}/receipts`, { version: record.version, parcels: 1, parcelCondition: 'INTACT', lines: [{ lineId: seeded.waitingLineId, quantity: 1 }] }, 201)).return
    record = (await wall('sales', 'POST', `/sales/returns/${returnId}/grades`, { version: record.version, lines: [{ lineId: seeded.waitingLineId, grade: 'NEW', cause: 'NO_FAULT' }] })).return
    record = (await wall('sales', 'POST', `/sales/returns/${returnId}/decisions`, { version: record.version, lines: [{ lineId: seeded.waitingLineId, disposition: 'CREDIT_ONLY', goodsOutcome: 'SCRAP' }] })).return
    const [due] = await events('return.credit_due', returnId)
    expect(due?.payload).toMatchObject({ returnId, lineIds: [seeded.waitingLineId] })

    await creditDue(due!.payload)
    const view = await as('GET', `/invoicing/returns/${returnId}/credit-notes`)
    expect(view).toMatchObject({ creditDecidedAmount: 25000, creditNotedAmount: 25000, toCredit: [], notCredited: [{ lineId: seeded.waitingLineId, code: 'ON_CREDIT_NOTE' }] })
    expect(view.creditNotes).toHaveLength(1)
    expect(view.creditNotes[0]).toMatchObject({ status: 'DRAFT', number: null, creditOfId: FT1(), creditOfNumber: 'FT-2026-00001', netTotal: 25000, grossTotal: 30500, lines: [{ returnLineId: seeded.waitingLineId, seq: 10, quantity: '1.0000', netAmount: 25000 }], refunds: [] })
    S.returnNote = view.creditNotes[0].id
    const draft = await invoice(S.returnNote)
    expect(draft).toMatchObject({ docType: 'TD04', priceBasis: 'NET', creditOfId: FT1(), causale: expect.stringMatching(/^Nota di credito: Reso merce - RMA .+ - rif\. fattura n\. FT-2026-00001 del 28\/10\/2026 \(art\. 26 DPR 633\/1972\)$/) })
    expect(draft.lines).toEqual([expect.objectContaining({ kind: 'GOODS', quantity: '1.0000', unitPrice: '250.000000', vatRatePct: '22.00', netAmount: 25000, returnLineId: seeded.waitingLineId, description: expect.stringMatching(/^Reso .+ riga 10: /) })])
    expect((await events('invoice.return_credit_drafted', S.returnNote)).map((row) => row.payload)).toEqual([{ invoiceId: S.returnNote, returnId, creditOfId: FT1(), partyId: A.P1, returnLineIds: [seeded.waitingLineId] }])
  })

  it('a repeat of the event, or a person on the RMA, drafts nothing twice; its lines stay the decided credit', async () => {
    const returnId = seeded.waitingReturnId
    await creditDue({ returnId, lineIds: [seeded.waitingLineId] })
    expect(await admin(`SELECT count(*)::int AS n FROM "Invoice" WHERE "creditOfId" = $1 AND "docType" = 'TD04'`, [FT1()])).toEqual([{ n: 1 }])
    const again = await refused('POST', `/invoicing/returns/${returnId}/credit-notes`, {}, 409)
    expect(again.message).toBe('Line 10 is on credit note (draft) already (DRAFT).')
    const typed = await refused('PUT', `/invoicing/invoices/${S.returnNote}/lines`, { lines: [{ description: 'Altro', quantity: '1', unitPrice: '10', vatRatePct: '22' }] }, 409)
    expect(typed.message).toContain('credits a customer return')
    // Walls: the floor and a partner never; a viewer without invoices.manage may not draft.
    await wall('floor', 'GET', `/invoicing/returns/${returnId}/credit-notes`, undefined, 403)
    await wall('viewer', 'POST', `/invoicing/returns/${returnId}/credit-notes`, {}, 403)
    await wall('otherTenant', 'GET', `/invoicing/returns/${returnId}/credit-notes`, undefined, 404)
  })

  it('issued by a person: FT-2026-00001 was paid in full, so a refund is due', async () => {
    const issued = await issue(S.returnNote)
    expect(issued).toMatchObject({ docType: 'TD04', status: 'ISSUED', number: expect.stringMatching(/^FT-/) })
    S.returnNoteNumber = issued.number
    expect((await events('invoice.refund_due', S.returnNote)).map((row) => row.payload)).toEqual([{ invoiceId: S.returnNote, creditOfId: FT1(), partyId: A.P1 }])
    expect(await invoice(FT1())).toMatchObject({ paidAmount: 61000, creditedAmount: 30500, openAmount: 0, refundDueAmount: 30500 })
  })

  it('a second credit of the same return line is refused at issue in words (pieces), before the database', async () => {
    const other = (await as('POST', `/invoicing/invoices/${FT1()}/credit-note`, { reason: 'RETURN', amount: 1000, amountBasis: 'NET' }, 201)).invoice
    await admin(`UPDATE "InvoiceLine" SET "returnLineId" = $1 WHERE "invoiceId" = $2`, [seeded.waitingLineId, other.id])
    const checks = await as('GET', `/invoicing/invoices/${other.id}/checks`)
    expect(checks.ready).toBe(false)
    expect(checks.problems.map((problem: Json) => problem.code)).toContain('RETURN_OVER')
    expect(checks.problems.find((problem: Json) => problem.code === 'RETURN_OVER').message).toMatch(/line 10 brings back 1 piece\(s\); with this credit note 2 would be credited \(1 on other credit notes\)\.$/)
    await as('DELETE', `/invoicing/invoices/${other.id}?version=${other.version}`)
  })
})

describe('refunds (FIN-127)', () => {
  it('"Refunds to make" lists the credit note; a refund is capped at what is refundable, DUE with a due date', async () => {
    const open = await as('GET', `/payments/refunds/open?companyId=${A.company}`)
    const row = open.creditNotesToRefund.find((entry: Json) => entry.creditNoteId === S.returnNote)
    expect(row).toMatchObject({ number: S.returnNoteNumber, creditOfId: FT1(), creditOfNumber: 'FT-2026-00001', refundableAmount: 30500, refundedAmount: 0 })
    expect(open.counts.refundsDue).toBe(1)
    expect((await refused('POST', '/payments/refunds', { creditNoteId: S.returnNote, amount: 30501 }, 409)).message).toBe(`The credit note ${S.returnNoteNumber} has 305.00 EUR left to refund: refund at most that.`)
    await refused('POST', '/payments/refunds', { creditNoteId: S.returnNote, paymentId: S.payment }, 400)
    const due = (await as('POST', '/payments/refunds', { creditNoteId: S.returnNote, dueDate: addDays(TODAY(), 14), internalNote: 'By bank transfer to the IBAN on file.' }, 201)).refund
    S.refund = due
    expect(due).toMatchObject({ status: 'DUE', amount: 30500, dueDate: addDays(TODAY(), 14), source: 'CREDIT_NOTE', paidOn: null, people: [expect.objectContaining({ name: expect.any(String) })] })
    expect((await events('refund.recorded', due.id)).map((event) => event.payload)).toEqual([{ refundId: due.id, partyId: A.P1, source: 'CREDIT_NOTE', sourceId: S.returnNote, status: 'DUE' }])
    expect((await refused('POST', '/payments/refunds', { creditNoteId: S.returnNote }, 409)).message).toBe(`Nothing is left to refund on the credit note ${S.returnNoteNumber}.`)
    // Still owed until paid: the invoice says so.
    expect((await invoice(FT1())).refundDueAmount).toBe(30500)
  })

  it('a DUE refund changes within the cap; paid with the bank date and reference (counted once); a value date to come is refused', async () => {
    const lower = (await as('PATCH', `/payments/refunds/${S.refund.id}`, { version: S.refund.version, amount: 20000 })).refund
    expect(lower).toMatchObject({ amount: 20000, version: S.refund.version + 1 })
    expect((await refused('PATCH', `/payments/refunds/${S.refund.id}`, { version: lower.version, amount: 30501 }, 409)).message).toContain('has 305.00 EUR left to refund')
    const back = (await as('PATCH', `/payments/refunds/${S.refund.id}`, { version: lower.version, amount: 30500 })).refund
    await refused('PATCH', `/payments/refunds/${S.refund.id}`, { version: lower.version, amount: 30000 }, 409)
    expect((await refused('POST', `/payments/refunds/${S.refund.id}/paid`, { version: back.version, paidOn: addDays(TODAY(), 1), externalRef: 'CRO-W2A61-0002' }, 400)).issues).toEqual([{ path: 'body/paidOn', message: 'The transfer left the bank on a day that has not come yet: check the value date.' }])
    expect((await refused('POST', `/payments/refunds/${S.refund.id}/paid`, { version: back.version, paidOn: TODAY(), externalRef: 'RFDW2A610001' }, 409)).message).toMatch(/^This bank reference is recorded already on the refund paid on /)
    const paid = (await as('POST', `/payments/refunds/${S.refund.id}/paid`, { version: back.version, paidOn: TODAY(), externalRef: 'CRO-W2A61-0002' })).refund
    expect(paid).toMatchObject({ status: 'PAID', paidOn: TODAY(), externalRef: 'CRO-W2A61-0002', amount: 30500 })
    expect((await events('refund.paid', S.refund.id)).map((event) => event.payload)).toEqual([{ refundId: S.refund.id, partyId: A.P1 }])
    expect(await invoice(FT1())).toMatchObject({ refundDueAmount: 0, openAmount: 0 })
    expect((await as('GET', `/payments/refunds/open?companyId=${A.company}`)).creditNotesToRefund.find((entry: Json) => entry.creditNoteId === S.returnNote)).toBeUndefined()
    await refused('PATCH', `/payments/refunds/${S.refund.id}`, { version: paid.version, amount: 100 }, 409)
    S.refund = paid
  })

  it('a refund recorded as paid by mistake is voided (payments.void): the money is owed again; a due one is cancelled with why', async () => {
    await wall('recorder', 'POST', `/payments/refunds/${S.refund.id}/void`, { version: S.refund.version, reason: 'Typed on the wrong customer.' }, 403)
    const voided = (await as('POST', `/payments/refunds/${S.refund.id}/void`, { version: S.refund.version, reason: 'Typed on the wrong customer.' })).refund
    expect(voided).toMatchObject({ status: 'VOIDED', voidReason: 'Typed on the wrong customer.', paidOn: TODAY() })
    expect((await invoice(FT1())).refundDueAmount).toBe(30500)
    await refused('POST', `/payments/refunds/${S.refund.id}/void`, { version: voided.version, reason: 'Again.' }, 409)
    const due = (await as('POST', '/payments/refunds', { creditNoteId: S.returnNote }, 201)).refund
    expect(due).toMatchObject({ status: 'DUE', amount: 30500 })
    const cancelled = (await as('POST', `/payments/refunds/${due.id}/cancel`, { version: due.version, reason: 'The customer keeps the credit for its next order.' })).refund
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'The customer keeps the credit for its next order.' })
    expect((await events('refund.cancelled', due.id)).length).toBe(1)
    await refused('POST', `/payments/refunds/${due.id}/paid`, { version: cancelled.version, paidOn: TODAY(), externalRef: 'CRO-W2A61-0003' }, 409)
    const list = await as('GET', `/payments/refunds?partyId=${A.P1}&view=closed`)
    expect(list.refunds.map((row: Json) => row.status).sort()).toEqual(['CANCELLED', 'VOIDED'])
  })

  it('walls: the floor and a partner never; without the price grain no amount; another tenant sees nothing', async () => {
    await wall('floor', 'GET', '/payments/refunds', undefined, 403)
    await wall('partner', 'GET', '/payments/refunds', undefined, 403)
    await wall('viewer', 'POST', '/payments/refunds', { creditNoteId: S.returnNote }, 403)
    const blind = await wall('viewer', 'GET', `/payments/refunds?partyId=${A.P1}`)
    expect(blind.refunds.length).toBeGreaterThan(0)
    expect(blind.refunds[0]).not.toHaveProperty('amount')
    await wall('otherTenant', 'GET', `/payments/refunds/${S.refund.id}`, undefined, 404)
    await wall('otherTenant', 'POST', '/payments/refunds', { creditNoteId: S.returnNote }, 404)
  })
})

describe('carry the credit: an overpayment becomes the credit balance (FIN-122)', () => {
  it("the credited invoice's excess goes back to its newest allocations' payments; then it is refunded or kept", async () => {
    // The newest allocations first: the seed's on-account allocation is dated 10 Nov (after today's), then today's.
    const onAccount = seeded.money.onAccountPaymentId
    const released = await as('POST', '/payments/release-overpayment', { invoiceId: FT1(), note: 'The customer keeps the credit of the return.' })
    expect(released).toMatchObject({ releasedAmount: 30500, invoice: { paidAmount: 30500, worthAmount: 30500 } })
    expect(released.payments).toEqual([
      { paymentId: onAccount, unplacedAmount: 40000 },
      { paymentId: S.payment, unplacedAmount: 19500 },
    ])
    expect(released.balances).toEqual([{ currency: 'EUR', amount: 64500 }])
    expect(await invoice(FT1())).toMatchObject({ paidAmount: 30500, openAmount: 0, refundDueAmount: 0 })
    const rows = await admin(`SELECT amount, note FROM "PaymentAllocation" WHERE "paymentId" = $1 AND "invoiceId" = $2 ORDER BY "createdAt", id`, [S.payment, FT1()])
    expect(rows.map((row) => row.amount)).toEqual([41000, -41000, 30500])
    expect(rows[1]!.note).toBe('The customer keeps the credit of the return. (carried to the credit balance)')
    expect((await events('payment.overpayment_released', FT1())).map((event) => event.payload)).toEqual([{ invoiceId: FT1(), partyId: A.P1, paymentIds: [onAccount, S.payment] }])
    expect((await refused('POST', '/payments/release-overpayment', { invoiceId: FT1(), note: 'Again.' }, 409)).message).toMatch(/^Invoice FT-2026-00001 is not paid beyond what it is worth/)
    expect((await refused('POST', '/payments/refunds', { creditNoteId: S.returnNote }, 409)).message).toBe(`Nothing is left to refund on the credit note ${S.returnNoteNumber}.`)
    await wall('viewer', 'POST', '/payments/release-overpayment', { invoiceId: FT1(), note: 'x' }, 403)
  })

  it("a refund of the payment's credit balance, capped by what it has unplaced; the matcher suggests what is left", async () => {
    expect((await refused('POST', '/payments/refunds', { paymentId: S.payment, amount: 19501 }, 409)).message).toMatch(/^The payment received on .+ \(TRN-W2A61-0001\) has 195\.00 EUR left to refund: refund at most that\.$/)
    const refund = (await as('POST', '/payments/refunds', { paymentId: S.payment, amount: 19400, paid: { paidOn: TODAY(), externalRef: 'CRO-W2A61-0004' } }, 201)).refund
    expect(refund).toMatchObject({ source: 'PAYMENT', status: 'PAID', amount: 19400, payment: { id: S.payment, externalRef: 'TRN-W2A61-0001' } })
    expect((await as('GET', `/payments/${S.payment}`)).payment).toMatchObject({ allocated: 80500, refunded: 19400, unallocated: 100 })
    const open = await as('GET', `/payments/open-items?companyId=${A.company}&partyId=${A.P1}&paymentId=${S.payment}`)
    expect(open.left).toEqual({ amount: 100, afterSuggestion: 100 })
    expect((await as('GET', `/payments/credit-balance?companyId=${A.company}&partyId=${A.P1}`)).balances).toEqual([{ currency: 'EUR', amount: 45100 }])
    expect((await refused('POST', `/payments/${S.payment}/void`, { reason: 'x' }, 409)).message).toBe('The payment still pays something: reverse its allocations first, then void it.')
  })
})
