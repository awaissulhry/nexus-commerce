import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { supplierInvoiceXml } from '@nexus/factory-domain/payables/testing'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAccounting, type AccountingSeed } from '../../../../../../packages/factory-db/seed/accounting'
import { seed as seedBank } from '../../../../../../packages/factory-db/seed/bank'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedIntegration } from '../../../../../../packages/factory-db/seed/integration'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedSubcontractReceipts, type SubcontractReceiptsSeed } from '../../../../../../packages/factory-db/seed/subcontract-receipts'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { FakeSdi } from '../../../adapters/sdi/fake'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { createGateway } from '../../../platform/gateway/gateway'
import { ruleContext, type Draft } from '../../../platform/notifications/fan-out'
import { MONEY_RULES } from '../../../platform/notifications/rules/money'
import { systemContext } from '../../../platform/outbox/system'
import { createPayablesSdi, usePayablesSdi } from '../sdi'

/**
 * B-W2b-403 — payables in depth on the local stack, through the app's real routes: a throwaway PostgreSQL 17 database from
 * the migrations (the runtime login: row-level security, the approval history's and the …_bank_bridge_w2b_guards triggers are
 * real), the factory-db seeds of one tenant (P2's SDI invoice 2026/0412 for 105 ft² of SEED-GR-0001's leather, P2's ACTIVE
 * account ending 7002, SEED-SC-0002 with 1 good piece back at 2.00), the FAKE SDI intermediary behind the real gateway, FAKE
 * mail, test sessions and two real browsers (the Owner, a second finance person) for the fresh codes.
 *   FIN-142  a foreign invoice above 10,000 approved by two people: the first yes a REQUESTED history line (the database refuses
 *            the same person's APPROVED line), a write lapses it, the bulk approve says a second yes is needed
 *   FIN-140  the week's candidates; a supplier without a verified account holds its line (HELD, refused); P2's two invoices
 *            proposed, never approved by their maker, a fresh code, two people above the amount, recorded paid (every invoice
 *            PAID); the remittance advice only behind the Owner's switch (PQ1:01, PQ1:02)
 *   SCM-132  2026/0412's leather: 105 ft² invoiced against the hides' area, then measured short beyond the order's tolerance:
 *            a DRAFT area claim opened from the invoice (purchasing's command)
 *   FIN-138  a subcontractor invoice line at another price than the order's: book the FEE at the invoiced price, then matched
 *   FIN-167  the money controls; FIN-169 the reconciliation difference told to who matches the bank lines
 * Every name, VAT number, IBAN and amount is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/payables/proposal`.
 */

type Json = Record<string, any>
const NS = 'w2b403-payables-depth'
const key = (name: string) => seedUuid(NS, name)
const A = { tenant: key('tenant'), company: key('company:A'), P2: key('party:P2'), sdi: key('integration:account:sdi') }
const TENANT: TestTenant = { id: A.tenant, slug: NS, companies: [{ id: A.company, code: 'A' }] }
const FAKE_VAT = { company: '00000003038', P2: '00000002022' } as const
const FOREIGN = newId()
const TODAY = businessDate(new Date())

const CLERK = newId()
const APPROVER_A = newId()
const APPROVER_B = newId()
const grant = (permissions: readonly string[]): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: readonly string[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId, grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  /** Finance: registers, maps, makes the proposal and records it paid (and may approve what others prepared); opens claims and books workshop fees; sees costs. */
  clerk: office(['payables.view', 'payables.manage', 'payables.differences.accept', 'payables.approve', 'payables.pay', 'payables.proposals.manage', 'payables.proposals.approve', 'money.cost', 'purchasing.view', 'purchasing.claims.manage', 'purchasing.subcontract.cost', 'files.read'], CLERK),
  approverA: office(['payables.view', 'payables.approve', 'money.cost'], APPROVER_A),
  approverB: office(['payables.view', 'payables.approve', 'money.cost'], APPROVER_B),
  /** Reads, without the cost grain and without any right to act. */
  viewer: office(['payables.view', 'purchasing.view']),
}

