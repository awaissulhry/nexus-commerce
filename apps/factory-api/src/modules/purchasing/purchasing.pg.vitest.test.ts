import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/planning/buy'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedProduction } from '../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../adapters/ses/fake'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../platform/auth/roles/system-roles'
import { addTenant, addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../platform/auth/sessions/testing/harness'
import { pdfFlatText } from '../../platform/documents/testing/pdf-text'
import { systemContext } from '../../platform/outbox/system'
import { supplierView } from './supplier-view'

/**
 * Purchase orders (B-W1-30; SCM-050, SCM-053, SCM-054, SCM-055, SCM-075; PLAN §4.7 stage 08-buy) on the local stack: a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the column grants and the
 * …_supply_guards triggers are real), the real app with the real office sign-in (a buyer with two-factor), the local file
 * store for the PDFs, the FAKE SES mailbox (the only place a confirm link's token exists), and a second app with test
 * sessions for the walls. The factory-db seeds up to production: SEED-SO-0001 / 0002 of the jacket, its leather bought by
 * the hide of 52.5 ft² from the supplier P2 (at least 5 hides, 14 days), the protector sold in steps of 12; P2's orders
 * contact orders.p2@example.com. Every name, number and price is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs purchasing`.
 */

let h: Harness
let walls: FastifyInstance
let buyer: Browser
let other: TestTenant

const NS = 'purchasing'
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
const leatherRED = seedId('product:item-colour:leather:RED')
const ORDERS_P2 = 'orders.p2@example.com'
const YEAR = businessDate(new Date()).slice(0, 4)
const FAKE_VAT = '12345670009'
const today = () => businessDate(new Date())

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
let counter = 0
const key = (label = 'k'): string => `po-${label}-${++counter}-${newId()}`

async function as(method: Method, url: string, body?: unknown, status = 200, headers: Record<string, string> = {}): Promise<Json> {
  const answer = await buyer.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}), { headers })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
const refusedAs = async (method: Method, url: string, body: unknown, status: number): Promise<Json> => (await as(method, url, body, status)).error

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties })
const SESSIONS: Record<string, () => SessionContext> = {
  viewer: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['purchasing.view'])] }),
  planner: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['purchasing.view', 'planning.view', 'planning.run'])] }),
  manager: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['purchasing.view', 'purchasing.manage', 'money.cost'])] }),
  clerk: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['purchasing.view', 'purchasing.manage'])] }),
  companyB: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['purchasing.view', 'purchasing.manage', 'purchasing.send', 'money.cost'], [companyB])] }),
  brandOnly: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['purchasing.view', 'purchasing.manage', 'money.cost'], 'all', [P1])] }),
  otherTenant: () => ({ audience: 'office', tenantId: other.id, actorId: newId(), grants: [grant(['purchasing.view', 'purchasing.manage', 'purchasing.send', 'money.cost'])] }),
  floor: () => ({ audience: 'floor', tenantId: tenant, actorId: newId(), siteId: siteA1, deviceId: newId(), grants: [{ permissions: ['purchasing.view', 'purchasing.manage', 'floor.work'], companies: [companyA], sites: [siteA1], parties: 'all' }] }),
  partner: () => ({ audience: 'partner', tenantId: tenant, actorId: newId(), partyId: P2, grants: [{ permissions: ['purchasing.view'], companies: 'all', sites: 'all', parties: [P2] }] }),
}
const wall = (session: string, method: Method, url: string, payload?: unknown) =>
  walls.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })

/** A request of the supplier's browser: only the link's token, no cookie. */
const viaLink = (token: string, method: 'GET' | 'POST', url: string) =>
  h.app.inject({ method, url, headers: { 'x-factory-link': token, ...(method === 'POST' ? { 'idempotency-key': key('link') } : {}) }, ...(method === 'POST' ? { payload: {} } : {}) })

const orderUrl = (id: string) => `/purchasing/orders/${id}`
const eventsOf = async (subject: string) => (await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])).map((row) => row.type)
const latestPlan = () => as('GET', `/planning/runs/latest?siteId=${siteA1}`)
const planLine = (plan: Json, itemId: string, colourId: string | null = null): Json => {
  const line = (plan.lines as Json[]).find((entry) => entry.item.id === itemId && (entry.colour?.id ?? null) === colourId)
  expect(line, `no plan line for ${itemId} ${colourId}`).toBeDefined()
  return line!
}

