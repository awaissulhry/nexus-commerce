import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { FakeMailBucket } from '../../adapters/ses-inbound/fake'
import { inboundS3Store } from '../../adapters/ses-inbound/s3'
import { callerFor, command, type CommandCaller } from '../../core/command'
import { BRAND_ALPHA, BRAND_BETA } from '../../golden-flow/portal/testing/two-brands'
import { addTenant, startHarness, type Harness, type TestTenant } from '../auth/sessions/testing/harness'
import { createGateway } from '../gateway/gateway'
import { processReceipt } from '../inbound/process'
import { inboundRuntime, useInbound } from '../inbound/providers'
import { fakeSignatureHeaders } from '../inbound/verifiers'
import { systemContext } from '../outbox/system'
import { SECRET_PURPOSES, storeSecret } from '../secrets/store'
import { useThreadRecords, type RecordResolver } from '../threads/records'
import { ensureThread, writeMessage } from '../threads/threads'
import { fetchInbound } from './fetch'
import { createEmailInRuntime, useEmailIn, type EmailInRuntime } from './service'
import { sortInbound } from './sort'
import { rawMail, receivedNotificationBody, type RawAttachment } from './testing'

/**
 * B-TH-088 (threads plan TH-8, G13; wall surface W22; Owner rule 2026-11-16: "One brand must not be able to see anything related
 * to any other brand"): pictures pasted in a mail are kept. A pasted picture (an inline part of the mail's HTML) becomes a file of
 * the mail like an attachment; a small one (a signature logo) and a repeated one (a banner in every quoted reply) stay out, as
 * 'inline'. Its home is the mail's: brand B's reply to brand B's thread puts the picture on brand B's record, shared with brand B
 * only — nothing of it on brand A's record or thread; a mail held for a person (a stranger writing to brand A's reply address)
 * keeps its picture on the mail itself, office only, shared with nobody. The mail travels as SES gives it (the FAKE bucket, the
 * inbound route), then the worker's two steps. Brand Alpha and Brand Beta are the two-brand harness's names; every address is
 * made up. Run with `node scripts/factory/run-pg-tests.mjs email-in/inline-pictures`.
 */

let h: Harness
let tenant: TestTenant
let ses: string
let bucket: FakeMailBucket
let runtime: EmailInRuntime

const WEBHOOK_SECRET = 'whsec_made_up_for_inline_picture_tests_088'
const BUCKET = 'factory-inbound-th088'
const alpha = newId()
const beta = newId()
const alphaQuote = newId()
const betaQuote = newId()
const BETA_CONTACT = 'bruno.becker@brand-beta.example'
const ALPHA_CONTACT = 'alma.alfieri@brand-alpha.example'
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(48_000, 11), Buffer.from([0xff, 0xd9])])
const logo = Buffer.concat([PNG_HEAD, Buffer.alloc(900, 5)])
const banner = Buffer.concat([PNG_HEAD, Buffer.alloc(32_000, 9)])
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
let quotes: Map<string, { companyId: string; partyId: string }>

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const first = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const system = (): CommandCaller => callerFor(h.database, systemContext(tenant.id, newId()))

async function party(id: string, brand: typeof BRAND_ALPHA, email: string): Promise<void> {
  await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: newId() }, async (client) => {
    await client.party.create({ data: { id, code: brand.code, kind: 'ORGANISATION', legalName: brand.legalName, tradeName: brand.tradeName, roles: ['CUSTOMER', 'BRAND'] } })
    await client.partyContact.create({ data: { id: newId(), partyId: id, name: brand.contact.name, email } })
  })
}

/** A brand's quote thread with one mail of ours: its reply token is what a reply is addressed to. */
async function openThread(record: string): Promise<{ id: string; token: string }> {
  const { result } = await command(system(), { name: 'threads.testOpen', input: { record } }, async (tools) => {
    const { thread } = await ensureThread(tools, { type: 'Quote', id: record }, null)
    tools.audit({ action: 'threads.testOpen', recordType: 'Thread', recordId: thread.id })
    await writeMessage(tools, thread, { direction: 'OUTBOUND', channel: 'EMAIL', author: { kind: 'SYSTEM', id: null, name: 'Test' }, bodyText: 'Here is the quote.', emailMessageId: `<out-${newId()}@factory.example.com>` })
    return thread.id
  })
  const { replyToken } = await first(`SELECT "replyToken" FROM "Thread" WHERE id = $1`, [result])
  return { id: result, token: replyToken }
}

