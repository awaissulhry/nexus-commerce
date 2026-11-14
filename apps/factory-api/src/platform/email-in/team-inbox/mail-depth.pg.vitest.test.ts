import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNotifyDepth, type NotifyDepthSeed } from '../../../../../../packages/factory-db/seed/notify-depth'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { FakeMailBucket } from '../../../adapters/ses-inbound/fake'
import { inboundS3Store } from '../../../adapters/ses-inbound/s3'
import { buildApp } from '../../../core/app'
import { callerFor, command, type CommandCaller } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { inquiryFromAddressHandler } from '../../../modules/sales/inquiries/from-mail'
import { startHarness, type Harness } from '../../auth/sessions/testing/harness'
import { createGateway } from '../../gateway/gateway'
import { processReceipt } from '../../inbound/process'
import { inboundRuntime, useInbound } from '../../inbound/providers'
import { fakeSignatureHeaders } from '../../inbound/verifiers'
import { fanOut } from '../../notifications/fan-out'
import type { EventHandler } from '../../outbox/dispatch'
import { systemContext } from '../../outbox/system'
import { SECRET_PURPOSES, storeSecret } from '../../secrets/store'
import { fetchInbound } from '../fetch'
import { createEmailInRuntime, useEmailIn, type EmailInRuntime } from '../service'
import { sortInbound } from '../sort'
import { rawMail, receivedNotificationBody, type RawMailInput, type ReceivedInput } from '../testing'
import { runFollowUps } from './follow-ups'
import { mailRouteHandler } from './route'

/**
 * Mail in depth (B-W2b-394; COL-021, COL-027, ML1:02, ML1:03) through the app's real routes and the worker's real steps on a
 * throwaway PostgreSQL 17 database from the migrations (row-level security and B-W2b-366's guards are real), on the seeds up
 * to notify-depth (company A's FAKE SES account and reply domain, its team inboxes Orders (owner + member) and Quotes
 * (member), its live capture address, the customer P1 with its buyer, the INQUIRY and SERVICE_CASE series). Mail arrives as SES
 * would send it: the raw mail in a FakeMailBucket, the notification through the signed inbound route, the worker's fetch and
 * sort, then this step's handlers (the route, the inquiry address) and the notifications' fan-out. Made-up words and addresses
 * only. Run with `node scripts/factory/run-pg-tests.mjs platform/email-in/team-inbox`.
 */

vi.setConfig({ testTimeout: 90_000 })

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'

const NS = 'w2b394-mail'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const P1 = idOf('party:P1')
const SES = idOf('email-in:account:ses')
const BUCKET = `factory-inbound-${NS}`
const REPLY = `reply.company-a.${NS}.example.com`
const SECRET = 'whsec_made_up_for_the_mail_depth_tests_0001'
const BUYER = 'buyer.p1@example.com'
const PDF = Buffer.from('%PDF-1.7\n% made-up photo report for the mail depth tests\n')

let h: Harness
let app: FastifyInstance
let seeded: NotifyDepthSeed
let bucket: FakeMailBucket
let runtime: EmailInRuntime
let MEMBER_MAIL = ''
const OUTSIDER = newId()
const run = randomBytes(4).toString('hex')
let serial = 0

const grantOf = (key: string, companies: Grant['companies']): Grant => {
  const template = templateOf(key)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => `money.${grain}` as Permission)], companies, sites: 'all', parties: 'all' }
}
const SESSIONS: Record<string, () => SessionContext> = {
  owner: () => ({ audience: 'office', tenantId: T, actorId: seeded.ownerId, grants: [grantOf('owner', 'all')] }),
  member: () => ({ audience: 'office', tenantId: T, actorId: seeded.memberId, grants: [grantOf('sales', [companyA])] }),
  outsider: () => ({ audience: 'office', tenantId: T, actorId: OUTSIDER, grants: [grantOf('sales', [companyA])] }),
  planner: () => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [grantOf('planner', 'all')] }),
}

