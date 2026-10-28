import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { FakeSesTransport, sesNotificationBody } from '../../adapters/ses/testing'
import { sesMailAdapter } from '../../adapters/ses/ses'
import { headerOf, textOf } from '../../adapters/ses/fake'
import { callerFor, command, type CommandCaller } from '../../core/command'
import { addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { createGateway } from '../gateway/gateway'
import { processReceipt } from '../inbound/process'
import { inboundRuntime, useInbound } from '../inbound/providers'
import { fakeSignatureHeaders } from '../inbound/verifiers'
import { systemContext } from '../outbox/system'
import { SECRET_PURPOSES, storeSecret } from '../secrets/store'
import { useThreadRecords, type RecordScope } from '../threads/records'
import { deliverOutbound, emailSendHandler, threadMailBuilder } from './outbound'
import { createEmailRuntime } from './service'

/**
 * Email out on the local stack, with the app's real routes and real sessions (the office sign-in harness): a throwaway
 * PostgreSQL 17 database from the migrations (row-level security and the guard triggers are real), the gateway on the
 * local Redis, FAKE SES accounts whose mailbox is in memory, and a SANDBOX one whose SES client talks to a scripted
 * transport. Nothing reaches AWS. `Quote` is a made-up record type with a party. Run with
 * `node scripts/factory/run-pg-tests.mjs email`.
 */

let h: Harness
let tenant: TestTenant
let tenantB: TestTenant
let owner: Browser
let ownerSecret: string
let sales: Browser
let salesB: Browser
let sesA: string
let sesB: string
let sharedFile: string
let officeFile: string

const WEBHOOK_SECRET = 'whsec_made_up_for_email_tests_51c2'
const SANDBOX_KEY = { accessKeyId: 'made-up-sandbox-key-id-01', secretAccessKey: 'made-up-sandbox-secret-key-for-tests' }
const partyOne = newId()
const partyTwo = newId()
const quote = newId()
const quoteNew = newId()
const quoteOther = newId()
const quoteB = newId()
/** The made-up quotes: their company (by tenant) and party. */
let quotes: Map<string, { companyId: string; partyId: string | null }>

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const first = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const system = (tenantId = tenant.id): CommandCaller => callerFor(h.database, systemContext(tenantId, newId()))
const send = (browser: Browser, recordId: string, body: Json, headers: Record<string, string> = {}) => browser.post(`/threads/Quote/${recordId}/emails`, body, { headers })
const outboundOf = (id: string) => first(`SELECT * FROM "EmailOutbound" WHERE id = $1`, [id])
const sendCalls = (outboundId: string) => admin(`SELECT * FROM "IntegrationCall" WHERE operation = 'mail.send' AND "requestSummary"->>'outboundId' = $1`, [outboundId])

/** The email.queued event of a mail, as the relay would publish it. */
async function queuedEvent(outboundId: string): Promise<EventEnvelope> {
  const row = await first(`SELECT * FROM "OutboxEvent" WHERE type = 'email.queued' AND subject = $1`, [outboundId])
  return {
    eventId: row.id,
    type: row.type,
    version: row.version,
    context: row.context,
    tenantId: row.tenantId,
    companyId: row.companyId,
    siteId: row.siteId,
    subject: row.subject,
    correlationId: row.correlationId,
    causationId: row.causationId,
    source: row.source,
    occurredAt: toUtcIso(row.occurredAt),
    payload: row.payload,
  }
}

/** Runs the worker's handler of email.queued for a mail (as the worker would, in the tenant's system context). */
async function work(outboundId: string, tenantId = tenant.id): Promise<void> {
  await emailSendHandler(() => h.email).handle(await queuedEvent(outboundId), { caller: system(tenantId), attempt: 1 })
}

/** A FAKE (or SANDBOX) SES account with a webhook secret and, for SANDBOX, sealed credentials. */
async function sesAccount(tenantId: string, mode: 'FAKE' | 'SANDBOX'): Promise<string> {
  const id = newId()
  await command(callerFor(h.database, { audience: 'office', tenantId, actorId: newId(), grants: [], requestId: newId() }), { name: 'integration.createAccount', input: { id } }, async (tools) => {
    const webhook = await storeSecret(tools, h.secrets, { purpose: SECRET_PURPOSES.webhook, plaintext: WEBHOOK_SECRET })
    const credentials = mode === 'SANDBOX' ? await storeSecret(tools, h.secrets, { purpose: SECRET_PURPOSES.credentials, plaintext: JSON.stringify(SANDBOX_KEY) }) : null
    await tools.tx.integrationAccount.create({
      data: {
        id,
        provider: 'SES',
        code: `ses-${id.slice(-12)}`,
        label: `Mail ${mode}`,
        mode,
        webhookSecretId: webhook.id,
        credentialsSecretId: credentials?.id ?? null,
        settings: mode === 'SANDBOX' ? { region: 'eu-south-1', configurationSet: 'factory-events' } : undefined,
        rateLimitPerMinute: 6000,
        rateLimitBurst: 1000,
      },
      select: { id: true },
    })
    tools.audit({ recordType: 'IntegrationAccount', recordId: id })
    return null
  })
  return id
}

/** Posts an SES notification to the inbound route of an account (signed as a FAKE account's provider), then processes it. */
async function notify(tenantId: string, accountId: string, body: string): Promise<string> {
  const eventId = `sns-${newId()}`
  const response = await h.app.inject({
    method: 'POST',
    url: `/inbound/ses/${tenantId}/${accountId}`,
    payload: body,
    headers: { 'content-type': 'application/json', ...fakeSignatureHeaders(WEBHOOK_SECRET, body, h.clock.now(), { id: eventId, type: 'ses.notification' }) },
  })
  expect(response.statusCode, response.body).toBe(200)
  const { receiptId } = response.json() as { receiptId: string }
  expect(await processReceipt(system(tenantId), receiptId, newId(), inboundRuntime())).toBe('processed')
  return receiptId
}

/** The bytes of the shared quote PDF (made up). */
const QUOTE_PDF = Buffer.concat([Buffer.from('%PDF-1.7\n% made-up quote for the email tests\n'), Buffer.from([0x00, 0xff, 0x10, 0x80])])

/**
 * An AVAILABLE file of a quote, written straight into the table (the files flow is tested in platform/files); with
 * `bytes`, its object is put in the local store first (one files.put), so the worker can attach it.
 */
async function file(recordId: string, sharedWith: string | null, bytes?: Buffer, sizeBytes = bytes?.byteLength ?? 100): Promise<string> {
  const id = newId()
  const store = (await first(`SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [tenant.id])).id
  const key = `t/${tenant.id}/c/${tenant.companies[0]!.id}/2026/${newId()}`
  const sha256 = createHash('sha256').update(bytes ?? id).digest('hex')
  if (bytes) await h.files.storage.put(system(), store, { key, contentType: 'application/pdf', body: bytes, sha256 })
  await admin(
    `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256,
       "storeAccountId", "storageKey", status, visibility, "partyId", "availableAt")
     VALUES ($1, $2, $3, 'Quote', $4, 'DOCUMENT', $5, 'application/pdf', $11, $6, $7, $8, 'AVAILABLE', $9::"FileAudience"[], $10, now())`,
    [
      id,
      tenant.id,
      tenant.companies[0]!.id,
      recordId,
      sharedWith ? 'Preventivo giacche.pdf' : 'Costi interni.pdf',
      sha256,
      store,
      key,
      sharedWith ? ['OFFICE', 'PARTNER'] : ['OFFICE'],
      sharedWith,
      sizeBytes,
    ],
  )
  return id
}

beforeAll(async () => {
  h = await startHarness('email_out')
  tenant = await addTenant(h, 'mail-a', 2)
  tenantB = await addTenant(h, 'mail-b')
  const [c1, c2] = tenant.companies
  quotes = new Map([
    [quote, { companyId: c1!.id, partyId: partyOne }],
    [quoteNew, { companyId: c1!.id, partyId: partyOne }],
    [quoteOther, { companyId: c2!.id, partyId: partyTwo }],
    [quoteB, { companyId: tenantB.companies[0]!.id, partyId: newId() }],
  ])
  useThreadRecords({
    // A made-up quote is the tenant's when its company is (read in the caller's scope: row-level security decides).
    Quote: async (client, id): Promise<RecordScope | null> => {
      const found = quotes.get(id)
      if (!found || !(await client.company.findUnique({ where: { id: found.companyId }, select: { id: true } }))) return null
      return { companyId: found.companyId, siteId: null, partyId: found.partyId }
    },
  })
  useInbound({ secrets: h.secrets, clock: h.clock, environment: 'test' })
  // Company C1's legal data (made up): the footer prints it, with c. 3 and c. 4 of art. 2250.
  await admin(
    `UPDATE "Company" SET "vatNumber" = 'IT00000000000', "fiscalCode" = '00000000000', "reaOffice" = 'FI', "reaNumber" = '123456', "shareCapital" = 10000,
       "soleShareholder" = true, "inLiquidation" = true,
       pec = 'mail-a@pec.example.com', address = '{"line1":"Via Esempio 1","postalCode":"50100","city":"Firenze","province":"FI","country":"IT"}'::jsonb
     WHERE id = $1`,
    [c1!.id],
  )
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode) VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE')`, [newId(), tenant.id])
  sharedFile = await file(quote, partyOne, QUOTE_PDF)
  officeFile = await file(quote, null)
  sesA = await sesAccount(tenant.id, 'FAKE')
  sesB = await sesAccount(tenantB.id, 'FAKE')

  const account = await addUser(h, tenant, { email: 'owner@mail-a.example.com', role: 'owner' })
  owner = new Browser(h.app)
  await owner.signIn('mail-a', account.email, account.password)
  ownerSecret = await enrolTotp(h, owner)
  const seller = await addUser(h, tenant, { email: 'sara.sales@mail-a.example.com', role: 'sales' })
  sales = new Browser(h.app)
  await sales.signIn('mail-a', seller.email, seller.password)
  const sellerB = await addUser(h, tenantB, { email: 'bruno.sales@mail-b.example.com', role: 'sales' })
  salesB = new Browser(h.app)
  await salesB.signIn('mail-b', sellerB.email, sellerB.password)
}, 90_000)

