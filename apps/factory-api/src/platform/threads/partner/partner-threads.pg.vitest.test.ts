import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { sortMail } from '@nexus/factory-domain/email-in/rules'
import { callerFor, command, type CommandTx } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../abuse/guard'
import { usePortalOptions } from '../../auth/portal/service'
import { freshGuard } from '../../auth/portal/testing/portal'
import { startHarness, type Browser, type Harness } from '../../auth/sessions/testing/harness'
import { sortFactsOf, type MailFacts } from '../../email-in/match'
import { inTenant, partnerWorld, signIn, type PartnerWorld } from '../../search/partner/testing/world'
import { ensureThread, writeMessage } from '../threads'

/**
 * The record thread as the partner sees it (B-W2b-168; COL-059, COL-060) on the local stack, through the real app: the
 * base seeds in one namespace, real portal sign-ins by e-mail code (FAKE mailbox), the partner role's row-level security
 * and the portal-frame guard on every read and post. COL-059: a portal session reads only the messages shared with its
 * party, never an internal note, with the files shared with it; COL-060: a portal post lands in the record's thread
 * (INBOUND, PORTAL, author PARTY, no author id), the office is told, the thread's last activity moves, and a reply by
 * e-mail from a portal person lands in the same thread. Refusals: view-only access, a closed thread, another party's
 * record, a record of another kind, a quote never sent, an office-only file. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/threads/partner`.
 */

let h: Harness
let world: PartnerWorld
let buyer: Browser
let viewer: Browser
let orders: Browser
const NS = 'pt168'

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const idOf = async (table: string, number: string): Promise<string> => (await admin<{ id: string }>(`SELECT id FROM "${table}" WHERE "tenantId" = $1 AND number = $2`, [world.tenantId, number]))[0]!.id
const office = () => callerFor(h.database, { audience: 'office', tenantId: world.tenantId, actorId: world.officeId, grants: [], requestId: newId() })

/** An internal note and a mail we sent to the party, written as the office and the email step do (the threads seam). */
async function officeWrites(type: string, recordId: string): Promise<{ note: string; mail: string }> {
  const { result } = await command(office(), { name: 'email.send', input: { type, recordId } }, async (tools) => {
    const { thread } = await ensureThread(tools, { type, id: recordId }, world.officeId)
    const note = await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: { kind: 'USER', id: world.officeId, name: 'Seed Owner' }, bodyText: 'Internal: their payment is late, keep it in the office.' })
    const mail = await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'EMAIL', author: { kind: 'USER', id: world.officeId, name: 'Seed Owner' }, bodyText: 'Your order is confirmed; it ships next week.' })
    return { note: note.id, mail: mail.id }
  })
  return result
}

/** An AVAILABLE file of a record, shared with a party (or office only), written straight into the table. */
async function file(recordType: string, recordId: string, partyId: string | null): Promise<string> {
  const id = newId()
  const store = (await admin<{ id: string }>(`SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2' ORDER BY id LIMIT 1`, [world.tenantId]))[0]!.id
  await admin(
    `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256,
       "storeAccountId", "storageKey", status, visibility, "partyId", "availableAt")
     VALUES ($1, $2, $3, $4, $5, 'DOCUMENT', $6, 'application/pdf', 100, $7, $8, $9, 'AVAILABLE', $10::"FileAudience"[], $11, now())`,
    [id, world.tenantId, world.companyA, recordType, recordId, `Made-up ${id.slice(-4)}.pdf`, createHash('sha256').update(id).digest('hex'), store, `t/${world.tenantId}/c/${world.companyA}/2026/${newId()}`, partyId ? ['OFFICE', 'PARTNER'] : ['OFFICE'], partyId],
  )
  return id
}

const thread = (browser: Browser, type: string, id: string, query = '') => browser.get(`/portal/threads/${type}/${id}${query}`)
const post = (browser: Browser, type: string, id: string, body: Json, key?: string) =>
  browser.send('POST', `/portal/threads/${type}/${id}/messages`, body, key ? { headers: { 'idempotency-key': key } } : {})

