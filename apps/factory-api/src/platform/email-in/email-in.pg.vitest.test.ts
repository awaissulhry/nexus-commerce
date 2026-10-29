import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { MAX_RAW_BYTES } from '@nexus/factory-domain/email-in/rules'
import { FakeMailBucket } from '../../adapters/ses-inbound/fake'
import { inboundS3Store } from '../../adapters/ses-inbound/s3'
import { callerFor, command, type CommandCaller } from '../../core/command'
import { addTenant, addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { createGateway } from '../gateway/gateway'
import { processReceipt } from '../inbound/process'
import { inboundRuntime, useInbound } from '../inbound/providers'
import { fakeSignatureHeaders } from '../inbound/verifiers'
import { systemContext } from '../outbox/system'
import { SECRET_PURPOSES, storeSecret } from '../secrets/store'
import { useThreadRecords, type RecordResolver, type RecordScope } from '../threads/records'
import { ensureThread, writeMessage } from '../threads/threads'
import { fetchInbound } from './fetch'
import { createEmailInRuntime, useEmailIn, type EmailInRuntime } from './service'
import { sortInbound } from './sort'
import { rawMail, receivedNotificationBody, type RawAttachment, type RawMailInput, type ReceivedInput } from './testing'

/**
 * Email in on the local stack, with the app's real routes and sessions (the office sign-in harness): a throwaway
 * PostgreSQL 17 database from the migrations (row-level security and the guard triggers are real), the gateway on the
 * local Redis, FAKE SES accounts whose receiving bucket is in memory (FakeMailBucket) and whose S3 adapter would refuse
 * to open a client: nothing reaches AWS. SES's notification goes through the real inbound route and ledger job; the
 * worker's two steps (fetch, sort) run as the worker would. `Quote` is a made-up record type with a party; `Party` has
 * the thread resolver the parties module will bring. Run with `node scripts/factory/run-pg-tests.mjs email-in`.
 */

let h: Harness
let tenant: TestTenant
let tenantB: TestTenant
let triager: Browser
let triagerId: string
let planner: Browser
let triagerB: Browser
/** Sales over company C2 only: the mail of company C1's SES account is not theirs to sort. */
let triagerC2: Browser
let sesA: string
let sesB: string
let bucket: FakeMailBucket
let runtime: EmailInRuntime

const WEBHOOK_SECRET = 'whsec_made_up_for_email_in_tests_77a1'
const BUCKET = 'factory-inbound-test'
const REPLY = 'reply.in-a.example.com'
const PDF = Buffer.from('%PDF-1.7\n% made-up offer for the email-in tests\n')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x02])
const partyOne = newId()
const partyTwo = newId()
const partyB = newId()
let anna: string
const quoteOne = newId()
const quoteTwo = newId()
const quoteClosed = newId()
const quoteBare = newId()
const quoteB = newId()
/** The made-up quotes: their company (by tenant) and party. */
let quotes: Map<string, { companyId: string; partyId: string | null }>

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const first = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const system = (tenantId = tenant.id): CommandCaller => callerFor(h.database, systemContext(tenantId, newId()))
const mailOf = (id: string) => first(`SELECT * FROM "InboundEmail" WHERE id = $1`, [id])
const fetchCalls = (accountId = sesA) => admin(`SELECT status FROM "IntegrationCall" WHERE operation = 'mail.fetch_inbound' AND "accountId" = $1`, [accountId])
const eventsOf = async (inboundEmailId: string) => (await admin(`SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id`, [inboundEmailId])).map((row) => row.type as string)

/** A FAKE SES account of a company, with the webhook secret and its receiving bucket. */
async function sesAccount(tenantId: string, companyId: string): Promise<string> {
  const id = newId()
  await command(callerFor(h.database, { audience: 'office', tenantId, actorId: newId(), grants: [], requestId: newId() }), { name: 'integration.createAccount', input: { id } }, async (tools) => {
    const webhook = await storeSecret(tools, h.secrets, { purpose: SECRET_PURPOSES.webhook, plaintext: WEBHOOK_SECRET })
    await tools.tx.integrationAccount.create({
      data: { id, companyId, provider: 'SES', code: `ses-in-${id.slice(-12)}`, label: 'Mail in (fake)', mode: 'FAKE', webhookSecretId: webhook.id, settings: { inboundBucket: BUCKET }, rateLimitPerMinute: 6000, rateLimitBurst: 1000 },
      select: { id: true },
    })
    tools.audit({ recordType: 'IntegrationAccount', recordId: id })
    return null
  })
  return id
}

/** A party with its contacts, written in the tenant's office scope. Answers the contacts' ids by address. */
async function party(tenantId: string, id: string, code: string, emails: readonly string[]): Promise<Map<string, string>> {
  const contacts = new Map(emails.map((email) => [email, newId()]))
  await h.database.withScope({ audience: 'office', tenantId, actorId: newId() }, async (client) => {
    await client.party.create({ data: { id, code, kind: 'ORGANISATION', legalName: `Made-up ${code} S.r.l.`, roles: ['CUSTOMER'] } })
    for (const [email, contactId] of contacts) await client.partyContact.create({ data: { id: contactId, partyId: id, name: `Contact ${email.split('@')[0]}`, email } })
  })
  return contacts
}

