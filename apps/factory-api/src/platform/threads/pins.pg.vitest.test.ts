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
import { inTenant, partnerWorld, signIn, type PartnerWorld, type Person } from '../search/partner/testing/world'
import { PIN_WORDS } from './pins'
import { ensureThread, writeMessage } from './threads'

/**
 * B-TH-091 (threads plan TH-9, N4, L2-G11; T2-F07, T3-F12, PROJ.thread-F06, O-SAL-INQ-LIST.pane-facts-F06; wall test T08 / W08; the
 * Owner's rule 2026-11-16: "One brand must not be able to see anything related to any other brand"): pins.
 *
 *   the office            pins our mail and an office note on brand A's order; reads both with who pinned them; unpins one; a mail in
 *                         its undo window is refused in words; a reader without the right to write cannot pin (403)
 *   brand A's portal      reads only the pin of the message shared with it — never the office note's pin, never who pinned it
 *   brand B's portal      reads no pin of brand A's conversation (T08)
 *   a request's note      moved into its conversation as a pinned office note, the request's field emptied; a second time: nothing to move
 *
 * Base seeds in one namespace (two brands included), real portal sign-ins, office sessions by the test authenticator. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/threads`.
 */

let h: Harness
let world: PartnerWorld
let app: FastifyInstance
let alpha: Browser
let beta: Browser
let run = 0
const NS = 'th091pin'
const office = { writer: newId(), reader: newId() }
const ids = { order: '', note: '', mail: '', held: '', request: '' }

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const sessions = (): Record<string, SessionContext> => ({
  writer: { audience: 'office', tenantId: world.tenantId, actorId: office.writer, grants: [{ permissions: ['threads.read', 'threads.post', 'sales.inquiries.manage', 'sales.inquiries.view'], companies: 'all', sites: 'all', parties: 'all' }] },
  reader: { audience: 'office', tenantId: world.tenantId, actorId: office.reader, grants: [{ permissions: ['threads.read'], companies: 'all', sites: 'all', parties: 'all' }] },
})
const call = async (who: keyof typeof office, method: 'GET' | 'PUT' | 'DELETE' | 'POST', url: string) => {
  const response = await app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `th091-key-${++run}` }) } })
  return { status: response.statusCode, body: response.json() as Json }
}
const pinned = (answer: { body: Json }): string[] => answer.body.pins.map((pin: Json) => pin.messageId)

beforeAll(async () => {
  h = await startHarness('pins_th091')
  h.clock.set(new Date())
  freshGuard(h)
  world = await partnerWorld(h, NS)
  const brandB = (await admin<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C2B'`, [world.tenantId]))[0]!.id
  const buyerB = (await admin<{ id: string; email: string; displayName: string }>(`SELECT id, email, "displayName" FROM "User" WHERE "tenantId" = $1 AND "partyId" = $2 AND email LIKE 'buyer.second-brand.%' LIMIT 1`, [world.tenantId, brandB]))[0]!
  await inTenant(h, world, (client) => client.portalSettings.updateMany({ where: { partyId: brandB }, data: { portalOn: true } }))
  for (const [key, id] of Object.entries(office)) await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, \'ACTIVE\', \'en\')', [id, world.tenantId, `th091-${key}@example.com`, `Made-up ${key}`])
  ids.order = (await admin<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001' AND "partyId" = $2`, [world.tenantId, world.p1]))[0]!.id
  const seam = callerFor(h.database, { audience: 'office', tenantId: world.tenantId, actorId: world.officeId, grants: [], requestId: newId() })
  const { result } = await command(seam, { name: 'email.send', input: { order: ids.order } }, async (tools) => {
    const { thread } = await ensureThread(tools, { type: 'SalesOrder', id: ids.order }, world.officeId)
    const by = { kind: 'USER' as const, id: world.officeId, name: 'Seed Owner' }
    const note = await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: by, bodyText: 'Internal decision: we keep the 2026 lining, not the cheap one.' })
    const mail = await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'EMAIL', author: by, bodyText: 'Made-up: agreed delivery in week 12.' })
    const held = await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'EMAIL', author: by, bodyText: 'Made-up: a mail still in its undo window.' })
    return { note: note.id, mail: mail.id, held: held.id }
  })
  Object.assign(ids, result)
  // A mail in its undo window (the database's held flag; test data past the guards on the one admin connection).
  await admin('SET session_replication_role = replica')
  try {
    await admin('UPDATE "Message" SET held = true WHERE id = $1', [ids.held])
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
  // A request of brand A with its own office note. fix-pg-1: the seeds give brand A one request, SEED-INQ-0004, already quoted (seed/
  // sales-intake.ts); moving its note does not ask the request's state.
  ids.request = (await admin<{ id: string }>(`SELECT id FROM "Inquiry" WHERE "tenantId" = $1 AND "partyId" = $2 ORDER BY number LIMIT 1`, [world.tenantId, world.p1]))[0]!.id
  await admin(`UPDATE "Inquiry" SET note = 'Made-up: the buyer prefers calls after 15:00.' WHERE id = $1`, [ids.request])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => sessions()[String(request.headers['x-test-session'])] ?? null) },
  )
  alpha = await signIn(h, world, world.people.buyer)
  beta = await signIn(h, world, { id: buyerB.id, email: buyerB.email, name: buyerB.displayName } satisfies Person)
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