beforeAll(async () => {
  h = await startHarness('portal_threads')
  h.clock.set(new Date())
  freshGuard(h)
  world = await partnerWorld(h, NS)
  buyer = await signIn(h, world, world.people.buyer)
  viewer = await signIn(h, world, world.people.viewer)
  orders = await signIn(h, world, world.people.orders)
}, 600_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('COL-059: the record thread as the partner sees it', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('shows our mail and their posts, never an internal note, with the record as they know it and "answer our e-mails"', async () => {
    const order = await idOf('SalesOrder', 'SEED-SO-0001')
    const { note, mail } = await officeWrites('SalesOrder', order)
    const answer = await thread(buyer, 'SalesOrder', order)
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    expect(answer.body.record).toMatchObject({ type: 'SalesOrder', id: order, theirRef: 'SEED-PO-77', ourRef: 'SEED-SO-0001' })
    const ids = answer.body.messages.map((message: Json) => message.id)
    expect(ids).toContain(mail)
    expect(ids).not.toContain(note)
    const ours = answer.body.messages.find((message: Json) => message.id === mail)
    expect(ours).toMatchObject({ side: 'COMPANY', channel: 'EMAIL', author: { name: 'Seed Owner', mine: false }, body: 'Your order is confirmed; it ships next week.' })
    // Nothing only the office reads: no author id, no mentions, no floor flag, no last activity.
    expect(ours.author.id).toBeUndefined()
    expect(ours.mentions).toBeUndefined()
    expect(answer.body.thread.lastMessageAt).toBeUndefined()
    expect(answer.body.composer).toMatchObject({ canPost: true, reason: null, replyByEmail: true })
    // The seeded buyer reads Italian.
    expect(answer.body.composer.hint).toBe('Puoi anche rispondere alle nostre e-mail: la risposta arriva qui.')
  })

  it('a view-only person reads but is told in their language why they cannot write; a post is refused', async () => {
    const order = await idOf('SalesOrder', 'SEED-SO-0001')
    const answer = await thread(viewer, 'SalesOrder', order)
    expect(answer.status).toBe(200)
    expect(answer.body.composer).toMatchObject({ canPost: false, reason: 'NO_COMMENT', words: 'Your access lets you read this conversation, not write in it. Your admin can change that.' })
    expect((await post(viewer, 'SalesOrder', order, { body: 'Can I write?' })).status).toBe(403)
  })

  it('opens only the party’s own records of its kind, in the state it knows them in', async () => {
    const po = await idOf('PurchaseOrder', 'SEED-PO-0001')
    const order = await idOf('SalesOrder', 'SEED-SO-0001')
    const draftQuote = await idOf('Quote', 'SEED-Q-0002')
    // Another party's record, a type its portal does not show, a quote never sent: not found (no hint that it exists).
    expect((await thread(buyer, 'PurchaseOrder', po)).status).toBe(404)
    expect((await thread(orders, 'SalesOrder', order)).status).toBe(404)
    expect((await thread(buyer, 'Quote', draftQuote)).status).toBe(404)
    expect((await thread(buyer, 'WorkOrder', newId())).status).toBe(404)
    expect((await thread(buyer, 'Party', world.p2)).status).toBe(404)
    expect((await post(buyer, 'PurchaseOrder', po, { body: 'Not mine.' })).status).toBe(404)
    // The supplier sees its own PO.
    const own = await thread(orders, 'PurchaseOrder', po)
    expect(own.status, JSON.stringify(own.body)).toBe(200)
    expect(own.body.record).toMatchObject({ ourRef: 'SEED-PO-0001', theirRef: 'SEED-OC-2201' })
  })

  it('a session of another audience never reaches the portal routes', async () => {
    const anonymous = await h.app.inject({ method: 'GET', url: '/portal/threads' })
    expect(anonymous.statusCode).toBe(401)
  })
})

