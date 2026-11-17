import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { REPLY_REFUSAL_WORDS } from '@nexus/factory-domain/threads/replies'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { SLOW_TEST_TIMEOUT_MS } from '../../testing/timeouts'
import { useAbuseGuard } from '../abuse/guard'
import { usePortalOptions } from '../auth/portal/service'
import { freshGuard, mailedCode, portalBrowser } from '../auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../auth/roles/system-roles'
import { startHarness, type Browser, type Harness } from '../auth/sessions/testing/harness'
import { systemContext } from '../outbox/system'
import { partnerFanOut } from '../portal/notifications/fan-out'
import { unsubscribeKeyOf } from '../portal/notifications/mail'

/**
 * B-TH-044 (threads plan TH-3, G15; wall test T08 / W08; Owner rule 2026-11-16: "One brand must not be able to see anything related
 * to any other brand"): POST /threads/<type>/<id>/replies — a reply the record's customer reads in its portal, with no mail. On the
 * local stack with every factory-db seed and the app's real routes; customer A is the seed's SEED-C1 (P1, with orders), customer B
 * SEED-C2 (P3), each with a portal person of its own.
 *   - A reply on A's order is an OUTBOUND PORTAL message; no mail of it is queued; A's portal person reads it on its portal thread,
 *     and the portal news tells A's people by A's own order number (never SO-…); customer B reads nothing of it, gets no notice.
 *   - One action replying on two of A's orders with one batchId is ONE bell item for A's reader (B-TH-045).
 *   - Refused: without threads.post (403), for a person limited to customer B on A's record (404), on a prospect's request
 *     (NO_PARTY), on a closed conversation (CLOSED), for a party of which nobody reads the portal (NO_PORTAL) — in words.
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/threads/portal-replies`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'portal-replies-th044'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const partyA = seedUuid(NS, 'party:P1')
const partyB = seedUuid(NS, 'party:P3')
const OFFICE = { writer: newId(), reader: newId(), betaDesk: newId() } as const
const all = { companies: 'all', sites: 'all' } as const
const SESSIONS: Record<keyof typeof OFFICE, SessionContext> = {
  writer: { audience: 'office', tenantId: T, actorId: OFFICE.writer, grants: [{ permissions: ['threads.read', 'threads.post', 'threads.manage', 'files.read'], ...all, parties: 'all' }] },
  reader: { audience: 'office', tenantId: T, actorId: OFFICE.reader, grants: [{ permissions: ['threads.read'], ...all, parties: 'all' }] },
  betaDesk: { audience: 'office', tenantId: T, actorId: OFFICE.betaDesk, grants: [{ permissions: ['threads.read', 'threads.post'], ...all, parties: [partyB] }] },
}

let h: Harness
let app: FastifyInstance
let run = 0
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const people = { aBuyer: 'ada.buyer.th044@brand-alpha.example', bBuyer: 'ben.buyer.th044@brand-beta.example' }
const ids = { aBuyer: '', bBuyer: '' }
const browsers = {} as Record<keyof typeof people, Browser>
let orders: { id: string; number: string; customerSeq: number }[] = []

const call = (who: keyof typeof OFFICE, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `th044-reply-${++run}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function reply(who: keyof typeof OFFICE, recordType: string, recordId: string, body: Json, status = 201): Promise<Json> {
  const response = await call(who, 'POST', `/threads/${recordType}/${recordId}/replies`, body)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
const refusalOf = (answer: Json): Json | undefined => (answer.issues ?? answer.error?.issues ?? []).find((issue: Json) => String(issue.path).startsWith('refusal/'))

async function partnerPerson(email: string, partyId: string): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of ['customer-buyer', 'partner-comment']) {
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

const system = () => callerFor(h.database, systemContext(T, `th044-${newId()}`))
/** The portal news of these messages, as the worker's fan-out makes it. */
async function partnerNews(messageIds: readonly string[]): Promise<void> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.message_posted' AND payload->>'messageId' = ANY($2::text[]) ORDER BY "occurredAt", id`, [T, messageIds])
  expect(rows.length).toBe(messageIds.length)
  for (const row of rows) {
    const event = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }
    await partnerFanOut(system(), event as never, { clock: h.clock, unsubscribeKey: unsubscribeKeyOf(h.auth.secrets) })
  }
}
const bell = async (who: keyof typeof people): Promise<Json[]> => {
  const answer = await browsers[who].get('/portal/notifications')
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return answer.body.items
}
const messagesOfParty = async (partyId: string) => (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."tenantId" = $1 AND t."partyId" = $2', [T, partyId]))[0]!.n
const threadsOf = async (recordType: string, recordId: string) => admin<{ id: string; version: number; status: string }>('SELECT id, version, status FROM "Thread" WHERE "tenantId" = $1 AND "recordType" = $2 AND "recordId" = $3', [T, recordType, recordId])

beforeAll(async () => {
  h = await startHarness('portal_replies_th044')
  h.clock.set(new Date())
  freshGuard(h)
  usePortalOptions({ answerFloorMs: 0 })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    for (const party of [partyA, partyB]) await client.portalSettings.upsert({ where: { id: party }, create: { id: party, partyId: party, portalOn: true }, update: { portalOn: true }, select: { id: true } })
  })
  const sales = (await admin<{ id: string }>('SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = \'sales\'', [T]))[0]!.id
  for (const person of Object.keys(OFFICE) as (keyof typeof OFFICE)[]) {
    await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, \'ACTIVE\', \'en\')', [OFFICE[person], T, `th044-${person}@example.com`, `Made-up ${person}`])
    await admin('INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, \'{}\'::uuid[], \'{}\'::uuid[], now() - interval \'30 days\')', [newId(), T, OFFICE[person], sales])
  }
  ids.aBuyer = await partnerPerson(people.aBuyer, partyA)
  ids.bBuyer = await partnerPerson(people.bBuyer, partyB)
  for (const who of Object.keys(people) as (keyof typeof people)[]) browsers[who] = await signedIn(people[who])
  orders = await admin('SELECT id, number, "customerSeq" FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 AND "companyId" = $3 AND "customerSeq" IS NOT NULL ORDER BY number LIMIT 4', [T, partyA, companyA])
  expect(orders.length).toBe(4)
  await admin('UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1', [T])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session']) as keyof typeof OFFICE] ?? null) },
  )
}, 900_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await app?.close()
  await h?.close()
})

