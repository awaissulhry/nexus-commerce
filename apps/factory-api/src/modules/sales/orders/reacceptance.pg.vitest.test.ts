import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPricing, type PricingSeed } from '../../../../../../packages/factory-db/seed/pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { forgetProgress } from '../portal-orders/progress'

/**
 * B-OC-001 (order changes tab R1; 13-backend §1; lead settle L5) — the customer's new yes for a revised order, asked EXACTLY as the
 * web's one helper asks it (F-OC-201: `POST /approvals-out` of kind REVISED_ORDER on the AMENDMENT the save answered, to the
 * confirmation's own recipient — the quote's contact with an e-mail, else the first active ORDERS contact with one — `send: false`
 * when there is none). The bug it pins: the Lines save asked on the ORDER, which no adapter takes (400), and a priced change asked
 * nobody. Six cases: the old call refused; a plain change with the tick asked and seen in the portal ("Review and confirm"), in
 * the changes read and in the waiting list; a priced change asked; no address → the portal only; the customer's yes clears the
 * wait; the walls (a person limited to another customer, the other customer's buyer, the real Sales template without prices).
 *
 * On the local stack: a throwaway PostgreSQL 17 database from the migrations (row-level security, the partner role's grants and
 * every guard are real), the real app with office people signed in (two-factor), the customers' buyers signed in to the portal by
 * e-mail code, a FAKE mailbox. The seeds give SEED-SO-0001 of customer P1 (Brand Alpha) with its ORDERS contact; Brand Beta is a
 * second customer made here with its own buyer. Every name, address and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/orders/reacceptance`.
 */

let h: Harness
let owner: Browser
let sales: Browser
let salesBeta: Browser
let buyer: Browser
let buyerBeta: Browser
let pricing: PricingSeed
const NS = 'oc001-reacceptance'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const P1 = seedId('party:P1')
const partyB = newId()
const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
const people = {
  owner: 'olga.owner@seed-a.example.com',
  sales: 'sara.sales@seed-a.example.com',
  salesBeta: 'bruno.beta-desk@seed-a.example.com',
  buyer: 'anna.buyer@customer-p1.example',
  buyerBeta: 'bea.buyer@customer-beta.example',
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
let counter = 0
const key = (): string => `oc001-${++counter}-${newId()}`

async function as(browser: Browser, method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await browser.send(method as never, url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}

const orderId = (): string => pricing.money.sales.orderId
const taskOf = (requestId: string) => one<{ kind: string; status: string }>('SELECT kind::text AS kind, status::text AS status FROM "PartnerTask" WHERE "recordId" = $1', [requestId])
const lastMail = (template: string, to: string) => h.ses.mails.filter((mail) => mail.templateKey === template && mail.to.includes(to)).at(-1)
const changeOf = async (browser: Browser, amendmentId: string): Promise<Json> => ((await as(browser, 'GET', `/sales/orders/${orderId()}/changes`)).changes as Json[]).find((change) => change.id === amendmentId)!
const blockersOf = async (browser: Browser): Promise<Json[]> => {
  forgetProgress()
  return (await as(browser, 'GET', `/sales/orders/${orderId()}/production?parts=headline`)).headline.waiting.blockers as Json[]
}

/** The confirmation's own recipient rule, as the web reads it (ord/depth/model.ts confirmationRecipient): the order has no quote contact here. */
async function ordersContactOf(partyId: string): Promise<{ id: string; email: string } | null> {
  const rows = await admin<{ id: string; email: string }>(`SELECT id, email FROM "PartyContact" WHERE "partyId" = $1 AND status = 'ACTIVE' AND email IS NOT NULL AND 'ORDERS' = ANY(roles::text[]) ORDER BY "createdAt", id LIMIT 1`, [partyId])
  return rows[0] ?? null
}

/** The web's ask (F-OC-201's helper): REVISED_ORDER on the amendment, due in 7 days, no files, sent only with an address. */
const askOf = (amendmentId: string, email: string | null) => ({
  kind: 'REVISED_ORDER',
  recordType: 'SalesOrderAmendment',
  recordId: amendmentId,
  question: 'Made-up: please confirm the order as revised.',
  dueAt: new Date(h.clock.now().getTime() + 7 * 86_400_000).toISOString(),
  fileIds: [],
  language: 'it',
  send: email !== null,
  ...(email ? { email } : {}),
})

/** A plain change with the tick (the Lines save): one more piece in the first size of the first line; the amendment it answers. */
async function plainChange(browser: Browser, reason: string): Promise<Json> {
  const order = (await as(browser, 'GET', `/sales/orders/${orderId()}`)).order
  const line = order.lines[0]
  const sizes = line.sizes.map((size: Json, index: number) => ({ size: size.size, quantity: size.quantity + (index === 0 ? 1 : 0) }))
  return as(browser, 'POST', `/sales/orders/${order.id}/amendments`, { version: order.version, reason, askCustomer: true, lines: order.lines.map((entry: Json) => (entry.id === line.id ? { id: entry.id, sizes } : { id: entry.id })) }, 201)
}

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!.replace('.', ' '), locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
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

/** An office person with a system role, over every company — and only over `partyIds` when given (a person limited to customers). */
async function officeBrowser(email: string, role: string, partyIds: string[] = []): Promise<Browser> {
  const user = await addUser(h, seedTenant, { email })
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId: user.id }, async (client) => {
    const found = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant, key: role } }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId: user.id, roleId: found.id, allCompanies: true, companyIds: [], siteIds: [], partyIds, validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
  })
  const browser = new Browser(h.app)
  expect((await browser.signIn(NS, user.email, user.password)).status).toBe(200)
  await enrolTotp(h, browser)
  return browser
}

