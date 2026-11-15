import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { addTenant, startHarness, type Harness, type TestTenant } from '../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../platform/outbox/system'
import { afterBankAcceptance, bankDepositInvoiceHandler } from './deposit-invoice'

/**
 * B-W2b-F48 — a deposit paid through an accepted bank line gets its deposit invoice (TD02) like the other two ways a deposit
 * is paid (DPR 633/1972 art. 6 c.4), on the local stack: a throwaway PostgreSQL 17 database from the migrations (the runtime
 * login: row-level security and the money and bank guards are real), the real app with test sessions, a CSV statement
 * imported through the bank's routes, and the worker's handler run on the very bank_match.accepted event each acceptance
 * wrote. One customer of one company with its tax identity and the invoice series; one order per deposit request (TD02).
 *   accepted suggestion   exactly one TD02 for the amount received, on the order; a retry and a second accept: still one;
 *                         nothing left for the office's deposit draft
 *   Accept all High       the same
 *   a split               each request its TD02 for what the line placed on it (a part for a part)
 *   take back             a PAID request keeps its money (refused, the TD02 stays); a part payment's acceptance is taken back,
 *                         its TD02 stays ISSUED (no credit note by itself), a retry makes nothing; the next payment of the
 *                         request is invoiced only for what passes the kept TD02
 *   by hand first         a DRAFT deposit invoice a person started: the worker makes no second one
 *   held                  a customer without a tax identity: no TD02, the refusal audited on the request
 * Every company, customer, VAT number, IBAN (bank and branch code 00000) and amount is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/payments`.
 */

let h: Harness
let tenant: TestTenant
let app: FastifyInstance

const YEAR = businessDate(new Date()).slice(0, 4)
const TODAY = businessDate(new Date())
const ACCOUNT_IBAN = 'IT27X0000000000000000480001'
const PAYER_IBAN = 'IT97X0000000000000000480002'
const CUSTOMER = 'Cliente Fittizio F48 S.r.l.'
const ids = { customer: newId(), noIdentity: newId(), account: newId() }
const company = () => tenant.companies[0]!.id

/** One order and its deposit request (30 %, TD02) per case. */
const CASES = {
  accepted: { number: 'OV-F48-1001', amount: 61000 },
  acceptAll: { number: 'OV-F48-2002', amount: 42700 },
  splitFull: { number: 'OV-F48-3003', amount: 30500 },
  splitPart: { number: 'OV-F48-4004', amount: 50000 },
  takeBack: { number: 'OV-F48-5005', amount: 80000 },
  byHand: { number: 'OV-F48-6006', amount: 36600 },
  held: { number: 'OV-F48-7007', amount: 24400 },
} as const
type Case = keyof typeof CASES
const orders = {} as Record<Case, string>
const requests = {} as Record<Case, string>

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const FINANCE: Permission[] = ['payments.view', 'payments.record', 'payments.void', 'payments.bank.view', 'payments.bank.import', 'payments.bank.match', 'files.upload', 'files.read', 'invoices.view', 'invoices.manage', 'receivables.view', 'money.price']
let financeSession: SessionContext

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
let keys = 0
const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': 'finance', ...(method === 'GET' ? {} : { 'idempotency-key': `w2bf48-${++keys}-${newId()}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const dmy = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`
const euro = (minor: number) => `${Math.floor(minor / 100)},${String(minor % 100).padStart(2, '0')}`
const CSV_HEADER = 'Data contabile;Data valuta;Importo;Causale;Ordinante;IBAN ordinante;Riferimento banca'

/** A CSV statement of these lines announced, sent, confirmed and imported: answers the new lines' ids in order. */
async function imported(name: string, lines: readonly { readonly amount: number; readonly text: string; readonly reference: string; readonly payer?: string }[]): Promise<string[]> {
  const body = Buffer.from([CSV_HEADER, ...lines.map((line) => `${dmy(TODAY)};${dmy(TODAY)};${euro(line.amount)};${line.text};${line.payer ?? CUSTOMER};${PAYER_IBAN};${line.reference}`)].join('\n'), 'utf8')
  const announced = await ok('POST', '/payments/bank/statements/uploads', { companyId: company(), originalName: name, sizeBytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }, 201)
  const sent = await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  await ok('POST', `/files/${announced.file.id}/complete`)
  const done = await ok('POST', '/payments/bank/statements', { fileId: announced.file.id, bankAccountId: ids.account, expectNew: lines.length }, 201)
  return done.lineIds as string[]
}

