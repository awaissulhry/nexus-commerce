import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, fixedClock } from '@nexus/factory-domain/core/time'
import { deliveryStateOf } from '@nexus/factory-domain/purchasing/orders/delivery'
import { addDays } from '@nexus/factory-domain/planning/buy'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { runConfirmationReminders } from '../reminders/daily'

/**
 * A purchase order's changes after the send (B-W2a-52; SCM-058, SCM-059, SCM-060, SCM-067, SCM-087) on the local stack:
 * a throwaway PostgreSQL 17 database from the migrations (row-level security, the partner role's grants and the
 * …_supply_w2a_guards triggers are real), the real app with the real office sign-in (a buyer with two-factor), the FAKE
 * SES mailbox (the only place a confirm link's token exists), the supplier's browser that holds only the token, and a
 * second app with test sessions (a warehouse manager who posts receipts; a planner without the cost grain). The
 * factory-db seeds up to production. Every name, number and price is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/purchasing/revisions`.
 */

let h: Harness
let walls: FastifyInstance
let buyer: Browser

const NS = 'po-changes'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const P2 = seedId('party:P2')
const leather = seedId('product:item:leather')
const protector = seedId('product:item:protector')
const lining = seedId('product:item:lining')
const leatherBLK = seedId('product:item-colour:leather:BLK')
const liningGRY = seedId('product:item-colour:lining:GRY')
const PO1 = seedId('link:P2:record')
const FAKE_VAT = '12345670009'
const HOUR = 3_600_000
const today = () => businessDate(new Date())

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
let counter = 0
const key = (label = 'k'): string => `poch-${label}-${++counter}-${newId()}`

async function as(method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await buyer.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, () => SessionContext> = {
  manager: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['inventory.receive', 'inventory.stock.view', 'money.cost', 'files.read', 'files.upload'])] }),
  planner: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['purchasing.view'])] }),
  manageOnly: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['purchasing.view', 'purchasing.manage', 'money.cost'])] }),
}
const wall = async (session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> => {
  const answer = await walls.inject({ method, url, headers: { 'x-test-session': session, 'idempotency-key': key('wall') }, ...(payload === undefined ? {} : { payload: payload as object }) })
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json()
}

/** A request of the supplier's browser: only the link's token, no cookie. */
const viaLink = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  h.app.inject({ method, url, headers: { 'x-factory-link': token, 'user-agent': 'SeedBrowser/1.0', ...(method === 'POST' ? { 'idempotency-key': key('link') } : {}) }, ...(method === 'POST' ? { payload: (payload ?? {}) as object } : {}) })
const page = async (token: string): Promise<Json> => {
  const answer = await viaLink(token, 'GET', '/link/purchase-order')
  expect(answer.statusCode, answer.body).toBe(200)
  return answer.json()
}
const orderUrl = (id: string) => `/purchasing/orders/${id}`
const mailOf = (outboundId: string) => h.ses.mails.find((entry) => entry.outboundId === outboundId)
const tokenOf = (outboundId: string): string => {
  const mail = mailOf(outboundId)
  return mail ? decodeURIComponent(/#token=(\S+)/.exec(textOf(mail.raw))?.[1] ?? '') : ''
}
const eventsOf = async (subject: string) => (await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])).map((row) => row.type)
/** The mail an order's command queued last (the worker sends it; FAKE here). */
const lastQueued = async (orderId: string) => one<{ subject: string; body: string; to: string[] }>(`SELECT o.subject, m."bodyText" AS body, o."to" FROM "EmailOutbound" o JOIN "Message" m ON m.id = o."messageId" WHERE o."recordType" = 'PurchaseOrder' AND o."recordId" = $1 ORDER BY o."queuedAt" DESC, o.id DESC LIMIT 1`, [orderId])
const priceTraces = (body: unknown): string[] => [/price/i, /amount/i, /cost/i, /internalNote/, /sentById/].filter((pattern) => pattern.test(JSON.stringify(body))).map(String)