beforeAll(async () => {
  h = await startHarness('oc001_reacceptance')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  pricing = await seedPricing({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  // The FAKE mailbox, as approvals-out.pg sets it up: the integration account and the company's sending identities.
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1`, [tenant])
  const ses = newId()
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses-oc001', 'Mail', 'FAKE', 6000, 1000)`, [ses, tenant])
  for (const kind of ['CONVERSATION', 'NOTIFICATION']) {
    await admin(
      `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
       SELECT $1, $2, $3, $4::"EmailIdentityKind", 'mail.seed-a.example.com', $5, 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $6, 'SUCCESS', 'SUCCESS', true
       WHERE NOT EXISTS (SELECT 1 FROM "EmailIdentity" WHERE "tenantId" = $2 AND "companyId" = $3 AND kind = $4::"EmailIdentityKind" AND "isDefault")`,
      [newId(), tenant, companyA, kind, kind === 'CONVERSATION' ? 'vendite@mail.seed-a.example.com' : 'avvisi@mail.seed-a.example.com', ses],
    )
  }
  await portalWorld(h, seedTenant)
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => {
    const settings = await client.portalSettings.findFirst({ where: { partyId: P1 }, select: { id: true } })
    if (settings) await client.portalSettings.update({ where: { id: settings.id }, data: { portalOn: true }, select: { id: true } })
    else await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
    // Brand Beta: another customer of the same company, with its own portal (and no contact: nothing of A's is its).
    await client.party.create({ data: { id: partyB, code: `P${partyB.slice(-6)}`, kind: 'ORGANISATION', legalName: 'Brand Beta S.r.l.', tradeName: 'Brand Beta', roles: ['CUSTOMER'] }, select: { id: true } })
    await client.portalSettings.create({ data: { id: partyB, partyId: partyB, portalOn: true }, select: { id: true } })
  })
  await partnerPerson(people.buyer, P1, ['customer-buyer', 'partner-approve'])
  await partnerPerson(people.buyerBeta, partyB, ['customer-buyer', 'partner-approve'])
  owner = await officeBrowser(people.owner, 'owner')
  sales = await officeBrowser(people.sales, 'sales')
  salesBeta = await officeBrowser(people.salesBeta, 'sales', [partyB])
  freshGuard(h)
  buyer = await signedIn(people.buyer)
  buyerBeta = await signedIn(people.buyerBeta)
}, 300_000)

afterAll(async () => {
  forgetProgress()
  await h?.close()
})

