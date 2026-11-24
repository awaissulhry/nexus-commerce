import { createHash } from 'node:crypto' // tw-s: the made-up files of a quote
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
// B-SA-061: what a message is about.
import { ABOUT_WORDS, type About } from './about'

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
 * B-SA-061 ("Discuss"; sales page plan R10 item 6): a note or a reply says which part of its sales order it is about (a line, a
 * work order that makes a line of it …), written once with the message and read back by the office; another order's line, another
 * customer's record or an id that is not there is refused in ONE neutral sentence and never stored; a reply to the customer is
 * never about a work order; a mixed work order is named only by who reaches every customer and read without it by anyone else;
 * the database refuses the same whatever writes it.
 * Every name and word is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/threads/message-links`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'message-links-th050'
const T = seedUuid(NS, 'tenant')
const partyA = seedUuid(NS, 'party:P1')
const partyB = seedUuid(NS, 'party:P3')
const WRITER = newId()
const ALPHA_DESK = newId() // B-SA-061: an office person limited to customer A
const PRICEY = newId() // tw-s S.1: an office reader who sees prices (the price grain)
const grant = (permissions: string[], parties: Grant['parties'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties })
const SESSIONS: Record<string, SessionContext> = {
  writer: { audience: 'office', tenantId: T, actorId: WRITER, grants: [grant(['threads.read', 'threads.post', 'files.read', 'tasks.manage', 'home.view'])] },
  // B-SA-061
  alphaDesk: { audience: 'office', tenantId: T, actorId: ALPHA_DESK, grants: [grant(['threads.read', 'threads.post', 'files.read'], [partyA])] },
  // tw-s S.1
  pricey: { audience: 'office', tenantId: T, actorId: PRICEY, grants: [grant(['threads.read', 'files.read', 'money.price'])] },
}

let h: Harness
let app: FastifyInstance
let run = 0
let orders: string[] = []
let workOrder = ''
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `th050-key-${++run}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
    // fix-pg-1: command() audits every write; on a thread that exists already nothing else is written, so the check names itself.
    tools.audit({ recordType: 'Test', recordId: thread.id, after: { checked: 'messageLinkProblems' } })
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
  await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, \'ACTIVE\', \'en\')', [ALPHA_DESK, T, 'sa061-alpha-desk@example.com', 'Made-up Alpha desk']) // B-SA-061
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

