import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/planning/buy'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { textOf } from '../../../adapters/ses/fake'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { tellBuyer } from '../confirm/handler'

/**
 * Supplier orders in the portal on the local stack (B-W2b-174; SCM-094, SCM-086; Owner answers C2 and P2): a throwaway
 * PostgreSQL 17 database from the migrations (row-level security, the partner role's column grants and the …_supply guards
 * are real), the real app with the office buyer who sends orders and decides, and the supplier's people signed in to the
 * portal by e-mail code (FAKE mailbox). Every name, number and price is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/purchasing/portal-orders`.
 */

let h: Harness
let buyer: Browser
let anna: Browser
let vito: Browser
let otto: Browser
let annaId: string
const NS = 'po-portal'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const siteA1 = seedId('site:A1')
const P2 = seedId('party:P2')
const P9 = newId()
const leather = seedId('product:item:leather')
const protector = seedId('product:item:protector')
const leatherBLK = seedId('product:item-colour:leather:BLK')
const otherProtector = newId()
const FAKE_VAT = '12345670009'
const people = { anna: 'anna.orders@tannery-p2.example', vito: 'vito.viewer@tannery-p2.example', otto: 'otto.orders@other-p9.example' }
const today = () => businessDate(h.clock.now())

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
let counter = 0
const key = (label = 'k'): string => `pop-${label}-${++counter}-${newId()}`
const system = () => callerFor(h.database, systemContext(tenant, newId()))

async function as(browser: Browser, method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await browser.send(method, url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'POST' ? { 'idempotency-key': key() } : {} })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

/** Every price-looking key or a seeded price in a JSON answer (none may be there; the decline reason PRICE is a word, not a price). */
function priceTraces(body: unknown): string[] {
  const text = JSON.stringify(body)
  return [/price"\s*:/i, /unitPrice/i, /amount/i, /cost/i, /"6\.5/, /"4\.2/, /"5\.5/, /internalNote/, /sentById/, /createdById/, /decisionNote/i].filter((pattern) => pattern.test(text)).map(String)
}

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!.replace('.', ' '), locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'SUPPLIER' }, select: { id: true } })
    for (const roleKey of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant, key: roleKey } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
  return id
}

async function signedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: NS, company: 'SCA', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: NS, company: 'SCA', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

