import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { buildApp } from '../../core/app'
import { callerFor, command } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { SLOW_TEST_TIMEOUT_MS } from '../../testing/timeouts'
import { useAbuseGuard } from '../abuse/guard'
import { usePortalOptions } from '../auth/portal/service'
import { freshGuard } from '../auth/portal/testing/portal'
import { startHarness, type Browser, type Harness } from '../auth/sessions/testing/harness'
import { partnerWorld, signIn, type PartnerWorld } from '../search/partner/testing/world'
import { ensureThread, writeMessage } from './threads'
import { DONE_WORDS } from './work-state'

/**
 * B-TH-093 (threads plan TH-9, N18; T1-F13; wall W08: "the work state is office only"): Done — a work state apart from Close.
 *
 *   the office   marks brand A's conversation done: it leaves the head's waiting and Customer replies; marking twice changes nothing;
 *                a closed conversation, or one with no message yet, is refused in words; a reader who may not write cannot mark it
 *   brand A      still writes (Done never closes) and is never told; its post makes the conversation open work again, as our own
 *                message shared with it does
 *
 * Base seeds in one namespace, a real portal sign-in, office sessions by the test authenticator. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/threads`.
 */

let h: Harness
let world: PartnerWorld
let app: FastifyInstance
let alpha: Browser
let run = 0
let order = ''
let quiet = ''
const NS = 'th093done'
const office = { writer: newId(), reader: newId() }

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const sessions = (): Record<string, SessionContext> => ({
  writer: { audience: 'office', tenantId: world.tenantId, actorId: office.writer, grants: [{ permissions: ['threads.read', 'threads.post', 'threads.manage', 'orders.view'], companies: 'all', sites: 'all', parties: 'all' }] },
  reader: { audience: 'office', tenantId: world.tenantId, actorId: office.reader, grants: [{ permissions: ['threads.read', 'orders.view'], companies: 'all', sites: 'all', parties: 'all' }] },
})
const call = async (who: keyof typeof office, method: 'GET' | 'PUT', url: string, payload?: Json) => {
  const response = await app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `th093-${++run}` }) }, ...(payload ? { payload } : {}) })
  return { status: response.statusCode, body: response.json() as Json }
}
const markDone = (done: boolean, recordId = order) => call('writer', 'PUT', `/threads/SalesOrder/${recordId}/done`, { done })
const head = async () => (await call('writer', 'GET', `/threads/SalesOrder/${order}`)).body
const waitingIds = async (): Promise<string[]> => (await call('writer', 'GET', '/threads/waiting?side=CUSTOMER&limit=100')).body.rows.map((row: Json) => row.recordId)

/** Our own message shared with the customer, written as the email step does (the threads seam). */
async function ourMail(text: string): Promise<void> {
  const seam = callerFor(h.database, { audience: 'office', tenantId: world.tenantId, actorId: world.officeId, grants: [], requestId: newId() })
  await command(seam, { name: 'email.send', input: { order, text } }, async (tools) => {
    const { thread } = await ensureThread(tools, { type: 'SalesOrder', id: order }, world.officeId)
    await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'EMAIL', author: { kind: 'USER', id: world.officeId, name: 'Seed Owner' }, bodyText: text })
    return null
  })
}

beforeAll(async () => {
  h = await startHarness('work_state_th093')
  h.clock.set(new Date())
  freshGuard(h)
  world = await partnerWorld(h, NS)
  for (const [key, id] of Object.entries(office)) await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, \'ACTIVE\', \'en\')', [id, world.tenantId, `th093-${key}@example.com`, `Made-up ${key}`])
  order = (await admin<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001' AND "partyId" = $2`, [world.tenantId, world.p1]))[0]!.id
  quiet = (await admin<{ id: string }>(`SELECT o.id FROM "SalesOrder" o WHERE o."tenantId" = $1 AND o."partyId" = $2 AND NOT EXISTS (SELECT 1 FROM "Thread" t WHERE t."recordType" = 'SalesOrder' AND t."recordId" = o.id) ORDER BY o.number LIMIT 1`, [world.tenantId, world.p1]))[0]!.id
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => sessions()[String(request.headers['x-test-session'])] ?? null) },
  )
  alpha = await signIn(h, world, world.people.buyer)
  // Brand A writes: the conversation waits on us.
  await ourMail('Made-up: your order is confirmed.')
  const posted = await alpha.send('POST', `/portal/threads/SalesOrder/${order}/messages`, { body: 'Made-up: can the lining be red?' }, { headers: { 'idempotency-key': `th093-${++run}` } })
  expect(posted.status, JSON.stringify(posted.body)).toBe(201)
}, 600_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await app?.close()
  await h?.close()
})

describe('B-TH-093: Done leaves the waiting views, never closes', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('waiting on us before; marked done it waits on nobody and leaves Customer replies; marking twice changes nothing', async () => {
    expect((await head()).head.waiting).toMatchObject({ on: 'US' })
    expect(await waitingIds()).toContain(order)
    const done = await markDone(true)
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.done).toMatchObject({ by: { id: office.writer, name: 'Made-up writer' } })
    const after = await head()
    expect(after.done).toMatchObject({ by: { id: office.writer } })
    expect(after.head.waiting).toBeNull()
    expect(after.thread.status).toBe('OPEN')
    expect(await waitingIds()).not.toContain(order)
    expect((await markDone(true)).body.done.at).toBe(done.body.done.at)
  })

  it('brand A still writes and is never told; its post makes the conversation open work again', async () => {
    for (const url of [`/threads/SalesOrder/${order}`, `/portal/threads/SalesOrder/${order}`]) {
      const answer = await alpha.get(url)
      expect(answer.status, JSON.stringify(answer.body)).toBe(200)
      expect(JSON.stringify(answer.body)).not.toMatch(/"done"|doneAt|doneBy|Made-up writer/)
    }
    const posted = await alpha.send('POST', `/portal/threads/SalesOrder/${order}/messages`, { body: 'Made-up: one more question.' }, { headers: { 'idempotency-key': `th093-${++run}` } })
    expect(posted.status, JSON.stringify(posted.body)).toBe(201)
    const after = await head()
    expect(after.done).toBeNull()
    expect(after.head.waiting).toMatchObject({ on: 'US' })
    expect(await waitingIds()).toContain(order)
  })

  it('our own message shared with the customer reopens it too; opening again by hand works', async () => {
    expect((await markDone(true)).body.done).not.toBeNull()
    await ourMail('Made-up: yes, red works.')
    expect((await head()).done).toBeNull()
    expect((await markDone(true)).body.done).not.toBeNull()
    expect((await markDone(false)).body.done).toBeNull()
  })
})

describe('B-TH-093: refusals in words', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a conversation with no message yet, a closed one, and a reader who may not write', async () => {
    const none = await markDone(true, quiet)
    expect(none.status, JSON.stringify(none.body)).toBe(409)
    expect(JSON.stringify(none.body)).toContain(DONE_WORDS.NO_THREAD.en)
    expect((await call('reader', 'PUT', `/threads/SalesOrder/${order}/done`, { done: true })).status).toBe(403)
    const thread = (await head()).thread
    const closed = await call('writer', 'PUT', `/threads/SalesOrder/${order}/status`, { status: 'CLOSED', version: thread.version })
    expect(closed.status, JSON.stringify(closed.body)).toBe(200)
    const refused = await markDone(true)
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    expect(JSON.stringify(refused.body)).toContain(DONE_WORDS.CLOSED.en)
  })
})
