import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FactoryClient } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { OWN_COLUMN_WORDS } from '@nexus/factory-domain/sales/own-columns/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Answer, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { officeListColumns, officeSetValue } from './commands'
import { unreadCounts } from '../../../platform/threads/reads' // owb- po2.3

/**
 * The customer's own columns (owb- order workflow, S1 po1.4; design § 5zi C, R62 a; PL-schema § 5A row 5, G8) on the local stack,
 * through the real app and the real portal sign-in by code: the factory-db seeds up to shipping (the brand SEED-C1 = P1 with its
 * orders), P1's portal and another customer's on; P1's buyer and designer, the other customer's buyer; the office through the
 * module's functions. Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs own-columns/own-columns`.
 *
 *   - a column: made (201), a duplicate name, a fixed column's name, a choice column with one choice: 409 in words; closed, kept
 *   - on a draft: at most 8; a value applies; switched off with a value: 409, unless dropValues (the value cleared); a closed column
 *     is not switched on and takes no value
 *   - on an order: the columns and a value at once, also after Confirm; the order record shows them; the Designer: 403
 *   - BRAND: customer B cannot read or write A's columns or values (404, absent); the office reaches A only over A
 *   - the floor role reads nothing of the three tables directly
 *   - po2.3 quiet lines: a column switched on on an ORDER writes one (SYSTEM, shared, its key + args, by the customer), grouped at
 *     read time; never unread; the partner feed shows it and never an office note; a draft writes none
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
const NS = 'owb-own-columns'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const SITE = seedUuid(NS, 'site:A1')

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!

const people = { buyer: 'bea.buyer@own-columns.example.com', designer: 'dino.designer@own-columns.example.com', other: 'olga.buyer@own-columns-two.example.com' }
const browsers = {} as Record<keyof typeof people, Browser>

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key } }, select: { id: true } })
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

const call = (browser: Browser, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<Answer> => browser.send(method as 'POST', url, method === 'GET' || method === 'DELETE' ? undefined : (body ?? {}))
async function ok(browser: Browser, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(browser, method, url, body)
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}

/** An office person limited to the OTHER customer (the brand wall for the office). */
const officeOf = (parties: 'all' | string[]) => callerFor(h.database, { audience: 'office', tenantId: T, actorId: newId(), requestId: newId(), grants: [{ permissions: ['orders.view', 'orders.manage'], companies: 'all', sites: 'all', parties }] })

/** A draft of P1 with one described line; its record. */
async function draftWithLine(subject: string): Promise<Json> {
  const made = await ok(browsers.buyer, 'POST', '/portal/order-requests', { source: 'PICKER', subject }, 201)
  return ok(browsers.buyer, 'POST', `/portal/order-requests/${made.request.id}/custom-lines`, { version: made.request.version, line: { description: 'Made-up suit', quantity: 2 } })
}
const column = (name: string, kind = 'TEXT', choices?: string[]) => ok(browsers.buyer, 'POST', '/portal/own-columns', { name, kind, ...(choices ? { choices } : {}) }, 201)

let order: { id: string; lineId: string }

