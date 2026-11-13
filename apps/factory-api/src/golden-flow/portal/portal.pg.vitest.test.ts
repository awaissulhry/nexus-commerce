import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { publicDocCodeOf } from '@nexus/factory-domain/compliance/public-doc/code'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { ErrorReport } from '@nexus/factory-domain/observability/report'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { newId } from '@nexus/factory-domain/core/ids'
import { FakePaymentProvider } from '../../adapters/payment-fake/fake'
import { textOf } from '../../adapters/ses/fake'
import { callerFor, command } from '../../core/command'
import { createPaymentsRuntime, usePayments } from '../../modules/payments/online/runtime'
import { createErrorTracker, useErrorTracker } from '../../observability/tracker'
import { useInbound } from '../../platform/inbound/providers'
import { systemContext } from '../../platform/outbox/system'
import { SECRET_PURPOSES, storeSecret } from '../../platform/secrets/store'
import { useAbuseGuard } from '../../platform/abuse/guard'
import { usePortalOptions } from '../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser } from '../../platform/auth/portal/testing/portal'
import { Browser } from '../../platform/auth/sessions/testing/harness'
import { fakeScanner } from '../../platform/files/scan/fake'
import { useScanner } from '../../platform/files/scan/service'
import type { EventHandler } from '../../platform/outbox/dispatch'
import { standardReasonsForNewTenants } from '../../platform/reasons/standard'
import type { SearchIndexer } from '../../platform/search/indexer'
import { indexNewTenants } from '../../platform/search/indexing'
import { admin, announce, call, ok, pdf, person, putBytes, QUIET, startWorld, stepped, type Method, type Person, type World } from '../testing/world'
import { assertEveryHandler, everyHandler, searchIndexers, settler } from '../daily/testing/day'

/**
 * The W2b-3 golden flow (B-W2b-202; design check I7): a customer, a tannery and a workshop online, and every link page, THROUGH
 * THE HTTP ROUTES, each act by the person who does it, on the seeded factory; portal and link records cross sales, purchasing,
 * shipping, payments, quality and files, and the flow proves they agree and that the partner wall holds on every route:
 *
 *   A  the partner roles synced; the sales office opens P1's portal and invites a buyer, the buyer opens P2's portal for a tannery
 *      desk and a workshop: each signs in by an e-mail code (a scanner opening the sign-in link first burns nothing) and
 *      acknowledges the portal terms at the first visit.
 *   C  the customer: its orders read and a question asked in an order's thread; production progress refused while the switch is
 *      off and shown when on; a reorder at today's prices with the difference named on each line, the request made into an order
 *      by the office; a change request accepted into an amendment and re-confirmed by the customer on the revised-order approval;
 *      the order's deposit paid on the FAKE card provider (the webhook twice, one payment); the declaration of conformity of what
 *      it received, with the certificate valid on the shipping date; a return asked and authorised; a complaint answer published
 *      to the portal.
 *   T  the tannery: a purchase order confirmed in the portal with a substitute for one line; the buyer takes the substitute by a
 *      revised order the supplier confirms; a ship notice with its hides checked against the order; the receipt prefilled from it;
 *      a document sent through the portal and accepted (refused while the scanner is off); the questionnaire answered by link.
 *   W  the workshop: a job accepted by link, the kit confirmed in the portal, progress reported, the return announced, which
 *      prefills the office's receive back.
 *   K  a concession approved by link by the customer.
 *   L  every link page: the tracking link and the public search, measurements with the notice first and a draft, a secure file
 *      with a password and a receipt (a file with pay figures refused), a used-up link renewed, the public DoC by code, a record
 *      shared with comment rights, the accountant's time-boxed access.
 *   X  the partner wall: a second customer, a second tannery and a second workshop each read the other's records on every route
 *      they can call (404); a partner of another kind is refused the route (403); an office cookie on a portal route and a
 *      portal cookie on an office route are strangers (401); no price in a supplier or workshop answer, no cost, margin or pay
 *      key in any partner or link answer of the whole flow.
 *
 * World: the W1 golden world (../testing/world.ts: a throwaway PostgreSQL 17 database from the migrations, EVERY base seed plus
 * the W1 golden scenario, the real app with the real sign-in, every outside provider FAKE: mail, payment, carrier, the virus
 * scanner) and the W2a day's worker (../daily/testing/day.ts: EVERY handler list of background.ts, run in-process by the real
 * outbox relay); the public routes' abuse guard on an in-memory store of the harness clock (as every module test of a public
 * route), each partner on a network of its own. SQL only reads ids and asserts: no step is made by SQL. Every name, address and
 * figure is made up. Run with `node scripts/factory/golden-flow.mjs portal`.
 */

let w: World
let handlers: readonly EventHandler[]
let indexers: readonly SearchIndexer[]
let settle: () => Promise<string[]>
type Json = Record<string, any>
const P = {} as Record<'owner' | 'admin' | 'sales' | 'buyer' | 'warehouse' | 'finance' | 'inspector', Person>
/** What the flow made, step by step. */
const G = {} as Record<string, any>
/** What the API reported as unexpected (a 500) during the flow: none at the end. */
const unexpected: ErrorReport[] = []
/** Every record the flow made: the end checks look for their audit rows. */
const made = new Set<string>()
const keep = (...ids: (string | undefined | null)[]) => ids.forEach((recordId) => recordId && made.add(recordId))
const id = (key: string) => w.id(key)
/** A seed row written with the seeds' firstId (ids that start with eight zeros) or with eight f's. */
const first = (key: string) => `00000000${w.id(key).slice(8)}`
const fours = (key: string) => `ffffffff${w.id(key).slice(8)}`
const companyA = () => id('company:A')
const siteA1 = () => id('site:A1')
const today = () => businessDate(new Date())
const pathsOf = (error: Json): string[] => ((error?.error?.issues ?? []) as Json[]).map((issue) => String(issue.path))

// ---- partners and links: every answer kept for the wall ------------------------------------------------------------------------

type Kind = 'customer' | 'supplier' | 'workshop' | 'guest'
interface Partner {
  readonly key: string
  readonly kind: Kind
  readonly partyId: string
  readonly email: string
  readonly browser: Browser
  userId?: string
}
const R = {} as Record<'buyer' | 'finance' | 'quality' | 'tannery' | 'workshop' | 'otherBuyer' | 'otherTannery' | 'otherWorkshop' | 'accountant', Partner>
/** Every answer a partner or a link holder got: what the wall searches at the end. */
const seen: { readonly who: string; readonly kind: Kind | 'link' | 'public'; readonly url: string; readonly body: unknown }[] = []
let network = 10

/** A partner's call (its portal cookie and the office CSRF): the answer kept for the wall. */
async function as(partner: Partner, method: Method, url: string, body?: unknown, status = 200, headers: Record<string, string> = {}): Promise<Json> {
  const answer = await call(partner.browser, method, url, body, headers)
  expect(answer.status, `${partner.key} ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  seen.push({ who: partner.key, kind: partner.kind, url, body: answer.body })
  return answer.body
}

/** A link holder's call (the token in `x-factory-link`, never a cookie): the answer kept for the wall. */
async function viaLink(token: string, method: Method, url: string, body?: unknown, status = 200, headers: Record<string, string> = {}): Promise<Json> {
  const answer = await call(new Browser(w.h.app), method, url, body, { 'x-factory-link': token, ...headers })
  expect(answer.status, `link ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  seen.push({ who: 'link', kind: 'link', url, body: answer.body })
  return answer.body
}

/** A public call (no cookie, no token) from a network of its own: the answer kept for the wall. */
async function anyone(method: 'GET' | 'POST', url: string, payload?: Json, status = 200, remoteAddress = '198.51.100.7'): Promise<Json> {
  const response = await w.h.app.inject({ method, url, remoteAddress, ...(payload === undefined ? {} : { payload }) })
  let body: any
  try {
    body = response.json()
  } catch {
    body = response.body
  }
  expect(response.statusCode, `public ${method} ${url}: ${response.body.slice(0, 400)}`).toBe(status)
  seen.push({ who: 'public', kind: 'public', url, body })
  return body
}

/** The token of the newest mail of a template to an address. */
function tokenOf(template: string, to: string): string {
  const mail = w.h.ses.mails.filter((entry) => entry.templateKey === template && entry.to.includes(to)).at(-1)
  if (!mail) throw new Error(`no ${template} mail to ${to} (mails: ${w.h.ses.mails.map((entry) => `${entry.templateKey} to ${entry.to.join(',')}`).join('; ')})`)
  const token = /#token=(\S+)/.exec(textOf(mail.raw))?.[1]
  if (!token) throw new Error(`the ${template} mail to ${to} holds no token`)
  return decodeURIComponent(token)
}
const mailsOf = (template: string, to: string) => w.h.ses.mails.filter((entry) => entry.templateKey === template && entry.to.includes(to))

/** A partner's browser on a network of its own (the sign-in guard counts per network). */
async function partnerOf(key: string, kind: Kind, partyId: string, email: string): Promise<Partner> {
  const partner: Partner = { key, kind, partyId, email, browser: await portalBrowser(w.h, `203.0.113.${++network}`) }
  return partner
}

/** The portal sign-in by the mailed code, then the first visit: the portal terms in force acknowledged (grants start here). */
async function signIn(partner: Partner): Promise<void> {
  expect((await call(partner.browser, 'POST', '/portal/signin/start', { tenant: w.tenant.slug, company: 'SCA', email: partner.email })).status).toBe(200)
  await w.h.auth.settled()
  await as(partner, 'POST', '/portal/signin/code', { tenant: w.tenant.slug, company: 'SCA', email: partner.email, code: mailedCode(w.h, partner.email)!.code })
  await firstVisit(partner)
}

async function firstVisit(partner: Partner): Promise<void> {
  const terms = await as(partner, 'GET', '/portal/terms?locale=en')
  await as(partner, 'POST', '/portal/first-visit', { noticeId: terms.notice.id, noticeLocale: terms.notice.locale, sha256: terms.notice.sha256 })
  const me = await as(partner, 'GET', '/portal/me')
  expect(me).toMatchObject({ termsDue: false, party: { id: partner.partyId } })
  partner.userId = me.user.id
  keep(partner.userId)
}

/** The office opens a party's portal (step-up; version 0 when it has no settings yet) and invites a person of one kind. */
async function openPortal(who: Person, partyId: string, change: Json = {}): Promise<void> {
  const tab = await ok(who, 'GET', `/partners/${partyId}`)
  await stepped(w, who)
  await ok(who, 'POST', `/partners/${partyId}/settings`, { portalOn: true, version: tab.settings?.version ?? 0, ...change })
}
async function invite(who: Person, partner: Partner, body: Json): Promise<Json> {
  await stepped(w, who)
  const invited = await ok(who, 'POST', `/partners/${partner.partyId}/people`, { email: partner.email, displayName: body.displayName, locale: 'en', companyId: companyA(), ...body })
  expect(invited).toMatchObject({ delivery: 'sent', invitation: { email: partner.email } })
  expect(mailsOf('auth.portal_invitation', partner.email)).toHaveLength(1)
  return invited
}

/** A file of a record through the real routes: announced, its bytes sent to the presigned URL, completed. */
async function upload(who: Person, owner: Json, name: string, body: Buffer = pdf(name)): Promise<string> {
  const announced = await ok(who, 'POST', '/files', { companyId: companyA(), kind: 'DOCUMENT', ...owner, ...announce(name, body) }, 201)
  await putBytes(w, announced, body)
  expect((await ok(who, 'POST', `/files/${announced.file.id}/complete`)).file.status).toBe('AVAILABLE')
  return announced.file.id as string
}

// ---- the wall -----------------------------------------------------------------------------------------------------------------

/** Every key of an answer, at any depth. */
function keysOf(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const entry of value) keysOf(entry, into)
  else if (value && typeof value === 'object')
    for (const [key, entry] of Object.entries(value)) {
      into.push(key)
      keysOf(entry, into)
    }
  return into
}
/** A cost, margin or pay key: never in a partner or link answer (price is a customer's own grain; payments are a customer's own). */
const NEVER = (key: string) => /cost|margin|wage|salary|earning|pieceRate|payroll|payslip/i.test(key) || /^pay([A-Z_]|$)/.test(key)
/** A price key: never in a supplier's, a workshop's, a link's or the public's answer. */
const PRICE = (key: string) => key !== 'seesPrices' && /price|amount|discount|netValue|grossValue|vatRate/i.test(key)