/** Sends an order; returns the answer and the token the mail carried (read from the fake mailbox only). */
async function send(order: Json, body: Json = {}, idempotencyKey = key('send')): Promise<{ answer: Json; token: string }> {
  const answer = await as('POST', `${orderUrl(order.id)}/send`, { version: order.version, ...body }, 200, { 'idempotency-key': idempotencyKey })
  const mail = h.ses.mails.find((entry) => entry.outboundId === answer.sent?.emailId)
  const token = mail ? decodeURIComponent(/#token=(\S+)/.exec(textOf(mail.raw))?.[1] ?? '') : ''
  return { answer, token }
}

/** A manual draft for P2 at A1 with one protector line needed in 30 days. */
async function manualOrder(): Promise<Json> {
  const created = (await as('POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2, incoterms: 'EXW Seedville' }, 201)).order
  return (await as('POST', `${orderUrl(created.id)}/lines`, { version: created.version, itemId: protector, quantity: '24', needDate: addDays(today(), 30) }, 201)).order
}

beforeAll(async () => {
  h = await startHarness('purchasing')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS }) // parties, product, sales, supply, inventory, floor-auth come with it
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  // Company A's purchase order series, a FAKE file store and a FAKE mail account with a verified conversation address.
  // Its letterhead and site A1's address are completed by the send-check test (they stop a send until then).
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'PURCHASE_ORDER', 'MAIN', $4, 'YEARLY', 'PO-{YYYY}-{N:4}', false)`, [newId(), tenant, companyA, YEAR])
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant])
  const ses = newId()
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses', 'Mail', 'FAKE', 6000, 1000)`, [ses, tenant])
  await admin(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'mail.seed-a.example.com', 'acquisti@mail.seed-a.example.com', 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), tenant, companyA, ses],
  )
  // The jacket's revision is released: the plan explodes both orders.
  await admin(`UPDATE "Style" SET status = 'ACTIVE' WHERE id = $1`, [seedId('product:style:JKT-01')])
  await admin(`UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2 WHERE id = $1`, [seedId('product:revision:JKT-01:1'), actorId])
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const buyerUser = await addUser(h, seedTenant, { email: 'bianca.buyer@seed-a.example.com', role: 'buyer' })
  other = await addTenant(h, 'purchasing-other')
  buyer = new Browser(h.app)
  expect((await buyer.signIn(NS, buyerUser.email, buyerUser.password)).status).toBe(200)
  await enrolTotp(h, buyer)
  walls = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await walls?.close()
  await h?.close()
}, 60_000)

let order: Json
const lineOf = (detail: Json, itemId: string, colourId: string | null = null): Json => (detail.lines as Json[]).find((line) => line.itemId === itemId && line.itemColourId === colourId)!