const lineOf = async (lineId: string) => (await ok('GET', `/payments/bank/lines/${lineId}`)).line

/** The worker's run of the handler on the bank_match.accepted event the acceptance of `matchId` wrote. */
async function runWorker(matchId: string): Promise<void> {
  const [row] = await admin<{ id: string; payload: Json }>(`SELECT id, payload FROM "OutboxEvent" WHERE type = 'bank_match.accepted' AND payload->>'matchId' = $1`, [matchId])
  expect(row, `the bank_match.accepted event of ${matchId}`).toBeDefined()
  const envelope = { eventId: row!.id, type: 'bank_match.accepted', version: 1, tenantId: tenant.id, companyId: company(), payload: row!.payload } as never
  await bankDepositInvoiceHandler().handle(envelope, { caller: callerFor(h.database, systemContext(tenant.id, newId())), attempt: 1 } as never)
}
const outcomeOf = async (matchId: string) => {
  const [row] = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'bank_match.accepted' AND payload->>'matchId' = $1`, [matchId])
  return afterBankAcceptance(callerFor(h.database, systemContext(tenant.id, newId())), row!.payload as never, newId())
}

interface Td02 { id: string; status: string; grossTotal: number; salesOrderId: string | null; depositRequestId: string; number: string | null; causale: string | null }
const td02sOf = (requestId: string) => admin<Td02>(`SELECT id, status::text AS status, "grossTotal", "salesOrderId", "depositRequestId", number, causale FROM "Invoice" WHERE "depositRequestId" = $1 AND "docType" = 'TD02' ORDER BY "createdAt", id`, [requestId])
const creditNotesOf = (invoiceIds: string[]) => admin(`SELECT id FROM "Invoice" WHERE "creditOfId" = ANY($1::uuid[])`, [invoiceIds])
const requestStatus = async (requestId: string) => (await admin<{ status: string }>('SELECT status::text AS status FROM "DepositRequest" WHERE id = $1', [requestId]))[0]!.status

async function addCustomer(id: string, code: string, legalName: string, withIdentity: boolean) {
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles, status, country) VALUES ($1, $2, $3, $4, 'ORGANISATION', $5, '{CUSTOMER}', 'ACTIVE', 'IT')`, [id, tenant.id, company(), code, legalName])
  if (withIdentity) await admin(`INSERT INTO "PartyTaxIdentity" (id, "tenantId", "partyId", country, "taxMode", "vatNumber", "sdiRecipientCode", "validFrom") VALUES ($1, $2, $3, 'IT', 'IT_B2B', 'IT76543210009', 'FAKE001', '2026-01-01')`, [newId(), tenant.id, id])
  await admin(`INSERT INTO "PartyAddress" (id, "tenantId", "partyId", kinds, line1, "postalCode", city, province, country, "isDefaultBillTo", "isDefaultShipTo") VALUES ($1, $2, $3, '{REGISTERED,BILL_TO,SHIP_TO}', 'Viale delle Prove 42', '40121', 'Bologna', 'BO', 'IT', true, true)`, [newId(), tenant.id, id])
}

