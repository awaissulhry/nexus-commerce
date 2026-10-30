import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { RENEW_ANSWER } from '@nexus/factory-domain/purchasing/confirm/renew'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addTenant, addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { LINK_UNAVAILABLE } from '../../../platform/links/authenticator'
import { systemContext } from '../../../platform/outbox/system'
import { tellBuyer } from './handler'

/**
 * The supplier confirms a purchase order through its PO_CONFIRM link (B-W1-31; SCM-085, SCM-086; PLAN §4.7 stage 08-buy
 * "supplier confirms by link (no prices on the link)") on the local stack: a throwaway PostgreSQL 17 database from the
 * migrations (row-level security, the partner role's column grants and the …_supply_guards triggers are real), the real
 * app with the real office sign-in (a buyer with two-factor) that sends the order (B-W1-30), the FAKE SES mailbox (the
 * only place a link's token exists), the supplier's browser that holds nothing but the token, and a second app with test
 * sessions for the walls. Every name, number and price is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs purchasing/confirm`.
 */

let h: Harness
let walls: FastifyInstance
let buyer: Browser
let other: TestTenant
let buyerId: string

const NS = 'po-confirm'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const companyB = seedId('company:B')
const siteA1 = seedId('site:A1')
const P1 = seedId('party:P1')
const P2 = seedId('party:P2')
const leather = seedId('product:item:leather')
const protector = seedId('product:item:protector')
const leatherBLK = seedId('product:item-colour:leather:BLK')
const ORDERS_P2 = 'orders.p2@example.com'
const FAKE_VAT = '12345670009'
const today = () => businessDate(new Date())

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const count = async (sql: string, values: unknown[] = []): Promise<number> => (await one<{ n: number }>(sql, values)).n
let counter = 0
const key = (label = 'k'): string => `poc-${label}-${++counter}-${newId()}`

async function as(method: Method, url: string, body?: unknown, status = 200, headers: Record<string, string> = {}): Promise<Json> {
  const answer = await buyer.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}), { headers })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties })
const SESSIONS: Record<string, () => SessionContext> = {
  viewer: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['purchasing.view'])] }),
  companyB: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['purchasing.view', 'purchasing.manage', 'purchasing.send', 'money.cost'], [companyB])] }),
  brandOnly: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['purchasing.view', 'purchasing.manage', 'money.cost'], 'all', [P1])] }),
  otherTenant: () => ({ audience: 'office', tenantId: other.id, actorId: newId(), grants: [grant(['purchasing.view', 'purchasing.manage', 'purchasing.send', 'money.cost'])] }),
  floor: () => ({ audience: 'floor', tenantId: tenant, actorId: newId(), siteId: siteA1, deviceId: newId(), grants: [{ permissions: ['purchasing.view', 'floor.work'], companies: [companyA], sites: [siteA1], parties: 'all' }] }),
  partner: () => ({ audience: 'partner', tenantId: tenant, actorId: newId(), partyId: P2, grants: [{ permissions: ['purchasing.view', 'links.open', 'links.confirm'], companies: 'all', sites: 'all', parties: [P2] }] }),
}
const wall = (session: string, method: Method, url: string, payload?: unknown) =>
  walls.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })

/** A request of the supplier's browser: only the link's token, no cookie. */
const viaLink = (token: string | null, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  h.app.inject({
    method,
    url,
    headers: { ...(token === null ? {} : { 'x-factory-link': token }), 'user-agent': 'SeedBrowser/1.0', ...(method === 'POST' ? { 'idempotency-key': key('link') } : {}) },
    ...(method === 'POST' ? { payload: (payload ?? {}) as object } : {}),
  })
const page = async (token: string): Promise<Json> => {
  const answer = await viaLink(token, 'GET', '/link/purchase-order')
  expect(answer.statusCode, answer.body).toBe(200)
  return answer.json()
}

const orderUrl = (id: string) => `/purchasing/orders/${id}`
const eventsOf = async (subject: string) => (await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])).map((row) => row.type)
const system = () => callerFor(h.database, systemContext(tenant, newId()))
const tokenOf = (outboundId: string): string => {
  const mail = h.ses.mails.find((entry) => entry.outboundId === outboundId)
  return mail ? decodeURIComponent(/#token=(\S+)/.exec(textOf(mail.raw))?.[1] ?? '') : ''
}

/** A draft for P2 at A1: 105 ft² of black leather (in 30 days) and 24 protectors (in 35 days). */
async function draftOrder(): Promise<Json> {
  let draft = (await as('POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2, incoterms: 'EXW Seedville' }, 201)).order
  draft = (await as('POST', `${orderUrl(draft.id)}/lines`, { version: draft.version, itemId: leather, itemColourId: leatherBLK, quantity: '105', uom: 'FT2', needDate: addDays(today(), 30), areaTolerancePct: '1', thicknessMinMm: '1.1', thicknessMaxMm: '1.3' }, 201)).order
  return (await as('POST', `${orderUrl(draft.id)}/lines`, { version: draft.version, itemId: protector, quantity: '24', needDate: addDays(today(), 35) }, 201)).order
}

/** Sends a draft; returns the order as sent and the token its mail carried. */
async function sent(): Promise<{ order: Json; token: string; linkId: string }> {
  const draft = await draftOrder()
  const answer = await as('POST', `${orderUrl(draft.id)}/send`, { version: draft.version }, 200, { 'idempotency-key': key('send') })
  return { order: answer.order, token: tokenOf(answer.sent.emailId), linkId: answer.sent.link.id }
}

/** Every price-looking key or a known price of the seed in a JSON answer (none may be there). */
function priceTraces(body: unknown): string[] {
  const text = JSON.stringify(body)
  return [/price/i, /amount/i, /cost/i, /"6\.5/, /"4\.2/, /:44100\b/, /:15600\b/, /:59700\b/, /internalNote/, /sentById/, /createdById/].filter((pattern) => pattern.test(text)).map(String)
}

/** The secret part of a token is in no stored row. */
async function tokenInNoRow(token: string): Promise<void> {
  const secret = token.split('.').at(-1)!
  for (const [table, column] of [['AuditLog', 'concat(before::text, after::text, reason)'], ['OutboxEvent', 'payload::text'], ['IdempotencyReceipt', 'response::text'], ['Message', '"bodyText"'], ['EmailOutbound', 'subject'], ['OneOffLink', '"tokenHash"'], ['LinkEvidence', 'concat("typedName", "userAgent", "ipHash")']] as const) {
    expect(await count(`SELECT count(*)::int AS n FROM "${table}" WHERE ${column} LIKE $1`, [`%${secret}%`]), table).toBe(0)
  }
}

beforeAll(async () => {
  h = await startHarness('po_confirm')
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
  // Company A's letterhead (the send needs it).
  await admin(`UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3, "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA, `IT${FAKE_VAT}`, FAKE_VAT])
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const buyerUser = await addUser(h, seedTenant, { email: 'bianca.buyer@seed-a.example.com', role: 'buyer' })
  buyerId = (await one<{ id: string }>('SELECT id FROM "User" WHERE email = $1', [buyerUser.email])).id
  other = await addTenant(h, 'po-confirm-other')
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

describe('the link page and "confirm all as asked" (SCM-085; no price on the link)', () => {
  let order: Json
  let token: string
  let linkId: string
  let sentVersion: number

  it("opens the sent order in the supplier's terms, with the leather specs and without any price; reading uses nothing", async () => {
    ;({ order, token, linkId } = await sent())
    sentVersion = order.version
    const view = await page(token)
    const company = await one<{ legalName: string }>('SELECT "legalName" FROM "Company" WHERE id = $1', [companyA])
    const buyerName = (await one<{ displayName: string }>('SELECT "displayName" FROM "User" WHERE id = $1', [buyerId])).displayName
    expect(view).toMatchObject({
      order: { id: order.id, number: order.number, status: 'SENT', revision: 1, incoterms: 'EXW Seedville', version: order.version },
      from: { legalName: company.legalName, buyerName },
      deliverTo: { name: expect.any(String), line1: expect.any(String) },
      canAnswer: true,
      message: null,
      answers: [
        { action: 'confirm', typedName: 'optional', email: false },
        { action: 'decline', typedName: 'optional', email: false },
      ],
      lineAnswers: ['AS_ASKED', 'OTHER', 'SPLIT', 'CANNOT_DELIVER'],
      declineReasons: ['NO_CAPACITY', 'MATERIAL_NOT_AVAILABLE', 'OTHER'],
      document: 'The PDF of this order is in the e-mail we sent you.',
    })
    expect(view.lines).toEqual([
      expect.objectContaining({ seq: 10, code: 'SEED-ART-100', name: 'Seed cowhide 1.2 mm', colour: { name: 'Black', supplierCode: 'S-001' }, quantity: '105.0000', uom: 'FT2', baseUom: 'FT2', needDate: addDays(today(), 30), thicknessMinMm: '1.1', thicknessMaxMm: '1.3', oneDyeBatch: true, areaTolerancePct: '1', estimatedHides: 2, requiresCrViTest: true, confirmedQuantity: null }),
      expect.objectContaining({ seq: 20, quantity: '24.0000', uom: 'PCS', needDate: addDays(today(), 35), colour: null }),
    ])
    expect(priceTraces(view)).toEqual([])
    expect(await one('SELECT uses, "lastUsedAt" FROM "OneOffLink" WHERE id = $1', [linkId])).toEqual({ uses: 0, lastUsedAt: null })
    expect(await count('SELECT count(*)::int AS n FROM "LinkEvidence" WHERE "linkId" = $1', [linkId])).toBe(0)
    // The office's own answer view of the waiting order.
    expect(await as('GET', `${orderUrl(order.id)}/answer`)).toMatchObject({ answer: 'WAITING', confirmation: null, decline: null, evidence: [], links: [{ id: linkId, state: 'LIVE' }] })
  })

  it('confirm all as asked → CONFIRMED by LINK, every line confirmed as ordered, the evidence kept, the link used once', async () => {
    const answered = await viaLink(token, 'POST', '/link/purchase-order/confirm', { version: order.version, mode: 'ALL_AS_ASKED', typedName: '  Mario   Rossi ', supplierRef: 'OC-4711', note: 'Grazie, consegna come richiesto.' })
    expect(answered.statusCode, answered.body).toBe(200)
    const body = answered.json()
    const buyerName = (await one<{ displayName: string }>('SELECT "displayName" FROM "User" WHERE id = $1', [buyerId])).displayName
    expect(body).toMatchObject({ outcome: 'CONFIRMED', summary: 'all 2 lines as asked', done: `Confirmed — thank you. ${buyerName} sees it now. Need to change something later? Reply to our e-mail.`, canAnswer: false, order: { status: 'CONFIRMED', confirmedVia: 'LINK', confirmedByName: 'Mario Rossi', supplierRef: 'OC-4711' } })
    expect(priceTraces(body)).toEqual([])

    expect(await one('SELECT status, "confirmedVia", "confirmLinkId", "confirmedByName", "supplierRef", "confirmNote", "confirmedAt" IS NOT NULL AS at FROM "PurchaseOrder" WHERE id = $1', [order.id])).toEqual({
      status: 'CONFIRMED',
      confirmedVia: 'LINK',
      confirmLinkId: linkId,
      confirmedByName: 'Mario Rossi',
      supplierRef: 'OC-4711',
      confirmNote: 'Grazie, consegna come richiesto.',
      at: true,
    })
    expect(await admin('SELECT seq, quantity::text AS quantity, "confirmedQuantity"::text AS confirmed, "confirmedDate"::text AS date, "needDate"::text AS need FROM "PurchaseOrderLine" WHERE "purchaseOrderId" = $1 ORDER BY seq', [order.id])).toEqual([
      { seq: 10, quantity: '105.0000', confirmed: '105.0000', date: addDays(today(), 30), need: addDays(today(), 30) },
      { seq: 20, quantity: '24.0000', confirmed: '24.0000', date: addDays(today(), 35), need: addDays(today(), 35) },
    ])
    expect(await one('SELECT action, "useNumber", "typedName", "emailCheck", "ipHash" IS NOT NULL AS hashed, "userAgent" FROM "LinkEvidence" WHERE "linkId" = $1', [linkId])).toEqual({ action: 'CONFIRMED', useNumber: 1, typedName: 'Mario Rossi', emailCheck: 'NOT_ASKED', hashed: true, userAgent: 'SeedBrowser/1.0' })
    expect(await one('SELECT uses FROM "OneOffLink" WHERE id = $1', [linkId])).toEqual({ uses: 1 })
    expect(await eventsOf(order.id)).toEqual(expect.arrayContaining(['purchase_order.sent', 'purchase_order.confirmed']))
    const audit = await one('SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = $2', [order.id, 'purchasing.confirmByLink'])
    expect(audit.after).toMatchObject({ status: 'CONFIRMED', channel: 'LINK', linkId, typedName: 'Mario Rossi', summary: 'all 2 lines as asked', lines: [{ seq: 10, kind: 'AS_ASKED' }, { seq: 20, kind: 'AS_ASKED' }] })
    await tokenInNoRow(token)
  })

  it('a second answer is refused (one use): every later request of the link is the one 404', async () => {
    for (const [method, url, payload] of [
      ['POST', '/link/purchase-order/confirm', { version: order.version + 1, mode: 'ALL_AS_ASKED' }],
      ['POST', '/link/purchase-order/decline', { version: order.version + 1, reason: 'NO_CAPACITY' }],
      ['GET', '/link/purchase-order', undefined],
    ] as const) {
      const again = await viaLink(token, method, url, payload)
      expect(again.statusCode, url).toBe(404)
      expect(again.json().error.message).toBe(LINK_UNAVAILABLE)
    }
    expect(await count('SELECT count(*)::int AS n FROM "LinkEvidence" WHERE "linkId" = $1', [linkId])).toBe(1)
  })

  it("the office sees the answer at once: asked against confirmed per line, who and when, the link's evidence", async () => {
    const answer = await as('GET', `${orderUrl(order.id)}/answer`)
    expect(answer).toMatchObject({
      status: 'CONFIRMED',
      answer: 'CONFIRMED',
      words: 'Confirmed by the supplier.',
      confirmation: { via: 'LINK', linkId, byName: 'Mario Rossi', supplierRef: 'OC-4711', note: 'Grazie, consegna come richiesto.' },
      decline: null,
      lines: [
        { seq: 10, item: { code: expect.any(String), name: 'Seed cowhide 1.2 mm' }, colour: 'Black', asked: { quantity: '105.0000', uom: 'FT2' }, confirmed: { quantity: '105.0000', date: addDays(today(), 30) }, changes: [] },
        { seq: 20, asked: { quantity: '24.0000', uom: 'PCS' }, confirmed: { quantity: '24.0000' }, changes: [] },
      ],
      evidence: [{ linkId, action: 'CONFIRMED', useNumber: 1, typedName: 'Mario Rossi', ipHash: expect.any(String), userAgent: 'SeedBrowser/1.0' }],
      links: [{ id: linkId, state: 'USED_UP' }],
    })
  })

  it("tells the buyer: one internal note on the order's thread from the worker's handler, mentioning who sent the order", async () => {
    const event = await one<{ id: string; type: string; payload: unknown }>(`SELECT id, type, payload FROM "OutboxEvent" WHERE subject = $1 AND type = 'purchase_order.confirmed'`, [order.id])
    await tellBuyer(system(), { eventId: event.id, type: event.type, payload: event.payload })
    await tellBuyer(system(), { eventId: event.id, type: event.type, payload: event.payload })
    const notes = await admin(`SELECT m."bodyText", m.audience, m."authorKind", m."mentionedUserIds" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordId" = $1 AND m.direction = 'INTERNAL_NOTE'`, [order.id])
    expect(notes).toEqual([
      {
        bodyText: `The supplier confirmed ${order.number} through its link by Mario Rossi (their reference OC-4711): all 2 lines as asked.\nTheir note: Grazie, consegna come richiesto.`,
        audience: 'OFFICE',
        authorKind: 'SYSTEM',
        mentionedUserIds: [buyerId],
      },
    ])
  })

  it('a cancel decided before the answer finds the order confirmed: 409, and a confirmed order is not cancelled here', async () => {
    const stale = await as('POST', `${orderUrl(order.id)}/cancel`, { version: sentVersion, reason: 'Covered elsewhere' }, 409)
    expect(stale.error.message).toMatch(/changed since it was read/)
    const current = (await as('GET', orderUrl(order.id))).order
    expect((await as('POST', `${orderUrl(order.id)}/cancel`, { version: current.version, reason: 'Covered elsewhere' }, 409)).error.message).toMatch(/^The supplier confirmed this order: it is a contract now/)
    expect(await one('SELECT status FROM "PurchaseOrder" WHERE id = $1', [order.id])).toEqual({ status: 'CONFIRMED' })
  })
})

describe('decline (the whole order, or every line it cannot deliver)', () => {
  it('declines with a reason: DECLINED with the words, the lines stay unconfirmed, the buyer is told', async () => {
    const { order, token, linkId } = await sent()
    // "Another reason" needs its words: refused, nothing used.
    const refused = await viaLink(token, 'POST', '/link/purchase-order/decline', { version: order.version, reason: 'OTHER' })
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error.issues).toEqual([{ path: 'body/note', message: 'Say why you decline the order.' }])
    expect(await one('SELECT uses FROM "OneOffLink" WHERE id = $1', [linkId])).toEqual({ uses: 0 })

    const declined = await viaLink(token, 'POST', '/link/purchase-order/decline', { version: order.version, reason: 'MATERIAL_NOT_AVAILABLE', note: 'Pelli esaurite fino a gennaio', typedName: 'Luca Bianchi' })
    expect(declined.statusCode, declined.body).toBe(200)
    expect(declined.json()).toMatchObject({ outcome: 'DECLINED', summary: null, order: { status: 'DECLINED', declineReason: 'The material is not available: Pelli esaurite fino a gennaio' } })
    expect(await one('SELECT status, "declineReason", "confirmedAt" FROM "PurchaseOrder" WHERE id = $1', [order.id])).toEqual({ status: 'DECLINED', declineReason: 'The material is not available: Pelli esaurite fino a gennaio', confirmedAt: null })
    expect(await count('SELECT count(*)::int AS n FROM "PurchaseOrderLine" WHERE "purchaseOrderId" = $1 AND ("confirmedQuantity" IS NOT NULL OR "confirmedDate" IS NOT NULL)', [order.id])).toBe(0)
    expect(await one('SELECT action, "typedName" FROM "LinkEvidence" WHERE "linkId" = $1', [linkId])).toEqual({ action: 'DECLINED', typedName: 'Luca Bianchi' })
    const event = await one<{ id: string; type: string; payload: unknown }>(`SELECT id, type, payload FROM "OutboxEvent" WHERE subject = $1 AND type = 'purchase_order.declined'`, [order.id])
    await tellBuyer(system(), { eventId: event.id, type: event.type, payload: event.payload })
    const note = await one<{ bodyText: string }>(`SELECT m."bodyText" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordId" = $1 AND m.direction = 'INTERNAL_NOTE'`, [order.id])
    expect(note.bodyText).toBe(`The supplier declined ${order.number} through its link by Luca Bianchi.\nThe material is not available: Pelli esaurite fino a gennaio\nChange the order and send it again, or cancel it.`)
    expect(await as('GET', `${orderUrl(order.id)}/answer`)).toMatchObject({ answer: 'DECLINED', decline: { reason: 'The material is not available: Pelli esaurite fino a gennaio' }, lines: [{ confirmed: null }, { confirmed: null }] })
  })

  it('answering every line "cannot deliver" is the decline, with each line\'s reason', async () => {
    const { order, token } = await sent()
    const lines = (await page(token)).lines as Json[]
    const declined = await viaLink(token, 'POST', '/link/purchase-order/confirm', { version: order.version, mode: 'BY_LINE', lines: lines.map((line) => ({ lineId: line.id, answer: 'CANNOT_DELIVER', reason: 'Fermo produzione' })) })
    expect(declined.statusCode, declined.body).toBe(200)
    expect(declined.json()).toMatchObject({ outcome: 'DECLINED', order: { status: 'DECLINED' } })
    const row = await one<{ declineReason: string }>('SELECT "declineReason" FROM "PurchaseOrder" WHERE id = $1', [order.id])
    expect(row.declineReason).toBe(
      [
        'Cannot deliver any line of the order.',
        `Line 10: cannot deliver (asked 105 ft² by ${addDays(today(), 30)}). Reason: Fermo produzione`,
        `Line 20: cannot deliver (asked 24 PCS by ${addDays(today(), 35)}). Reason: Fermo produzione`,
      ].join('\n'),
    )
    expect(await one('SELECT action FROM "LinkEvidence" e JOIN "OneOffLink" l ON l.id = e."linkId" WHERE l."recordId" = $1', [order.id])).toEqual({ action: 'DECLINED' })
  })
})

describe('changes per line are a proposal: the buyer accepts or refuses it (SCM-086; P2, answer A)', () => {
  let proposed: { order: Json; token: string; linkId: string }

  it('other quantities and dates and a split wait for the buyer: CHANGES_PROPOSED, the proposal on each line, nothing confirmed', async () => {
    proposed = await sent()
    const { order, token, linkId } = proposed
    const lines = (await page(token)).lines as Json[]
    const answered = await viaLink(token, 'POST', '/link/purchase-order/confirm', {
      version: order.version,
      mode: 'BY_LINE',
      typedName: 'Mario Rossi',
      supplierRef: 'OC-5000',
      note: 'Possiamo anticipare la prima parte.',
      lines: [
        { lineId: lines[0]!.id, answer: 'SPLIT', deliveries: [{ quantity: '55', date: addDays(today(), 40) }, { quantity: '50', date: addDays(today(), 32) }], reason: 'Due bagni di tintura' },
        { lineId: lines[1]!.id, answer: 'OTHER', quantity: '12', date: addDays(today(), 38), reason: 'Solo 12 a magazzino' },
      ],
    })
    expect(answered.statusCode, answered.body).toBe(200)
    const buyerName = (await one<{ displayName: string }>('SELECT "displayName" FROM "User" WHERE id = $1', [buyerId])).displayName
    expect(answered.json()).toMatchObject({ outcome: 'PROPOSED', summary: '2 later dates · 1 other quantity · 1 split', done: `Thank you: your changes are with ${buyerName}, who accepts or refuses them. You will hear back by e-mail.`, order: { status: 'CHANGES_PROPOSED', confirmedAt: null } })
    expect(priceTraces(answered.json())).toEqual([])
    expect(await one('SELECT status, "proposalLinkId", "proposedByName", "proposalSupplierRef", "proposalNote", "proposedAt" IS NOT NULL AS at, "proposalDecision", "confirmedAt" FROM "PurchaseOrder" WHERE id = $1', [order.id])).toEqual({
      status: 'CHANGES_PROPOSED',
      proposalLinkId: linkId,
      proposedByName: 'Mario Rossi',
      proposalSupplierRef: 'OC-5000',
      proposalNote: 'Possiamo anticipare la prima parte.',
      at: true,
      proposalDecision: null,
      confirmedAt: null,
    })
    // Nothing is confirmed: the plan keeps the need dates and a receipt the ordered quantities until the buyer accepts.
    expect(await admin('SELECT seq, "confirmedQuantity", "confirmedDate", "proposedQuantity"::text AS q, "proposedDate"::text AS d, "proposedSplitQuantity"::text AS q2, "proposedSplitDate"::text AS d2, "proposalReason" AS reason FROM "PurchaseOrderLine" WHERE "purchaseOrderId" = $1 ORDER BY seq', [order.id])).toEqual([
      { seq: 10, confirmedQuantity: null, confirmedDate: null, q: '50.0000', d: addDays(today(), 32), q2: '55.0000', d2: addDays(today(), 40), reason: 'Due bagni di tintura' },
      { seq: 20, confirmedQuantity: null, confirmedDate: null, q: '12.0000', d: addDays(today(), 38), q2: null, d2: null, reason: 'Solo 12 a magazzino' },
    ])
    expect(await one('SELECT action, uses FROM "LinkEvidence" e JOIN "OneOffLink" l ON l.id = e."linkId" WHERE l.id = $1', [linkId])).toEqual({ action: 'CONFIRMED', uses: 1 })
    expect(await eventsOf(order.id)).toEqual(expect.arrayContaining(['purchase_order.changes_proposed']))
    expect(await eventsOf(order.id)).not.toContain('purchase_order.confirmed')

    const event = await one<{ id: string; type: string; payload: unknown }>(`SELECT id, type, payload FROM "OutboxEvent" WHERE subject = $1 AND type = 'purchase_order.changes_proposed'`, [order.id])
    await tellBuyer(system(), { eventId: event.id, type: event.type, payload: event.payload })
    const note = await one<{ bodyText: string }>(`SELECT m."bodyText" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordId" = $1 AND m.direction = 'INTERNAL_NOTE'`, [order.id])
    expect(note.bodyText).toBe(
      [
        `The supplier proposed changes to ${order.number} through its link by Mario Rossi (their reference OC-5000): 2 later dates · 1 other quantity · 1 split.`,
        `Line 10: in two deliveries, 50 ft² by ${addDays(today(), 32)} and 55 ft² by ${addDays(today(), 40)} (asked 105 ft² by ${addDays(today(), 30)}). Reason: Due bagni di tintura`,
        `Line 20: 12 PCS by ${addDays(today(), 38)} (asked 24 PCS by ${addDays(today(), 35)}). Reason: Solo 12 a magazzino`,
        'Their note: Possiamo anticipare la prima parte.',
        'Accept or refuse them on the order: until then nothing is confirmed and the plan keeps the dates asked.',
      ].join('\n'),
    )
    expect(await as('GET', `${orderUrl(order.id)}/answer`)).toMatchObject({
      answer: 'CHANGES_PROPOSED',
      words: 'The supplier proposed changes: accept or refuse them.',
      confirmation: null,
      proposal: { linkId, byName: 'Mario Rossi', supplierRef: 'OC-5000', summary: '2 later dates · 1 other quantity · 1 split', decision: null },
      lines: [
        { seq: 10, proposed: { kind: 'SPLIT', quantity: '105.0000', date: addDays(today(), 40), changes: ['SPLIT', 'LATER'] }, confirmed: null },
        { seq: 20, proposed: { kind: 'OTHER', quantity: '12.0000', date: addDays(today(), 38), changes: ['LATER', 'LESS'] }, confirmed: null },
      ],
    })
  })

  it('while the buyer decides: no cancel, no new link, no receipt (accept or refuse the changes first)', async () => {
    const current = (await as('GET', orderUrl(proposed.order.id))).order
    expect((await as('POST', `${orderUrl(current.id)}/cancel`, { version: current.version, reason: 'No' }, 409)).error.message).toMatch(/accept or refuse the supplier's changes first/)
    expect((await as('POST', `${orderUrl(current.id)}/send-link`, { version: current.version }, 409, { 'idempotency-key': key('link') })).error.message).toMatch(/accept or refuse the supplier's changes first/)
    // The trigger holds it too: CHANGES_PROPOSED leaves only by the buyer's decision.
    await expect(admin(`UPDATE "PurchaseOrder" SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'OFFICE' WHERE id = $1`, [current.id])).rejects.toThrow(/leaves CHANGES_PROPOSED only by the buyer's decision/)
    await expect(admin(`UPDATE "PurchaseOrder" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'x' WHERE id = $1`, [current.id])).rejects.toThrow(/cannot move from CHANGES_PROPOSED to CANCELLED/)
  })

  it('the buyer accepts: CONFIRMED with the proposal as the confirmation (a split: the whole quantity by the later date); the supplier is told', async () => {
    const { order, linkId } = proposed
    const current = (await as('GET', orderUrl(order.id))).order
    expect((await wall('viewer', 'POST', `${orderUrl(order.id)}/proposal/accept`, { version: current.version })).statusCode).toBe(403)
    expect((await as('POST', `${orderUrl(order.id)}/proposal/accept`, { version: current.version - 1 }, 409)).error.message).toMatch(/changed since it was read/)
    const accepted = await as('POST', `${orderUrl(order.id)}/proposal/accept`, { version: current.version, message: 'A presto.' })
    expect(accepted).toMatchObject({ supplierTold: true, order: { status: 'CONFIRMED', confirmedVia: 'LINK', confirmedByName: 'Mario Rossi', supplierRef: 'OC-5000', confirmNote: 'Possiamo anticipare la prima parte.' } })
    expect(await admin('SELECT seq, "confirmedQuantity"::text AS q, "confirmedDate"::text AS d FROM "PurchaseOrderLine" WHERE "purchaseOrderId" = $1 ORDER BY seq', [order.id])).toEqual([
      { seq: 10, q: '105.0000', d: addDays(today(), 40) },
      { seq: 20, q: '12.0000', d: addDays(today(), 38) },
    ])
    expect(await one('SELECT "confirmLinkId", "proposalDecision", "proposalDecidedById", "proposalDecidedAt" IS NOT NULL AS at FROM "PurchaseOrder" WHERE id = $1', [order.id])).toEqual({ confirmLinkId: linkId, proposalDecision: 'ACCEPTED', proposalDecidedById: buyerId, at: true })
    const mail = await one<{ subject: string; to: string[]; bodyText: string }>(`SELECT o.subject, o.to, m."bodyText" FROM "EmailOutbound" o JOIN "Message" m ON m.id = o."messageId" WHERE o."recordId" = $1 AND o.subject LIKE '%modifiche accettate'`, [order.id])
    expect(mail).toMatchObject({ subject: `Ordine di acquisto ${order.number}: modifiche accettate`, to: [ORDERS_P2] })
    expect(mail.bodyText).toContain('A presto.')
    const event = await one<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE subject = $1 AND type = 'purchase_order.confirmed'`, [order.id])
    expect(event.payload).toMatchObject({ channel: 'LINK', linkId, proposalAccepted: true })
    expect(await as('GET', `${orderUrl(order.id)}/answer`)).toMatchObject({ answer: 'CONFIRMED', proposal: { decision: 'ACCEPTED' }, lines: [{ confirmed: { quantity: '105.0000' }, changes: ['LATER'] }, { confirmed: { quantity: '12.0000' }, changes: ['LATER', 'LESS'] }] })
    const after = (await as('GET', orderUrl(order.id))).order
    expect((await as('POST', `${orderUrl(order.id)}/proposal/accept`, { version: after.version }, 409)).error.message).toBe('The order has no proposal waiting for a decision.')
  })

  it('the buyer refuses: back to SENT, nothing confirmed; a new link lets the supplier answer again, and its new proposal clears the old decision', async () => {
    const { order, token } = await sent()
    const lines = (await page(token)).lines as Json[]
    const answer = await viaLink(token, 'POST', '/link/purchase-order/confirm', { version: order.version, mode: 'BY_LINE', lines: [{ lineId: lines[0]!.id, answer: 'CANNOT_DELIVER', reason: 'Colore fuori produzione' }, { lineId: lines[1]!.id, answer: 'AS_ASKED' }] })
    expect(answer.json()).toMatchObject({ outcome: 'PROPOSED', summary: '1 line as asked · 1 line it cannot deliver' })
    let current = (await as('GET', orderUrl(order.id))).order
    const refused = await as('POST', `${orderUrl(order.id)}/proposal/refuse`, { version: current.version, note: 'Serve tutta la pelle nera' })
    expect(refused).toMatchObject({ order: { status: 'SENT' }, next: expect.stringMatching(/^Nothing is confirmed/) })
    expect(await one('SELECT status, "proposalDecision", "proposalDecisionNote", "proposalDecidedById" FROM "PurchaseOrder" WHERE id = $1', [order.id])).toEqual({ status: 'SENT', proposalDecision: 'REFUSED', proposalDecisionNote: 'Serve tutta la pelle nera', proposalDecidedById: buyerId })
    expect(await count('SELECT count(*)::int AS n FROM "PurchaseOrderLine" WHERE "purchaseOrderId" = $1 AND "confirmedQuantity" IS NOT NULL', [order.id])).toBe(0)
    expect(await eventsOf(order.id)).toEqual(expect.arrayContaining(['purchase_order.proposal_refused']))

    current = refused.order
    const again = await as('POST', `${orderUrl(order.id)}/send-link`, { version: current.version, message: 'Ci serve tutta la quantità: può riconsiderare?' }, 200, { 'idempotency-key': key('link') })
    const fresh = tokenOf(again.link.emailId)
    const view = await page(fresh)
    expect(view.canAnswer).toBe(true)
    const second = await viaLink(fresh, 'POST', '/link/purchase-order/confirm', { version: view.order.version, mode: 'BY_LINE', lines: [{ lineId: lines[0]!.id, answer: 'OTHER', date: addDays(today(), 45), reason: 'Riordino dalla conceria' }, { lineId: lines[1]!.id, answer: 'AS_ASKED' }] })
    expect(second.statusCode, second.body).toBe(200)
    expect(await one('SELECT status, "proposalDecision", "proposalDecidedAt", "proposalDecidedById", "proposalDecisionNote" FROM "PurchaseOrder" WHERE id = $1', [order.id])).toEqual({ status: 'CHANGES_PROPOSED', proposalDecision: null, proposalDecidedAt: null, proposalDecidedById: null, proposalDecisionNote: null })
    expect(await one('SELECT "proposedQuantity"::text AS q, "proposedDate"::text AS d, "proposalReason" AS reason FROM "PurchaseOrderLine" WHERE id = $1', [lines[0]!.id])).toEqual({ q: '105.0000', d: addDays(today(), 45), reason: 'Riordino dalla conceria' })
  })
})

describe('refusals, races and walls', () => {
  it('an incomplete answer is refused with every problem at once, and uses nothing', async () => {
    const { order, token, linkId } = await sent()
    const lines = (await page(token)).lines as Json[]
    const refused = await viaLink(token, 'POST', '/link/purchase-order/confirm', { version: order.version, mode: 'BY_LINE', lines: [{ lineId: lines[0]!.id, answer: 'OTHER', reason: 'r' }] })
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error.issues).toEqual([
      { path: 'body/lines/0', message: 'Give the other quantity, the other date, or both.' },
      { path: 'body/lines', message: 'Answer line 20 too.' },
    ])
    expect(await one('SELECT uses FROM "OneOffLink" WHERE id = $1', [linkId])).toEqual({ uses: 0 })
    // A stale version (the page showed another one) is a 409: reload.
    expect((await viaLink(token, 'POST', '/link/purchase-order/confirm', { version: order.version - 1, mode: 'ALL_AS_ASKED' })).statusCode).toBe(409)
    expect(await one('SELECT status FROM "PurchaseOrder" WHERE id = $1', [order.id])).toEqual({ status: 'SENT' })
  })

  it('goods received before the answer: the order needs no confirmation any more (409 in words)', async () => {
    const { order, token, linkId } = await sent()
    await admin(`UPDATE "PurchaseOrder" SET status = 'PARTLY_RECEIVED', version = version + 1 WHERE id = $1`, [order.id])
    const view = await page(token)
    expect(view).toMatchObject({ canAnswer: false, answers: [], message: 'Goods of this order were received already: it needs no confirmation any more.' })
    const refused = await viaLink(token, 'POST', '/link/purchase-order/confirm', { version: view.order.version, mode: 'ALL_AS_ASKED' })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.message).toBe('Goods of this order were received already: it needs no confirmation any more.')
    expect(await one('SELECT uses FROM "OneOffLink" WHERE id = $1', [linkId])).toEqual({ uses: 0 })
  })

  it('answered at the same time as a cancel: exactly one wins, and the order is wholly confirmed or wholly cancelled', async () => {
    for (let round = 0; round < 3; round++) {
      const { order, token, linkId } = await sent()
      const [confirm, cancel] = await Promise.all([
        viaLink(token, 'POST', '/link/purchase-order/confirm', { version: order.version, mode: 'ALL_AS_ASKED' }),
        buyer.send('POST', `${orderUrl(order.id)}/cancel`, { version: order.version, reason: 'Race' }),
      ])
      const wins = [confirm.statusCode, cancel.status].filter((status) => status === 200)
      expect(wins, `round ${round}: ${confirm.body} / ${JSON.stringify(cancel.body)}`).toHaveLength(1)
      const row = await one<{ status: string }>('SELECT status FROM "PurchaseOrder" WHERE id = $1', [order.id])
      const confirmedLines = await count('SELECT count(*)::int AS n FROM "PurchaseOrderLine" WHERE "purchaseOrderId" = $1 AND "confirmedQuantity" IS NOT NULL', [order.id])
      const link = await one<{ uses: number; revoked: boolean }>('SELECT uses, "revokedAt" IS NOT NULL AS revoked FROM "OneOffLink" WHERE id = $1', [linkId])
      if (confirm.statusCode === 200) expect({ status: row.status, confirmedLines, ...link }).toEqual({ status: 'CONFIRMED', confirmedLines: 2, uses: 1, revoked: false })
      else expect({ status: row.status, confirmedLines, ...link, loser: [404, 409].includes(confirm.statusCode) }).toEqual({ status: 'CANCELLED', confirmedLines: 0, uses: 0, revoked: true, loser: true })
    }
  })

  it("another supplier's link, a link of another purpose and another tenant's token see nothing", async () => {
    const { order } = await sent()
    const forge = async (partyId: string, purpose: string) => {
      const linkId = newId()
      const token = mintLinkToken({ tenantId: tenant, partyId, linkId }).value
      await admin(
        `INSERT INTO "OneOffLink" (id, "tenantId", "companyId", "partyId", purpose, "recordType", "recordId", "tokenHash", email, "expiresAt", "maxUses", "createdById") VALUES ($1, $2, $3, $4, $5::"LinkPurpose", 'PurchaseOrder', $6, $7, NULL, now() + interval '5 days', 1, $8)`,
        [linkId, tenant, companyA, partyId, purpose, order.id, linkTokenHash(token), buyerId],
      )
      return token
    }
    // P1's link that names P2's order: the order is behind P2's wall.
    const p1 = await forge(P1, 'PO_CONFIRM')
    expect((await viaLink(p1, 'GET', '/link/purchase-order')).statusCode).toBe(404)
    expect((await viaLink(p1, 'POST', '/link/purchase-order/confirm', { version: order.version, mode: 'ALL_AS_ASKED' })).statusCode).toBe(404)
    // A document link of P2 opens no order, and cannot confirm one.
    const document = await forge(P2, 'DOCUMENT_VIEW')
    expect((await viaLink(document, 'GET', '/link/purchase-order')).statusCode).toBe(404)
    expect((await viaLink(document, 'POST', '/link/purchase-order/confirm', { version: order.version, mode: 'ALL_AS_ASKED' })).statusCode).toBe(403)
    // Another tenant's token for the same ids.
    const foreign = mintLinkToken({ tenantId: other.id, partyId: P2, linkId: newId() }).value
    expect((await viaLink(foreign, 'GET', '/link/purchase-order')).statusCode).toBe(404)
    expect(await one('SELECT status FROM "PurchaseOrder" WHERE id = $1', [order.id])).toEqual({ status: 'SENT' })
  })

  it('the office answer view: other tenants, companies and suppliers see nothing; no floor or portal route', async () => {
    const { order } = await sent()
    expect((await wall('viewer', 'GET', `${orderUrl(order.id)}/answer`)).statusCode).toBe(200)
    for (const session of ['otherTenant', 'companyB', 'brandOnly']) expect((await wall(session, 'GET', `${orderUrl(order.id)}/answer`)).statusCode, session).toBe(404)
    for (const session of ['floor', 'partner']) {
      expect((await wall(session, 'GET', `${orderUrl(order.id)}/answer`)).statusCode, session).toBe(403)
      expect((await wall(session, 'GET', '/link/purchase-order')).statusCode, session).toBe(403)
    }
  })
})

describe("the supplier's confirmation PDF goes with its answer (B-W1-33 for SCR-100; SCM-090)", () => {
  const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% made-up confirmation: ${text}\n%%EOF\n`)
  const announce = (token: string, bytes: Buffer, extra: Json = {}) =>
    viaLink(token, 'POST', '/link/purchase-order/confirmation', { originalName: 'conferma-ordine.pdf', contentType: 'application/pdf', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...extra })
  const putBytes = (upload: Json, bytes: Buffer) => h.app.inject({ method: 'PUT', url: upload.url, headers: upload.headers, payload: bytes })

  it('announce, send the bytes, complete, confirm with it: the order\'s PDF, shared with the office and this supplier, named in the answer', async () => {
    const { order, token } = await sent()
    const bytes = pdf('OC-77')
    const announced = await announce(token, bytes)
    expect(announced.statusCode, announced.body).toBe(201)
    const { file, upload } = announced.json()
    expect(file).toMatchObject({ originalName: 'conferma-ordine.pdf', sizeBytes: bytes.length, status: 'PENDING_UPLOAD' })
    expect(upload).toMatchObject({ method: 'PUT' })
    expect((await putBytes(upload, bytes)).statusCode).toBeLessThan(300)
    const completed = await viaLink(token, 'POST', `/link/purchase-order/confirmation/${file.id}/complete`)
    expect(completed.statusCode, completed.body).toBe(200)
    expect(completed.json().file).toMatchObject({ id: file.id, status: 'AVAILABLE' })
    expect(await one('SELECT "recordType", "recordId"::text AS "recordId", kind::text AS kind, visibility::text[] AS visibility, "partyId"::text AS "partyId", "createdById" FROM "StoredFile" WHERE id = $1', [file.id])).toEqual({
      recordType: 'PurchaseOrder',
      recordId: order.id,
      kind: 'DOCUMENT',
      visibility: ['OFFICE', 'LINK'],
      partyId: P2,
      createdById: null,
    })
    // Uploading used nothing of the link.
    expect(await one('SELECT uses FROM "OneOffLink" WHERE "recordId" = $1', [order.id])).toEqual({ uses: 0 })

    const view = await page(token)
    const answer = await viaLink(token, 'POST', '/link/purchase-order/confirm', { version: view.order.version, mode: 'ALL_AS_ASKED', supplierRef: 'OC-77', confirmationFileId: file.id })
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.json()).toMatchObject({ outcome: 'CONFIRMED', confirmationFile: { id: file.id, originalName: 'conferma-ordine.pdf', status: 'AVAILABLE' } })
    expect(priceTraces(answer.json())).toEqual([])
    expect(await admin(`SELECT after->>'fileId' AS file, after->>'outcome' AS outcome FROM "AuditLog" WHERE action = 'purchasing.supplierConfirmationFile' AND "recordId" = $1`, [order.id])).toEqual([{ file: file.id, outcome: 'CONFIRMED' }])
    // The buyer finds it among the order's files; the used link uploads nothing more.
    expect((await as('GET', `/files?recordType=PurchaseOrder&recordId=${order.id}`)).files.map((entry: Json) => entry.id)).toContain(file.id)
    expect((await announce(token, pdf('again'))).statusCode).toBe(404)
  })

  it('refuses what is no PDF, a file not ready or of another order, and a file another link would confirm', async () => {
    const first = await sent()
    const second = await sent()
    const notPdf = await announce(first.token, pdf('x'), { contentType: 'image/png', originalName: 'photo.png' })
    expect(notPdf.statusCode, notPdf.body).toBe(400)
    expect(notPdf.json().error.issues).toEqual([{ path: 'body/contentType', message: 'Your confirmation is a PDF (application/pdf).' }])
    const pending = (await announce(first.token, pdf('pending'))).json().file
    // Not sent to the store yet: the answer refuses it, nothing is confirmed.
    const early = await viaLink(first.token, 'POST', '/link/purchase-order/confirm', { version: (await page(first.token)).order.version, mode: 'ALL_AS_ASKED', confirmationFileId: pending.id })
    expect(early.statusCode, early.body).toBe(400)
    expect(early.json().error.issues[0].path).toBe('body/confirmationFileId')
    expect((await page(first.token)).order.status).toBe('SENT')
    // Another order's link neither completes nor names it.
    expect((await viaLink(second.token, 'POST', `/link/purchase-order/confirmation/${pending.id}/complete`)).statusCode).toBe(404)
    const crossed = await viaLink(second.token, 'POST', '/link/purchase-order/confirm', { version: (await page(second.token)).order.version, mode: 'ALL_AS_ASKED', confirmationFileId: pending.id })
    expect(crossed.statusCode, crossed.body).toBe(400)
    expect(await count(`SELECT count(*)::int AS n FROM "StoredFile" WHERE "recordId" = $1`, [second.order.id])).toBe(1)
  })
})

describe('dead links and "ask for a new link" (the address on file only)', () => {
  it('a revoked link answers like garbage; asking again for a revoked, a used, a live link or for garbage sends nothing', async () => {
    const { order, token } = await sent()
    const current = (await as('GET', orderUrl(order.id))).order
    const renewed = await as('POST', `${orderUrl(order.id)}/send-link`, { version: current.version }, 200, { 'idempotency-key': key('link') })
    const live = tokenOf(renewed.link.emailId)
    const garbage = await viaLink('not-a-token', 'GET', '/link/purchase-order')
    const revoked = await viaLink(token, 'GET', '/link/purchase-order')
    expect([garbage.statusCode, revoked.statusCode]).toEqual([404, 404])
    expect(revoked.json().error.message).toBe(garbage.json().error.message)

    const links = await count('SELECT count(*)::int AS n FROM "OneOffLink"')
    const mails = h.ses.mails.length
    for (const header of [null, 'not-a-token', token, live]) {
      const asked = await viaLink(header, 'POST', '/link/purchase-order/renew')
      expect(asked.statusCode).toBe(202)
      expect(asked.json()).toEqual({ status: 'requested', message: RENEW_ANSWER })
    }
    await h.auth.settled()
    expect(await count('SELECT count(*)::int AS n FROM "OneOffLink"')).toBe(links)
    expect(h.ses.mails.length).toBe(mails)
  })

  it('an expired link of an order that still waits: ONE new link, mailed with the PDF to the address on file only; the buyer is told', async () => {
    // Two orders sent now; then the clock passes their links' expiry (the latest need date, 35 days).
    const first = await sent()
    const second = await sent()
    h.clock.set(new Date(Date.now() + 36 * 24 * 60 * 60 * 1000))
    const expired = await viaLink(first.token, 'GET', '/link/purchase-order')
    expect(expired.statusCode).toBe(404)
    expect(expired.json().error.message).toBe(LINK_UNAVAILABLE)

    // The supplier's contact is archived: its address is no longer on file, nothing goes out.
    const contact = await one<{ contactId: string }>('SELECT "contactId" FROM "PurchaseOrder" WHERE id = $1', [second.order.id])
    await admin(`UPDATE "PartyContact" SET status = 'ARCHIVED' WHERE id = $1`, [contact.contactId])
    const before = { links: await count('SELECT count(*)::int AS n FROM "OneOffLink"'), mails: h.ses.mails.length }
    expect((await viaLink(second.token, 'POST', '/link/purchase-order/renew')).statusCode).toBe(202)
    await h.auth.settled()
    expect({ links: await count('SELECT count(*)::int AS n FROM "OneOffLink"'), mails: h.ses.mails.length }).toEqual(before)
    await admin(`UPDATE "PartyContact" SET status = 'ACTIVE' WHERE id = $1`, [contact.contactId])

    expect((await viaLink(first.token, 'POST', '/link/purchase-order/renew')).statusCode).toBe(202)
    await h.auth.settled()
    const made = await admin<{ id: string; email: string; createdById: string; revokedAt: Date | null }>(`SELECT id, email, "createdById", "revokedAt" FROM "OneOffLink" WHERE "recordId" = $1 AND id <> $2`, [first.order.id, first.linkId])
    expect(made).toHaveLength(1)
    expect(made[0]).toMatchObject({ email: ORDERS_P2, createdById: '00000000-0000-7000-8000-000000000000', revokedAt: null })
    const mail = await one<{ id: string; to: string[]; cc: string[]; status: string; attachments: string[] }>(
      `SELECT o.id, o.to, o.cc, o.status, m."attachmentFileIds" AS attachments FROM "EmailOutbound" o JOIN "Message" m ON m.id = o."messageId" WHERE o."recordId" = $1 ORDER BY o."queuedAt" DESC LIMIT 1`,
      [first.order.id],
    )
    expect(mail).toMatchObject({ to: [ORDERS_P2], cc: [], status: 'SENT', attachments: [expect.any(String)] })
    const sentMails = h.ses.mails.filter((entry) => entry.outboundId === mail.id)
    expect(sentMails).toHaveLength(1)
    expect(sentMails[0]!.raw).toContain('.pdf"')
    const fresh = tokenOf(mail.id)
    expect((await page(fresh)).canAnswer).toBe(true)
    await tokenInNoRow(fresh)
    const note = await one<{ bodyText: string }>(`SELECT m."bodyText" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordId" = $1 AND m.direction = 'INTERNAL_NOTE'`, [first.order.id])
    expect(note.bodyText).toMatch(new RegExp(`^The supplier asked for a new link: the old one had expired before it was answered\\. A new one went to ${ORDERS_P2.replace(/\./g, '\\.')}`))
    expect(await eventsOf(first.order.id)).toEqual(expect.arrayContaining(['purchase_order.link_sent']))

    // Asked again with the old token: the order has a live link now, nothing more goes out.
    const mails = h.ses.mails.length
    expect((await viaLink(first.token, 'POST', '/link/purchase-order/renew')).statusCode).toBe(202)
    await h.auth.settled()
    expect(h.ses.mails.length).toBe(mails)
    expect(await count('SELECT count(*)::int AS n FROM "OneOffLink" WHERE "recordId" = $1', [first.order.id])).toBe(2)
  })
})