describe('Draft PO from What to buy & make (SCR-055; SCM-050, SCM-075)', () => {
  let plan: Json

  it('drafts two plan lines of one supplier into ONE new order, the leather by the hide with its specs, and marks them ORDERED', async () => {
    await as('POST', '/planning/runs', { siteId: siteA1 }, 201)
    plan = await latestPlan()
    const black = planLine(plan, leather, leatherBLK)
    const red = planLine(plan, leather, leatherRED)
    expect([black.supplier.id, red.supplier.id]).toEqual([P2, P2])

    const drafted = await as('POST', '/purchasing/from-plan', { lines: [{ id: black.id, version: black.version }, { id: red.id, version: red.version }] })
    expect(drafted.orders).toHaveLength(1)
    expect(drafted.orders[0]).toMatchObject({ created: true, lineCount: 2, number: `PO-${YEAR}-0001` })
    expect(drafted.lines.map((line: Json) => line.requirementId)).toEqual([black.id, red.id])

    order = (await as('GET', orderUrl(drafted.orders[0].id))).order
    expect(order).toMatchObject({ status: 'DRAFT', partyId: P2, siteId: siteA1, companyId: companyA, currency: 'EUR', contact: { email: ORDERS_P2 }, lineCount: 2, netAmount: 264_600 })
    // 186.48 ft² short = 3.55 hides → 4 whole hides → the supplier's minimum of 5; red 353.92 ft² → 7 hides. 4.20 €/ft² × 52.5.
    expect(lineOf(order, leather, leatherBLK)).toMatchObject({
      seq: 10,
      quantity: '5.0000',
      uom: 'HIDE',
      baseQuantity: '262.5000',
      baseUom: 'FT2',
      unitPrice: '220.500000',
      netAmount: 110_250,
      needDate: '2026-12-18',
      estimatedHides: 5,
      grade: 'A',
      thicknessMinMm: '1.1',
      thicknessMaxMm: '1.3',
      oneDyeBatch: true,
      requiresCrViTest: true,
      supplierArticleCode: 'SEED-ART-100',
      supplierColourCode: 'S-001',
      plan: [{ requirementId: black.id, runId: plan.run.id, runStatus: 'DONE', decision: 'ORDERED' }],
    })
    expect(lineOf(order, leather, leatherRED)).toMatchObject({ seq: 20, quantity: '7.0000', baseQuantity: '367.5000', netAmount: 154_350, estimatedHides: 7, supplierColourCode: 'S-002', needDate: '2026-12-04' })

    const after = await latestPlan()
    expect(planLine(after, leather, leatherBLK)).toMatchObject({ decision: 'ORDERED', purchaseOrderLineId: drafted.lines[0].purchaseOrderLineId })
    expect(after.summary).toMatchObject({ inDraftPurchaseOrder: 2 })
    expect(await eventsOf(order.id)).toEqual(['purchase_order.created', 'purchase_order.lines_changed'])
    expect((await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'planning.requirements_decided' AND subject = $1`, [plan.run.id]))[0]!.n).toBe(2)
    const audit = await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "recordId" = ANY($1::uuid[]) ORDER BY at, id`, [[order.id, black.id]])
    expect(audit.map((row) => row.action)).toEqual(expect.arrayContaining(['purchasing.create', 'planning.order', 'purchasing.draftFromPlan']))
  })

  it("adds the next plan line to the supplier's open draft, rounded up to the supplier's steps of 12; Undo opens it again", async () => {
    const protectorLine = planLine(plan, protector)
    const drafted = await as('POST', '/purchasing/from-plan', { lines: [{ id: protectorLine.id, version: protectorLine.version }] })
    expect(drafted.orders).toEqual([expect.objectContaining({ id: order.id, created: false, lineCount: 3 })])
    // 4 short, sold in steps of 12.
    const detail = (await as('GET', orderUrl(order.id))).order
    expect(lineOf(detail, protector)).toMatchObject({ seq: 30, quantity: '12.0000', uom: 'PCS', unitPrice: '6.500000', netAmount: 7_800, estimatedHides: null, oneDyeBatch: false, grade: null })

    const undone = await as('POST', '/purchasing/from-plan/undo', { lines: [drafted.lines[0].purchaseOrderLineId] })
    expect(undone).toEqual({ orders: [{ id: order.id, number: order.number, lineCount: 2, cancelled: false }], reopenedRequirementIds: [protectorLine.id] })
    expect(planLine(await latestPlan(), protector)).toMatchObject({ decision: 'OPEN', purchaseOrderLineId: null })
  })

  it('drafts into a NEW order on request; its Undo cancels the empty draft; a cancelled draft opens its plan lines again', async () => {
    const fresh = planLine(await latestPlan(), protector)
    const drafted = await as('POST', '/purchasing/from-plan', { lines: [{ id: fresh.id, version: fresh.version }], into: [{ supplierId: P2, purchaseOrderId: null }] })
    expect(drafted.orders[0]).toMatchObject({ created: true, lineCount: 1 })
    expect(drafted.orders[0].id).not.toBe(order.id)
    const undone = await as('POST', '/purchasing/from-plan/undo', { lines: [drafted.lines[0].purchaseOrderLineId], cancelOrderIds: [drafted.orders[0].id] })
    expect(undone.orders).toEqual([{ id: drafted.orders[0].id, number: drafted.orders[0].number, lineCount: 0, cancelled: true }])
    expect(await one('SELECT status, "cancelReason" FROM "PurchaseOrder" WHERE id = $1', [drafted.orders[0].id])).toEqual({ status: 'CANCELLED', cancelReason: 'Undo of a draft made from the plan: no line left.' })

    const again = planLine(await latestPlan(), protector)
    const third = await as('POST', '/purchasing/from-plan', { lines: [{ id: again.id, version: again.version }], into: [{ supplierId: P2, purchaseOrderId: null }] })
    const draft = (await as('GET', orderUrl(third.orders[0].id))).order
    const cancelled = await as('POST', `${orderUrl(draft.id)}/cancel`, { version: draft.version, reason: 'Ordered with the leather instead' })
    expect(cancelled).toMatchObject({ order: { status: 'CANCELLED', cancelReason: 'Ordered with the leather instead' }, supplierTold: false })
    expect(planLine(await latestPlan(), protector)).toMatchObject({ decision: 'OPEN', purchaseOrderLineId: null })
  })

  it('a line drafted from a plan that a newer run replaced stays: it is neither removed nor undone (409 in words)', async () => {
    const fresh = planLine(await latestPlan(), protector)
    const drafted = await as('POST', '/purchasing/from-plan', { lines: [{ id: fresh.id, version: fresh.version }] })
    expect(drafted.orders[0]).toMatchObject({ id: order.id, lineCount: 3 })
    const lineId = drafted.lines[0].purchaseOrderLineId
    await as('POST', '/planning/runs', { siteId: siteA1 }, 201)
    let detail = (await as('GET', orderUrl(order.id))).order
    expect((await refusedAs('DELETE', `${orderUrl(order.id)}/lines/${lineId}?version=${detail.version}`, undefined, 409)).message).toMatch(/^A newer plan replaced the plan line 30 was drafted from/)
    expect((await refusedAs('POST', '/purchasing/from-plan/undo', { lines: [lineId] }, 409)).message).toMatch(/Change its quantity, or cancel the order\.$/)
    detail = (await as('GET', orderUrl(order.id))).order
    expect(detail.lineCount).toBe(3)
    // A plan line of the superseded run is no longer drafted.
    const stale = planLine(plan, leather, leatherBLK)
    expect((await refusedAs('POST', '/purchasing/from-plan', { lines: [{ id: stale.id, version: stale.version + 1 }] }, 409)).message).toMatch(/A newer plan replaced this one/)
    // The line can still be changed: its quantity, its need date.
    order = (await as('PATCH', `${orderUrl(order.id)}/lines/${lineId}`, { version: detail.version, quantity: '24' })).order
    expect(lineOf(order, protector)).toMatchObject({ quantity: '24.0000', netAmount: 15_600, version: 2 })
    expect(order.netAmount).toBe(264_600 + 15_600)
  })
})

describe('send: the PDF, the confirm link and the mail (SCM-054, SCM-055)', () => {
  let sent: Json
  let token: string

  it('the send check says what stops it: the letterhead, the delivery address, a blocked supplier', async () => {
    const check = await as('GET', `${orderUrl(order.id)}/send-check`)
    expect(check).toMatchObject({ ready: false, recipient: { name: 'Seed Order Desk', email: ORDERS_P2 }, documentNumber: order.number, language: 'it', subject: `Ordine di acquisto ${order.number}` })
    expect(check.checks.filter((entry: Json) => entry.severity === 'BLOCKS').map((entry: Json) => entry.code)).toEqual(['COMPANY_LEGAL', 'NO_DELIVERY_ADDRESS'])
    expect(check.message).not.toContain('token')
    await admin(`UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3, "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA, `IT${FAKE_VAT}`, FAKE_VAT])
    await admin(`UPDATE "Site" SET address = '{"line1": "Via Esempio 1", "postalCode": "00000", "city": "Seedville", "country": "IT"}'::jsonb WHERE id = $1`, [siteA1])
    // The need dates, moved to 40 days from today (so the send never depends on the calendar).
    for (const line of order.lines as Json[]) order = (await as('PATCH', `${orderUrl(order.id)}/lines/${line.id}`, { version: order.version, needDate: addDays(today(), 40) })).order
    expect((await as('GET', `${orderUrl(order.id)}/send-check`)).ready).toBe(true)

    await admin(`UPDATE "Party" SET status = 'BLOCKED' WHERE id = $1`, [P2])
    try {
      const blocked = await as('GET', `${orderUrl(order.id)}/send-check`)
      expect(blocked.checks.map((entry: Json) => [entry.code, entry.message])).toContainEqual(['SUPPLIER_NOT_ACTIVE', expect.stringMatching(/is blocked: pick another approved source\.$/)])
      expect((await refusedAs('POST', `${orderUrl(order.id)}/send`, { version: order.version }, 409)).message).toMatch(/^The order cannot be sent yet\. .* is blocked/)
      expect((await refusedAs('POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2 }, 409)).message).toMatch(/is blocked: no purchase order goes to it/)
      expect(await admin('SELECT id FROM "StoredFile" WHERE "recordId" = $1', [order.id])).toEqual([])
    } finally {
      await admin(`UPDATE "Party" SET status = 'ACTIVE' WHERE id = $1`, [P2])
    }
  })

  it('sends: the PDF stored with the prices and the leather specs, the link made, the mail queued and sent; the token in no row', async () => {
    ;({ answer: sent, token } = await send(order, {}, 'po-first-send-0001'))
    expect(token).toMatch(/^[0-9a-f-]{36}\.[0-9a-f-]{36}\.[0-9a-f-]{36}\./)
    expect(sent).toMatchObject({ delivery: 'sent', order: { status: 'SENT', revision: 1, send: null }, sent: { revision: 1, to: ORDERS_P2 } })
    order = sent.order
    expect(await one('SELECT status, "sentById", "netAmount", "orderDate" FROM "PurchaseOrder" WHERE id = $1', [order.id])).toMatchObject({ status: 'SENT', netAmount: 280_200, sentById: expect.any(String) })

    const file = await one('SELECT kind, "partyId", visibility::text[] AS visibility, sha256, "contentType", "originalName", "storeAccountId", "storageKey", "sizeBytes" FROM "StoredFile" WHERE id = $1', [sent.sent.documentFileId])
    expect(file).toMatchObject({ kind: 'FISCAL_ARCHIVE', partyId: P2, visibility: ['OFFICE', 'PARTNER'], sha256: sent.sent.documentSha256, contentType: 'application/pdf', originalName: `Ordine di acquisto ${order.number}.pdf` })
    const pdf = await h.files.storage.read(callerFor(h.database, systemContext(tenant, 'po-test')), file.storeAccountId, file.storageKey, file.sizeBytes)
    const text = pdfFlatText(pdf!)
    for (const words of [order.number, 'Seed cowhide 1.2 mm', 'colore Black (cod. fornitore S-001)', 'scelta A', 'un solo bagno di tintura', 'circa 5 pelli', 'prova Cr VI richiesta', '220,50', '1.102,50', 'FORNITORE', 'CONSEGNARE A', 'Seed plant A1']) {
      expect(text, words).toContain(words)
    }

    const link = await one('SELECT purpose, "recordType", "recordId", "partyId", email, "maxUses", uses, "revokedAt", "tokenHash", "expiresAt" FROM "OneOffLink" WHERE id = $1', [sent.sent.link.id])
    expect(link).toMatchObject({ purpose: 'PO_CONFIRM', recordType: 'PurchaseOrder', recordId: order.id, partyId: P2, email: ORDERS_P2, maxUses: 1, uses: 0, revokedAt: null })
    expect(link.tokenHash).not.toBe(token)
    // The thread keeps the mail without the link; it left (in this process) with the link and the PDF.
    const mail = await one('SELECT o.status, o.to, o.subject, m."bodyText", m."attachmentFileIds" FROM "EmailOutbound" o JOIN "Message" m ON m.id = o."messageId" WHERE o.id = $1', [sent.sent.emailId])
    expect(mail).toMatchObject({ status: 'SENT', to: [ORDERS_P2], subject: `Ordine di acquisto ${order.number}`, attachmentFileIds: [sent.sent.documentFileId] })
    expect(mail.bodyText).toContain("usi il link personale contenuto nell'e-mail inviata")
    const raw = h.ses.mails.find((entry) => entry.outboundId === sent.sent.emailId)!.raw
    expect(textOf(raw)).toContain('usi questo link personale')
    expect(raw).toContain(`filename="Ordine di acquisto ${order.number}.pdf"`)
    // The token (its secret part) is in no stored row: only the mail carried it.
    const secret = token.split('.').at(-1)!
    for (const [table, column] of [['AuditLog', 'concat(before::text, after::text)'], ['OutboxEvent', 'payload::text'], ['IdempotencyReceipt', 'response::text'], ['Message', '"bodyText"'], ['EmailOutbound', 'subject'], ['OneOffLink', '"tokenHash"']] as const) {
      expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE ${column} LIKE $1`, [`%${secret}%`])).n, table).toBe(0)
    }
    expect(await eventsOf(order.id)).toContain('purchase_order.sent')
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'email.queued' AND payload->>'outboundId' = $1`, [sent.sent.emailId])).n).toBe(0)
  })

  it('is idempotent: the same key answers the first send, nothing is made or mailed again; the order is frozen', async () => {
    const mails = h.ses.mails.length
    const again = await as('POST', `${orderUrl(order.id)}/send`, { version: order.version - 1 }, 200, { 'idempotency-key': 'po-first-send-0001' })
    expect(again.sent).toEqual(sent.sent)
    expect(again.delivery).toBeNull()
    expect(h.ses.mails.length).toBe(mails)
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM "OneOffLink" WHERE "recordId" = $1', [order.id])).n).toBe(1)
    const line = order.lines[0] as Json
    expect((await refusedAs('PATCH', `${orderUrl(order.id)}/lines/${line.id}`, { version: order.version, quantity: '6' }, 409)).message).toBe('The order is sent and waiting for the supplier: its lines and terms change only while it is a draft.')
    expect((await refusedAs('POST', `${orderUrl(order.id)}/send`, { version: order.version }, 409)).message).toMatch(/only a draft is sent/)
  })

  it("the link opens the order for the supplier; what it sees has no price, also read in the supplier's own scope", async () => {
    const opened = await viaLink(token, 'POST', '/link/open')
    expect(opened.statusCode, opened.body).toBe(200)
    expect(opened.json().link).toMatchObject({ purpose: 'PO_CONFIRM', record: { type: 'PurchaseOrder', id: order.id } })
    const preview = await as('GET', `${orderUrl(order.id)}/supplier-view`)
    expect(preview.lines[0]).toMatchObject({ code: 'SEED-ART-100', name: 'Seed cowhide 1.2 mm', quantity: '5.0000', uom: 'HIDE', estimatedHides: 5, requiresCrViTest: true })
    const keys = JSON.stringify(preview)
    for (const word of ['unitPrice', 'netAmount', 'price', 'Amount', 'internalNote', 'createdById', 'sentById']) expect(keys).not.toContain(word)
    // The same read in the supplier's party scope (factory_partner_runtime): every column it names is the partner's to read.
    const office = { audience: 'office' as const, tenantId: tenant, actorId: newId() }
    const asSupplier = await h.database.withScope({ audience: 'partner', tenantId: tenant, actorId: newId(), partyId: P2 }, (client) => h.database.withScope(office, (labels) => supplierView(client, order.id, labels)))
    expect(asSupplier).toEqual(preview)
    await expect(h.database.withScope({ audience: 'partner', tenantId: tenant, actorId: newId(), partyId: P1 }, (client) => supplierView(client, order.id))).rejects.toThrow(/Purchase order not found/)
  })

  it('a new link: the live one stops working, the new one is mailed with the same PDF', async () => {
    const answer = await as('POST', `${orderUrl(order.id)}/send-link`, { version: order.version }, 200, { 'idempotency-key': key('link') })
    expect(answer).toMatchObject({ delivery: 'sent', link: { to: ORDERS_P2, revokedLinkIds: [sent.sent.link.id] } })
    order = answer.order
    expect(order.confirmLinks.map((link: Json) => link.state)).toEqual(['REVOKED', 'LIVE'])
    expect((await viaLink(token, 'POST', '/link/open')).statusCode).toBe(404)
    const raw = h.ses.mails.find((entry) => entry.outboundId === answer.link.emailId)!.raw
    expect(textOf(raw)).toContain('le inviamo un nuovo link')
    expect(raw).toContain(`filename="Ordine di acquisto ${order.number}.pdf"`)
    const documents = await as('GET', `${orderUrl(order.id)}/documents`)
    expect(documents).toMatchObject({ revision: 1, status: 'SENT', documents: [{ fileId: sent.sent.documentFileId, sha256: sent.sent.documentSha256 }] })
    expect(documents.links.map((link: Json) => link.state)).toEqual(['REVOKED', 'LIVE'])
    expect(documents.mails.map((mail: Json) => mail.status)).toEqual(['SENT', 'SENT'])
  })
})

describe('a send and a cancel never both happen (compare-and-set on the order version)', () => {
  it('a cancel decided on the draft does not cancel the order sent meanwhile; read again, it cancels it and tells the supplier', async () => {
    const draft = await manualOrder()
    const { answer } = await send(draft)
    const stale = await refusedAs('POST', `${orderUrl(draft.id)}/cancel`, { version: draft.version, reason: 'Too late' }, 409)
    expect(stale.message).toMatch(/changed since it was read/)
    expect(await one('SELECT status FROM "PurchaseOrder" WHERE id = $1', [draft.id])).toEqual({ status: 'SENT' })

    const cancelled = await as('POST', `${orderUrl(draft.id)}/cancel`, { version: answer.order.version, reason: 'Covered by another order', message: 'Ci scusiamo per il disturbo.' })
    expect(cancelled).toMatchObject({ order: { status: 'CANCELLED', cancelReason: 'Covered by another order' }, supplierTold: true })
    expect(cancelled.order.confirmLinks.map((link: Json) => link.state)).toEqual(['REVOKED'])
    const mail = await one(`SELECT status, subject, m."bodyText" FROM "EmailOutbound" o JOIN "Message" m ON m.id = o."messageId" WHERE o."recordId" = $1 AND o.subject LIKE 'Annullamento%'`, [draft.id])
    expect(mail).toMatchObject({ status: 'QUEUED', subject: `Annullamento ordine di acquisto ${draft.number}` })
    expect(mail.bodyText).toContain('Ci scusiamo per il disturbo.')
    expect(mail.bodyText).not.toContain('Covered by another order')
    expect(await eventsOf(draft.id)).toEqual(expect.arrayContaining(['purchase_order.sent', 'purchase_order.cancelled']))
  })

  it('a send decided on the draft does not send the order cancelled meanwhile: no PDF row, no link, no mail', async () => {
    const draft = await manualOrder()
    await as('POST', `${orderUrl(draft.id)}/cancel`, { version: draft.version, reason: 'Not needed any more' })
    const mails = h.ses.mails.length
    const stale = await refusedAs('POST', `${orderUrl(draft.id)}/send`, { version: draft.version }, 409)
    expect(stale.message).toMatch(/changed since it was read/)
    expect(await one('SELECT status FROM "PurchaseOrder" WHERE id = $1', [draft.id])).toEqual({ status: 'CANCELLED' })
    for (const table of ['StoredFile', 'OneOffLink', 'EmailOutbound']) expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE "recordId" = $1`, [draft.id])).n, table).toBe(0)
    expect(h.ses.mails.length).toBe(mails)
  })

  it('sent at the same time as a cancel: exactly one wins, and the order is wholly sent or wholly cancelled', async () => {
    for (let round = 0; round < 3; round++) {
      const draft = await manualOrder()
      const [sendAnswer, cancelAnswer] = await Promise.all([
        buyer.send('POST', `${orderUrl(draft.id)}/send`, { version: draft.version }, { headers: { 'idempotency-key': key('race') } }),
        buyer.send('POST', `${orderUrl(draft.id)}/cancel`, { version: draft.version, reason: 'Race' }),
      ])
      expect([sendAnswer.status, cancelAnswer.status].sort()).toEqual([200, 409])
      const row = await one<{ status: string }>('SELECT status FROM "PurchaseOrder" WHERE id = $1', [draft.id])
      const links = (await one<{ n: number }>('SELECT count(*)::int AS n FROM "OneOffLink" WHERE "recordId" = $1', [draft.id])).n
      const files = (await one<{ n: number }>('SELECT count(*)::int AS n FROM "StoredFile" WHERE "recordId" = $1', [draft.id])).n
      if (sendAnswer.status === 200) expect({ status: row.status, links, files }).toEqual({ status: 'SENT', links: 1, files: 1 })
      else expect({ status: row.status, links, files }).toEqual({ status: 'CANCELLED', links: 0, files: 0 })
    }
  })

  it('a confirmed order is a contract: it is not cancelled here; a received one is closed, never cancelled', async () => {
    const draft = await manualOrder()
    const { answer } = await send(draft)
    await admin(`UPDATE "PurchaseOrder" SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'OFFICE', "confirmedByName" = 'Seed Order Desk' WHERE id = $1`, [draft.id])
    const current = (await as('GET', orderUrl(draft.id))).order
    expect((await refusedAs('POST', `${orderUrl(draft.id)}/cancel`, { version: current.version, reason: 'Changed our mind' }, 409)).message).toMatch(/^The supplier confirmed this order: it is a contract now/)
    expect(answer.order.status).toBe('SENT')
    const received = (await as('GET', orderUrl(seedId('link:P2:record')))).order
    expect(received.status).toBe('PARTLY_RECEIVED')
    expect((await refusedAs('POST', `${orderUrl(received.id)}/cancel`, { version: received.version, reason: 'No' }, 409)).message).toMatch(/Goods were received/)
  })
})

