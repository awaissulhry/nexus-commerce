import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { sesNotificationBody } from '../../../adapters/ses/testing'
import { callerFor, type CommandCaller } from '../../../core/command'
import { CSRF_HEADER } from '../../auth/sessions/cookies'
import { addTenant, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../auth/sessions/testing/harness'
import { processReceipt } from '../../inbound/process'
import { inboundRuntime, useInbound } from '../../inbound/providers'
import { fakeSignatureHeaders } from '../../inbound/verifiers'
import { systemContext } from '../../outbox/system'
import { useSecrets } from '../../secrets/service'
import { emailSendHandler } from '../outbound'
import { bounceTaskHandler } from './tasks'

/**
 * Delivery status in depth (B-W2b-394; COL-031 "each external message shows sent, delivered or bounced; a bounce makes a
 * task"; ML1:01 the FAKE mail account's webhook secret) with the app's real routes and real sessions (two-factor, step-up) on a
 * throwaway PostgreSQL 17 database from the migrations: the webhook secret is set through its route and then signs SES's
 * notifications end to end (the inbound route, the ledger's job, email out's processor and this step's), a mail is sent from a
 * customer's thread through the FAKE SES, bounces softly and hard, and the bounce's task reaches its sender. Made-up addresses
 * only. Run with `node scripts/factory/run-pg-tests.mjs platform/email-out/delivery-status`.
 */

let h: Harness
let tenant: TestTenant
let owner: Browser
let ownerSecret: string
let sales: Browser
let salesId = ''
let ses = ''
let secret = 'whsec_made_up_for_delivery_status_tests_0001'
const party = newId()

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const first = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const system = (): CommandCaller => callerFor(h.database, systemContext(tenant.id, newId()))
const outboundOf = (id: string) => first(`SELECT * FROM "EmailOutbound" WHERE id = $1`, [id])

/** A PUT as the browser would send it (its cookies and CSRF header). */
async function put(browser: Browser, url: string, body: unknown): Promise<{ status: number; body: Json }> {
  const cookie = [...browser.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  const response = await browser.app.inject({ method: 'PUT', url, headers: { cookie, ...(browser.csrfToken ? { [CSRF_HEADER]: browser.csrfToken } : {}) }, payload: body as object })
  return { status: response.statusCode, body: response.json() as Json }
}

const envelopeOf = (row: Json): EventEnvelope => ({
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
})

/** Sends a mail from the customer's thread as the sales person, and the worker sends it (FAKE SES): SENT with SES's id. */
async function sent(to: string): Promise<Json> {
  const answer = await sales.post(`/threads/Party/${party}/emails`, { to: [to], subject: 'Conferma taglie', body: 'Buongiorno, confermiamo le taglie.' })
  expect(answer.status, JSON.stringify(answer.body)).toBe(201)
  const id = answer.body.email.id as string
  const queued = await first(`SELECT * FROM "OutboxEvent" WHERE type = 'email.queued' AND subject = $1`, [id])
  await emailSendHandler(() => h.email).handle(envelopeOf(queued), { caller: system(), attempt: 1 })
  const row = await outboundOf(id)
  expect(row.status).toBe('SENT')
  return row
}

/** SES's notification, signed with the account's webhook secret, through the inbound route and the ledger's job. */
async function notify(body: string, signWith = secret): Promise<number> {
  const eventId = `sns-${newId()}`
  const response = await h.app.inject({ method: 'POST', url: `/inbound/ses/${tenant.id}/${ses}`, payload: body, headers: { 'content-type': 'application/json', ...fakeSignatureHeaders(signWith, body, h.clock.now(), { id: eventId, type: 'ses.notification' }) } })
  if (response.statusCode === 200) expect(await processReceipt(system(), (response.json() as Json).receiptId, newId(), inboundRuntime())).toBe('processed')
  return response.statusCode
}

/** The bounce-task handler over the events of a mail (as the worker would run it). */
async function tasksFor(outboundId: string): Promise<void> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE type IN ('email.status_changed', 'email.bounce_noted') AND subject = $1 ORDER BY "occurredAt", id`, [outboundId])
  for (const row of rows) await bounceTaskHandler().handle(envelopeOf(row), { caller: system(), attempt: 1 })
}

beforeAll(async () => {
  h = await startHarness('delivery_status')
  tenant = await addTenant(h, 'ds-a')
  useInbound({ secrets: h.secrets, clock: h.clock, environment: 'test' })
  // The route seals the value with the process's secrets: the harness's.
  useSecrets(h.secrets)
  const companyId = tenant.companies[0]!.id
  ses = (await first(`SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'SES'`, [tenant.id])).id
  // The company's record mail leaves from a verified CONVERSATION identity (made up) on the tenant's FAKE SES account.
  await h.database.withScope({ audience: 'office', tenantId: tenant.id, actorId: newId() }, async (client) => {
    await client.emailIdentity.create({
      data: { id: newId(), companyId, kind: 'CONVERSATION', domain: 'ds-a.example.invalid', fromAddress: 'noreply@ds-a.example.invalid', displayName: 'Made-up DS', displayNamePolicy: 'COMPANY', replyDomain: 'reply.ds-a.example.invalid', accountId: ses, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    await client.party.create({ data: { id: party, companyId, code: 'DS1', kind: 'ORGANISATION', legalName: 'Made-up Buyer S.r.l.', roles: ['CUSTOMER'] } })
    await client.partyContact.create({ data: { id: newId(), partyId: party, name: 'Made-up Buyer', email: 'buyer@buyer.example.invalid' } })
  })
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode) VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE')`, [newId(), tenant.id])
  const account = await addUser(h, tenant, { email: 'owner@ds-a.example.invalid', role: 'owner' })
  owner = new Browser(h.app)
  await owner.signIn('ds-a', account.email, account.password)
  ownerSecret = await enrolTotp(h, owner)
  const seller = await addUser(h, tenant, { email: 'sara.sales@ds-a.example.invalid', role: 'sales' })
  salesId = seller.id
  sales = new Browser(h.app)
  await sales.signIn('ds-a', seller.email, seller.password)
  await enrolTotp(h, sales)
}, 90_000)