/** A record's thread (made in a command, as the email-out step would), with OUTBOUND mails of our own. */
async function openThread(record: string, ourMessageIds: readonly string[] = [], tenantId = tenant.id): Promise<{ id: string; token: string }> {
  const { result } = await command(system(tenantId), { name: 'threads.testOpen', input: { record } }, async (tools) => {
    const { thread } = await ensureThread(tools, { type: 'Quote', id: record }, null)
    tools.audit({ action: 'threads.testOpen', recordType: 'Thread', recordId: thread.id })
    for (const emailMessageId of ourMessageIds) {
      await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'EMAIL', author: { kind: 'SYSTEM', id: null, name: 'Test' }, bodyText: 'Ecco il preventivo.', emailMessageId })
    }
    return thread.id
  })
  const { replyToken } = await first(`SELECT "replyToken" FROM "Thread" WHERE id = $1`, [result])
  return { id: result, token: replyToken }
}

/** Posts an SES notification to an account's inbound route (signed as a FAKE account's provider) and processes it. */
async function notify(tenantId: string, accountId: string, body: string, eventId: string): Promise<{ status: string; receiptId: string }> {
  const response = await h.app.inject({
    method: 'POST',
    url: `/inbound/ses/${tenantId}/${accountId}`,
    payload: body,
    headers: { 'content-type': 'application/json', ...fakeSignatureHeaders(WEBHOOK_SECRET, body, h.clock.now(), { id: eventId, type: 'ses.notification' }) },
  })
  expect(response.statusCode, response.body).toBe(200)
  const answer = response.json() as { status: string; receiptId: string }
  if (answer.status === 'received') expect(await processReceipt(system(tenantId), answer.receiptId, newId(), inboundRuntime())).toBe('processed')
  return answer
}

type Delivery = Omit<RawMailInput, 'from'> & Pick<ReceivedInput, 'verdicts' | 'destination'> & { readonly from: string; readonly tenantId?: string; readonly accountId?: string }

/** SES receives a mail: its raw bytes in the bucket, its notification through the inbound route. Answers the row and the body. */
async function receive(mail: Delivery): Promise<{ row: Json; body: string; sesMessageId: string }> {
  const sesMessageId = `ses${newId().replace(/-/g, '')}`
  const location = { bucket: BUCKET, key: `inbound/${sesMessageId}` }
  bucket.put(location, rawMail(mail))
  const body = receivedNotificationBody({
    snsMessageId: `sns-${sesMessageId}`,
    sesMessageId,
    ...location,
    from: mail.from,
    to: mail.to,
    ...(mail.cc ? { cc: mail.cc } : {}),
    ...(mail.destination ? { destination: mail.destination } : {}),
    subject: mail.subject,
    ...(mail.messageId ? { messageId: mail.messageId } : {}),
    ...(mail.verdicts ? { verdicts: mail.verdicts } : {}),
  })
  await notify(mail.tenantId ?? tenant.id, mail.accountId ?? sesA, body, `sns-${sesMessageId}`)
  return { row: await first(`SELECT * FROM "InboundEmail" WHERE "sesMessageId" = $1`, [sesMessageId]), body, sesMessageId }
}

/** The worker's two steps for a mail, as its handlers would run them. */
async function work(id: string, tenantId = tenant.id): Promise<Json> {
  await fetchInbound(runtime, system(tenantId), id)
  await sortInbound(system(tenantId), id)
  return mailOf(id)
}

/** Receives and works a mail. */
const deliver = async (mail: Delivery): Promise<Json> => work((await receive(mail)).row.id, mail.tenantId)

const offer: RawAttachment = { filename: 'offerta.pdf', contentType: 'application/pdf', content: PDF }

beforeAll(async () => {
  h = await startHarness('email_in')
  tenant = await addTenant(h, 'in-a', 2)
  tenantB = await addTenant(h, 'in-b')
  const [c1, c2] = tenant.companies
  quotes = new Map([
    [quoteOne, { companyId: c1!.id, partyId: partyOne }],
    [quoteClosed, { companyId: c1!.id, partyId: partyOne }],
    [quoteTwo, { companyId: c2!.id, partyId: partyTwo }],
    [quoteBare, { companyId: c1!.id, partyId: null }],
    [quoteB, { companyId: tenantB.companies[0]!.id, partyId: partyB }],
  ])
  useThreadRecords({ Quote: quoteResolverOf(), Party: partyResolverOf() })
  useInbound({ secrets: h.secrets, clock: h.clock, environment: 'test' })
  for (const owner of [tenant, tenantB]) {
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), owner.id])
  }
  sesA = await sesAccount(tenant.id, c1!.id)
  sesB = await sesAccount(tenantB.id, tenantB.companies[0]!.id)
  bucket = new FakeMailBucket()
  const gateway = createGateway({ environment: 'test', redis: h.redis, prefix: h.redisPrefix, secrets: h.secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  // A LIVE or SANDBOX account never reaches S3 from a test: its client refuses before anything is sent.
  const neverS3 = inboundS3Store({
    clientFor: () => {
      throw new Error('The email-in tests never call S3; use a FAKE account.')
    },
  })
  runtime = createEmailInRuntime({ gateway, fake: bucket, s3: neverS3, files: h.files })
  useEmailIn(runtime)

  anna = (await party(tenant.id, partyOne, 'P1', ['anna@buyer-one.example.com'])).get('anna@buyer-one.example.com')!
  await party(tenant.id, partyTwo, 'P2', ['luca@buyer-two.example.com'])
  await party(tenantB.id, partyB, 'PB', ['anna@buyer-one.example.com'])

  const triage = await addUser(h, tenant, { email: 'sara.sales@in-a.example.com', role: 'sales' })
  triagerId = triage.id
  triager = new Browser(h.app)
  await triager.signIn('in-a', triage.email, triage.password)
  await enrolTotp(h, triager)
  const plan = await addUser(h, tenant, { email: 'piero.planner@in-a.example.com', role: 'planner' })
  planner = new Browser(h.app)
  await planner.signIn('in-a', plan.email, plan.password)
  const other = await addUser(h, tenant, { email: 'carla.sales@in-a.example.com' })
  await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: other.id }, async (client) => {
    const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant.id, key: 'sales' } }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId: other.id, roleId: role.id, allCompanies: false, companyIds: [c2!.id], validFrom: new Date('2026-10-28T09:00:00.000Z') } })
  })
  triagerC2 = new Browser(h.app)
  await triagerC2.signIn('in-a', other.email, other.password)
  await enrolTotp(h, triagerC2)
  const salesB = await addUser(h, tenantB, { email: 'bruno.sales@in-b.example.com', role: 'sales' })
  triagerB = new Browser(h.app)
  await triagerB.signIn('in-b', salesB.email, salesB.password)
  await enrolTotp(h, triagerB)
}, 90_000)