afterAll(async () => {
  useThreadRecords(undefined)
  useInbound(undefined)
  await h?.close()
}, 60_000)

describe('sending identities (PLT-230)', () => {
  it('need email.manage and a step-up; SES verifies the domain through the gateway; senders list them', async () => {
    const body = { companyId: tenant.companies[0]!.id, kind: 'CONVERSATION', domain: 'Mail-A.Example.com', accountId: sesA }
    expect((await sales.post('/email/identities', body)).status).toBe(403)
    const refused = await owner.post('/email/identities', body)
    expect(refused.status).toBe(403)
    expect(refused.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])

    await stepUp(h, owner, ownerSecret)
    const created = await owner.post('/email/identities', body)
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    expect(created.body).toMatchObject({
      sesChecked: true,
      identity: {
        kind: 'CONVERSATION',
        domain: 'mail-a.example.com',
        fromAddress: 'noreply@mail-a.example.com',
        displayName: 'Test company C1',
        displayNamePolicy: 'PERSON_VIA_COMPANY',
        replyDomain: 'reply.mail-a.example.com',
        verificationStatus: 'SUCCESS',
        dkimStatus: 'SUCCESS',
        ready: true,
        isDefault: true,
      },
    })
    expect(created.body.identity.dkimRecords).toHaveLength(3)
    expect(created.body.identity.dkimRecords[0]).toMatchObject({ type: 'CNAME', name: expect.stringMatching(/\._domainkey\.mail-a\.example\.com$/), value: expect.stringMatching(/\.dkim\.amazonses\.com$/) })
    const calls = await admin(`SELECT operation, status FROM "IntegrationCall" WHERE "accountId" = $1 AND operation = 'mail.create_identity'`, [sesA])
    expect(calls).toEqual([{ operation: 'mail.create_identity', status: 'SUCCEEDED' }])

    // The same address twice is refused; a person without email.manage cannot change one.
    await stepUp(h, owner, ownerSecret)
    expect((await owner.post('/email/identities', body)).body.error.issues).toEqual([{ path: 'body/localPart', message: 'This company already sends from this address.' }])
    const listed = await sales.get('/email/identities')
    expect(listed.status).toBe(200)
    expect(listed.body.identities.map((identity: Json) => identity.kind).sort()).toEqual(['CONVERSATION', 'NOTIFICATION'])
    expect((await sales.send('PUT' as never, `/email/identities/${created.body.identity.id}`, { version: 1, displayName: 'X' })).status).toBe(403)
  })
})

