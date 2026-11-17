import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { callerFor, command, type CommandCaller } from '../../core/command'
import { addTenant, addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { systemContext } from '../outbox/system'
import { defineHandler, dispatchEvent } from '../outbox/dispatch'
import { RECORD_RULES } from '../portal/notifications/rules/records'
import { useThreadRecords, type RecordScope } from '../threads/records'
import { deliverOutbound, deliverWhenDue, emailSendHandler, sendEmail, threadMailBuilder } from './outbound'

/**
 * B-TH-048 (threads plan TH-3, thread-G08, feature T7-F06; Owner decision 6): undo send, on the local stack with the app's
 * real routes and sessions. A mail from a record's thread waits 10 seconds (EmailOutbound.sendAfter) with its message held
 * (no customer reads it); its sender takes it back in that time (POST …/emails/:emailId/undo → WITHDRAWN, the text back);
 * the worker's job waits until sendAfter and never sends a mail taken back; a portal notice waits for the mail to leave. The
 * tests read the release time: the worker runs on clocks set before and after it. `Quote` is a made-up record type with a
 * party. Run with `node scripts/factory/run-pg-tests.mjs undo-send`.
 */

let h: Harness
let tenant: TestTenant
let sales: Browser
let colleague: Browser
let owner: Browser
let salesId: string
const party = newId()
const otherParty = newId()
const quote = newId()

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const first = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const system = (): CommandCaller => callerFor(h.database, systemContext(tenant.id, newId()))
const send = (browser: Browser, body: Json) => browser.post(`/threads/Quote/${quote}/emails`, body)
const undo = (browser: Browser, emailId: string, recordId = quote) => browser.post(`/threads/Quote/${recordId}/emails/${emailId}/undo`, {})
const outboundOf = (id: string) => first(`SELECT * FROM "EmailOutbound" WHERE id = $1`, [id])
const at = (base: Date, ms: number) => ({ now: () => new Date(base.getTime() + ms) })
const mailsTo = (address: string) => h.ses.mails.filter((mail) => mail.to.includes(address))
/** What a portal session of a party reads of the quote's thread (the database's partner filter). */
const partnerReads = async (partyId: string) => {
  const thread = await first(`SELECT id FROM "Thread" WHERE "recordId" = $1`, [quote])
  return h.database.withScope({ audience: 'partner', tenantId: tenant.id, actorId: newId(), partyId }, (client) => client.message.findMany({ where: { threadId: thread.id }, select: { id: true } }))
}

async function queuedEvent(outboundId: string): Promise<EventEnvelope> {
  const row = await first(`SELECT * FROM "OutboxEvent" WHERE type = 'email.queued' AND subject = $1`, [outboundId])
  return { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: toUtcIso(row.occurredAt), payload: row.payload }
}

beforeAll(async () => {
  h = await startHarness('undo_send')
  tenant = await addTenant(h, 'undo-a')
  const companyId = tenant.companies[0]!.id
  useThreadRecords({
    Quote: async (client, id): Promise<RecordScope | null> => (id === quote && (await client.company.findUnique({ where: { id: companyId }, select: { id: true } })) ? { companyId, siteId: null, partyId: party } : null),
  })
  // The company's CONVERSATION identity on the tenant's FAKE mail account (verified).
  const account = (await first(`SELECT "accountId" FROM "EmailIdentity" WHERE "tenantId" = $1 LIMIT 1`, [tenant.id])).accountId
  await admin(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'talk.undo-a.example.com', 'noreply@talk.undo-a.example.com', 'Undo C1', 'reply.talk.undo-a.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), tenant.id, companyId, account],
  )
  const seller = await addUser(h, tenant, { email: 'sara.sales@undo-a.example.com', role: 'sales' })
  salesId = seller.id
  sales = new Browser(h.app)
  await sales.signIn('undo-a', seller.email, seller.password)
  await enrolTotp(h, sales)
  const other = await addUser(h, tenant, { email: 'carlo.sales@undo-a.example.com', role: 'sales' })
  colleague = new Browser(h.app)
  await colleague.signIn('undo-a', other.email, other.password)
  await enrolTotp(h, colleague)
  const boss = await addUser(h, tenant, { email: 'owner@undo-a.example.com', role: 'owner' })
  owner = new Browser(h.app)
  await owner.signIn('undo-a', boss.email, boss.password)
  await enrolTotp(h, owner)
}, 120_000)

afterAll(async () => {
  useThreadRecords(undefined)
  await h?.close()
}, 60_000)

describe('a thread mail waits 10 seconds', () => {
  it('the answer says until when it can be taken back; the mail, its event and its held message carry the release time', async () => {
    const answer = await send(sales, { to: ['buyer@customer-a.example.com'], subject: 'Taglie', body: 'Buongiorno, ecco le taglie.' })
    expect(answer.status, JSON.stringify(answer.body)).toBe(201)
    const row = await outboundOf(answer.body.email.id)
    const sendAfter = new Date(row.queuedAt.getTime() + 10_000)
    expect(row.sendAfter.toISOString()).toBe(sendAfter.toISOString())
    expect(answer.body.email).toMatchObject({ status: 'QUEUED', sendAfter: sendAfter.toISOString(), undoUntil: sendAfter.toISOString(), sentById: salesId, withdrawnAt: null, withdrawnById: null })
    expect((await first(`SELECT held FROM "Message" WHERE id = $1`, [answer.body.messageId])).held).toBe(true)
    expect((await queuedEvent(row.id)).payload).toMatchObject({ outboundId: row.id, sendAfter: sendAfter.toISOString() })
    // The record's mail list and the delivery state say the same ("Sending… · Undo").
    const listed = (await sales.get(`/threads/Quote/${quote}/emails`)).body.emails.find((email: Json) => email.id === row.id)
    expect(listed).toMatchObject({ status: 'QUEUED', undoUntil: sendAfter.toISOString() })
    const delivery = (await sales.get(`/email/delivery-status?recordType=Quote&recordId=${quote}`)).body.messages.find((entry: Json) => entry.outboundId === row.id)
    expect(delivery).toMatchObject({ state: 'WAITING', undoUntil: sendAfter.toISOString(), withdrawnAt: null })
  })

  it('W20 the customer reads nothing of it until it leaves; the worker claims it only after sendAfter, then the message is released', async () => {
    const answer = await send(sales, { to: ['wait@customer-a.example.com'], body: 'Arriva tra poco.' })
    const id = answer.body.email.id as string
    const row = await outboundOf(id)
    expect((await partnerReads(party)).map((message) => message.id)).not.toContain(answer.body.messageId)
    // Before its time: no claim, no try, nothing sent.
    expect(await deliverWhenDue(h.email, system(), id, { retry: true, clock: at(row.queuedAt, 9_000), build: threadMailBuilder(h.email, system()) })).toBe('waiting')
    // The modules' own call says 'retry' (it never meets a mail that waits: theirs leave at once).
    expect(await deliverOutbound(h.email, system(), id, { retry: true, clock: at(row.queuedAt, 9_000), build: threadMailBuilder(h.email, system()) })).toBe('retry')
    expect(await outboundOf(id)).toMatchObject({ status: 'QUEUED', attempts: 0 })
    expect(mailsTo('wait@customer-a.example.com')).toHaveLength(0)
    // The worker's handler run early waits the rest (here a clock it moves) and sends it once.
    let now = row.queuedAt.getTime() + 4_000
    const waited: number[] = []
    const handler = emailSendHandler(() => h.email, { clock: { now: () => new Date(now) }, sleep: async (ms) => { waited.push(ms); now += ms } })
    await handler.handle(await queuedEvent(id), { caller: system(), attempt: 1 })
    expect(waited).toEqual([6_050])
    expect(await outboundOf(id)).toMatchObject({ status: 'SENT', attempts: 1 })
    expect(mailsTo('wait@customer-a.example.com')).toHaveLength(1)
    expect((await first(`SELECT held FROM "Message" WHERE id = $1`, [answer.body.messageId])).held).toBe(false)
    expect((await partnerReads(party)).map((message) => message.id)).toContain(answer.body.messageId)
    expect((await partnerReads(otherParty)).map((message) => message.id)).not.toContain(answer.body.messageId)
  })

  it('the dispatcher gives the worker’s job the rest of the window as its delay; a mail without a window runs at once', async () => {
    const added: Json[] = []
    const kit = { prefix: 'undo', add: async (_queue: string, _name: string, _data: unknown, options: Json) => void added.push(options) }
    const handler = emailSendHandler(() => h.email)
    const base = { eventId: newId(), type: 'email.queued', version: 1, context: 'email', tenantId: tenant.id, companyId: null, siteId: null, subject: newId(), correlationId: newId(), causationId: null, source: 'factory-api', occurredAt: toUtcIso(new Date()) } as const
    const sendAfter = new Date(Date.now() + 10_000).toISOString()
    await dispatchEvent({ ...base, payload: { outboundId: newId(), threadId: newId(), messageId: newId(), sendAfter } } as unknown as EventEnvelope, { kit: kit as never, handlers: [handler] })
    await dispatchEvent({ ...base, eventId: newId(), payload: { outboundId: newId(), threadId: newId(), messageId: newId() } } as unknown as EventEnvelope, { kit: kit as never, handlers: [handler] })
    expect(added[0]!.delay).toBeGreaterThan(9_000)
    expect(added[0]!.delay).toBeLessThanOrEqual(10_000)
    expect(added[1]!.delay).toBeUndefined()
    // Any other handler is untouched.
    const plain = defineHandler({ name: 'test.plain', events: ['email.queued'], async handle() {} })
    await dispatchEvent({ ...base, eventId: newId(), payload: { outboundId: newId(), threadId: newId(), messageId: newId(), sendAfter } } as unknown as EventEnvelope, { kit: kit as never, handlers: [plain] })
    expect(added[2]!.delay).toBeUndefined()
  })
})

describe('taking a mail back', () => {
  it('its sender takes it back in the window: WITHDRAWN with when and by whom, the text back for the composer, never sent, never seen by the customer', async () => {
    const answer = await send(sales, { to: ['oops@customer-a.example.com'], cc: ['copy@customer-a.example.com'], subject: 'Prezzo sbagliato', body: 'Il prezzo è 10.' })
    const id = answer.body.email.id as string
    const taken = await undo(sales, id)
    expect(taken.status, JSON.stringify(taken.body)).toBe(200)
    expect(taken.body.email).toMatchObject({ id, status: 'WITHDRAWN', withdrawnById: salesId, undoUntil: null })
    expect(taken.body.email.withdrawnAt).not.toBeNull()
    expect(taken.body.text).toEqual({ to: ['oops@customer-a.example.com'], cc: ['copy@customer-a.example.com'], bcc: [], subject: 'Prezzo sbagliato', body: 'Il prezzo è 10.', attachments: [] })
    const row = await outboundOf(id)
    expect(row).toMatchObject({ status: 'WITHDRAWN', withdrawnById: salesId, attempts: 0 })
    expect((await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'email.status_changed' AND subject = $1`, [id])).map((event) => event.payload.status)).toEqual(['WITHDRAWN'])
    expect((await admin(`SELECT action FROM "AuditLog" WHERE "recordType" = 'EmailOutbound' AND "recordId" = $1 AND action = 'email.takeBack'`, [id])).length).toBe(1)
    // The worker afterwards has nothing to send, and the customer never reads it.
    expect(await deliverOutbound(h.email, system(), id, { retry: true, clock: at(row.queuedAt, 60_000), build: threadMailBuilder(h.email, system()) })).toBe('settled')
    expect(mailsTo('oops@customer-a.example.com')).toHaveLength(0)
    expect((await first(`SELECT held FROM "Message" WHERE id = $1`, [answer.body.messageId])).held).toBe(true)
    expect((await partnerReads(party)).map((message) => message.id)).not.toContain(answer.body.messageId)
    // Its words: the thread's delivery state and the delivery log say "taken back".
    const delivery = (await sales.get(`/email/delivery-status?recordType=Quote&recordId=${quote}`)).body.messages.find((entry: Json) => entry.outboundId === id)
    expect(delivery).toMatchObject({ state: 'WITHDRAWN', undoUntil: null, withdrawnAt: expect.any(String) })
    const log = await owner.get('/email/delivery?state=WITHDRAWN')
    expect(log.status, JSON.stringify(log.body)).toBe(200)
    expect(log.body.mails.map((mail: Json) => [mail.id, mail.state, mail.status])).toContainEqual([id, 'WITHDRAWN', 'WITHDRAWN'])
    expect(log.body.counts.WITHDRAWN).toBeGreaterThanOrEqual(1)
    // Again: the same answer, nothing changes.
    const again = await undo(sales, id)
    expect(again.status).toBe(200)
    expect(again.body.email).toMatchObject({ status: 'WITHDRAWN', withdrawnAt: taken.body.email.withdrawnAt })
  })

  it('refused in words: another person, a mail that left, a mail that did not go, a mail with no window; another record’s path finds nothing', async () => {
    const mine = (await send(sales, { to: ['late@customer-a.example.com'], body: 'Parte.' })).body.email.id as string
    const notYours = await undo(colleague, mine)
    expect(notYours.status).toBe(409)
    expect(notYours.body.error.issues[0]).toEqual({ path: 'refusal/NOT_YOURS', message: 'Only the person who sent this mail can undo the send.' })
    expect((await undo(sales, mine, newId())).status).toBe(404)

    // Left: claimed and sent after its window.
    const row = await outboundOf(mine)
    expect(await deliverOutbound(h.email, system(), mine, { retry: true, clock: at(row.queuedAt, 11_000), build: threadMailBuilder(h.email, system()) })).toBe('sent')
    const left = await undo(sales, mine)
    expect(left.status).toBe(409)
    expect(left.body.error.issues[0]).toEqual({ path: 'refusal/LEFT', message: 'This mail has already left: the send can no longer be undone.' })

    // A try that failed and went back to QUEUED was claimed once: it may have reached the mail service.
    const tried = (await send(sales, { to: ['retry@customer-a.example.com'], body: 'Riprova.' })).body.email.id as string
    h.ses.failNext = { httpStatus: 503, message: 'Service unavailable' }
    const triedRow = await outboundOf(tried)
    expect(await deliverOutbound(h.email, system(), tried, { retry: true, clock: at(triedRow.queuedAt, 11_000), build: threadMailBuilder(h.email, system()) })).toBe('retry')
    expect(await outboundOf(tried)).toMatchObject({ status: 'QUEUED', attempts: 1 })
    expect((await undo(sales, tried)).body.error.issues[0].path).toBe('refusal/LEFT')

    // Did not go: refused at the claim (the address was blocked meanwhile).
    const blocked = (await send(sales, { to: ['blocked@customer-a.example.com'], body: 'Bloccata.' })).body.email.id as string
    await admin(`INSERT INTO "Suppression" (id, "tenantId", address, reason, at) VALUES ($1, $2, 'blocked@customer-a.example.com', 'MANUAL', now())`, [newId(), tenant.id])
    const blockedRow = await outboundOf(blocked)
    expect(await deliverOutbound(h.email, system(), blocked, { retry: true, clock: at(blockedRow.queuedAt, 11_000), build: threadMailBuilder(h.email, system()) })).toBe('failed')
    expect((await undo(sales, blocked)).body.error.issues[0]).toEqual({ path: 'refusal/NOT_SENT', message: 'This mail did not go: there is nothing to undo.' })

    // No window: a module's document mail leaves at once (it never waits, and is not taken back).
    const sender = { userId: salesId, name: 'sara sales', email: 'sara.sales@undo-a.example.com' }
    const office = callerFor(h.database, { audience: 'office', tenantId: tenant.id, actorId: salesId, grants: [], requestId: newId() })
    const { result } = await command(office, { name: 'test.documentMail', input: {} }, async (tools) => {
      const sent = await sendEmail(tools, { record: { type: 'Quote', id: quote }, sender, to: ['doc@customer-a.example.com'], subject: 'Documento', body: 'In allegato.' })
      return { outboundId: sent.outbound.id, messageId: sent.messageId }
    })
    expect(await outboundOf(result.outboundId)).toMatchObject({ sendAfter: null })
    expect((await first(`SELECT held FROM "Message" WHERE id = $1`, [result.messageId])).held).toBe(false)
    expect((await undo(sales, result.outboundId)).body.error.issues[0]).toEqual({ path: 'refusal/NO_WINDOW', message: 'This mail went at once, without the 10 seconds to undo the send.' })
  })
})

describe('the customer’s news waits for the mail', () => {
  const rule = (name: string) => RECORD_RULES.find((entry) => entry.name === name)!
  const draftsOf = (name: string, payload: Json) => system().withClient((client) => rule(name).drafts({ tx: client as never, tenantId: tenant.id, now: new Date(), event: { payload } as never }, payload))

  it('no portal notice while the mail waits; one when it left; none for a mail taken back', async () => {
    const waiting = await send(sales, { to: ['news@customer-a.example.com'], body: 'Novità.' })
    const thread = await first(`SELECT id FROM "Thread" WHERE "recordId" = $1`, [quote])
    const posted = { threadId: thread.id, messageId: waiting.body.messageId, recordType: 'Quote', recordId: quote, direction: 'OUTBOUND', audience: 'PARTNER' }
    expect(await draftsOf('portalNews.messagePosted', posted)).toEqual([])
    const id = waiting.body.email.id as string
    const row = await outboundOf(id)
    expect(await deliverOutbound(h.email, system(), id, { retry: true, clock: at(row.queuedAt, 11_000), build: threadMailBuilder(h.email, system()) })).toBe('sent')
    const left = await draftsOf('portalNews.mailLeft', { outboundId: id, threadId: thread.id, recordType: 'Quote', recordId: quote, status: 'SENT' })
    expect(left.map((draft) => [draft.partyId, draft.anchor, draft.messageKey])).toEqual([[party, `message:${waiting.body.messageId}`, 'portal.message.posted']])
    // Its later delivery is no second notice.
    expect(await draftsOf('portalNews.mailLeft', { outboundId: id, threadId: thread.id, recordType: 'Quote', recordId: quote, status: 'DELIVERED' })).toEqual([])

    const takenBack = await send(sales, { to: ['news@customer-a.example.com'], body: 'Ripensamento.' })
    await undo(sales, takenBack.body.email.id)
    expect(await draftsOf('portalNews.messagePosted', { ...posted, messageId: takenBack.body.messageId })).toEqual([])
    expect(await draftsOf('portalNews.mailLeft', { outboundId: takenBack.body.email.id, threadId: thread.id, recordType: 'Quote', recordId: quote, status: 'WITHDRAWN' })).toEqual([])
  })
})