/** A draft for P2 at A1 with these lines (each: item, colour, quantity, unit, need in days). */
async function draft(lines: readonly { itemId: string; colourId?: string; quantity: string; uom: string; days: number; unitPrice?: string }[]): Promise<Json> {
  let order = (await as('POST', '/purchasing/orders', { companyId: companyA, siteId: seedId('site:A1'), partyId: P2, incoterms: 'EXW Seedville' }, 201)).order
  for (const line of lines) {
    order = (await as('POST', `${orderUrl(order.id)}/lines`, { version: order.version, itemId: line.itemId, ...(line.colourId ? { itemColourId: line.colourId } : {}), quantity: line.quantity, uom: line.uom, needDate: addDays(today(), line.days), ...(line.unitPrice ? { unitPrice: line.unitPrice } : {}) }, 201)).order
  }
  return order
}
const LEATHER_AND_PROTECTORS = [
  { itemId: leather, colourId: leatherBLK, quantity: '105', uom: 'FT2', days: 30 },
  { itemId: protector, quantity: '24', uom: 'PCS', days: 35 },
]

async function send(order: Json, body: Json = {}): Promise<{ order: Json; sent: Json; token: string }> {
  const answer = await as('POST', `${orderUrl(order.id)}/send`, { version: order.version, ...body })
  return { order: answer.order, sent: answer.sent, token: tokenOf(answer.sent.emailId) }
}
const confirmAll = async (token: string, version: number) => {
  const answer = await viaLink(token, 'POST', '/link/purchase-order/confirm', { version, mode: 'ALL_AS_ASKED', typedName: 'Mario Rossi', supplierRef: 'OC-7' })
  expect(answer.statusCode, answer.body).toBe(200)
  return answer.json()
}