describe('COL-060: one thread whichever way the partner answers', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a portal post lands in the record’s thread as the party’s own message, audited, announced, the thread moved on', async () => {
    const order = await idOf('SalesOrder', 'SEED-SO-0001')
    const shared = await file('SalesOrder', order, world.p1)
    const key = `post-${newId()}`
    const answer = await post(buyer, 'SalesOrder', order, { body: '  Can you ship on Friday?\r\nThanks  ', attachments: [shared] }, key)
    expect(answer.status, JSON.stringify(answer.body)).toBe(201)
    const message = answer.body.message
    expect(message).toMatchObject({ side: 'PARTNER', channel: 'PORTAL', author: { name: 'Seed Portal Buyer', mine: true }, body: 'Can you ship on Friday?\nThanks' })
    expect(message.attachments.map((attachment: Json) => attachment.id)).toEqual([shared])

    const [row] = await admin('SELECT * FROM "Message" WHERE id = $1', [message.id])
    expect(row).toMatchObject({ direction: 'INBOUND', audience: 'PARTNER', channel: 'PORTAL', authorKind: 'PARTY', authorId: null, partyId: world.p1, authorName: 'Seed Portal Buyer', emailMessageId: null, forFloor: false })
    expect(row!.mentionedUserIds).toEqual([])
    const [audit] = await admin('SELECT * FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2', ['Message', message.id])
    expect(audit).toMatchObject({ action: 'portal.postMessage', actorId: world.people.buyer.id, audience: 'PARTNER', partyId: world.p1 })
    const events = await admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.message_posted' AND payload->>'messageId' = $2`, [world.tenantId, message.id])
    expect(events.map((event) => event.payload)).toEqual([expect.objectContaining({ recordType: 'SalesOrder', recordId: order, direction: 'INBOUND', audience: 'PARTNER' })])
    const [moved] = await admin('SELECT "lastMessageAt" FROM "Thread" WHERE id = $1', [answer.body.thread.id])
    expect(new Date(moved!.lastMessageAt).toISOString()).toBe(message.at)

    // The same request again (its Idempotency-Key): the same answer, no second message.
    const again = await post(buyer, 'SalesOrder', order, { body: '  Can you ship on Friday?\r\nThanks  ', attachments: [shared] }, key)
    expect(again.status).toBe(201)
    expect(again.body.message.id).toBe(message.id)
    expect((await admin('SELECT count(*)::int AS n FROM "Message" WHERE "threadId" = $1 AND channel = $2', [answer.body.thread.id, 'PORTAL']))[0]!.n).toBe(1)

    // The buyer reads it back as its own; the viewer of the same party reads it as a colleague's.
    expect((await thread(buyer, 'SalesOrder', order)).body.messages[0]).toMatchObject({ id: message.id, author: { mine: true } })
    expect((await thread(viewer, 'SalesOrder', order)).body.messages[0]).toMatchObject({ id: message.id, author: { name: 'Seed Portal Buyer', mine: false } })
  })

  it('posts into the record’s thread (made with the first post when it has none), with the record’s own party', async () => {
    const po = await idOf('PurchaseOrder', 'SEED-PO-0001')
    const answer = await post(orders, 'PurchaseOrder', po, { body: 'Confirmed for the 12th.' })
    expect(answer.status, JSON.stringify(answer.body)).toBe(201)
    const [made] = await admin('SELECT * FROM "Thread" WHERE id = $1', [answer.body.thread.id])
    expect(made).toMatchObject({ recordType: 'PurchaseOrder', recordId: po, partyId: world.p2, status: 'OPEN' })
    // "Ask a question" with no record: the account's own thread.
    const account = await post(buyer, 'Party', world.p1, { body: 'Can we change our invoice address?' })
    expect(account.status, JSON.stringify(account.body)).toBe(201)
    const read = await thread(buyer, 'Party', world.p1)
    expect(read.body.record).toMatchObject({ type: 'Party', id: world.p1 })
    expect(read.body.messages[0].body).toBe('Can we change our invoice address?')
  })

  it('attaches only available files of the record shared with the party', async () => {
    const order = await idOf('SalesOrder', 'SEED-SO-0001')
    const officeOnly = await file('SalesOrder', order, null)
    const otherRecord = await file('Party', world.p1, world.p1)
    const refused = await post(buyer, 'SalesOrder', order, { body: 'See attached.', attachments: [officeOnly, otherRecord] })
    expect(refused.status).toBe(400)
    expect(refused.body.error.issues).toEqual([
      { path: 'body/attachments/0', message: 'File not found.' },
      { path: 'body/attachments/1', message: 'Only a file of this record can be attached.' },
    ])
    expect((await post(buyer, 'SalesOrder', order, { body: '   ' })).status).toBe(400)
  })

  it('a closed thread refuses a post in words, and the composer says so', async () => {
    const quote = await idOf('Quote', 'SEED-Q-0001')
    const first = await post(buyer, 'Quote', quote, { body: 'One more question on the quote.' })
    expect(first.status, JSON.stringify(first.body)).toBe(201)
    await inTenant(h, world, (client) => client.thread.update({ where: { id: first.body.thread.id }, data: { status: 'CLOSED', version: { increment: 1 } }, select: { id: true } }))
    const refused = await post(buyer, 'Quote', quote, { body: 'Still there?' })
    expect(refused.status).toBe(409)
    expect(refused.body.error.issues).toEqual([{ path: 'thread/CLOSED', message: 'Seed A ha chiuso questa conversazione: non si possono aggiungere messaggi.' }])
    expect((await thread(buyer, 'Quote', quote)).body.composer).toMatchObject({ canPost: false, reason: 'CLOSED' })
  })

  it('a reply by e-mail from a portal person lands in the same thread (not held as an unknown sender)', async () => {
    const order = await idOf('SalesOrder', 'SEED-SO-0001')
    const [row] = await admin<{ id: string; replyToken: string }>('SELECT id, "replyToken" FROM "Thread" WHERE "tenantId" = $1 AND "recordType" = $2 AND "recordId" = $3', [world.tenantId, 'SalesOrder', order])
    const [identity] = await admin<{ replyDomain: string }>('SELECT "replyDomain" FROM "EmailIdentity" WHERE "tenantId" = $1 ORDER BY id LIMIT 1', [world.tenantId])
    const mail: MailFacts = {
      id: newId(),
      status: 'FETCHED',
      companyId: world.companyA,
      envelopeTo: [`r-${row!.replyToken}@${identity!.replyDomain}`],
      to: [`r-${row!.replyToken}@${identity!.replyDomain}`],
      cc: [],
      // The viewer's address is no contact of the party, nor at a contact's company domain: a portal person only.
      fromAddress: world.people.viewer.email,
      emailMessageId: `<${newId()}@studio-alpha.example>`,
      inReplyTo: null,
      referenceIds: [],
      spfVerdict: 'PASS',
      dkimVerdict: 'PASS',
      dmarcVerdict: 'PASS',
      spamVerdict: 'PASS',
      virusVerdict: 'PASS',
    } as MailFacts
    const { facts } = await inTenant(h, world, (client) => sortFactsOf(client as unknown as CommandTx, mail))
    expect(facts.thread).toMatchObject({ id: row!.id, by: 'TOKEN' })
    expect(facts.senderKnown).toBe('CONTACT')
    expect(sortMail(facts)).toEqual({ status: 'MATCHED', by: 'TOKEN', threadId: row!.id })
    // A stranger at the same domain is still held for a person.
    const stranger = await inTenant(h, world, (client) => sortFactsOf(client as unknown as CommandTx, { ...mail, fromAddress: `someone.${NS}@elsewhere.example` }))
    expect(sortMail(stranger.facts)).toMatchObject({ status: 'HELD', reason: 'UNKNOWN_SENDER' })
  })
})

