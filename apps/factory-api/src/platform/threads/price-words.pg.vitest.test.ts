import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { PRICES_IN_WORDS_WORDS } from '@nexus/factory-domain/threads/price-check'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { SLOW_TEST_TIMEOUT_MS } from '../../testing/timeouts'
import { useAbuseGuard } from '../abuse/guard'
import { usePortalOptions } from '../auth/portal/service'
import { freshGuard, mailedCode, portalBrowser } from '../auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../auth/roles/system-roles'
import { startHarness, type Browser, type Harness } from '../auth/sessions/testing/harness'

/**
 * B-CP-020 (customer page plan O5, L3; design customer-page 11 §4.6 L3; review F5, B6): prices typed in words by our own people —
 * warn, never block — through the app's real routes on a throwaway PostgreSQL 17 database from the migrations and every factory-db
 * seed (Brand Alpha = the seeds' customer SEED-C1 with its orders, its Buyer signed in to the portal; the work order SEED-WO-0001).
 *
 *   - an office note whose words look like a price is held once: 409 refusal/NAMES_A_PRICE, the warning repeats no amount, nothing
 *     is written; sent again with pricesInWordsOk it is posted as typed; a note of sizes, dates and pieces goes at once
 *   - an office reply the customer reads in its portal: 409 with the reply's own words, then sent with the tick
 *   - a note for the floor stays HELD (refusal/FLOOR_PRICE), whatever the tick
 *   - a purchase's thread talks purchase prices with its supplier: not warned (Owner O8)
 *   - the customer's own post in its portal is unchanged (an accepted residual, review B6)
 * Every name and figure is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/threads/price-words`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'price-words-cp020'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const partyA = seedUuid(NS, 'party:P1')
const WRITER = newId()
const grant = (permissions: string[]): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  writer: { audience: 'office', tenantId: T, actorId: WRITER, grants: [grant(['threads.read', 'threads.post', 'files.read', 'money.price'])] },
}
const BUYER = 'ada.buyer.cp020@brand-alpha.example'

let h: Harness
let app: FastifyInstance
let buyer: Browser
let run = 0
let order = ''
let workOrder = ''
let purchaseOrder = ''
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': 'writer', ...(method === 'GET' ? {} : { 'idempotency-key': `cp020-key-${++run}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(url: string, payload: unknown, status = 201): Promise<Json> {
  const response = await call('POST', url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
const refusalOf = (answer: Json): Json | undefined => (answer.error?.issues ?? []).find((issue: Json) => String(issue.path).startsWith('refusal/'))
const messageCount = async (recordType: string, recordId: string) =>
  (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."tenantId" = $1 AND t."recordType" = $2 AND t."recordId" = $3', [T, recordType, recordId]))[0]!.n

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

beforeAll(async () => {
  h = await startHarness('price_words_cp020')
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
    await client.portalSettings.upsert({ where: { id: partyA }, create: { id: partyA, partyId: partyA, portalOn: true }, update: { portalOn: true }, select: { id: true } })
    const id = newId()
    await client.user.create({ data: { id, email: BUYER, displayName: 'Ada Buyer', locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId: partyA, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of ['customer-buyer', 'partner-comment']) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyA], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
  await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, \'ACTIVE\', \'en\')', [WRITER, T, 'cp020-writer@example.com', 'Made-up writer'])
  await admin('UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1', [T])
  buyer = await signedIn(BUYER)
  order = (await admin<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 AND "companyId" = $3 ORDER BY number LIMIT 1', [T, partyA, companyA]))[0]!.id
  workOrder = (await admin<{ id: string }>("SELECT id FROM \"WorkOrder\" WHERE \"tenantId\" = $1 AND number = 'SEED-WO-0001'", [T]))[0]!.id
  purchaseOrder = (await admin<{ id: string }>('SELECT id FROM "PurchaseOrder" WHERE "tenantId" = $1 ORDER BY number LIMIT 1', [T]))[0]!.id
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
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
}, 60_000)

describe('B-CP-020 prices typed in words: warn, never block', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('an office note naming a price is held once; the warning repeats no amount; nothing is written; sent anyway it is posted', async () => {
    for (const body of ['Made-up: il cliente paga € 12,50 al pezzo', 'Made-up: we quoted 12.50 EUR a jacket', 'Made-up: prezzo 40 per la giacca']) {
      const before = await messageCount('SalesOrder', order)
      const held = await call('POST', `/threads/SalesOrder/${order}/notes`, { body })
      expect(held.statusCode, held.body).toBe(409)
      const answer = held.json() as Json
      expect(refusalOf(answer)).toEqual({ path: 'refusal/NAMES_A_PRICE', message: PRICES_IN_WORDS_WORDS.note.en })
      expect(answer.error.message).toBe(PRICES_IN_WORDS_WORDS.note.en)
      // The money wall: the words that looked like a price are never echoed back.
      expect(held.body).not.toMatch(/12,50|12\.50|prezzo 40|€/)
      expect(await messageCount('SalesOrder', order)).toBe(before)
      const posted = await ok(`/threads/SalesOrder/${order}/notes`, { body, pricesInWordsOk: true })
      expect(posted.message).toMatchObject({ direction: 'INTERNAL_NOTE', audience: 'OFFICE', body })
      expect(await messageCount('SalesOrder', order)).toBe(before + 1)
    }
  })

  it('a note of sizes, dates and pieces goes at once (no warning)', async () => {
    for (const body of ['Made-up: taglia XL 52, 30 pezzi', 'Made-up: consegna il 12/11/2026, ordine del 2026-11-19', 'Made-up: Europa 2026, cuciture rinforzate da 3 mm']) {
      const posted = await ok(`/threads/SalesOrder/${order}/notes`, { body })
      expect(posted.message.body).toBe(body)
    }
  })

  it('an office reply the customer reads in its portal: held with the reply’s own words, then sent with the tick', async () => {
    const before = await messageCount('SalesOrder', order)
    const body = 'Made-up: your price stays € 99,00 a jacket'
    const held = await call('POST', `/threads/SalesOrder/${order}/replies`, { body })
    expect(held.statusCode, held.body).toBe(409)
    expect(refusalOf(held.json() as Json)).toEqual({ path: 'refusal/NAMES_A_PRICE', message: PRICES_IN_WORDS_WORDS.reply.en })
    expect(held.body).not.toMatch(/99,00|€/)
    expect(await messageCount('SalesOrder', order)).toBe(before)
    const sent = await ok(`/threads/SalesOrder/${order}/replies`, { body, pricesInWordsOk: true })
    expect(sent.message).toMatchObject({ direction: 'OUTBOUND', channel: 'PORTAL', body })
    // The customer reads it as sent (its own price talk with us).
    const seen = await buyer.get(`/portal/threads/SalesOrder/${order}`)
    expect(seen.status, JSON.stringify(seen.body)).toBe(200)
    expect(seen.body.messages.map((message: Json) => message.body)).toContain(body)
  })

  it('a note for the floor stays HELD (FLOOR_PRICE), whatever the tick; nothing is written', async () => {
    const before = await messageCount('WorkOrder', workOrder)
    const held = await call('POST', `/threads/WorkOrder/${workOrder}/notes`, { body: 'Made-up: prezzo: 42 per capo', forFloor: true, pricesInWordsOk: true })
    expect(held.statusCode, held.body).toBe(409)
    expect(refusalOf(held.json() as Json)?.path).toBe('refusal/FLOOR_PRICE')
    expect(await messageCount('WorkOrder', workOrder)).toBe(before)
    // The same words as an office note of the work order: held once, then posted (it stays in the office).
    expect(refusalOf((await call('POST', `/threads/WorkOrder/${workOrder}/notes`, { body: 'Made-up: prezzo: 42 per capo' })).json() as Json)?.path).toBe('refusal/NAMES_A_PRICE')
    expect((await ok(`/threads/WorkOrder/${workOrder}/notes`, { body: 'Made-up: prezzo: 42 per capo', pricesInWordsOk: true })).message).toMatchObject({ forFloor: false })
  })

  it('a purchase’s thread talks purchase prices with its supplier: not warned (Owner O8)', async () => {
    const posted = await ok(`/threads/PurchaseOrder/${purchaseOrder}/notes`, { body: 'Made-up: the mill asks € 3,20 a metre now' })
    expect(posted.message.body).toBe('Made-up: the mill asks € 3,20 a metre now')
  })

  it('the customer’s own post in its portal is unchanged (an accepted residual, review B6)', async () => {
    const before = await messageCount('SalesOrder', order)
    const posted = await buyer.send('POST', `/portal/threads/SalesOrder/${order}/messages`, { body: 'Made-up: our budget is € 95,00 a jacket' }, { headers: { 'idempotency-key': `cp020-portal-${newId()}` } })
    expect(posted.status, JSON.stringify(posted.body)).toBeLessThan(300)
    expect(await messageCount('SalesOrder', order)).toBe(before + 1)
  })
})
