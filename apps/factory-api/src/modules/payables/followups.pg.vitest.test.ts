import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { supplierInvoiceXml } from '@nexus/factory-domain/payables/testing'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAccounting, type AccountingSeed } from '../../../../../packages/factory-db/seed/accounting'
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../packages/factory-db/seed/email'
import { seed as seedIntegration } from '../../../../../packages/factory-db/seed/integration'
import { seed as seedSourcing, type SourcingSeed } from '../../../../../packages/factory-db/seed/sourcing'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { FakeSdi } from '../../adapters/sdi/fake'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { startHarness, type Harness } from '../../platform/auth/sessions/testing/harness'
import { createGateway } from '../../platform/gateway/gateway'
import { createPayablesSdi, usePayablesSdi } from './sdi'

/**
 * B-W2b-21 — payables follow-ups on the local stack, through the app's real routes (a throwaway PostgreSQL 17 database
 * from the migrations: the runtime login, row-level security and the …_followups_quality_money_w2b_guards are real; the
 * factory-db seeds: P2's SEED-PO-0001 and its SDI invoice 2026/0412 with a price difference of 10.50, P2's claim
 * SEED-CLM-0001 for a credit, September 2026 HARD-locked; the FAKE SDI intermediary behind the real gateway):
 *   Z8:03  the payables settings (tolerances, billing basis, who approves what SDI delivered) and the match that reads them
 *   Z8:04  a voided typed invoice frees its number and date
 *   Z8:05  a file of several invoices (a lotto) recorded with its invoices
 *   Z8:06  the SDI inbox of deliveries the pickup could not record: attempts, dismiss, reopen, recorded at last
 *   Z8:07  a supplier credit note matched to its claim
 * Every name, VAT number and amount is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/payables/followups`.
 */

let h: Harness
let app: FastifyInstance
let fake: FakeSdi
let accounting: AccountingSeed
let sourcing: SourcingSeed

