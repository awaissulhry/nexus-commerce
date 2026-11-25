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
import { callerFor, command, COMMAND_SETTINGS, runCommand, type CommandSettings } from '../../core/command'
import { testAuthenticator, type RequestContext, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { startHarness, type Harness } from '../auth/sessions/testing/harness'
import { moveMark } from './reads'
import { ensureThread, writeMessage } from './threads'
// pg-s1 S1.4: the one helper of every portal write path, in the two scopes they write in.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readOwnMessage } from './reads'
import { systemContext } from '../outbox/system'
import { fixedClock } from '@nexus/factory-domain/core/time' // pg-fx2: a command's clock ahead of the database's

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
  // B-OP-061: an office person limited to P1 (Brand A).
  adaP1: { audience: 'office', tenantId: T, actorId: PEOPLE.ada, grants: [grant(SALES, [P1])] },
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

// ── pg-s1 S1.4 (the pt- lane's L-1): a portal person's own message is never new to them, on every portal write path ──────────
// The portal's write paths write a person's words in one of two scopes, then move the writer's own mark through ONE helper
// (readOwnMessage): the partner scope (the portal post — the thread page, a request's first words and its files, a production
// problem — and a change asked on the order page) and the tenant's system scope (an approval answered in the portal). Both are
// written here as those paths write them; the order page's ask and the portal approval are also checked through their own routes
// (sales/change-requests B-SA-048, approvals-out pg-s1 S1.4).
describe('pg-s1 S1.4: a portal person’s own message never counts as new to them; another brand’s never moves their count', () => {
  type ThreadOf = { id: string; companyId: string | null; siteId: string | null; partyId: string | null }
  const threadOf = async (recordId: string) => (await one('SELECT id, "companyId", "siteId", "partyId" FROM "Thread" WHERE "recordType" = $1 AND "recordId" = $2', ['Inquiry', recordId])) as ThreadOf
  const countOn = async (session: string, recordId: string) => (await unread(session, [{ recordType: 'Inquiry', recordId }]))[0]!.newCount as number
  const markOf = async (userId: string, threadId: string) => (await admin('SELECT "lastReadMessageId"::text AS id FROM "ThreadRead" WHERE "userId" = $1 AND "threadId" = $2', [userId, threadId]))[0]?.id ?? null

  /** The person's words as the partner scope writes them (the portal post, the order page's ask): INBOUND PORTAL by their name. */
  async function partnerPost(session: 'anna' | 'alba' | 'berta', recordId: string, body: string, settings: CommandSettings = COMMAND_SETTINGS): Promise<{ id: string; moved: boolean }> {
    const context = contextOf(session)
    const thread = await threadOf(recordId)
    const { result } = await runCommand(callerFor(h.database, context), { name: 'portal.postMessage', input: { recordId, body } }, async (tools) => {
      const id = newId()
      const row = await tools.tx.message.create({
        data: { id, threadId: thread.id, partyId: thread.partyId, direction: 'INBOUND', audience: 'PARTNER', channel: 'PORTAL', authorKind: 'PARTY', authorName: `Made-up ${session}`, bodyText: body, bodyHtml: null, attachmentFileIds: [], emailMessageId: null, at: tools.now, createdAt: tools.now },
        select: { id: true, at: true },
      })
      tools.audit({ recordType: 'Message', recordId: id, companyId: thread.companyId, siteId: thread.siteId, after: { threadId: thread.id, direction: 'INBOUND', audience: 'PARTNER', channel: 'PORTAL' } })
      return { id: row.id, moved: await readOwnMessage(tools, thread, { userId: context.actorId }, row) }
    }, settings)
    return result
  }

  /** An answer as the tenant's system writes it after a portal answer (approvals-out settle): INBOUND PORTAL by the typed name. */
  async function systemPost(recordId: string, body: string, writers: readonly { readonly userId: string | null; readonly preview?: boolean }[]): Promise<{ id: string; moved: boolean[] }> {
    const { result } = await command(callerFor(h.database, systemContext(T, newId())), { name: 'approvalsOut.settle', input: { recordId, body } }, async (tools) => {
      const { thread } = await ensureThread(tools, { type: 'Inquiry', id: recordId }, null)
      const written = await writeMessage(tools, thread, { direction: 'INBOUND', channel: 'PORTAL', author: { kind: 'PARTY', id: null, name: 'Made-up typed name' }, bodyText: body })
      const moved: boolean[] = []
      for (const writer of writers) moved.push(await readOwnMessage(tools, thread, writer, written))
      return { id: written.id, moved }
    })
    return result
  }

  it('the partner scope (the portal post, a change asked on the order page): Anna’s own words leave her count at 0; Alba counts them; Berta (Brand B) nothing', async () => {
    const thread = await threadOf(inquiry)
    const before = { anna: await countOn('anna', inquiry), alba: await countOn('alba', inquiry), ada: await countOn('ada', inquiry) }
    expect(before.anna).toBe(0) // T08 above: Anna read up to the answer
    const posted = await partnerPost('anna', inquiry, 'Made-up words of Anna: can the sleeves be longer?')
    expect(posted.moved).toBe(true)
    expect(await countOn('anna', inquiry)).toBe(0)
    expect(await markOf(PEOPLE.anna, thread.id)).toBe(posted.id)
    // Her colleague and the office read it as new; another brand's person counts nothing of it.
    expect(await countOn('alba', inquiry)).toBe(before.alba + 1)
    expect(await countOn('ada', inquiry)).toBe(before.ada + 1)
    expect(await countOn('berta', inquiry)).toBe(0)
  })

  it('the tenant’s system scope (an approval answered in the portal): Alba’s own answer leaves her count at 0; Anna counts it', async () => {
    const thread = await threadOf(inquiry)
    const anna = await countOn('anna', inquiry)
    const answered = await systemPost(inquiry, 'Made-up answer of Alba: approved.', [{ userId: PEOPLE.alba }])
    expect(answered.moved).toEqual([true])
    expect(await countOn('alba', inquiry)).toBe(0)
    expect(await markOf(PEOPLE.alba, thread.id)).toBe(answered.id)
    expect(await countOn('anna', inquiry)).toBe(anna + 1)
    expect(await countOn('berta', inquiry)).toBe(0)
  })

  it('no mark for a link (no person) or a preview: everybody still counts the message as new', async () => {
    const thread = await threadOf(inquiry)
    const before = { anna: await countOn('anna', inquiry), alba: await countOn('alba', inquiry), annaMark: await markOf(PEOPLE.anna, thread.id) }
    const linked = await systemPost(inquiry, 'Made-up words of an invited link.', [{ userId: null }, { userId: PEOPLE.anna, preview: true }])
    expect(linked.moved).toEqual([false, false])
    expect(await countOn('anna', inquiry)).toBe(before.anna + 1)
    expect(await countOn('alba', inquiry)).toBe(before.alba + 1)
    expect(await markOf(PEOPLE.anna, thread.id)).toBe(before.annaMark)
  })

  it('Brand B’s own words on its own request never move Brand A’s counts, and Brand B can never mark Brand A’s thread', async () => {
    const theirs = (await ok('ada', 'POST', '/sales/inquiries', { companyId: idOf('company:A'), source: 'PHONE', partyId: P3, request: 'Made-up: ten rain jackets.', lines: [{ description: 'Made-up: rain jacket', quantity: 10 }] }, 201)).inquiry.id as string
    await command(callerFor(h.database, contextOf('ada')), { name: 'threads.postNote', input: { body: 'Made-up question to Brand B' } }, async (tools) => {
      const { thread } = await ensureThread(tools, { type: 'Inquiry', id: theirs }, PEOPLE.ada)
      return { id: (await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'PORTAL', author: { kind: 'USER', id: PEOPLE.ada, name: 'Made-up ada' }, bodyText: 'Made-up question to Brand B: which colour?' })).id }
    })
    const brandA = { anna: await countOn('anna', inquiry), alba: await countOn('alba', inquiry) }
    expect(await countOn('berta', theirs)).toBe(1)
    const posted = await partnerPost('berta', theirs, 'Made-up words of Berta: navy, please.')
    expect(posted.moved).toBe(true)
    expect(await countOn('berta', theirs)).toBe(0)
    // Brand A's people: their own request's counts do not move, and Brand B's request is not theirs to count.
    expect({ anna: await countOn('anna', inquiry), alba: await countOn('alba', inquiry) }).toEqual(brandA)
    expect(await countOn('anna', theirs)).toBe(0)
    expect(await countOn('alba', theirs)).toBe(0)
    // Berta's scope cannot write a mark on Brand A's thread (row-level security: her party only).
    const aThread = await threadOf(inquiry)
    const aMessage = (await one('SELECT id, at FROM "Message" WHERE id = $1', [M.answer])) as { id: string; at: Date }
    await expect(command(callerFor(h.database, contextOf('berta')), { name: 'threads.markRead', input: { messageId: M.answer } }, async (tools) => ({ moved: await readOwnMessage(tools, aThread, { userId: PEOPLE.berta }, aMessage) }))).rejects.toThrow()
    expect(await markOf(PEOPLE.berta, aThread.id)).toBeNull()
  })

  // pg-fx2 (end check: the order page's asks of brand-requests.pg answered 409 'This cannot be saved as it is.' once the test
  // world's clock ran more than 5 minutes ahead of the database's — ThreadRead_guard 'read at a time not in the future').
  it('a command’s clock more than 5 minutes ahead of the database’s: the writer’s words are still saved and read, at the database’s time', async () => {
    const own = (await ok('ada', 'POST', '/sales/inquiries', { companyId: idOf('company:A'), source: 'PHONE', partyId: P1, request: 'Made-up: five rain capes.', lines: [{ description: 'Made-up: rain cape', quantity: 5 }] }, 201)).inquiry.id as string
    await command(callerFor(h.database, contextOf('ada')), { name: 'threads.postNote', input: { body: 'Made-up question to Brand A' } }, async (tools) => {
      const { thread } = await ensureThread(tools, { type: 'Inquiry', id: own }, PEOPLE.ada)
      return { id: (await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'PORTAL', author: { kind: 'USER', id: PEOPLE.ada, name: 'Made-up ada' }, bodyText: 'Made-up question to Brand A: which length?' })).id }
    })
    expect(await countOn('anna', own)).toBe(1)
    const ahead = { ...COMMAND_SETTINGS, clock: fixedClock(new Date(Date.now() + 10 * 60_000)) }
    const posted = await partnerPost('anna', own, 'Made-up words of Anna: knee length, please.', ahead)
    expect(posted.moved).toBe(true)
    expect(await countOn('anna', own)).toBe(0)
    expect(await countOn('alba', own)).toBe(2)
    const thread = await threadOf(own)
    expect(await one('SELECT "lastReadMessageId"::text AS id, "readAt" <= now() AS "notAhead" FROM "ThreadRead" WHERE "userId" = $1 AND "threadId" = $2', [PEOPLE.anna, thread.id])).toEqual({ id: posted.id, notAhead: true })
  })

  it('every portal write path moves the writer’s mark through the one helper (no copy of it)', () => {
    const src = fileURLToPath(new URL('../..', import.meta.url))
    const source = (path: string) => readFileSync(join(src, path), 'utf8')
    for (const path of ['platform/threads/partner/service.ts', 'modules/sales/change-requests/portal.ts', 'platform/approvals-out/settle.ts']) expect(source(path), path).toMatch(/await readOwnMessage\(tools, /)
    expect(source('platform/threads/partner/service.ts')).not.toMatch(/moveMark\(/)
  })
})
// ── end pg-s1 S1.4 ──