describe('the party’s conversations (Messages list; Home’s recent messages from us)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('lists the conversations by their newest shared message, ours only with from=company, never another party’s', async () => {
    const all = await buyer.get('/portal/threads')
    expect(all.status, JSON.stringify(all.body)).toBe(200)
    const types = all.body.conversations.map((entry: Json) => entry.record.type)
    expect(types).toEqual(expect.arrayContaining(['SalesOrder', 'Party']))
    expect(types).not.toContain('PurchaseOrder')
    const times = all.body.conversations.map((entry: Json) => entry.last.at)
    expect([...times].sort().reverse()).toEqual(times)
    const ours = await buyer.get('/portal/threads?from=company')
    expect(ours.status).toBe(200)
    for (const entry of ours.body.conversations) expect(entry.last.side).toBe('COMPANY')
    expect((await buyer.get('/portal/threads?from=company&limit=3')).body.conversations.length).toBeLessThanOrEqual(3)
    const order = ours.body.conversations.find((entry: Json) => entry.record.type === 'SalesOrder')
    expect(order.last).toMatchObject({ excerpt: 'Your order is confirmed; it ships next week.', authorName: 'Seed Owner' })
    // The supplier's list holds its own records' threads only.
    const supplier = (await orders.get('/portal/threads')).body.conversations.map((entry: Json) => entry.record.type)
    expect(supplier).toContain('PurchaseOrder')
    expect(supplier).not.toContain('SalesOrder')
    expect(supplier).not.toContain('Quote')
  })
})