const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const one = async (sql: string, values: unknown[] = []): Promise<Json> => (await admin(sql, values))[0]!
const system = (): CommandCaller => callerFor(h.database, systemContext(T, newId()))
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `md-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const mailOf = (id: string) => one(`SELECT * FROM "InboundEmail" WHERE id = $1`, [id])

/** The worker after a step: every outbox event since the mark through this step's handlers and the notifications' fan-out, until quiet. */
let mark = new Date(0)
const seen = new Set<string>()
async function settle(): Promise<void> {
  const handlers: EventHandler[] = [mailRouteHandler(() => runtime), inquiryFromAddressHandler()]
  for (let round = 0; round < 6; round += 1) {
    const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND "occurredAt" >= $2 ORDER BY "occurredAt", id`, [T, mark])
    const fresh = rows.filter((row) => !seen.has(row.id as string))
    if (fresh.length === 0) return
    for (const row of fresh) {
      seen.add(row.id as string)
      const envelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload } as EventEnvelope
      for (const handler of handlers) if (handler.events.includes(envelope.type)) await handler.handle(envelope, { caller: system(), attempt: 1 })
      await fanOut(system(), envelope)
    }
  }
}

/** SES receives a mail (raw bytes in the bucket, its notification through the signed route), the worker reads and sorts it, then settles. */
async function deliver(mail: Omit<RawMailInput, 'from'> & Pick<ReceivedInput, 'verdicts' | 'destination'> & { readonly from: string }): Promise<Json> {
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
    at: new Date(),
  })
  const response = await app.inject({ method: 'POST', url: `/inbound/ses/${T}/${SES}`, payload: body, headers: { 'content-type': 'application/json', ...fakeSignatureHeaders(SECRET, body, h.clock.now(), { id: `sns-${sesMessageId}`, type: 'ses.notification' }) } })
  expect(response.statusCode, response.body).toBe(200)
  expect(await processReceipt(system(), (response.json() as Json).receiptId, newId(), inboundRuntime())).toBe('processed')
  const { id } = await one(`SELECT id FROM "InboundEmail" WHERE "sesMessageId" = $1`, [sesMessageId])
  await fetchInbound(runtime, system(), id)
  await sortInbound(system(), id)
  await settle()
  return mailOf(id)
}

const message = (id: string) => one(`SELECT * FROM "Message" WHERE id = $1`, [id])
const thread = (id: string) => one(`SELECT * FROM "Thread" WHERE id = $1`, [id])
const notificationsOf = (userId: string, key: string) => admin(`SELECT * FROM "Notification" WHERE "tenantId" = $1 AND "userId" = $2 AND "messageKey" = $3`, [T, userId, key])
const worked = async (mailId: string) => (await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'email.inbound_worked' AND subject = $1 ORDER BY "occurredAt", id`, [mailId])).map((row) => row.payload.change as string)

beforeAll(async () => {
  h = await startHarness('mail_depth')
  await seedCore({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  seeded = await seedNotifyDepth({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  MEMBER_MAIL = (await one(`SELECT email FROM "User" WHERE id = $1`, [seeded.memberId])).email
  // An office person who sorts company A's mail but is a member of no inbox.
  const salesRole = (await one(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'sales'`, [T])).id
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, 'Made-up Outsider', 'ACTIVE')`, [OUTSIDER, T, `outsider.${run}@example.invalid`])
  await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, false, ARRAY[$5]::uuid[], now() - interval '30 days')`, [newId(), T, OUTSIDER, salesRole, companyA])
  // The seeded FAKE SES account signs with a made-up secret (the route of ML1:01 is proven in delivery-status's test).
  await command(callerFor(h.database, { audience: 'office', tenantId: T, actorId: seeded.ownerId, grants: [], requestId: newId() }), { name: 'integration.testSecret', input: { SES } }, async (tools) => {
    const stored = await storeSecret(tools, h.secrets, { purpose: SECRET_PURPOSES.webhook, plaintext: SECRET })
    await tools.tx.integrationAccount.update({ where: { id: SES }, data: { webhookSecretId: stored.id }, select: { id: true } })
    tools.audit({ recordType: 'IntegrationAccount', recordId: SES, after: { webhookSecret: 'set' } })
    return null
  })
  useInbound({ secrets: h.secrets, clock: h.clock, environment: 'test' })
  bucket = new FakeMailBucket()
  const gateway = createGateway({ environment: 'test', redis: h.redis, prefix: h.redisPrefix, secrets: h.secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  runtime = createEmailInRuntime({ gateway, fake: bucket, s3: inboundS3Store({ clientFor: () => { throw new Error('The mail depth tests never call S3.') } }), files: h.files })
  useEmailIn(runtime)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  mark = new Date()
}, 900_000)

