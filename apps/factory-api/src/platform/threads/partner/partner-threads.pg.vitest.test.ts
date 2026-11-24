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
import { inTenant, partnerWorld, signIn, type PartnerWorld, type Person } from '../../search/partner/testing/world'
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
    // th2-backend step 7 (§0.5): "ours" is the customer's own order number, never the office's SO-… series.
    expect(answer.body.record).toMatchObject({ type: 'SalesOrder', id: order, theirRef: 'SEED-PO-77', ourRef: expect.stringMatching(/^#\d+$/) })
    expect(JSON.stringify(answer.body)).not.toContain('SEED-SO-0001')
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
    expect(answer.body.composer.hint).toBe('Potete anche rispondere alle nostre e-mail: la risposta arriva qui.')
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

  it('B-W2b-197: a customer’s return and complaint have their thread (the case’s Messages tab); a supplier never opens them', async () => {
    const rma = await idOf('ReturnAuthorisation', 'SEED-RMA-0001')
    const complaint = await idOf('Complaint', 'SEED-CMP-0001')
    const read = await thread(buyer, 'ReturnAuthorisation', rma)
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect(read.body.record).toMatchObject({ type: 'ReturnAuthorisation', id: rma, ourRef: 'SEED-RMA-0001' })
    const claim = await thread(buyer, 'Complaint', complaint)
    expect(claim.status, JSON.stringify(claim.body)).toBe(200)
    expect(claim.body.record).toMatchObject({ type: 'Complaint', ourRef: 'SEED-CMP-0001' })
    // Never the internal note of the complaint (the partner grant hides it; the view never names it).
    expect(JSON.stringify(claim.body)).not.toMatch(/internalNote/)
    const sent = await post(buyer, 'ReturnAuthorisation', rma, { body: 'We send it back on Monday.' }, newId())
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    expect((await admin(`SELECT m.direction, m.channel, m."authorKind" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'ReturnAuthorisation' AND t."recordId" = $1 AND m."bodyText" = $2`, [rma, 'We send it back on Monday.']))[0]).toMatchObject({ direction: 'INBOUND', channel: 'PORTAL', authorKind: 'PARTY' })
    // The supplier of another party: as if it did not exist.
    expect((await thread(orders, 'ReturnAuthorisation', rma)).status).toBe(404)
    expect((await thread(orders, 'Complaint', complaint)).status).toBe(404)
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

// ── tw-s S.1 (the thread rebuild; wall R1: a quote is drawn only from the reader's own read) ──
describe('tw-s R1: a portal read quotes only messages shared with its own customer', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('R1: every replyTo / corrects of a portal read is a shared message of the same customer, with no authorId, no audience, never an office note', async () => {
    const order = await idOf('SalesOrder', 'SEED-SO-0001')
    // The office: a note, our mail, our mail correcting it, an office note answering our mail (never the portal's).
    const by = { kind: 'USER' as const, id: world.officeId, name: 'Seed Owner' }
    const { result: written } = await command(office(), { name: 'email.send', input: { type: 'SalesOrder', order, tws: 'R1' } }, async (tools) => {
      const { thread } = await ensureThread(tools, { type: 'SalesOrder', id: order }, world.officeId)
      const note = await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: by, bodyText: 'Made-up R1: internal, the lining is late.' })
      const mail = await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'EMAIL', author: by, bodyText: 'Made-up R1: the jackets ship on Friday.' })
      const fixed = await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'EMAIL', author: by, bodyText: 'Made-up R1: correction, they ship on Monday.', correctsMessageId: mail.id })
      const aside = await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: by, bodyText: 'Made-up R1: an office note on our mail.', replyToMessageId: mail.id })
      return { note: note.id, mail: mail.id, fixed: fixed.id, aside: aside.id }
    })
    // The buyer writes in the portal; our answer in the portal quotes the buyer's post.
    const asked = await post(buyer, 'SalesOrder', order, { body: 'Made-up R1: Monday works for us.' }, newId())
    expect(asked.status, JSON.stringify(asked.body)).toBe(201)
    const { result: answered } = await command(office(), { name: 'threads.reply', input: { type: 'SalesOrder', order, tws: 'R1-answer' } }, async (tools) => {
      const { thread } = await ensureThread(tools, { type: 'SalesOrder', id: order }, world.officeId)
      const answer = await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'PORTAL', author: by, bodyText: 'Made-up R1: noted, Monday it is.', replyToMessageId: asked.body.message.id })
      return { answer: answer.id }
    })

    const page = await thread(buyer, 'SalesOrder', order, '?limit=200')
    expect(page.status, JSON.stringify(page.body)).toBe(200)
    const messages = page.body.messages as Json[]
    const quotes = messages.flatMap((message) => [message.replyTo, message.corrects]).filter((quote): quote is Json => quote !== null && quote !== undefined)
    const quotedIds = [...new Set(quotes.map((quote) => quote.id as string))]
    expect(quotedIds).toEqual(expect.arrayContaining([written.mail, asked.body.message.id]))
    // Every quote is a message shared with this customer (the database says so) — never an office note, never another customer's.
    const rows = await admin<{ id: string; audience: string; partyId: string | null }>('SELECT id, audience, "partyId" FROM "Message" WHERE id = ANY($1::uuid[])', [quotedIds])
    expect(rows.length).toBe(quotedIds.length)
    for (const row of rows) expect(row, row.id).toMatchObject({ audience: 'PARTNER', partyId: world.p1 })
    for (const quote of quotes) {
      expect([written.note, written.aside], quote.id).not.toContain(quote.id)
      expect(quote, quote.id).not.toHaveProperty('authorId')
      expect(quote, quote.id).not.toHaveProperty('audience')
      expect(quote, quote.id).toMatchObject({ authorKind: expect.stringMatching(/^(USER|PARTY|SYSTEM)$/), mine: expect.any(Boolean), fileCount: expect.any(Number) })
    }
    expect(JSON.stringify(page.body)).not.toMatch(/Made-up R1: internal|an office note on our mail/)
    // Our correction quotes our mail; our answer quotes the buyer's own post ("mine" for the buyer, a colleague's for the viewer).
    const of = (body: Json, id: string): Json => (body.messages as Json[]).find((message) => message.id === id)!
    expect(of(page.body, written.fixed).corrects).toMatchObject({ id: written.mail, authorKind: 'USER', authorName: 'Seed Owner', mine: false, fileCount: 0, firstFile: null })
    expect(of(page.body, answered.answer).replyTo).toMatchObject({ id: asked.body.message.id, authorKind: 'PARTY', mine: true })
    const asViewer = await thread(viewer, 'SalesOrder', order, '?limit=200')
    expect(asViewer.status, JSON.stringify(asViewer.body)).toBe(200)
    expect(of(asViewer.body, answered.answer).replyTo).toMatchObject({ id: asked.body.message.id, mine: false })
  })
})
// ── end tw-s ──