const NS = 'w2b21-payables-a'
const idOf = (key: string) => seedUuid(NS, key)
const A = { tenant: idOf('tenant'), company: idOf('company:A'), P2: idOf('party:P2'), sdi: idOf('integration:account:sdi') }
const FAKE_VAT = { company: '00000003038', P2: '00000002022', stranger: '00000005058' } as const
const FOREIGN = newId()
const TODAY = businessDate(new Date())

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const CLERK = newId()
const APPROVER = newId()
const LISTED = newId()
const office = (permissions: Permission[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId, grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  /** Finance: keeps the settings, registers and maps; sees costs. */
  finance: office(['payables.view', 'payables.manage', 'payables.differences.accept', 'payables.settings', 'money.cost', 'files.read', 'purchasing.view', 'purchasing.claims.manage'], CLERK),
  /** Another finance person who approves. */
  approver: office(['payables.view', 'payables.approve', 'money.cost'], APPROVER),
  /** The one person the LISTED rule names. */
  listed: office(['payables.view', 'payables.approve', 'money.cost'], LISTED),
  /** Reads without the settings permission. */
  viewer: office(['payables.view']),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `w2b21-pay-${run}-${++keys}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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

type Body = { number: string; lines: { description: string; quantity: string; uom?: string; unitPrice: string }[]; documentType?: 'TD01' | 'TD04'; relatedInvoices?: { number: string }[] }
const xmlOf = (input: Body & { supplierVat?: string }) =>
  supplierInvoiceXml({ supplierVat: input.supplierVat ?? FAKE_VAT.P2, buyerVat: FAKE_VAT.company, number: input.number, date: TODAY, lines: input.lines, dueDate: TODAY, progressive: String(++keys).padStart(5, '0'), ...(input.documentType ? { documentType: input.documentType } : {}), ...(input.relatedInvoices ? { relatedInvoices: input.relatedInvoices } : {}) })
const deliver = (input: Body & { supplierVat?: string }) => {
  const { xml, fileName } = xmlOf(input)
  return fake.deliver({ tenantId: A.tenant, accountId: A.sdi, xml, fileName })
}
/** A file of several invoices (a lotto): the second body put into the first file, one header. */
function deliverLotto(bodies: Body[]) {
  const files = bodies.map((body) => xmlOf(body))
  const bodyOf = (xml: string) => xml.slice(xml.indexOf('<FatturaElettronicaBody>'), xml.lastIndexOf('</FatturaElettronicaBody>') + '</FatturaElettronicaBody>'.length)
  const first = files[0]!.xml
  const close = first.lastIndexOf('</FatturaElettronicaBody>') + '</FatturaElettronicaBody>'.length
  const xml = first.slice(0, close) + files.slice(1).map((file) => bodyOf(file.xml)).join('') + first.slice(close)
  return fake.deliver({ tenantId: A.tenant, accountId: A.sdi, xml, fileName: files[0]!.fileName })
}

beforeAll(async () => {
  h = await startHarness('payables_followups')
  await seedCore({ db: h.database, namespace: NS })
  accounting = await seedAccounting({ db: h.database, namespace: NS })
  sourcing = await seedSourcing({ db: h.database, namespace: NS })
  for (const seedOf of [seedEmail, seedIntegration]) await seedOf({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000, "callTimeoutMs" = 2000, "circuitFailureThreshold" = 1000 WHERE provider IN ('R2', 'SDI')`)
  await admin(`UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3 WHERE id = $1`, [A.company, `IT${FAKE_VAT.company}`, FAKE_VAT.company])
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles, status, country, currency) VALUES ($1, $2, NULL, 'DE-SUP', 'ORGANISATION', 'Beispiel Leder GmbH', '{SUPPLIER}', 'ACTIVE', 'DE', 'EUR')`, [FOREIGN, A.tenant])
  // The office users the settings may list (a listed approver must be a user of the tenant).
  for (const [userId, email] of [[LISTED, 'listed'], [APPROVER, 'approver']] as const) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName") VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [userId, A.tenant, `${email}.${run}@w2b21.example.com`, `Made-up ${email}`])
  }
  fake = new FakeSdi()
  const gateway = createGateway({ environment: 'test', redis: h.redis, prefix: h.redisPrefix, secrets: h.secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  usePayablesSdi(createPayablesSdi({ gateway, fake }))
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

describe('the payables settings (Z8:03)', () => {
  it('none set: the W2a rule, not decided; the seeded price difference is outside it', async () => {
    const settings = await ok('finance', 'GET', `/payables/settings?companyId=${A.company}`)
    expect(settings).toMatchObject({ company: null, tenant: null, effective: { quantityTolerancePct: '0.0000', priceTolerancePct: '0.0000', billingBasis: 'RECEIVED', sdiApproval: 'ANY_APPROVER', decided: false }, mayManage: true })
    const { invoice } = await ok('finance', 'GET', url(accounting.supplierInvoiceId))
    expect(invoice).toMatchObject({ matchStatus: 'DIFFERENCES', tolerance: { decided: false, priceTolerancePct: '0' } })
  })

  it('refused in words: a percentage above 100, LISTED without people, the four eyes lifted, no settings permission', async () => {
    const pct = await refused('finance', 'PUT', '/payables/settings', { companyId: A.company, priceTolerancePct: '120' }, 400)
    expect(pct.issues.map((issue: Json) => issue.path)).toEqual(['body/priceTolerancePct'])
    const listed = await refused('finance', 'PUT', '/payables/settings', { companyId: A.company, sdiApproval: 'LISTED' }, 400)
    expect(listed.issues.map((issue: Json) => issue.path)).toEqual(['body/sdiApproverIds'])
    const lifted = await refused('finance', 'PUT', '/payables/settings', { companyId: A.company, accepterMayNotApprove: false }, 400)
    expect(lifted.issues[0].message).toContain('cannot be lifted')
    expect((await call('viewer', 'PUT', '/payables/settings', { companyId: A.company, priceTolerancePct: '1' })).statusCode).toBe(403)
  })

  it('a price tolerance the accountant agreed lets the seeded 2.4 % rise pass at the next match', async () => {
    const made = await ok('finance', 'PUT', '/payables/settings', { companyId: A.company, quantityTolerancePct: '0', priceTolerancePct: '2.5', differenceToleranceAmount: 0, billingBasis: 'RECEIVED' })
    expect(made).toMatchObject({ company: { version: 1, priceTolerancePct: '2.5000' }, effective: { priceTolerancePct: '2.5000', decided: true, source: { priceTolerancePct: 'COMPANY' } } })
    let { invoice } = await ok('finance', 'GET', url(accounting.supplierInvoiceId))
    ;({ invoice } = await ok('finance', 'POST', url(accounting.supplierInvoiceId, '/match'), { version: invoice.version }))
    expect(invoice).toMatchObject({ matchStatus: 'MATCHED', tolerance: { priceTolerancePct: '2.5000', decided: true } })
    expect(invoice.matches.find((row: Json) => row.differenceAmount === 1_050)).toMatchObject({ withinTolerance: true, priceTolerancePct: '2.5' })
    expect(invoice.tolerance.words.en).toContain('2.5 % on the price')
    const stale = await refused('finance', 'PUT', '/payables/settings', { companyId: A.company, version: 7, priceTolerancePct: '1' }, 409)
    expect(stale.issues[0].path).toBe('body/version')
  })

  it('LISTED: only the people the settings name approve what SDI delivered', async () => {
    await ok('finance', 'PUT', '/payables/settings', { companyId: A.company, version: 1, sdiApproval: 'LISTED', sdiApproverIds: [LISTED] })
    const { invoice } = await ok('approver', 'GET', url(accounting.supplierInvoiceId))
    expect(invoice.approval).toMatchObject({ ready: false, problems: [{ code: 'NOT_A_LISTED_APPROVER' }] })
    const refusal = await refused('approver', 'POST', url(accounting.supplierInvoiceId, '/approve'), { version: invoice.version }, 409)
    expect(refusal.issues).toEqual([{ path: 'refusal/NOT_A_LISTED_APPROVER', message: expect.stringContaining('payables settings list') }])
    const approved = await ok('listed', 'POST', url(accounting.supplierInvoiceId, '/approve'), { version: invoice.version })
    expect(approved.invoice).toMatchObject({ status: 'APPROVED', approval: { approvedBy: { id: LISTED } } })
    const settings = await ok('finance', 'GET', `/payables/settings?companyId=${A.company}`)
    expect(settings.people).toEqual([{ id: LISTED, name: 'Made-up listed' }])
    await ok('finance', 'PUT', '/payables/settings', { companyId: A.company, version: 2, sdiApproval: 'ANY_APPROVER' })
  })
})

describe('a voided typed invoice frees its number and date (Z8:04)', () => {
  it('typed, voided, typed again with the same number and date', async () => {
    const body = { companyId: A.company, partyId: FOREIGN, source: 'MANUAL', number: 'RE-2026-200', issueDate: TODAY, lines: [{ description: 'Lederprüfung', netAmount: 5_000, vatRatePct: '0', vatNature: 'N2.1' }] }
    const first = (await ok('finance', 'POST', '/payables/invoices', body, 201)).invoice
    const twice = await refused('finance', 'POST', '/payables/invoices', body, 409)
    expect(twice.issues[0].path).toBe('refusal/DUPLICATE')
    await ok('finance', 'POST', url(first.id, '/void'), { version: first.version, reason: 'Typed twice by mistake.' })
    const again = (await ok('finance', 'POST', '/payables/invoices', body, 201)).invoice
    expect(again).toMatchObject({ number: 'RE-2026-200', status: 'RECEIVED' })
  })
})

describe('a file of several invoices (a lotto) (Z8:05)', () => {
  it('is recorded whole: the file, its XML once, each body an invoice naming the file and its body', async () => {
    deliverLotto([
      { number: 'P2-L-0001', lines: [{ description: 'Trasporto ottobre', quantity: '1', unitPrice: '40.00' }] },
      { number: 'P2-L-0002', lines: [{ description: 'Etichette campione', quantity: '10', unitPrice: '1.50' }] },
    ])
    const pickup = await ok('finance', 'POST', '/payables/sdi/pickup', { companyId: A.company })
    expect(pickup).toMatchObject({ listed: 1, waiting: [] })
    expect(pickup.recorded.map((row: Json) => row.number)).toEqual(['P2-L-0001', 'P2-L-0002'])
    const [file] = await admin(`SELECT id, "invoiceCount", "xmlFileId", "sdiIdentifier" FROM "SupplierInvoiceFile" WHERE "tenantId" = $1 AND "invoiceCount" = 2 ORDER BY "createdAt" DESC LIMIT 1`, [A.tenant])
    expect(file).toMatchObject({ invoiceCount: 2, xmlFileId: expect.any(String) })
    const second = (await ok('finance', 'GET', url(pickup.recorded[1].invoiceId))).invoice
    expect(second).toMatchObject({ source: 'SDI', sdiIdentifier: file!.sdiIdentifier, sdiFile: { id: file!.id, invoiceCount: 2, bodyIndex: 2, xmlFileId: file!.xmlFileId }, files: { xml: { id: file!.xmlFileId } } })
    const xml = await ok('finance', 'GET', url(second.id, '/xml'))
    expect(xml).toMatchObject({ bodyIndex: 2 })
    expect(xml.read.documents.map((document: Json) => document.number)).toEqual(['P2-L-0001', 'P2-L-0002'])
    const again = await ok('finance', 'POST', '/payables/sdi/pickup', { companyId: A.company })
    expect(again).toMatchObject({ recorded: [], waiting: [] })
  })
})

describe('the SDI inbox (Z8:06)', () => {
  let itemId = ''

  it('a delivery from an unknown supplier waits in the inbox; each pickup counts an attempt', async () => {
    deliver({ number: 'UNK-2026-1', supplierVat: FAKE_VAT.stranger, lines: [{ description: 'Filo', quantity: '1', unitPrice: '10.00' }] })
    await ok('finance', 'POST', '/payables/sdi/pickup', { companyId: A.company })
    await ok('finance', 'POST', '/payables/sdi/pickup', { companyId: A.company })
    const inbox = await ok('finance', 'GET', `/payables/sdi/inbox?companyId=${A.company}&status=OPEN`)
    expect(inbox.counts).toMatchObject({ open: 1 })
    expect(inbox.items[0]).toMatchObject({ problem: 'SUPPLIER_UNKNOWN', attempts: 2, status: 'OPEN', problemText: expect.stringContaining('not a supplier among the parties') })
    itemId = inbox.items[0].id
    const status = await ok('finance', 'GET', `/payables/sdi?companyId=${A.company}`)
    expect(status.companies[0]).toMatchObject({ inboxOpen: 1, lastPickup: { waiting: [expect.objectContaining({ problem: expect.stringContaining('not a supplier') })] } })
  })

  it('dismissed with a reason, it is not tried again; reopened, it is', async () => {
    const before = (await ok('finance', 'GET', `/payables/sdi/inbox?companyId=${A.company}`)).items.find((row: Json) => row.id === itemId)
    expect((await call('viewer', 'POST', `/payables/sdi/inbox/${itemId}/dismiss`, { version: before.version, reason: 'x' })).statusCode).toBe(403)
    const { item } = await ok('finance', 'POST', `/payables/sdi/inbox/${itemId}/dismiss`, { version: before.version, reason: 'A test delivery of the intermediary.' })
    expect(item).toMatchObject({ status: 'DISMISSED', dismissed: { by: { id: CLERK }, reason: 'A test delivery of the intermediary.' } })
    const pickup = await ok('finance', 'POST', '/payables/sdi/pickup', { companyId: A.company })
    expect(pickup.waiting).toEqual([])
    const twice = await refused('finance', 'POST', `/payables/sdi/inbox/${itemId}/dismiss`, { version: item.version, reason: 'Again' }, 409)
    expect(twice.issues[0].path).toBe('refusal/NOT_OPEN')
    const reopened = (await ok('finance', 'POST', `/payables/sdi/inbox/${itemId}/reopen`, { version: item.version })).item
    expect(reopened).toMatchObject({ status: 'OPEN', dismissed: null, attempts: 2 })
  })

  it('once the supplier is known, the next pickup records it and the inbox item is RECORDED with the invoice', async () => {
    const party = newId()
    await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles, status, country, currency) VALUES ($1, $2, NULL, 'IT-NEW', 'ORGANISATION', 'Filati Fittizi S.r.l.', '{SUPPLIER}', 'ACTIVE', 'IT', 'EUR')`, [party, A.tenant])
    await admin(`INSERT INTO "PartyTaxIdentity" (id, "tenantId", "partyId", country, "taxMode", "vatNumber", "validFrom") VALUES ($1, $2, $3, 'IT', 'IT_B2B', $4, '2020-01-01')`, [newId(), A.tenant, party, `IT${FAKE_VAT.stranger}`])
    const pickup = await ok('finance', 'POST', '/payables/sdi/pickup', { companyId: A.company })
    expect(pickup.recorded.map((row: Json) => row.number)).toEqual(['UNK-2026-1'])
    const { items } = await ok('finance', 'GET', `/payables/sdi/inbox?companyId=${A.company}`)
    expect(items.find((row: Json) => row.id === itemId)).toMatchObject({ status: 'RECORDED', recorded: { supplierInvoiceId: pickup.recorded[0].invoiceId, supplierInvoiceFileId: null } })
  })
})