describe('B-TH-044: reply in the portal without e-mail', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('T08: a reply on customer A’s order is a PORTAL message A reads in its portal, no mail; A’s notice names A’s own number; B gets nothing', async () => {
    const order = orders[0]!
    const bMessages = await messagesOfParty(partyB)
    const made = await reply('writer', 'SalesOrder', order.id, { body: 'Made-up: your jackets leave on Friday.' })
    expect(made.message).toMatchObject({ direction: 'OUTBOUND', audience: 'PARTNER', channel: 'PORTAL', body: 'Made-up: your jackets leave on Friday.', author: { kind: 'USER', id: OFFICE.writer, name: 'Made-up writer' } })
    expect(made.thread).toMatchObject({ recordType: 'SalesOrder', recordId: order.id, partyId: partyA, status: 'OPEN' })
    // Nothing is mailed: no outbound mail on the record's thread (the reply is read in the portal).
    expect(await admin('SELECT id FROM "EmailOutbound" WHERE "tenantId" = $1 AND "threadId" = $2', [T, made.thread.id])).toEqual([])
    // A's portal person reads it on the order's portal thread.
    const seen = await browsers.aBuyer.get(`/portal/threads/SalesOrder/${order.id}`)
    expect(seen.status, JSON.stringify(seen.body)).toBe(200)
    expect(seen.body.messages.map((message: Json) => message.body)).toContain('Made-up: your jackets leave on Friday.')
    // Customer B: the record is not found, its threads get nothing.
    const other = await browsers.bBuyer.get(`/portal/threads/SalesOrder/${order.id}`)
    expect(other.status).toBe(404)
    expect(JSON.stringify(other.body)).not.toContain('jackets leave')
    expect(await messagesOfParty(partyB)).toBe(bMessages)
    // The portal news: A's people only, by A's own order number ("#N", "your order N"), never the office's series.
    await partnerNews([made.message.id])
    const rows = await admin<{ userId: string; partyId: string; recordLabel: string; messageKey: string }>('SELECT "userId", "partyId", "recordLabel", "messageKey" FROM "Notification" WHERE "tenantId" = $1 AND "recordType" = \'SalesOrder\' AND "recordId" = $2 AND anchor = $3', [T, order.id, `message:${made.message.id}`])
    expect(rows.map((row) => row.userId)).toContain(ids.aBuyer)
    expect(rows.map((row) => row.userId)).not.toContain(ids.bBuyer)
    for (const row of rows) expect(row).toMatchObject({ partyId: partyA, recordLabel: `#${order.customerSeq}`, messageKey: 'portal.message.posted' })
    const items = (await bell('aBuyer')).filter((item) => item.record.id === order.id && item.messageKey === 'portal.message.posted')
    expect(items).toHaveLength(1)
    expect(items[0]!.sentence.en).toContain(`your order ${order.customerSeq}`)
    expect(JSON.stringify(items)).not.toContain(order.number)
    expect(JSON.stringify(await bell('bBuyer'))).not.toContain(order.id)
  })

  it('B-TH-045: one action replying on two of A’s orders with one batchId is ONE bell item for A’s reader', async () => {
    const batchId = newId()
    const first = await reply('writer', 'SalesOrder', orders[1]!.id, { body: 'Made-up: the samples are ready.', batchId })
    const second = await reply('writer', 'SalesOrder', orders[2]!.id, { body: 'Made-up: the samples are ready.', batchId })
    const events = await admin<{ batch: string }>(`SELECT payload->>'batchId' AS batch FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.message_posted' AND payload->>'messageId' = ANY($2::text[])`, [T, [first.message.id, second.message.id]])
    expect(events.map((event) => event.batch)).toEqual([batchId, batchId])
    await partnerNews([first.message.id, second.message.id])
    const grouped = (await bell('aBuyer')).filter((item) => item.group.key === `batch:${batchId}:FOLLOWING`)
    expect(grouped).toHaveLength(1)
    expect(grouped[0]!.group).toMatchObject({ count: 2, records: 2 })
    expect(JSON.stringify(await bell('bBuyer'))).not.toMatch(new RegExp(`${orders[1]!.id}|${orders[2]!.id}`))
  })

  it('W08: without threads.post 403; a person limited to customer B finds A’s order not found and writes nothing', async () => {
    const order = orders[3]!
    expect((await call('reader', 'POST', `/threads/SalesOrder/${order.id}/replies`, { body: 'Made-up: hello.' })).statusCode).toBe(403)
    const limited = await call('betaDesk', 'POST', `/threads/SalesOrder/${order.id}/replies`, { body: 'Made-up: hello.' })
    expect(limited.statusCode).toBe(404)
    expect(limited.body).not.toContain(order.number)
    expect(await threadsOf('SalesOrder', order.id)).toEqual([])
  })

  it('refused in words: a prospect’s request (make the customer first), a closed conversation, a party nobody reads the portal for', async () => {
    // A prospect's request has no party: no portal, no reply; nothing is made.
    const [{ id: prospectRequest }] = (await admin<{ id: string }>('SELECT id FROM "Inquiry" WHERE "tenantId" = $1 AND number = \'SEED-INQ-0001\' AND "partyId" IS NULL', [T])) as [{ id: string }]
    const prospect = await reply('writer', 'Inquiry', prospectRequest, { body: 'Made-up: thanks for asking.' }, 409)
    expect(refusalOf(prospect)).toMatchObject({ path: 'refusal/NO_PARTY', message: REPLY_REFUSAL_WORDS.NO_PARTY.en })
    expect(await threadsOf('Inquiry', prospectRequest)).toEqual([])
    // A closed conversation takes no reply until it is reopened.
    const order = orders[3]!
    const opened = await reply('writer', 'SalesOrder', order.id, { body: 'Made-up: one more question answered.' })
    const closed = await call('writer', 'PUT', `/threads/SalesOrder/${order.id}/status`, { status: 'CLOSED', version: opened.thread.version, reason: 'Made-up: done.' })
    expect(closed.statusCode, closed.body).toBe(200)
    const refused = await reply('writer', 'SalesOrder', order.id, { body: 'Made-up: and another.' }, 409)
    expect(refusalOf(refused)).toMatchObject({ path: 'refusal/CLOSED', message: REPLY_REFUSAL_WORDS.CLOSED.en })
    // A customer with nobody in the portal (the seed's SEED-R1): reply by e-mail instead; nothing written.
    const [lonely] = await admin<{ id: string }>('SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = \'SEED-R1\'', [T])
    const before = await messagesOfParty(lonely!.id)
    const nobody = await reply('writer', 'Party', lonely!.id, { body: 'Made-up: your sizes are noted.' }, 409)
    expect(refusalOf(nobody)).toMatchObject({ path: 'refusal/NO_PORTAL', message: REPLY_REFUSAL_WORDS.NO_PORTAL.en })
    expect(await messagesOfParty(lonely!.id)).toBe(before)
    // A file that is not this record's, shared with its party, never goes with a reply.
    const stray = await call('writer', 'POST', `/threads/SalesOrder/${orders[0]!.id}/replies`, { body: 'Made-up: see the file.', attachments: [newId()] })
    expect(stray.statusCode).toBe(400)
  })
})