afterAll(async () => {
  useThreadRecords(undefined)
  useInbound(undefined)
  useEmailIn(undefined)
  await h?.close()
}, 60_000)

describe('a reply by its reply address (COL-020, COL-026, COL-025)', () => {
  let thread: { id: string; token: string }
  let mailId: string
  let sesMessageId: string
  let body: string

  it('SES says it arrived: one row RECEIVED with the verdicts, nothing read yet', async () => {
    thread = await openThread(quoteOne, ['<out-1@in-a.example.com>'])
    const received = await receive({
      from: '"Anna Esempio" <Anna@Buyer-One.example.com>',
      to: [`r-${thread.token}@${REPLY}`],
      subject: 'Re: Preventivo giacche',
      messageId: '<reply-1@buyer-one.example.com>',
      inReplyTo: '<out-1@in-a.example.com>',
      text: 'Buongiorno,\nconfermiamo. In allegato il PDF.',
      html:
        '<html><body><p onclick="steal()" style="color:#333;position:fixed">Buongiorno, <b>confermiamo</b>.</p>' +
        '<script>document.location="https://evil.example.net"</script><img src="https://track.example.net/p.gif"><img src="cid:logo-1"></body></html>',
      attachments: [offer, { filename: 'logo.png', contentType: 'image/png', content: PNG, contentId: 'logo-1' }, { filename: 'setup.exe', contentType: 'application/x-msdownload', content: Buffer.from('MZ') }],
    })
    ;({ sesMessageId, body } = received)
    mailId = received.row.id
    expect(received.row).toMatchObject({
      status: 'RECEIVED',
      companyId: tenant.companies[0]!.id,
      accountId: sesA,
      s3Bucket: BUCKET,
      fromAddress: 'anna@buyer-one.example.com',
      envelopeTo: [`r-${thread.token}@${REPLY}`],
      emailMessageId: '<reply-1@buyer-one.example.com>',
      spfVerdict: 'PASS',
      dmarcVerdict: 'PASS',
      virusVerdict: 'PASS',
      bodyText: null,
      attempts: 0,
    })
    expect(await eventsOf(mailId)).toEqual(['email.inbound_received'])
    expect(await fetchCalls()).toEqual([])
  })

  it('the worker reads it through the gateway (one ledger row), sanitises it and stores the attachment it keeps', async () => {
    expect(await fetchInbound(runtime, system(), mailId)).toBe('fetched')
    expect(await fetchCalls()).toEqual([{ status: 'SUCCEEDED' }])
    const row = await mailOf(mailId)
    expect(row).toMatchObject({ status: 'FETCHED', attempts: 1, fromName: 'Anna Esempio', subject: 'Re: Preventivo giacche', inReplyTo: '<out-1@in-a.example.com>' })
    expect(row.bodyText).toBe('Buongiorno,\nconfermiamo. In allegato il PDF.')
    expect(row.bodyHtml).not.toMatch(/script|onclick|steal|evil|position|\ssrc=/i)
    expect(row.bodyHtml).toContain('<p style="color:#333">Buongiorno, <b>confermiamo</b>.</p>')
    expect(row.bodyHtml).toContain('data-remote-src="https://track.example.net/p.gif"')
    // The inline logo is part of the HTML (multipart/related): it comes first in the mail and is no record file.
    expect(row.attachments.map((part: Json) => [part.name, part.kept, part.reason ?? null, part.fileId ?? null])).toEqual([
      ['logo.png', false, 'inline', null],
      ['offerta.pdf', true, null, null],
      ['setup.exe', false, 'type_not_allowed', null],
    ])
    expect(await admin(`SELECT operation FROM "IntegrationCall" WHERE operation = 'files.put' AND "requestSummary"->>'key' = $1`, [row.attachments[1].storageKey])).toHaveLength(1)
    expect(await eventsOf(mailId)).toEqual(['email.inbound_received', 'email.inbound_fetched'])
  })

  it('sorting joins it to the thread as ONE INBOUND message, its file shared with the party', async () => {
    expect(await sortInbound(system(), mailId)).toBe('MATCHED')
    const row = await mailOf(mailId)
    expect(row).toMatchObject({ status: 'MATCHED', matchedBy: 'TOKEN', threadId: thread.id, senderPartyId: partyOne, senderContactId: anna, heldReason: null })
    const message = await first(`SELECT * FROM "Message" WHERE id = $1`, [row.messageId])
    expect(message).toMatchObject({
      threadId: thread.id,
      direction: 'INBOUND',
      audience: 'PARTNER',
      channel: 'EMAIL',
      partyId: partyOne,
      authorKind: 'PARTY',
      authorId: anna,
      authorName: 'Anna Esempio',
      bodyText: 'Buongiorno,\nconfermiamo. In allegato il PDF.',
      bodyHtml: row.bodyHtml,
      emailMessageId: '<reply-1@buyer-one.example.com>',
    })
    expect(message.attachmentFileIds).toEqual([row.attachments[1].fileId])
    const file = await first(`SELECT * FROM "StoredFile" WHERE id = $1`, [row.attachments[1].fileId])
    expect(file).toMatchObject({ recordType: 'Quote', recordId: quoteOne, kind: 'ATTACHMENT', originalName: 'offerta.pdf', contentType: 'application/pdf', status: 'AVAILABLE', partyId: partyOne, sha256: createHash('sha256').update(PDF).digest('hex') })
    expect(file.visibility).toBe('{OFFICE,PARTNER}')
    expect(await h.files.storage.read(system(), file.storeAccountId, file.storageKey, 1_000)).toEqual(PDF)
    expect(await eventsOf(mailId)).toEqual(['email.inbound_received', 'email.inbound_fetched', 'email.inbound_sorted'])
    expect((await admin(`SELECT type FROM "OutboxEvent" WHERE type = 'thread.message_posted' AND payload->>'messageId' = $1`, [message.id])).length).toBe(1)

    // The office reads it on the record's thread, sanitised.
    const read = await triager.get(`/threads/Quote/${quoteOne}`)
    expect(read.status).toBe(200)
    const shown = read.body.messages.find((entry: Json) => entry.id === message.id)
    expect(shown).toMatchObject({ direction: 'INBOUND', channel: 'EMAIL', body: 'Buongiorno,\nconfermiamo. In allegato il PDF.', attachments: [{ id: file.id, originalName: 'offerta.pdf' }] })
    expect(shown.bodyHtml).not.toMatch(/script/i)
  })

  it('the same notification again, or SES telling it twice, adds nothing: one row, one read, one message', async () => {
    expect((await notify(tenant.id, sesA, body, `sns-${sesMessageId}`)).status).toBe('duplicate')
    expect((await notify(tenant.id, sesA, body, `sns-${sesMessageId}-again`)).status).toBe('received')
    expect(await admin(`SELECT id FROM "InboundEmail" WHERE "sesMessageId" = $1`, [sesMessageId])).toHaveLength(1)
    expect(await fetchInbound(runtime, system(), mailId)).toBe('settled')
    expect(await sortInbound(system(), mailId)).toBe('settled')
    expect(await fetchCalls()).toHaveLength(1)
    expect(await admin(`SELECT id FROM "Message" WHERE "emailMessageId" = '<reply-1@buyer-one.example.com>'`)).toHaveLength(1)
    expect(await first(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'emailIn.receiveAgain' AND "recordId" = $1`, [mailId])).toEqual({ n: 1 })
  })

  it('a mail that is ours coming back (the same Message-ID as a thread message) is a duplicate', async () => {
    const row = await deliver({ from: 'anna@buyer-one.example.com', to: [`r-${thread.token}@${REPLY}`], subject: 'Preventivo', messageId: '<out-1@in-a.example.com>', text: 'loop' })
    expect(row).toMatchObject({ status: 'REJECTED', rejectReason: 'DUPLICATE', messageId: null })
    expect(await admin(`SELECT id FROM "Message" WHERE "emailMessageId" = '<out-1@in-a.example.com>'`)).toHaveLength(1)
  })
})

describe('a reply address at another domain', () => {
  it('names no thread: only the tenant reply domains carry tokens', async () => {
    const thread = await openThread(quoteOne)
    const row = await deliver({ from: 'anna@buyer-one.example.com', to: [`r-${thread.token}@elsewhere.example.org`], subject: 'Re', messageId: '<d1@buyer-one.example.com>', text: 'x', verdicts: { dmarc: 'GRAY' } })
    expect(row).toMatchObject({ status: 'TRIAGE', threadId: null, senderPartyId: partyOne, senderContactId: anna })
  })
})

describe('a reply by its headers', () => {
  it('In-Reply-To, else References, against our own mail find the thread', async () => {
    const thread = await openThread(quoteTwo, ['<out-2a@in-a.example.com>', '<out-2b@in-a.example.com>'])
    const byReply = await deliver({ from: 'luca@buyer-two.example.com', to: ['ordini@in-a.example.com'], subject: 'Re: offerta', messageId: '<h1@buyer-two.example.com>', inReplyTo: '<out-2b@in-a.example.com>', text: 'Va bene.' })
    expect(byReply).toMatchObject({ status: 'MATCHED', matchedBy: 'HEADERS', threadId: thread.id })
    const byReferences = await deliver({ from: 'luca@buyer-two.example.com', to: ['ordini@in-a.example.com'], subject: 'Re: offerta', messageId: '<h2@buyer-two.example.com>', references: ['<nobody@elsewhere.example.org>', '<out-2a@in-a.example.com>'], text: 'Ok.' })
    expect(byReferences).toMatchObject({ status: 'MATCHED', matchedBy: 'HEADERS', threadId: thread.id })
    // Their own earlier mail is no key: only what we sent is.
    const notOurs = await deliver({ from: 'luca@buyer-two.example.com', to: ['ordini@in-a.example.com'], subject: 'Re', messageId: '<h3@buyer-two.example.com>', inReplyTo: '<h1@buyer-two.example.com>', text: 'x', verdicts: { dmarc: 'GRAY' } })
    expect(notOurs).toMatchObject({ status: 'TRIAGE', threadId: null, senderPartyId: partyTwo })
  })
})

describe('the sender check (COL-022)', () => {
  let thread: { id: string; token: string }

  it('an unknown sender whose DMARC fails waits for a person, with the thread it named; its file stays on the mail', async () => {
    thread = await openThread(quoteOne)
    const row = await deliver({
      from: '"Amministrazione" <stranger@evil.example.net>',
      to: [`r-${thread.token}@${REPLY}`],
      subject: 'Nuove coordinate bancarie',
      messageId: '<spoof-1@evil.example.net>',
      text: 'Pagate sul nuovo IBAN.',
      attachments: [offer],
      verdicts: { dmarc: 'FAIL', spf: 'FAIL' },
    })
    expect(row).toMatchObject({ status: 'HELD', heldReason: 'DMARC_FAIL', threadId: thread.id, messageId: null, matchedBy: null })
    expect(await admin(`SELECT id FROM "Message" WHERE "emailMessageId" = '<spoof-1@evil.example.net>'`)).toEqual([])
    const file = await first(`SELECT * FROM "StoredFile" WHERE id = $1`, [row.attachments[0].fileId])
    expect(file).toMatchObject({ recordType: 'InboundEmail', recordId: row.id, partyId: null, companyId: tenant.companies[0]!.id })
    expect(file.visibility).toBe('{OFFICE}')
  })

  it('an unknown sender is held even when DMARC passes; a colleague at the contact company domain is known', async () => {
    const unknown = await deliver({ from: 'mallory@evil.example.net', to: [`r-${thread.token}@${REPLY}`], subject: 'Re', messageId: '<u1@evil.example.net>', text: 'Ciao' })
    expect(unknown).toMatchObject({ status: 'HELD', heldReason: 'UNKNOWN_SENDER', threadId: thread.id })
    const colleague = await deliver({ from: 'marta@buyer-one.example.com', to: [`r-${thread.token}@${REPLY}`], subject: 'Re', messageId: '<c1@buyer-one.example.com>', text: 'Confermo anche io.' })
    expect(colleague).toMatchObject({ status: 'MATCHED', matchedBy: 'TOKEN', threadId: thread.id, senderContactId: null })
    expect(await first(`SELECT "authorId", "authorName" FROM "Message" WHERE id = $1`, [colleague.messageId])).toEqual({ authorId: null, authorName: 'marta@buyer-one.example.com' })
  })

  it("a reply to a closed thread waits; a person releases it into that thread, its file copied onto the record", async () => {
    const closed = await openThread(quoteClosed)
    await admin(`UPDATE "Thread" SET status = 'CLOSED' WHERE id = $1`, [closed.id])
    const row = await deliver({ from: 'anna@buyer-one.example.com', to: [`r-${closed.token}@${REPLY}`], subject: 'Re', messageId: '<late-1@buyer-one.example.com>', text: 'Ancora una cosa.', attachments: [offer] })
    expect(row).toMatchObject({ status: 'HELD', heldReason: 'THREAD_CLOSED', threadId: closed.id })

    expect((await triager.post(`/email/inbound/${row.id}/release`, { version: row.version + 5 })).status).toBe(409)
    expect((await planner.post(`/email/inbound/${row.id}/release`, { version: row.version })).status).toBe(403)
    const released = await triager.post(`/email/inbound/${row.id}/release`, { version: row.version, reason: 'Checked with the customer by phone' })
    expect(released.status, JSON.stringify(released.body)).toBe(200)
    expect(released.body.mail).toMatchObject({ status: 'MATCHED', matchedBy: 'MANUAL', heldReason: null, threadId: closed.id, thread: { id: closed.id, recordType: 'Quote', recordId: quoteClosed, status: 'CLOSED' }, sortedById: triagerId })
    const after = await mailOf(row.id)
    const message = await first(`SELECT * FROM "Message" WHERE id = $1`, [after.messageId])
    expect(message).toMatchObject({ threadId: closed.id, direction: 'INBOUND', partyId: partyOne, authorId: anna, emailMessageId: '<late-1@buyer-one.example.com>' })
    const copy = await first(`SELECT * FROM "StoredFile" WHERE id = $1`, [message.attachmentFileIds[0]])
    expect(copy).toMatchObject({ recordType: 'Quote', recordId: quoteClosed, partyId: partyOne, sha256: createHash('sha256').update(PDF).digest('hex') })
    expect(copy.storageKey).not.toBe(row.attachments[0].storageKey)
    // The mail keeps its own copy, office only; a mail joined once is not released again.
    expect(await first(`SELECT "recordType", visibility::text FROM "StoredFile" WHERE id = $1`, [after.attachments[0].fileId])).toEqual({ recordType: 'InboundEmail', visibility: '{OFFICE}' })
    expect((await triager.post(`/email/inbound/${row.id}/release`, { version: after.version })).status).toBe(409)
    expect(await first(`SELECT reason FROM "AuditLog" WHERE action = 'emailIn.release' AND "recordId" = $1`, [row.id])).toEqual({ reason: 'Checked with the customer by phone' })
  })

  it('a virus is never read', async () => {
    const before = (await fetchCalls()).length
    const { row } = await receive({ from: 'x@virus.example.net', to: ['ordini@in-a.example.com'], subject: 'Fattura', messageId: '<v1@virus.example.net>', text: 'x', verdicts: { virus: 'FAIL' } })
    expect(row).toMatchObject({ status: 'REJECTED', rejectReason: 'VIRUS', bodyText: null })
    expect(await fetchInbound(runtime, system(), row.id)).toBe('settled')
    expect(await fetchCalls()).toHaveLength(before)
    expect(await eventsOf(row.id)).toEqual(['email.inbound_sorted'])
  })
})

describe('mail to sort (COL-023, A2 SCR-019)', () => {
  let waiting: Json

  it('a mail nothing matches waits in triage; only people with email.triage of the tenant see it', async () => {
    waiting = await deliver({
      from: '"Nuovo Cliente" <new.buyer@prospect.example.org>',
      to: ['ordini@in-a.example.com'],
      subject: 'Richiesta giacche',
      messageId: '<new-1@prospect.example.org>',
      html: '<p>Vorremmo 40 giacche.<script>x()</script></p>',
      attachments: [{ ...offer, filename: 'richiesta.pdf' }],
    })
    expect(waiting).toMatchObject({ status: 'TRIAGE', threadId: null, senderPartyId: null, bodyText: 'Vorremmo 40 giacche.' })

    expect((await planner.get('/email/inbound')).status).toBe(403)
    const list = await triager.get('/email/inbound')
    expect(list.status).toBe(200)
    const listed = list.body.mails.find((mail: Json) => mail.id === waiting.id)
    expect(listed).toMatchObject({ status: 'TRIAGE', from: { address: 'new.buyer@prospect.example.org', name: 'Nuovo Cliente' }, subject: 'Richiesta giacche', excerpt: 'Vorremmo 40 giacche.', attachmentCount: 1 })
    expect(list.body.mails.every((mail: Json) => ['TRIAGE', 'HELD', 'FAILED'].includes(mail.status))).toBe(true)

    const view = await triager.get(`/email/inbound/${waiting.id}`)
    expect(view.status).toBe(200)
    expect(view.body.mail).toMatchObject({ bodyHtml: '<p>Vorremmo 40 giacche.</p>', attachments: [{ name: 'richiesta.pdf', kept: true, skipReason: null, file: { originalName: 'richiesta.pdf', status: 'AVAILABLE' } }] })
    expect(JSON.stringify(view.body)).not.toMatch(/inbound\/ses|s3Key|storageKey|factory-inbound-test|r-[a-z2-7]{26}/)
    expect((await triagerB.get(`/email/inbound/${waiting.id}`)).status).toBe(404)
    // A person of another company of the tenant neither lists nor opens it (the SES account is company C1's).
    expect((await triagerC2.get(`/email/inbound/${waiting.id}`)).status).toBe(404)
    expect((await triagerC2.get('/email/inbound')).body.mails).toEqual([])
    expect((await triagerB.get('/email/inbound')).body.mails.map((mail: Json) => mail.id)).not.toContain(waiting.id)
  })

  it('a person assigns it to a record with a party: its thread gets the message, the file is copied onto the record', async () => {
    const stale = await triager.post(`/email/inbound/${waiting.id}/assign`, { recordType: 'Quote', recordId: quoteTwo, version: waiting.version - 1 })
    expect(stale.status).toBe(409)
    expect((await triager.post(`/email/inbound/${waiting.id}/assign`, { recordType: 'Quote', recordId: quoteBare, version: waiting.version })).status).toBe(409)
    expect((await triager.post(`/email/inbound/${waiting.id}/assign`, { recordType: 'Quote', recordId: quoteB, version: waiting.version })).status).toBe(404)
    expect((await planner.post(`/email/inbound/${waiting.id}/assign`, { recordType: 'Quote', recordId: quoteTwo, version: waiting.version })).status).toBe(403)

    const assigned = await triager.post(`/email/inbound/${waiting.id}/assign`, { recordType: 'Quote', recordId: quoteTwo, version: waiting.version })
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200)
    expect(assigned.body.mail).toMatchObject({ status: 'MATCHED', matchedBy: 'MANUAL', thread: { recordType: 'Quote', recordId: quoteTwo } })
    const row = await mailOf(waiting.id)
    const message = await first(`SELECT * FROM "Message" WHERE id = $1`, [row.messageId])
    expect(message).toMatchObject({ direction: 'INBOUND', partyId: partyTwo, authorId: null, authorName: 'Nuovo Cliente', emailMessageId: '<new-1@prospect.example.org>' })
    const copy = await first(`SELECT * FROM "StoredFile" WHERE id = $1`, [message.attachmentFileIds[0]])
    expect(copy).toMatchObject({ recordType: 'Quote', recordId: quoteTwo, companyId: tenant.companies[1]!.id, partyId: partyTwo, originalName: 'richiesta.pdf' })
    expect(await h.files.storage.read(system(), copy.storeAccountId, copy.storageKey, 1_000)).toEqual(PDF)
    expect((await triager.post(`/email/inbound/${waiting.id}/assign`, { recordType: 'Quote', recordId: quoteTwo, version: row.version })).status).toBe(409)
    expect((await triager.get('/email/inbound')).body.mails.map((mail: Json) => mail.id)).not.toContain(waiting.id)
  })

  it('a person marks one as spam or throws one away', async () => {
    const spam = await deliver({ from: 'offers@bulk.example.net', to: ['ordini@in-a.example.com'], subject: 'Offerta imperdibile', messageId: '<s1@bulk.example.net>', text: 'Compra' })
    expect(spam.status).toBe('TRIAGE')
    const rejected = await triager.post(`/email/inbound/${spam.id}/reject`, { reason: 'MARKED_SPAM', version: spam.version, note: 'Advertising' })
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200)
    expect(rejected.body.mail).toMatchObject({ status: 'REJECTED', rejectReason: 'MARKED_SPAM', sortedById: triagerId })
    expect((await triager.post(`/email/inbound/${spam.id}/reject`, { reason: 'DISCARDED', version: rejected.body.mail.version })).status).toBe(409)
    expect((await triager.post(`/email/inbound/${spam.id}/reject`, { reason: 'VIRUS', version: rejected.body.mail.version })).status).toBe(400)
    expect(await eventsOf(spam.id)).toEqual(['email.inbound_received', 'email.inbound_fetched', 'email.inbound_sorted', 'email.inbound_sorted'])
  })

  it("a known contact writing without a reply address joins the party's own thread when DMARC passes; otherwise the party is suggested", async () => {
    const joined = await deliver({ from: 'luca@buyer-two.example.com', to: ['ordini@in-a.example.com'], subject: 'Nuovo ordine', messageId: '<n1@buyer-two.example.com>', text: 'Ordiniamo ancora.' })
    expect(joined).toMatchObject({ status: 'MATCHED', matchedBy: 'SENDER', senderPartyId: partyTwo })
    expect(await first(`SELECT "recordType", "recordId", "partyId" FROM "Thread" WHERE id = $1`, [joined.threadId])).toEqual({ recordType: 'Party', recordId: partyTwo, partyId: partyTwo })
    const unsure = await deliver({ from: 'luca@buyer-two.example.com', to: ['ordini@in-a.example.com'], subject: 'Nuovo ordine', messageId: '<n2@buyer-two.example.com>', text: 'x', verdicts: { dmarc: 'GRAY' } })
    expect(unsure).toMatchObject({ status: 'TRIAGE', senderPartyId: partyTwo, threadId: null })
    // Without a thread resolver for parties (the parties module brings it), a known contact waits in triage too.
    useThreadRecords({ Quote: quoteResolverOf() })
    try {
      const waiting = await deliver({ from: 'anna@buyer-one.example.com', to: ['ordini@in-a.example.com'], subject: 'Domanda', messageId: '<n3@buyer-one.example.com>', text: 'x' })
      expect(waiting).toMatchObject({ status: 'TRIAGE', senderPartyId: partyOne, senderContactId: anna })
    } finally {
      useThreadRecords({ Quote: quoteResolverOf(), Party: partyResolverOf() })
    }
  })
})

describe('who sees the files (COL-025, COL-050)', () => {
  it('a joined mail’s file reaches its own party only; a waiting mail’s file reaches no party; the floor sees neither; no party reads the mail rows', async () => {
    const files = await admin(`SELECT id, "recordType", "partyId" FROM "StoredFile" WHERE "tenantId" = $1 AND kind = 'ATTACHMENT'`, [tenant.id])
    const shared = files.filter((file) => file.partyId === partyOne).map((file) => file.id)
    const onMail = files.filter((file) => file.recordType === 'InboundEmail').map((file) => file.id)
    expect(shared.length).toBeGreaterThan(0)
    expect(onMail.length).toBeGreaterThan(0)
    const seenBy = (scope: { audience: 'partner'; partyId: string } | { audience: 'floor'; siteId: string }) =>
      h.database.withScope({ ...scope, tenantId: tenant.id, actorId: newId() } as never, async (client) =>
        (await client.storedFile.findMany({ select: { id: true } })).map((file) => file.id),
      )
    const one = await seenBy({ audience: 'partner', partyId: partyOne })
    expect(one.sort()).toEqual(shared.sort())
    expect(one.some((id) => onMail.includes(id))).toBe(false)
    const two = await seenBy({ audience: 'partner', partyId: partyTwo })
    expect(two.some((id) => shared.includes(id) || onMail.includes(id))).toBe(false)
    expect(await seenBy({ audience: 'floor', siteId: newId() })).toEqual([])
    await expect(h.database.withScope({ audience: 'partner', tenantId: tenant.id, actorId: newId(), partyId: partyOne }, (client) => client.inboundEmail.findMany({ select: { id: true } }))).rejects.toThrow(/permission denied/)
  })
})

describe('the tenant wall', () => {
  it("another tenant's reply token names nothing there, even at its own reply domain; neither tenant sees the other's mail", async () => {
    const thread = await openThread(quoteOne)
    // Tenant B's reply domain (its identity's, from the harness) with tenant A's token: row-level security finds no thread.
    const row = await deliver({ tenantId: tenantB.id, accountId: sesB, from: 'anna@buyer-one.example.com', to: [`r-${thread.token}@reply.in-b.example.com`], subject: 'Re', messageId: '<wall-1@buyer-one.example.com>', text: 'x', verdicts: { dmarc: 'GRAY' } })
    expect(row).toMatchObject({ tenantId: tenantB.id, status: 'TRIAGE', threadId: null, senderPartyId: partyB })
    expect(await admin(`SELECT id FROM "Message" WHERE "emailMessageId" = '<wall-1@buyer-one.example.com>'`)).toEqual([])
    expect((await triager.get(`/email/inbound/${row.id}`)).status).toBe(404)
    expect((await triager.get('/email/inbound')).body.mails.map((mail: Json) => mail.id)).not.toContain(row.id)
    expect((await triagerB.get(`/email/inbound/${row.id}`)).status).toBe(200)
    expect(await fetchCalls(sesB)).toEqual([{ status: 'SUCCEEDED' }])
  })
})

describe('reading failures', () => {
  it('a raw mail gone from the bucket fails at once and waits for a person; a paused account is tried again', async () => {
    const { row } = await receive({ from: 'luca@buyer-two.example.com', to: ['ordini@in-a.example.com'], subject: 'Gone', messageId: '<g1@buyer-two.example.com>', text: 'x' })
    bucket.remove({ bucket: BUCKET, key: row.s3Key })
    expect(await fetchInbound(runtime, system(), row.id)).toBe('failed')
    expect(await mailOf(row.id)).toMatchObject({ status: 'FAILED', attempts: 1, lastError: expect.stringMatching(/no longer in the bucket/) })
    const listed = await triager.get('/email/inbound?status=FAILED')
    expect(listed.body.mails.map((mail: Json) => mail.id)).toContain(row.id)
    const discarded = await triager.post(`/email/inbound/${row.id}/reject`, { reason: 'DISCARDED', version: (await mailOf(row.id)).version })
    expect(discarded.body.mail).toMatchObject({ status: 'REJECTED', rejectReason: 'DISCARDED' })

    // Larger than SES takes (40 MB): refused from its size, once, never retried.
    const large = (await receive({ from: 'luca@buyer-two.example.com', to: ['ordini@in-a.example.com'], subject: 'Big', messageId: '<g3@buyer-two.example.com>', text: 'x' })).row
    bucket.put({ bucket: BUCKET, key: large.s3Key }, Buffer.alloc(MAX_RAW_BYTES + 1, 0x41))
    expect(await fetchInbound(runtime, system(), large.id)).toBe('failed')
    expect(await mailOf(large.id)).toMatchObject({ status: 'FAILED', attempts: 1, lastError: expect.stringMatching(/at most 41943040/) })
    expect(await admin(`SELECT status, attempts FROM "IntegrationCall" WHERE operation = 'mail.fetch_inbound' AND "requestSummary"->>'key' = $1`, [large.s3Key])).toEqual([{ status: 'FAILED', attempts: 1 }])

    const paused = (await receive({ from: 'luca@buyer-two.example.com', to: ['ordini@in-a.example.com'], subject: 'Later', messageId: '<g2@buyer-two.example.com>', text: 'x' })).row
    await admin(`UPDATE "IntegrationAccount" SET status = 'PAUSED' WHERE id = $1`, [sesA])
    try {
      expect(await fetchInbound(runtime, system(), paused.id)).toBe('retry')
      expect(await mailOf(paused.id)).toMatchObject({ status: 'RECEIVED', attempts: 1, lastError: expect.stringMatching(/GatewayRefusal/) })
    } finally {
      await admin(`UPDATE "IntegrationAccount" SET status = 'ACTIVE' WHERE id = $1`, [sesA])
    }
    expect(await fetchInbound(runtime, system(), paused.id)).toBe('fetched')
    expect(await mailOf(paused.id)).toMatchObject({ status: 'FETCHED', attempts: 2, lastError: null })
  })
})

describe('the database guard (…_email_in_guards)', () => {
  it('keeps what SES said, what the mail held and the machine, for every login', async () => {
    const matched = await first(`SELECT id FROM "InboundEmail" WHERE "tenantId" = $1 AND status = 'MATCHED' LIMIT 1`, [tenant.id])
    const waiting = await first(`SELECT id FROM "InboundEmail" WHERE "tenantId" = $1 AND status = 'HELD' LIMIT 1`, [tenant.id])
    await expect(admin(`UPDATE "InboundEmail" SET "dmarcVerdict" = 'PASS' WHERE id = $1`, [waiting.id])).rejects.toThrow(/what SES said/)
    await expect(admin(`UPDATE "InboundEmail" SET "bodyText" = 'changed' WHERE id = $1`, [waiting.id])).rejects.toThrow(/never changes/)
    await expect(admin(`UPDATE "InboundEmail" SET status = 'RECEIVED', "heldReason" = NULL WHERE id = $1`, [waiting.id])).rejects.toThrow(/cannot move/)
    await expect(admin(`UPDATE "InboundEmail" SET status = 'TRIAGE' WHERE id = $1`, [waiting.id])).rejects.toThrow(/held reason exactly/)
    await expect(admin(`UPDATE "InboundEmail" SET "lastError" = 'x' WHERE id = $1`, [matched.id])).rejects.toThrow(/changes no more/)
    await expect(admin(`DELETE FROM "InboundEmail" WHERE id = $1`, [waiting.id])).rejects.toThrow(/never deleted/)
    await expect(admin(`TRUNCATE "InboundEmail"`)).rejects.toThrow(/TRUNCATE/)
  })
})

/** The made-up quotes' resolver: a quote is the tenant's when its company is (read in the caller's scope). */
function quoteResolverOf(): RecordResolver {
  return async (client, id): Promise<RecordScope | null> => {
    const found = quotes.get(id)
    if (!found || !(await client.company.findUnique({ where: { id: found.companyId }, select: { id: true } }))) return null
    return { companyId: found.companyId, siteId: null, partyId: found.partyId }
  }
}

/** A party's own thread resolver, as the parties module will register it: the party's company, the party itself. */
function partyResolverOf(): RecordResolver {
  return async (client, id) => {
    const found = await client.party.findUnique({ where: { id }, select: { companyId: true } })
    return found ? { companyId: found.companyId, siteId: null, partyId: id } : null
  }
}