describe('lines by hand (SCM-075) and the send warnings', () => {
  it("a manual line takes the material's defaults; the supplier's steps and minimum are warnings, never blocks", async () => {
    const created = (await as('POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2, requestedDate: addDays(today(), 20) }, 201)).order
    expect(created).toMatchObject({ status: 'DRAFT', contact: { email: ORDERS_P2 }, paymentTerms: 'Bank transfer 60 days end of month', currency: 'EUR', lineCount: 0 })
    let draft = (await as('POST', `${orderUrl(created.id)}/lines`, { version: created.version, itemId: protector, quantity: '10', needDate: addDays(today(), 30) }, 201)).order
    // Leather by area: 105 ft², 2 hides of 52.5, under the minimum of 5 hides; 1 % area tolerance.
    draft = (await as('POST', `${orderUrl(created.id)}/lines`, { version: draft.version, itemId: leather, itemColourId: leatherRED, quantity: '105', uom: 'FT2', needDate: addDays(today(), 30), areaTolerancePct: '1', thicknessMinMm: '1.2', thicknessMaxMm: '1.2' }, 201)).order
    expect(lineOf(draft, leather, leatherRED)).toMatchObject({ quantity: '105.0000', uom: 'FT2', baseQuantity: '105.0000', unitPrice: '4.200000', netAmount: 44_100, estimatedHides: 2, areaTolerancePct: '1', thicknessMinMm: '1.2', oneDyeBatch: true })
    expect(draft.send.checks.map((check: Json) => [check.code, check.severity])).toEqual([
      ['NOT_A_MULTIPLE', 'WARNING'],
      ['BELOW_MINIMUM', 'WARNING'],
    ])
    expect(draft.send.ready).toBe(true)
    // A protector is no leather; a colour of another material is refused.
    expect((await refusedAs('POST', `${orderUrl(created.id)}/lines`, { version: draft.version, itemId: protector, quantity: '12', needDate: addDays(today(), 30), oneDyeBatch: true }, 400)).issues).toEqual([{ path: 'body/oneDyeBatch', message: 'Only a leather line has a grade, thickness, dye batch or area tolerance.' }])
    expect((await refusedAs('POST', `${orderUrl(created.id)}/lines`, { version: draft.version, itemId: protector, itemColourId: leatherBLK, quantity: '12', needDate: addDays(today(), 30) }, 400)).message).toBe('Not a colour of this material.')
    const protectorLine = lineOf(draft, protector)
    draft = (await as('DELETE', `${orderUrl(created.id)}/lines/${protectorLine.id}?version=${draft.version}`)).order
    expect(draft).toMatchObject({ lineCount: 1, netAmount: 44_100 })
    // Bought by the hide instead: the same 105 ft² at the same price per ft².
    draft = (await as('PATCH', `${orderUrl(created.id)}/lines/${lineOf(draft, leather, leatherRED).id}`, { version: draft.version, uom: 'HIDE' })).order
    expect(lineOf(draft, leather, leatherRED)).toMatchObject({ quantity: '2.0000', uom: 'HIDE', baseQuantity: '105.0000', unitPrice: '220.500000', netAmount: 44_100, estimatedHides: 2 })
  })
})

describe('walls (A1 §2.2, §2.6): tenant, company, supplier, audience, money', () => {
  it('without the cost grain the order reads without a price; a viewer or planner writes nothing', async () => {
    const viewed = (await wall('viewer', 'GET', orderUrl(order.id))).json().order
    expect(viewed.lines.length).toBeGreaterThan(0)
    expect(viewed).not.toHaveProperty('netAmount')
    for (const line of viewed.lines) {
      expect(line).not.toHaveProperty('unitPrice')
      expect(line).not.toHaveProperty('netAmount')
    }
    const list = (await wall('viewer', 'GET', '/purchasing/orders')).json()
    expect(list.orders.length).toBeGreaterThan(0)
    expect(list.orders[0]).not.toHaveProperty('netAmount')
    const withCost = (await wall('manager', 'GET', orderUrl(order.id))).json().order
    expect(withCost.netAmount).toBe(280_200)
    expect((await wall('planner', 'POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2 })).statusCode).toBe(403)
    expect((await wall('planner', 'POST', `${orderUrl(order.id)}/send`, { version: order.version })).statusCode).toBe(403)
    // A price sent without the cost grain is refused, not ignored.
    const draft = (await wall('manager', 'POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2 })).json().order
    expect((await wall('clerk', 'POST', `${orderUrl(draft.id)}/lines`, { version: draft.version, itemId: protector, quantity: '12', needDate: addDays(today(), 30), unitPrice: '1' })).statusCode).toBe(403)
    // Without a price the clerk's line takes the material's standard price, which the clerk does not see.
    const added = (await wall('clerk', 'POST', `${orderUrl(draft.id)}/lines`, { version: draft.version, itemId: protector, quantity: '12', needDate: addDays(today(), 30) })).json().order
    expect(added.lines[0]).not.toHaveProperty('unitPrice')
    expect(await one('SELECT "unitPrice"::text AS price FROM "PurchaseOrderLine" WHERE id = $1', [added.lines[0].id])).toEqual({ price: '6.500000' })
    // Cancelling an order the supplier holds needs the right to send.
    expect((await wall('manager', 'POST', `${orderUrl(order.id)}/cancel`, { version: order.version, reason: 'No' })).statusCode).toBe(403)
  })

  it('another tenant, another company or a role kept to other suppliers does not see the order', async () => {
    for (const session of ['otherTenant', 'companyB', 'brandOnly']) {
      expect((await wall(session, 'GET', orderUrl(order.id))).statusCode, session).toBe(404)
      expect((await wall(session, 'GET', `${orderUrl(order.id)}/supplier-view`)).statusCode, session).toBe(404)
    }
    expect((await wall('companyB', 'GET', '/purchasing/orders')).json().orders).toEqual([])
    expect((await wall('brandOnly', 'GET', '/purchasing/orders')).json().orders.every((row: Json) => row.partyId === P1)).toBe(true)
    const plan = await latestPlan()
    const line = (plan.lines as Json[])[0]!
    expect((await wall('otherTenant', 'POST', '/purchasing/from-plan', { lines: [{ id: line.id, version: line.version }] })).statusCode).toBe(404)
    expect((await wall('companyB', 'POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2 })).statusCode).toBe(404)
  })

  it('the floor and a partner session have no purchasing route', async () => {
    for (const session of ['floor', 'partner']) {
      expect((await wall(session, 'GET', '/purchasing/orders')).statusCode, session).toBe(403)
      expect((await wall(session, 'GET', orderUrl(order.id))).statusCode, session).toBe(403)
      expect((await wall(session, 'POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2 })).statusCode, session).toBe(403)
    }
  })
})
