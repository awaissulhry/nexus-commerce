import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import type { MessageChannel, MessageDirection } from '@nexus/factory-domain/threads/rules'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor, command } from '../../core/command'
import { testAuthenticator, type RequestContext, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { SLOW_TEST_TIMEOUT_MS } from '../../testing/timeouts'
import { startHarness, type Harness } from '../auth/sessions/testing/harness'
import { ensureThread, messageLinkProblems, messageLinksOf, writeMessage, type MessageLinkInput } from './threads'

/**
 * B-TH-050 (threads plan TH-3, thread-G19, thread-G20; features T3-F07 Reply, T3-F09 Make a task, T3-F11 Correct; wall W08: "the
 * correction of a shared message stays shared with the same party only") through the app's real routes on a throwaway PostgreSQL 17
 * database from the migrations, every factory-db seed (customer A = SEED-C1 with its orders, customer B = SEED-C2, the work order
 * SEED-WO-0001).
 *
 *   - "Correct" posts a new note linked to the one it corrects (never an edit): the new one names what it corrects, the old one
 *     its newest correction ("Corrected below");
 *   - "Reply" on a customer's message names the message it answers ("In reply to …");
 *   - refused in words: both at once, a message of another conversation, an office note "correcting" a customer's message, the
 *     correction of a floor note that would not reach the floor; a shared message pointing at an office note, a mail corrected in
 *     the portal;
 *   - W08: a correction of a mail sent to customer A is shared with A only — A's own scope reads both and the link, B reads none;
 *   - "Make a task" on a message: the task names the message, a message of its own record's conversation only.
 * Every name and word is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/threads/message-links`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'message-links-th050'
const T = seedUuid(NS, 'tenant')
const partyA = seedUuid(NS, 'party:P1')
const partyB = seedUuid(NS, 'party:P3')
const WRITER = newId()
const grant = (permissions: string[], parties: Grant['parties'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties })
const SESSIONS: Record<string, SessionContext> = {
  writer: { audience: 'office', tenantId: T, actorId: WRITER, grants: [grant(['threads.read', 'threads.post', 'files.read', 'tasks.manage', 'home.view'])] },
}

let h: Harness
let app: FastifyInstance
let run = 0
let orders: string[] = []
let workOrder = ''
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `th050-${++run}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call('writer', method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function refused(url: string, payload: unknown): Promise<Json[]> {
  const response = await call('writer', 'POST', url, payload)
  expect(response.statusCode, response.body).toBe(400)
  return ((response.json() as Json).error?.issues ?? []) as Json[]
}
const note = (recordType: string, recordId: string, body: Json) => ok('POST', `/threads/${recordType}/${recordId}/notes`, body, 201)
const messagesOf = async (recordType: string, recordId: string): Promise<Json[]> => (await ok('GET', `/threads/${recordType}/${recordId}`)).messages
const office = (): RequestContext => ({ ...SESSIONS.writer, requestId: newId() }) as RequestContext

/** One message written through the threads' seam, as the writer (a customer's message by its name). */
async function seam(record: { type: string; id: string }, direction: MessageDirection, channel: MessageChannel, body: string, links: MessageLinkInput = {}): Promise<string> {
  const { result } = await command(callerFor(h.database, office()), { name: 'threads.test.seam', input: { record, direction, body, links } }, async (tools) => {
    const { thread } = await ensureThread(tools, record, WRITER)
    const written = await writeMessage(tools, thread, {
      direction,
      channel,
      author: direction === 'INBOUND' ? { kind: 'PARTY', id: null, name: 'Made-up buyer' } : { kind: 'USER', id: WRITER, name: 'Made-up writer' },
      bodyText: body,
      ...(links.replyToMessageId ? { replyToMessageId: links.replyToMessageId } : {}),
      ...(links.correctsMessageId ? { correctsMessageId: links.correctsMessageId } : {}),
    })
    return { id: written.id }
  })
  return result.id
}

/** What messageLinkProblems says of a new message on the record's thread. */
async function problems(record: { type: string; id: string }, links: MessageLinkInput, facts: { direction: MessageDirection; channel: MessageChannel; forFloor?: boolean }): Promise<string[]> {
  const { result } = await command(callerFor(h.database, office()), { name: 'threads.test.links', input: { record, links, facts } }, async (tools) => {
    const { thread } = await ensureThread(tools, record, WRITER)
    return { issues: await messageLinkProblems(tools.tx, thread, links, facts) }
  })
  return result.issues.map((issue) => `${issue.path}: ${issue.message}`)
}

beforeAll(async () => {
  h = await startHarness('message_links_th050')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, \'ACTIVE\', \'en\')', [WRITER, T, 'th050-writer@example.com', 'Made-up writer'])
  orders = (await admin<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 ORDER BY number LIMIT 3', [T, partyA])).map((row) => row.id)
  expect(orders.length).toBe(3)
  workOrder = (await admin<{ id: string }>("SELECT id FROM \"WorkOrder\" WHERE \"tenantId\" = $1 AND number = 'SEED-WO-0001'", [T]))[0]!.id
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-TH-050 messages that point at messages', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('Correct: a new note linked to the one it corrects; the old one names its newest correction (“Corrected below”)', async () => {
    const first = await note('SalesOrder', orders[0]!, { body: 'Made-up: the fabric arrives on Monday.' })
    const correction = await note('SalesOrder', orders[0]!, { body: 'Made-up: correction — the fabric arrives on Tuesday.', correctsMessageId: first.message.id })
    expect(correction.message.corrects).toMatchObject({ id: first.message.id, authorName: 'Made-up writer', excerpt: 'Made-up: the fabric arrives on Monday.' })
    expect(correction.message.replyTo).toBeNull()
    expect((await admin<Json>('SELECT "correctsMessageId", "replyToMessageId" FROM "Message" WHERE id = $1', [correction.message.id]))[0]).toEqual({ correctsMessageId: first.message.id, replyToMessageId: null })
    // The old note is never edited: same words, and it names its correction.
    const thread = await messagesOf('SalesOrder', orders[0]!)
    const old = thread.find((message) => message.id === first.message.id)!
    expect(old.body).toBe('Made-up: the fabric arrives on Monday.')
    expect(old.correctedBy).toMatchObject({ id: correction.message.id })
    expect(thread.find((message) => message.id === correction.message.id)?.corrects?.id).toBe(first.message.id)
  })

  it('Reply: a note on a customer’s message names the message it answers', async () => {
    const asked = await seam({ type: 'SalesOrder', id: orders[1]! }, 'INBOUND', 'PORTAL', 'Made-up: can the jackets ship by the 20th?')
    const answered = await note('SalesOrder', orders[1]!, { body: 'Made-up: checking with production, back tomorrow.', replyToMessageId: asked })
    expect(answered.message.replyTo).toMatchObject({ id: asked, authorName: 'Made-up buyer', excerpt: 'Made-up: can the jackets ship by the 20th?' })
    expect(answered.message.corrects).toBeNull()
  })

  it('refused in words: both at once, another conversation’s message, an office note correcting a customer’s message, a floor note’s correction off the floor', async () => {
    const mine = await note('SalesOrder', orders[0]!, { body: 'Made-up: one more note.' })
    const elsewhere = await note('SalesOrder', orders[2]!, { body: 'Made-up: a note on another order.' })
    const asked = await seam({ type: 'SalesOrder', id: orders[0]! }, 'INBOUND', 'EMAIL', 'Made-up: please confirm the sizes.')
    expect(await refused(`/threads/SalesOrder/${orders[0]}/notes`, { body: 'Made-up.', replyToMessageId: mine.message.id, correctsMessageId: mine.message.id })).toEqual([expect.objectContaining({ path: 'body/correctsMessageId', message: expect.stringContaining('not both') })])
    expect(await refused(`/threads/SalesOrder/${orders[0]}/notes`, { body: 'Made-up.', correctsMessageId: elsewhere.message.id })).toEqual([expect.objectContaining({ path: 'body/correctsMessageId', message: 'Not a message of this conversation.' })])
    expect(await refused(`/threads/SalesOrder/${orders[0]}/notes`, { body: 'Made-up.', replyToMessageId: newId() })).toEqual([expect.objectContaining({ path: 'body/replyToMessageId', message: 'Not a message of this conversation.' })])
    expect(await refused(`/threads/SalesOrder/${orders[0]}/notes`, { body: 'Made-up.', correctsMessageId: asked })).toEqual([expect.objectContaining({ path: 'body/correctsMessageId', message: expect.stringContaining('answer it instead') })])
    // A note on the floor's tablets is corrected on the tablets too.
    const floor = await note('WorkOrder', workOrder, { body: 'Made-up: cut size 48 first.', forFloor: true })
    expect(await refused(`/threads/WorkOrder/${workOrder}/notes`, { body: 'Made-up: cut size 50 first.', correctsMessageId: floor.message.id })).toEqual([expect.objectContaining({ path: 'body/forFloor' })])
    const fixed = await note('WorkOrder', workOrder, { body: 'Made-up: cut size 50 first.', correctsMessageId: floor.message.id, forFloor: true })
    expect(fixed.message).toMatchObject({ forFloor: true, corrects: { id: floor.message.id } })
  })

  it('a shared message points only at a shared one; a mail is corrected by a mail, a portal reply in the portal', async () => {
    const record = { type: 'SalesOrder', id: orders[2]! }
    const officeNote = await note('SalesOrder', orders[2]!, { body: 'Made-up: internal only.' })
    const mail = await seam(record, 'OUTBOUND', 'EMAIL', 'Made-up: your order ships on Friday.')
    const portalReply = await seam(record, 'OUTBOUND', 'PORTAL', 'Made-up: the samples are ready.')
    expect(await problems(record, { replyToMessageId: officeNote.message.id }, { direction: 'OUTBOUND', channel: 'PORTAL' })).toEqual([expect.stringContaining('never an office note')])
    expect(await problems(record, { correctsMessageId: mail }, { direction: 'OUTBOUND', channel: 'PORTAL' })).toEqual([expect.stringContaining('A mail is corrected by a mail')])
    expect(await problems(record, { correctsMessageId: portalReply }, { direction: 'OUTBOUND', channel: 'EMAIL' })).toEqual([expect.stringContaining('corrected by a reply in the portal')])
    expect(await problems(record, { correctsMessageId: mail }, { direction: 'OUTBOUND', channel: 'EMAIL' })).toEqual([])
    expect(await problems(record, { replyToMessageId: mail }, { direction: 'OUTBOUND', channel: 'PORTAL' })).toEqual([])
    // An office note may answer or discuss anything of its conversation.
    expect(await problems(record, { replyToMessageId: mail }, { direction: 'INTERNAL_NOTE', channel: 'APP' })).toEqual([])
  })

  it('W08: the correction of a mail sent to customer A is shared with A only — A reads both and the link, B reads none', async () => {
    const record = { type: 'SalesOrder', id: orders[1]! }
    const mail = await seam(record, 'OUTBOUND', 'EMAIL', 'Made-up: delivery on the 12th.')
    const correction = await seam(record, 'OUTBOUND', 'EMAIL', 'Made-up: correction — delivery on the 14th.', { correctsMessageId: mail })
    expect(await admin<Json>('SELECT id, "partyId" FROM "Message" WHERE id = ANY($1::uuid[]) ORDER BY at, id', [[mail, correction]])).toEqual([
      { id: mail, partyId: partyA },
      { id: correction, partyId: partyA },
    ])
    const threadId = (await admin<{ id: string }>('SELECT "threadId" AS id FROM "Message" WHERE id = $1', [mail]))[0]!.id
    const asPartner = (partyId: string) =>
      h.database.withScope({ audience: 'partner', tenantId: T, actorId: newId(), partyId }, async (client) => {
        const rows = await client.message.findMany({ where: { threadId }, select: { id: true, replyToMessageId: true, correctsMessageId: true } })
        const links = await messageLinksOf(client, threadId, rows, { sharedOnly: true, workerShown: false })
        return { ids: rows.map((row) => row.id), linked: [...links.linked.keys()], correctedBy: Object.fromEntries(links.correctedBy) }
      })
    const a = await asPartner(partyA)
    expect(a.ids).toEqual(expect.arrayContaining([mail, correction]))
    expect(a.linked).toContain(mail)
    expect(a.correctedBy[mail]).toMatchObject({ id: correction })
    const b = await asPartner(partyB)
    expect(b).toEqual({ ids: [], linked: [], correctedBy: {} })
  })

  it('Make a task on a message: the task names it; only a message of the task’s own record', async () => {
    const asked = await note('SalesOrder', orders[0]!, { body: 'Made-up: call the buyer about the hood.' })
    const made = await ok('POST', '/tasks', { title: 'Made-up: call the buyer about the hood', record: { type: 'SalesOrder', id: orders[0] }, messageId: asked.message.id, assigneeId: null }, 201)
    expect(made.task).toMatchObject({ messageId: asked.message.id, record: { type: 'SalesOrder', id: orders[0] } })
    expect((await admin<Json>('SELECT "messageId" FROM "Task" WHERE id = $1', [made.task.id]))[0]).toEqual({ messageId: asked.message.id })
    expect((await ok('GET', `/tasks/${made.task.id}`)).task.messageId).toBe(asked.message.id)
    const other = await note('SalesOrder', orders[2]!, { body: 'Made-up: a note of another order.' })
    expect(await refused('/tasks', { title: 'Made-up', record: { type: 'SalesOrder', id: orders[0] }, messageId: other.message.id, assigneeId: null })).toEqual([expect.objectContaining({ path: 'body/messageId' })])
    expect(await refused('/tasks', { title: 'Made-up', messageId: asked.message.id, assigneeId: null })).toEqual([expect.objectContaining({ path: 'body/messageId' })])
  })
})