beforeAll(async () => {
  h = await startHarness('payments_td02')
  // The file store's presigned requests run on the real clock (this test's dates are today's).
  h.clock.set(new Date())
  tenant = await addTenant(h, 'f48-td02')
  financeSession = { audience: 'office', tenantId: tenant.id, actorId: newId(), grants: [grant(FINANCE)] }
  await admin(
    `UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "regimeFiscale" = 'RF01', "reaOffice" = 'MI', "reaNumber" = '0000001', address = $2::jsonb WHERE id = $1`,
    [company(), JSON.stringify({ line1: 'Via dei Conciatori Finti 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' })],
  )
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'INVOICE', 'MAIN', $4, 'YEARLY', 'FT-{YYYY}-{N:5}', true)`, [newId(), tenant.id, company(), YEAR])
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant.id])
  await admin(`INSERT INTO "BankAccount" (id, "tenantId", "companyId", holder, iban, "bankName") VALUES ($1, $2, $3, 'Test company C1', $4, 'Test example bank')`, [ids.account, tenant.id, company(), ACCOUNT_IBAN])
  await addCustomer(ids.customer, 'C-F48', CUSTOMER, true)
  await addCustomer(ids.noIdentity, 'C-F48-NOID', 'Cliente Senza Identita F48 S.r.l.', false)
  for (const [key, entry] of Object.entries(CASES) as [Case, (typeof CASES)[Case]][]) {
    const partyId = key === 'held' ? ids.noIdentity : ids.customer
    orders[key] = newId()
    requests[key] = newId()
    await admin(`INSERT INTO "SalesOrder" (id, "tenantId", "companyId", "partyId", number, "orderDate", "taxMode", "billTo", "shipTo") VALUES ($1, $2, $3, $4, $5, '2026-10-01', 'IT_B2B', '{}', '{}')`, [orders[key], tenant.id, company(), partyId, entry.number])
    await admin(
      `INSERT INTO "DepositRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, "depositPct", currency, amount, "dueDate", "fiscalDocument", "fiscalRule") VALUES ($1, $2, $3, $4, $5, 'ACCONTO', 30, 'EUR', $6, '2026-12-31', 'TD02', 'DEPOSIT_INVOICE_IT')`,
      [requests[key], tenant.id, company(), partyId, orders[key], entry.amount],
    )
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => (request.headers['x-test-session'] === 'finance' ? financeSession : null)), logger: false },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('a deposit request paid by an accepted bank line gets its TD02 by the worker (DPR 633/1972 art. 6 c.4)', () => {
  let acceptedMatch = ''

  it('an accepted suggestion: the request PAID, then exactly one TD02 for the amount received, on the order, issued', async () => {
    const [lineId] = await imported('estratto-f48-1.csv', [{ amount: CASES.accepted.amount, text: `Acconto ordine ${CASES.accepted.number}`, reference: 'BNK-F48-0001' }])
    const line = await lineOf(lineId!)
    const best = line.suggestions[0]
    expect(best, JSON.stringify(line)).toMatchObject({ confidence: 'HIGH', partyId: ids.customer, items: [{ id: requests.accepted }] })
    const accepted = await ok('POST', `/payments/bank/matches/${best.id}/accept`, { version: best.version })
    expect(accepted).toMatchObject({ recorded: true })
    acceptedMatch = best.id
    expect(await requestStatus(requests.accepted)).toBe('PAID')
    // The acceptance itself stays fast: the TD02 is the worker's.
    expect(await td02sOf(requests.accepted)).toEqual([])
    await runWorker(acceptedMatch)
    const made = await td02sOf(requests.accepted)
    expect(made).toHaveLength(1)
    expect(made[0]).toMatchObject({ status: 'ISSUED', grossTotal: CASES.accepted.amount, salesOrderId: orders.accepted, depositRequestId: requests.accepted, number: `FT-${YEAR}-00001` })
    expect(made[0]!.causale).toContain(`pagamento ricevuto il ${dmy(TODAY)}`)
    const audit = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE action = 'payments.bankDepositInvoice' AND "recordId" = $1`, [requests.accepted])
    expect(audit.map((row) => row.after)).toEqual([expect.objectContaining({ matchId: acceptedMatch, paymentId: accepted.paymentId, invoiceId: made[0]!.id, number: made[0]!.number })])
  })

  it('a retry of the worker and a second accept change nothing: still one TD02, and nothing left for the deposit draft by hand', async () => {
    await runWorker(acceptedMatch)
    expect(await outcomeOf(acceptedMatch)).toEqual({ [requests.accepted]: 'exists' })
    const again = await call('POST', `/payments/bank/matches/${acceptedMatch}/accept`, { version: 1 })
    expect(again.statusCode, again.body).toBe(409)
    expect(await td02sOf(requests.accepted)).toHaveLength(1)
    const byHand = await call('POST', '/invoicing/invoices/deposit-draft', { depositRequestId: requests.accepted })
    expect(byHand.statusCode, byHand.body).toBe(409)
    expect(byHand.json().error.message).toContain('Nothing paid on this deposit request is waiting for a deposit invoice')
  })

  it('Accept all High: the same, one TD02 for the request it paid', async () => {
    const [lineId] = await imported('estratto-f48-2.csv', [{ amount: CASES.acceptAll.amount, text: `Acconto ordine ${CASES.acceptAll.number}`, reference: 'BNK-F48-0002' }])
    const best = (await lineOf(lineId!)).suggestions[0]
    expect(best).toMatchObject({ confidence: 'HIGH', items: [{ id: requests.acceptAll }] })
    const all = await ok('POST', '/payments/bank/matches/accept', { companyId: company(), matches: [{ matchId: best.id, version: best.version }] })
    expect(all.accepted).toEqual([expect.objectContaining({ matchId: best.id, recorded: true })])
    await runWorker(best.id)
    await runWorker(best.id)
    expect(await td02sOf(requests.acceptAll)).toEqual([expect.objectContaining({ status: 'ISSUED', grossTotal: CASES.acceptAll.amount, salesOrderId: orders.acceptAll })])
  })

  let splitMatch = ''
  const PART = 20000

  it('a split: one line pays one request whole and part of another; each gets the TD02 of what the line placed on it', async () => {
    const [lineId] = await imported('estratto-f48-3.csv', [{ amount: CASES.splitFull.amount + PART, text: `Acconti ordini ${CASES.splitFull.number} e ${CASES.splitPart.number}`, reference: 'BNK-F48-0003' }])
    const chosen = await ok('POST', `/payments/bank/lines/${lineId}/match`, { partyId: ids.customer, items: [{ depositRequestId: requests.splitFull, amount: CASES.splitFull.amount }, { depositRequestId: requests.splitPart, amount: PART }] }, 201)
    expect(chosen.recorded).toBe(true)
    splitMatch = chosen.matchId
    expect([await requestStatus(requests.splitFull), await requestStatus(requests.splitPart)]).toEqual(['PAID', 'OPEN'])
    await runWorker(splitMatch)
    expect(await outcomeOf(splitMatch)).toEqual({ [requests.splitFull]: 'exists', [requests.splitPart]: 'exists' })
    expect(await td02sOf(requests.splitFull)).toEqual([expect.objectContaining({ status: 'ISSUED', grossTotal: CASES.splitFull.amount })])
    expect(await td02sOf(requests.splitPart)).toEqual([expect.objectContaining({ status: 'ISSUED', grossTotal: PART })])
  })

  it('take back: a PAID request keeps its money, so its acceptance is refused and its TD02 stays', async () => {
    const accepted = (await lineOf((await admin<{ bankLineId: string }>('SELECT "bankLineId" FROM "BankMatch" WHERE id = $1', [splitMatch]))[0]!.bankLineId)).accepted
    const refused = await call('POST', `/payments/bank/matches/${splitMatch}/reverse`, { version: accepted.version, reason: 'Test: the wrong line' })
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().error.message).toContain('its money stays')
    expect((await td02sOf(requests.splitFull)).map((row) => row.status)).toEqual(['ISSUED'])
    expect((await td02sOf(requests.splitPart)).map((row) => row.status)).toEqual(['ISSUED'])
  })

  it('take back of a part payment: the payment voided, its TD02 stays ISSUED with no credit note; a retry makes nothing; the next payment is invoiced for what passes it', async () => {
    const [wrongLine, rightLine] = await imported('estratto-f48-5.csv', [
      { amount: 30000, text: `Acconto parziale ordine ${CASES.takeBack.number}`, reference: 'BNK-F48-0005' },
      { amount: CASES.takeBack.amount, text: `Acconto ordine ${CASES.takeBack.number} (saldo)`, reference: 'BNK-F48-0006' },
    ])
    const chosen = await ok('POST', `/payments/bank/lines/${wrongLine}/match`, { partyId: ids.customer, items: [{ depositRequestId: requests.takeBack }] }, 201)
    expect(await requestStatus(requests.takeBack)).toBe('OPEN')
    await runWorker(chosen.matchId)
    const [kept] = await td02sOf(requests.takeBack)
    expect(kept).toMatchObject({ status: 'ISSUED', grossTotal: 30000 })
    const accepted = (await lineOf(wrongLine!)).accepted
    const reversed = await ok('POST', `/payments/bank/matches/${chosen.matchId}/reverse`, { version: accepted.version, reason: 'Test: another customer paid it' })
    expect(reversed).toMatchObject({ voided: true, paymentId: chosen.paymentId })
    // The issued TD02 never changes or goes (DPR 633/1972 art. 26): a credit note is a person's decision.
    expect(await td02sOf(requests.takeBack)).toEqual([expect.objectContaining({ id: kept!.id, status: 'ISSUED', grossTotal: 30000 })])
    expect(await creditNotesOf([kept!.id])).toEqual([])
    // A retry of the accepted event after the take-back: the payment is voided, nothing is made.
    await runWorker(chosen.matchId)
    expect(await outcomeOf(chosen.matchId)).toEqual({})
    expect(await td02sOf(requests.takeBack)).toHaveLength(1)
    // The request's right payment, whole: invoiced only for what passes the kept TD02 (never two TD02s for the same money).
    const right = await ok('POST', `/payments/bank/lines/${rightLine}/match`, { partyId: ids.customer, items: [{ depositRequestId: requests.takeBack }] }, 201)
    expect(await requestStatus(requests.takeBack)).toBe('PAID')
    await runWorker(right.matchId)
    const both = await td02sOf(requests.takeBack)
    expect(both.map((row) => [row.status, row.grossTotal])).toEqual([
      ['ISSUED', 30000],
      ['ISSUED', CASES.takeBack.amount - 30000],
    ])
  })

  it('a DRAFT deposit invoice a person started by hand: the worker makes no second one', async () => {
    const [lineId] = await imported('estratto-f48-6.csv', [{ amount: CASES.byHand.amount, text: `Acconto ordine ${CASES.byHand.number}`, reference: 'BNK-F48-0007' }])
    const chosen = await ok('POST', `/payments/bank/lines/${lineId}/match`, { partyId: ids.customer, items: [{ depositRequestId: requests.byHand }] }, 201)
    const draft = (await ok('POST', '/invoicing/invoices/deposit-draft', { depositRequestId: requests.byHand }, 201)).invoice
    expect(draft).toMatchObject({ docType: 'TD02', status: 'DRAFT', grossTotal: CASES.byHand.amount })
    await runWorker(chosen.matchId)
    expect(await outcomeOf(chosen.matchId)).toEqual({ [requests.byHand]: 'exists' })
    expect(await td02sOf(requests.byHand)).toEqual([expect.objectContaining({ id: draft.id, status: 'DRAFT' })])
  })

  it('held: a customer without a tax identity gets no TD02; the refusal is audited on the request for the office', async () => {
    const [lineId] = await imported('estratto-f48-7.csv', [{ amount: CASES.held.amount, text: `Acconto ordine ${CASES.held.number}`, reference: 'BNK-F48-0008', payer: 'Cliente Senza Identita F48 S.r.l.' }])
    const chosen = await ok('POST', `/payments/bank/lines/${lineId}/match`, { partyId: ids.noIdentity, items: [{ depositRequestId: requests.held }] }, 201)
    expect(await requestStatus(requests.held)).toBe('PAID')
    await runWorker(chosen.matchId)
    expect(await td02sOf(requests.held)).toEqual([])
    const audit = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE action = 'payments.bankDepositInvoiceHeld' AND "recordId" = $1`, [requests.held])
    expect(audit.map((row) => row.after)).toEqual([expect.objectContaining({ matchId: chosen.matchId, paymentId: chosen.paymentId, reason: expect.stringContaining('tax identity') })])
  })
})