/** A draft for P2 at A1: 105 ft² of black leather (in 30 days) and 24 protectors (in 35 days), sent; the order as sent. */
async function sentOrder(): Promise<Json> {
  let draft = (await as(buyer, 'POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2, incoterms: 'EXW Seedville' }, 201)).order
  draft = (await as(buyer, 'POST', `/purchasing/orders/${draft.id}/lines`, { version: draft.version, itemId: leather, itemColourId: leatherBLK, quantity: '105', uom: 'FT2', needDate: addDays(today(), 30) }, 201)).order
  draft = (await as(buyer, 'POST', `/purchasing/orders/${draft.id}/lines`, { version: draft.version, itemId: protector, quantity: '24', needDate: addDays(today(), 35) }, 201)).order
  return (await as(buyer, 'POST', `/purchasing/orders/${draft.id}/send`, { version: draft.version })).order
}

const tasksOf = (orderId: string) => admin<{ status: string; sourceKey: string; doneById: string | null; dueAt: Date | null; askedByName: string | null }>('SELECT status, "sourceKey", "doneById", "dueAt", "askedByName" FROM "PartnerTask" WHERE "recordId" = $1 ORDER BY "createdAt", id', [orderId])
const outboxOf = (orderId: string, type: string) => admin<{ id: string; type: string; payload: Json; source: string }>('SELECT id, type, payload, source FROM "OutboxEvent" WHERE subject = $1 AND type = $2 ORDER BY "occurredAt", id', [orderId, type])
const lineOf = (orderId: string, seq: number) => one(`SELECT * FROM "PurchaseOrderLine" WHERE "purchaseOrderId" = $1 AND seq = $2`, [orderId, seq])
/** B-W2b-F13a: how the order keeps the supplier's answer (the wave-23 columns). */
const channelOf = (orderId: string) =>
  one('SELECT status, "confirmedVia", "confirmLinkId", "confirmedByUserId", "confirmedByName", "proposalLinkId", "proposedByUserId", "proposalDecision" FROM "PurchaseOrder" WHERE id = $1', [orderId])
/** A request of the supplier's browser through the emailed link: only its token, no cookie. */
const viaLink = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  h.app.inject({ method, url, headers: { 'x-factory-link': token, 'user-agent': 'SeedBrowser/1.0', ...(method === 'POST' ? { 'idempotency-key': key('link') } : {}) }, ...(method === 'POST' ? { payload: (payload ?? {}) as object } : {}) })
const tokenOf = (outboundId: string): string => {
  const mail = h.ses.mails.find((entry) => entry.outboundId === outboundId)
  return mail ? decodeURIComponent(/#token=(\S+)/.exec(textOf(mail.raw))?.[1] ?? '') : ''
}

beforeAll(async () => {
  h = await startHarness('po_portal')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
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
  // The company's portal terms (and a made-up customer of the helper's: not used here).
  await portalWorld(h, seedTenant)
  // A second protector P2 may offer instead (an approved source of the supplier, never shown with its price).
  const columns = (await admin<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Item' AND column_name NOT IN ('id', 'code', 'name')`)).map((row) => `"${row.column_name}"`)
  await admin(`INSERT INTO "Item" (id, code, name, ${columns.join(', ')}) SELECT $1, 'TEST-PRO-200', 'Test shoulder protector level 1', ${columns.join(', ')} FROM "Item" WHERE id = $2`, [otherProtector, protector])
  await admin(`INSERT INTO "SupplierItem" (id, "tenantId", "companyId", "partyId", "itemId", "supplierArticleCode", "purchaseUom", "unitPrice") VALUES ($1, $2, $3, $4, $5, 'P2-PRO-1', 'PCS', 5.5)`, [newId(), tenant, companyA, P2, otherProtector])
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => {
    await client.portalSettings.create({ data: { id: P2, partyId: P2, portalOn: true }, select: { id: true } })
    await client.party.create({ data: { id: P9, code: `P${P9.slice(-6)}`, kind: 'ORGANISATION', legalName: 'Other Supplier S.r.l.', roles: ['SUPPLIER'] }, select: { id: true } })
    await client.portalSettings.create({ data: { id: P9, partyId: P9, portalOn: true }, select: { id: true } })
  })
  annaId = await partnerPerson(people.anna, P2, ['supplier-orders', 'partner-approve'])
  await partnerPerson(people.vito, P2, ['supplier-orders'])
  await partnerPerson(people.otto, P9, ['supplier-orders', 'partner-approve'])
  const buyerUser = await addUser(h, seedTenant, { email: 'bianca.buyer@seed-a.example.com', role: 'buyer' })
  buyer = new Browser(h.app)
  expect((await buyer.signIn(NS, buyerUser.email, buyerUser.password)).status).toBe(200)
  await enrolTotp(h, buyer)
  freshGuard(h)
  anna = await signedIn(people.anna)
  vito = await signedIn(people.vito)
  otto = await signedIn(people.otto)
}, 240_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
}, 60_000)

describe('the supplier sees its purchase orders without any price (SCM-094, C2)', () => {
  let order: Json

  it('opens a CONFIRM_PO request when the order is sent, due by its confirm-by time, asked by the buyer', async () => {
    order = await sentOrder()
    const tasks = await tasksOf(order.id)
    expect(tasks).toEqual([expect.objectContaining({ status: 'OPEN', sourceKey: `PurchaseOrder:${order.id}:r1`, askedByName: expect.any(String) })])
    expect(tasks[0]!.dueAt).not.toBeNull()
    const list = await as(anna, 'GET', '/portal/tasks')
    expect(list.items.map((task: Json) => [task.kind, task.record.id, task.canMarkDone])).toContainEqual(['CONFIRM_PO', order.id, false])
    // The viewer cannot approve: the request is not theirs.
    expect((await as(vito, 'GET', '/portal/tasks')).items.filter((task: Json) => task.record.id === order.id)).toEqual([])
  })

  it('lists the order under "To confirm" with the counts, and Home counts it', async () => {
    const list = await as(anna, 'GET', '/portal/purchase-orders')
    expect(list.chip).toBe('TO_CONFIRM')
    expect(list.counts.toConfirm).toBeGreaterThanOrEqual(1)
    expect(list.items).toContainEqual(expect.objectContaining({ id: order.id, state: 'TO_CONFIRM', words: { it: 'Da confermare', en: 'To confirm' }, revision: 1, lines: 2, canAnswer: true, late: false, earliestNeedDate: addDays(today(), 30) }))
    expect(priceTraces(list)).toEqual([])
    expect((await as(anna, 'GET', `/portal/purchase-orders?q=${encodeURIComponent(order.number)}`)).items.map((row: Json) => row.id)).toEqual([order.id])
    const home = await as(anna, 'GET', '/portal/home')
    expect(home.counts).toContainEqual(expect.objectContaining({ key: 'purchase_orders.to_confirm', value: list.counts.toConfirm }))
  })

  it('shows the record in the supplier\'s terms with the articles it may offer instead, never a price', async () => {
    const page = await as(anna, 'GET', `/portal/purchase-orders/${order.id}`)
    expect(page.order).toMatchObject({ id: order.id, status: 'SENT', state: 'TO_CONFIRM', revision: 1, incoterms: 'EXW Seedville', version: order.version })
    expect(page.answer).toMatchObject({ canAnswer: true, mayAnswer: true, lineAnswers: ['AS_ASKED', 'OTHER', 'SPLIT', 'CANNOT_DELIVER', 'SUBSTITUTE', 'CHANGE'], declineReasons: ['NO_CAPACITY', 'MATERIAL_NOT_AVAILABLE', 'PRICE', 'OTHER'] })
    const protectorLine = page.lines.find((line: Json) => line.seq === 20)
    expect(page.answer.substitutes[protectorLine.id]).toEqual([{ itemId: otherProtector, code: 'P2-PRO-1', name: 'Test shoulder protector level 1' }])
    expect(page.answer.substitutes[page.lines[0].id]).toEqual([])
    expect(page.lines[0]).toMatchObject({ seq: 10, code: 'SEED-ART-100', colour: { name: 'Black' }, quantity: '105.0000', uom: 'FT2', receivedBase: '0.0000', locked: false, proposal: null })
    expect(page.changes).toBeNull()
    expect(page.history).toEqual([expect.objectContaining({ revision: 1, answer: 'WAITING' })])
    expect(priceTraces(page)).toEqual([])
    // The viewer reads it but may not answer.
    expect((await as(vito, 'GET', `/portal/purchase-orders/${order.id}`)).answer.mayAnswer).toBe(false)
  })

  it('gives a copy of the order without prices (a PDF, nothing stored)', async () => {
    const files = await one<{ n: number }>('SELECT count(*)::int AS n FROM "StoredFile" WHERE "recordId" = $1', [order.id])
    const answer = await anna.send('GET', `/portal/purchase-orders/${order.id}/copy`)
    expect(answer.status).toBe(200)
    expect(answer.response.headers['content-type']).toMatch(/^application\/pdf/)
    expect(answer.response.headers['content-disposition']).toMatch(/copy without prices/)
    const pdf = answer.response.rawPayload
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdf.toString('latin1')).not.toMatch(/4[.,]20|441[.,]00|6[.,]50/)
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM "StoredFile" WHERE "recordId" = $1', [order.id])).n).toBe(files.n)
  })

  it('REFUSES another supplier and a person who may not approve', async () => {
    expect((await otto.send('GET', `/portal/purchase-orders/${order.id}`)).status).toBe(404)
    expect((await as(otto, 'GET', '/portal/purchase-orders?chip=ALL')).items).toEqual([])
    const refused = await vito.send('POST', `/portal/purchase-orders/${order.id}/confirm`, { version: order.version, mode: 'ALL_AS_ASKED' }, { headers: { 'idempotency-key': key() } })
    expect(refused.status).toBe(403)
    expect(JSON.stringify(refused.body)).toMatch(/not answer them/)
    expect((await buyer.send('GET', '/portal/purchase-orders')).status).toBe(401)
  })
})

describe('answer line by line: a substitute waits for the buyer, a line as asked is confirmed at once (SCM-086, P2)', () => {
  let order: Json
  let lines: Json[]

  it('proposes: line 10 as asked (confirmed now), line 20 a substitute; the request is done', async () => {
    order = await sentOrder()
    lines = (await as(anna, 'GET', `/portal/purchase-orders/${order.id}`)).lines
    const stale = await anna.send('POST', `/portal/purchase-orders/${order.id}/confirm`, { version: order.version - 1, mode: 'ALL_AS_ASKED' }, { headers: { 'idempotency-key': key() } })
    expect(stale.status).toBe(409)
    const end = await as(anna, 'POST', `/portal/purchase-orders/${order.id}/confirm`, {
      version: order.version,
      mode: 'BY_LINE',
      supplierRef: 'OC-77',
      lines: [
        { lineId: lines[0]!.id, answer: 'AS_ASKED' },
        { lineId: lines[1]!.id, answer: 'SUBSTITUTE', substituteItemId: otherProtector, substituteNote: 'Level 1, same size', date: addDays(today(), 40), reason: 'Level 2 sold out' },
      ],
    })
    expect(end).toMatchObject({ outcome: 'PROPOSED', summary: '1 line as asked · 1 later date · 1 substitute', order: { status: 'CHANGES_PROPOSED', state: 'CHANGE_PROPOSED' } })
    expect(end.done).toMatch(/^Thank you: the line as asked is confirmed/)
    expect(end.lines[0]).toMatchObject({ confirmedQuantity: '105.0000', locked: true, proposal: { kind: 'AS_ASKED', needsBuyer: false } })
    expect(end.lines[1]).toMatchObject({ confirmedQuantity: null, proposal: { kind: 'SUBSTITUTE', needsBuyer: true, date: addDays(today(), 40), substitute: { itemId: otherProtector, code: 'TEST-PRO-200', note: 'Level 1, same size' } } })
    expect(priceTraces(end)).toEqual([])
    expect(await lineOf(order.id, 20)).toMatchObject({ proposedSubstituteItemId: otherProtector, proposalNeedsBuyer: true, confirmedQuantity: null })
    const stored = await one('SELECT status, "proposalLinkId", "proposedByUserId", "proposedByName", "proposalSupplierRef" FROM "PurchaseOrder" WHERE id = $1', [order.id])
    // B-W2b-F13a: a portal proposal names its person, never the emailed link.
    expect(stored).toEqual({ status: 'CHANGES_PROPOSED', proposalLinkId: null, proposedByUserId: annaId, proposedByName: 'anna orders', proposalSupplierRef: 'OC-77' })
    expect(await tasksOf(order.id)).toEqual([expect.objectContaining({ status: 'DONE', doneById: expect.any(String) })])
    const audit = await one(`SELECT action, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'purchasing.portalPropose'`, [order.id])
    expect(audit.after).toMatchObject({ via: 'PORTAL', byPartner: true, personId: annaId, byName: 'anna orders' })
    expect(audit.after).not.toHaveProperty('linkId')
    const [event] = await outboxOf(order.id, 'purchase_order.changes_proposed')
    expect(event!.payload).toMatchObject({ linkId: null, changed: 1 })
  })

  it('tells the buyer on the thread: in the portal, with the substitute in words', async () => {
    const [event] = await outboxOf(order.id, 'purchase_order.changes_proposed')
    expect(event!.source).toBe('purchasing.portalConfirm')
    await tellBuyer(system(), { eventId: event!.id, type: event!.type, payload: event!.payload, source: event!.source })
    const note = await one<{ bodyText: string }>(`SELECT m."bodyText" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordId" = $1 AND m.direction = 'INTERNAL_NOTE' ORDER BY m."createdAt" DESC LIMIT 1`, [order.id])
    expect(note.bodyText).toContain(`The supplier proposed changes to ${order.number} in the portal by anna orders (their reference OC-77): 1 line as asked · 1 later date · 1 substitute.`)
    expect(note.bodyText).toContain('Line 20: a substitute instead, TEST-PRO-200 Test shoulder protector level 1 — Level 1, same size')
  })

  it('shows the office the substitute, and REFUSES accepting it as the article asked for', async () => {
    const panel = await as(buyer, 'GET', `/purchasing/orders/${order.id}/answer`)
    expect(panel.proposal).toMatchObject({ via: 'PORTAL', linkId: null, byName: 'anna orders', summary: '1 line as asked · 1 later date · 1 substitute' })
    expect(panel.lines[1].proposed).toMatchObject({ portalKind: 'SUBSTITUTE', needsBuyer: true, substitute: { itemId: otherProtector, code: 'TEST-PRO-200' } })
    const current = (await as(buyer, 'GET', `/purchasing/orders/${order.id}`)).order
    const refused = await buyer.send('POST', `/purchasing/orders/${order.id}/proposal/accept`, { version: current.version }, { headers: { 'idempotency-key': key() } })
    expect(refused.status).toBe(409)
    expect(JSON.stringify(refused.body)).toMatch(/Line 20 offers another article instead/)
  })

  it('refused by the buyer: the request opens again, line 10 stays confirmed, "confirm all as asked" confirms the rest', async () => {
    const current = (await as(buyer, 'GET', `/purchasing/orders/${order.id}`)).order
    await as(buyer, 'POST', `/purchasing/orders/${order.id}/proposal/refuse`, { version: current.version, note: 'Only level 2' })
    expect((await tasksOf(order.id)).map((task) => task.status)).toEqual(['OPEN'])
    const page = await as(anna, 'GET', `/portal/purchase-orders/${order.id}`)
    expect(page.proposal).toMatchObject({ decision: 'REFUSED' })
    expect(priceTraces(page)).toEqual([])
    expect(page.lines[0].locked).toBe(true)
    const relock = await anna.send('POST', `/portal/purchase-orders/${order.id}/confirm`, { version: page.order.version, mode: 'BY_LINE', lines: [{ lineId: lines[0]!.id, answer: 'AS_ASKED' }, { lineId: lines[1]!.id, answer: 'AS_ASKED' }] }, { headers: { 'idempotency-key': key() } })
    expect(relock.status).toBe(400)
    expect(JSON.stringify(relock.body)).toMatch(/Line 10 is confirmed already/)
    const end = await as(anna, 'POST', `/portal/purchase-orders/${order.id}/confirm`, { version: page.order.version, mode: 'ALL_AS_ASKED' })
    expect(end).toMatchObject({ outcome: 'CONFIRMED', order: { status: 'CONFIRMED', confirmedByName: 'anna orders' } })
    expect(end.lines.map((line: Json) => line.confirmedQuantity)).toEqual(['105.0000', '24.0000'])
    expect((await tasksOf(order.id)).map((task) => task.status)).toEqual(['DONE'])
    expect(end.history).toEqual([expect.objectContaining({ revision: 1, answer: 'CONFIRMED', confirmation: expect.objectContaining({ byName: 'anna orders' }) })])
    // B-W2b-F13a: stored as what it is, PORTAL by the person, no link (the refused proposal stays on the row, the person's).
    expect(await channelOf(order.id)).toEqual({ status: 'CONFIRMED', confirmedVia: 'PORTAL', confirmLinkId: null, confirmedByUserId: annaId, confirmedByName: 'anna orders', proposalLinkId: null, proposedByUserId: annaId, proposalDecision: 'REFUSED' })
    const audit = await one(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'purchasing.portalConfirm'`, [order.id])
    expect(audit.after).toMatchObject({ status: 'CONFIRMED', via: 'PORTAL', personId: annaId })
    const [event] = await outboxOf(order.id, 'purchase_order.confirmed')
    expect(event!.payload).toMatchObject({ channel: 'PORTAL', linkId: null, proposalAccepted: false })
    await tellBuyer(system(), { eventId: event!.id, type: event!.type, payload: event!.payload, source: event!.source })
    const note = await one<{ bodyText: string }>(`SELECT m."bodyText" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordId" = $1 AND m.direction = 'INTERNAL_NOTE' ORDER BY m."createdAt" DESC LIMIT 1`, [order.id])
    expect(note.bodyText).toMatch(new RegExp(`^The supplier confirmed ${order.number} in the portal by anna orders`))
    const panel = await as(buyer, 'GET', `/purchasing/orders/${order.id}/answer`)
    expect(panel.confirmation).toMatchObject({ via: 'PORTAL', linkId: null, byName: 'anna orders' })
    const row = (await as(buyer, 'GET', '/purchasing/orders?limit=200')).orders.find((item: Json) => item.id === order.id)
    expect(row).toMatchObject({ confirmedVia: 'PORTAL', confirmedByName: 'anna orders' })
  })

  it('a change takes the PORTAL-confirmed order back to DRAFT: the confirmation and its person cleared, kept with the change', async () => {
    const current = (await as(buyer, 'GET', `/purchasing/orders/${order.id}`)).order
    const changed = await as(buyer, 'POST', `/purchasing/orders/${order.id}/change`, { version: current.version, note: 'More leather' })
    expect(changed).toMatchObject({ revision: 2, order: { status: 'DRAFT', confirmedAt: null, confirmedVia: null, confirmedByName: null } })
    expect(await channelOf(order.id)).toMatchObject({ status: 'DRAFT', confirmedVia: null, confirmLinkId: null, confirmedByUserId: null, confirmedByName: null })
    const audit = await one(`SELECT before, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'purchasing.change'`, [order.id])
    expect(audit).toMatchObject({ before: { status: 'CONFIRMED', revision: 1 }, after: { status: 'DRAFT', revision: 2, kept: { status: 'CONFIRMED', confirmation: { via: 'PORTAL', byName: 'anna orders' } } } })
  })
})

describe('each proposal names the channel it came through; the buyer accepts it on that channel (B-W2b-F13a)', () => {
  it('portal → refused → link → refused → portal → accepted: PORTAL by the person who proposed it', async () => {
    const order = await sentOrder()
    const [ten, twenty] = [(await lineOf(order.id, 10)).id as string, (await lineOf(order.id, 20)).id as string]
    const byPortal = (version: number, days: number) =>
      as(anna, 'POST', `/portal/purchase-orders/${order.id}/confirm`, { version, mode: 'BY_LINE', lines: [{ lineId: ten, answer: 'OTHER', date: addDays(today(), days), reason: 'Dye batch late' }, { lineId: twenty, answer: 'OTHER', quantity: '20', reason: 'Only 20 in stock' }] })
    const refuse = async () => {
      const current = (await as(buyer, 'GET', `/purchasing/orders/${order.id}`)).order
      return (await as(buyer, 'POST', `/purchasing/orders/${order.id}/proposal/refuse`, { version: current.version })).order
    }
    expect((await byPortal(order.version, 40)).outcome).toBe('PROPOSED')
    expect(await channelOf(order.id)).toMatchObject({ status: 'CHANGES_PROPOSED', proposalLinkId: null, proposedByUserId: annaId })
    // Refused; a new link; the supplier answers on the link: the link, no person (the portal one is cleared).
    let current = await refuse()
    const sent = await as(buyer, 'POST', `/purchasing/orders/${order.id}/send-link`, { version: current.version })
    const token = tokenOf(sent.link.emailId)
    const linkPage = (await viaLink(token, 'GET', '/link/purchase-order')).json()
    const answered = await viaLink(token, 'POST', '/link/purchase-order/confirm', { version: linkPage.order.version, mode: 'BY_LINE', typedName: 'Anna Link', lines: [{ lineId: ten, answer: 'OTHER', date: addDays(today(), 41), reason: 'Dye batch late' }, { lineId: twenty, answer: 'AS_ASKED' }] })
    expect(answered.statusCode, answered.body).toBe(200)
    expect(await channelOf(order.id)).toMatchObject({ status: 'CHANGES_PROPOSED', proposalLinkId: sent.link.id, proposedByUserId: null })
    expect((await as(buyer, 'GET', `/purchasing/orders/${order.id}/answer`)).proposal).toMatchObject({ via: 'LINK', linkId: sent.link.id, byName: 'Anna Link' })
    // Refused again; the supplier answers in the portal: the person, no link.
    current = await refuse()
    const page = await as(anna, 'GET', `/portal/purchase-orders/${order.id}`)
    expect((await byPortal(page.order.version, 42)).outcome).toBe('PROPOSED')
    expect(await channelOf(order.id)).toMatchObject({ status: 'CHANGES_PROPOSED', proposalLinkId: null, proposedByUserId: annaId, proposalDecision: null })
    // Accepted: a PORTAL confirmation by the person who proposed it.
    current = (await as(buyer, 'GET', `/purchasing/orders/${order.id}`)).order
    const accepted = await as(buyer, 'POST', `/purchasing/orders/${order.id}/proposal/accept`, { version: current.version })
    expect(accepted.order).toMatchObject({ status: 'CONFIRMED', confirmedVia: 'PORTAL', confirmedByName: 'anna orders' })
    expect(await channelOf(order.id)).toEqual({ status: 'CONFIRMED', confirmedVia: 'PORTAL', confirmLinkId: null, confirmedByUserId: annaId, confirmedByName: 'anna orders', proposalLinkId: null, proposedByUserId: annaId, proposalDecision: 'ACCEPTED' })
    expect(await admin('SELECT seq, "confirmedQuantity"::text AS q, "confirmedDate"::text AS d FROM "PurchaseOrderLine" WHERE "purchaseOrderId" = $1 ORDER BY seq', [order.id])).toEqual([
      { seq: 10, q: '105.0000', d: addDays(today(), 42) },
      { seq: 20, q: '20.0000', d: addDays(today(), 35) },
    ])
    const audit = await one(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'purchasing.acceptProposal'`, [order.id])
    expect(audit.after).toMatchObject({ decision: 'ACCEPTED', via: 'PORTAL', linkId: null, personId: annaId })
    const events = await outboxOf(order.id, 'purchase_order.confirmed')
    expect(events.map((event) => event.payload)).toEqual([expect.objectContaining({ channel: 'PORTAL', linkId: null, proposalAccepted: true })])
    expect((await as(buyer, 'GET', `/purchasing/orders/${order.id}/answer`)).confirmation).toMatchObject({ via: 'PORTAL', linkId: null, byName: 'anna orders' })
    expect((await as(anna, 'GET', `/portal/purchase-orders/${order.id}`)).order).toMatchObject({ status: 'CONFIRMED' })
  })
})

describe('what changed in a revision; the decline (SCM-086)', () => {
  let order: Json

  it('a change withdraws the request and shows the version the supplier holds; the new version asks again and says what changed', async () => {
    order = await sentOrder()
    const first = await as(anna, 'POST', `/portal/purchase-orders/${order.id}/confirm`, {
      version: order.version,
      mode: 'BY_LINE',
      lines: [
        { lineId: (await lineOf(order.id, 10)).id, answer: 'CHANGE', reason: 'Two dye batches' },
        { lineId: (await lineOf(order.id, 20)).id, answer: 'SUBSTITUTE', substituteNote: 'Our own level 1 model' },
      ],
    })
    expect(first.outcome).toBe('PROPOSED')
    // The buyer counter-proposes: a new version as a draft (the supplier's proposal kept with it, the lines cleared).
    let current = (await as(buyer, 'GET', `/purchasing/orders/${order.id}`)).order
    await as(buyer, 'POST', `/purchasing/orders/${order.id}/proposal/counter`, { version: current.version })
    expect(await lineOf(order.id, 20)).toMatchObject({ proposedSubstituteNote: null, proposedSubstituteItemId: null, proposalNeedsBuyer: false, proposedQuantity: null })
    const held = (await as(anna, 'GET', '/portal/purchase-orders?chip=ALL')).items.find((row: Json) => row.id === order.id)
    expect(held).toMatchObject({ state: 'BEING_CHANGED', revision: 1, canAnswer: false })
    const page = await as(anna, 'GET', `/portal/purchase-orders/${order.id}`)
    expect(page.answer).toMatchObject({ canAnswer: false, message: 'We are changing this order: its new version comes to you to confirm.' })
    expect(page.lines.map((line: Json) => line.quantity)).toEqual(['105.0000', '24.0000'])
    // The buyer edits the draft and sends version 2.
    current = (await as(buyer, 'GET', `/purchasing/orders/${order.id}`)).order
    const leatherLine = current.lines.find((line: Json) => line.seq === 10)
    current = (await as(buyer, 'PATCH' as 'POST', `/purchasing/orders/${order.id}/lines/${leatherLine.id}`, { version: current.version, quantity: '140' })).order
    current = (await as(buyer, 'POST', `/purchasing/orders/${order.id}/send`, { version: current.version, changeNote: 'More leather' })).order
    expect((await tasksOf(order.id)).map((task) => [task.status, task.sourceKey])).toEqual([
      ['DONE', `PurchaseOrder:${order.id}:r1`],
      ['OPEN', `PurchaseOrder:${order.id}:r2`],
    ])
    const v2 = await as(anna, 'GET', `/portal/purchase-orders/${order.id}`)
    expect(v2.order).toMatchObject({ revision: 2, documentNumber: `${order.number} rev. 2`, state: 'TO_CONFIRM' })
    expect(v2.changes).toMatchObject({ revision: 2, changeNote: 'More leather' })
    expect(v2.changes.words.join('\n')).toMatch(/105 ft² → 140 ft²/)
    expect(v2.history.map((entry: Json) => [entry.revision, entry.answer])).toEqual([
      [1, 'CHANGES_PROPOSED'],
      [2, 'WAITING'],
    ])
    const revisions = await as(anna, 'GET', `/portal/purchase-orders/${order.id}/revisions?language=it`)
    expect(revisions.revisions.map((entry: Json) => entry.revision)).toEqual([1, 2])
    expect(priceTraces([v2, revisions])).toEqual([])
    order = v2.order
  })

  it('declines with the price reason; the request is done; a second answer is refused in words', async () => {
    const end = await as(anna, 'POST', `/portal/purchase-orders/${order.id}/decline`, { version: order.version, reason: 'PRICE', note: 'Let us talk in the messages' })
    expect(end).toMatchObject({ outcome: 'DECLINED', order: { status: 'DECLINED', state: 'DECLINED', declineReason: 'The price does not work for us: Let us talk in the messages' } })
    expect((await tasksOf(order.id)).map((task) => task.status)).toEqual(['DONE', 'DONE'])
    const again = await anna.send('POST', `/portal/purchase-orders/${order.id}/confirm`, { version: end.order.version, mode: 'ALL_AS_ASKED' }, { headers: { 'idempotency-key': key() } })
    expect(again.status).toBe(409)
    expect(JSON.stringify(again.body)).toMatch(/You declined this order/)
    const [event] = await outboxOf(order.id, 'purchase_order.declined')
    expect(event!.source).toBe('purchasing.portalDecline')
  })

  it('cancelling a sent order withdraws its request', async () => {
    const sent = await sentOrder()
    await as(buyer, 'POST', `/purchasing/orders/${sent.id}/cancel`, { version: sent.version, reason: 'Not needed' })
    expect((await tasksOf(sent.id)).map((task) => task.status)).toEqual(['CANCELLED'])
    expect((await as(anna, 'GET', '/portal/purchase-orders?chip=CLOSED')).items.map((row: Json) => row.id)).toContain(sent.id)
  })
})