describe('sending from a record thread (COL-024)', () => {
  let outboundId: string

  it('writes the OUTBOUND message, the EmailOutbound row QUEUED and email.queued in ONE command; nothing is sent yet', async () => {
    const before = h.ses.mails.length
    const answer = await send(sales, quote, {
      to: [' Buyer@Example.com'],
      cc: ['boss@example.com'],
      bcc: ['archive@example.com'],
      subject: 'Preventivo giacche',
      body: 'Buongiorno,\necco il preventivo per le giacche.',
      attachments: [sharedFile],
    })
    expect(answer.status, JSON.stringify(answer.body)).toBe(201)
    outboundId = answer.body.email.id
    expect(answer.body.email).toMatchObject({
      status: 'QUEUED',
      templateKey: 'thread.message',
      locale: 'it',
      from: { name: 'sara sales via Test company C1', address: 'noreply@mail-a.example.com' },
      to: ['buyer@example.com'],
      cc: ['boss@example.com'],
      bcc: ['archive@example.com'],
      subject: 'Preventivo giacche',
      attempts: 0,
    })
    expect(JSON.stringify(answer.body)).not.toMatch(/r-[a-z2-7]{26}|reply\.mail-a/)

    const message = await first(`SELECT * FROM "Message" WHERE id = $1`, [answer.body.messageId])
    expect(message).toMatchObject({ direction: 'OUTBOUND', audience: 'PARTNER', channel: 'EMAIL', partyId: partyOne, emailMessageId: `<${outboundId}@mail-a.example.com>`, attachmentFileIds: [sharedFile] })
    const row = await outboundOf(outboundId)
    expect(row).toMatchObject({ status: 'QUEUED', threadId: message.threadId, messageId: message.id, emailMessageId: message.emailMessageId, inReplyTo: null, referenceIds: [], sesMessageId: null })
    // One command: its audit row, the message, the mail and both events carry the same request.
    const audit = await first(`SELECT "requestId" FROM "AuditLog" WHERE action = 'email.send' AND "recordId" = $1`, [outboundId])
    const events = await admin(`SELECT type, "correlationId", payload FROM "OutboxEvent" WHERE "correlationId" = $1 ORDER BY type`, [audit.requestId])
    expect(events.map((event) => event.type)).toEqual(['email.queued', 'thread.message_posted'])
    expect(events[0]!.payload).toEqual({ outboundId, threadId: message.threadId, messageId: message.id })
    expect(h.ses.mails.length).toBe(before)
  })

  it('refuses a mail it cannot send, and then writes nothing at all (not even the thread)', async () => {
    const refused = await send(sales, quoteNew, { to: ['ok@example.com', 'not an address'], subject: 'X', body: 'Text', attachments: [officeFile] })
    expect(refused.status).toBe(400)
    expect(refused.body.error.issues).toEqual([
      { path: 'body/to/1', message: 'Not an email address.' },
      { path: 'body/attachments/0', message: 'Only a file of this record can be attached.' },
    ])
    expect(await admin(`SELECT id FROM "Thread" WHERE "recordId" = $1`, [quoteNew])).toEqual([])
    const unshared = await send(sales, quote, { to: ['ok@example.com'], subject: 'X', body: 'Text', attachments: [officeFile] })
    expect(unshared.body.error.issues).toEqual([{ path: 'body/attachments/0', message: "Share the file with the record's party first." }])
    // Another company's record, and a person without email.send.
    expect((await send(salesB, quote, { to: ['ok@example.com'], subject: 'X', body: 'Text' })).status).toBe(404)
  })

  it('the worker sends it ONCE through the fake SES (one gateway ledger row): Reply-To is the thread address, the footer has the legal block and the privacy link', async () => {
    const before = h.ses.mails.length
    await work(outboundId)
    await work(outboundId)
    expect(h.ses.mails.length).toBe(before + 1)
    expect(await sendCalls(outboundId)).toHaveLength(1)
    const row = await outboundOf(outboundId)
    expect(row).toMatchObject({ status: 'SENT', attempts: 1, lastError: null })
    expect(row.sesMessageId).toMatch(/^fake-/)
    expect((await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'email.status_changed' AND subject = $1`, [outboundId])).map((event) => event.payload.status)).toEqual(['SENT'])

    const mail = h.ses.mails.at(-1)!
    expect(mail).toMatchObject({ outboundId, to: ['buyer@example.com'], cc: ['boss@example.com'], bcc: ['archive@example.com'], from: 'noreply@mail-a.example.com' })
    const thread = await first(`SELECT "replyToken" FROM "Thread" WHERE "recordId" = $1`, [quote])
    expect(headerOf(mail.raw, 'Reply-To')).toBe(`r-${thread.replyToken}@reply.mail-a.example.com`)
    expect(headerOf(mail.raw, 'From')).toBe('"sara sales via Test company C1" <noreply@mail-a.example.com>')
    expect(headerOf(mail.raw, 'Message-ID')).toBe(`<${outboundId}@mail-a.example.com>`)
    expect(headerOf(mail.raw, 'Bcc')).toBeNull()
    expect(mail.raw).not.toContain('archive@example.com')
    const text = textOf(mail.raw)
    expect(text).toContain('Buongiorno,\necco il preventivo per le giacche.')
    expect(text).toContain('Allegati:\n- Preventivo giacche.pdf')
    expect(text).toContain('Test company C1 in liquidazione\nSede legale: Via Esempio 1, 50100 Firenze (FI)')
    expect(text).toContain('P. IVA IT00000000000 · C.F. 00000000000')
    expect(text).toContain('Registro Imprese di FI n. 00000000000 · REA FI-123456')
    expect(text).toContain('Capitale sociale versato € 10.000,00 · Società con socio unico')
    expect(text).toContain(`Informativa privacy (artt. 13-14 GDPR): http://localhost:3200/privacy/${tenant.companies[0]!.id}`)

    // The attachment's bytes and name travel in the MIME, read once through the file store (worker, not the command).
    expect(mail.raw).toContain('Content-Type: multipart/mixed; boundary=')
    expect(mail.raw).toContain('Content-Disposition: attachment; filename="Preventivo giacche.pdf"')
    const part = /filename="Preventivo giacche\.pdf"\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(mail.raw)?.[1] ?? ''
    expect(Buffer.from(part.replace(/\r\n/g, ''), 'base64').equals(QUOTE_PDF)).toBe(true)
    const { storageKey } = await first(`SELECT "storageKey" FROM "StoredFile" WHERE id = $1`, [sharedFile])
    expect(await admin(`SELECT status FROM "IntegrationCall" WHERE operation = 'files.read' AND "requestSummary"->>'key' = $1`, [storageKey])).toEqual([{ status: 'SUCCEEDED' }])
  })

  it('refuses attachments that hold more than 10 MB together, before anything is written', async () => {
    const big = await file(quote, partyOne, undefined, 6 * 1024 * 1024)
    const bigger = await file(quote, partyOne, undefined, 5 * 1024 * 1024)
    const refused = await send(sales, quote, { to: ['buyer@example.com'], subject: 'Campionario', body: 'Tutto.', attachments: [big, bigger] })
    expect(refused.status).toBe(400)
    expect(refused.body.error.issues).toEqual([{ path: 'body/attachments', message: expect.stringMatching(/hold 11 MB together; a mail carries at most 10 MB/) }])
    expect(await admin(`SELECT id FROM "Message" WHERE $1 = ANY("attachmentFileIds")`, [big])).toEqual([])
  })

  it('a reply on the same thread threads: In-Reply-To and References, and "Re:" the subject', async () => {
    const answer = await send(sales, quote, { to: ['buyer@example.com'], body: 'Un aggiornamento.' })
    expect(answer.status, JSON.stringify(answer.body)).toBe(201)
    const reply = answer.body.email.id
    expect(answer.body.email.subject).toBe('Re: Preventivo giacche')
    expect(await outboundOf(reply)).toMatchObject({ inReplyTo: `<${outboundId}@mail-a.example.com>`, referenceIds: [`<${outboundId}@mail-a.example.com>`] })
    await work(reply)
    const mail = h.ses.mails.at(-1)!
    expect(headerOf(mail.raw, 'In-Reply-To')).toBe(`<${outboundId}@mail-a.example.com>`)
    expect(headerOf(mail.raw, 'References')).toBe(`<${outboundId}@mail-a.example.com>`)
    const listed = await sales.get(`/threads/Quote/${quote}/emails`)
    expect(listed.status).toBe(200)
    expect(listed.body.emails.map((email: Json) => [email.id, email.status])).toEqual([
      [reply, 'SENT'],
      [outboundId, 'SENT'],
    ])
  })

  it('a failed try goes back to QUEUED for the job; a final failure is FAILED; two workers send a mail once', async () => {
    const answer = await send(sales, quote, { to: ['retry@example.com'], body: 'Ancora.' })
    const id = answer.body.email.id
    h.ses.failNext = { httpStatus: 503, message: 'Service unavailable' }
    await expect(work(id)).rejects.toThrow(/will be tried again/)
    expect(await outboundOf(id)).toMatchObject({ status: 'QUEUED', attempts: 1, lastError: expect.stringMatching(/503|Service unavailable/) })
    await work(id)
    expect(await outboundOf(id)).toMatchObject({ status: 'SENT', attempts: 2 })
    expect((await sendCalls(id)).map((call) => call.status)).toEqual(['FAILED', 'SUCCEEDED'])

    const rejected = (await send(sales, quote, { to: ['rejected@example.com'], body: 'No.' })).body.email.id
    h.ses.failNext = { httpStatus: 400, message: 'MessageRejected' }
    await work(rejected)
    expect(await outboundOf(rejected)).toMatchObject({ status: 'FAILED', attempts: 1 })

    const raced = (await send(sales, quote, { to: ['race@example.com'], body: 'Una volta.' })).body.email.id
    const before = h.ses.mails.length
    const outcomes = await Promise.all([1, 2].map(() => deliverOutbound(h.email, system(), raced, { retry: true, build: threadMailBuilder(h.email, system()) })))
    expect(outcomes.sort()).toEqual(['sent', 'settled'])
    expect(h.ses.mails.length).toBe(before + 1)
    expect(await sendCalls(raced)).toHaveLength(1)
  })
})

describe('SES notifications (PLT-149)', () => {
  it('a bounce suppresses the address, the mail is BOUNCED, and the next send to it is refused', async () => {
    const id = (await send(sales, quote, { to: ['gone@example.com'], cc: ['still@example.com'], body: 'Prova.' })).body.email.id
    await work(id)
    const { sesMessageId } = await outboundOf(id)
    await notify(tenant.id, sesA, sesNotificationBody({ snsMessageId: `sns-${newId()}`, eventType: 'Bounce', sesMessageId, outboundId: id, bounce: { type: 'Permanent', recipients: ['Gone@Example.com'] } }))
    expect(await outboundOf(id)).toMatchObject({ status: 'BOUNCED', lastError: 'bounce Permanent/General' })
    expect((await outboundOf(id)).bouncedAt).not.toBeNull()
    expect(await admin(`SELECT address, reason, detail, "outboundId" FROM "Suppression" WHERE "tenantId" = $1`, [tenant.id])).toEqual([
      { address: 'gone@example.com', reason: 'BOUNCE', detail: 'Permanent/General', outboundId: id },
    ])
    expect((await admin(`SELECT type FROM "OutboxEvent" WHERE type IN ('email.address_suppressed', 'email.status_changed') AND subject <> $1 AND payload->>'reason' = 'BOUNCE'`, [id])).length).toBe(1)

    // A delivery to the other recipient afterwards leaves it BOUNCED.
    await notify(tenant.id, sesA, sesNotificationBody({ snsMessageId: `sns-${newId()}`, eventType: 'Delivery', sesMessageId, delivered: ['still@example.com'] }))
    expect(await outboundOf(id)).toMatchObject({ status: 'BOUNCED' })
    expect((await outboundOf(id)).deliveredAt).not.toBeNull()

    const refused = await send(sales, quote, { to: ['ok@example.com'], bcc: ['GONE@example.com'], body: 'Di nuovo.' })
    expect(refused.status).toBe(400)
    expect(refused.body.error.issues).toEqual([{ path: 'body/bcc/0', message: 'This address bounced or complained before; no mail goes to it.' }])
  })

  it('a transient bounce suppresses nothing; a complaint suppresses; a mail queued before its address was suppressed fails unsent', async () => {
    const queuedLater = (await send(sales, quote, { to: ['angry@example.com'], body: 'In coda.' })).body.email.id
    const id = (await send(sales, quote, { to: ['angry@example.com'], body: 'Prima.' })).body.email.id
    await work(id)
    const { sesMessageId } = await outboundOf(id)
    await notify(tenant.id, sesA, sesNotificationBody({ snsMessageId: `sns-${newId()}`, eventType: 'Bounce', sesMessageId, bounce: { type: 'Transient', subType: 'MailboxFull', recipients: ['angry@example.com'] } }))
    expect(await outboundOf(id)).toMatchObject({ status: 'SENT', lastError: 'bounce Transient/MailboxFull' })
    expect(await admin(`SELECT 1 FROM "Suppression" WHERE address = 'angry@example.com'`)).toEqual([])
    await notify(tenant.id, sesA, sesNotificationBody({ snsMessageId: `sns-${newId()}`, eventType: 'Complaint', sesMessageId, complaint: { recipients: ['angry@example.com'] } }))
    expect(await outboundOf(id)).toMatchObject({ status: 'COMPLAINED' })
    expect(await first(`SELECT reason, detail FROM "Suppression" WHERE address = 'angry@example.com'`)).toEqual({ reason: 'COMPLAINT', detail: 'abuse' })

    const calls = (await admin(`SELECT count(*)::int AS n FROM "IntegrationCall" WHERE operation = 'mail.send'`))[0]!.n
    await work(queuedLater)
    expect(await outboundOf(queuedLater)).toMatchObject({ status: 'FAILED', lastError: expect.stringMatching(/^suppressed/) })
    expect((await admin(`SELECT count(*)::int AS n FROM "IntegrationCall" WHERE operation = 'mail.send'`))[0]!.n).toBe(calls)
  })
})

describe('the walls', () => {
  it('a party sees the OUTBOUND message only when it is shared with it, never an internal note or the delivery state', async () => {
    const note = await sales.post(`/threads/Quote/${quote}/notes`, { body: 'Nota interna: sconto massimo 5%.' })
    expect(note.status).toBe(201)
    const thread = await first(`SELECT id FROM "Thread" WHERE "recordId" = $1`, [quote])
    const asParty = (partyId: string) => ({ audience: 'partner' as const, tenantId: tenant.id, actorId: newId(), partyId })
    const seen = await h.database.withScope(asParty(partyOne), (client) =>
      client.message.findMany({ where: { threadId: thread.id }, select: { direction: true, bodyText: true } }),
    )
    expect(seen.length).toBeGreaterThan(0)
    expect(new Set(seen.map((message) => message.direction))).toEqual(new Set(['OUTBOUND']))
    expect(seen.map((message) => message.bodyText)).not.toContain('Nota interna: sconto massimo 5%.')
    expect(await h.database.withScope(asParty(partyTwo), (client) => client.message.findMany({ where: { threadId: thread.id }, select: { id: true } }))).toEqual([])
    await expect(h.database.withScope(asParty(partyOne), (client) => client.emailOutbound.findMany({ select: { id: true } }))).rejects.toThrow(/permission denied/)
    await expect(h.database.withScope(asParty(partyOne), (client) => client.suppression.findMany({ select: { id: true } }))).rejects.toThrow(/permission denied/)
  })

  it('a tenant sees and changes only its own mail, identities and suppression list', async () => {
    expect((await salesB.get(`/threads/Quote/${quote}/emails`)).status).toBe(404)
    const identities = await salesB.get('/email/identities')
    expect(identities.body.identities.map((identity: Json) => identity.domain)).toEqual(['mail.mail-b.example.com'])
    // A notification on tenant B's account naming tenant A's mail changes nothing of A's.
    const id = (await send(sales, quote, { to: ['walled@example.com'], body: 'Muro.' })).body.email.id
    await work(id)
    const { sesMessageId } = await outboundOf(id)
    await notify(tenantB.id, sesB, sesNotificationBody({ snsMessageId: `sns-${newId()}`, eventType: 'Bounce', sesMessageId, bounce: { type: 'Permanent', recipients: ['walled@example.com'] } }))
    expect(await outboundOf(id)).toMatchObject({ status: 'SENT' })
    expect(await admin(`SELECT "tenantId" FROM "Suppression" WHERE address = 'walled@example.com'`)).toEqual([{ tenantId: tenantB.id }])
    expect((await send(sales, quote, { to: ['walled@example.com'], body: 'Ancora.' })).status).toBe(201)
    // Tenant B's worker cannot send tenant A's mail.
    const other = (await send(sales, quote, { to: ['ok@example.com'], body: 'Mio.' })).body.email.id
    expect(await deliverOutbound(h.email, system(tenantB.id), other, { retry: true, build: threadMailBuilder(h.email, system(tenantB.id)) })).toBe('settled')
    expect(await outboundOf(other)).toMatchObject({ status: 'QUEUED' })
  })

  it('the gateway ledger keeps no SES credentials and no address (a SANDBOX account through the real SES client)', async () => {
    const sandbox = await sesAccount(tenant.id, 'SANDBOX')
    await admin(
      `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "replyDomain", "accountId", "verificationStatus", "dkimStatus")
       VALUES ($1, $2, $3, 'CONVERSATION', 'sandbox.mail-a.example.com', 'noreply@sandbox.mail-a.example.com', 'Sandbox C1', 'reply.sandbox.mail-a.example.com', $4, 'SUCCESS', 'SUCCESS')`,
      [newId(), tenant.id, tenant.companies[0]!.id, sandbox],
    )
    const identity = (await first(`SELECT id FROM "EmailIdentity" WHERE "accountId" = $1`, [sandbox])).id
    const id = (await send(sales, quote, { to: ['sandbox.buyer@example.com'], bcc: ['sandbox.archive@example.com'], body: 'Sandbox.', identityId: identity })).body.email.id
    const transport = new FakeSesTransport().answer('POST /v2/email/outbound-emails', { status: 200, body: { MessageId: 'ses-sandbox-0001' } })
    const runtime = createEmailRuntime({
      gateway: createGateway({ environment: 'test', redis: h.redis, prefix: h.redisPrefix, secrets: h.secrets, sleep: async () => {} }),
      fake: null,
      webOrigin: 'http://localhost:3200',
      ses: sesMailAdapter({ clientFor: transport.clientFor }),
    })
    expect(await deliverOutbound(runtime, system(), id, { retry: true, build: threadMailBuilder(runtime, system()) })).toBe('sent')
    expect(await outboundOf(id)).toMatchObject({ status: 'SENT', sesMessageId: 'ses-sandbox-0001' })
    expect(transport.requests).toHaveLength(1)
    expect(JSON.parse(transport.requests[0]!.body).Destination.BccAddresses).toEqual(['sandbox.archive@example.com'])
    expect(transport.requests[0]!.headers.authorization).toContain(`Credential=${SANDBOX_KEY.accessKeyId}/`)

    const ledger = await admin(`SELECT to_jsonb(c)::text AS row FROM "IntegrationCall" c WHERE provider = 'SES'`)
    expect(ledger.length).toBeGreaterThan(5)
    for (const { row } of ledger) {
      expect(row).not.toContain(SANDBOX_KEY.accessKeyId)
      expect(row).not.toContain(SANDBOX_KEY.secretAccessKey)
      expect(row).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]/)
    }
  })
})