beforeAll(async () => {
  h = await startHarness('po_changes')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant])
  const ses = newId()
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses', 'Mail', 'FAKE', 6000, 1000)`, [ses, tenant])
  await admin(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'mail.seed-a.example.com', 'acquisti@mail.seed-a.example.com', 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), tenant, companyA, ses],
  )
  await admin(`UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3, "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA, `IT${FAKE_VAT}`, FAKE_VAT])
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const buyerUser = await addUser(h, seedTenant, { email: 'bianca.buyer@seed-a.example.com', role: 'buyer' })
  buyer = new Browser(h.app)
  expect((await buyer.signIn(NS, buyerUser.email, buyerUser.password)).status).toBe(200)
  await enrolTotp(h, buyer)
  walls = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await walls?.close()
  await h?.close()
}, 60_000)

describe('the send writes revision 1 and the confirm-by deadline (SCM-058, SCM-087)', () => {
  it('48 hours after the send by default; the revision row as sent (no price in it), its prices apart; a planner reads no price', async () => {
    const order = await draft(LEATHER_AND_PROTECTORS)
    const check = await as('GET', `${orderUrl(order.id)}/send-check`)
    expect(check).toMatchObject({ ready: true, revision: 1, changes: null })
    const { order: sent, sent: answer } = await send(order)
    expect(sent.confirmBy).toBe(new Date(new Date(sent.sentAt).getTime() + 48 * HOUR).toISOString())
    expect(answer).toMatchObject({ revision: 1, confirmBy: sent.confirmBy, revisionId: expect.any(String), changes: null })
    const row = await one('SELECT revision, before, after, "beforePrices", "afterPrices", "documentFileId", "changeNote", "sentAt" FROM "PurchaseOrderRevision" WHERE "purchaseOrderId" = $1', [order.id])
    expect(row).toMatchObject({ revision: 1, before: null, beforePrices: null, documentFileId: answer.documentFileId, changeNote: null })
    expect(row.after).toMatchObject({ status: 'SENT', incoterms: 'EXW Seedville', confirmation: null, lines: [{ seq: 10, quantity: '105.0000', uom: 'FT2', cancelled: false }, { seq: 20, quantity: '24.0000', uom: 'PCS', cancelled: false }] })
    expect(priceTraces(row.after)).toEqual([])
    expect(row.afterPrices).toMatchObject({ currency: 'EUR', netAmount: sent.netAmount, lines: [{ seq: 10 }, { seq: 20 }] })

    const revisions = await as('GET', `${orderUrl(order.id)}/revisions`)
    expect(revisions).toMatchObject({ revision: 1, status: 'SENT', draft: null, revisions: [{ revision: 1, documentNumber: sent.number, answer: 'WAITING', changes: { count: 0 }, documentFileId: answer.documentFileId, prices: { after: { netAmount: sent.netAmount } } }] })
    const planner = await wall('planner', 'GET', `${orderUrl(order.id)}/revisions`)
    expect(planner.revisions[0].prices).toBeUndefined()
    expect((await wall('planner', 'GET', orderUrl(order.id))).order.openNetAmount).toBeUndefined()
  })

  it('a deadline given by the dialog; a past one is refused in words; the office moves it while the order waits', async () => {
    const order = await draft(LEATHER_AND_PROTECTORS)
    const past = await buyer.send('POST', `${orderUrl(order.id)}/send`, { version: order.version, confirmBy: new Date(Date.now() - HOUR).toISOString() }, { headers: { 'idempotency-key': key() } })
    expect(past.status).toBe(400)
    expect((past.body as Json).error.issues).toEqual([{ path: 'body/confirmBy', message: 'The supplier is asked to answer by a time still to come.' }])
    const wanted = new Date(Date.now() + 72 * HOUR).toISOString()
    const { order: sent } = await send(order, { confirmBy: wanted })
    expect(sent.confirmBy).toBe(wanted)
    const later = new Date(Date.now() + 96 * HOUR).toISOString()
    const moved = (await as('POST', `${orderUrl(order.id)}/confirm-by`, { version: sent.version, confirmBy: later })).order
    expect(moved.confirmBy).toBe(later)
    expect(await eventsOf(order.id)).toContain('purchase_order.confirm_by_moved')
  })
})

describe('Change: revision 2 with a visible diff and a new confirmation (SCM-058)', () => {
  let order: Json
  let firstToken: string

  it('a confirmed order goes back to DRAFT as revision 2: confirmation gone (kept with the change), links stopped', async () => {
    const sent = await send(await draft(LEATHER_AND_PROTECTORS))
    firstToken = sent.token
    await confirmAll(sent.token, sent.order.version)
    order = (await as('GET', orderUrl(sent.order.id))).order
    expect(order.status).toBe('CONFIRMED')
    const changed = await as('POST', `${orderUrl(order.id)}/change`, { version: order.version, note: 'The customer wants more' })
    expect(changed).toMatchObject({ revision: 2, revokedLinkIds: [] })
    order = changed.order
    expect(order).toMatchObject({ status: 'DRAFT', revision: 2, documentNumber: `${order.number} rev. 2`, sentAt: null, confirmBy: null, confirmedAt: null, confirmedVia: null })
    expect(order.lines.map((line: Json) => line.confirmedQuantity)).toEqual([null, null])
    // The link of revision 1 was used already; it opens nothing now.
    expect((await viaLink(firstToken, 'GET', '/link/purchase-order')).statusCode).toBe(404)
    const audit = await one('SELECT reason, before, after FROM "AuditLog" WHERE "recordId" = $1 AND action = $2', [order.id, 'purchasing.change'])
    expect(audit).toMatchObject({ reason: 'The customer wants more', before: { status: 'CONFIRMED', revision: 1 }, after: { status: 'DRAFT', revision: 2, kept: { status: 'CONFIRMED', confirmation: { via: 'LINK', byName: 'Mario Rossi', supplierRef: 'OC-7' }, lines: [{ confirmedQuantity: '105.0000' }, { confirmedQuantity: '24.0000' }] } } })
    expect(await eventsOf(order.id)).toContain('purchase_order.revision_started')
    // A draft is not changed: it is sent.
    expect((await as('POST', `${orderUrl(order.id)}/change`, { version: order.version }, 409)).error.message).toBe('The order is a draft: change it and send it.')
  })

  it('the draft changes: more leather, the protectors cancelled (sent before: cancelled, not removed); its total skips them', async () => {
    const [line10, line20] = order.lines as Json[]
    order = (await as('PATCH', `${orderUrl(order.id)}/lines/${line10!.id}`, { version: order.version, quantity: '140' })).order
    const cancelled = await as('POST', `${orderUrl(order.id)}/lines/cancel`, { version: order.version, lineIds: [line20!.id], reason: 'Bought elsewhere' })
    order = cancelled.order
    expect(cancelled.supplierTold).toBe(false)
    expect(order.lines[1]).toMatchObject({ ended: { kind: 'CANCELLED', reason: 'Bought elsewhere' } })
    expect(order.netAmount).toBe(order.lines[0].netAmount)
    const revisions = await as('GET', `${orderUrl(order.id)}/revisions`)
    expect(revisions.draft).toMatchObject({ revision: 2, changes: { count: 2, lines: [{ seq: 10, kind: 'CHANGED', changes: [{ field: 'quantity', before: '105.0000 FT2', after: '140.0000 FT2' }] }, { seq: 20, kind: 'CANCELLED' }] } })
  })

  it('the send of revision 2: the mail says what changed and why, a new link, the revision row with the state it replaces', async () => {
    const check = await as('GET', `${orderUrl(order.id)}/send-check`)
    // In the supplier's language (P2 reads Italian).
    expect(check.changes).toEqual(['Riga 10 (SEED-ART-100 Seed cowhide 1.2 mm): quantità 105 ft² → 140 ft²', 'Riga 20 (SEED-ART-300 Seed shoulder protector level 2): annullata'])
    const { order: sent, sent: answer, token } = await send(order, { changeNote: 'Our customer doubled the run.' })
    expect(sent).toMatchObject({ status: 'SENT', revision: 2, netAmount: sent.lines[0].netAmount })
    const text = textOf(mailOf(answer.emailId)!.raw)
    expect(text).toContain(`le inviamo la revisione ${sent.number} rev. 2 del nostro ordine di acquisto, che sostituisce ${sent.number}`)
    expect(text).toMatch(/Cosa cambia:\s+- Riga 10 \(.+\): quantità 105 ft² → 140 ft²\s+- Riga 20 \(.+\): annullata/)
    expect(text).toContain('Il motivo: Our customer doubled the run.')
    const row = await one('SELECT before, after, "beforePrices", "afterPrices", "changeNote" FROM "PurchaseOrderRevision" WHERE "purchaseOrderId" = $1 AND revision = 2', [order.id])
    expect(row).toMatchObject({ changeNote: 'Our customer doubled the run.', before: { status: 'CONFIRMED', confirmation: { byName: 'Mario Rossi' } }, after: { status: 'SENT', lines: [{ quantity: '140.0000', cancelled: false }, { cancelled: true }] } })
    expect(row.afterPrices.lines).toHaveLength(1)
    expect(row.beforePrices.lines).toHaveLength(2)

    // The supplier sees what changed (no price), the cancelled line as cancelled, and answers the open line only.
    const view = await page(token)
    expect(view.order).toMatchObject({ revision: 2, status: 'SENT' })
    expect(view.revision).toMatchObject({ revision: 2, changeNote: 'Our customer doubled the run.', changes: check.changes })
    expect(view.lines.map((line: Json) => line.ended)).toEqual([null, 'CANCELLED'])
    expect(priceTraces(view)).toEqual([])
    const answered = await viaLink(token, 'POST', '/link/purchase-order/confirm', { version: view.order.version, mode: 'BY_LINE', lines: [{ lineId: view.lines[0].id, answer: 'AS_ASKED' }] })
    expect(answered.statusCode, answered.body).toBe(200)
    expect(answered.json()).toMatchObject({ outcome: 'CONFIRMED', summary: 'the line as asked' })
    const revisions = await as('GET', `${orderUrl(order.id)}/revisions`)
    expect(revisions.revisions.map((entry: Json) => [entry.revision, entry.answer])).toEqual([
      [1, 'CONFIRMED'],
      [2, 'CONFIRMED'],
    ])
    expect(revisions.revisions[1]).toMatchObject({ changeNote: 'Our customer doubled the run.', changes: { count: 2 }, prices: { changed: { netAmount: { before: expect.any(Number), after: sent.netAmount } } } })
  })
})

describe('counter-propose: the supplier’s proposal refused into revision 2 (W1 leftover, Owner answer P2)', () => {
  it('CHANGES_PROPOSED → DRAFT revision 2 with the decision REFUSED; the proposal kept with the change, cleared from the lines', async () => {
    const { order, token } = await send(await draft(LEATHER_AND_PROTECTORS))
    const lines = (await page(token)).lines as Json[]
    const proposed = await viaLink(token, 'POST', '/link/purchase-order/confirm', { version: order.version, mode: 'BY_LINE', lines: [{ lineId: lines[0]!.id, answer: 'OTHER', quantity: '105', date: addDays(today(), 45), reason: 'Tannery closed' }, { lineId: lines[1]!.id, answer: 'AS_ASKED' }] })
    expect(proposed.statusCode, proposed.body).toBe(200)
    const current = (await as('GET', orderUrl(order.id))).order
    // Only a waiting proposal is countered; Change is refused while one waits.
    expect((await as('POST', `${orderUrl(order.id)}/change`, { version: current.version }, 409)).error.message).toMatch(/counter-propose/)
    const countered = await as('POST', `${orderUrl(order.id)}/proposal/counter`, { version: current.version, note: 'Too late for us' })
    expect(countered).toMatchObject({ revision: 2, order: { status: 'DRAFT', revision: 2 } })
    expect(await one('SELECT "proposalDecision", "proposalDecisionNote" FROM "PurchaseOrder" WHERE id = $1', [order.id])).toEqual({ proposalDecision: 'REFUSED', proposalDecisionNote: 'Too late for us' })
    expect(await admin('SELECT "proposedQuantity", "proposedDate" FROM "PurchaseOrderLine" WHERE "purchaseOrderId" = $1 ORDER BY seq', [order.id])).toEqual([
      { proposedQuantity: null, proposedDate: null },
      { proposedQuantity: null, proposedDate: null },
    ])
    const audit = await one('SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = $2', [order.id, 'purchasing.counterPropose'])
    expect(audit.after.kept).toMatchObject({ status: 'CHANGES_PROPOSED', lines: [{ proposal: { date: addDays(today(), 45), reason: 'Tannery closed' } }, { proposal: { quantity: '24.0000' } }] })
    const event = await one('SELECT payload FROM "OutboxEvent" WHERE subject = $1 AND type = $2', [order.id, 'purchase_order.revision_started'])
    expect(event.payload).toMatchObject({ revision: 2, from: 'CHANGES_PROPOSED', counterProposal: true })
  })
})

describe('cancel a line or the order (SCM-059: the pegged demand released, the supplier told)', () => {
  it('a sent order’s line: ended, the supplier mailed, the link skips it; the last open line → cancel the order instead', async () => {
    const { order, token } = await send(await draft(LEATHER_AND_PROTECTORS))
    const reach = await as('GET', `${orderUrl(order.id)}/reach?action=CANCEL_LINES&lineIds=${order.lines[1].id}`)
    expect(reach).toMatchObject({ action: 'CANCEL_LINES', allowed: true, problems: [], mayDo: true, supplierTold: true, lines: [{ seq: 20, outstandingBase: '24.0000' }] })
    // purchasing.manage alone may not tell the supplier.
    const forbidden = await walls.inject({ method: 'POST', url: `${orderUrl(order.id)}/lines/cancel`, headers: { 'x-test-session': 'manageOnly', 'idempotency-key': key() }, payload: { version: order.version, lineIds: [order.lines[1].id], reason: 'No' } })
    expect(forbidden.statusCode).toBe(403)
    const answer = await as('POST', `${orderUrl(order.id)}/lines/cancel`, { version: order.version, lineIds: [order.lines[1].id], reason: 'Bought elsewhere', message: 'Sorry for the trouble.' })
    expect(answer).toMatchObject({ supplierTold: true, order: { status: 'SENT', lines: [{ ended: null }, { ended: { kind: 'CANCELLED' } }] } })
    const mail = await lastQueued(order.id)
    expect(mail.subject).toBe(`Ordine di acquisto ${order.number}: righe annullate`)
    expect(mail.body).toMatch(/queste righe del nostro ordine di acquisto .+ sono annullate: la preghiamo di non evaderle\.\n- Line 20 /)
    expect(mail.body).not.toContain('Bought elsewhere')
    expect(mail.body).toContain('Sorry for the trouble.')
    expect((await page(token)).lines.map((line: Json) => line.ended)).toEqual([null, 'CANCELLED'])
    const last = await as('POST', `${orderUrl(order.id)}/lines/cancel`, { version: answer.order.version, lineIds: [order.lines[0].id], reason: 'No more' }, 409)
    expect(last.error).toMatchObject({ message: 'These are the last open lines of the order: cancel the order instead.', issues: [{ path: 'body/lineIds' }] })
    expect(await eventsOf(order.id)).toContain('purchase_order.lines_cancelled')
  })

  it('W2a: a confirmed order is cancelled too (it ends a contract: the reach says so); the supplier is told', async () => {
    const { order, token } = await send(await draft(LEATHER_AND_PROTECTORS))
    await confirmAll(token, order.version)
    const confirmed = (await as('GET', orderUrl(order.id))).order
    expect(await as('GET', `${orderUrl(confirmed.id)}/reach?action=CANCEL_ORDER`)).toMatchObject({ allowed: true, confirmed: true, supplierTold: true, lines: [{ seq: 10 }, { seq: 20 }] })
    const cancelled = await as('POST', `${orderUrl(confirmed.id)}/cancel`, { version: confirmed.version, reason: 'Customer order cancelled' })
    expect(cancelled).toMatchObject({ supplierTold: true, order: { status: 'CANCELLED' }, reach: { lines: [{ seq: 10 }, { seq: 20 }] } })
    expect((await lastQueued(order.id)).subject).toBe(`Annullamento ordine di acquisto ${order.number}`)
  })
})

describe('close short and the expected deliveries (SCM-060, SCM-067)', () => {
  it('PO1 (seeded, partly received): closing the leather short keeps what came; the protectors at the dock refuse a cancel', async () => {
    const po1 = (await as('GET', orderUrl(PO1))).order
    expect(po1.status).toBe('PARTLY_RECEIVED')
    const [leatherLine, protectorLine] = po1.lines as Json[]
    const atDock = await as('POST', `${orderUrl(PO1)}/lines/cancel`, { version: po1.version, lineIds: [protectorLine!.id], reason: 'No' }, 409)
    expect(atDock.error.message).toMatch(/goods for it are at the dock \(an open receipt\)/)
    const nothing = await as('POST', `${orderUrl(PO1)}/lines/close-short`, { version: po1.version, lineIds: [protectorLine!.id], reason: 'No' }, 409)
    expect(nothing.error.message).toMatch(/nothing came for it yet: cancel it instead/)
    const reach = await as('GET', `${orderUrl(PO1)}/reach?action=CLOSE_SHORT&lineIds=${leatherLine!.id}`)
    expect(reach).toMatchObject({ allowed: true, lines: [{ seq: leatherLine!.seq, receivedBase: leatherLine!.receivedBaseQuantity }] })
    const closed = await as('POST', `${orderUrl(PO1)}/lines/close-short`, { version: po1.version, lineIds: [leatherLine!.id], reason: 'The tannery has no more of this batch' })
    expect(closed).toMatchObject({ supplierTold: true, order: { status: 'PARTLY_RECEIVED', lines: [{ ended: { kind: 'CLOSED_SHORT', reason: 'The tannery has no more of this batch' } }, { ended: null }] } })
    expect((await lastQueued(PO1)).subject).toMatch(/: righe chiuse$/)
    // The plan line it bought is open again (planning's hook): its rest is to buy again.
    const planLineIds = closed.reach.lines[0].planLineIds as string[]
    expect(planLineIds.length).toBeGreaterThanOrEqual(1)
    expect(await admin('SELECT decision, "purchaseOrderLineId" FROM "MaterialRequirement" WHERE id = ANY($1::uuid[])', [planLineIds])).toEqual(planLineIds.map(() => ({ decision: 'OPEN', purchaseOrderLineId: null })))
    expect(await eventsOf(PO1)).toContain('purchase_order.lines_closed_short')
  })

  it('a sent order: the protectors in full, the lining in part → PARTLY_RECEIVED; the lining closed short → RECEIVED; the expected view moves', async () => {
    const order = (await send(await draft([{ itemId: protector, quantity: '20', uom: 'PCS', days: 10 }, { itemId: lining, colourId: liningGRY, quantity: '100', uom: 'M', days: 3 }]))).order
    const expected = await as('GET', `/purchasing/expected`)
    // The earliest expected first: the lining (in 3 days) before the protectors (in 10).
    expect(expected.lines.filter((line: Json) => line.purchaseOrderId === order.id).map((line: Json) => [line.seq, line.state, line.outstandingBase, line.dateFrom])).toEqual([
      [20, deliveryStateOf(addDays(today(), 3), today()), '100.0000', 'ASKED'],
      [10, deliveryStateOf(addDays(today(), 10), today()), '20.0000', 'ASKED'],
    ])
    await wall('manager', 'POST', '/inventory/receipts', { purchaseOrderId: order.id, lines: [{ purchaseOrderLineId: order.lines[0].id, lots: [{ quantity: '20' }] }, { purchaseOrderLineId: order.lines[1].id, lots: [{ quantity: '40' }] }] }, 201)
    let current = (await as('GET', orderUrl(order.id))).order
    expect(current.status).toBe('PARTLY_RECEIVED')
    expect((await as('POST', `${orderUrl(order.id)}/lines/close-short`, { version: current.version, lineIds: [order.lines[0].id], reason: 'x' }, 409)).error.message).toMatch(/it was received in full/)
    current = (await as('POST', `${orderUrl(order.id)}/lines/close-short`, { version: current.version, lineIds: [order.lines[1].id], reason: '60 m will not come' })).order
    expect(current.status).toBe('RECEIVED')
    expect((await as('GET', `/purchasing/expected`)).lines.some((line: Json) => line.purchaseOrderId === order.id)).toBe(false)
    // A closed-short line takes no more goods (B-W2a-31's words).
    const refused = await walls.inject({ method: 'POST', url: '/inventory/receipts', headers: { 'x-test-session': 'manager', 'idempotency-key': key() }, payload: { purchaseOrderId: order.id, lines: [{ purchaseOrderLineId: order.lines[1].id, lots: [{ quantity: '10' }] }] } })
    expect(refused.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('the list: Late and Due this week tiles and filters', async () => {
    const order = (await send(await draft([{ itemId: protector, quantity: '12', uom: 'PCS', days: 1 }]))).order
    // The supplier confirmed a date three days ago (a need date cannot be set in the past through the routes).
    await admin(`UPDATE "PurchaseOrderLine" SET "confirmedQuantity" = quantity, "confirmedDate" = $2::date WHERE "purchaseOrderId" = $1`, [order.id, addDays(today(), -3)])
    const list = await as('GET', '/purchasing/orders?due=LATE')
    expect(list.orders.map((row: Json) => row.id)).toContain(order.id)
    expect(list.orders.find((row: Json) => row.id === order.id)).toMatchObject({ delivery: 'LATE', nextExpectedDate: addDays(today(), -3) })
    expect(list.summary.late).toBeGreaterThanOrEqual(1)
    expect(typeof list.summary.dueThisWeek).toBe('number')
    const late = await as('GET', '/purchasing/expected?state=LATE')
    expect(late.lines.find((line: Json) => line.purchaseOrderId === order.id)).toMatchObject({ state: 'LATE', daysLate: 3, dateFrom: 'CONFIRMED', outstandingBase: '12.0000' })
    expect(priceTraces(late)).toEqual([])
  })
})

describe('reminders to confirm (SCM-087): by the buyer; the daily run only with the switch on', () => {
  it('by hand while the order waits; the reminder row, a mail without a link, the record lists it; a confirmed order is refused', async () => {
    const { order } = await send(await draft(LEATHER_AND_PROTECTORS))
    const reminded = await as('POST', `${orderUrl(order.id)}/remind`, { version: order.version, message: 'Please answer today.' })
    expect(reminded.reminder).toMatchObject({ revision: 1, automatic: false, to: 'orders.p2@example.com' })
    const mail = await lastQueued(order.id)
    expect(mail.subject).toBe(`Promemoria: conferma dell'ordine di acquisto ${order.number}`)
    expect(mail.body).toContain('Please answer today.')
    expect(mail.body).not.toMatch(/#token=|\/l#/)
    const reminders = await as('GET', `${orderUrl(order.id)}/reminders`)
    expect(reminders).toMatchObject({ automatic: false, overdue: false, sentForRevision: 1, reminders: [{ revision: 1, automatic: false, note: 'Please answer today.' }] })
    expect(await eventsOf(order.id)).toContain('purchase_order.reminder_sent')
    await confirmAll(tokenOf((await one<{ id: string }>(`SELECT o.id FROM "EmailOutbound" o WHERE o."recordId" = $1 ORDER BY o."queuedAt" ASC LIMIT 1`, [order.id])).id), reminded.order.version)
    const confirmed = (await as('GET', orderUrl(order.id))).order
    expect((await as('POST', `${orderUrl(order.id)}/remind`, { version: confirmed.version }, 409)).error.message).toBe('The supplier answered this order already: it waits for no confirmation.')
  })

  it('the daily run: past the deadline it is due; the switch off sends nothing; on, one reminder, and a second run the same day none', async () => {
    // Asked to answer within a minute; the run looks three days on.
    const { order } = await send(await draft(LEATHER_AND_PROTECTORS), { confirmBy: new Date(Date.now() + 60_000).toISOString() })
    const clock = fixedClock(new Date(Date.now() + 72 * HOUR))
    expect((await as('GET', '/purchasing/reminders/due')).orders.some((row: Json) => row.id === order.id)).toBe(false)
    const log = { info: () => undefined, error: () => undefined, warn: () => undefined } as never
    const off = await runConfirmationReminders({ database: h.database, log, clock })
    expect(off).toMatchObject({ sent: 0 })
    expect(off.switchedOff).toBeGreaterThanOrEqual(1)
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM "PurchaseOrderReminder" WHERE "purchaseOrderId" = $1', [order.id])).n).toBe(0)
    const on = await runConfirmationReminders({ database: h.database, log, clock, switchOn: () => true })
    expect(on.sent).toBeGreaterThanOrEqual(1)
    expect(await admin('SELECT revision, "sentById", "toAddress" FROM "PurchaseOrderReminder" WHERE "purchaseOrderId" = $1', [order.id])).toEqual([{ revision: 1, sentById: null, toAddress: 'orders.p2@example.com' }])
    const again = await runConfirmationReminders({ database: h.database, log, clock, switchOn: () => true })
    expect(again.failed).toBe(0)
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM "PurchaseOrderReminder" WHERE "purchaseOrderId" = $1', [order.id])).n).toBe(1)
    expect((await one('SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = $2', [order.id, 'purchasing.remindAutomatic'])).after).toMatchObject({ automatic: true })
  })
})

