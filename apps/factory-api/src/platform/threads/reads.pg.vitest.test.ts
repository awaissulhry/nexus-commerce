import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../packages/factory-db/seed/roles'
import { seed as seedSalesIntake } from '../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor, command } from '../../core/command'
import { testAuthenticator, type RequestContext, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { startHarness, type Harness } from '../auth/sessions/testing/harness'
import { moveMark } from './reads'
import { ensureThread, writeMessage } from './threads'

/**
 * B-TH-027 — each person's own read mark (threads plan TH-2, G10; wall W08 / T08) through the app's real routes on a throwaway
 * PostgreSQL 17 database from the migrations (row-level security, the partner grant on ThreadRead and its guard are real), on the
 * seeds up to the sales intake (the brand P1 = SEED-C1, the customer P3 = SEED-C2). A request of P1 carries four messages: Ada's
 * internal note, our question to the customer (shared), the customer's answer (shared), Bruno's internal note. Every name and
 * word is made up.
 *
 *   - office: the thread answers each person's own reading (their own words never count); read up to the newest, unread from a
 *     message; one person's mark never moves another's; POST /threads/unread counts a page of records in one read;
 *   - T08: a portal person of P1 counts only the messages shared with P1 (an internal note never counts, nor is its id named);
 *     their mark is theirs alone; a portal person of P3 counts 0 on P1's request and reads nothing of it;
 *   - no route takes a person: a body naming one is refused; at most 200 records.
 * Run with `node scripts/factory/run-pg-tests.mjs platform/threads/reads`.
 */

vi.setConfig({ testTimeout: 120_000 })

type Json = Record<string, any>
type Method = 'GET' | 'POST'

const NS = 'th2-thread-reads'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const P1 = idOf('party:P1')
const P3 = idOf('party:P3')

const sales = templateOf('sales')!
const SALES = [...sales.permissions, ...sales.grains.map((grain) => `money.${grain}`)] as Permission[]
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const PEOPLE = { ada: newId(), bruno: newId(), anna: newId(), alba: newId(), berta: newId() } as const
const partner = (actorId: string, partyId: string): SessionContext => ({ audience: 'partner', tenantId: T, actorId, partyId, grants: [grant(['threads.read'] as Permission[], [partyId])] })
const SESSIONS: Record<string, SessionContext> = {
  ada: { audience: 'office', tenantId: T, actorId: PEOPLE.ada, grants: [grant(SALES)] },
  bruno: { audience: 'office', tenantId: T, actorId: PEOPLE.bruno, grants: [grant(SALES)] },
  // P1's portal people (Brand A) and P3's (Brand B).
  anna: partner(PEOPLE.anna, P1),
  alba: partner(PEOPLE.alba, P1),
  berta: partner(PEOPLE.berta, P3),
}

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const one = async (sql: string, values: unknown[] = []): Promise<Json> => (await admin(sql, values))[0]!
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `rd-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const contextOf = (session: string) => ({ ...(SESSIONS[session] as SessionContext), requestId: newId() }) as RequestContext & { actorId: string }

let inquiry = ''
const M = {} as Record<'adaNote' | 'question' | 'answer' | 'brunoNote', string>
const unread = async (session: string, records: Json[] = [{ recordType: 'Inquiry', recordId: inquiry }]) => (await ok(session, 'POST', '/threads/unread', { records })).counts as Json[]
const reading = async (session: string) => (await ok(session, 'GET', `/threads/Inquiry/${inquiry}`)).reading

/** One message written through the threads' own seam, as `session` (an office person) in a command of its own. */
async function message(session: string, direction: 'INTERNAL_NOTE' | 'OUTBOUND' | 'INBOUND', body: string): Promise<string> {
  const context = contextOf(session)
  const { result } = await command(callerFor(h.database, context), { name: 'threads.postNote', input: { body } }, async (tools) => {
    const { thread } = await ensureThread(tools, { type: 'Inquiry', id: inquiry }, context.actorId)
    const written = await writeMessage(tools, thread, {
      direction,
      channel: direction === 'INTERNAL_NOTE' ? 'APP' : 'PORTAL',
      author: direction === 'INBOUND' ? { kind: 'PARTY', id: null, name: 'Made-up Anna' } : { kind: 'USER', id: context.actorId, name: `Made-up ${session}` },
      bodyText: body,
    })
    return { id: written.id }
  })
  return result.id
}

beforeAll(async () => {
  h = await startHarness('th2_thread_reads')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  for (const [person, userId] of Object.entries(PEOPLE)) {
    const party = person === 'anna' || person === 'alba' ? P1 : person === 'berta' ? P3 : null
    if (party) await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, audience, "partyId", "partnerKind") VALUES ($1, $2, $3, $4, 'ACTIVE', 'PARTNER', $5, 'CUSTOMER')`, [userId, T, `th2-${person}-${run}@example.test`, `Made-up ${person}`, party])
    else await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, T, `th2-${person}-${run}@example.test`, `Made-up ${person}`])
  }
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  const companyA = idOf('company:A')
  inquiry = (await ok('ada', 'POST', '/sales/inquiries', { companyId: companyA, source: 'PHONE', partyId: P1, request: 'Made-up: twenty team jackets.', lines: [{ description: 'Made-up: team jacket', quantity: 20 }] }, 201)).inquiry.id
  M.adaNote = await message('ada', 'INTERNAL_NOTE', 'Made-up office note by Ada: check the price list first.')
  M.question = await message('ada', 'OUTBOUND', 'Made-up question: which sizes do you need?')
  M.answer = await message('ada', 'INBOUND', 'Made-up answer: 50 to 54, ten of each.')
  M.brunoNote = await message('bruno', 'INTERNAL_NOTE', 'Made-up office note by Bruno: sizes are fine.')
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-TH-027 each person’s own read mark (office)', () => {
  it('the thread answers each person’s own reading: their own words never count, the first new message is the line', async () => {
    expect(await reading('ada')).toEqual({ lastReadMessageId: null, newCount: 2, firstNewMessageId: M.answer })
    expect(await reading('bruno')).toEqual({ lastReadMessageId: null, newCount: 3, firstNewMessageId: M.adaNote })
    expect(await unread('ada')).toEqual([{ recordType: 'Inquiry', recordId: inquiry, newCount: 2, lastAt: expect.any(String) }])
  })

  it('reading up to the newest clears it for that person only; unread from a message brings it back; the mark only moves forward', async () => {
    expect((await ok('bruno', 'POST', `/threads/Inquiry/${inquiry}/read`, {})).reading).toEqual({ lastReadMessageId: M.brunoNote, newCount: 0, firstNewMessageId: null })
    expect((await unread('bruno'))[0]!.newCount).toBe(0)
    expect((await unread('ada'))[0]!.newCount).toBe(2)
    // Read up to an older message: the mark stays where it is.
    expect((await ok('bruno', 'POST', `/threads/Inquiry/${inquiry}/read`, { messageId: M.question })).reading.lastReadMessageId).toBe(M.brunoNote)
    // Unread from the answer: the answer is new again (his own note after it never counts).
    expect((await ok('bruno', 'POST', `/threads/Inquiry/${inquiry}/unread`, { messageId: M.answer })).reading).toEqual({ lastReadMessageId: M.question, newCount: 1, firstNewMessageId: M.answer })
    // From the first message on: no mark at all, everything new again (but Bruno's own note).
    expect((await ok('bruno', 'POST', `/threads/Inquiry/${inquiry}/unread`, { messageId: M.adaNote })).reading).toEqual({ lastReadMessageId: null, newCount: 3, firstNewMessageId: M.adaNote })
    expect(await admin('SELECT "userId" FROM "ThreadRead" WHERE "tenantId" = $1', [T])).toEqual([])
  })

  it('no route takes a person: a body naming one is refused; a page holds at most 200 records; another record counts 0', async () => {
    expect((await call('ada', 'POST', `/threads/Inquiry/${inquiry}/read`, { userId: PEOPLE.bruno })).statusCode).toBe(400)
    expect((await call('ada', 'POST', '/threads/unread', { records: [{ recordType: 'Inquiry', recordId: inquiry }], userId: PEOPLE.bruno })).statusCode).toBe(400)
    expect((await call('ada', 'POST', '/threads/unread', { records: Array.from({ length: 201 }, () => ({ recordType: 'Inquiry', recordId: newId() })) })).statusCode).toBe(400)
    const other = newId()
    expect(await unread('ada', [{ recordType: 'Inquiry', recordId: other }, { recordType: 'Inquiry', recordId: inquiry }])).toEqual([
      { recordType: 'Inquiry', recordId: other, newCount: 0, lastAt: null },
      { recordType: 'Inquiry', recordId: inquiry, newCount: 2, lastAt: expect.any(String) },
    ])
  })
})