// ── B-SA-061 (sales page plan S5, lead picks P26, P9, R10 item 6; 10-order-page §6.4 "Discuss"): what a message is about ──
describe('B-SA-061: a message says which part of its order it is about', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  // SEED-SO-0002 (customer A) and SEED-WO-0001, the work order that makes its lines (seed/production.ts).
  const order = seedUuid(NS, 'production:sales-order:SO-0002')
  const part = { line: '', otherOrderLine: '', otherCustomerLine: '', otherCustomerWorkOrder: '', mixedWorkOrder: '' }
  const NOT_PART = [{ path: 'body/about', message: ABOUT_WORDS.NOT_PART.en }]
  const as = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'x-test-session': who, ...(method === 'GET' ? {} : { 'idempotency-key': `sa061-key-${++run}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  const issuesOf = (response: { statusCode: number; body: string; json: () => unknown }): Json[] => {
    expect(response.statusCode, response.body).toBe(400)
    return ((response.json() as Json).error?.issues ?? []) as Json[]
  }
  const stored = async (body: string) => (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "Message" WHERE "bodyText" = $1', [body]))[0]!.n
  /** One message written through the seam (the system), with what it is about. */
  const aboutSeam = (direction: MessageDirection, channel: MessageChannel, body: string, about: About) =>
    command(callerFor(h.database, office()), { name: 'threads.test.about', input: { direction, body, about } }, async (tools) => {
      const { thread } = await ensureThread(tools, { type: 'SalesOrder', id: order }, WRITER)
      const written = await writeMessage(tools, thread, { direction, channel, author: { kind: 'USER', id: WRITER, name: 'Made-up writer' }, bodyText: body, about })
      return { id: written.id }
    })

  beforeAll(async () => {
    const [workOrder] = await admin<{ id: string }>("SELECT id FROM \"WorkOrder\" WHERE \"tenantId\" = $1 AND number = 'SEED-WO-0001'", [T])
    part.line = (await admin<{ id: string }>('SELECT l.id FROM "SalesOrderLine" l JOIN "WorkOrderSize" c ON c."salesOrderLineId" = l.id WHERE l."orderId" = $1 AND c."workOrderId" = $2 ORDER BY l.id LIMIT 1', [order, workOrder!.id]))[0]!.id
    part.otherOrderLine = (await admin<{ id: string }>('SELECT id FROM "SalesOrderLine" WHERE "tenantId" = $1 AND "partyId" = $2 AND "orderId" <> $3 ORDER BY id LIMIT 1', [T, partyA, order]))[0]!.id
    part.otherCustomerLine = (await admin<{ id: string }>('SELECT id FROM "SalesOrderLine" WHERE "tenantId" = $1 AND "partyId" <> $2 ORDER BY id LIMIT 1', [T, partyA]))[0]!.id
    part.otherCustomerWorkOrder = (await admin<{ id: string }>('SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND "partyId" IS NOT NULL AND "partyId" <> $2 ORDER BY id LIMIT 1', [T, partyA]))[0]!.id
    // A work order made before the one-customer rule (no customer), making a line of this order: SEED-WO-0001 copied with no
    // customer, its own number and batch number (both unique in the tenant), and one cell of the order's line (the
    // database's rules off for this one statement, as the copy step met them).
    part.mixedWorkOrder = newId()
    await h.db.admin.query(
      `BEGIN;
       SET LOCAL session_replication_role = replica;
       INSERT INTO "WorkOrder" SELECT (jsonb_populate_record(NULL::"WorkOrder", to_jsonb(w) || jsonb_build_object('id', '${part.mixedWorkOrder}', 'number', 'T-SA061-MIX', 'batchNumber', 'T-SA061-MIX', 'partyId', NULL))).* FROM "WorkOrder" w WHERE w.id = '${workOrder!.id}';
       INSERT INTO "WorkOrderSize" SELECT (jsonb_populate_record(NULL::"WorkOrderSize", to_jsonb(c) || jsonb_build_object('id', '${newId()}', 'workOrderId', '${part.mixedWorkOrder}'))).* FROM "WorkOrderSize" c WHERE c."workOrderId" = '${workOrder!.id}' AND c."salesOrderLineId" = '${part.line}' ORDER BY c.id LIMIT 1;
       COMMIT;`,
    )
  })

  it('a note names a line of its order: written once with the message, read back by the office', async () => {
    const made = await note('SalesOrder', order, { body: 'Made-up: line 2 needs the darker thread.', about: { kind: 'SalesOrderLine', id: part.line } })
    expect(made.message.about).toEqual({ kind: 'SalesOrderLine', id: part.line })
    expect((await admin<Json>('SELECT "aboutKind", "aboutId" FROM "Message" WHERE id = $1', [made.message.id]))[0]).toEqual({ aboutKind: 'SalesOrderLine', aboutId: part.line })
    expect((await messagesOf('SalesOrder', order)).find((message) => message.id === made.message.id)?.about).toEqual({ kind: 'SalesOrderLine', id: part.line })
    // A message about nothing reads so.
    const plain = await note('SalesOrder', order, { body: 'Made-up: nothing in particular.' })
    expect(plain.message.about).toBeNull()
  })

  it('an office note names a work order that makes a line of the order', async () => {
    const [workOrder] = await admin<{ id: string }>("SELECT id FROM \"WorkOrder\" WHERE \"tenantId\" = $1 AND number = 'SEED-WO-0001'", [T])
    const made = await note('SalesOrder', order, { body: 'Made-up: the work order waits for the zips.', about: { kind: 'WorkOrder', id: workOrder!.id } })
    expect(made.message.about).toEqual({ kind: 'WorkOrder', id: workOrder!.id })
    // A person limited to customer A reaches A's own work order: they may name it too.
    const desk = await as('alphaDesk', 'POST', `/threads/SalesOrder/${order}/notes`, { body: 'Made-up: Alpha desk on the work order.', about: { kind: 'WorkOrder', id: workOrder!.id } })
    expect(desk.statusCode, desk.body).toBe(201)
  })

  it('another record’s id is refused in ONE neutral sentence and never stored: another order’s line, another customer’s line or work order, an id that is not there', async () => {
    const tries: Array<{ label: string; about: About }> = [
      { label: 'another order of the same customer', about: { kind: 'SalesOrderLine', id: part.otherOrderLine } },
      { label: 'another customer’s line', about: { kind: 'SalesOrderLine', id: part.otherCustomerLine } },
      { label: 'another customer’s work order', about: { kind: 'WorkOrder', id: part.otherCustomerWorkOrder } },
      { label: 'a line that is not there', about: { kind: 'SalesOrderLine', id: newId() } },
      { label: 'a shipment that is not there', about: { kind: 'Shipment', id: newId() } },
      { label: 'an order line named as a change request', about: { kind: 'OrderChangeRequest', id: part.line } },
    ]
    for (const one of tries) {
      const body = `Made-up: about ${one.label}.`
      expect(issuesOf(await as('writer', 'POST', `/threads/SalesOrder/${order}/notes`, { body, about: one.about })), one.label).toEqual(NOT_PART)
      expect(await stored(body), one.label).toBe(0)
    }
    // Only a sales order's message is about a part of it: a work order's note is refused the same way, before anything is read.
    const [workOrder] = await admin<{ id: string }>("SELECT id FROM \"WorkOrder\" WHERE \"tenantId\" = $1 AND number = 'SEED-WO-0001'", [T])
    expect(issuesOf(await as('writer', 'POST', `/threads/WorkOrder/${workOrder!.id}/notes`, { body: 'Made-up: about the line.', about: { kind: 'SalesOrderLine', id: part.line } }))).toEqual(NOT_PART)
    // A kind the database does not know is refused by the contract.
    expect((await as('writer', 'POST', `/threads/SalesOrder/${order}/notes`, { body: 'Made-up: about a style.', about: { kind: 'Style', id: newId() } })).statusCode).toBe(400)
  })

  it('a reply to the customer is never about a work order: refused in words, nothing written', async () => {
    const [workOrder] = await admin<{ id: string }>("SELECT id FROM \"WorkOrder\" WHERE \"tenantId\" = $1 AND number = 'SEED-WO-0001'", [T])
    const body = 'Made-up: your work order is cut.'
    expect(issuesOf(await as('writer', 'POST', `/threads/SalesOrder/${order}/replies`, { body, about: { kind: 'WorkOrder', id: workOrder!.id } }))).toEqual([{ path: 'body/about/kind', message: ABOUT_WORDS.OFFICE_ONLY.en }])
    expect(await stored(body)).toBe(0)
    // A reply's about is on a sales order's reply only.
    expect(issuesOf(await as('writer', 'POST', `/threads/Party/${partyA}/replies`,{ body: 'Made-up: about a line.', about: { kind: 'SalesOrderLine', id: part.line } }))).toEqual(NOT_PART)
  })

  it('the wall: a mixed work order is named only by who reaches every customer, and read without it by anyone else', async () => {
    const body = 'Made-up: the mixed work order is behind.'
    const made = await note('SalesOrder', order, { body, about: { kind: 'WorkOrder', id: part.mixedWorkOrder } })
    expect(made.message.about).toEqual({ kind: 'WorkOrder', id: part.mixedWorkOrder })
    // A person limited to customer A: the same neutral sentence as for an id that is not there; nothing stored.
    const deskBody = 'Made-up: Alpha desk on the mixed work order.'
    expect(issuesOf(await as('alphaDesk', 'POST', `/threads/SalesOrder/${order}/notes`, { body: deskBody, about: { kind: 'WorkOrder', id: part.mixedWorkOrder } }))).toEqual(NOT_PART)
    expect(await stored(deskBody)).toBe(0)
    // They read the order's thread, and the message, without what it is about; the factory reads it with it.
    const read = await as('alphaDesk', 'GET', `/threads/SalesOrder/${order}?limit=200`)
    expect(read.statusCode, read.body).toBe(200)
    const seen = ((read.json() as Json).messages as Json[]).find((message) => message.id === made.message.id)
    expect(seen).toMatchObject({ body, about: null })
    expect(read.body).not.toContain(part.mixedWorkOrder)
    expect((await messagesOf('SalesOrder', order)).find((message) => message.id === made.message.id)?.about).toEqual({ kind: 'WorkOrder', id: part.mixedWorkOrder })
  })

  it('the database refuses the same, whatever writes it; a portal message about a line of its order is stored with the customer', async () => {
    await expect(aboutSeam('INTERNAL_NOTE', 'APP', 'Made-up: seam about another order.', { kind: 'SalesOrderLine', id: part.otherOrderLine })).rejects.toThrow()
    await expect(aboutSeam('INTERNAL_NOTE', 'APP', 'Made-up: seam about another customer.', { kind: 'SalesOrderLine', id: part.otherCustomerLine })).rejects.toThrow()
    await expect(aboutSeam('OUTBOUND', 'PORTAL', 'Made-up: seam about the work order.', { kind: 'WorkOrder', id: part.mixedWorkOrder })).rejects.toThrow()
    expect(await stored('Made-up: seam about another order.')).toBe(0)
    expect(await stored('Made-up: seam about another customer.')).toBe(0)
    expect(await stored('Made-up: seam about the work order.')).toBe(0)
    const { result } = await aboutSeam('OUTBOUND', 'PORTAL', 'Made-up: your line 2 is sewn.', { kind: 'SalesOrderLine', id: part.line })
    expect((await admin<Json>('SELECT "partyId", "aboutKind", "aboutId" FROM "Message" WHERE id = $1', [result.id]))[0]).toEqual({ partyId: partyA, aboutKind: 'SalesOrderLine', aboutId: part.line })
    // Written once: the message never changes (the database's append-only rule), so neither does what it is about.
    await expect(admin('UPDATE "Message" SET "aboutId" = $2 WHERE id = $1', [result.id, part.otherOrderLine])).rejects.toThrow()
  })
})
// ── end B-SA-061 ──

// ── tw-s (the thread rebuild: the record thread looks and works like a group chat; walls R1, R2, worker privacy): what a quote carries ──
describe('tw-s: a quote carries its own data, through the reader’s own walls', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  type Ref = { type: string; id: string }
  const read = async (who: string, url: string): Promise<Json> => {
    const response = await call(who, 'GET', url)
    expect(response.statusCode, response.body).toBe(200)
    return response.json() as Json
  }
  const byId = (page: Json, id: string): Json => (page.messages as Json[]).find((message) => message.id === id)!
  /** An AVAILABLE office file of the record, written straight into the table (the files flow is platform/files'). */
  async function officeFile(record: Ref, name: string, kind: 'DOCUMENT' | 'PHOTO', contentType: string, priced: boolean): Promise<string> {
    const id = newId()
    const [owner] = await admin<{ companyId: string }>(`SELECT "companyId" FROM "${record.type}" WHERE id = $1`, [record.id])
    const [store] = await admin<{ id: string }>(`SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2' ORDER BY id LIMIT 1`, [T])
    await admin(
      `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256,
         "storeAccountId", "storageKey", status, visibility, "partyId", "availableAt", priced)
       VALUES ($1, $2, $3, $4, $5, $6::"FileKind", $7, $8, 100, $9, $10, $11, 'AVAILABLE', '{OFFICE}'::"FileAudience"[], NULL, now(), $12)`,
      [id, T, owner!.companyId, record.type, record.id, kind, name, contentType, createHash('sha256').update(id).digest('hex'), store!.id, `t/${T}/c/${owner!.companyId}/2026/${newId()}`, priced],
    )
    return id
  }
  /** Test data past the guards (replica mode, the one admin connection). */
  async function pastGuards(work: () => Promise<void>): Promise<void> {
    await admin('SET session_replication_role = replica')
    try {
      await work()
    } finally {
      await admin('SET session_replication_role = DEFAULT')
    }
  }

  beforeAll(async () => {
    await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", status, locale) VALUES ($1, $2, $3, $4, \'ACTIVE\', \'en\')', [PRICEY, T, 'tws-pricey@example.com', 'Made-up price reader'])
  })

  it('a quote names its writer’s kind, says erased, and counts the files the READER may open; a priced file is never the quote’s file for a reader without the price grain', async () => {
    const record: Ref = { type: 'SalesOrder', id: orders[1]! }
    const priced = await officeFile(record, 'Made-up order confirmation.pdf', 'DOCUMENT', 'application/pdf', true)
    const photo = await officeFile(record, 'Made-up sleeve.jpg', 'PHOTO', 'image/jpeg', false)
    // An office note with the priced file first, then the photo; a customer's mail later erased after a privacy request.
    const { result } = await command(callerFor(h.database, office()), { name: 'threads.test.quoted', input: { record } }, async (tools) => {
      const { thread } = await ensureThread(tools, record, WRITER)
      const withFiles = await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'USER', id: WRITER, name: 'Made-up writer' }, bodyText: 'Made-up: the confirmation and the sleeve.', attachments: [priced, photo] })
      const asked = await writeMessage(tools, thread, { direction: 'INBOUND', channel: 'EMAIL', author: { kind: 'PARTY', id: null, name: 'Made-up rider' }, bodyText: 'Made-up: my home address is …' })
      return { withFiles: withFiles.id, asked: asked.id, companyId: thread.companyId }
    })
    await pastGuards(async () => {
      await admin(`UPDATE "Message" SET "authorName" = NULL, "bodyText" = '', "bodyHtml" = NULL WHERE id = $1`, [result.asked])
      await admin(
        `INSERT INTO "ErasureRecord" (id, "tenantId", "companyId", "sweepId", "recordType", "recordId", method, "erasedFields", "keptFields", "erasedAt")
         VALUES ($1, $2, $3, $4, 'Message', $5, 'ANONYMISED', '{authorName,bodyText,bodyHtml}', '{}', now())`,
        [newId(), T, result.companyId, newId(), result.asked],
      )
    })
    const onFiles = await note(record.type, record.id, { body: 'Made-up: filed, thanks.', replyToMessageId: result.withFiles })
    const onErased = await note(record.type, record.id, { body: 'Made-up: noted.', replyToMessageId: result.asked })

    // The writer does not see prices: the priced file never counts and is never the quote's file — the photo is.
    const quoteOfFiles = { id: result.withFiles, authorKind: 'USER', authorId: WRITER, audience: 'OFFICE', authorName: 'Made-up writer', excerpt: 'Made-up: the confirmation and the sleeve.', at: expect.any(String), fileCount: 1, firstFile: { id: photo, kind: 'PHOTO', contentType: 'image/jpeg' } }
    expect(onFiles.message.replyTo).toEqual(quoteOfFiles)
    const asWriter = await read('writer', `/threads/${record.type}/${record.id}?limit=200`)
    expect(byId(asWriter, onFiles.message.id).replyTo).toEqual(quoteOfFiles)
    expect(JSON.stringify(byId(asWriter, onFiles.message.id).replyTo)).not.toContain(priced)
    // The card of the quoted note still shows the priced file locked (counted, never named): the quote only leaves it out.
    expect(byId(asWriter, result.withFiles).attachments).toEqual(expect.arrayContaining([expect.objectContaining({ id: priced, originalName: '', locked: 'PRICED' })]))
    // A reader with the price grain opens both: the priced file is first.
    const asPricey = await read('pricey', `/threads/${record.type}/${record.id}?limit=200`)
    expect(byId(asPricey, onFiles.message.id).replyTo).toMatchObject({ id: result.withFiles, fileCount: 2, firstFile: { id: priced, kind: 'DOCUMENT', contentType: 'application/pdf' } })
    // The erased message is said so: no name, no words, its kind and audience kept, no file.
    const erasedQuote = { id: result.asked, authorKind: 'PARTY', authorId: null, audience: 'PARTNER', authorName: null, excerpt: '', erased: true, fileCount: 0, firstFile: null }
    expect(byId(asWriter, onErased.message.id).replyTo).toMatchObject(erasedQuote)
    expect(onErased.message.replyTo).toMatchObject(erasedQuote)
    // A quote of a message that is not erased never says so.
    expect(byId(asWriter, onFiles.message.id).replyTo).not.toHaveProperty('erased')
  })
})
// ── end tw-s ──