describe('B-OC-001: the customer’s new yes for a revised order, asked as the web asks it (R1)', () => {
  let plain: { amendmentId: string; requestId: string; email: string }

  it('1 · the old call (on the ORDER) is refused: a revised order is asked on its amendment, never on the order (the bug, pinned)', async () => {
    const refused = await as(owner, 'POST', '/approvals-out', { ...askOf(orderId(), null), recordType: 'SalesOrder' }, 400)
    expect(refused.error.issues.map((issue: Json) => issue.path)).toEqual(['body/recordType'])
    expect(refused.error.message).toBe('A revised order is asked on SalesOrderAmendment.')
    expect(await admin(`SELECT 1 FROM "ApprovalRequest" WHERE kind = 'REVISED_ORDER' AND "recordType" = 'SalesOrder' AND "recordId" = $1`, [orderId()])).toEqual([])
  })

  it('2 · a plain change with the tick: asked on the amendment to the ORDERS contact — mailed, the portal’s "Review and confirm", the changes read WAITING, the waiting list names it', async () => {
    const amended = await plainChange(owner, 'Made-up: one more jacket, as the customer asked by phone.')
    expect(amended.amendment.reacceptance).toBe('NEEDED')
    const contact = await ordersContactOf(P1)
    expect(contact, 'the seeds give P1 an ORDERS contact with an e-mail').not.toBeNull()
    const made = await as(owner, 'POST', '/approvals-out', askOf(amended.amendment.id, contact!.email), 201)
    expect(made).toMatchObject({ url: null, delivery: 'SENT', request: { kind: 'REVISED_ORDER', status: 'OPEN', record: { type: 'SalesOrderAmendment', id: amended.amendment.id }, party: { id: P1 } } })
    plain = { amendmentId: amended.amendment.id, requestId: made.request.id, email: contact!.email }
    expect(lastMail('approvals.request', contact!.email), 'the request mail').toBeDefined()
    expect(await taskOf(made.request.id)).toEqual({ kind: 'RECONFIRM_ORDER', status: 'OPEN' })

    // The customer's buyer: it waits in the portal, with the order as revised and the answer open to it.
    const list = await as(buyer, 'GET', '/portal/approvals?state=OPEN')
    expect((list.items as Json[]).map((item) => item.id)).toContain(made.request.id)
    const page = await as(buyer, 'GET', `/portal/approvals/${made.request.id}`)
    expect(page.content.revisedOrder).toMatchObject({ revision: amended.amendment.revision })
    expect(page.may.answer).toBe(true)

    // The office: the changes read says WAITING with its request; the ONE waiting list names it, its kind in words.
    expect((await changeOf(owner, amended.amendment.id)).customer).toMatchObject({ decision: 'WAITING', requestId: made.request.id })
    expect((await blockersOf(owner)).find((blocker) => blocker.ref?.id === made.request.id)).toMatchObject({ kind: 'APPROVAL', on: 'BRAND', ref: { type: 'ApprovalRequest', id: made.request.id }, words: { en: "Waiting for the customer's yes: Revised order" } })
  })

  it('5 · the customer says yes in the portal: the order no longer waits, the change reads ACCEPTED, the waiting row is gone', async () => {
    const page = await as(buyer, 'GET', `/portal/approvals/${plain.requestId}`)
    await as(buyer, 'POST', `/portal/approvals/${plain.requestId}/answer`, { decision: 'APPROVED', typedName: 'Anna Buyer', version: page.request.version })
    expect((await one<{ waits: boolean }>('SELECT "reapprovalNeededAt" IS NOT NULL AS waits FROM "SalesOrder" WHERE id = $1', [orderId()])).waits).toBe(false)
    expect(await admin(`SELECT 1 FROM "AuditLog" WHERE action = 'sales.reaccepted' AND "recordId" = $1`, [orderId()])).toHaveLength(1)
    expect((await changeOf(owner, plain.amendmentId)).customer).toMatchObject({ decision: 'ACCEPTED', requestId: plain.requestId })
    expect((await blockersOf(owner)).find((blocker) => blocker.ref?.id === plain.requestId)).toBeUndefined()
    expect((await taskOf(plain.requestId)).status).toBe('DONE')
  })

  it('3 · a priced change asks too: NOT_ASKED after the save, asked on the change it answered, then WAITING', async () => {
    const order = (await as(owner, 'GET', `/sales/orders/${orderId()}`)).order
    const line = order.lines[0]
    const sizes = line.sizes.map((size: Json, index: number) => ({ size: size.size, quantity: size.quantity + (index === 0 ? 1 : 0) }))
    const applied = await as(owner, 'POST', `/sales/orders/${order.id}/priced-changes`, { version: order.version, reason: 'Made-up: one more, recut after the start.', askCustomer: true, fee: '10.00', lines: order.lines.map((entry: Json) => (entry.id === line.id ? { id: entry.id, sizes } : { id: entry.id })) }, 201)
    expect(applied.change.customer.decision).toBe('NOT_ASKED')
    const made = await as(owner, 'POST', '/approvals-out', askOf(applied.change.id, plain.email), 201)
    expect(made).toMatchObject({ delivery: 'SENT', request: { kind: 'REVISED_ORDER', status: 'OPEN', record: { type: 'SalesOrderAmendment', id: applied.change.id } } })
    expect((await changeOf(owner, applied.change.id)).customer).toMatchObject({ decision: 'WAITING', requestId: made.request.id })
    // The customer reads its own prices (the kind is priced): the parts and the fee are in what it answers.
    const page = await as(buyer, 'GET', `/portal/approvals/${made.request.id}`)
    expect(JSON.stringify(page.content.facts)).toMatch(/Change fee|Costo della modifica/)
  })

  it('4 · no address on file: the portal alone (send: false) — the link once, no mail, the portal task open; the real Sales template (no prices) may ask', async () => {
    // Sales saves the change (sizes only: no price) and asks — the web sends `send: false` when the recipient rule finds no address.
    const amended = await plainChange(sales, 'Made-up: one more, by the Sales desk.')
    expect(amended.amendment.reacceptance).toBe('NEEDED')
    const body = askOf(amended.amendment.id, null)
    const idempotency = key()
    const first = await sales.send('POST', '/approvals-out', body, { headers: { 'idempotency-key': idempotency } })
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    const made = first.body as Json
    expect(made).toMatchObject({ delivery: null, request: { kind: 'REVISED_ORDER', status: 'OPEN', record: { type: 'SalesOrderAmendment', id: amended.amendment.id } } })
    expect(typeof made.url).toBe('string')
    // The link once: the same call again answers from its receipt, with no link.
    const again = await sales.send('POST', '/approvals-out', body, { headers: { 'idempotency-key': idempotency } })
    expect([again.status, (again.body as Json).url]).toEqual([201, null])
    expect(await admin(`SELECT 1 FROM "EmailOutbound" WHERE "recordType" = 'OneOffLink' AND "recordId" IN (SELECT id FROM "OneOffLink" WHERE "recordId" = $1)`, [made.request.id])).toEqual([])
    expect(await taskOf(made.request.id)).toEqual({ kind: 'RECONFIRM_ORDER', status: 'OPEN' })
    expect((await as(buyer, 'GET', '/portal/approvals?state=OPEN')).items.map((item: Json) => item.id)).toContain(made.request.id)
    // The money wall: Sales' views of the request, the changes and the waiting list name no amount.
    const office = await as(sales, 'GET', `/approvals-out/${made.request.id}`)
    expect(JSON.stringify(office)).not.toMatch(/netAmount|grossAmount|feeAmount|unitPrice|changeAmount/)
    const change = await changeOf(sales, amended.amendment.id)
    expect(change.customer).toMatchObject({ decision: 'WAITING', requestId: made.request.id })
    for (const field of ['changeAmount', 'feeAmount', 'parts']) expect(change, field).not.toHaveProperty(field)
    const row = (await blockersOf(sales)).find((blocker) => blocker.ref?.id === made.request.id)
    expect(row).toMatchObject({ kind: 'APPROVAL', on: 'BRAND', words: { en: "Waiting for the customer's yes: Revised order" } })
    // The row's own fields only: never the question, never an amount.
    expect(Object.keys(row!).sort()).toEqual(['due', 'kind', 'on', 'ref', 'since', 'sub', 'task', 'words'])
  })

  it('6 · the walls: a person limited to Brand Beta asking on A’s revision is answered as an unknown record; Beta’s buyer never lists or opens A’s request', async () => {
    const latest = await one<{ id: string }>('SELECT id FROM "SalesOrderAmendment" WHERE "orderId" = $1 ORDER BY revision DESC LIMIT 1', [orderId()])
    const walled = await as(salesBeta, 'POST', '/approvals-out', askOf(latest.id, null), 404)
    const unknown = await as(salesBeta, 'POST', '/approvals-out', askOf(newId(), null), 404)
    expect(walled.error.message).toBe(unknown.error.message)
    expect(walled.error.message).toBe('Record not found.')
    const asked = (await admin<{ id: string }>(`SELECT id FROM "ApprovalRequest" WHERE kind = 'REVISED_ORDER' AND "partyId" = $1`, [P1])).map((row) => row.id)
    expect(asked.length).toBeGreaterThanOrEqual(3)
    // Beta's buyer: its portal lists none of A's requests (row-level security by party) and opens none.
    for (const state of ['OPEN', 'DONE']) {
      const list = await as(buyerBeta, 'GET', `/portal/approvals?state=${state}`)
      for (const id of asked) expect((list.items as Json[]).map((item) => item.id), `${state} ${id}`).not.toContain(id)
    }
    for (const id of asked) expect((await buyerBeta.get(`/portal/approvals/${id}`)).status, id).toBe(404)
    // A's own order: its production read is the unknown order's to the Beta-limited person.
    const order = await salesBeta.get(`/sales/orders/${orderId()}/production?parts=headline`)
    const none = await salesBeta.get(`/sales/orders/${newId()}/production?parts=headline`)
    expect([order.status, order.body.error?.message]).toEqual([none.status, none.body.error?.message])
  })
})