// ── pt-s (S.6, the portal reply link; walls: the office note, the held mail, the brand): a portal post may answer a shared message ──
describe('pt-s S.6: a portal post answers a shared message of its own record', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  // The ONE neutral refusal (409), pinned as the web reads it: its issue path, and the words of a reader of Italian (the seeded buyers).
  const REPLY_ISSUE = 'refusal/REPLY_REFUSED'
  const REFUSED_IT = 'A quel messaggio non si può rispondere qui.'
  const messagesOf = async (threadId: string): Promise<number> => (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "Message" WHERE "threadId" = $1', [threadId]))[0]!.n
  const postsBy = async (actorId: string): Promise<number> => (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "AuditLog" WHERE action = $1 AND "actorId" = $2', ['portal.postMessage', actorId]))[0]!.n
  const threadIdOf = async (type: string, recordId: string): Promise<string> => (await admin<{ id: string }>('SELECT id FROM "Thread" WHERE "tenantId" = $1 AND "recordType" = $2 AND "recordId" = $3', [world.tenantId, type, recordId]))[0]!.id
  /** Test data past the guards, on the one admin connection (a mail in its undo window). */
  const pastGuards = async (work: () => Promise<unknown>): Promise<void> => {
    await admin('SET session_replication_role = replica')
    try {
      await work()
    } finally {
      await admin('SET session_replication_role = DEFAULT')
    }
  }
  /** A9: a record of brand A its portal opens that has no conversation yet (a read makes none). */
  async function recordWithNoThread(): Promise<{ type: string; id: string }> {
    for (const type of ['SalesOrder', 'Quote', 'ReturnAuthorisation', 'Complaint']) {
      const rows = await admin<{ id: string }>(
        `SELECT r.id FROM "${type}" r WHERE r."tenantId" = $1 AND r."partyId" = $2
           AND NOT EXISTS (SELECT 1 FROM "Thread" t WHERE t."tenantId" = r."tenantId" AND t."recordType" = $3 AND t."recordId" = r.id) ORDER BY r.id`,
        [world.tenantId, world.p1, type],
      )
      for (const row of rows) {
        const read = await thread(buyer, type, row.id)
        if (read.status === 200 && read.body.thread === null) return { type, id: row.id }
      }
    }
    throw new Error('the seeds give brand A no record its portal opens without a conversation')
  }

  // Brand B (the threads' second brand, SEED-C2B, its order SEED-SO-B001): its buyer may write on its own records, as brand A's may.
  let beta: Browser
  let betaId = ''
  beforeAll(async () => {
    freshGuard(h)
    const brandB = (await admin<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C2B'`, [world.tenantId]))[0]!.id
    const buyerB = (await admin<{ id: string; email: string; displayName: string }>(`SELECT id, email, "displayName" FROM "User" WHERE "tenantId" = $1 AND "partyId" = $2 AND email LIKE 'buyer.second-brand.%' LIMIT 1`, [world.tenantId, brandB]))[0]!
    await inTenant(h, world, async (client) => {
      await client.portalSettings.updateMany({ where: { partyId: brandB }, data: { portalOn: true } })
      const role = await client.role.findFirstOrThrow({ where: { key: 'partner-comment', audience: 'PARTNER' }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: buyerB.id, roleId: role.id, allCompanies: true, partyIds: [brandB], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    })
    betaId = buyerB.id
    beta = await signIn(h, world, { id: buyerB.id, email: buyerB.email, name: buyerB.displayName } satisfies Person)
  }, 600_000)

  it('a portal post answers a shared message of its record; an office note, a held mail or another record’s message is refused in words and nothing is written', async () => {
    const order = await idOf('SalesOrder', 'SEED-SO-0001')
    const by = { kind: 'USER' as const, id: world.officeId, name: 'Seed Owner' }
    const { result: written } = await command(office(), { name: 'email.send', input: { type: 'SalesOrder', order, pts: 'S.2' } }, async (tools) => {
      const { thread } = await ensureThread(tools, { type: 'SalesOrder', id: order }, world.officeId)
      const note = await writeMessage(tools, thread, { direction: 'INTERNAL_NOTE', channel: 'APP', author: by, bodyText: 'Made-up pt-s S.2: internal, the lining is late.' })
      const mail = await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'EMAIL', author: by, bodyText: 'Made-up pt-s S.2: the jackets ship on Friday.' })
      const held = await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'EMAIL', author: by, bodyText: 'Made-up pt-s S.2: a mail still in its undo window.' })
      return { threadId: thread.id, note: note.id, mail: mail.id, held: held.id }
    })
    await pastGuards(() => admin('UPDATE "Message" SET held = true WHERE id = $1', [written.held]))
    // Another record's message shared with the same customer: the buyer's own question on its account.
    const elsewhere = await post(buyer, 'Party', world.p1, { body: 'Made-up pt-s S.2: a question on our account.' }, newId())
    expect(elsewhere.status, JSON.stringify(elsewhere.body)).toBe(201)

    // The answer to our mail lands.
    const answered = await post(buyer, 'SalesOrder', order, { body: 'Made-up pt-s S.2: Friday works for us.', replyToMessageId: written.mail }, newId())
    expect(answered.status, JSON.stringify(answered.body)).toBe(201)
    // S.3: the stored message carries the link (never a correction), and its audit row names it.
    const [stored] = await admin('SELECT "replyToMessageId", "correctsMessageId", direction, audience, channel, "authorKind", "authorId" FROM "Message" WHERE id = $1', [answered.body.message.id])
    expect(stored).toEqual({ replyToMessageId: written.mail, correctsMessageId: null, direction: 'INBOUND', audience: 'PARTNER', channel: 'PORTAL', authorKind: 'PARTY', authorId: null })
    const [audit] = await admin('SELECT after FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2 AND action = $3', ['Message', answered.body.message.id, 'portal.postMessage'])
    expect(audit!.after).toMatchObject({ threadId: written.threadId, replyToMessageId: written.mail, direction: 'INBOUND', audience: 'PARTNER', channel: 'PORTAL' })

    // An office note, a held mail, another record's message, a message that is not there: refused alike — 409, ONE neutral sentence in
    // the person's language, never which case it was — and nothing written (no message, no audit row, the conversation as it was).
    const before = { messages: await messagesOf(written.threadId), posts: await postsBy(world.people.buyer.id) }
    for (const target of [written.note, written.held, elsewhere.body.message.id as string, newId()]) {
      const body = `Made-up pt-s S.2: an answer that never lands (${target.slice(-4)}).`
      const refused = await post(buyer, 'SalesOrder', order, { body, replyToMessageId: target }, newId())
      expect(refused.status, `${target}: ${JSON.stringify(refused.body)}`).toBe(409)
      expect(refused.body.error).toMatchObject({ code: 'conflict', message: REFUSED_IT, issues: [{ path: REPLY_ISSUE, message: REFUSED_IT }] })
      expect(JSON.stringify([refused.body.error.message, refused.body.error.issues]), target).not.toMatch(/note|nota|ufficio|office|internal|held|undo|account|lining/i)
      expect(await admin('SELECT id FROM "Message" WHERE "tenantId" = $1 AND "bodyText" = $2', [world.tenantId, body])).toEqual([])
    }
    expect({ messages: await messagesOf(written.threadId), posts: await postsBy(world.people.buyer.id) }).toEqual(before)

    // A9: a record with no conversation yet — nothing to answer; refused in the same words BEFORE a thread is made (none is made).
    const fresh = await recordWithNoThread()
    const none = await post(buyer, fresh.type, fresh.id, { body: 'Made-up pt-s A9: an answer to nothing here.', replyToMessageId: written.mail }, newId())
    expect(none.status, JSON.stringify(none.body)).toBe(409)
    expect(none.body.error.issues).toEqual([{ path: REPLY_ISSUE, message: REFUSED_IT }])
    expect(await admin('SELECT id FROM "Thread" WHERE "tenantId" = $1 AND "recordType" = $2 AND "recordId" = $3', [world.tenantId, fresh.type, fresh.id])).toEqual([])
    expect(await postsBy(world.people.buyer.id)).toBe(before.posts)
  })

  it('brand B’s portal post answering brand A’s message is refused in the same words; nothing is written in either thread', async () => {
    const orderA = await idOf('SalesOrder', 'SEED-SO-0001')
    const orderB = await idOf('SalesOrder', 'SEED-SO-B001')
    const { mail } = await officeWrites('SalesOrder', orderA)
    const [threadA, threadB] = [await threadIdOf('SalesOrder', orderA), await threadIdOf('SalesOrder', orderB)]
    // The control: brand B opens its own order, so its refusal below is about brand A's message, never about the record.
    expect((await thread(beta, 'SalesOrder', orderB)).status).toBe(200)
    const before = { a: await messagesOf(threadA), b: await messagesOf(threadB), posts: await postsBy(betaId) }
    const body = 'Made-up pt-s S.2: brand B answers a message it never had.'
    // On its own order: brand A's message is not of this conversation, and never brand B's to read — the same neutral words.
    const refused = await post(beta, 'SalesOrder', orderB, { body, replyToMessageId: mail }, newId())
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    expect(refused.body.error).toMatchObject({ code: 'conflict', message: REFUSED_IT, issues: [{ path: REPLY_ISSUE, message: REFUSED_IT }] })
    expect(JSON.stringify(refused.body)).not.toMatch(/Seed Owner|ships next week|SEED-SO-0001|SEED-PO-77/)
    // On brand A's order: not found, as if it did not exist.
    expect((await post(beta, 'SalesOrder', orderA, { body, replyToMessageId: mail }, newId())).status).toBe(404)
    expect({ a: await messagesOf(threadA), b: await messagesOf(threadB), posts: await postsBy(betaId) }).toEqual(before)
    expect(await admin('SELECT id FROM "Message" WHERE "tenantId" = $1 AND "bodyText" = $2', [world.tenantId, body])).toEqual([])
  })

  it('the post’s answer quotes what it answers, as the read does: no authorId, no audience, mine for the writer', async () => {
    const order = await idOf('SalesOrder', 'SEED-SO-0001')
    const { mail } = await officeWrites('SalesOrder', order)
    // The buyer asks; then answers our mail; then answers its own question.
    const asked = await post(buyer, 'SalesOrder', order, { body: 'Made-up pt-s S.4: can the zip be red?' }, newId())
    expect(asked.status, JSON.stringify(asked.body)).toBe(201)
    const toMail = await post(buyer, 'SalesOrder', order, { body: 'Made-up pt-s S.4: thanks, noted.', replyToMessageId: mail }, newId())
    const key = newId()
    const toOwn = await post(buyer, 'SalesOrder', order, { body: 'Made-up pt-s S.4: and the lining blue.', replyToMessageId: asked.body.message.id }, key)
    for (const answer of [toMail, toOwn]) {
      expect(answer.status, JSON.stringify(answer.body)).toBe(201)
      expect(answer.body.message.replyTo, answer.body.message.id).not.toHaveProperty('authorId')
      expect(answer.body.message.replyTo, answer.body.message.id).not.toHaveProperty('audience')
      expect(answer.body.message.corrects ?? null).toBeNull()
    }
    expect(toMail.body.message.replyTo).toMatchObject({ id: mail, authorKind: 'USER', authorName: 'Seed Owner', excerpt: 'Your order is confirmed; it ships next week.', mine: false, fileCount: 0, firstFile: null })
    expect(toOwn.body.message.replyTo).toMatchObject({ id: asked.body.message.id, authorKind: 'PARTY', authorName: 'Seed Portal Buyer', excerpt: 'Made-up pt-s S.4: can the zip be red?', mine: true, fileCount: 0, firstFile: null })

    // As the read does: the read's quote of the same message is the answer's, field for field.
    const page = await thread(buyer, 'SalesOrder', order, '?limit=200')
    expect(page.status, JSON.stringify(page.body)).toBe(200)
    const read = (body: Json, id: string): Json => (body.messages as Json[]).find((message) => message.id === id)!
    expect(read(page.body, toMail.body.message.id).replyTo).toEqual(toMail.body.message.replyTo)
    expect(read(page.body, toOwn.body.message.id).replyTo).toEqual(toOwn.body.message.replyTo)
    // "mine" is the writer's own: a colleague of the same customer reads the same quote as not theirs.
    const asViewer = await thread(viewer, 'SalesOrder', order, '?limit=200')
    expect(read(asViewer.body, toOwn.body.message.id).replyTo).toMatchObject({ id: asked.body.message.id, mine: false })

    // The same request again (its Idempotency-Key): no second message, the same quote. The same key answering another message is
    // another request: refused (409), nothing written.
    const count = await messagesOf(toOwn.body.thread.id)
    const again = await post(buyer, 'SalesOrder', order, { body: 'Made-up pt-s S.4: and the lining blue.', replyToMessageId: asked.body.message.id }, key)
    expect(again.status, JSON.stringify(again.body)).toBe(201)
    expect(again.body.message).toMatchObject({ id: toOwn.body.message.id, replyTo: toOwn.body.message.replyTo })
    const reused = await post(buyer, 'SalesOrder', order, { body: 'Made-up pt-s S.4: and the lining blue.', replyToMessageId: mail }, key)
    expect(reused.status, JSON.stringify(reused.body)).toBe(409)
    expect(await messagesOf(toOwn.body.thread.id)).toBe(count)
  })

  it('a portal post naming correctsMessageId is refused (unknown key)', async () => {
    const order = await idOf('SalesOrder', 'SEED-SO-0001')
    const { mail } = await officeWrites('SalesOrder', order)
    const body = 'Made-up pt-s S.1: a correction the portal never sends.'
    // Even of a message shared with the customer: a portal person answers, never corrects (the strict input refuses the key).
    const refused = await post(buyer, 'SalesOrder', order, { body, correctsMessageId: mail }, newId())
    expect(refused.status, JSON.stringify(refused.body)).toBe(400)
    expect(refused.body.error.code).toBe('validation_failed')
    expect(JSON.stringify(refused.body.error.issues)).toContain('correctsMessageId')
    expect(await admin('SELECT id FROM "Message" WHERE "tenantId" = $1 AND "bodyText" = $2', [world.tenantId, body])).toEqual([])
  })
})
// ── end pt-s ──
