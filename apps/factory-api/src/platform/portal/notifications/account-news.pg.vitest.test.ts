import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../abuse/guard'
import { usePortalOptions } from '../../auth/portal/service'
import { freshGuard, mailedCode, portalBrowser } from '../../auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../auth/roles/system-roles'
import { startHarness, type Browser, type Harness } from '../../auth/sessions/testing/harness'
import { fanOut } from '../../notifications/fan-out'
import { systemContext } from '../../outbox/system'
import { ensureThread, writeMessage, type MessageInput, type RecordRef } from '../../threads/threads'
import { partnerFanOut } from './fan-out'
import { unsubscribeKeyOf } from './mail'

/**
 * B-TH-045 (threads plan TH-3, thread-G04, thread-G05; production lane T6; wall test T06; Owner rule 2026-11-16: "One brand must
 * not be able to see anything related to any other brand"): portal message news everywhere and at once. On the local stack with
 * every factory-db seed and the app's real routes; customer A is the seed's SEED-C1, customer B SEED-C2 (both served by every
 * company: their account conversation has no company), each with portal people.
 *   - Our message on A's account conversation (a thread with no company) tells A's people too — the bell, and by mail as it
 *     happens (MESSAGES' default, Owner decision 5) unless the person chose otherwise; B's people get nothing (T06).
 *   - A batch of ours (one answer to three of A's orders) is ONE bell item for each of A's people, its count and records theirs.
 *   - An office note to three records of two customers, mentioning two colleagues in one batch, is ONE bell item each; a colleague
 *     limited to customer A counts only A's records (the group's count and newest record are per reader).
 * Mail goes to the FAKE mailbox only; every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs portal/notifications/account-news`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'account-news-th045'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const partyA = seedUuid(NS, 'party:P1')
const partyB = seedUuid(NS, 'party:P3')
const OFFICE = { everyone: newId(), alphaDesk: newId() } as const
type OfficePerson = keyof typeof OFFICE
const SESSIONS: Record<string, SessionContext> = {
  everyone: { audience: 'office', tenantId: T, actorId: OFFICE.everyone, grants: [{ permissions: ['threads.read', 'home.view'], companies: 'all', sites: 'all', parties: 'all' }] },
  alphaDesk: { audience: 'office', tenantId: T, actorId: OFFICE.alphaDesk, grants: [{ permissions: ['threads.read', 'home.view'], companies: 'all', sites: 'all', parties: [partyA] }] },
}

let h: Harness
let app: FastifyInstance
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const people = { aBuyer: 'bea.buyer.th045@brand-alpha.example', aDaily: 'dora.daily.th045@brand-alpha.example', bBuyer: 'bo.buyer.th045@brand-beta.example' }
const ids = { aBuyer: '', aDaily: '', bBuyer: '' }
const browsers = {} as Record<keyof typeof people, Browser>
let orders: string[] = []

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

const system = () => callerFor(h.database, systemContext(T, `th045-${newId()}`))
/** Messages written in one command (as one action of the office), and their outbox events. */
async function write(entries: readonly { record: RecordRef; input: MessageInput }[]): Promise<string[]> {
  const { result } = await command(system(), { name: 'test.write', input: { n: entries.length } }, async (tools) => {
    const made: string[] = []
    for (const entry of entries) {
      const { thread } = await ensureThread(tools, entry.record, null)
      made.push((await writeMessage(tools, thread, entry.input)).id)
    }
    return made
  })
  return result
}
async function eventsOf(messageIds: readonly string[], types: readonly string[]): Promise<Json[]> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = ANY($2::text[]) AND payload->>'messageId' = ANY($3::text[]) ORDER BY "occurredAt", id`, [T, types, messageIds])
  return rows.map((row) => ({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }))
}
async function partnerNews(messageIds: readonly string[]): Promise<void> {
  for (const event of await eventsOf(messageIds, ['thread.message_posted'])) await partnerFanOut(system(), event as never, { clock: h.clock, unsubscribeKey: unsubscribeKeyOf(h.auth.secrets) })
}
async function officeNews(messageIds: readonly string[]): Promise<void> {
  for (const event of await eventsOf(messageIds, ['thread.user_mentioned', 'thread.message_posted'])) await fanOut(system(), event as never)
}
/** The seed's office person writes (a USER author has an id: the threads guard). */
const OFFICE_ACTOR = seedUuid(NS, 'actor')
const ours = (bodyText: string, batchId?: string): MessageInput => ({ direction: 'OUTBOUND', channel: 'EMAIL', author: { kind: 'USER', id: OFFICE_ACTOR, name: 'Made-up Office' }, bodyText, ...(batchId ? { batchId } : {}) })
const bell = async (who: keyof typeof people): Promise<Json[]> => {
  const answer = await browsers[who].get('/portal/notifications')
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  return answer.body.items
}
const instantMailsTo = (email: string) => h.ses.mails.filter((mail) => mail.templateKey === 'portal.notification' && mail.to[0] === email)
async function officeBell(who: OfficePerson): Promise<Json[]> {
  const response = await app.inject({ method: 'GET', url: '/notifications?limit=50', headers: { 'x-test-session': who } })
  expect(response.statusCode, response.body).toBe(200)
  return (response.json() as Json).items
}

beforeAll(async () => {
  h = await startHarness('account_news_th045')
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
  for (const [person, parties] of [['everyone', []], ['alphaDesk', [partyA]]] as const) {
    await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, \'ACTIVE\', \'en\')', [OFFICE[person], T, `th045-${person}@example.com`, `Made-up ${person}`])
    await admin('INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "partyIds", "validFrom") VALUES ($1, $2, $3, $4, true, \'{}\'::uuid[], $5::uuid[], now() - interval \'30 days\')', [newId(), T, OFFICE[person], sales, [...parties]])
  }
  ids.aBuyer = await partnerPerson(people.aBuyer, partyA)
  ids.aDaily = await partnerPerson(people.aDaily, partyA)
  ids.bBuyer = await partnerPerson(people.bBuyer, partyB)
  for (const who of Object.keys(people) as (keyof typeof people)[]) browsers[who] = await signedIn(people[who])
  // One of A's people chose the daily summary for messages: their choice wins over the default.
  const saved = await browsers.aDaily.send('PUT' as never, '/portal/email-settings', { topics: [{ topic: 'MESSAGES', frequency: 'DAILY' }] })
  expect(saved.status, JSON.stringify(saved.body)).toBe(200)
  orders = (await admin<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 AND "companyId" = $3 ORDER BY number LIMIT 3', [T, partyA, companyA])).map((row) => row.id)
  expect(orders.length).toBe(3)
  await admin('UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1', [T])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
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

describe('B-TH-045: portal message news everywhere and at once', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('thread-G04 / T06: our message on A’s account conversation (no company) tells A’s people, never B’s', async () => {
    const [threadCompany] = await admin<{ companyId: string | null }>('SELECT "companyId" FROM "Party" WHERE id = $1', [partyA])
    expect(threadCompany!.companyId).toBeNull()
    const [message] = await write([{ record: { type: 'Party', id: partyA }, input: ours('Made-up: your new price list is in the portal.') }])
    await partnerNews([message!])
    const rows = await admin<{ userId: string; partyId: string; companyId: string; messageKey: string }>('SELECT "userId", "partyId", "companyId", "messageKey" FROM "Notification" WHERE "recordType" = \'Party\' AND "recordId" = $1', [partyA])
    expect(rows.map((row) => row.userId).sort()).toEqual([ids.aBuyer, ids.aDaily].sort())
    for (const row of rows) expect(row).toMatchObject({ partyId: partyA, companyId: companyA, messageKey: 'portal.message.posted' })
    expect((await bell('aBuyer')).map((item) => item.record)).toContainEqual({ type: 'Party', id: partyA, label: expect.any(String) })
    expect(JSON.stringify(await bell('bBuyer'))).not.toContain(partyA)
  })

  it('thread-G05: as it happens by default — A’s buyer has the mail at once; the person who chose the daily summary does not', async () => {
    expect(instantMailsTo(people.aBuyer).length).toBeGreaterThanOrEqual(1)
    expect(instantMailsTo(people.aDaily)).toEqual([])
    expect(instantMailsTo(people.bBuyer)).toEqual([])
    const settings = await browsers.aBuyer.get('/portal/email-settings')
    expect(settings.body.topics.find((entry: Json) => entry.topic === 'MESSAGES')).toMatchObject({ frequency: 'INSTANT', stored: false, locked: false })
  })

  it('T6: one answer of ours to three of A’s orders (one batch) is ONE bell item for each of A’s people, its count and records theirs', async () => {
    const batch = newId()
    const made = await write(orders.map((id, index) => ({ record: { type: 'SalesOrder', id }, input: ours(`Made-up: order ${index + 1} ships on Monday.`, batch) })))
    const events = await eventsOf(made, ['thread.message_posted'])
    expect(events.map((event) => event.payload.batchId)).toEqual([batch, batch, batch])
    await partnerNews(made)
    const items = (await bell('aBuyer')).filter((item) => item.group.key.startsWith('batch:'))
    expect(items).toHaveLength(1)
    expect(items[0]!.group).toMatchObject({ count: 3, records: 3 })
    expect(orders).toContain(items[0]!.record.id)
    expect(JSON.stringify(await bell('bBuyer'))).not.toMatch(new RegExp(orders.join('|')))
  })

  it('a note to three records of two customers, mentioning two colleagues in one batch: ONE bell item each, the limited one counting A’s records only', async () => {
    const batch = newId()
    const mention = (bodyText: string): MessageInput => ({ direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'USER', id: OFFICE_ACTOR, name: 'Made-up Planner' }, bodyText, mentions: [OFFICE.everyone, OFFICE.alphaDesk], batchId: batch })
    const made = await write([
      { record: { type: 'SalesOrder', id: orders[0]! }, input: mention('Made-up: the cutting starts tomorrow.') },
      { record: { type: 'SalesOrder', id: orders[1]! }, input: mention('Made-up: the cutting starts tomorrow.') },
      { record: { type: 'Party', id: partyB }, input: mention('Made-up: the cutting starts tomorrow.') },
    ])
    await officeNews(made)
    const everyone = (await officeBell('everyone')).filter((item) => item.category === 'MENTION')
    expect(everyone).toHaveLength(1)
    expect(everyone[0]!.group).toMatchObject({ key: `batch:${batch}:MENTION`, count: 3, records: 3 })
    const limited = (await officeBell('alphaDesk')).filter((item) => item.category === 'MENTION')
    expect(limited).toHaveLength(1)
    expect(limited[0]!.group).toMatchObject({ key: `batch:${batch}:MENTION`, count: 2, records: 2 })
    expect([orders[0], orders[1]]).toContain(limited[0]!.record.id)
    expect((await admin('SELECT id FROM "Notification" WHERE "userId" = $1 AND "recordId" = $2', [OFFICE.alphaDesk, partyB])).length).toBe(0)
  })
})