// ---- the event types the flow must leave behind (Z1) --------------------------------------------------------------------------

const EVENTS = [
  // A: partners
  'partner_portal.settings_changed',
  'partner_user.invited',
  // C: the customer
  'thread.message_posted',
  'portal_order_request.sent',
  'portal_order_request.accepted',
  'sales_order.created',
  'order_change_request.asked',
  'order_change_request.answered',
  'sales_order.amended',
  'approval_request.asked',
  'approval_request.answered',
  'payment_intent.started',
  'payment_intent.finished',
  'payment.recorded',
  'return_request.sent',
  'return.authorised',
  'complaint.received',
  'complaint_answer.published',
  'shipment.documents_attached',
  // T: the tannery
  'purchase_order.sent',
  'purchase_order.changes_proposed',
  'purchase_order.revision_started',
  'purchase_order.confirmed',
  'ship_notice.sent',
  'ship_notice.received',
  'inventory.receipt_posted',
  'supplier_document.uploaded',
  'supplier_document.accepted',
  'supplier_questionnaire.link_sent',
  'supplier_questionnaire.answered',
  'supplier_questionnaire.reviewed',
  'partner_task.opened',
  'partner_task.closed',
  // W: the workshop
  'subcontract_order.job_sent',
  'subcontract_order.job_answered',
  'subcontract_order.kit_sent',
  'subcontract_order.kit_checked',
  'subcontract_order.progress_reported',
  'subcontract_order.return_announced',
  'subcontract_order.received',
  // L: the link pages
  'shipment.tracking_link_made',
  'measure_link.sent',
  'measurements.submitted',
  'link.used',
  'link.renewed',
  'record_share.invited',
  'record_share.changed',
]

beforeAll(async () => {
  useErrorTracker(createErrorTracker({ sink: { kind: 'fake', send: (report) => void unexpected.push(report) }, source: 'api' }))
  w = await startWorld()
  // The portal's codes are refused by the database once past their end in REAL time (factory_portal_code_guard reads now()):
  // the harness clock starts at now, never the two hours back harnessStart takes near a month end (no month-end check here).
  w.h.clock.set(new Date())
  freshGuard(w.h)
  usePortalOptions({ answerFloorMs: 0 })
  useScanner(fakeScanner())
  // The FAKE card provider and the inbound ledger on the harness clock (its webhooks are signed and dated by it).
  useInbound({ environment: 'test', secrets: w.h.secrets, clock: w.h.clock })
  usePayments(createPaymentsRuntime({ gateway: w.gateway, environment: 'test', fake: new FakePaymentProvider(w.h.clock) }))
  // GAP (no route): the seeded FAKE payment account of company A has no webhook secret, and no route sets one (Admin ›
  // Connections pauses and resumes only). Set as the system would, in one command with its audit row; named in the notes.
  const [account] = await admin<{ id: string }>(w, `SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND code = 'payments-fake-a'`, [w.tenant.id])
  await command(callerFor(w.h.database, systemContext(w.tenant.id, newId())), { name: 'golden.paymentWebhookSecret', input: {} }, async (tools) => {
    const secret = await storeSecret(tools, w.h.secrets, { purpose: SECRET_PURPOSES.webhook, plaintext: `made-up-golden-hook-${newId()}` })
    await tools.tx.integrationAccount.update({ where: { id: account!.id }, data: { webhookSecretId: secret.id }, select: { id: true } })
    tools.audit({ recordType: 'IntegrationAccount', recordId: account!.id, after: { webhookSecret: 'set' } })
    return {}
  })
  indexers = await searchIndexers()
  handlers = everyHandler(indexers)
  settle = settler(w, handlers)
  for (const [key, role] of [
    ['owner', 'owner'],
    ['admin', 'admin'],
    ['sales', 'sales'],
    ['buyer', 'buyer'],
    ['warehouse', 'warehouse'],
    ['finance', 'finance'],
    ['inspector', 'quality_inspector'],
  ] as const) {
    P[key] = await person(w, key, role)
  }
}, 1_200_000)

afterAll(async () => {
  usePayments(undefined)
  useInbound(undefined)
  useScanner(undefined)
  useAbuseGuard(undefined)
  usePortalOptions({})
  useErrorTracker(undefined)
  await w?.close()
}, 60_000)