describe('sign-in mail through email out', () => {
  it('an invitation goes out with its link, from the notification identity; no stored row holds the link', async () => {
    await stepUp(h, owner, ownerSecret)
    const invited = await owner.post('/auth/invitations', { email: 'New.Hire@example.com', displayName: 'Nina Hire' })
    expect(invited.status).toBe(200)
    expect(JSON.stringify(invited.body)).not.toMatch(/token|#/)
    const message = h.mailer.last('invitation', 'new.hire@example.com')!
    expect(message.link).toMatch(/^http:\/\/localhost:3200\/accept-invitation#token=/)
    const raw = message.mail.raw
    expect(headerOf(raw, 'From')).toBe('"Test company C1" <noreply@mail.mail-a.example.com>')
    expect(headerOf(raw, 'Auto-Submitted')).toBe('auto-generated')
    expect(headerOf(raw, 'Reply-To')).toBeNull()
    expect(textOf(raw)).toContain('Nina Hire')
    expect(textOf(raw)).toContain(`http://localhost:3200/privacy/${tenant.companies[0]!.id}`)
    const row = await first(`SELECT * FROM "EmailOutbound" WHERE id = $1`, [message.mail.outboundId])
    expect(row).toMatchObject({ templateKey: 'auth.invitation', status: 'SENT', recordType: 'User', threadId: null, messageId: null, to: ['new.hire@example.com'] })
    expect(await sendCalls(row.id)).toHaveLength(1)

    // A password reset likewise (sent after the answer).
    const reset = await new Browser(h.app).post('/auth/office/password/reset-request', { tenant: 'mail-a', email: 'sara.sales@mail-a.example.com' })
    expect(reset.status).toBe(200)
    await h.auth.settled()
    const resetMail = h.mailer.last('password_reset', 'sara.sales@mail-a.example.com')!
    expect(resetMail.link).toMatch(/\/reset-password#token=/)

    const secrets = [message.link, resetMail.link].flatMap((link) => {
      const token = decodeURIComponent(link.split('#token=')[1]!)
      return [token, token.split('.')[2]!]
    })
    const tables = await admin<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`)
    expect(tables.map((table) => table.table_name)).toEqual(expect.arrayContaining(['EmailOutbound', 'AuditLog', 'OutboxEvent', 'IntegrationCall', 'IdempotencyReceipt']))
    for (const { table_name } of tables) {
      const all = await admin<{ row: string }>(`SELECT to_jsonb(t)::text AS row FROM "${table_name}" t`)
      for (const secret of secrets) expect(all.filter((entry) => entry.row.includes(secret)), `${table_name}`).toEqual([])
    }
  })

  it('a sign-in mail to a suppressed address is not sent (FAILED), and the answer stays the same', async () => {
    await admin(`INSERT INTO "Suppression" (id, "tenantId", address, reason, at) VALUES ($1, $2, 'blocked.hire@example.com', 'MANUAL', now())`, [newId(), tenant.id])
    await stepUp(h, owner, ownerSecret)
    const before = h.ses.mails.length
    const invited = await owner.post('/auth/invitations', { email: 'blocked.hire@example.com', displayName: 'Blocked Hire' })
    expect(invited.status).toBe(200)
    expect(invited.body.delivery).toBe('sent')
    expect(h.ses.mails.length).toBe(before)
    expect(await first(`SELECT status, "lastError" FROM "EmailOutbound" WHERE "to" @> ARRAY['blocked.hire@example.com']`)).toMatchObject({ status: 'FAILED', lastError: expect.stringMatching(/^suppressed/) })
  })
})