/** SES receives a mail (raw bytes in the bucket, the notification through the inbound route); the worker fetches and sorts it. */
async function deliver(mail: { from: string; to: string[]; subject: string; html: string; attachments: RawAttachment[] }): Promise<Json> {
  const sesMessageId = `ses${newId().replace(/-/g, '')}`
  const location = { bucket: BUCKET, key: `inbound/${sesMessageId}` }
  bucket.put(location, rawMail({ ...mail, text: 'Made-up: see the picture.', messageId: `<${sesMessageId}@sender.example>` }))
  const body = receivedNotificationBody({ snsMessageId: `sns-${sesMessageId}`, sesMessageId, ...location, from: mail.from, to: mail.to, subject: mail.subject })
  const response = await h.app.inject({
    method: 'POST',
    url: `/inbound/ses/${tenant.id}/${ses}`,
    payload: body,
    headers: { 'content-type': 'application/json', ...fakeSignatureHeaders(WEBHOOK_SECRET, body, h.clock.now(), { id: `sns-${sesMessageId}`, type: 'ses.notification' }) },
  })
  expect(response.statusCode, response.body).toBe(200)
  expect(await processReceipt(system(), (response.json() as { receiptId: string }).receiptId, newId(), inboundRuntime())).toBe('processed')
  const { id } = await first<{ id: string }>(`SELECT id FROM "InboundEmail" WHERE "sesMessageId" = $1`, [sesMessageId])
  await fetchInbound(runtime, system(), id)
  await sortInbound(system(), id)
  return first(`SELECT * FROM "InboundEmail" WHERE id = $1`, [id])
}

const pasted = (): RawAttachment[] => [
  { filename: '', contentType: 'image/jpeg', content: photo, contentId: 'photo-1' },
  { filename: 'logo.png', contentType: 'image/png', content: logo, contentId: 'logo-1' },
  { filename: 'banner.png', contentType: 'image/png', content: banner, contentId: 'banner-1' },
  { filename: 'banner.png', contentType: 'image/png', content: banner, contentId: 'banner-2' },
]
const html = '<p>Made-up: the sample, see the photo.</p><img src="cid:photo-1"><img src="cid:logo-1"><img src="cid:banner-1"><blockquote><img src="cid:banner-2"></blockquote>'

beforeAll(async () => {
  h = await startHarness('email_in_inline_pictures')
  tenant = await addTenant(h, 'th088-mail')
  const companyId = tenant.companies[0]!.id
  quotes = new Map([
    [alphaQuote, { companyId, partyId: alpha }],
    [betaQuote, { companyId, partyId: beta }],
  ])
  const quoteResolver: RecordResolver = async (client, id) => {
    const found = quotes.get(id)
    return found && (await client.company.findUnique({ where: { id: found.companyId }, select: { id: true } })) ? { companyId: found.companyId, siteId: null, partyId: found.partyId } : null
  }
  const partyResolver: RecordResolver = async (client, id) => {
    const found = await client.party.findUnique({ where: { id }, select: { companyId: true } })
    return found ? { companyId: found.companyId, siteId: null, partyId: id } : null
  }
  useThreadRecords({ Quote: quoteResolver, Party: partyResolver })
  useInbound({ secrets: h.secrets, clock: h.clock, environment: 'test' })
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant.id])
  ses = newId()
  await command(callerFor(h.database, { audience: 'office', tenantId: tenant.id, actorId: newId(), grants: [], requestId: newId() }), { name: 'integration.createAccount', input: { id: ses } }, async (tools) => {
    const webhook = await storeSecret(tools, h.secrets, { purpose: SECRET_PURPOSES.webhook, plaintext: WEBHOOK_SECRET })
    await tools.tx.integrationAccount.create({
      data: { id: ses, companyId, provider: 'SES', code: `ses-in-${ses.slice(-12)}`, label: 'Mail in (fake)', mode: 'FAKE', webhookSecretId: webhook.id, settings: { inboundBucket: BUCKET }, rateLimitPerMinute: 6000, rateLimitBurst: 1000 },
      select: { id: true },
    })
    tools.audit({ recordType: 'IntegrationAccount', recordId: ses })
    return null
  })
  bucket = new FakeMailBucket()
  const gateway = createGateway({ environment: 'test', redis: h.redis, prefix: h.redisPrefix, secrets: h.secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  const neverS3 = inboundS3Store({
    clientFor: () => {
      throw new Error('The inline-picture tests never call S3; use a FAKE account.')
    },
  })
  runtime = createEmailInRuntime({ gateway, fake: bucket, s3: neverS3, files: h.files })
  useEmailIn(runtime)
  await party(alpha, BRAND_ALPHA, ALPHA_CONTACT)
  await party(beta, BRAND_BETA, BETA_CONTACT)
}, 120_000)

afterAll(async () => {
  useThreadRecords(undefined)
  useInbound(undefined)
  useEmailIn(undefined)
  await h?.close()
}, 60_000)