describe('Send n: several orders, each its own send (design grid "Bulk: Send n")', () => {
  it('the cards first; then one goes, one is refused alone in words', async () => {
    const good = await draft(LEATHER_AND_PROTECTORS)
    const empty = (await as('POST', '/purchasing/orders', { companyId: companyA, siteId: seedId('site:A1'), partyId: P2 }, 201)).order
    const cards = await as('POST', '/purchasing/orders/send-checks', { orderIds: [good.id, empty.id] })
    expect(cards).toMatchObject({ ready: 1, cards: [{ id: good.id, ready: true }, { id: empty.id, ready: false, checks: expect.arrayContaining([expect.objectContaining({ code: 'NO_LINES' })]) }] })
    const answer = await as('POST', '/purchasing/orders/send-many', { orders: [{ id: good.id, version: good.version }, { id: empty.id, version: empty.version }] })
    expect(answer).toMatchObject({ sent: 1, refused: 1, outcomes: [{ id: good.id, outcome: 'SENT', sent: { revision: 1 }, refused: null }, { id: empty.id, outcome: 'REFUSED', sent: null, refused: { code: 'conflict' } }] })
    expect(answer.outcomes[1].refused.message).toMatch(/^The order cannot be sent yet\. Add a line/)
    expect(await one('SELECT status FROM "PurchaseOrder" WHERE id = $1', [good.id])).toEqual({ status: 'SENT' })
    expect(await one('SELECT status FROM "PurchaseOrder" WHERE id = $1', [empty.id])).toEqual({ status: 'DRAFT' })
  })
})