afterAll(async () => {
  useInbound(undefined)
  useEmailIn(undefined)
  await app?.close()
  await h?.close()
}, 60_000)

describe('team inboxes (COL-027)', () => {
  let repairs: Json

  it('lists the inboxes a person works, with their address and counts; a manager sees every one', async () => {
    const mine = await ok('member', 'GET', `/email/team-inboxes?companyId=${companyA}`)
    expect(mine.inboxes.map((inbox: Json) => inbox.name)).toEqual(['Orders', 'Quotes'])
    expect(mine.inboxes[0]).toMatchObject({ localPart: 'orders', address: `orders@${REPLY}`, member: true, active: true })
    expect(mine.mayManage).toBe(false)
    expect((await ok('outsider', 'GET', `/email/team-inboxes?companyId=${companyA}`)).inboxes).toEqual([])
    const all = await ok('owner', 'GET', '/email/team-inboxes?includeOff=true')
    expect(all.inboxes.map((inbox: Json) => inbox.name).sort()).toEqual(['Old samples', 'Orders', 'Orders', 'Quotes'])
    expect(all.mayManage).toBe(true)
  })

  it('sets one up (name, address, members), refuses a reserved address and a second name, and switches it off', async () => {
    repairs = (await ok('owner', 'POST', '/email/team-inboxes', { companyId: companyA, name: 'Repairs', localPart: 'Repairs', memberIds: [seeded.memberId] }, 201)).inbox
    expect(repairs).toMatchObject({ name: 'Repairs', localPart: 'repairs', address: `repairs@${REPLY}`, members: [{ id: seeded.memberId }] })
    expect((await no('owner', 'POST', '/email/team-inboxes', { companyId: companyA, name: 'Replies', localPart: 'r-replies', memberIds: [] }, 400)).issues[0].path).toBe('body/localPart')
    expect((await no('owner', 'POST', '/email/team-inboxes', { companyId: companyA, name: 'Repairs', localPart: 'repairs2', memberIds: [] }, 400)).issues[0].path).toBe('body/name')
    // A member must sort the company's mail: the planner role does not.
    const planner = await one(`SELECT u.id FROM "User" u JOIN "RoleAssignment" a ON a."userId" = u.id JOIN "Role" r ON r.id = a."roleId" WHERE u."tenantId" = $1 AND r.key = 'planner' LIMIT 1`, [T])
    expect((await no('owner', 'POST', '/email/team-inboxes', { companyId: companyA, name: 'Planning', localPart: 'planning', memberIds: [planner.id] }, 400)).issues[0].path).toBe('body/memberIds/0')
    await no('member', 'POST', '/email/team-inboxes', { companyId: companyA, name: 'Mine', localPart: 'mine', memberIds: [] }, 403)
    const off = await ok('owner', 'PUT', `/email/team-inboxes/${repairs.id}`, { version: repairs.version, active: false })
    expect(off.inbox.active).toBe(false)
    const on = await ok('owner', 'PUT', `/email/team-inboxes/${repairs.id}`, { version: off.inbox.version, active: true })
    expect(on.inbox.active).toBe(true)
    expect((await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'email.team_inbox_changed' AND subject = $1 ORDER BY "occurredAt", id`, [repairs.id])).map((row) => row.payload.change)).toEqual(['CREATED', 'SWITCHED_OFF', 'SWITCHED_ON'])
  })

  let mailId = ''
  it('puts a mail to orders@ in Orders (the worker), and its members work it: take, give, snooze, close, reopen', async () => {
    const mail = await deliver({ from: 'nuovo.cliente@shop.example.invalid', to: [`orders@${REPLY}`], subject: 'Ordine nuovo', messageId: `<order-${run}@shop.example.invalid>`, text: 'Vorremmo ordinare 20 giacche.' })
    mailId = mail.id
    expect(mail).toMatchObject({ status: 'TRIAGE', teamInboxId: seeded.teamInboxIds.aOrders, assigneeId: null })
    expect(await worked(mailId)).toEqual(['ROUTED'])
    let queue = await ok('member', 'GET', `/email/team-inboxes/${seeded.teamInboxIds.aOrders}/mail?view=UNASSIGNED`)
    const row = queue.mails.find((entry: Json) => entry.id === mailId)
    expect(row).toMatchObject({ state: 'OPEN', assignee: null, mine: false, subject: 'Ordine nuovo' })
    // Given to the member by the owner: it leaves the unassigned queue, and the member is told.
    let answer = await ok('owner', 'POST', `/email/inbound/${mailId}/assignee`, { version: row.version, assigneeId: seeded.memberId })
    expect(answer.mail).toMatchObject({ assignee: { id: seeded.memberId }, state: 'OPEN' })
    await settle()
    expect(await notificationsOf(seeded.memberId, 'notifications.mail.assigned')).toHaveLength(1)
    queue = await ok('member', 'GET', `/email/team-inboxes/${seeded.teamInboxIds.aOrders}/mail?view=MINE`)
    expect(queue.mails.map((entry: Json) => entry.id)).toContain(mailId)
    expect((await ok('member', 'GET', `/email/team-inboxes/${seeded.teamInboxIds.aOrders}/mail?view=UNASSIGNED`)).mails.map((entry: Json) => entry.id)).not.toContain(mailId)
    // Refused: someone who is no member, a stale version, a follow-up without a thread, a snooze too soon.
    expect((await no('owner', 'POST', `/email/inbound/${mailId}/assignee`, { version: answer.mail.version, assigneeId: OUTSIDER }, 400)).issues[0].path).toBe('body/assigneeId')
    await no('owner', 'POST', `/email/inbound/${mailId}/close`, { version: answer.mail.version - 1 }, 409)
    await no('member', 'POST', `/email/inbound/${mailId}/follow-up`, { version: answer.mail.version, until: new Date(Date.now() + 86_400_000).toISOString() }, 409)
    await no('member', 'POST', `/email/inbound/${mailId}/snooze`, { version: answer.mail.version, until: new Date(Date.now() + 60_000).toISOString() }, 400)
    await no('outsider', 'POST', `/email/inbound/${mailId}/close`, { version: answer.mail.version }, 404)
    answer = await ok('member', 'POST', `/email/inbound/${mailId}/snooze`, { version: answer.mail.version, until: new Date(Date.now() + 2 * 3_600_000).toISOString() })
    expect(answer.mail.state).toBe('SNOOZED')
    expect((await ok('member', 'GET', `/email/team-inboxes/${seeded.teamInboxIds.aOrders}/mail?view=OPEN`)).mails.map((entry: Json) => entry.id)).not.toContain(mailId)
    answer = await ok('member', 'POST', `/email/inbound/${mailId}/snooze`, { version: answer.mail.version, until: null })
    answer = await ok('member', 'POST', `/email/inbound/${mailId}/close`, { version: answer.mail.version })
    expect(answer.mail).toMatchObject({ state: 'CLOSED' })
    expect((await ok('member', 'GET', `/email/team-inboxes/${seeded.teamInboxIds.aOrders}/mail?view=CLOSED`)).mails.map((entry: Json) => entry.id)).toContain(mailId)
    await no('member', 'POST', `/email/inbound/${mailId}/close`, { version: answer.mail.version }, 409)
    answer = await ok('member', 'POST', `/email/inbound/${mailId}/reopen`, { version: answer.mail.version })
    expect(answer.mail.state).toBe('OPEN')
    // Moved to Quotes (the member works both); its assignee is a member there, so it stays theirs.
    answer = await ok('member', 'POST', `/email/inbound/${mailId}/team-inbox`, { version: answer.mail.version, teamInboxId: seeded.teamInboxIds.aQuotes })
    expect(answer.mail).toMatchObject({ teamInboxId: seeded.teamInboxIds.aQuotes, assignee: { id: seeded.memberId } })
    expect(await worked(mailId)).toEqual(['ROUTED', 'ASSIGNED', 'SNOOZED', 'WOKEN', 'CLOSED', 'REOPENED', 'MOVED'])
    const audit = await admin(`SELECT action FROM "AuditLog" WHERE "recordType" = 'InboundEmail' AND "recordId" = $1`, [mailId])
    expect(audit.length).toBeGreaterThanOrEqual(7)
  })

  it('a follow-up on a mail in a thread cancels itself when the partner answers there, and comes back when nobody does', async () => {
    const mail = await deliver({ from: 'Seed Buyer One <buyer.p1@example.com>', to: [`quotes@${REPLY}`], subject: 'Domanda sui tempi', messageId: `<ask-${run}@example.com>`, text: 'Quando arrivano le giacche?' })
    // A known contact with a passing DMARC: in P1's own thread, and in Quotes.
    expect(mail).toMatchObject({ status: 'MATCHED', matchedBy: 'SENDER', teamInboxId: seeded.teamInboxIds.aQuotes })
    let answer = await ok('member', 'POST', `/email/inbound/${mail.id}/follow-up`, { version: mail.version, until: new Date(Date.now() + 3 * 86_400_000).toISOString() })
    expect(answer.mail.followUpUntil).not.toBeNull()
    answer = await ok('member', 'POST', `/email/inbound/${mail.id}/close`, { version: answer.mail.version })
    // The partner answers in the same thread: the database clears the follow-up of the earlier mail.
    await deliver({ from: 'Seed Buyer One <buyer.p1@example.com>', to: [`quotes@${REPLY}`], subject: 'Re: Domanda sui tempi', messageId: `<ask2-${run}@example.com>`, text: 'Scusate, ho trovato la risposta.' })
    expect(await mailOf(mail.id)).toMatchObject({ followUpUntil: null, closedAt: expect.any(Date) })
    // Another follow-up whose time passed with no answer: the cron brings the mail back, open, and tells its assignee.
    const again = await mailOf(mail.id)
    answer = await ok('member', 'POST', `/email/inbound/${mail.id}/assignee`, { version: again.version, assigneeId: seeded.memberId })
    answer = await ok('member', 'POST', `/email/inbound/${mail.id}/follow-up`, { version: answer.mail.version, until: new Date(Date.now() + 86_400_000).toISOString() })
    await admin(`UPDATE "InboundEmail" SET "followUpUntil" = now() - interval '1 minute' WHERE id = $1`, [mail.id])
    const result = await runFollowUps({ database: h.database, log: { info() {}, warn() {}, error() {} } })
    expect(result.due).toBeGreaterThanOrEqual(1)
    expect(await mailOf(mail.id)).toMatchObject({ followUpUntil: null, closedAt: null })
    await settle()
    expect(await notificationsOf(seeded.memberId, 'notifications.mail.followUpDue')).toHaveLength(1)
    expect(await worked(mail.id)).toContain('FOLLOW_UP_DUE')
  })
})

describe('the capture address (COL-021)', () => {
  let address = ''

  it('is read by whoever writes mail, replaced by a manager (the old one off in the same step), refused without the one it replaces', async () => {
    const read = await ok('member', 'GET', `/email/capture?companyId=${companyA}`)
    expect(read).toMatchObject({ receivingDomain: REPLY, mayManage: false, capture: { id: seeded.captureIds.aLive, defaultTeamInbox: { id: seeded.teamInboxIds.aOrders } } })
    expect(read.capture.address).toMatch(new RegExp(`^c-[a-z2-7]{26}@${REPLY.replace(/\./g, '\\.')}$`))
    await no('owner', 'POST', '/email/capture', { companyId: companyA }, 409)
    await no('member', 'POST', '/email/capture', { companyId: companyA, replacing: { id: read.capture.id, version: read.capture.version } }, 403)
    const made = await ok('owner', 'POST', '/email/capture', { companyId: companyA, replacing: { id: read.capture.id, version: read.capture.version } }, 201)
    expect(made.capture.address).not.toBe(read.capture.address)
    expect(made.capture.defaultTeamInbox.id).toBe(seeded.teamInboxIds.aOrders)
    expect((await one(`SELECT "revokedAt" FROM "CaptureAddress" WHERE id = $1`, [read.capture.id])).revokedAt).not.toBeNull()
    address = made.capture.address
    // The token never reaches the audit log.
    const audit = await admin(`SELECT after FROM "AuditLog" WHERE "recordType" = 'CaptureAddress' AND "recordId" = $1`, [made.capture.id])
    expect(JSON.stringify(audit)).not.toContain(address.slice(2, 28))
  })

  it('a forwarded mail joins the record its subject names, as the partner wrote it, with its file', async () => {
    const mail = await deliver({
      from: MEMBER_MAIL,
      to: [address],
      subject: 'Fwd: SEED-INQ-0004 foto',
      messageId: `<fwd-${run}@example.com>`,
      text: `Ciao, guarda qui sotto.\n\n---------- Forwarded message ---------\nFrom: Seed Buyer One <${BUYER}>\nDate: Mon, 9 Nov 2026\nSubject: foto\n\nEcco le foto del difetto.`,
      attachments: [{ filename: 'difetto.pdf', contentType: 'application/pdf', content: PDF }],
    })
    expect(mail).toMatchObject({ status: 'MATCHED', matchedBy: 'MANUAL', sortedById: seeded.memberId, senderPartyId: P1 })
    const written = await message(mail.messageId)
    expect(written).toMatchObject({ direction: 'INBOUND', authorKind: 'PARTY', authorName: 'Seed Buyer One', audience: 'PARTNER', partyId: P1 })
    expect(written.bodyText).toMatch(/^---------- Forwarded message/)
    expect(written.bodyText).not.toContain('guarda qui sotto')
    expect(written.attachmentFileIds).toHaveLength(1)
    const where = await thread(mail.threadId)
    const inquiry = await one(`SELECT id FROM "Inquiry" WHERE "tenantId" = $1 AND number = 'SEED-INQ-0004'`, [T])
    expect(where).toMatchObject({ recordType: 'Inquiry', recordId: inquiry.id })
    expect(await one(`SELECT "recordType", "recordId", "partyId" FROM "StoredFile" WHERE id = $1`, [written.attachmentFileIds[0]])).toMatchObject({ recordType: 'Inquiry', recordId: inquiry.id, partyId: P1 })
  })

  it('a BCC of a person’s own mail joins the customer’s thread as that person’s mail', async () => {
    const mail = await deliver({ from: MEMBER_MAIL, to: [BUYER], destination: [BUYER, address], subject: 'Conferma consegna', messageId: `<bcc-${run}@example.com>`, text: 'Buongiorno, confermo la consegna di venerdì.' })
    expect(mail).toMatchObject({ status: 'MATCHED', matchedBy: 'MANUAL' })
    const written = await message(mail.messageId)
    expect(written).toMatchObject({ direction: 'INBOUND', authorKind: 'USER', authorId: seeded.memberId, bodyText: 'Buongiorno, confermo la consegna di venerdì.' })
    expect(await thread(mail.threadId)).toMatchObject({ recordType: 'Party', recordId: P1 })
  })

  it('what it cannot place waits in Mail to sort, in its default team inbox: a stranger, an unknown partner', async () => {
    const stranger = await deliver({ from: 'someone@elsewhere.example.invalid', to: [address], subject: 'Fwd: ciao', messageId: `<str-${run}@elsewhere.example.invalid>`, text: 'From: Seed Buyer One <buyer.p1@example.com>\n\nCiao' })
    expect(stranger).toMatchObject({ status: 'TRIAGE', teamInboxId: seeded.teamInboxIds.aOrders })
    expect(await worked(stranger.id)).toEqual(['CAPTURED'])
    const unknown = await deliver({ from: MEMBER_MAIL, to: [address], subject: 'Fwd: domanda', messageId: `<unk-${run}@example.com>`, text: '---------- Forwarded message ---------\nFrom: Chi <chi@nowhere.example.invalid>\n\nUna domanda.' })
    expect(unknown).toMatchObject({ status: 'TRIAGE', teamInboxId: seeded.teamInboxIds.aOrders })
  })
})

describe('inquiries from an inquiry address (ML1:02) and a service case from a mail (ML1:03)', () => {
  it('keeps the addresses per company: at a receiving domain, once in the tenant; a role without the sales settings is refused', async () => {
    const before = await ok('owner', 'GET', `/sales/inquiries/addresses?companyId=${companyA}`)
    expect(before.mayManage).toBe(true)
    const scope = before.hasOwnSettings ? { companyId: companyA } : {}
    const version = before.hasOwnSettings ? before.version : (await ok('owner', 'GET', '/sales/inquiries/addresses')).version
    expect((await no('owner', 'PUT', '/sales/inquiries/addresses', { ...scope, version, addresses: ['offerte@elsewhere.example.invalid'] }, 400)).issues[0].path).toBe('body/addresses/0')
    await no('member', 'PUT', '/sales/inquiries/addresses', { ...scope, version, addresses: [`offerte@${REPLY}`] }, 403)
    const saved = await ok('owner', 'PUT', '/sales/inquiries/addresses', { ...scope, version, addresses: [`Offerte@${REPLY}`] })
    expect(saved.addresses).toEqual([`offerte@${REPLY}`])
    expect((await ok('member', 'GET', `/sales/inquiries/addresses?companyId=${companyA}`)).addresses).toEqual([`offerte@${REPLY}`])
  })

  it('a stranger’s mail to it makes an inquiry by itself (a prospect); Mail to sort no longer lists it', async () => {
    const mail = await deliver({ from: 'Moto Club Esempio <club@moto.example.invalid>', to: [`offerte@${REPLY}`], subject: 'Preventivo 40 giacche', messageId: `<rfq-${run}@moto.example.invalid>`, text: 'Buongiorno, ci servono 40 giacche.' })
    expect(mail.status).toBe('TRIAGE')
    const inquiry = await one(`SELECT * FROM "Inquiry" WHERE "sourceEmailId" = $1`, [mail.id])
    expect(inquiry).toMatchObject({ source: 'MAIL', status: 'NEW', partyId: null, prospectEmail: 'club@moto.example.invalid', createdById: null })
    expect(inquiry.request).toMatch(/^Preventivo 40 giacche/)
    const triage = await ok('member', 'GET', '/email/inbound?limit=200')
    expect(triage.mails.map((entry: Json) => entry.id)).not.toContain(mail.id)
    const draft = await ok('member', 'GET', `/sales/inquiries/from-mail/${mail.id}`)
    expect(draft.inquiry).toMatchObject({ number: inquiry.number })
    // The handler again: no second inquiry.
    await settle()
    expect(await admin(`SELECT id FROM "Inquiry" WHERE "sourceEmailId" = $1`, [mail.id])).toHaveLength(1)
  })

  it('a known customer’s mail to it (in their thread already) makes their inquiry', async () => {
    const mail = await deliver({ from: `Seed Buyer One <${BUYER}>`, to: [`offerte@${REPLY}`], subject: 'Nuova richiesta', messageId: `<rfq2-${run}@example.com>`, text: 'Altre 10 giacche, grazie.' })
    expect(mail).toMatchObject({ status: 'MATCHED', matchedBy: 'SENDER' })
    expect(await one(`SELECT "partyId", "contactId", source FROM "Inquiry" WHERE "sourceEmailId" = $1`, [mail.id])).toMatchObject({ partyId: P1, source: 'MAIL', contactId: expect.any(String) })
  })

  it('opens a service case from a waiting mail in one step: the case, the mail in its thread with its file', async () => {
    const mail = await deliver({ from: 'rider@moto.example.invalid', to: [`assistenza@${REPLY}`], subject: 'Cerniera rotta', messageId: `<svc-${run}@moto.example.invalid>`, text: 'La cerniera della giacca si è rotta.', attachments: [{ filename: 'foto.pdf', contentType: 'application/pdf', content: PDF }] })
    expect(mail.status).toBe('TRIAGE')
    await no('planner', 'POST', `/sales/service/cases/from-mail/${mail.id}`, { version: mail.version, kind: 'WARRANTY', partyId: P1 }, 403)
    await no('member', 'POST', `/sales/service/cases/from-mail/${mail.id}`, { version: mail.version, kind: 'WARRANTY' }, 400)
    await no('member', 'POST', `/sales/service/cases/from-mail/${mail.id}`, { version: mail.version + 5, kind: 'WARRANTY', partyId: P1 }, 409)
    const made = await ok('member', 'POST', `/sales/service/cases/from-mail/${mail.id}`, { version: mail.version, kind: 'WARRANTY', partyId: P1 }, 201)
    expect(made.case).toMatchObject({ channel: 'MAIL', status: 'NEW' })
    expect(made.case.problem).toMatch(/^Cerniera rotta/)
    expect(made.mail.status).toBe('MATCHED')
    const after = await mailOf(mail.id)
    expect(after).toMatchObject({ status: 'MATCHED', matchedBy: 'MANUAL', sortedById: seeded.memberId })
    expect(await thread(after.threadId)).toMatchObject({ recordType: 'ServiceCase', recordId: made.case.id })
    expect((await message(after.messageId)).attachmentFileIds).toHaveLength(1)
    await no('member', 'POST', `/sales/service/cases/from-mail/${mail.id}`, { version: after.version, kind: 'WARRANTY', partyId: P1 }, 409)
  })
})