describe('a supplier credit note matched to its claim (Z8:07)', () => {
  it('settles the claim accepted for a credit and names it; the claim reads its credit note; once only', async () => {
    await admin(`UPDATE "SupplierClaim" SET status = 'SENT', "sentAt" = now(), "sentById" = $2 WHERE id = $1`, [sourcing.claimId, CLERK])
    await admin(`UPDATE "SupplierClaim" SET status = 'ACCEPTED', "supplierAnswer" = 'Credit agreed by phone.', "answeredAt" = now() WHERE id = $1`, [sourcing.claimId])
    deliver({ number: 'NC-2026-0101', documentType: 'TD04', lines: [{ description: 'Storno pelle forata', quantity: '4.5', uom: 'FT2', unitPrice: '4.20' }], relatedInvoices: [{ number: '2026/0412' }] })
    const pickup = await ok('finance', 'POST', '/payables/sdi/pickup', { companyId: A.company })
    const noteId = pickup.recorded.find((row: Json) => row.number === 'NC-2026-0101').invoiceId
    const note = (await ok('finance', 'GET', url(noteId))).invoice
    const settled = await ok('finance', 'POST', url(noteId, '/settle-claim'), { version: note.version, claimId: sourcing.claimId })
    expect(settled).toMatchObject({ claim: { id: sourcing.claimId, status: 'CLOSED' }, claimClosed: true, invoice: { claim: { id: sourcing.claimId, number: 'SEED-CLM-0001', status: 'CLOSED' } } })
    const claim = (await ok('finance', 'GET', `/purchasing/claims/${sourcing.claimId}`)).claim
    expect(claim.credit).toMatchObject({ matched: { total: 1_890, creditNotes: [{ id: noteId, number: 'NC-2026-0101' }] }, difference: 0 })
    const twice = await refused('finance', 'POST', url(noteId, '/settle-claim'), { version: settled.invoice.version, claimId: sourcing.claimId }, 409)
    expect(twice.issues[0].path).toBe('refusal/CLAIM_NAMED')
    const events = await admin(`SELECT type FROM "OutboxEvent" WHERE subject = $1 AND type LIKE 'supplier_invoice.claim_%'`, [noteId])
    expect(events.map((row) => row.type)).toEqual(['supplier_invoice.claim_settled'])
  })
})