let h: Harness
let app: FastifyInstance
let fake: FakeSdi
let subcontract: SubcontractReceiptsSeed
let accounting: AccountingSeed
let owner: { browser: Browser; secret: string; id: string }
let finance2: { browser: Browser; secret: string; id: string }
let serial = 0
const idem = () => `w2b403-${randomBytes(4).toString('hex')}-${++serial}`

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown): Promise<LightMyRequestResponse> =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const ok = async (response: Promise<LightMyRequestResponse>, status = 200): Promise<Json> => {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json() as Json
}
const refusal = async (response: Promise<LightMyRequestResponse>, status: number): Promise<string[]> => {
  const answer = await response
  expect(answer.statusCode, answer.body).toBe(status)
  return (answer.json().error.issues ?? []).map((issue: Json) => issue.path)
}
const as = async (who: { browser: Browser }, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<{ status: number; body: Json }> => {
  const answer = await who.browser.send(method, url, body, method === 'GET' ? {} : { headers: { 'idempotency-key': idem() } })
  return { status: answer.status, body: answer.body as Json }
}
const outbox = async (type: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY id`, [A.tenant, type])

/** One of P2's invoices through the FAKE SDI, picked up, its unmapped lines marked as without an order (a service). */
async function sdiInvoice(number: string, lines: { description: string; quantity: string; unitPrice: string }[], withoutOrder = true): Promise<Json> {
  const { xml, fileName } = supplierInvoiceXml({ supplierVat: FAKE_VAT.P2, buyerVat: FAKE_VAT.company, number, date: TODAY, lines, dueDate: TODAY, progressive: String(++serial).padStart(5, '0') })
  fake.deliver({ tenantId: A.tenant, accountId: A.sdi, xml, fileName })
  const pickup = await ok(call('clerk', 'POST', '/payables/sdi/pickup', { companyId: A.company }))
  const recorded = pickup.recorded.find((row: Json) => row.number === number)
  expect(recorded, JSON.stringify(pickup)).toBeDefined()
  let { invoice } = await ok(call('clerk', 'GET', `/payables/invoices/${recorded.invoiceId}`))
  if (withoutOrder) ({ invoice } = await ok(call('clerk', 'POST', `/payables/invoices/${invoice.id}/without-order`, { version: invoice.version })))
  return invoice
}

/** A foreign supplier's invoice typed from its PDF (no SDI), without an order. */
async function foreignInvoice(number: string, net: number): Promise<Json> {
  let { invoice } = await ok(call('clerk', 'POST', '/payables/invoices', { companyId: A.company, partyId: FOREIGN, source: 'MANUAL', number, issueDate: TODAY, dueDate: TODAY, lines: [{ description: 'Prova di laboratorio', quantity: '1', unitPrice: (net / 100).toFixed(2), netAmount: net, vatRatePct: '0', vatNature: 'N2.1' }] }), 201)
  ;({ invoice } = await ok(call('clerk', 'POST', `/payables/invoices/${invoice.id}/without-order`, { version: invoice.version })))
  return invoice
}

const approve = (session: string, invoice: Json) => call(session, 'POST', `/payables/invoices/${invoice.id}/approve`, { version: invoice.version })
const current = async (invoiceId: string): Promise<Json> => (await ok(call('clerk', 'GET', `/payables/invoices/${invoiceId}`))).invoice

async function signedIn(role: string): Promise<{ browser: Browser; secret: string; id: string }> {
  const user = await addUser(h, TENANT, { email: `${role}-${randomBytes(3).toString('hex')}@example.test`, role })
  const browser = new Browser(h.app)
  const signed = await browser.signIn(TENANT.slug, user.email, user.password)
  if (signed.body.status !== 'signed_in') throw new Error(`${role} sign-in: ${signed.status} ${JSON.stringify(signed.body)}`)
  return { browser, secret: await enrolTotp(h, browser), id: user.id }
}

beforeAll(async () => {
  h = await startHarness('payables_depth_403')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  for (const seedOf of [seedEmail, seedIntegration, seedReasons]) await seedOf({ db: h.database, namespace: NS })
  await seedBank({ db: h.database, namespace: NS })
  accounting = await seedAccounting({ db: h.database, namespace: NS })
  subcontract = await seedSubcontractReceipts({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000, "callTimeoutMs" = 2000, "circuitFailureThreshold" = 1000 WHERE "tenantId" = $1`, [A.tenant])
  await admin(`UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3 WHERE id = $1`, [A.company, `IT${FAKE_VAT.company}`, FAKE_VAT.company])
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles, status, country, currency) VALUES ($1, $2, NULL, 'T403-DE', 'ORGANISATION', 'Testlabor Beispiel GmbH', '{SUPPLIER}', 'ACTIVE', 'DE', 'EUR')`, [FOREIGN, A.tenant])
  for (const [userId, name] of [[CLERK, 'clerk'], [APPROVER_A, 'approver.a'], [APPROVER_B, 'approver.b']] as const) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName") VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [userId, A.tenant, `${name}.${randomBytes(3).toString('hex')}@example.test`, `Made-up ${name}`])
  }
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  owner = await signedIn('owner')
  finance2 = await signedIn('finance')
  fake = new FakeSdi()
  const gateway = createGateway({ environment: 'test', redis: h.redis, prefix: h.redisPrefix, secrets: h.secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  usePayablesSdi(createPayablesSdi({ gateway, fake }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 300_000)

afterAll(async () => {
  usePayablesSdi(undefined)
  await app?.close()
  await h?.close()
}, 60_000)

let foreign: Json = {}

describe('separation of duties and dual approval of a supplier invoice (FIN-142)', () => {
  it('above 10,000 the first yes waits for a second person; the same person again is refused, by the API and the database', async () => {
    foreign = await foreignInvoice('T403-DE-1', 1_200_000)
    expect(await refusal(approve('clerk', foreign), 409)).toEqual(['refusal/OWN_INVOICE'])
    const before = await ok(call('approverA', 'GET', `/payables/invoices/${foreign.id}/dual-approval`))
    expect(before).toMatchObject({ needed: true, step: 'FIRST', first: null, held: null, threshold: { amount: 1_000_000, currency: 'EUR', decided: false } })
    const first = (await ok(approve('approverA', foreign))).invoice
    expect(first.status).toBe('RECEIVED')
    const waiting = await ok(call('approverA', 'GET', `/payables/invoices/${foreign.id}/dual-approval`))
    expect(waiting).toMatchObject({ step: 'SECOND', first: { by: { id: APPROVER_A }, standing: true }, held: 'SECOND_APPROVER' })
    expect(waiting.words.en).toBe('Approved once by Made-up approver.a: a second person approves totals above 10000.00 EUR.')
    expect(await refusal(approve('approverA', first), 409)).toEqual(['refusal/SECOND_APPROVER'])
    // The database's rule on the history: a decision is never by the person of the last REQUESTED line.
    await expect(admin(`INSERT INTO "ApprovalEvent" (id, "tenantId", "companyId", "recordType", "recordId", action, "byId", words) VALUES ($1, $2, $3, 'SupplierInvoice', $4, 'APPROVED', $5, 'self')`, [newId(), A.tenant, A.company, foreign.id, APPROVER_A])).rejects.toThrow(/nobody approves their own request/)
    // Without the cost grain the amount is not sent.
    expect((await ok(call('viewer', 'GET', `/payables/invoices/${foreign.id}/dual-approval`))).threshold.amount).toBeUndefined()
    foreign = first
  })

  it('a write between the two yeses lapses the first; then two people approve it', async () => {
    const changed = (await ok(call('clerk', 'PATCH', `/payables/invoices/${foreign.id}`, { version: foreign.version, internalNote: 'Laboratorio: prova ripetuta.' }))).invoice
    const again = (await ok(approve('approverB', changed))).invoice
    expect(again.status).toBe('RECEIVED')
    expect((await ok(call('approverA', 'GET', `/payables/invoices/${foreign.id}/dual-approval`))).first).toMatchObject({ by: { id: APPROVER_B }, standing: true })
    const approved = (await ok(approve('approverA', again))).invoice
    expect(approved).toMatchObject({ status: 'APPROVED' })
    const lines = await admin<{ action: string; byId: string }>(`SELECT action::text AS action, "byId" FROM "ApprovalEvent" WHERE "recordType" = 'SupplierInvoice' AND "recordId" = $1 ORDER BY at, "createdAt"`, [foreign.id])
    expect(lines).toEqual([{ action: 'REQUESTED', byId: APPROVER_A }, { action: 'REQUESTED', byId: APPROVER_B }, { action: 'APPROVED', byId: APPROVER_A }])
    expect((await outbox('supplier_invoice.first_approved')).filter((event) => event.payload.supplierInvoiceId === foreign.id)).toHaveLength(2)
    foreign = approved
  })

  it('the bulk approve says a second yes is needed; at or below the amount one yes approves', async () => {
    const big = await foreignInvoice('T403-DE-2', 1_100_000)
    const bulk = await ok(call('approverA', 'POST', '/payables/invoices/approve', { items: [{ id: big.id, version: big.version }] }))
    expect(bulk).toMatchObject({ approved: 0, refused: 1, results: [{ approved: false, status: 'RECEIVED', refusals: [{ code: 'SECOND_APPROVAL' }] }] })
    const small = await foreignInvoice('T403-DE-3', 1_000_000)
    expect((await ok(approve('approverA', small))).invoice.status).toBe('APPROVED')
  })
})

describe('the weekly payment proposal (FIN-140, FIN-142; PQ1:01, PQ1:02)', () => {
  let p2Big: Json = {}
  let p2Small: Json = {}
  let proposal: Json = {}

  it('a supplier without a verified bank account: its line is held and the proposal is not approved', async () => {
    const candidates = await ok(call('clerk', 'GET', `/payables/proposals/candidates?companyId=${A.company}`))
    const row = candidates.items.find((item: Json) => item.invoiceId === foreign.id)
    expect(row).toMatchObject({ held: true, account: null, due: 'THIS_WEEK', payable: 1_200_000, inProposal: null })
    const held = (await ok(call('clerk', 'POST', '/payables/proposals', { companyId: A.company, lines: [{ invoiceId: foreign.id }] }), 201)).proposal
    expect(held).toMatchObject({ status: 'DRAFT', weekStart: candidates.weekStart, totals: { lines: 1, held: 1, amount: 1_200_000 }, lines: [{ held: true, account: null, heldWords: { en: expect.stringContaining('payments to this supplier are held') } }], may: { approve: 'OWN_PROPOSAL' } })
    await stepUp(h, owner.browser, owner.secret)
    const refused = await as(owner, 'POST', `/payables/proposals/${held.id}/approve`, { version: held.version })
    expect([refused.status, refused.body.error.issues.map((issue: Json) => issue.path)]).toEqual([409, ['refusal/HELD']])
    const cancelled = (await ok(call('clerk', 'POST', `/payables/proposals/${held.id}/cancel`, { version: held.version, reason: 'Conto del fornitore da verificare.' }))).proposal
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Conto del fornitore da verificare.' })
  })

  it("P2's invoices are proposed to its verified account; the maker never approves; a fresh code; two people above the amount", async () => {
    p2Big = await sdiInvoice('T403-0903', [{ description: 'Pelle bovina, partita extra', quantity: '1', unitPrice: '9000.00' }])
    expect((await ok(approve('approverB', p2Big))).invoice.status).toBe('RECEIVED')
    p2Big = (await ok(approve('approverA', await current(p2Big.id)))).invoice
    p2Small = await sdiInvoice('T403-0904', [{ description: 'Campioni', quantity: '1', unitPrice: '100.00' }])
    p2Small = (await ok(approve('approverA', p2Small))).invoice
    expect([p2Big.status, p2Small.status]).toEqual(['APPROVED', 'APPROVED'])
    proposal = (await ok(call('clerk', 'POST', '/payables/proposals', { companyId: A.company, lines: [{ invoiceId: p2Big.id }, { invoiceId: p2Small.id, discountAmount: 200 }], note: 'Settimana di prova.' }), 201)).proposal
    expect(proposal).toMatchObject({ status: 'DRAFT', totals: { lines: 2, held: 0, amount: 1_098_000 + 12_200 - 200, discount: 200, suppliers: 1 }, approval: { dual: { needed: true, threshold: 1_000_000, first: null } }, remittance: { on: false } })
    // Both due today: the bigger discount first.
    expect(proposal.lines.map((line: Json) => [line.invoice.number, line.amount, line.discountAmount, line.account.masked])).toEqual([
      ['T403-0904', 12_000, 200, 'IT** **** **** 7002'],
      ['T403-0903', 1_098_000, 0, 'IT** **** **** 7002'],
    ])
    expect(JSON.stringify(proposal)).not.toMatch(/IT63X/)
    expect(await refusal(call('clerk', 'POST', `/payables/proposals/${proposal.id}/approve`, { version: proposal.version }), 409)).toEqual(['refusal/OWN_PROPOSAL'])
    expect((await call('viewer', 'POST', `/payables/proposals/${proposal.id}/approve`, { version: proposal.version })).statusCode).toBe(403)
    const noCode = await as(finance2, 'POST', `/payables/proposals/${proposal.id}/approve`, { version: proposal.version })
    expect([noCode.status, noCode.body.error.issues]).toEqual([403, [{ path: 'stepUp', message: 'Required.' }]])
    await stepUp(h, finance2.browser, finance2.secret)
    const first = await as(finance2, 'POST', `/payables/proposals/${proposal.id}/approve`, { version: proposal.version })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(first.body).toMatchObject({ step: 'FIRST', proposal: { status: 'DRAFT', approval: { dual: { first: { by: { id: finance2.id }, standing: true } } }, may: { approve: 'SECOND_APPROVER' } } })
    const twice = await as(finance2, 'POST', `/payables/proposals/${proposal.id}/approve`, { version: first.body.proposal.version })
    expect([twice.status, twice.body.error.issues.map((issue: Json) => issue.path)]).toEqual([409, ['refusal/SECOND_APPROVER']])
    await stepUp(h, owner.browser, owner.secret)
    const second = await as(owner, 'POST', `/payables/proposals/${proposal.id}/approve`, { version: first.body.proposal.version })
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    expect(second.body).toMatchObject({ step: 'SECOND', proposal: { status: 'APPROVED', approvedBy: { id: owner.id } } })
    proposal = second.body.proposal
    const candidates = await ok(call('clerk', 'GET', `/payables/proposals/candidates?companyId=${A.company}`))
    expect(candidates.items.find((item: Json) => item.invoiceId === p2Big.id).inProposal).toEqual({ id: proposal.id, status: 'APPROVED' })
  })

  it('recorded paid once the transfers left the bank: every invoice PAID; no remittance while the switch is off', async () => {
    expect(await refusal(call('clerk', 'POST', `/payables/proposals/${proposal.id}/paid`, { version: proposal.version, paidOn: '2099-01-01', paymentRef: 'CRO 0000-TEST' }), 400)).toEqual(['body/paidOn'])
    const paid = await ok(call('clerk', 'POST', `/payables/proposals/${proposal.id}/paid`, { version: proposal.version, paidOn: TODAY, paymentRef: 'CRO 0000-TEST-403' }))
    expect(paid.proposal).toMatchObject({ status: 'PAID' })
    expect(paid.remittances).toEqual([{ partyId: A.P2, sent: false, held: 'SWITCHED_OFF', emailId: null, recipients: 0, words: expect.stringContaining('off') }])
    for (const id of [p2Big.id, p2Small.id]) expect(await current(id)).toMatchObject({ status: 'PAID', payment: { paidOn: TODAY, paymentRef: 'CRO 0000-TEST-403' } })
    expect((await outbox('payment_proposal.changed')).filter((event) => event.payload.proposalId === proposal.id).map((event) => event.payload.change)).toEqual(['CREATED', 'FIRST_APPROVED', 'APPROVED', 'PAID'])
    expect(await refusal(call('clerk', 'POST', `/payables/proposals/${proposal.id}/cancel`, { version: paid.proposal.version, reason: 'Troppo tardi.' }), 409)).toEqual(['refusal/NOT_DRAFT'])
  })

  it("the Owner's remittance switch (a fresh code to turn it on); then the supplier's remittance contact gets one mail, never an IBAN", async () => {
    expect(await ok(call('clerk', 'GET', `/payables/remittance/settings?companyId=${A.company}`))).toMatchObject({ on: false, mayChange: false })
    expect((await call('clerk', 'PUT', '/payables/remittance/settings', { companyId: A.company, remittanceMailOn: true })).statusCode).toBe(403)
    await stepUp(h, owner.browser, owner.secret)
    const on = await as(owner, 'PUT', '/payables/remittance/settings', { companyId: A.company, remittanceMailOn: true })
    expect(on.status, JSON.stringify(on.body)).toBe(200)
    expect(on.body).toMatchObject({ on: true, source: 'COMPANY', mayChange: true })
    expect((await outbox('payables_settings.changed')).at(-1)?.payload).toMatchObject({ companyId: A.company, fields: ['remittanceMailOn'] })
    await admin(`INSERT INTO "PartyContact" (id, "tenantId", "partyId", name, email, roles, receives, status) VALUES ($1, $2, $3, 'Test Accounts P2', 'accounts.t403@example.com', ARRAY[]::"PartyContactRole"[], ARRAY['REMITTANCE']::"PartyContactReceives"[], 'ACTIVE')`, [newId(), A.tenant, A.P2])
    const third = (await ok(approve('approverA', await sdiInvoice('T403-0905', [{ description: 'Campioni bis', quantity: '1', unitPrice: '50.00' }])))).invoice
    let next = (await ok(call('clerk', 'POST', '/payables/proposals', { companyId: A.company, lines: [{ invoiceId: third.id }] }), 201)).proposal
    expect(next.approval.dual.needed).toBe(false)
    const single = await as(owner, 'POST', `/payables/proposals/${next.id}/approve`, { version: next.version })
    expect([single.status, single.body.step]).toEqual([200, 'SINGLE'])
    next = single.body.proposal
    const paid = await ok(call('clerk', 'POST', `/payables/proposals/${next.id}/paid`, { version: next.version, paidOn: TODAY, paymentRef: 'CRO 0000-TEST-404' }))
    expect(paid.remittances).toEqual([{ partyId: A.P2, sent: true, held: null, emailId: expect.any(String), recipients: 1, words: null }])
    const [mail] = await admin<{ subject: string; bodyText: string; to: string[]; recordType: string }>(`SELECT o.subject, m."bodyText", o."to", o."recordType" FROM "EmailOutbound" o JOIN "Message" m ON m.id = o."messageId" WHERE o.id = $1`, [paid.remittances[0].emailId])
    expect(mail).toMatchObject({ to: ['accounts.t403@example.com'], recordType: 'SupplierInvoice' })
    expect(mail!.bodyText).toContain('T403-0905')
    expect(mail!.bodyText).toContain('CRO 0000-TEST-404')
    expect(mail!.bodyText).not.toMatch(/IT\d\d[A-Z]\d/)
  })
})

describe('the leather area check on a supplier invoice (SCM-132)', () => {
  let invoiceId = ''

  it("2026/0412's 105 ft² against the hides' area: within while unmeasured; measured short beyond the order's tolerance: a claim is in order", async () => {
    invoiceId = accounting.supplierInvoiceId
    const before = await ok(call('viewer', 'GET', `/payables/invoices/${invoiceId}/area-check`))
    expect(before.lines).toHaveLength(1)
    expect(before.lines[0]).toMatchObject({ seq: 1, item: { baseUom: 'FT2' }, check: { invoiced: '105.0000', measured: '105.0000', unmeasuredHides: 2, outcome: 'WITHIN', opensClaim: false }, claim: { opens: false } })
    const hides = await admin<{ id: string; lotId: string; siteId: string; code: string }>(`SELECT id, "lotId", "siteId", code FROM "Hide" WHERE "tenantId" = $1 AND code IN ('SEED-HIDE-0001', 'SEED-HIDE-0002') ORDER BY code`, [A.tenant])
    for (const [index, hide] of hides.entries()) {
      await admin(`INSERT INTO "HideMeasure" (id, "tenantId", "siteId", "lotId", "hideId", "declaredArea", "measuredArea", "areaUom", "measuredById", "measuredAt", "createdById") VALUES ($1, $2, $3, $4, $5, NULL, $6, 'FT2', $7, now(), $7)`, [newId(), A.tenant, hide.siteId, hide.lotId, hide.id, index === 0 ? '50.0000' : '49.0000', CLERK])
    }
    const after = await ok(call('clerk', 'GET', `/payables/invoices/${invoiceId}/area-check`))
    expect(after.lines[0]).toMatchObject({ check: { measured: '99.0000', measuredHides: 2, outcome: 'SHORT', opensClaim: true, shortfall: '6.0000' }, claim: { opens: true, held: null, existing: [] } })
    expect(after.lines[0].words.en).toContain('6.00 ft²')
  })

  it('the claim is opened by who may open claims (a DRAFT, purchasing sends it); the viewer may not', async () => {
    const line = (await ok(call('clerk', 'GET', `/payables/invoices/${invoiceId}/area-check`))).lines[0]
    expect((await call('viewer', 'POST', `/payables/invoices/${invoiceId}/area-check/${line.lineId}/claim`, {})).statusCode).toBe(403)
    const opened = await ok(call('clerk', 'POST', `/payables/invoices/${invoiceId}/area-check/${line.lineId}/claim`, {}), 201)
    expect(opened).toMatchObject({ claim: { status: 'DRAFT' }, check: { outcome: 'SHORT' } })
    const [claim] = await admin<{ kind: string; reasonCode: string; reason: string; purchaseOrderId: string }>(`SELECT kind::text AS kind, "reasonCode", reason, "purchaseOrderId" FROM "SupplierClaim" WHERE id = $1`, [opened.claim.id])
    expect(claim).toMatchObject({ kind: 'CLAIM', reasonCode: 'SHORT_DELIVERY', purchaseOrderId: line.order.id })
    expect(claim!.reason).toContain('Invoice 2026/0412 line 1')
    expect((await ok(call('clerk', 'GET', `/payables/invoices/${invoiceId}/area-check`))).lines[0].claim.existing).toEqual([{ id: opened.claim.id, number: opened.claim.number, status: 'DRAFT' }])
  })
})

describe("the subcontractor's invoice matched to its operations and cost entries (FIN-138, PQ1:03)", () => {
  it('a piece billed at another price than the order: book the FEE at the invoiced price, then it matches; never twice', async () => {
    let invoice = await sdiInvoice('T403-0906', [{ description: 'Confezionamento maniche', quantity: '1', unitPrice: '2.50' }], false)
    ;({ invoice } = await ok(call('clerk', 'PATCH', `/payables/invoices/${invoice.id}/lines/${invoice.lines[0].id}`, { version: invoice.version, kind: 'SUBCONTRACT', subcontractOrderId: subcontract.orderId })))
    const match = await ok(call('clerk', 'GET', `/payables/invoices/${invoice.id}/subcontract-match`))
    expect(match.lines[0]).toMatchObject({ order: { id: subcontract.orderId }, match: { verdict: 'BOOK_FEE', price: 'HIGHER', invoicedUnitPrice: '2.500000', orderUnitPrice: '2.000000', piecesOwed: 1, suggestions: [{ subcontractOperationId: subcontract.operationId, quantity: 1, unitPrice: '2.500000' }] }, book: { held: null } })
    expect((await ok(call('viewer', 'GET', `/payables/invoices/${invoice.id}/subcontract-match`))).lines[0].match.invoicedUnitPrice).toBeUndefined()
    const line = match.lines[0]
    expect((await call('viewer', 'POST', `/payables/invoices/${invoice.id}/subcontract-match/${line.lineId}/fee`, { orderVersion: line.order.version, subcontractOperationId: subcontract.operationId, quantity: 1 })).statusCode).toBe(403)
    const booked = await ok(call('clerk', 'POST', `/payables/invoices/${invoice.id}/subcontract-match/${line.lineId}/fee`, { orderVersion: line.order.version, subcontractOperationId: subcontract.operationId, quantity: 1 }), 201)
    expect(booked.match.lines[0]).toMatchObject({ match: { verdict: 'MATCHED', piecesAtInvoicedPrice: 1 }, entries: [{ kind: 'FEE', quantity: '1.0000', unitPrice: '2.500000', amount: 250, ofThisLine: true }] })
    expect(booked.match.lines[0].entries[0].reason).toBe('Supplier invoice T403-0906 line 1: 1 pieces at the invoiced price.')
    // Purchasing's own check: the piece is booked already.
    expect((await call('clerk', 'POST', `/payables/invoices/${invoice.id}/subcontract-match/${line.lineId}/fee`, { orderVersion: booked.match.lines[0].order.version, subcontractOperationId: subcontract.operationId, quantity: 1 })).statusCode).toBe(400)
  })
})

describe('approvals and notifications of money (FIN-167, FIN-169)', () => {
  it('the money controls say what asks a yes or a fresh code today, and where the schema has no kind yet', async () => {
    const controls = await ok(call('clerk', 'GET', `/payables/money-controls?companyId=${A.company}`))
    expect(controls.actions.map((action: Json) => action.code)).toEqual(['SUPPLIER_INVOICE', 'PAYMENT_PROPOSAL', 'MANUAL_PAYMENT', 'CREDIT_NOTE', 'WRITE_OFF', 'PRICE_OVERRIDE'])
    expect(controls.actions.find((action: Json) => action.code === 'PAYMENT_PROPOSAL')).toMatchObject({ stepUp: { action: 'payments.approve', on: true }, dual: { amount: 1_000_000, decided: false } })
    expect(controls.actions.find((action: Json) => action.code === 'CREDIT_NOTE')).toMatchObject({ kind: { code: 'CREDIT_WITHOUT_RETURN', registered: true, active: 0 }, stepUp: { action: 'invoices.issue', on: true } })
    expect(controls.actions.find((action: Json) => action.code === 'PRICE_OVERRIDE').kind).toMatchObject({ code: 'PRICE_CHANGE', registered: false })
    expect(controls.notifications.map((entry: Json) => entry.code)).toEqual(['PAYMENT_RECEIVED', 'SDI_REJECTED', 'OVERDUE', 'DEPOSIT_RECEIVED', 'RECONCILIATION_DIFFERENCE'])
    expect(controls.remittance).toMatchObject({ on: true, source: 'COMPANY' })
  })

  it('a reconciliation difference of the nightly checks is told to who matches the bank lines; a passing run tells nobody', async () => {
    const rule = MONEY_RULES.find((entry) => entry.name === 'money.reconciliationDifference')!
    const system = callerFor(h.database, systemContext(A.tenant, `w2b403-${newId()}`))
    const drafts = async (failed: string[]): Promise<readonly Draft[]> =>
      system.withClient((client) => client.$transaction((tx) => rule.drafts(ruleContext(tx, A.tenant, new Date()), { companyId: A.company, ranAt: new Date().toISOString(), checks: 6, failed, flagged: 0 })))
    const told = await drafts(['PAYMENTS_PLACED'])
    expect(told.map((draft) => draft.userId)).toContain(owner.id)
    expect(told.find((draft) => draft.userId === owner.id)).toMatchObject({ category: 'ALERT', messageKey: 'notifications.money.reconciliationDifference', record: { type: 'Company', id: A.company }, params: { count: 1 } })
    expect(await drafts(['LEDGER_BALANCES'])).toEqual([])
  })
})