// One step may take a while on a loaded machine (a step renders PDFs, runs the worker).
describe('the W2b-3 golden flow: a customer, a tannery and a workshop online, and every link page, through the HTTP routes', { timeout: 180_000 }, () => {
  it('00 the world: the worker runs every handler list of background.ts; the seeds drain; the partner roles synced by the administrator', async () => {
    assertEveryHandler()
    await standardReasonsForNewTenants({ database: w.h.database, log: QUIET })
    await indexNewTenants({ database: w.h.database, indexers, log: QUIET })
    await settle()
    // REFUSAL: without the partner roles a portal cannot be given to anybody.
    await stepped(w, P.sales)
    const early = await ok(P.sales, 'POST', `/partners/${id('party:P1')}/people`, { email: 'early@brand-p1.example', displayName: 'Too Early', locale: 'en', roleKey: 'customer-buyer', companyId: companyA() }, 409)
    expect(early.error.message).toMatch(/portal roles/i)
    await stepped(w, P.admin)
    const synced = await ok(P.admin, 'POST', '/auth/roles/sync-templates')
    expect(synced.created).toBeGreaterThan(0)
    expect((await admin<{ key: string }>(w, `SELECT key FROM "Role" WHERE "tenantId" = $1 AND audience = 'PARTNER' ORDER BY key`, [w.tenant.id])).map((row) => row.key)).toEqual(
      expect.arrayContaining(['customer-buyer', 'supplier-orders', 'subcontractor-jobs', 'guest-accountant']),
    )
  })

  // ---- A: partners invited and signed in --------------------------------------------------------------------------------------

  it('A01 the sales office opens P1’s portal and invites a buyer; a scanner opening the sign-in link first burns nothing, Continue signs the buyer in; the first visit takes the terms', async () => {
    R.buyer = await partnerOf('buyer', 'customer', id('party:P1'), 'giulia.golden@brand-p1.example')
    // REFUSAL: the portal is off (the seeds ship every portal off): the right code is refused in words.
    await stepped(w, P.sales)
    const invited = await invite(P.sales, R.buyer, { displayName: 'Giulia Golden', roleKey: 'customer-buyer' })
    expect(invited.invitation.roleKeys).toEqual(['customer-buyer', 'partner-comment', 'partner-upload', 'partner-approve'])
    expect(textOf(mailsOf('auth.portal_invitation', R.buyer.email)[0]!.raw)).toContain(`/p/signin?tenant=${w.tenant.slug}&company=SCA`)
    expect((await call(R.buyer.browser, 'POST', '/portal/signin/start', { tenant: w.tenant.slug, company: 'SCA', email: R.buyer.email })).status).toBe(200)
    await w.h.auth.settled()
    const off = await call(R.buyer.browser, 'POST', '/portal/signin/code', { tenant: w.tenant.slug, company: 'SCA', email: R.buyer.email, code: mailedCode(w.h, R.buyer.email)!.code })
    expect(off.status, JSON.stringify(off.body)).toBe(403)
    expect(pathsOf(off.body)).toEqual(['access/PORTAL_OFF'])
    await openPortal(P.sales, id('party:P1'), { allowedRoleKeys: ['customer-buyer', 'customer-viewer', 'customer-finance', 'customer-quality'] })
    // A new code a minute per address: the clock moves on (the harness clock: sessions and codes, never the server's today).
    w.h.clock.advance(61_000)
    expect((await call(R.buyer.browser, 'POST', '/portal/signin/start', { tenant: w.tenant.slug, company: 'SCA', email: R.buyer.email })).status).toBe(200)
    await w.h.auth.settled()
    const mailed = mailedCode(w.h, R.buyer.email)!
    // The mail's scanner opens the link first: the preview names the portal and the address and uses nothing.
    for (let scan = 0; scan < 2; scan++) {
      expect(await as(R.buyer, 'POST', '/portal/signin/link/preview', { token: mailed.token })).toMatchObject({ company: { code: 'SCA' }, email: R.buyer.email })
    }
    await as(R.buyer, 'POST', '/portal/signin/link', { token: mailed.token })
    // The link is used now: a second Continue opens nothing.
    const again = await call(new Browser(w.h.app), 'POST', '/portal/signin/link/preview', { token: mailed.token })
    expect(again.status).toBe(404)
    const before = await as(R.buyer, 'GET', '/portal/me')
    expect(before.termsDue).toBe(true)
    // Grants start at the first visit: an order list before it is refused.
    await as(R.buyer, 'GET', '/portal/sales-orders', undefined, 403)
    await firstVisit(R.buyer)
    const access = await as(R.buyer, 'GET', '/portal/access')
    expect(access).toMatchObject({ kind: 'CUSTOMER', role: { key: 'customer-buyer' } })
    expect(access.capabilities).toEqual(expect.arrayContaining(['comment', 'upload', 'approve']))
    await settle()
  })

  it('A02 the buyer opens P2’s portal for a tannery desk (supplier orders) and a workshop (jobs): one main role each; both sign in by code', async () => {
    R.tannery = await partnerOf('tannery', 'supplier', id('party:P2'), 'marta.golden@tannery-p2.example')
    R.workshop = await partnerOf('workshop', 'workshop', id('party:P2'), 'rosa.golden@workshop-p2.example')
    await openPortal(P.buyer, id('party:P2'), { maxUsers: 6 })
    // REFUSAL: P2 supplies and works for us: which portal a person gets must be said.
    await stepped(w, P.buyer)
    const noKind = await ok(P.buyer, 'POST', `/partners/${id('party:P2')}/people`, { email: R.tannery.email, displayName: 'Marta Golden', locale: 'en', roleKey: 'supplier-orders', companyId: companyA() }, 400)
    expect(noKind.error.issues.map((issue: Json) => issue.path)).toContain('kind')
    await invite(P.buyer, R.tannery, { displayName: 'Marta Golden', kind: 'SUPPLIER', roleKey: 'supplier-orders' })
    await invite(P.buyer, R.workshop, { displayName: 'Rosa Golden', kind: 'SUBCONTRACTOR', roleKey: 'subcontractor-jobs' })
    await signIn(R.tannery)
    await signIn(R.workshop)
    expect(await as(R.tannery, 'GET', '/portal/access')).toMatchObject({ kind: 'SUPPLIER', role: { key: 'supplier-orders' } })
    expect(await as(R.workshop, 'GET', '/portal/access')).toMatchObject({ kind: 'SUBCONTRACTOR', role: { key: 'subcontractor-jobs' } })
    await settle()
  })

  // ---- C: the customer --------------------------------------------------------------------------------------------------------

  it('C01 the buyer reads P1’s orders and asks on one in its thread; production progress is refused while the switch is off, shown once the sales office switches it on, and gone again at once when it is off', async () => {
    const so2 = id('production:sales-order:SO-0002')
    const list = await as(R.buyer, 'GET', '/portal/sales-orders?chip=ALL')
    expect((list.items as Json[]).map((item) => item.number)).toEqual(expect.arrayContaining(['SEED-SO-0001', 'SEED-SO-0002']))
    const record = await as(R.buyer, 'GET', `/portal/sales-orders/${so2}`)
    expect(record).toMatchObject({ order: { number: 'SEED-SO-0002' }, progressShared: false })
    G.so2Line = record.lines[0]
    const off = await as(R.buyer, 'GET', `/portal/sales-orders/${so2}/progress`, undefined, 404)
    expect(off.error.message).toMatch(/not shared/)
    const share = async (progressShared: boolean) => {
      const tab = await ok(P.sales, 'GET', `/partners/${id('party:P1')}`)
      await stepped(w, P.sales)
      await ok(P.sales, 'POST', `/partners/${id('party:P1')}/settings`, { progressShared, version: tab.settings.version })
    }
    await share(true)
    const progress = await as(R.buyer, 'GET', `/portal/sales-orders/${so2}/progress`)
    expect(progress).toMatchObject({ refreshSeconds: 60, whole: { ordered: expect.any(Number) } })
    expect((progress.stages as Json[]).map((stage) => stage.key)).toEqual(['CUT', 'SEWN', 'INSPECTED', 'PACKED'])
    await share(false)
    await as(R.buyer, 'GET', `/portal/sales-orders/${so2}/progress`, undefined, 404)
    const thread = await as(R.buyer, 'GET', `/portal/threads/SalesOrder/${id('sales:SO1')}`)
    expect(thread).toMatchObject({ record: { ourRef: 'SEED-SO-0001' }, composer: { canPost: true } })
    const posted = await as(R.buyer, 'POST', `/portal/threads/SalesOrder/${id('sales:SO1')}/messages`, { body: 'Can you ship on Friday?' }, 201)
    expect(posted.message).toMatchObject({ side: 'PARTNER', channel: 'PORTAL', author: { mine: true } })
    expect(JSON.stringify(await ok(P.sales, 'GET', `/threads/SalesOrder/${id('sales:SO1')}`))).toContain('Can you ship on Friday?')
    await settle()
  })

  it('C02 the buyer reorders SEED-SO-0002 at today’s prices, the difference named on each line; the request is sent and the sales office makes it into an order (with its 30 % deposit asked)', async () => {
    const so2 = id('production:sales-order:SO-0002')
    const plan = await as(R.buyer, 'GET', `/portal/reorder/orders/${so2}`)
    const priced = (plan.lines as Json[]).filter((line) => line.addable)
    expect(priced.length).toBeGreaterThan(0)
    for (const line of priced) {
      expect(line.priceNow).not.toBe(line.unitPriceThen)
      expect(line.notices).toContainEqual(expect.objectContaining({ code: 'PRICE_CHANGED', words: expect.objectContaining({ en: `Price now ${line.priceNow} (was ${line.unitPriceThen})` }) }))
    }
    let request = (await as(R.buyer, 'POST', '/portal/order-requests', { source: 'REORDER', customerRef: 'PO-GOLDEN-0001' }, 201)).request
    expect(request).toMatchObject({ status: 'DRAFT', number: null })
    const reordered = await as(R.buyer, 'POST', `/portal/order-requests/${request.id}/reorder`, { version: request.version, orderId: so2 })
    request = reordered.request
    expect(reordered.added).toBe(priced.length)
    for (const line of request.lines as Json[]) expect(line).toMatchObject({ unitPriceShown: line.priceNow, source: expect.objectContaining({ orderNumber: 'SEED-SO-0002' }) })
    const sent = await as(R.buyer, 'POST', `/portal/order-requests/${request.id}/send`, { version: request.version })
    expect(sent.request).toMatchObject({ status: 'SENT', number: expect.stringMatching(/^RQ-\d{4}$/) })
    G.request = sent.request
    keep(G.request.id)
    await settle()
    const office = await ok(P.sales, 'GET', `/sales/order-requests/${G.request.id}`)
    expect(office.may).toMatchObject({ order: true })
    const accepted = await ok(P.sales, 'POST', `/sales/order-requests/${G.request.id}/accept`, { version: office.request.version, as: 'ORDER' })
    expect(accepted).toMatchObject({ request: { status: 'ACCEPTED' }, made: { as: 'ORDER', salesOrderId: expect.any(String) } })
    await ok(P.sales, 'POST', `/sales/order-requests/${G.request.id}/accept`, { version: accepted.request.version, as: 'ORDER' }, 409)
    G.order = { id: accepted.made.salesOrderId, number: accepted.made.number }
    keep(G.order.id)
    const theirs = await as(R.buyer, 'GET', `/portal/order-requests/${G.request.id}`)
    expect(theirs.request).toMatchObject({ status: 'ACCEPTED', salesOrder: { id: G.order.id } })
    const order = await as(R.buyer, 'GET', `/portal/sales-orders/${G.order.id}`)
    expect(order.deposits).toEqual([expect.objectContaining({ status: 'OPEN' })])
    await settle()
  })

  it('C03 a change request: the buyer asks one more piece of a size, the sales office accepts it into an amendment; the order waits for the customer’s re-confirmation, which the buyer gives on the revised-order approval in the portal', async () => {
    const rules = await as(R.buyer, 'GET', `/portal/sales-orders/${G.order.id}/change-requests/rules`)
    expect(rules.change).toMatchObject({ code: 'FREE' })
    const line = rules.lines[0]
    const size = (line.sizes as Json[]).find((entry) => entry.quantity > 0)!
    G.changeCell = { lineId: line.lineId, size: size.size, quantity: size.quantity + 3 }
    const asked = await as(R.buyer, 'POST', `/portal/sales-orders/${G.order.id}/change-requests`, { kind: 'CHANGE', cells: [{ lineId: line.lineId, size: size.size, quantity: size.quantity + 1 }], note: 'One more, please.' }, 201)
    expect(asked.request).toMatchObject({ kind: 'CHANGE', status: 'OPEN' })
    // REFUSAL: one open request per order.
    const second = await as(R.buyer, 'POST', `/portal/sales-orders/${G.order.id}/change-requests`, { kind: 'CHANGE', cells: [{ lineId: line.lineId, size: size.size, quantity: size.quantity + 2 }] }, 409)
    expect(pathsOf(second)).toEqual(['body/OPEN_REQUEST'])
    const preview = await ok(P.sales, 'GET', `/sales/change-requests/${asked.request.id}`)
    expect(preview.preview).toMatchObject({ ok: true, amendment: { reacceptanceNeeded: true } })
    const answered = await ok(P.sales, 'POST', `/sales/change-requests/${asked.request.id}/accept`, { version: asked.request.version, answer: 'Done: one more piece.' })
    expect(answered.request).toMatchObject({ status: 'ACCEPTED', amendment: { id: expect.any(String), revision: 1 } })
    // An amendment's audit rows are its order's (orders.amend on the SalesOrder), never its own id.
    keep(asked.request.id)
    expect((await as(R.buyer, 'GET', `/portal/sales-orders/${G.order.id}`)).order.reconfirmNeeded).toBe(true)
    const ask = await ok(P.sales, 'POST', '/approvals-out', { kind: 'REVISED_ORDER', recordType: 'SalesOrderAmendment', recordId: answered.request.amendment.id, question: 'Please confirm the order as revised.', send: false }, 201)
    expect(ask.request).toMatchObject({ kind: 'REVISED_ORDER', status: 'OPEN' })
    G.revised = ask.request
    keep(ask.request.id)
    await settle()
    const open = await as(R.buyer, 'GET', '/portal/approvals?state=OPEN')
    expect((open.items as Json[]).map((item) => item.id)).toContain(ask.request.id)
    const page = await as(R.buyer, 'GET', `/portal/approvals/${ask.request.id}`)
    expect(page).toMatchObject({ content: { revisedOrder: { revision: 1 } }, may: { answer: true, withChanges: false } })
    const changes = await as(R.buyer, 'POST', `/portal/approvals/${ask.request.id}/answer`, { decision: 'APPROVED_WITH_CHANGES', answer: 'x', typedName: 'Giulia Golden', version: page.request.version }, 400)
    expect(pathsOf(changes)).toContain('body/decision')
    await as(R.buyer, 'POST', `/portal/approvals/${ask.request.id}/answer`, { decision: 'APPROVED', typedName: 'Giulia Golden', version: page.request.version })
    expect((await as(R.buyer, 'GET', `/portal/sales-orders/${G.order.id}`)).order.reconfirmNeeded).toBe(false)
    await settle()
  })

  it('C04 the deposit paid on the FAKE provider by the customer’s finance person: the webhook comes twice, ONE payment is recorded and the deposit is paid; the buyer may not pay, a paid deposit takes no second payment', async () => {
    R.finance = await partnerOf('finance', 'customer', id('party:P1'), 'franca.golden@brand-p1.example')
    await invite(P.sales, R.finance, { displayName: 'Franca Golden', roleKey: 'customer-finance' })
    await signIn(R.finance)
    const items = await as(R.finance, 'GET', '/portal/payments/open-items')
    expect(items).toMatchObject({ mayPay: true, card: { available: true, provider: 'PAYMENT_FAKE', mode: 'FAKE' } })
    const deposit = (items.deposits as Json[]).find((entry) => entry.orderNumber === G.order.number)!
    expect(deposit).toMatchObject({ canPay: true })
    await as(R.buyer, 'POST', '/portal/payments/intents', { depositRequestId: deposit.depositRequestId, method: 'CARD' }, 403)
    const started = await as(R.finance, 'POST', '/portal/payments/intents', { depositRequestId: deposit.depositRequestId, method: 'CARD' }, 201)
    expect(started).toMatchObject({ intent: { status: 'WAITING', target: 'DEPOSIT_REQUEST' }, provider: { name: 'PAYMENT_FAKE', mode: 'FAKE' } })
    G.intent = started.intent.id
    keep(started.intent.id)
    // The provider's webhook arrives twice (two deliveries of the success) before the worker runs.
    for (let delivery = 0; delivery < 2; delivery++) {
      const hook = await anyone('POST', '/payment-fake/confirm', { clientSecret: started.provider.clientSecret, scenario: 'succeed' })
      expect(hook).toMatchObject({ state: 'succeeded', error: null })
    }
    await settle()
    const [intent] = await admin<Json>(w, `SELECT status::text AS status, "paymentId", "providerRef" FROM "PaymentIntent" WHERE id = $1`, [started.intent.id])
    expect(intent).toMatchObject({ status: 'SUCCEEDED', paymentId: expect.any(String) })
    expect(await admin(w, `SELECT count(*)::int AS n FROM "Payment" WHERE "externalRef" = $1`, [intent!.providerRef])).toEqual([{ n: 1 }])
    expect(await admin(w, `SELECT count(*)::int AS n FROM "InboundWebhook" WHERE "tenantId" = $1 AND provider = 'PAYMENT_FAKE' AND status::text = 'PROCESSED'`, [w.tenant.id])).toEqual([{ n: 2 }])
    expect(await admin(w, `SELECT status::text AS status FROM "DepositRequest" WHERE id = $1`, [deposit.depositRequestId])).toEqual([{ status: 'PAID' }])
    expect((await as(R.finance, 'GET', `/portal/payments/intents/${started.intent.id}`)).intent.status).toBe('SUCCEEDED')
    const again = await as(R.finance, 'POST', '/portal/payments/intents', { depositRequestId: deposit.depositRequestId, method: 'CARD' }, 409)
    expect(pathsOf(again)).toEqual(['payment/NOT_OPEN'])
    keep(intent!.paymentId)
  })

  it('C05 the documents: the inspector issues the jacket’s declaration of conformity and user information, the warehouse puts them on SEED-SH-0001; the buyer reads the DoC of what it received with the certificate valid on the shipping date, and opens it', async () => {
    const style = id('production:style:JKT-02')
    const receivedOf = async () => ((await as(R.buyer, 'GET', '/portal/customer-documents/conformity')).styles as Json[]).find((entry) => entry.style.code === 'SEED-JKT-02')!
    const before = await receivedOf()
    expect(before).toMatchObject({ ppe: true, certificateRequired: true })
    expect((before.received as Json[]).find((row) => row.shipment.number === 'SEED-SH-0001')).toMatchObject({ declaration: null })
    for (const [kind, name] of [
      ['DECLARATION_OF_CONFORMITY', 'doc-jkt-02.pdf'],
      ['USER_INFORMATION', 'info-jkt-02.pdf'],
    ] as const) {
      const body = pdf(`${kind} SEED-JKT-02 (made up)`)
      const announced = await ok(P.inspector, 'POST', `/product/styles/${style}/compliance/documents`, { revisionId: fours('production:revision:JKT-02:1'), kind, language: 'it', ...announce(name, body) }, 201)
      await putBytes(w, announced, body)
      const issued = await ok(P.inspector, 'POST', `/product/styles/${style}/compliance/documents/${announced.document.id}/files/${announced.file.id}/complete`)
      expect(issued.document.status).toBe('ISSUED')
      keep(announced.document.id)
    }
    await ok(P.warehouse, 'POST', `/shipping/shipments/${id('shipping:shipment:SH-0001')}/documents/attach`, {})
    await settle()
    const row = ((await receivedOf()).received as Json[]).find((entry) => entry.shipment.number === 'SEED-SH-0001')!
    expect(row).toMatchObject({ order: { number: 'SEED-SO-0002' }, state: 'COMPLETE', declaration: { kind: 'DECLARATION_OF_CONFORMITY' }, certificate: { validOnShippingDate: true } })
    const library = await as(R.buyer, 'GET', '/portal/customer-documents')
    const doc = (library.items as Json[]).find((item) => item.kind === 'DECLARATION_OF_CONFORMITY')!
    G.docFile = doc.files[0].fileId
    const opened = await as(R.buyer, 'POST', `/portal/customer-documents/${G.docFile}/download`, { mode: 'preview' })
    expect(opened).toMatchObject({ document: { kind: 'DECLARATION_OF_CONFORMITY' }, download: { url: expect.any(String) } })
  })

  it('C06 a return: the buyer asks to return a delivered jacket (too many refused); the sales office authorises it; the buyer is told to send it back', async () => {
    const offer = await as(R.buyer, 'GET', '/portal/returns/returnable')
    const item = (offer.items as Json[]).find((entry) => entry.canReturn > 0)!
    const reason = (offer.reasons as Json[])[0]!
    const line = { invoiceLineId: item.invoiceLineId, salesOrderLineId: item.salesOrderLineId, size: item.size, reasonCode: reason.code, reasonNote: 'Seam opened at the shoulder.' }
    const tooMany = await as(R.buyer, 'POST', '/portal/returns', { lines: [{ ...line, quantity: 999 }], outcomeWanted: 'REPAIR', customerRef: 'CL-GOLDEN-1' }, 409)
    expect(pathsOf(tooMany)).toContain('body/lines/0/quantity')
    const asked = await as(R.buyer, 'POST', '/portal/returns', { lines: [{ ...line, quantity: 1 }], outcomeWanted: 'REPAIR', customerRef: 'CL-GOLDEN-1', note: 'Please repair it.' }, 201)
    expect(asked.return).toMatchObject({ status: 'REQUESTED' })
    G.return = asked.return
    keep(G.return.id)
    await settle()
    const office = (await ok(P.sales, 'GET', `/sales/returns/${G.return.id}`)).return
    const authorised = await ok(P.sales, 'POST', `/sales/returns/${G.return.id}/authorise`, { version: office.version })
    expect(authorised.return).toMatchObject({ status: 'AUTHORISED', channel: 'PORTAL', outcomeWanted: 'REPAIR' })
    await ok(P.sales, 'POST', `/sales/returns/${G.return.id}/authorise`, { version: authorised.return.version }, 409)
    await settle()
    const theirs = await as(R.buyer, 'GET', `/portal/returns/${G.return.id}`)
    expect(theirs.return).toMatchObject({ state: 'SEND_IT_BACK' })
  })

  it('C07 a complaint: the buyer reports a problem (a new one cannot be answered before triage); the inspector publishes SEED-CMP-0001’s answer to the portal, and the customer’s quality person reads it there', async () => {
    R.quality = await partnerOf('quality', 'customer', id('party:P1'), 'qualita.golden@brand-p1.example')
    await invite(P.sales, R.quality, { displayName: 'Quinta Golden', roleKey: 'customer-quality' })
    await signIn(R.quality)
    const size = (G.so2Line.sizes as Json[])[0]?.size ?? null
    const reported = await as(R.buyer, 'POST', '/portal/complaints', { description: 'The zip of one jacket sticks.', salesOrderLineId: G.so2Line.id, size, customerRef: 'CMP-GOLDEN-1' }, 201)
    expect(reported.complaint).toMatchObject({ status: 'NEW', request: { via: 'PORTAL' } })
    G.complaint = reported.complaint.id
    keep(reported.complaint.id)
    await settle()
    const fresh = (await ok(P.inspector, 'GET', `/quality/complaints/${reported.complaint.id}`)).complaint
    const early = await ok(P.inspector, 'POST', `/quality/complaints/${reported.complaint.id}/answer/publish`, { version: fresh.version }, 409)
    expect(pathsOf(early)).toEqual(['held/NOT_TRIAGED'])
    const seeded = (await ok(P.inspector, 'GET', `/quality/complaints/${id('returns:CMP-0001')}`)).complaint
    const published = await ok(P.inspector, 'POST', `/quality/complaints/${id('returns:CMP-0001')}/answer/publish`, { version: seeded.version })
    expect(published.complaint.status).toBe('ANSWERED')
    await settle()
    const read = await as(R.quality, 'GET', `/portal/complaints/${id('returns:CMP-0001')}`)
    expect(read.complaint ?? read).toMatchObject({ state: 'ANSWERED', investigation: { answeredVia: 'PORTAL' } })
    await as(R.buyer, 'GET', '/portal/complaints', undefined, 403)
  })

  // ---- T: the tannery ---------------------------------------------------------------------------------------------------------

  it('T01 the buyer sends P2 a purchase order (black leather, grade A, one dye batch, 5 % tolerance; 24 protectors) and keeps a level-1 protector of P2 ready as a substitute', async () => {
    const material = (await ok(P.buyer, 'POST', '/product/materials', { code: 'PR-L1-GF', name: 'Paraspalla livello 1 (golden)', kind: 'PROTECTOR', baseUom: 'PCS' }, 201)).material
    await ok(P.buyer, 'POST', '/purchasing/supplier-items', { companyId: companyA(), partyId: id('party:P2'), itemId: material.id, supplierArticleCode: 'P2-PRO-L1', purchaseUom: 'PCS', unitPrice: '5.5' }, 201)
    G.substitute = material
    keep(material.id)
    let order = (await ok(P.buyer, 'POST', '/purchasing/orders', { companyId: companyA(), siteId: siteA1(), partyId: id('party:P2'), incoterms: 'EXW Golden' }, 201)).order
    order = (
      await ok(P.buyer, 'POST', `/purchasing/orders/${order.id}/lines`, { version: order.version, itemId: id('product:item:leather'), itemColourId: id('product:item-colour:leather:BLK'), quantity: '105', uom: 'FT2', needDate: addDays(today(), 30), grade: 'A', oneDyeBatch: true, areaTolerancePct: '5' }, 201)
    ).order
    order = (await ok(P.buyer, 'POST', `/purchasing/orders/${order.id}/lines`, { version: order.version, itemId: id('product:item:protector'), quantity: '24', needDate: addDays(today(), 35) }, 201)).order
    const sent = await ok(P.buyer, 'POST', `/purchasing/orders/${order.id}/send`, { version: order.version })
    expect(sent).toMatchObject({ order: { status: 'SENT' }, delivery: 'sent' })
    G.po = sent.order
    keep(G.po.id)
    await settle()
  })

  it('T02 the tannery reads the order without a price (and its copy without prices), confirms the leather as asked and offers the level-1 protector instead of line 20', async () => {
    const list = await as(R.tannery, 'GET', '/portal/purchase-orders')
    expect(list.items).toContainEqual(expect.objectContaining({ id: G.po.id, state: 'TO_CONFIRM', canAnswer: true }))
    const page = await as(R.tannery, 'GET', `/portal/purchase-orders/${G.po.id}`)
    expect(page.order).toMatchObject({ status: 'SENT', state: 'TO_CONFIRM', revision: 1 })
    const [leather, protector] = [...(page.lines as Json[])].sort((a, b) => a.seq - b.seq)
    expect(page.answer.substitutes[protector!.id]).toEqual([expect.objectContaining({ itemId: G.substitute.id, code: 'P2-PRO-L1' })])
    const copy = await call(R.tannery.browser, 'GET', `/portal/purchase-orders/${G.po.id}/copy`)
    expect(copy.status).toBe(200)
    expect(String(copy.response.headers['content-disposition'])).toMatch(/without prices/i)
    const answered = await as(R.tannery, 'POST', `/portal/purchase-orders/${G.po.id}/confirm`, {
      version: page.order.version,
      mode: 'BY_LINE',
      supplierRef: 'OC-GOLDEN-77',
      lines: [
        { lineId: leather!.id, answer: 'AS_ASKED' },
        { lineId: protector!.id, answer: 'SUBSTITUTE', substituteItemId: G.substitute.id, substituteNote: 'Level 1, same size', reason: 'Level 2 sold out' },
      ],
    })
    expect(answered).toMatchObject({ outcome: 'PROPOSED', order: { status: 'CHANGES_PROPOSED' } })
    const lines = [...(answered.lines as Json[])].sort((a, b) => a.seq - b.seq)
    expect(lines[0]).toMatchObject({ locked: true, proposal: { kind: 'AS_ASKED', needsBuyer: false } })
    expect(lines[1]).toMatchObject({ proposal: { kind: 'SUBSTITUTE', needsBuyer: true, substitute: expect.objectContaining({ itemId: G.substitute.id }) } })
    G.poLines = { leather: leather!.id, protector: protector!.id }
    await settle()
  })

  it('T03 the buyer takes the substitute: accepting the proposal as it stands is refused in words; a revised order (the line 20 cancelled, the substitute added) goes out and the tannery confirms it', async () => {
    const panel = await ok(P.buyer, 'GET', `/purchasing/orders/${G.po.id}/answer`)
    expect(panel.proposal).toMatchObject({ via: 'PORTAL' })
    let order = (await ok(P.buyer, 'GET', `/purchasing/orders/${G.po.id}`)).order
    const accept = await ok(P.buyer, 'POST', `/purchasing/orders/${G.po.id}/proposal/accept`, { version: order.version }, 409)
    expect(accept.error.message).toMatch(/offers another article instead/)
    order = (await ok(P.buyer, 'POST', `/purchasing/orders/${G.po.id}/proposal/counter`, { version: order.version, note: 'We take your level-1 protector.' })).order
    expect(order.status).toBe('DRAFT')
    order = (await ok(P.buyer, 'POST', `/purchasing/orders/${G.po.id}/lines/cancel`, { version: order.version, lineIds: [G.poLines.protector], reason: 'Substitute taken' })).order
    order = (await ok(P.buyer, 'POST', `/purchasing/orders/${G.po.id}/lines`, { version: order.version, itemId: G.substitute.id, quantity: '24', needDate: addDays(today(), 35) }, 201)).order
    const sent = await ok(P.buyer, 'POST', `/purchasing/orders/${G.po.id}/send`, { version: order.version, changeNote: 'Your level-1 protector instead of line 20' })
    expect(sent.order).toMatchObject({ status: 'SENT' })
    await settle()
    const page = await as(R.tannery, 'GET', `/portal/purchase-orders/${G.po.id}`)
    expect(page.order).toMatchObject({ revision: 2, state: 'TO_CONFIRM' })
    const confirmed = await as(R.tannery, 'POST', `/portal/purchase-orders/${G.po.id}/confirm`, { version: page.order.version, mode: 'ALL_AS_ASKED' })
    expect(confirmed).toMatchObject({ outcome: 'CONFIRMED', order: { status: 'CONFIRMED' } })
    expect(await admin(w, `SELECT "confirmedVia"::text AS via, "confirmLinkId" FROM "PurchaseOrder" WHERE id = $1`, [G.po.id])).toEqual([{ via: 'PORTAL', confirmLinkId: null }])
    await settle()
  })

  it('T04 the tannery announces the delivery: lines and dye batch, the packing list checked hide by hide against the order (a grade B hide is not as ordered), sent only with a note, numbered from the ASN series', async () => {
    const shippable = await as(R.tannery, 'GET', `/portal/ship-notices/shippable?purchaseOrderId=${G.po.id}`)
    const lines = (shippable.orders as Json[]).find((entry) => entry.id === G.po.id)!.lines as Json[]
    const leather = lines.find((line) => line.item.leather)!
    const protector = lines.find((line) => !line.item.leather)!
    expect(leather).toMatchObject({ uom: 'FT2', open: '105.0000', grade: 'A', oneDyeBatch: true, tolerancePct: '5' })
    const draft = await as(
      R.tannery,
      'POST',
      '/portal/ship-notices',
      {
        purchaseOrderId: G.po.id,
        lines: [
          { purchaseOrderLineId: leather.purchaseOrderLineId, quantity: '105', dyeBatch: '2231', supplierLot: 'L-GOLD-77' },
          { purchaseOrderLineId: protector.purchaseOrderLineId, quantity: '24', supplierLot: 'PR-GOLD-12' },
        ],
        shipDate: addDays(today(), 1),
        expectedDate: addDays(today(), 3),
        carrier: 'Made-up Freight',
        trackingNumber: 'MF-GOLD-1',
        parcels: 2,
        ddtNumber: 'DDT-GOLD-45',
        ddtDate: addDays(today(), 1),
      },
      201,
    )
    let notice = draft.notice
    expect(notice).toMatchObject({ status: 'DRAFT', number: null })
    expect(notice.lines[0].reasons.map((reason: Json) => reason.code)).toContain('NO_PACKING_LIST')
    const rows = ['A', 'A', 'B', 'A', 'A'].map((grade, index) => ({ hideNumber: `2231-${String(index + 1).padStart(3, '0')}`, area: '21', unit: 'FT2', grade, thicknessMm: '1.2', dyeBatch: '2231' }))
    notice = (await as(R.tannery, 'PUT', `/portal/ship-notices/${notice.id}/packing-list`, { version: notice.version, rows })).notice
    const line = (notice.lines as Json[]).find((entry) => entry.hides.length > 0)!
    expect(line.hides[2]).toMatchObject({ hideNumber: '2231-003', verdict: 'NOT_AS_ORDERED', reasons: [expect.objectContaining({ code: 'GRADE' })] })
    expect(line.figures).toMatchObject({ hides: 5, area: '105', expected: '105' })
    expect(notice.verdict).toBe('NOT_AS_ORDERED')
    const held = await as(R.tannery, 'POST', `/portal/ship-notices/${notice.id}/send`, { version: notice.version }, 400)
    expect(pathsOf(held)).toContain('body/note')
    const sent = await as(R.tannery, 'POST', `/portal/ship-notices/${notice.id}/send`, { version: notice.version, note: 'Hide 2231-003 is grade B, as agreed by phone.' })
    expect(sent.notice).toMatchObject({ status: 'SENT', state: 'ANNOUNCED', number: expect.stringMatching(/^ASN-\d{4}-\d{4}$/) })
    G.notice = sent.notice
    keep(G.notice.id)
    await settle()
  })

  it('T05 the dock reads the receipt prefilled from the notice (each hide’s declared area) and receives it: the notice is RECEIVED in the receipt’s own command; a second receipt refused', async () => {
    const read = await ok(P.warehouse, 'GET', `/inventory/receiving/ship-notices/${G.notice.id}`)
    expect(read).toMatchObject({ canReceive: true, notice: { supplier: { id: id('party:P2') } }, prefill: { purchaseOrderId: G.po.id, shipNoticeId: G.notice.id, supplierDdtNumber: 'DDT-GOLD-45' } })
    const leather = (read.prefill.lines as Json[]).find((entry) => entry.lots[0]?.hides.length > 0)!
    expect(leather.lots[0]).toMatchObject({ supplierLotRef: 'L-GOLD-77', dyeBatch: '2231' })
    expect(leather.lots[0].hides).toHaveLength(5)
    expect(leather.lots[0].hides[2]).toMatchObject({ supplierCode: '2231-003', area: '21.0000', areaUom: 'FT2', grade: 'B' })
    const lines = (read.prefill.lines as Json[]).map((entry) => ({
      purchaseOrderLineId: entry.purchaseOrderLineId,
      ...(entry.quantity ? { quantity: entry.quantity } : {}),
      lots: (entry.lots as Json[]).map((lot) => ({
        ...(lot.supplierLotRef ? { supplierLotRef: lot.supplierLotRef } : {}),
        ...(lot.dyeBatch ? { dyeBatch: lot.dyeBatch } : {}),
        ...(lot.quantity ? { quantity: lot.quantity } : {}),
        ...(lot.hides.length > 0 ? { hides: (lot.hides as Json[]).map((hide) => ({ supplierCode: hide.supplierCode, area: hide.area, areaUom: hide.areaUom, ...(hide.grade ? { grade: hide.grade } : {}), ...(hide.thicknessMm ? { thicknessMm: hide.thicknessMm } : {}) })) } : {}),
      })),
    }))
    const received = await ok(P.warehouse, 'POST', '/inventory/receipts', { purchaseOrderId: G.po.id, shipNoticeId: G.notice.id, supplierDdtNumber: read.prefill.supplierDdtNumber, supplierDdtDate: read.prefill.supplierDdtDate, lines }, 201)
    expect(received.receipt.status).toBe('POSTED')
    keep(received.receipt.id)
    expect(await admin(w, `SELECT status::text AS status FROM "ShipNotice" WHERE id = $1`, [G.notice.id])).toEqual([{ status: 'RECEIVED' }])
    const again = await ok(P.warehouse, 'POST', '/inventory/receipts', { purchaseOrderId: G.po.id, shipNoticeId: G.notice.id, lines: [lines[1]] }, 409)
    // The order is received in full by the notice: nothing more is taken against it.
    expect(again.error.message).toMatch(/received in full/)
    const page = await as(R.tannery, 'GET', `/portal/ship-notices/${G.notice.id}`)
    expect(page.notice.status).toBe('RECEIVED')
    await settle()
  })

  it('T06 the tannery sends its test report for the order through the portal (scanned by the FAKE scanner), the buyer accepts it; with the scanner off a live portal refuses the upload in words', async () => {
    const body = pdf('Cr VI test report TR-GOLD-1')
    const meta = { category: 'TEST_REPORT', recordType: 'PurchaseOrder', recordId: G.po.id, issuer: 'Test Lab One (made up)', number: 'TR-GOLD-1', issuedOn: today(), originalName: 'cr6-gold.pdf', contentType: 'application/pdf', sizeBytes: body.length, sha256: (announce('x', body) as Json).sha256 }
    // REFUSAL: on a live portal with no scanner running, nothing from outside is taken (FV1:02; GATE-SPEND). FACTORY_ENV is read per
    // call: the step says "staging" for this one request and puts it back.
    useScanner(null)
    const before = process.env.FACTORY_ENV
    process.env.FACTORY_ENV = 'staging'
    try {
      const closed = await as(R.tannery, 'POST', '/portal/supplier-documents', meta, 503)
      expect(closed.error.message).toBe('Uploads from outside are closed for now: the virus scanner is not running here yet. Please send the file to your contact by e-mail.')
    } finally {
      if (before === undefined) delete process.env.FACTORY_ENV
      else process.env.FACTORY_ENV = before
      useScanner(fakeScanner())
    }
    const announced = await as(R.tannery, 'POST', '/portal/supplier-documents', meta, 201)
    expect(announced.file.status).toBe('PENDING_UPLOAD')
    await putBytes(w, announced, body)
    const completed = await as(R.tannery, 'POST', `/portal/supplier-documents/${announced.file.id}/complete`)
    expect(completed).toMatchObject({ file: { status: 'AVAILABLE' }, state: 'WAITING' })
    G.testReport = announced.file.id
    keep(G.testReport)
    const rows = (await ok(P.buyer, 'GET', `/purchasing/supplier-documents?partyId=${id('party:P2')}`)).rows as Json[]
    const row = rows.find((entry) => entry.fileId === G.testReport)!
    expect(row).toMatchObject({ state: 'WAITING', mayDecide: true })
    const accepted = await ok(P.buyer, 'POST', `/purchasing/supplier-documents/${G.testReport}/accept`, { category: 'TEST_REPORT', expiresOn: null, version: row.version })
    expect(accepted.state).toBe('ACCEPTED')
    await settle()
  })

  it('T07 the questionnaire by link: the buyer sends it (the inspector may not), the tannery answers it (missing answers refused at their fields), the buyer accepts the answers', async () => {
    const email = 'onboarding.golden@tannery-p2.example'
    await ok(P.inspector, 'POST', `/purchasing/suppliers/${id('party:P2')}/questionnaire-link`, { send: true, email, language: 'en' }, 403)
    const sent = await ok(P.buyer, 'POST', `/purchasing/suppliers/${id('party:P2')}/questionnaire-link`, { send: true, email, language: 'en' }, 201)
    expect(sent).toMatchObject({ url: null, delivery: 'SENT' })
    const token = tokenOf('purchasing.questionnaire_link', email)
    const page = await viaLink(token, 'GET', '/link/supplier-questionnaire?language=en')
    G.questionnaire = page.questionnaire
    const answers = {
      'company.legal-name': { value: 'Seed Tannery Two S.r.l.' },
      'company.vat': { value: 'IT00000002022' },
      'contacts.quality': { value: { name: 'Carla Example', email: 'quality.golden@tannery-p2.example', phone: '+39 000 0000077' } },
      'certs.cr6-testing': { value: 'Every lot, by an outside lab (made up).' },
      'labour.forced-labour': { value: 'YES' },
      'labour.code-of-conduct': { value: 'SIGNED' },
    }
    const missing = await viaLink(token, 'POST', '/link/supplier-questionnaire?language=en', { questionnaireId: page.questionnaire.id, answers, sites: [], subTierSites: [], signedName: 'Carla Example', signedRole: 'Quality manager' }, 400)
    expect(pathsOf(missing)).toEqual(['body/truthful'])
    const answered = await viaLink(token, 'POST', '/link/supplier-questionnaire?language=en', {
      questionnaireId: page.questionnaire.id,
      answers,
      sites: [{ name: 'Golden tannery (made up)', country: 'IT', town: 'Seedville', steps: ['RETANNING', 'FINISHING'] }],
      subTierSites: [],
      signedName: 'Carla Example',
      signedRole: 'Quality manager',
      truthful: true,
    })
    expect(answered.sent).toMatchObject({ id: expect.any(String) })
    // One use: the link opens nothing any more.
    await viaLink(token, 'GET', '/link/supplier-questionnaire', undefined, 404)
    const office = await ok(P.buyer, 'GET', `/purchasing/suppliers/${id('party:P2')}/questionnaire`)
    const response = (office.answers as Json[]).find((entry) => entry.id === answered.sent.id)!
    expect(response).toMatchObject({ state: 'WAITING', via: 'LINK' })
    const reviewed = await ok(P.buyer, 'POST', `/purchasing/questionnaire-answers/${response.id}/review`, { decision: 'ACCEPTED', version: response.version })
    expect(reviewed.state).toBe('ACCEPTED')
    keep(response.id)
    await settle()
  })

  // ---- W: the workshop --------------------------------------------------------------------------------------------------------

  it('W01 the buyer gives the sewing of SEED-WO-0001 to P2 with the lining kit and mails the job link; the workshop reads it (no price) and accepts it by link; the used link opens nothing', async () => {
    const seeded = (await ok(P.buyer, 'GET', `/purchasing/subcontracting/orders/${id('subcontract:SC-0001')}`)).order
    await ok(P.buyer, 'POST', `/purchasing/subcontracting/orders/${seeded.id}/cancel`, { version: seeded.version, reason: 'Given to the workshop again from today’s plan' })
    const back = addDays(today(), 10)
    // B-W2b-365: an order made by hand goes to a workshop approved for the work: the buyer approves P2's pending sewing
    // qualification (seed/suppliers-depth.ts), resting on P2's accepted document (seed/portal-followups.ts).
    const P2 = id('party:P2')
    const pending = ((await ok(P.buyer, 'GET', `/purchasing/suppliers/${P2}/qualifications`)).qualifications as Json[]).find((row) => row.status === 'PENDING' && row.scope.workCentreKinds.includes('SEWING'))!
    const evidenced = ((await ok(P.buyer, 'PATCH', `/purchasing/suppliers/${P2}/qualifications/${pending.id}`, { version: pending.version, evidence: [{ recordType: 'SupplierDocumentUpload', recordId: id('portal-followups:upload:P2:certificate') }] })).qualifications as Json[]).find((row) => row.id === pending.id)!
    await ok(P.buyer, 'POST', `/purchasing/suppliers/${P2}/qualifications/${pending.id}/decide`, { version: evidenced.version, decision: 'APPROVED' })
    let order = (
      await ok(P.buyer, 'POST', '/purchasing/subcontracting/orders', { workOrderId: id('production:work-order:WO-0001'), partyId: P2, expectedBackDate: back, operations: [{ workOrderOperationId: id('production:WO-0001:operation:20'), pricePerPiece: '4.50', expectedBackDate: back }] }, 201)
    ).order
    order = (await ok(P.buyer, 'POST', `/purchasing/subcontracting/orders/${order.id}/kit`, { version: order.version, lines: [{ itemId: id('product:item:lining'), itemColourId: id('product:item-colour:lining:GRY'), lotId: id('inventory:lot:LIN-01'), quantity: '12.6', uom: 'M' }] }, 201)).order
    // REFUSAL: a job link before the order is sent.
    const early = await ok(P.buyer, 'POST', `/purchasing/subcontracting/orders/${order.id}/job-link`, { email: 'lab.golden@workshop-p2.example', send: true, language: 'en' }, 409)
    expect(early.error.message).toMatch(/Send the order to the workshop first/)
    order = (await ok(P.buyer, 'POST', `/purchasing/subcontracting/orders/${order.id}/issue`, { version: order.version })).order
    expect(order.status).toBe('ISSUED')
    G.job = order
    keep(order.id)
    await settle()
    expect(await ok(P.buyer, 'POST', `/purchasing/subcontracting/orders/${order.id}/job-link`, { email: 'lab.golden@workshop-p2.example', send: true, language: 'en' }, 201)).toMatchObject({ url: null, delivery: 'SENT' })
    const token = tokenOf('purchasing.job_link', 'lab.golden@workshop-p2.example')
    const page = await viaLink(token, 'GET', '/link/job?language=en')
    expect(page.job).toMatchObject({ number: order.number, state: 'TO_ANSWER' })
    const accepted = await viaLink(token, 'POST', '/link/job/accept?language=en', { version: page.job.version, typedName: 'Rosa Golden' })
    expect(accepted.done).toMatch(/^Accepted/)
    await viaLink(token, 'GET', '/link/job', undefined, 404)
    await settle()
  })

  it('W02 the warehouse sends the kit; the workshop sees its job in the portal (no price), confirms the kit and reports the 7 pieces finished (more than the pieces refused)', async () => {
    let order = (await ok(P.warehouse, 'GET', `/purchasing/subcontracting/orders/${G.job.id}`)).order
    const lining = (order.kitLines as Json[]).find((line) => line.status === 'PLANNED')!
    order = (
      await ok(
        P.warehouse,
        'POST',
        `/purchasing/subcontracting/orders/${G.job.id}/kit/send`,
        { version: order.version, lines: [{ lineId: lining.id, fromLocationId: id('inventory:location:A1-STORE-01'), lotId: id('inventory:lot:LIN-01') }], bundles: [], pieces: [{ operationId: order.operations[0].id, pieces: 7 }], ddt: null },
        201,
      )
    ).order
    expect(order.status).toBe('AT_WORKSHOP')
    await settle()
    const list = await as(R.workshop, 'GET', '/portal/jobs')
    expect(list.items.map((item: Json) => item.number)).toContain(G.job.number)
    let record = await as(R.workshop, 'GET', `/portal/jobs/${G.job.id}`)
    expect(record.mayAct).toEqual({ approve: true, comment: true, upload: true })
    expect(record.job.kit.toConfirm).toBe(1)
    record = await as(R.workshop, 'POST', `/portal/jobs/${G.job.id}/kit`, { version: record.job.version, all: true })
    expect(record.done).toEqual(expect.any(String))
    const operation = record.job.operations[0]
    const over = await as(R.workshop, 'POST', `/portal/jobs/${G.job.id}/progress`, { version: record.job.version, entries: [{ operationId: operation.id, finished: 8 }] }, 400)
    expect(pathsOf(over)).toEqual(['body/entries/0/finished'])
    record = await as(R.workshop, 'POST', `/portal/jobs/${G.job.id}/progress`, { version: record.job.version, entries: [{ operationId: operation.id, finished: 7 }], note: 'All seven sewn.' })
    expect(record.done).toContain('7 finished')
    await settle()
  })

  it('W03 the workshop announces the send-back with its DDT: it prefills the receive back and moves nothing; the warehouse receives from it; the same notice twice refused', async () => {
    let record = await as(R.workshop, 'GET', `/portal/jobs/${G.job.id}`)
    const operation = record.job.operations[0]
    const moves = (await admin<{ n: string }>(w, 'SELECT count(*)::text AS n FROM "StockMove" WHERE "tenantId" = $1', [w.tenant.id]))[0]!.n
    record = await as(R.workshop, 'POST', `/portal/jobs/${G.job.id}/returns`, { version: record.job.version, quantities: [{ operationId: operation.id, finished: 7 }], parcels: 1, expectedDate: addDays(today(), 3), ddt: { number: 'W-GOLD-77', date: today() } })
    expect(record.done).toMatch(/^We expect 7 piece\(s\) on /)
    expect((await admin<{ n: string }>(w, 'SELECT count(*)::text AS n FROM "StockMove" WHERE "tenantId" = $1', [w.tenant.id]))[0]!.n).toBe(moves)
    const noticeId = record.job.returns[0].id as string
    const view = await ok(P.warehouse, 'GET', `/purchasing/subcontracting/orders/${G.job.id}/workshop`)
    const prefill = (view.prefills as Json[]).find((entry) => entry.returnNoticeId === noticeId)!
    expect(prefill).toMatchObject({ supplierDdt: { number: 'W-GOLD-77', date: today() }, lines: [expect.objectContaining({ operationId: operation.id, good: 7 })] })
    const current = (await ok(P.warehouse, 'GET', `/purchasing/subcontracting/orders/${G.job.id}`)).order
    const lines = (prefill.lines as Json[]).map((line) => ({ operationId: line.operationId, ...(line.bundleId ? { bundleId: line.bundleId } : {}), good: line.good, defective: line.defective, scrapped: line.scrapped, reason: line.reason }))
    const received = await ok(P.warehouse, 'POST', `/purchasing/subcontracting/orders/${G.job.id}/receive`, { version: current.version, lines, supplierDdt: prefill.supplierDdt, returnNoticeId: noticeId }, 201)
    expect(['PARTLY_RECEIVED', 'RECEIVED']).toContain(received.order.status)
    expect(await admin(w, `SELECT status::text AS status FROM "SubcontractReturnNotice" WHERE id = $1`, [noticeId])).toEqual([{ status: 'RECEIVED' }])
    await ok(P.warehouse, 'POST', `/purchasing/subcontracting/orders/${G.job.id}/receive`, { version: received.order.version, lines, supplierDdt: prefill.supplierDdt, returnNoticeId: noticeId }, 409)
    await settle()
  })

  // ---- K: a concession approved by link ---------------------------------------------------------------------------------------

  it('K01 the inspector asks P1 by link to accept SEED-NCR-0002’s concession; the link shows what we ask; a refusal without words refused; approved by its typed name; the used link opens nothing', async () => {
    const concession = first('capa:concession:NCR-0002')
    const email = 'qa.golden@brand-p1.example'
    const made = await ok(P.inspector, 'POST', '/approvals-out', { kind: 'CONCESSION', recordType: 'NcrConcession', recordId: concession, email, question: 'Accept the sleeves with the shade difference?', send: true, language: 'en' }, 201)
    expect(made).toMatchObject({ delivery: 'SENT', request: { kind: 'CONCESSION', status: 'OPEN', party: { id: id('party:P1') } } })
    G.concession = made.request
    keep(made.request.id)
    // REFUSAL: one open request per concession.
    await ok(P.inspector, 'POST', '/approvals-out', { kind: 'CONCESSION', recordType: 'NcrConcession', recordId: concession, email, question: 'Again?', send: false }, 409)
    const token = tokenOf('approvals.request', email)
    const page = await viaLink(token, 'GET', '/link/approval?language=en')
    expect(page.request).toMatchObject({ kind: 'CONCESSION', status: 'OPEN' })
    expect(page.may).toMatchObject({ answer: true })
    const empty = await viaLink(token, 'POST', '/link/approval/refuse?language=en', { answer: '', typedName: 'Anna Rossi' }, 400)
    expect(pathsOf(empty)).toEqual(['body/answer'])
    const answered = await viaLink(token, 'POST', '/link/approval/approve?language=en', { decision: 'APPROVED', typedName: 'Anna Rossi' })
    expect(answered.request.decided).toMatch(/^Approved — signed by Anna Rossi at /)
    await viaLink(token, 'GET', '/link/approval', undefined, 404)
    const office = await ok(P.inspector, 'GET', `/approvals-out/${made.request.id}`)
    expect(office.request.answer).toMatchObject({ typedName: 'Anna Rossi', via: 'LINK' })
    expect(await admin(w, `SELECT status::text AS status FROM "NcrConcession" WHERE id = $1`, [concession])).toEqual([{ status: 'ACCEPTED' }])
    await settle()
  })

  // ---- L: every link page -----------------------------------------------------------------------------------------------------

  it('L01 the tracking link: the warehouse mails SEED-SH-0001’s page to the customer’s order contact (no money key on it); the public search finds the shipment by their PO and postcode, a miss answers nothing', async () => {
    const shipment = id('shipping:shipment:SH-0001')
    await ok(P.sales, 'POST', `/shipping/shipments/${shipment}/tracking-links`, { send: true }, 403)
    const made = await ok(P.warehouse, 'POST', `/shipping/shipments/${shipment}/tracking-links`, { send: true }, 201)
    expect(made.links).toEqual([expect.objectContaining({ email: 'buyer.p1@example.com', delivery: 'SENT' })])
    const token = tokenOf('shipping.tracking_link', 'buyer.p1@example.com')
    const page = await viaLink(token, 'GET', '/link/tracking')
    expect(page).toMatchObject({ shipment: { number: 'SEED-SH-0001', status: 'SHIPPED' }, order: { customerRef: 'SEED-PO-78', number: 'SEED-SO-0002' }, link: { via: expect.any(String) } })
    expect(JSON.stringify(page)).not.toMatch(/"(price|unitPrice|amount|total|netValue|freightCharge|freightCost|value)"/)
    const found = await anyone('POST', '/tracking/search', { tenant: w.tenant.slug, company: 'SCA', reference: ' seed-po-78 ', postcode: '000 00' })
    expect(found.shipments).toEqual([expect.objectContaining({ number: 'SEED-SH-0001', token: expect.any(String) })])
    const searched = await viaLink(found.shipments[0].token, 'GET', '/link/tracking')
    expect(searched).toMatchObject({ link: { via: 'SEARCH' }, papers: { shown: false, files: [] } })
    // REFUSAL in silence: a wrong postcode finds nothing, and says nothing more.
    expect(await anyone('POST', '/tracking/search', { tenant: w.tenant.slug, company: 'SCA', reference: 'SEED-PO-78', postcode: '99999' })).toEqual({ shipments: [] })
    await settle()
  })

  it('L02 measurements by link: the sales office sends it to the rider; the page shows the privacy notice first (nothing is taken before it is ticked), keeps a draft, then takes the measures once', async () => {
    const email = 'rider.golden@team-p1.example'
    const made = await ok(P.sales, 'POST', '/sales/measure-links', { profileId: id('measurement:P1:rider:JACKET:1'), companyId: companyA(), send: true, email, language: 'en', photos: 'OPTIONAL' }, 201)
    expect(made).toMatchObject({ link: { purpose: 'MEASUREMENTS' }, delivery: 'SENT' })
    keep(made.link.id)
    const token = tokenOf('sales.measure_link', email)
    const page = await viaLink(token, 'GET', '/link/measure?language=en')
    expect(page).toMatchObject({ garment: { code: 'JACKET' }, noticeRead: null })
    const body = { units: 'cm', basics: { height: '178', weight: '74', age: '34' }, values: { chest: '100', waist: '86', sleeve: '64,5' }, fit: { fit: 'SNUG', posture: 'Racing crouch.', asymmetry: '' }, photos: {}, noticeId: page.notice.id, typedName: 'Seed Team Rider' }
    const first = await viaLink(token, 'POST', '/link/measure', body, 409)
    expect(pathsOf(first)).toEqual(['refusal/NOTICE_FIRST'])
    expect(await viaLink(token, 'POST', '/link/measure/notice', { noticeId: page.notice.id })).toMatchObject({ noticeRead: { noticeId: page.notice.id } })
    const draft = await viaLink(token, 'PUT', '/link/draft', { data: { step: 'points', form: { units: 'cm', values: { chest: '101' } } } })
    expect(draft.draft.version).toBe(1)
    expect((await viaLink(token, 'GET', '/link/draft')).draft).toMatchObject({ data: { step: 'points', form: { values: { chest: '101' } } }, version: 1 })
    const sent = await viaLink(token, 'POST', '/link/measure', body, 201)
    expect(sent).toMatchObject({ sent: { profileId: expect.any(String), photos: 0 }, link: { usesLeft: 0 } })
    await viaLink(token, 'GET', '/link/measure', undefined, 404)
    keep(sent.sent.profileId)
    await settle()
  })

  it('L03 a secure file with a password and a receipt: the owner sends two files by link (a file with pay figures refused); locked until the password (a wrong one refused), downloaded, the receipt signed once and read in the office', async () => {
    const style = id('production:style:JKT-02')
    G.files = [] as string[]
    for (const name of ['golden-tech-pack.pdf', 'golden-size-chart.pdf', 'golden-care.pdf', 'golden-labels.pdf']) G.files.push(await upload(P.owner, { recordType: 'Style', recordId: style }, name))
    const base = { purpose: 'SECURE_FILE', companyId: companyA(), partyId: id('party:P1'), contactId: id('party-contact:P1:buyer'), password: 'made-up pass 7', send: true, language: 'en' }
    await ok(P.sales, 'POST', '/links/files', { ...base, fileIds: G.files.slice(0, 2) }, 403)
    const pay = await ok(P.owner, 'POST', '/links/files', { ...base, fileIds: [G.files[0], fours('pay:file:export:A:2026-11:data')] }, 409)
    expect(pathsOf(pay)).toEqual(['refusal/PAY_FIGURES', 'body/fileIds/1'])
    expect(pay.error.message).toMatch(/pay figures never go by link/)
    const made = await ok(P.owner, 'POST', '/links/files', { ...base, fileIds: G.files.slice(0, 2), note: 'golden' }, 201)
    expect(made).toMatchObject({ link: { purpose: 'SECURE_FILE', email: 'buyer.p1@example.com', password: { set: true } }, delivery: 'SENT' })
    expect(textOf(mailsOf('links.files', 'buyer.p1@example.com').at(-1)!.raw)).not.toContain('made-up pass 7')
    const token = tokenOf('links.files', 'buyer.p1@example.com')
    const locked = await viaLink(token, 'GET', '/link/files')
    expect(locked).toMatchObject({ count: 2, files: [], link: { password: { asked: true, unlocked: false } } })
    const blocked = await viaLink(token, 'POST', `/link/files/${G.files[0]}/download`, {}, 403)
    expect(pathsOf(blocked)).toEqual(['password'])
    const wrong = await viaLink(token, 'POST', '/link/password', { password: 'nope' }, 400)
    expect(wrong.error.issues[0]).toMatchObject({ path: 'body/password', message: expect.stringMatching(/does not match/) })
    const { unlock } = await viaLink(token, 'POST', '/link/password', { password: 'made-up pass 7' })
    const unlocked = { 'x-factory-link-unlock': unlock }
    expect((await viaLink(token, 'GET', '/link/files', undefined, 200, unlocked)).files).toHaveLength(2)
    const download = await viaLink(token, 'POST', `/link/files/${G.files[0]}/download`, {}, 200, unlocked)
    expect(download).toMatchObject({ fileId: G.files[0], usesLeft: 4, download: { url: expect.any(String) } })
    await viaLink(token, 'POST', `/link/files/${G.files[2]}/download`, {}, 404, unlocked)
    expect((await viaLink(token, 'POST', '/link/files/received', { typedName: 'Giulia Golden' }, 200, unlocked)).receipt).toMatchObject({ name: 'Giulia Golden' })
    const twice = await viaLink(token, 'POST', '/link/files/received', { typedName: 'Giulia Golden' }, 409, unlocked)
    expect(pathsOf(twice)).toEqual(['refusal/RECEIVED'])
    const links = (await ok(P.owner, 'GET', `/links?recordType=StoredFile&recordId=${G.files[0]}`)).links as Json[]
    const link = links.find((entry) => entry.id === made.link.id)!
    expect(link.receipt).toMatchObject({ name: 'Giulia Golden' })
    expect((link.evidence as Json[]).map((entry) => entry.action)).toEqual(expect.arrayContaining(['DOWNLOADED', 'RECEIVED']))
    keep(made.link.id)
    await settle()
  })

  it('L04 a used-up link renewed: one download uses it up; it opens nothing; "Ask for a new link" answers the same words to anybody and mails the same address a new link with the same password', async () => {
    const made = await ok(P.owner, 'POST', '/links/files', { purpose: 'SECURE_FILE', companyId: companyA(), partyId: id('party:P1'), contactId: id('party-contact:P1:buyer'), fileIds: G.files.slice(2, 4), password: 'made-up pass 8', maxUses: 1, expiresInDays: 3, send: true, language: 'en' }, 201)
    const token = tokenOf('links.files', 'buyer.p1@example.com')
    const { unlock } = await viaLink(token, 'POST', '/link/password', { password: 'made-up pass 8' })
    expect(await viaLink(token, 'POST', `/link/files/${G.files[2]}/download`, {}, 200, { 'x-factory-link-unlock': unlock })).toMatchObject({ usesLeft: 0 })
    await viaLink(token, 'GET', '/link/files', undefined, 404)
    const asked = await viaLink(token, 'POST', '/link/renew', {}, 202)
    expect(asked).toMatchObject({ status: 'requested' })
    // Somebody with a made-up token gets the very same answer.
    expect(await viaLink('pl0.nothing', 'POST', '/link/renew', {}, 202)).toEqual(asked)
    await w.h.auth.settled()
    expect(await admin(w, `SELECT count(*)::int AS n FROM "OneOffLink" WHERE "renewalOfId" = $1`, [made.link.id])).toEqual([{ n: 1 }])
    expect(mailsOf('links.files_renewed', 'buyer.p1@example.com')).toHaveLength(1)
    keep(made.link.id)
    await settle()
  })

  it('L05 the public DoC by code: the batch label’s code opens the jacket’s declaration (issued at C05) for anybody, in any case and with no money; an unknown code refused in words', async () => {
    const code = publicDocCodeOf(id('production:work-order:WO-0001'))
    const page = (await anyone('POST', '/public/doc/lookup', { code: code.toLowerCase() })).page
    expect(page).toMatchObject({ kind: 'BATCH', product: { style: { code: 'SEED-JKT-02' }, batch: { number: 'SEED-BT-0001' } }, declaration: { standing: 'CURRENT' } })
    expect(JSON.stringify(page)).not.toMatch(/price|cost|amount|wage|actorId|createdById|releasedById/i)
    const file = page.declaration.files[0]
    const served = await w.h.app.inject({ method: 'GET', url: `/public/doc/${code}/files/${file.fileId}`, remoteAddress: '198.51.100.7' })
    expect(served.statusCode).toBe(200)
    expect(served.headers['content-type']).toMatch(/application\/pdf/)
    const unknown = await anyone('POST', '/public/doc/lookup', { code: 'ZZZZ-ZZZZ' }, 404)
    expect(unknown.error.message).toBe('We could not find this code. Check it on the label.')
    await settle()
  })

  it('L06 a record shared with comment rights: the sales office invites the brand’s designer to SEED-SO-0001; the designer reads it and comments by link; the office reads the comment; narrowed to view only, the next comment refused', async () => {
    const order = id('sales:SO1')
    const email = 'designer.golden@studio-p1.example'
    const shared = await ok(P.sales, 'POST', '/shares', { recordType: 'SalesOrder', recordId: order, email, permissions: ['COMMENT'], expiresAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), note: 'Please check the collar.', send: true, language: 'en' }, 201)
    expect(shared.share).toMatchObject({ email, permissions: ['VIEW', 'COMMENT'], state: 'LIVE' })
    keep(shared.share.id)
    const twice = await ok(P.sales, 'POST', '/shares', { recordType: 'SalesOrder', recordId: order, email, permissions: ['COMMENT'], send: false }, 409)
    expect(pathsOf(twice)).toEqual(['refusal/ALREADY_INVITED'])
    const token = tokenOf('shares.invite', email)
    const page = await viaLink(token, 'GET', '/link/share?language=en')
    expect(page).toMatchObject({ record: { type: 'SalesOrder' }, thread: { canPost: true }, upload: { canUpload: false } })
    const posted = await viaLink(token, 'POST', '/link/share/messages', { body: 'The collar looks right to me.' }, 201)
    expect(posted.message).toMatchObject({ side: 'PARTNER' })
    const thread = await ok(P.sales, 'GET', `/threads/SalesOrder/${order}`)
    expect(JSON.stringify(thread)).toContain('The collar looks right to me.')
    const narrowed = await ok(P.sales, 'PUT', `/shares/${shared.share.id}/permissions`, { permissions: ['VIEW'], version: shared.share.version })
    expect(narrowed.share.permissions).toEqual(['VIEW'])
    const refused = await viaLink(token, 'POST', '/link/share/messages', { body: 'One more thing.' }, 403)
    expect(pathsOf(refused)).toEqual(['held/NO_COMMENT'])
    await settle()
  })

  it('L07 the accountant’s time-boxed access: finance invites the payroll studio’s accountant; she signs in by code and reads the shared month’s exports and downloads one; a month not shared refused', async () => {
    R.accountant = await partnerOf('accountant', 'guest', id('party:CONSULTANT'), 'anna.golden@studio-prova.example')
    await ok(P.sales, 'POST', '/accounting/accountants', { companyId: companyA(), partyId: id('party:CONSULTANT'), email: R.accountant.email, displayName: 'Anna Golden', locale: 'it', accessUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() }, 403)
    await stepped(w, P.finance)
    const invited = await ok(P.finance, 'POST', '/accounting/accountants', { companyId: companyA(), partyId: id('party:CONSULTANT'), email: R.accountant.email, displayName: 'Anna Golden', locale: 'it', accessUntil: new Date(Date.now() + 30 * 86_400_000).toISOString() }, 201)
    expect(invited).toMatchObject({ delivery: 'sent', invitation: { email: R.accountant.email } })
    await signIn(R.accountant)
    expect(await as(R.accountant, 'GET', '/portal/access')).toMatchObject({ kind: 'GUEST', role: { key: 'guest-accountant' } })
    const room = await as(R.accountant, 'GET', '/portal/accounting')
    expect(room.months).toContainEqual(expect.objectContaining({ month: '2026-09' }))
    const period = await as(R.accountant, 'GET', '/portal/accounting/periods/2026-09')
    const file = (period.exports as Json[])[0]!.files[0].file
    const download = await as(R.accountant, 'POST', `/portal/accounting/files/${file.id}/download`, { period: '2026-09' })
    expect(download).toMatchObject({ file: { id: file.id }, download: { url: expect.any(String) } })
    const october = await as(R.accountant, 'GET', '/portal/accounting/periods/2026-10', undefined, 409)
    expect(pathsOf(october)).toEqual(['problem/PERIOD_NOT_SHARED'])
    await settle()
  })

  // ---- X: the partner wall ----------------------------------------------------------------------------------------------------

  it('X01 a second customer, a second tannery and a second workshop online: P3’s admin (every customer right); a new supplier and workshop party made by the buyer, with a desk and a workshop person; each signs in by code', async () => {
    R.otherBuyer = await partnerOf('otherBuyer', 'customer', id('party:P3'), 'kai.golden@kunde-p3.example')
    await openPortal(P.sales, id('party:P3'))
    // Its admin holds every customer right: each customer route answers for the record, never for a missing right.
    await invite(P.sales, R.otherBuyer, { displayName: 'Kai Golden', roleKey: 'customer-admin' })
    const party = (await ok(P.buyer, 'POST', '/parties', { companyId: companyA(), code: 'GF-TAN-2', legalName: 'Conceria Golden Due S.r.l. (made up)', roles: ['SUPPLIER', 'SUBCONTRACTOR'] }, 201)).party
    keep(party.id)
    R.otherTannery = await partnerOf('otherTannery', 'supplier', party.id, 'desk.golden@conceria-due.example')
    R.otherWorkshop = await partnerOf('otherWorkshop', 'workshop', party.id, 'lab.golden@conceria-due.example')
    await openPortal(P.buyer, party.id)
    await invite(P.buyer, R.otherTannery, { displayName: 'Dario Due', kind: 'SUPPLIER', roleKey: 'supplier-orders' })
    await invite(P.buyer, R.otherWorkshop, { displayName: 'Lia Due', kind: 'SUBCONTRACTOR', roleKey: 'subcontractor-jobs' })
    for (const partner of [R.otherBuyer, R.otherTannery, R.otherWorkshop]) await signIn(partner)
    await settle()
  })

  it('X02 the partner wall: each reads the other party’s records on every route it can call and finds nothing (404), its lists hold none of them; a partner of another kind is refused the route (403); office and portal cookies are strangers to each other (401)', async () => {
    const so2 = id('production:sales-order:SO-0002')
    // A customer of another party.
    for (const url of [
      `/portal/sales-orders/${so2}`,
      `/portal/sales-orders/${so2}/shipments`,
      `/portal/sales-orders/${G.order.id}`,
      `/portal/sales-orders/${G.order.id}/change-requests/rules`,
      `/portal/reorder/orders/${so2}`,
      `/portal/order-requests/${G.request.id}`,
      `/portal/approvals/${G.revised.id}`,
      `/portal/returns/${G.return.id}`,
      `/portal/customer-documents/${G.docFile}`,
      `/portal/threads/SalesOrder/${id('sales:SO1')}`,
      `/portal/payments/intents/${G.intent}`,
      `/portal/complaints/${G.complaint}`,
      `/portal/complaints/${id('returns:CMP-0001')}`,
    ]) {
      await as(R.otherBuyer, 'GET', url, undefined, 404)
    }
    await as(R.otherBuyer, 'POST', `/portal/threads/SalesOrder/${id('sales:SO1')}/messages`, { body: 'Not mine.' }, 404)
    await as(R.otherBuyer, 'POST', `/portal/sales-orders/${G.order.id}/change-requests`, { kind: 'CHANGE', cells: [G.changeCell], note: 'Not mine.' }, 404)
    await as(R.otherBuyer, 'POST', `/portal/approvals/${G.revised.id}/answer`, { decision: 'APPROVED', typedName: 'Kai Golden', version: 1 }, 404)
    await as(R.otherBuyer, 'POST', `/portal/customer-documents/${G.docFile}/download`, { mode: 'preview' }, 404)
    const theirOrders = JSON.stringify(await as(R.otherBuyer, 'GET', '/portal/sales-orders?chip=ALL'))
    for (const number of ['SEED-SO-0001', 'SEED-SO-0002', G.order.number]) expect(theirOrders).not.toContain(number)
    expect(JSON.stringify(await as(R.otherBuyer, 'GET', '/portal/returns'))).not.toContain(G.return.id)
    // A tannery of another party.
    for (const url of [`/portal/purchase-orders/${G.po.id}`, `/portal/ship-notices/${G.notice.id}`]) await as(R.otherTannery, 'GET', url, undefined, 404)
    const confirm = await as(R.otherTannery, 'POST', `/portal/purchase-orders/${G.po.id}/confirm`, { version: 1, mode: 'ALL_AS_ASKED' }, 404)
    expect(confirm.error.message).toBe('Purchase order not found.')
    expect((await as(R.otherTannery, 'GET', '/portal/purchase-orders?chip=ALL')).items).toEqual([])
    await as(R.otherTannery, 'POST', '/portal/supplier-documents', { category: 'TEST_REPORT', recordType: 'PurchaseOrder', recordId: G.po.id, originalName: 'not-mine.pdf', contentType: 'application/pdf', sizeBytes: 100, sha256: 'c'.repeat(64) }, 404)
    // A workshop of another party.
    await as(R.otherWorkshop, 'GET', `/portal/jobs/${G.job.id}`, undefined, 404)
    for (const chip of ['NEW', 'KIT', 'WORK', 'BACK', 'DONE']) expect((await as(R.otherWorkshop, 'GET', `/portal/jobs?chip=${chip}`)).items).toEqual([])
    // Another kind: refused the route itself.
    await as(R.buyer, 'GET', `/portal/purchase-orders/${G.po.id}`, undefined, 403)
    await as(R.buyer, 'GET', `/portal/jobs/${G.job.id}`, undefined, 403)
    await as(R.tannery, 'GET', `/portal/sales-orders/${so2}`, undefined, 403)
    await as(R.tannery, 'GET', `/portal/jobs/${G.job.id}`, undefined, 403)
    await as(R.workshop, 'GET', `/portal/purchase-orders/${G.po.id}`, undefined, 403)
    await as(R.workshop, 'GET', `/portal/sales-orders/${so2}`, undefined, 403)
    await as(R.accountant, 'GET', `/portal/sales-orders/${so2}`, undefined, 403)
    await as(R.buyer, 'GET', '/portal/accounting', undefined, 403)
    // Office and portal: strangers.
    expect((await call(P.sales.browser, 'GET', '/portal/sales-orders')).status).toBe(401)
    expect((await call(R.buyer.browser, 'GET', `/sales/orders/${so2}`)).status).toBe(401)
    expect((await call(R.tannery.browser, 'GET', `/purchasing/orders/${G.po.id}`)).status).toBe(401)
  })

  it('X03 no price in any answer a supplier, a workshop, a link or the public got; no cost, margin or pay key in any partner or link answer of the whole flow', async () => {
    expect(seen.length).toBeGreaterThan(100)
    const never = seen.flatMap((entry) => [...new Set(keysOf(entry.body).filter(NEVER))].map((key) => `${entry.who} ${entry.url}: ${key}`))
    expect(never).toEqual([])
    const priced = seen
      .filter((entry) => entry.kind === 'supplier' || entry.kind === 'workshop' || entry.kind === 'link' || entry.kind === 'public')
      .flatMap((entry) => [...new Set(keysOf(entry.body).filter(PRICE))].map((key) => `${entry.who} ${entry.url}: ${key}`))
    expect(priced).toEqual([])
    // What each kind saw, to prove the scan read them all.
    expect(new Set(seen.map((entry) => entry.kind))).toEqual(new Set(['customer', 'supplier', 'workshop', 'guest', 'link', 'public']))
  })

  it('Z1 every record the flow made has its audit rows; the W2b-3 events fired; the worker never retried; no route answered 500; the outbox is empty', async () => {
    await settle()
    const ids = [...made]
    const audited = new Set((await admin<{ recordId: string }>(w, 'SELECT DISTINCT "recordId"::text AS "recordId" FROM "AuditLog" WHERE "recordId" = ANY($1::uuid[])', [ids])).map((row) => row.recordId))
    const named = (recordId: string) => `${recordId} (${[...Object.entries(R).filter(([, partner]) => partner.userId === recordId).map(([key]) => `partner ${key}`), ...Object.entries(G).filter(([, value]) => JSON.stringify(value ?? null).includes(recordId)).map(([key]) => `G.${key}`)].join(', ')})`
    expect(ids.filter((recordId) => !audited.has(recordId)).map(named)).toEqual([])
    const events = new Set((await admin<{ type: string }>(w, 'SELECT DISTINCT type FROM "OutboxEvent" WHERE "tenantId" = $1', [w.tenant.id])).map((row) => row.type))
    expect(EVENTS.filter((type) => !events.has(type)), `seen: ${[...events].sort().join(' ')}`).toEqual([])
    expect(w.retried).toEqual([])
    expect(unexpected.map((report) => `${report.context.method} ${report.context.route}: ${report.name}: ${report.message} ${report.stack.slice(0, 3).join(' | ')}`)).toEqual([])
    expect(await admin(w, `SELECT type, status::text AS status FROM "OutboxEvent" WHERE "tenantId" = $1 AND status <> 'PUBLISHED'`, [w.tenant.id])).toEqual([])
  })
})