// ── B-OP-061 (order page dock A2): asked with `readable`, each row says whether the reader may read the record's thread ──
describe('B-OP-061: POST /threads/unread {readable: true} — readable per record, false alike for an unknown record and another customer\'s', () => {
  const ids = { fresh: '', otherWithThread: '', otherNoThread: '' }
  const companyA = idOf('company:A')
  const newInquiry = async (partyId: string) => (await ok('ada', 'POST', '/sales/inquiries', { companyId: companyA, source: 'PHONE', partyId, request: 'Made-up: a few jackets.', lines: [{ description: 'Made-up: jacket', quantity: 2 }] }, 201)).inquiry.id as string
  const asked = (records: string[]) => records.map((recordId) => ({ recordType: 'Inquiry', recordId }))
  const readableOf = async (session: string, records: Json[]) => (await ok(session, 'POST', '/threads/unread', { records, readable: true })).counts as Json[]

  beforeAll(async () => {
    ids.fresh = await newInquiry(P1)
    ids.otherWithThread = await newInquiry(P3)
    await ok('ada', 'POST', `/threads/Inquiry/${ids.otherWithThread}/notes`, { body: "Made-up office note on the other customer's request." }, 201)
    ids.otherNoThread = await newInquiry(P3)
  })

  it('a person limited to P1: its request with a thread and one with no thread yet are readable; P3\'s (with or without a thread) and an unknown one are not — alike', async () => {
    const unknown = newId()
    const rows = await readableOf('adaP1', [...asked([inquiry, ids.fresh, ids.otherWithThread, ids.otherNoThread, unknown]), { recordType: 'NoSuchRecord', recordId: newId() }])
    expect(rows.map((row) => [row.recordId, row.readable])).toEqual([
      [inquiry, true],
      [ids.fresh, true],
      [ids.otherWithThread, false],
      [ids.otherNoThread, false],
      [unknown, false],
      [rows[5]!.recordId, false],
    ])
    // No difference to read between another customer's record and one that does not exist.
    const without = (row: Json) => ({ ...row, recordId: 'x' })
    expect(without(rows[2]!)).toEqual(without(rows[4]!))
    expect(without(rows[3]!)).toEqual(without(rows[4]!))
    expect(rows[2]).toEqual({ recordType: 'Inquiry', recordId: ids.otherWithThread, newCount: 0, lastAt: null, readable: false })
  })

  it('a person of every customer reads them all; not asked, no row carries it (a list pays no extra read)', async () => {
    expect((await readableOf('ada', asked([ids.otherWithThread, ids.otherNoThread]))).map((row) => row.readable)).toEqual([true, true])
    expect(await unread('ada', asked([ids.fresh]))).toEqual([{ recordType: 'Inquiry', recordId: ids.fresh, newCount: 0, lastAt: null }])
  })

  it('a portal person: its own party\'s thread that exists is readable; one not started yet, and another customer\'s, are not', async () => {
    expect((await readableOf('anna', asked([inquiry, ids.fresh, ids.otherWithThread]))).map((row) => row.readable)).toEqual([true, false, false])
    expect((await readableOf('berta', asked([inquiry]))).map((row) => [row.newCount, row.readable])).toEqual([[0, false]])
  })
})
// ── end B-OP-061 ──