describe('B-TH-091: the office pins and unpins', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('pins our mail and an office note; reads both, oldest pin first, with who pinned them; a second pin changes nothing', async () => {
    expect((await call('writer', 'PUT', `/threads/SalesOrder/${ids.order}/pins/${ids.mail}`)).status).toBe(200)
    const both = await call('writer', 'PUT', `/threads/SalesOrder/${ids.order}/pins/${ids.note}`)
    expect(both.status, JSON.stringify(both.body)).toBe(200)
    expect(pinned(both)).toEqual([ids.mail, ids.note])
    expect(both.body.pins[0]).toMatchObject({ pinnedBy: { id: office.writer, name: 'Made-up writer' }, message: { audience: 'PARTNER', excerpt: 'Made-up: agreed delivery in week 12.', removed: false } })
    expect(pinned(await call('writer', 'PUT', `/threads/SalesOrder/${ids.order}/pins/${ids.mail}`))).toEqual([ids.mail, ids.note])
    expect((await admin('SELECT 1 FROM "ThreadPin" WHERE "tenantId" = $1 AND "messageId" = $2', [world.tenantId, ids.mail])).length).toBe(1)
  })

  it('a mail in its undo window is refused in words; a reader without the right to write cannot pin; another thread’s message is not found', async () => {
    const held = await call('writer', 'PUT', `/threads/SalesOrder/${ids.order}/pins/${ids.held}`)
    expect(held.status, JSON.stringify(held.body)).toBe(409)
    expect(JSON.stringify(held.body)).toContain(PIN_WORDS.HELD.en)
    expect((await call('reader', 'PUT', `/threads/SalesOrder/${ids.order}/pins/${ids.mail}`)).status).toBe(403)
    expect((await call('writer', 'PUT', `/threads/SalesOrder/${ids.order}/pins/${newId()}`)).status).toBe(404)
  })
})

describe('T08: a brand sees only pins of messages shared with it', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('brand A reads the pin of our mail only — never the office note’s pin, never who pinned it', async () => {
    const answer = await alpha.get(`/threads/SalesOrder/${ids.order}/pins`)
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(pinned(answer)).toEqual([ids.mail])
    expect(answer.body.pins[0].pinnedBy).toBeUndefined()
    expect(answer.body.pins[0].message.audience).toBeUndefined()
    expect(JSON.stringify(answer.body)).not.toMatch(/Internal decision|Made-up writer/)
  })

  it('brand B reads no pin of brand A’s conversation', async () => {
    const answer = await beta.get(`/threads/SalesOrder/${ids.order}/pins`)
    expect([200, 404], JSON.stringify(answer.body)).toContain(answer.status)
    if (answer.status === 200) expect(answer.body.pins).toEqual([])
    expect(JSON.stringify(answer.body)).not.toMatch(/agreed delivery|Internal decision/)
  })

  it('unpinned, the count drops for everyone', async () => {
    const after = await call('writer', 'DELETE', `/threads/SalesOrder/${ids.order}/pins/${ids.mail}`)
    expect(after.status, JSON.stringify(after.body)).toBe(200)
    expect(pinned(after)).toEqual([ids.note])
    expect(pinned(await alpha.get(`/threads/SalesOrder/${ids.order}/pins`))).toEqual([])
    // fix-pg-1: unpinning a message that is not pinned changes nothing (it was a 500: the command wrote no audit row).
    const again = await call('writer', 'DELETE', `/threads/SalesOrder/${ids.order}/pins/${ids.mail}`)
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(pinned(again)).toEqual([ids.note])
  })
})

describe('L2-G11: a request’s note becomes its first pinned note', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('moves the note into the conversation as a pinned office note and empties the field; a second time there is nothing to move', async () => {
    const moved = await call('writer', 'POST', `/threads/Inquiry/${ids.request}/pins/note`)
    expect(moved.status, JSON.stringify(moved.body)).toBe(201)
    expect(pinned(moved)).toEqual([moved.body.messageId])
    expect(moved.body.pins[0].message).toMatchObject({ audience: 'OFFICE', excerpt: 'Made-up: the buyer prefers calls after 15:00.' })
    const [row] = await admin<{ note: string | null }>('SELECT note FROM "Inquiry" WHERE id = $1', [ids.request])
    expect(row?.note).toBeNull()
    const again = await call('writer', 'POST', `/threads/Inquiry/${ids.request}/pins/note`)
    expect(again.status, JSON.stringify(again.body)).toBe(409)
    expect(JSON.stringify(again.body)).toContain(PIN_WORDS.NO_NOTE.en)
    // The customer's portal never reads the office note nor its pin.
    expect(JSON.stringify((await alpha.get(`/threads/Inquiry/${ids.request}/pins`)).body)).not.toContain('calls after 15:00')
  })
})