describe('T08 portal people: shared messages only, their own mark only, another brand nothing', () => {
  it('a portal person of P1 counts only the messages shared with P1 — an internal note never counts nor is named', async () => {
    expect((await unread('anna'))[0]!.newCount).toBe(2)
    const read = await ok('anna', 'GET', `/threads/Inquiry/${inquiry}`)
    expect(read.reading).toEqual({ lastReadMessageId: null, newCount: 2, firstNewMessageId: M.question })
    const text = JSON.stringify(read)
    for (const note of [M.adaNote, M.brunoNote]) expect(text).not.toContain(note)
    expect(text).not.toContain('office note')
    expect(read.head).toBeUndefined()
  })

  it('their mark is theirs: Anna reads up to the answer (the portal’s own write, in the partner scope); Alba still counts 2', async () => {
    const context = contextOf('anna')
    const thread = (await one('SELECT id, "companyId", "siteId", "partyId" FROM "Thread" WHERE "recordType" = $1 AND "recordId" = $2', ['Inquiry', inquiry])) as { id: string; companyId: string | null; siteId: string | null; partyId: string | null }
    const answer = (await one('SELECT id, at FROM "Message" WHERE id = $1', [M.answer])) as { id: string; at: Date }
    await command(callerFor(h.database, context), { name: 'threads.markRead', input: { messageId: M.answer } }, async (tools) => ({ moved: await moveMark(tools, thread, { userId: PEOPLE.anna, office: false }, answer, true) }))
    expect((await unread('anna'))[0]!.newCount).toBe(0)
    expect((await unread('alba'))[0]!.newCount).toBe(2)
    expect(await one('SELECT "partyId", "lastReadMessageId" FROM "ThreadRead" WHERE "userId" = $1', [PEOPLE.anna])).toEqual({ partyId: P1, lastReadMessageId: M.answer })
    // The database refuses a portal person's mark on an internal note (never counted as read or unread for a customer).
    const note = (await one('SELECT id, at FROM "Message" WHERE id = $1', [M.brunoNote])) as { id: string; at: Date }
    await expect(command(callerFor(h.database, contextOf('alba')), { name: 'threads.markRead', input: { messageId: M.brunoNote } }, async (tools) => ({ moved: await moveMark(tools, thread, { userId: PEOPLE.alba, office: false }, note, true) }))).rejects.toThrow()
    // Office counts never move with a portal person's mark.
    expect((await unread('ada'))[0]!.newCount).toBe(2)
  })

  it('a portal person of P3 (Brand B) counts 0 on P1’s request and reads nothing of its thread', async () => {
    expect(await unread('berta')).toEqual([{ recordType: 'Inquiry', recordId: inquiry, newCount: 0, lastAt: null }])
    const read = await ok('berta', 'GET', `/threads/Inquiry/${inquiry}`)
    expect(read).toEqual({ thread: null, messages: [], nextCursor: null })
    expect([403, 404]).toContain((await call('berta', 'POST', `/threads/Inquiry/${inquiry}/read`, {})).statusCode)
  })
})