beforeAll(async () => {
  h = await startHarness('owb_own_columns')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  tenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    const settings = await client.portalSettings.findUnique({ where: { id: P1 }, select: { id: true, version: true } })
    if (settings) await client.portalSettings.update({ where: { id: P1 }, data: { portalOn: true, version: settings.version + 1 }, select: { id: true } })
    else await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  world = await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(people.buyer, P1, ['customer-buyer'])
  await partnerPerson(people.designer, P1, ['customer-designer'])
  await partnerPerson(people.other, world.partyId, ['customer-buyer'])
  for (const key of Object.keys(people) as (keyof typeof people)[]) browsers[key] = await signedIn(people[key])
  h.clock.set(new Date(Date.now() - 2_000))
  const open = await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 AND status NOT IN ('CLOSED', 'CANCELLED') ORDER BY number LIMIT 1`, [T, P1])
  const line = await one<{ id: string }>(`SELECT id FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq LIMIT 1`, [open.id])
  order = { id: open.id, lineId: line.id }
}, 300_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('own columns (owb- po1.4)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a column is made once: a duplicate name, a fixed column’s name and a one-choice column are 409 in words', async () => {
    const rider = await column('Rider number (made up)')
    expect(rider).toMatchObject({ name: 'Rider number (made up)', kind: 'TEXT', choices: [], closed: false, version: 1 })
    const twice = await call(browsers.buyer, 'POST', '/portal/own-columns', { name: 'rider NUMBER (made up)', kind: 'TEXT' })
    expect(twice.status).toBe(409)
    expect(twice.body.error.message).toBe(OWN_COLUMN_WORDS.DUPLICATE('rider NUMBER (made up)').en)
    expect((await call(browsers.buyer, 'POST', '/portal/own-columns', { name: 'Material', kind: 'TEXT' })).status).toBe(409)
    expect((await call(browsers.buyer, 'POST', '/portal/own-columns', { name: 'Logo place (made up)', kind: 'CHOICE', choices: ['Front'] })).status).toBe(409)
    expect((await call(browsers.buyer, 'POST', '/portal/own-columns', { name: 'x'.repeat(41), kind: 'TEXT' })).status).toBe(400)
    const listed = await ok(browsers.buyer, 'GET', '/portal/own-columns')
    expect(listed.columns.map((entry: Json) => entry.name)).toContain('Rider number (made up)')
  })

  it('on a draft: at most 8, a value applies, switched off with a value only with dropValues; a closed column takes nothing new', async () => {
    const a = await column('Name on the piece (made up)')
    const b = await column('Logo ready (made up)', 'YES_NO')
    const draft = await draftWithLine('Made-up columns draft')
    const url = `/portal/order-requests/${draft.request.id}`
    const lineId = draft.request.customLines[0].id
    const used = await ok(browsers.buyer, 'PUT', `${url}/own-columns`, { version: draft.request.version, columnIds: [a.id, b.id] })
    expect(used.request.ownColumns.used.map((entry: Json) => entry.id)).toEqual([a.id, b.id])
    expect(used.request.version).toBe(draft.request.version + 1)
    const value = await ok(browsers.buyer, 'PUT', '/portal/own-values', { line: { kind: 'REQUEST_LINE', id: lineId }, columnId: b.id, value: true })
    expect(value).toEqual({ columnId: b.id, value: true, version: 1 })
    expect((await call(browsers.buyer, 'PUT', '/portal/own-values', { line: { kind: 'REQUEST_LINE', id: lineId }, columnId: b.id, value: 'yes' })).status).toBe(400)
    expect((await call(browsers.buyer, 'PUT', '/portal/own-values', { line: { kind: 'REQUEST_LINE', id: lineId }, columnId: b.id, value: false, version: 9 })).status).toBe(409)
    const read = await ok(browsers.buyer, 'GET', url)
    expect(read.request.ownColumns.values[lineId][b.id]).toMatchObject({ value: true, version: 1 })
    // Switched off with a value: refused, unless dropValues (the value is cleared, the column kept off).
    const kept = await call(browsers.buyer, 'PUT', `${url}/own-columns`, { version: read.request.version, columnIds: [a.id] })
    expect(kept.status).toBe(409)
    expect(kept.body.error.message).toBe(OWN_COLUMN_WORDS.HAS_VALUES('Logo ready (made up)').en)
    const dropped = await ok(browsers.buyer, 'PUT', `${url}/own-columns`, { version: read.request.version, columnIds: [a.id], dropValues: true })
    expect(dropped.request.ownColumns.used.map((entry: Json) => entry.id)).toEqual([a.id])
    expect((await one('SELECT "valueBool" FROM "OrderLineOwnValue" WHERE "columnId" = $1 AND "portalOrderRequestLineId" = $2', [b.id, lineId])).valueBool).toBeNull()
    // A value on a column that is not on the order: 409.
    expect((await call(browsers.buyer, 'PUT', '/portal/own-values', { line: { kind: 'REQUEST_LINE', id: lineId }, columnId: b.id, value: true })).status).toBe(409)
    // At most 8 on one order.
    const many = await Promise.all(Array.from({ length: 8 }, (_, index) => column(`Extra ${index} (made up)`)))
    const nine = await call(browsers.buyer, 'PUT', `${url}/own-columns`, { version: dropped.request.version, columnIds: [a.id, ...many.map((entry) => entry.id)] })
    expect(nine.status).toBe(409)
    expect(nine.body.error.message).toBe(OWN_COLUMN_WORDS.TOO_MANY.en)
    // Closed: never deleted, kept; not switched on again, no new value.
    const closed = await ok(browsers.buyer, 'POST', `/portal/own-columns/${b.id}/close`, { version: b.version })
    expect(closed).toMatchObject({ id: b.id, closed: true })
    const again = await call(browsers.buyer, 'PUT', `${url}/own-columns`, { version: dropped.request.version, columnIds: [a.id, b.id] })
    expect(again.status).toBe(409)
    expect(again.body.error.message).toBe(OWN_COLUMN_WORDS.CLOSED.en)
    expect((await one('SELECT count(*)::int AS n FROM "PartyLineColumn" WHERE id = $1', [b.id])).n).toBe(1)
  })

  it('on an order: the columns and a value apply at once (after Confirm); the order record shows them; the Designer may not', async () => {
    const note = await column('Comment (made up)')
    const set = await ok(browsers.buyer, 'PUT', `/portal/sales-orders/${order.id}/own-columns`, { columnIds: [note.id] })
    expect(set.ownColumns.used.map((entry: Json) => entry.id)).toEqual([note.id])
    const value = await ok(browsers.buyer, 'PUT', '/portal/own-values', { line: { kind: 'ORDER_LINE', id: order.lineId }, columnId: note.id, value: 'Made-up words for the floor' })
    expect(value.value).toBe('Made-up words for the floor')
    const record = await ok(browsers.buyer, 'GET', `/portal/sales-orders/${order.id}`)
    expect(record.ownColumns.values[order.lineId][note.id].value).toBe('Made-up words for the floor')
    expect((await call(browsers.designer, 'PUT', `/portal/sales-orders/${order.id}/own-columns`, { columnIds: [note.id] })).status).toBe(403)
    expect((await call(browsers.designer, 'PUT', '/portal/own-values', { line: { kind: 'ORDER_LINE', id: order.lineId }, columnId: note.id, value: 'x' })).status).toBe(403)
    // The history keeps from → to on the order's own audit rows.
    const audit = await one<{ before: Json; after: Json }>(`SELECT before, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'ownColumns.setValue' ORDER BY at DESC LIMIT 1`, [order.id])
    expect(audit).toMatchObject({ before: { value: null }, after: { value: 'Made-up words for the floor' } })
  })

  it('BRAND: customer B cannot read or write A’s columns or values; the office reaches A only over A', async () => {
    const secret = await column('Brand A secret (made up)')
    const draft = await draftWithLine('Made-up brand wall')
    const url = `/portal/order-requests/${draft.request.id}`
    const lineId = draft.request.customLines[0].id
    const used = await ok(browsers.buyer, 'PUT', `${url}/own-columns`, { version: draft.request.version, columnIds: [secret.id] })
    await ok(browsers.buyer, 'PUT', '/portal/own-values', { line: { kind: 'REQUEST_LINE', id: lineId }, columnId: secret.id, value: 'Made-up A only' })
    const theirs = await ok(browsers.other, 'GET', '/portal/own-columns')
    expect(JSON.stringify(theirs)).not.toContain('Brand A secret')
    expect((await call(browsers.other, 'POST', `/portal/own-columns/${secret.id}/close`, { version: secret.version })).status).toBe(404)
    expect((await call(browsers.other, 'PUT', '/portal/own-values', { line: { kind: 'REQUEST_LINE', id: lineId }, columnId: secret.id, value: 'x' })).status).toBe(404)
    expect((await call(browsers.other, 'PUT', '/portal/own-values', { line: { kind: 'ORDER_LINE', id: order.lineId }, columnId: secret.id, value: 'x' })).status).toBe(404)
    expect((await call(browsers.other, 'PUT', `${url}/own-columns`, { version: used.request.version, columnIds: [] })).status).toBe(404)
    expect((await call(browsers.other, 'PUT', `/portal/sales-orders/${order.id}/own-columns`, { columnIds: [] })).status).toBe(404)
    // B's own draft cannot name A's column (not found, as a wrong id).
    const mine = await ok(browsers.other, 'POST', '/portal/order-requests', { source: 'PICKER', subject: 'Made-up B draft' }, 201)
    expect((await call(browsers.other, 'PUT', `/portal/order-requests/${mine.request.id}/own-columns`, { version: mine.request.version, columnIds: [secret.id] })).status).toBe(404)
    // The office limited to customer B: A's columns are not found; over every customer it reads them.
    await expect(officeListColumns(h.app, officeOf([world.partyId]) as never, P1)).rejects.toThrow(/not found/)
    await expect(officeSetValue(h.app, officeOf([world.partyId]) as never, { line: { kind: 'REQUEST_LINE', id: lineId }, columnId: secret.id, value: 'x' })).rejects.toThrow(/not found/)
    expect((await officeListColumns(h.app, officeOf('all') as never, P1)).columns.map((entry) => entry.name)).toContain('Brand A secret (made up)')
  })

  it('the floor role reads nothing of the three tables directly', async () => {
    const floor = <R>(work: (client: FactoryClient) => Promise<R>) => h.database.withScope({ audience: 'floor', tenantId: T, actorId: newId(), siteId: SITE }, work)
    await expect(floor((client) => client.partyLineColumn.findMany())).rejects.toThrow(/permission denied/)
    await expect(floor((client) => client.orderLineColumnUse.count())).rejects.toThrow(/permission denied/)
    await expect(floor((client) => client.orderLineOwnValue.count())).rejects.toThrow(/permission denied/)
  })
})

describe('quiet lines (owb- po2.3)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const quietOf = (recordId: string) => admin<{ eventKey: string; eventArgs: Json; authorKind: string; audience: string; direction: string }>(`SELECT m."eventKey", m."eventArgs", m."authorKind"::text AS "authorKind", m.audience::text AS audience, m.direction::text AS direction FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordId" = $1 AND m."eventKey" IS NOT NULL ORDER BY m.at`, [recordId])

  it('a column switched on on an order: ONE quiet line each, SYSTEM and shared, grouped in the feed, never unread', async () => {
    const readerId = newId()
    const officeReader = callerFor(h.database, { audience: 'office', tenantId: T, actorId: readerId, requestId: newId(), grants: [{ permissions: ['threads.read', 'orders.view'], companies: 'all', sites: 'all', parties: 'all' }] })
    const before = (await unreadCounts(officeReader, [{ type: 'SalesOrder', id: order.id }])).counts[0]!.newCount
    const first = await column('Quiet one (made up)')
    const second = await column('Quiet two (made up)')
    const now = await ok(browsers.buyer, 'GET', `/portal/sales-orders/${order.id}`)
    await ok(browsers.buyer, 'PUT', `/portal/sales-orders/${order.id}/own-columns`, { columnIds: [...now.ownColumns.used.map((entry: Json) => entry.id), first.id, second.id] })
    const lines = (await quietOf(order.id)).filter((line) => line.eventArgs.columnId === first.id || line.eventArgs.columnId === second.id)
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(line).toMatchObject({ eventKey: 'quiet.ownColumnAdded', authorKind: 'SYSTEM', audience: 'PARTNER', direction: 'OUTBOUND', eventArgs: { by: 'CUSTOMER' } })
    // Never unread (the office's count did not move).
    expect((await unreadCounts(officeReader, [{ type: 'SalesOrder', id: order.id }])).counts[0]!.newCount).toBe(before)
    // The partner feed shows them as ONE line (one side, one key, inside 10 minutes), never an office note.
    const thread = await one<{ id: string; partyId: string }>('SELECT id, "partyId" FROM "Thread" WHERE "recordId" = $1', [order.id])
    await admin(`INSERT INTO "Message" (id, "tenantId", "threadId", direction, audience, channel, "authorKind", "bodyText", at, "createdAt") VALUES ($1, $2, $3, 'INTERNAL_NOTE', 'OFFICE', 'APP', 'SYSTEM', 'Made-up office note', now(), now())`, [newId(), T, thread.id])
    const feed = await ok(browsers.buyer, 'GET', `/portal/threads/SalesOrder/${order.id}`)
    const quiet = feed.messages.filter((message: Json) => message.event)
    expect(quiet.length).toBeGreaterThan(0)
    expect(quiet[0].event).toMatchObject({ key: 'quiet.ownColumnAdded', args: { by: 'CUSTOMER' } })
    expect(quiet[0].event.count).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(feed)).not.toContain('Made-up office note')
  })

  it('a draft writes none (silent for a draft)', async () => {
    const quietCol = await column('Draft silent (made up)')
    const draft = await draftWithLine('Made-up silent draft')
    await ok(browsers.buyer, 'PUT', `/portal/order-requests/${draft.request.id}/own-columns`, { version: draft.request.version, columnIds: [quietCol.id] })
    expect(await quietOf(draft.request.id)).toEqual([])
  })
})
