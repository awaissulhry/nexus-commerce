import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { ORDER_CHIPS, ORDER_GROUPS } from '@nexus/factory-domain/sales/portal-orders/status'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * pg-s1 S1.5 — the wall of the numbers of Portal › Orders (portal grid plan § 5 pg-2.1–2.3; 15-steps GAP-1 on the model of PW-11,
 * GAP-4): every number the portal's band, chips and count show is counted by the server over the customer's OWN rows, read in the
 * partner scope (row-level security), never another customer's. Through the real app and the real portal sign-in by code, on the
 * factory-db seeds up to shipping (Brand A = the seeded customer SEED-C1 with SEED-SO-0001/0002/0003; Brand B = another customer,
 * no orders). Each brand is given a row in EVERY group — an order waiting for our yes and the request it came from (an ORDER_WAITING
 * pair: counted once), a catalogue request, a request sent, one we asked something about (NEED_INFO), an order to re-confirm, in
 * production, ready, shipped in part and all, delivered, cancelled, and a withdrawn request (Closed requests) — written with the
 * database's rules off (the reads are what is tested here, not how the office makes these rows). Every name and number is made up.
 *
 *   - Brand A's `groups`, `open`, `needsYou`, `chips` and `count` move by exactly its own rows; Brand B's rows never move them; the
 *     same the other way; one more order on either side moves only that side.
 *   - no office series in any list or sheet answer: no RQ-, SH-, SEED-SO- (and none of this test's own office numbers).
 *   - a number alone searches the customer's own number exactly: "12" and "#12" find "Your order 12" only (never 112, never an order
 *     whose hidden office number holds 12, never another customer's "Your order 12"); the band does not follow the search.
 *   - a REQUEST row's number is null; an OPEN order's `needsYou` follows its re-confirmation wait (a cancelled or delivered one never).
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/portal-orders`.
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
const NS = 'portal-orders-counts'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!

const people = { a: 'ada.buyer@seed-racing.example', b: 'bea.buyer@other-brand.example' }
const browsers = {} as Record<keyof typeof people, Browser>

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<void> {
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    const id = newId()
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
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

async function ok(browser: Browser, url: string): Promise<Json> {
  const answer = await browser.get(url)
  expect(answer.status, `${url}: ${JSON.stringify(answer.body)}`).toBe(200)
  return answer.body as Json
}

// ---- the rows, written with the database's rules off (replica): the reads are what is tested ----------------------------------

async function forced(sql: string, values: unknown[]): Promise<void> {
  await h.db.admin.query('BEGIN')
  try {
    await h.db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await h.db.admin.query(sql, values)
    await h.db.admin.query('COMMIT')
  } catch (error) {
    await h.db.admin.query('ROLLBACK')
    throw error
  }
}

/** The seeded order whose columns a made-up order copies (its own facts given over them). */
let template = ''

/** An order of the party: a copy of the template with its own id, number, customer number, PO and status (no lines, no shipment). */
async function order(partyId: string, facts: { readonly number: string; readonly seq: number; readonly ref: string; readonly status: string; readonly reconfirm?: boolean }): Promise<string> {
  const id = newId()
  const changes = {
    id,
    partyId,
    number: facts.number,
    customerSeq: facts.seq,
    customerRef: facts.ref,
    status: facts.status,
    quoteVersionId: null,
    reapprovalNeededAt: facts.reconfirm ? new Date().toISOString() : null,
    closedAt: null,
    deliveredAt: facts.status === 'DELIVERED' ? new Date().toISOString() : null,
    cancelReason: null,
    internalNote: null,
    costAmount: null,
    billTo: { name: 'Made-up billing' },
    shipTo: { name: 'Made-up delivery' },
    version: 1,
  }
  await forced('INSERT INTO "SalesOrder" SELECT * FROM jsonb_populate_record(NULL::"SalesOrder", (SELECT to_jsonb(o) || $1::jsonb FROM "SalesOrder" o WHERE o.id = $2::uuid))', [JSON.stringify(changes), template])
  return id
}

/** A catalogue order request of the party, SENT and not decided yet (the list's REQUEST row), with the company's RQ- number. */
async function catalogueRequest(partyId: string, facts: { readonly number: string; readonly ref: string }): Promise<string> {
  const id = newId()
  await forced(`INSERT INTO "PortalOrderRequest" (id, "tenantId", "companyId", "partyId", number, "customerRef", currency, status, "sentAt", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, 'EUR', 'SENT', now(), now(), now())`, [id, T, companyA, partyId, facts.number, facts.ref])
  return id
}

/** pg-fx4: a draft of the party sent with its subject (the draft's title), no PO: a REQUEST row of the list, as the Owner's own. */
async function sentDraft(partyId: string, facts: { readonly number: string; readonly subject: string }): Promise<string> {
  const id = newId()
  await forced(`INSERT INTO "PortalOrderRequest" (id, "tenantId", "companyId", "partyId", number, subject, currency, status, "sentAt", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, 'EUR', 'SENT', now(), now(), now())`, [id, T, companyA, partyId, facts.number, facts.subject])
  return id
}

/** A request (inquiry) of the party sent from its portal, in a status; ORDERED names the order made from it. */
async function request(partyId: string, facts: { readonly number: string; readonly seq: number; readonly status: string; readonly orderId?: string }): Promise<string> {
  const id = newId()
  const closed = ['ORDERED', 'DECLINED', 'LOST', 'WITHDRAWN'].includes(facts.status)
  await forced(
    `INSERT INTO "Inquiry" (id, "tenantId", "companyId", number, "customerSeq", source, "receivedAt", "partyId", request, status, "salesOrderId", "closedAt", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, 'PORTAL', now(), $6, $7, $8, $9, $10, now(), now())`,
    [id, T, companyA, facts.number, facts.seq, partyId, `Made-up request ${facts.number}`, facts.status, facts.orderId ?? null, closed ? new Date() : null],
  )
  return id
}

/**
 * A row of the party in every group of the band. The order to re-confirm is "Your order 12", the one in production "Your order 112";
 * the ready one's hidden office number holds "12". POs and office numbers are the brand's own (PG-A-…, TPG-SO-A-…), never holding "12"
 * except where said.
 */
async function everyGroup(partyId: string, tag: 'A' | 'B') {
  const office = (what: string) => `TPG-SO-${tag}-${what}`
  const po = (what: string) => `PG-${tag}-${what}`
  const waiting = await order(partyId, { number: office('WAIT'), seq: 941, ref: po('WAIT'), status: 'PENDING_APPROVAL' })
  return {
    waiting,
    confirmed: await order(partyId, { number: office('CONF'), seq: 12, ref: po('CONF'), status: 'CONFIRMED', reconfirm: true }),
    production: await order(partyId, { number: office('PROD'), seq: 112, ref: po('PROD'), status: 'IN_PRODUCTION' }),
    ready: await order(partyId, { number: office('0012'), seq: 943, ref: po('READY'), status: 'READY' }),
    partly: await order(partyId, { number: office('PART'), seq: 944, ref: po('PART'), status: 'PARTLY_SHIPPED' }),
    shipped: await order(partyId, { number: office('LEFT'), seq: 945, ref: po('LEFT'), status: 'SHIPPED' }),
    delivered: await order(partyId, { number: office('DELI'), seq: 946, ref: po('DELI'), status: 'DELIVERED' }),
    cancelled: await order(partyId, { number: office('CANC'), seq: 947, ref: po('CANC'), status: 'CANCELLED' }),
    catalogue: await catalogueRequest(partyId, { number: `RQ-PG-${tag}-0001`, ref: po('CATALOGUE') }),
    sent: await request(partyId, { number: `TPG-INQ-${tag}-1`, seq: 971, status: 'NEW' }),
    needInfo: await request(partyId, { number: `TPG-INQ-${tag}-2`, seq: 972, status: 'NEED_INFO' }),
    pair: await request(partyId, { number: `TPG-INQ-${tag}-3`, seq: 973, status: 'ORDERED', orderId: waiting }),
    withdrawn: await request(partyId, { number: `TPG-INQ-${tag}-4`, seq: 974, status: 'WITHDRAWN' }),
  }
}

// ---- the numbers --------------------------------------------------------------------------------------------------------------

type Numbers = { groups: Record<string, number>; open: number; needsYou: number; chips: Record<string, number>; count: number }

const numbersOf = (sheet: Json): Numbers => ({
  groups: Object.fromEntries((sheet.groups as Json[]).map((entry) => [entry.group, entry.count])),
  open: sheet.open,
  needsYou: sheet.needsYou,
  chips: Object.fromEntries((sheet.chips as Json[]).map((entry) => [entry.chip, entry.count])),
  count: sheet.count,
})

const ZERO: Numbers = { groups: Object.fromEntries(ORDER_GROUPS.map((group) => [group, 0])), open: 0, needsYou: 0, chips: Object.fromEntries(ORDER_CHIPS.map((chip) => [chip, 0])), count: 0 }

/**
 * What one brand's rows of `everyGroup` add: Requests = the order waiting + the catalogue request + the request sent + the one we
 * asked about (its ORDER_WAITING request is that order's row: never twice); Shipped = partly + all; Closed requests = the withdrawn
 * one. Open = Requests … Shipped. Needs you = the NEED_INFO request + the order to re-confirm. The chips count the list's rows (orders
 * and the catalogue request; the default chip OPEN gives `count`).
 */
const EVERY_GROUP: Numbers = {
  groups: { REQUESTS: 4, CONFIRMED: 1, IN_PRODUCTION: 1, READY: 1, SHIPPED: 2, DELIVERED: 1, CANCELLED: 1, CLOSED_REQUESTS: 1 },
  open: 9,
  needsYou: 2,
  chips: { OPEN: 7, REQUESTED: 2, CONFIRMED: 1, IN_PRODUCTION: 1, READY: 1, SHIPPED: 2, DELIVERED: 1, CANCELLED: 1, ALL: 9, DATE_MOVED: 0 },
  count: 7,
}
/** One more confirmed order. */
const ONE_CONFIRMED: Numbers = { groups: { ...ZERO.groups, CONFIRMED: 1 }, open: 1, needsYou: 0, chips: { ...ZERO.chips, OPEN: 1, CONFIRMED: 1, ALL: 1 }, count: 1 }

const add = (a: Numbers, b: Numbers): Numbers => {
  const sum = (x: Record<string, number>, y: Record<string, number>) => Object.fromEntries(Object.keys(x).map((key) => [key, x[key]! + (y[key] ?? 0)]))
  return { groups: sum(a.groups, b.groups), open: a.open + b.open, needsYou: a.needsYou + b.needsYou, chips: sum(a.chips, b.chips), count: a.count + b.count }
}

const sheetOf = async (who: keyof typeof people, query = '') => ok(browsers[who], `/portal/sales-orders/sheet${query}`)
const numbers = async (who: keyof typeof people) => numbersOf(await sheetOf(who))
const ids = (answer: Json): string[] => (answer.items as Json[]).map((row) => row.id as string)

beforeAll(async () => {
  h = await startHarness('portal_order_counts')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  tenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    // The portal's sign-in mail sender (as tenant set-up makes it): a FAKE SES account and company A's NOTIFICATION identity.
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  // Company A's portal terms and Brand B (another customer, no orders) with its portal on.
  world = await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(people.a, P1, ['customer-buyer'])
  await partnerPerson(people.b, world.partyId, ['customer-buyer'])
  for (const key of Object.keys(people) as (keyof typeof people)[]) browsers[key] = await signedIn(people[key])
  template = (await one<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2', [T, 'SEED-SO-0001'])).id
}, 240_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('pg-s1 S1.5 the band of Portal › Orders counts each customer’s own rows only (GAP-1, as PW-11)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  type Made = Awaited<ReturnType<typeof everyGroup>>
  let start: Numbers
  const made = {} as { A: Made; B: Made }

  it('the sheet says the band; the plain list (Home’s read) keeps its shape; Brand B, with no rows, reads all zero', async () => {
    start = await numbers('a')
    expect(Object.keys(start.groups)).toEqual([...ORDER_GROUPS])
    expect(start.chips.ALL).toBeGreaterThan(0) // the seeded orders
    expect(await numbers('b')).toEqual(ZERO)
    const list = await ok(browsers.a, '/portal/sales-orders')
    for (const key of ['groups', 'open', 'needsYou']) expect(list, key).not.toHaveProperty(key)
  })

  it('Brand A’s rows in every group move Brand A’s numbers by exactly its own rows — and Brand B’s not at all', async () => {
    made.A = await everyGroup(P1, 'A')
    expect(await numbers('a')).toEqual(add(start, EVERY_GROUP))
    expect(await numbers('b')).toEqual(ZERO)
  })

  it('Brand B’s rows in every group: its numbers are exactly its own rows; Brand A’s do not move', async () => {
    made.B = await everyGroup(world.partyId, 'B')
    expect(await numbers('b')).toEqual(EVERY_GROUP)
    expect(await numbers('a')).toEqual(add(start, EVERY_GROUP))
  })

  it('one more order on either side moves only that side', async () => {
    await order(world.partyId, { number: 'TPG-SO-B-MORE', seq: 948, ref: 'PG-B-MORE', status: 'CONFIRMED' })
    expect(await numbers('b')).toEqual(add(EVERY_GROUP, ONE_CONFIRMED))
    expect(await numbers('a')).toEqual(add(start, EVERY_GROUP))
    await order(P1, { number: 'TPG-SO-A-MORE', seq: 948, ref: 'PG-A-MORE', status: 'CONFIRMED' })
    expect(await numbers('a')).toEqual(add(add(start, EVERY_GROUP), ONE_CONFIRMED))
    expect(await numbers('b')).toEqual(add(EVERY_GROUP, ONE_CONFIRMED))
  })

  it('GAP-4: no office series in any list or sheet answer — and nothing of the other customer', async () => {
    const SERIES = /\bRQ-|\bSH-|SEED-SO-|TPG-SO-|TPG-INQ-/
    for (const [who, other] of [['a', ['PG-B-', 'Brand Alpha', made.B.confirmed]], ['b', ['PG-A-', 'SEED-PO-', 'Seed Racing', made.A.confirmed, template]]] as const) {
      for (const url of ['/portal/sales-orders?chip=ALL&limit=200', '/portal/sales-orders/sheet?chip=ALL&limit=200']) {
        const text = JSON.stringify(await ok(browsers[who], url))
        expect(text, `${who} ${url}`).not.toMatch(SERIES)
        for (const word of other) expect(text, `${who} ${url}: ${word}`).not.toContain(word)
      }
    }
    // A REQUEST row's number is null (was the company's RQ-…); every row's number is null.
    const sheet = await sheetOf('a', '?chip=ALL&limit=200')
    const rows = new Map((sheet.items as Json[]).map((row) => [row.id as string, row]))
    expect(rows.get(made.A.catalogue)).toMatchObject({ kind: 'REQUEST', number: null, customerRef: 'PG-A-CATALOGUE', needsYou: false })
    expect((sheet.items as Json[]).every((row) => row.number === null)).toBe(true)
  })

  it('a number alone is the customer’s own number, exactly: "12" and "#12" find "Your order 12" only; the band does not follow the search', async () => {
    const search = async (who: keyof typeof people, q: string) => ok(browsers[who], `/portal/sales-orders?chip=ALL&q=${encodeURIComponent(q)}`)
    // Never 112, never the order whose hidden office number holds 12 (TPG-SO-A-0012), never another customer's "Your order 12".
    expect(ids(await search('a', '12'))).toEqual([made.A.confirmed])
    expect(ids(await search('a', '#12'))).toEqual([made.A.confirmed])
    expect((await search('a', '12')).items[0].yourNumber).toMatchObject({ seq: 12, words: { en: 'Your order 12' } })
    expect(ids(await search('a', '112'))).toEqual([made.A.production])
    expect(ids(await search('b', '12'))).toEqual([made.B.confirmed])
    expect(ids(await search('b', '#12'))).toEqual([made.B.confirmed])
    // Words as before: the office number still finds its order (printed on its confirmation), the request's number its request.
    expect(ids(await search('a', 'TPG-SO-A-0012'))).toEqual([made.A.ready])
    expect(ids(await search('a', 'RQ-PG-A'))).toEqual([made.A.catalogue])
    expect(ids(await search('b', 'TPG-SO-A-0012'))).toEqual([])
    // The sheet: the chips and the count follow the search, the band does not.
    const all = numbersOf(await sheetOf('a'))
    const searched = numbersOf(await sheetOf('a', `?q=${encodeURIComponent('12')}`))
    expect({ groups: searched.groups, open: searched.open, needsYou: searched.needsYou }).toEqual({ groups: all.groups, open: all.open, needsYou: all.needsYou })
    expect(searched.chips).toMatchObject({ ALL: 1, CONFIRMED: 1, OPEN: 1 })
    expect(searched.count).toBe(1)
  })

  it('an order’s needsYou follows its re-confirmation wait; the band’s needsYou with it', async () => {
    const row = async () => (await sheetOf('a', '?chip=ALL&limit=200')).items.find((entry: Json) => entry.id === made.A.confirmed)
    expect(await row()).toMatchObject({ needsYou: true })
    expect((await sheetOf('a', '?chip=ALL&limit=200')).items.filter((entry: Json) => entry.needsYou).map((entry: Json) => entry.id)).toEqual([made.A.confirmed])
    const before = await numbers('a')
    await forced('UPDATE "SalesOrder" SET "reapprovalNeededAt" = NULL WHERE id = $1', [made.A.confirmed])
    expect(await row()).toMatchObject({ needsYou: false })
    expect((await numbers('a')).needsYou).toBe(before.needsYou - 1)
    // Brand B's own order to re-confirm still waits for Brand B only.
    expect((await numbers('b')).needsYou).toBe(EVERY_GROUP.needsYou)
    // Only an OPEN order needs the customer: a cancelled or delivered order with a stale re-confirmation wait is not needsYou, in the
    // row and in the band.
    const stale = await numbers('a')
    await forced('UPDATE "SalesOrder" SET "reapprovalNeededAt" = now() WHERE id = ANY($1::uuid[])', [[made.A.cancelled, made.A.delivered]])
    const rows = new Map(((await sheetOf('a', '?chip=ALL&limit=200')).items as Json[]).map((entry) => [entry.id as string, entry]))
    expect(rows.get(made.A.cancelled)).toMatchObject({ status: 'CANCELLED', needsYou: false })
    expect(rows.get(made.A.delivered)).toMatchObject({ status: 'DELIVERED', needsYou: false })
    expect((await numbers('a')).needsYou).toBe(stale.needsYou)
  })

  it('pg-fx4 (Z5): a sent draft carries its subject (an order and a draft without one: null); words find it — each customer its own only', async () => {
    const subjects = { a: 'PGFX4 made-up suit for the alpha riders', b: 'PGFX4 made-up vests for the beta riders' }
    const draft = { a: await sentDraft(P1, { number: 'RQ-PG-A-0002', subject: subjects.a }), b: await sentDraft(world.partyId, { number: 'RQ-PG-B-0002', subject: subjects.b }) }
    for (const url of ['/portal/sales-orders?chip=ALL&limit=200', '/portal/sales-orders/sheet?chip=ALL&limit=200']) {
      const rows = new Map(((await ok(browsers.a, url)).items as Json[]).map((row) => [row.id as string, row]))
      expect(rows.get(draft.a), url).toMatchObject({ kind: 'REQUEST', subject: subjects.a, customerRef: null, number: null, yourNumber: null })
      expect(rows.get(made.A.catalogue), url).toMatchObject({ kind: 'REQUEST', subject: null })
      expect(rows.get(made.A.confirmed), url).toMatchObject({ kind: 'ORDER', subject: null })
      // The wall: never the other customer's subject (or its row), either way.
      expect(JSON.stringify(await ok(browsers.b, url)), url).not.toContain(subjects.a)
      expect(JSON.stringify(await ok(browsers.a, url)), url).not.toContain(subjects.b)
      expect(rows.has(draft.b), url).toBe(false)
    }
    const search = async (who: keyof typeof people, q: string) => ids(await ok(browsers[who], `/portal/sales-orders?chip=ALL&q=${encodeURIComponent(q)}`))
    expect(await search('a', 'made-up suit')).toEqual([draft.a])
    expect(await search('a', 'MADE-UP SUIT FOR THE ALPHA')).toEqual([draft.a])
    expect(await search('b', 'made-up vests')).toEqual([draft.b])
    expect(await search('b', 'made-up suit')).toEqual([])
    expect(await search('a', 'made-up vests')).toEqual([])
    expect(await search('a', 'PGFX4')).toEqual([draft.a])
  })
})