describe('B-TH-088: pictures pasted in a mail are kept', () => {
  let betaThread: { id: string; token: string }
  let alphaThread: { id: string; token: string }
  let joined: Json

  it('brand B’s reply keeps its pasted photo as a file of brand B’s record, shared with brand B; the logo and the repeated banner stay out', async () => {
    betaThread = await openThread(betaQuote)
    alphaThread = await openThread(alphaQuote)
    const replyDomain = 'reply.th088.example.com'
    await admin(`UPDATE "Thread" SET "replyToken" = "replyToken" WHERE id = $1`, [betaThread.id])
    joined = await deliver({ from: `"${BRAND_BETA.contact.name}" <${BETA_CONTACT}>`, to: [`r-${betaThread.token}@${replyDomain}`], subject: 'Re: the sample', html, attachments: pasted() })
    expect(joined.attachments.map((part: Json) => [part.name, part.kept, part.reason ?? null])).toEqual([
      ['picture-1.jpg', true, null],
      ['logo.png', false, 'inline'],
      ['banner.png', false, 'inline'],
      ['banner.png', false, 'inline'],
    ])
    if (joined.status !== 'MATCHED') {
      // The tenant has no reply domain set: a known contact's mail joins its party's record by the sender instead (the same home).
      expect(joined.status).toBe('MATCHED')
    }
    const fileId = joined.attachments[0].fileId as string
    const file = await first(`SELECT "recordType", "recordId", "partyId", visibility::text[] AS visibility, "originalName", "contentType", sha256, status::text AS status FROM "StoredFile" WHERE id = $1`, [fileId])
    expect(file).toMatchObject({ partyId: beta, visibility: ['OFFICE', 'PARTNER'], originalName: 'picture-1.jpg', contentType: 'image/jpeg', sha256: sha(photo), status: 'AVAILABLE' })
    expect([betaQuote, beta]).toContain(file.recordId)
    const message = await first(`SELECT "threadId", "partyId", "attachmentFileIds" FROM "Message" WHERE id = $1`, [joined.messageId])
    expect(message).toMatchObject({ partyId: beta, attachmentFileIds: [fileId] })
    // The logo and the banner are no file anywhere.
    expect((await admin(`SELECT id FROM "StoredFile" WHERE "tenantId" = $1 AND sha256 = ANY($2::text[])`, [tenant.id, [sha(logo), sha(banner)]])).length).toBe(0)
  })

  it('W22: nothing of brand B’s picture reaches brand A’s record or thread', async () => {
    const files = await admin<{ recordType: string; recordId: string; partyId: string | null }>(`SELECT "recordType", "recordId", "partyId" FROM "StoredFile" WHERE "tenantId" = $1 AND sha256 = $2`, [tenant.id, sha(photo)])
    expect(files.length).toBe(1)
    expect(files.every((row) => row.partyId === beta && row.recordId !== alphaQuote && row.recordId !== alpha)).toBe(true)
    expect((await admin(`SELECT id FROM "StoredFile" WHERE "tenantId" = $1 AND ("recordId" = $2 OR "recordId" = $3)`, [tenant.id, alphaQuote, alpha])).length).toBe(0)
    const alphaMessages = await admin<{ attachmentFileIds: string[] }>(`SELECT "attachmentFileIds" FROM "Message" WHERE "threadId" = $1`, [alphaThread.id])
    expect(alphaMessages.flatMap((row) => row.attachmentFileIds)).toEqual([])
  })

  it('a mail held for a person keeps its pasted picture on the mail itself, office only, shared with nobody', async () => {
    const held = await deliver({ from: 'stranger.th088@elsewhere.example', to: [`r-${alphaThread.token}@reply.th088.example.com`], subject: 'Re: the quote', html: '<p>Made-up</p><img src="cid:photo-1">', attachments: [{ filename: 'sample.jpg', contentType: 'image/jpeg', content: Buffer.concat([photo, Buffer.from('held')]), contentId: 'photo-1' }] })
    expect(['HELD', 'TRIAGE']).toContain(held.status)
    expect(held.messageId).toBeNull()
    const fileId = held.attachments[0].fileId as string
    const file = await first(`SELECT "recordType", "recordId", "partyId", visibility::text[] AS visibility FROM "StoredFile" WHERE id = $1`, [fileId])
    expect(file).toEqual({ recordType: 'InboundEmail', recordId: held.id, partyId: null, visibility: ['OFFICE'] })
    expect((await admin(`SELECT id FROM "StoredFile" WHERE "tenantId" = $1 AND ("recordId" = $2 OR "recordId" = $3)`, [tenant.id, alphaQuote, alpha])).length).toBe(0)
  })
})