afterAll(async () => {
  useInbound(undefined)
  useSecrets(undefined)
  await h?.close()
}, 60_000)

describe('the FAKE mail account’s webhook secret (ML1:01)', () => {
  it('is set with email.manage and a fresh code, then signs SES’s notifications end to end; a role without it, no code, a short value are refused', async () => {
    const before = await first(`SELECT version, "webhookSecretId" FROM "IntegrationAccount" WHERE id = $1`, [ses])
    expect(before.webhookSecretId).toBeNull()
    // Nothing verifies without a secret: SES's notification is refused.
    expect(await notify(sesNotificationBody({ snsMessageId: `sns-${newId()}`, eventType: 'Delivery', sesMessageId: 'ses-unknown', delivered: ['x@buyer.example.invalid'] }))).toBe(401)
    expect((await put(sales, `/email/ses-accounts/${ses}/webhook-secret`, { version: before.version, value: secret })).status).toBe(403)
    const noCode = await put(owner, `/email/ses-accounts/${ses}/webhook-secret`, { version: before.version, value: secret })
    expect(noCode.status).toBe(403)
    expect(noCode.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    await stepUp(h, owner, ownerSecret)
    const short = await put(owner, `/email/ses-accounts/${ses}/webhook-secret`, { version: before.version, value: 'too-short' })
    expect(short.status, JSON.stringify(short.body)).toBe(400)
    expect(short.body.error.issues[0].path).toBe('body/value')
    const saved = await put(owner, `/email/ses-accounts/${ses}/webhook-secret`, { version: before.version, value: secret })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body).toMatchObject({ accountId: ses, replaced: false, endsIn: secret.slice(-4) })
    const row = await first(`SELECT "webhookSecretId" FROM "IntegrationAccount" WHERE id = $1`, [ses])
    expect(await first(`SELECT purpose FROM "SecretValue" WHERE id = $1`, [row.webhookSecretId])).toEqual({ purpose: 'integration.webhook' })
    // The value is in no audit row, no event, no receipt.
    expect(JSON.stringify(await admin(`SELECT after, before FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'IntegrationAccount'`, [tenant.id]))).not.toContain(secret)
    expect(JSON.stringify(await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'email.webhook_secret_changed'`))).not.toContain(secret)
    expect(await notify(sesNotificationBody({ snsMessageId: `sns-${newId()}`, eventType: 'Delivery', sesMessageId: 'ses-unknown', delivered: ['x@buyer.example.invalid'] }))).toBe(200)
  })

  it('is replaced (the old one stops at once and its sealed value is deleted); a live account’s is not set here', async () => {
    const before = await first(`SELECT version, "webhookSecretId" FROM "IntegrationAccount" WHERE id = $1`, [ses])
    const fresh = 'whsec_made_up_replacement_for_delivery_tests_0002'
    const replaced = await put(owner, `/email/ses-accounts/${ses}/webhook-secret`, { version: before.version, value: fresh })
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200)
    expect(replaced.body.replaced).toBe(true)
    expect(await admin(`SELECT id FROM "SecretValue" WHERE id = $1`, [before.webhookSecretId])).toEqual([])
    expect(await notify(sesNotificationBody({ snsMessageId: `sns-${newId()}`, eventType: 'Delivery', sesMessageId: 'ses-unknown', delivered: ['x@buyer.example.invalid'] }))).toBe(401)
    const old = secret
    secret = fresh
    expect(await notify(sesNotificationBody({ snsMessageId: `sns-${newId()}`, eventType: 'Delivery', sesMessageId: 'ses-unknown', delivered: ['x@buyer.example.invalid'] }))).toBe(200)
    expect(old).not.toBe(secret)
    const live = newId()
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode) VALUES ($1, $2, 'SES', 'ses-live', 'Mail (live)', 'LIVE')`, [live, tenant.id])
    expect((await put(owner, `/email/ses-accounts/${live}/webhook-secret`, { version: 1, value: fresh })).status).toBe(409)
    expect((await put(owner, `/email/ses-accounts/${newId()}/webhook-secret`, { version: 1, value: fresh })).status).toBe(404)
  })
})

describe('the delivery status of each message (COL-031)', () => {
  it('a soft bounce keeps the mail SENT with its kind, shows as not delivered for now, and gives its sender a task', async () => {
    const mail = await sent('full@buyer.example.invalid')
    expect(await notify(sesNotificationBody({ snsMessageId: `sns-${newId()}`, eventType: 'Bounce', sesMessageId: mail.sesMessageId, bounce: { type: 'Transient', subType: 'MailboxFull', recipients: ['full@buyer.example.invalid'] } }))).toBe(200)
    expect(await outboundOf(mail.id)).toMatchObject({ status: 'SENT', bounceKind: 'TRANSIENT' })
    expect(await admin(`SELECT 1 FROM "Suppression" WHERE address = 'full@buyer.example.invalid'`)).toEqual([])
    await tasksFor(mail.id)
    await tasksFor(mail.id)
    const tasks = await admin(`SELECT * FROM "Task" WHERE "recordType" = 'Party' AND "recordId" = $1 AND "assigneeId" = $2`, [party, salesId])
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ status: 'OPEN', title: 'Mail non consegnata: Conferma taglie (DS1 Made-up Buyer S.r.l.)', createdById: null })
    const status = await sales.get(`/email/delivery-status?recordType=Party&recordId=${party}`)
    expect(status.status).toBe(200)
    expect(status.body.messages.find((entry: Json) => entry.outboundId === mail.id)).toMatchObject({ state: 'SOFT_BOUNCE', bounceKind: 'TRANSIENT', recipients: 1, task: { id: tasks[0]!.id, status: 'OPEN' }, messageId: mail.messageId })
  })

  it('a hard bounce makes the mail BOUNCED (kind PERMANENT) and its own task; a delivered mail shows delivered', async () => {
    const mail = await sent('gone@buyer.example.invalid')
    expect(await notify(sesNotificationBody({ snsMessageId: `sns-${newId()}`, eventType: 'Bounce', sesMessageId: mail.sesMessageId, bounce: { type: 'Permanent', recipients: ['gone@buyer.example.invalid'] } }))).toBe(200)
    expect(await outboundOf(mail.id)).toMatchObject({ status: 'BOUNCED', bounceKind: 'PERMANENT' })
    await tasksFor(mail.id)
    const task = await first(`SELECT * FROM "Task" WHERE "recordId" = $1 AND title LIKE 'Mail respinta%'`, [party])
    expect(task).toMatchObject({ assigneeId: salesId, recordLabel: 'DS1 Made-up Buyer S.r.l.' })
    const delivered = await sent('buyer@buyer.example.invalid')
    expect(await notify(sesNotificationBody({ snsMessageId: `sns-${newId()}`, eventType: 'Delivery', sesMessageId: delivered.sesMessageId, delivered: ['buyer@buyer.example.invalid'] }))).toBe(200)
    const status = (await sales.get(`/email/delivery-status?recordType=Party&recordId=${party}`)).body.messages as Json[]
    expect(status.find((entry) => entry.outboundId === mail.id)).toMatchObject({ state: 'BOUNCED', bounceKind: 'PERMANENT', task: { id: task.id } })
    expect(status.find((entry) => entry.outboundId === delivered.id)).toMatchObject({ state: 'DELIVERED', bounceKind: null, task: null })
    // A record the reader may not see is not found.
    expect((await sales.get(`/email/delivery-status?recordType=Party&recordId=${newId()}`)).status).toBe(404)
  })
})
