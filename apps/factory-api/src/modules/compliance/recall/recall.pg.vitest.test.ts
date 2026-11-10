import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { publicDocCodeOf } from '@nexus/factory-domain/compliance/public-doc/code'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedRecall, type RecallSeed } from '../../../../../../packages/factory-db/seed/recall'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, COMMAND_SETTINGS, runCommand } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { ensureThread, writeMessage } from '../../../platform/threads/threads'
import { readPublicNotices } from '../public-doc/notice'
import { guarded } from './common'
import { distributorHandlers } from './distributors'

/**
 * Recall, withdrawal and authority (B-W2b-260; PRD-387, PRD-388, PRD-390; RG1:01, RG1:02) through the app's real routes on a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and B-W2b-222's recall guards
 * are real), on the recall seed (SEED-REG-2026-901 RECALL risk YES, -902 WITHDRAWAL risk NO, -903 AUTHORITY_REQUEST, all
 * OPEN, of SEED-JKT-02 with batch SEED-BT-0001: SEED-WO-0001 in progress, SEED-SH-0001 shipped to SEED-C1 with 2 garments,
 * SEED-SH-0002 a draft). The quality person who speaks outward uses the harness's real sign-in (two-factor, step-up). Every
 * name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/compliance/recall`.
 */

let h: Harness
let app: FastifyInstance
let seeded: RecallSeed

const NS = 'w2b260-recall'
const idOf = (key: string): string => seedUuid(NS, key)
const T = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B') }
const TENANT: TestTenant = { id: T.tenant, slug: NS, companies: [{ id: T.companyA, code: 'A' }, { id: T.companyB, code: 'B' }] }
const KEEPER: Permission[] = [
  'compliance.register.view',
  'compliance.register.manage',
  'compliance.recall.manage',
  'quality.holds.view',
  'quality.holds.place',
  'threads.read',
  'threads.post',
  'files.read',
  'files.upload',
]
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  keeper: { audience: 'office', tenantId: T.tenant, actorId: idOf('actor'), grants: [grant(KEEPER)] },
  viewer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['compliance.register.view'])] },
  companyB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(KEEPER, [T.companyB])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
let keys = 0
const key = () => `rc-${++keys}-${newId()}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const eventsOf = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T.tenant, type])).map((row) => row.payload)
const entryRow = async (entryId: string) => (await admin<Json>('SELECT "authorityNotifiedAt", "authorityReference", "distributorsInformedAt", status FROM "PpeRegisterEntry" WHERE id = $1', [entryId]))[0]!

interface Person {
  readonly browser: Browser
  readonly secret: string
}
let quality: Person
async function asPerson(method: 'GET' | 'POST', url: string, body: unknown, status: number): Promise<Json> {
  const answer = await quality.browser.send(method, url, body, { headers: { 'idempotency-key': key() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

beforeAll(async () => {
  h = await startHarness('w2b260_recall')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedReasons({ db: h.database, namespace: NS })
  await seedEmail({ db: h.database, namespace: NS })
  seeded = await seedRecall({ db: h.database, namespace: NS })
  // The system roles as the templates hold them now (compliance.recall.* for the quality inspector).
  await h.database.withScope({ audience: 'office', tenantId: T.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  const user = await addUser(h, TENANT, { email: 'quality.recall@example.com', role: 'quality_inspector' })
  const browser = new Browser(h.app)
  const answer = await browser.signIn(TENANT.slug, user.email, user.password)
  if ((answer.body as Json)?.status !== 'signed_in') throw new Error(`sign-in: ${answer.status} ${JSON.stringify(answer.body)}`)
  quality = { browser, secret: await enrolTotp(h, browser) }
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the register reads its new kinds', () => {
  it('lists the withdrawal and the authority-request entries and reads their source', async () => {
    const list = await ok('viewer', 'GET', '/compliance/register')
    const kinds = Object.fromEntries(list.entries.map((entry: Json) => [entry.reference, entry.kind]))
    expect(kinds).toMatchObject({ 'SEED-REG-2026-901': 'RECALL', 'SEED-REG-2026-902': 'WITHDRAWAL', 'SEED-REG-2026-903': 'AUTHORITY_REQUEST' })
    const request = await ok('viewer', 'GET', `/compliance/register/${seeded.entryIds.request}`)
    expect(request.entry.source).toEqual({ type: 'AuthorityRequest', id: seeded.requestIds.answered })
    expect((await ok('viewer', 'GET', '/compliance/register?kind=WITHDRAWAL')).entries.map((entry: Json) => entry.reference)).toEqual(['SEED-REG-2026-902'])
  })
})

describe('the non-conformity decision and the authority notice (PRD-387)', () => {
  let notice: Json

  it('drafts a notice per market from the entry in the market languages', async () => {
    notice = (await ok('keeper', 'POST', `/compliance/register/${seeded.entryIds.recall}/authority-notices`, { marketCode: 'CH', authorityName: 'Made-up Federal Surveillance Office', channel: 'AUTHORITY_SITE' }, 201)).notice
    expect(notice).toMatchObject({ status: 'DRAFT', decision: 'RISK', marketCode: 'CH', law: 'Reg. (EU) 2016/425 art. 8(8)', entry: { reference: 'SEED-REG-2026-901' }, may: { edit: true, send: false, cancel: true } })
    expect(Object.keys(notice.words).sort()).toEqual(['de', 'fr', 'it'])
    expect(notice.words.it).toContain('DPI che presenta un rischio')
    expect(await no('keeper', 'POST', `/compliance/register/${seeded.entryIds.recall}/authority-notices`, { marketCode: 'ZZ', authorityName: 'Nobody', channel: 'EMAIL' }, 400)).toMatchObject({ issues: [{ path: 'body/marketCode' }] })
    await no('viewer', 'POST', `/compliance/register/${seeded.entryIds.recall}/authority-notices`, { marketCode: 'IT', authorityName: 'Made-up', channel: 'EMAIL' }, 403)
    await no('companyB', 'GET', `/compliance/authority-notices/${notice.id}`, undefined, 404)
    const edited = (await ok('keeper', 'PATCH', `/compliance/authority-notices/${notice.id}`, { version: notice.version, words: { ...notice.words, en: 'Made-up notice words in English.' } })).notice
    expect(Object.keys(edited.words)).toContain('en')
    notice = edited
    const pdf = await call('viewer', 'GET', `/compliance/authority-notices/${notice.id}/pdf?language=it`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toContain('application/pdf')
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    expect((await eventsOf('authority_notice.changed')).map((event) => event.change)).toEqual(['DRAFTED', 'EDITED'])
  })

  it('is marked as sent by a person with a fresh code, and the entry gets its date and reference', async () => {
    const url = `/compliance/authority-notices/${notice.id}/sent`
    expect((await asPerson('POST', url, { version: notice.version, reference: 'MADEUP-CH-0001' }, 403)).error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    await stepUp(h, quality.browser, quality.secret)
    const sent = (await asPerson('POST', url, { version: notice.version, reference: 'MADEUP-CH-0001' }, 200)).notice
    expect(sent).toMatchObject({ status: 'SENT', reference: 'MADEUP-CH-0001', sentBy: { name: expect.any(String) }, may: { edit: false, cancel: false } })
    const entry = await entryRow(seeded.entryIds.recall)
    expect(entry.authorityNotifiedAt).not.toBeNull()
    expect(entry.authorityReference).toBe('MADEUP-CH-0001')
    // Sent once; never cancelled.
    expect((await asPerson('POST', url, { version: sent.version }, 409)).error.message).toContain('sent already')
    await no('keeper', 'POST', `/compliance/authority-notices/${notice.id}/cancel`, { version: sent.version, reason: 'Made-up' }, 409)
    expect(await no('keeper', 'POST', `/compliance/authority-notices/${notice.id}/reference`, { version: sent.version, reference: 'ANOTHER' }, 409)).toMatchObject({ issues: [{ path: 'body/reference' }] })
  })

  it('refuses to report a risk the entry did not decide (409 in words), and lists the tiles', async () => {
    const risky = (await ok('keeper', 'POST', `/compliance/register/${seeded.entryIds.withdrawal}/authority-notices`, { marketCode: 'IT', authorityName: 'Made-up Ufficio di vigilanza', channel: 'PEC', decision: 'RISK' }, 201)).notice
    expect(risky.may.send).toBe(false)
    const refused = await asPerson('POST', `/compliance/authority-notices/${risky.id}/sent`, { version: risky.version }, 409)
    expect(refused.error.issues).toEqual([{ path: 'problem/RISK_NOT_DECIDED', message: expect.stringContaining('risk YES') }])
    const cancelled = (await ok('keeper', 'POST', `/compliance/authority-notices/${risky.id}/cancel`, { version: risky.version, reason: 'Made-up: the risk is NO.' })).notice
    expect(cancelled.status).toBe('CANCELLED')
    const list = await ok('viewer', 'GET', `/compliance/authority-notices?entryId=${seeded.entryIds.recall}`)
    expect(list.notices.length).toBeGreaterThanOrEqual(3)
    expect(list.tiles.sentThisYear).toBeGreaterThanOrEqual(2)
  })
})

describe('the recall and withdrawal workflow (PRD-388)', () => {
  let recall: Json

  it('drafts a withdrawal from the entry with its trace, numbered from the RECALL series', async () => {
    recall = (await ok('keeper', 'POST', `/compliance/register/${seeded.entryIds.withdrawal}/recalls`, { kind: 'WITHDRAWAL', noticeLanguages: ['it', 'en'] }, 201)).recall
    expect(recall).toMatchObject({ kind: 'WITHDRAWAL', status: 'DRAFT', scope: { wholeStyle: false, batchNumbers: ['SEED-BT-0001'] }, style: { code: 'SEED-JKT-02' } })
    expect(recall.number).toMatch(/^RCL-\d{4}-\d{4}$/)
    expect(Object.keys(recall.publicNotice).sort()).toEqual(['en', 'it'])
    expect(recall.trace.customers.map((customer: Json) => customer.code)).toEqual(['SEED-C1'])
    // SEED-WO-0001 is in progress (garments still here); SEED-SH-0002, the draft shipment, carries another style's batch.
    expect(recall.holdable).toEqual({ workOrders: 1, serials: 0, shipments: 0 })
    expect(await no('keeper', 'POST', `/compliance/register/${seeded.entryIds.withdrawal}/recalls`, { kind: 'RECALL', workOrderIds: [newId()] }, 400)).toMatchObject({ issues: [{ path: 'body/workOrderIds/0' }] })
  })

  it('holds what is still here through quality/holds, one hold per kind and site', async () => {
    const answer = await ok('keeper', 'POST', `/compliance/recalls/${recall.id}/holds`, { version: recall.version, reasonCode: 'QUALITY_CHECK' })
    expect(answer.placed.map((hold: Json) => hold.subjectType)).toEqual(['WorkOrder'])
    expect(answer.recall.holds).toHaveLength(1)
    const sources = await admin<{ sourceType: string; sourceId: string; subjectType: string }>('SELECT "sourceType", "sourceId", "subjectType" FROM "QualityHold" WHERE "sourceId" = $1', [recall.id])
    expect(sources.every((row) => row.sourceType === 'RecallAction')).toBe(true)
    expect((await admin<{ status: string }>(`SELECT status FROM "WorkOrder" WHERE id = $1`, [seeded.workOrderId]))[0]!.status).toBe('ON_HOLD')
    // Everything still here is held now.
    expect((await no('keeper', 'POST', `/compliance/recalls/${recall.id}/holds`, { version: answer.recall.version, reasonCode: 'QUALITY_CHECK' }, 409)).message).toContain('on hold already')
    recall = answer.recall
  })

  it('starts with one progress row per shipment that left, then records returns per customer', async () => {
    recall = (await ok('keeper', 'POST', `/compliance/recalls/${recall.id}/start`, { version: recall.version })).recall
    expect(recall).toMatchObject({ status: 'ACTIVE', startedBy: { id: idOf('actor') } })
    expect(recall.progressRows.map((row: Json) => [row.party.code, row.shipment?.number, row.unitsSent, row.unitsStillOut])).toEqual([['SEED-C1', 'SEED-SH-0001', 2, 2]])
    const row = recall.progressRows[0]
    expect(await no('keeper', 'PATCH', `/compliance/recalls/${recall.id}/progress/${row.id}`, { version: row.version, unitsReturned: 2, unitsDestroyed: 1 }, 400)).toMatchObject({ issues: [{ path: 'body/unitsReturned' }] })
    recall = (await ok('keeper', 'PATCH', `/compliance/recalls/${recall.id}/progress/${row.id}`, { version: row.version, unitsReturned: 1 })).recall
    expect(recall.progress).toMatchObject({ unitsSent: 2, unitsReturned: 1, unitsStillOut: 1, percentDone: 50 })
    await no('keeper', 'POST', `/compliance/recalls/${recall.id}/progress`, { partyId: row.party.id, unitsSent: 1 }, 409)
    // Once started the scope only widens: what is given is added.
    recall = (await ok('keeper', 'PATCH', `/compliance/recalls/${recall.id}`, { version: recall.version, batchNumbers: ['MADEUP-BT-9'] })).recall
    expect(recall.scope.batchNumbers).toEqual(['SEED-BT-0001', 'MADEUP-BT-9'])
    expect((await eventsOf('recall.changed')).map((event) => event.change)).toEqual(expect.arrayContaining(['DRAFTED', 'HOLDS_PLACED', 'STARTED', 'WIDENED']))
  })

  it('publishes its public notice with a fresh code: first on the public DoC page of the batch, then taken down', async () => {
    await stepUp(h, quality.browser, quality.secret)
    const published = (await asPerson('POST', `/compliance/recalls/${recall.id}/notice/publish`, { version: recall.version }, 200)).recall
    expect(published.notice.live).toBe(true)
    expect([...published.notice.languages].sort()).toEqual(['en', 'it'])
    const system = callerFor(h.database, systemContext(T.tenant, newId()))
    const page = await system.withClient((client) => readPublicNotices(client, { tenantId: T.tenant, kind: 'BATCH', id: seeded.workOrderId }))
    expect(page.map((entry) => entry.number)).toContain(recall.number)
    expect(page.find((entry) => entry.number === recall.number)).toMatchObject({ kind: 'WITHDRAWAL', reach: 'BATCH', batches: ['SEED-BT-0001'], words: { en: { title: expect.any(String) } } })
    const lookup = await h.app.inject({ method: 'POST', url: '/public/doc/lookup', payload: { code: publicDocCodeOf(seeded.workOrderId) } })
    expect(lookup.statusCode, lookup.body).toBe(200)
    expect(lookup.json().page.notices.map((entry: Json) => entry.number)).toContain(recall.number)
    // A published notice only gains languages.
    expect((await no('keeper', 'PATCH', `/compliance/recalls/${recall.id}`, { version: published.version, publicNotice: { it: { title: 'Altro', problem: 'Altro', action: 'Altro', contact: 'Altro' } } }, 409)).message).toContain('published')
    const taken = (await ok('keeper', 'POST', `/compliance/recalls/${recall.id}/notice/withdraw`, { version: published.version })).recall
    expect(taken.notice.live).toBe(false)
    const after = await system.withClient((client) => readPublicNotices(client, { tenantId: T.tenant, kind: 'BATCH', id: seeded.workOrderId }))
    expect(after.map((entry) => entry.number)).not.toContain(recall.number)
    recall = taken
  })

  it('closes with how it ended; a draft is cancelled, never closed', async () => {
    const closed = (await ok('keeper', 'POST', `/compliance/recalls/${recall.id}/close`, { version: recall.version, closeNote: 'Made-up: one garment returned, the customer kept one on hold.' })).recall
    expect(closed).toMatchObject({ status: 'CLOSED', closedBy: { id: idOf('actor') }, may: { edit: false, close: false } })
    await no('keeper', 'POST', `/compliance/recalls/${recall.id}/cancel`, { version: closed.version, reason: 'Made-up' }, 409)
    const draft = await ok('viewer', 'GET', `/compliance/recalls/${seeded.actionIds.draft}`)
    await no('keeper', 'POST', `/compliance/recalls/${draft.recall.id}/close`, { version: draft.recall.version, closeNote: 'Made-up' }, 409)
    const list = await ok('viewer', 'GET', '/compliance/recalls')
    expect(list.tiles.active).toBeGreaterThanOrEqual(1)
    expect((await ok('companyB', 'GET', '/compliance/recalls')).recalls).toEqual([])
  })
})

describe('distributors told one by one (RG1:02)', () => {
  it('drafts per recipient, sends by e-mail through the outbox with a fresh code, and sets W1’s date when all were told', async () => {
    const before = await ok('viewer', 'GET', `/compliance/register/${seeded.entryIds.recall}/distributors`)
    expect(before.recipients.map((recipient: Json) => recipient.party.code)).toEqual(['SEED-C1'])
    const drafted = await ok('keeper', 'POST', `/compliance/register/${seeded.entryIds.recall}/distributor-notices`, { recipients: [{ partyId: before.recipients[0].party.id, channel: 'EMAIL', contact: 'buyer.c1@example.com', language: 'it' }] }, 201)
    expect(drafted.notices[0]).toMatchObject({ status: 'DRAFT', channel: 'EMAIL', language: 'it', subject: expect.stringContaining('SEED-JKT-02') })
    expect(await no('keeper', 'POST', `/compliance/register/${seeded.entryIds.recall}/distributor-notices`, { recipients: [{ partyId: before.recipients[0].party.id, channel: 'PHONE', contact: 'not a number' }] }, 400)).toMatchObject({ issues: [{ path: 'body/recipients/0/contact' }] })
    await stepUp(h, quality.browser, quality.secret)
    const sent = await asPerson('POST', `/compliance/register/${seeded.entryIds.recall}/distributor-notices/send`, { noticeIds: [drafted.notices[0].id] }, 200)
    expect(sent.results).toEqual([{ noticeId: drafted.notices[0].id, sent: true, problem: null }])
    expect(sent.notices[0]).toMatchObject({ status: 'SENT', mail: { status: 'QUEUED' } })
    expect(sent).toMatchObject({ told: 1, of: 1 })
    const mail = await admin<{ recordType: string; to: string[] }>('SELECT "recordType", "to" FROM "EmailOutbound" WHERE "recordId" = $1', [drafted.notices[0].id])
    expect(mail).toEqual([{ recordType: 'DistributorNotice', to: ['buyer.c1@example.com'] }])
    expect((await entryRow(seeded.entryIds.recall)).distributorsInformedAt).not.toBeNull()
    // Sent once.
    expect((await asPerson('POST', `/compliance/register/${seeded.entryIds.recall}/distributor-notices/send`, { noticeIds: [drafted.notices[0].id] }, 400)).error.issues[0].path).toBe('body/noticeIds/0')
  })

  it('records the reply on the notice’s thread as its answer, and a bounce as a failure (the worker)', async () => {
    const [reply, bounce] = distributorHandlers()
    const system = callerFor(h.database, systemContext(T.tenant, newId()))
    const rows = await admin<{ id: string; partyId: string }>(`SELECT id, "partyId" FROM "DistributorNotice" WHERE "registerEntryId" = $1 AND status = 'SENT' ORDER BY "createdAt"`, [seeded.entryIds.recall])
    const noticeId = rows.at(-1)!.id
    const { result } = await runCommand(system, { name: 'threads.testReply', input: { noticeId } }, async (tools) => {
      const { thread } = await ensureThread(tools, { type: 'DistributorNotice', id: noticeId }, null)
      const message = await writeMessage(tools, thread, { direction: 'INBOUND', channel: 'EMAIL', author: { kind: 'PARTY', id: null, name: 'Made-up Buyer' }, bodyText: 'Ricevuto: abbiamo bloccato i capi.' })
      tools.audit({ recordType: 'Message', recordId: message.id, after: { test: true } })
      return { messageId: message.id }
    }, COMMAND_SETTINGS)
    const envelope = (type: string, payload: Json) => ({ eventId: newId(), type, version: 1, context: 'test', subject: noticeId, correlationId: newId(), causationId: null, source: 'test', occurredAt: new Date().toISOString(), payload, tenantId: T.tenant, companyId: null, siteId: null })
    await reply!.handle(envelope('thread.message_posted', { threadId: newId(), messageId: result.messageId, recordType: 'DistributorNotice', recordId: noticeId, direction: 'INBOUND', audience: 'PARTNER' }) as never, { caller: system, attempt: 1 })
    const answered = await ok('viewer', 'GET', `/compliance/register/${seeded.entryIds.recall}/distributors`)
    const view = answered.recipients[0].notices.find((entry: Json) => entry.id === noticeId)
    expect(view).toMatchObject({ status: 'ANSWERED', answer: 'Ricevuto: abbiamo bloccato i capi.', answeredByName: 'Made-up Buyer' })
    // A second notice by phone, sent, then its mail bounces? A phone has no mail: the bounce handler leaves others alone.
    await bounce!.handle(envelope('email.status_changed', { outboundId: newId(), threadId: null, recordType: 'DistributorNotice', recordId: noticeId, status: 'BOUNCED' }) as never, { caller: system, attempt: 1 })
    expect((await admin<{ status: string }>('SELECT status FROM "DistributorNotice" WHERE id = $1', [noticeId]))[0]!.status).toBe('ANSWERED')
    const bounced = seeded.distributorNoticeIds.draft
    // The seed's DRAFT is no SENT notice: a bounce of it changes nothing either.
    await bounce!.handle(envelope('email.status_changed', { outboundId: newId(), threadId: null, recordType: 'DistributorNotice', recordId: bounced, status: 'BOUNCED' }) as never, { caller: system, attempt: 1 })
    expect((await admin<{ status: string }>('SELECT status FROM "DistributorNotice" WHERE id = $1', [bounced]))[0]!.status).toBe('DRAFT')
  })

  it('records an answer taken by phone and refuses one for a draft', async () => {
    const draft = (await ok('viewer', 'GET', `/compliance/register/${seeded.entryIds.recall}/distributors`)).recipients[0].notices.find((entry: Json) => entry.status === 'DRAFT')
    expect((await no('keeper', 'POST', `/compliance/distributor-notices/${draft.id}/answer`, { version: draft.version, answer: 'Made-up' }, 409)).message).toContain('Send the notice first')
    const cancelled = (await ok('keeper', 'POST', `/compliance/distributor-notices/${draft.id}/cancel`, { version: draft.version, reason: 'Made-up: told by e-mail instead.' })).notice
    expect(cancelled.status).toBe('CANCELLED')
  })
})

describe('the authority request log (PRD-390)', () => {
  let request: Json
  const received = new Date(Date.now() - 2 * 3_600_000).toISOString()
  const due = businessDate(new Date(Date.now() + 5 * 86_400_000))

  it('logs a request numbered AR-…, counts down to its due day, and refuses a due day before it came', async () => {
    const styleId = seeded.styleId
    request = (await ok('keeper', 'POST', '/compliance/authority-requests', { companyId: T.companyA, authorityName: 'Made-up Ufficio vigilanza Milano', marketCode: 'IT', authorityReference: 'MADEUP-PROT-77', channel: 'PEC', receivedAt: received, styleId, batchNumbers: ['SEED-BT-0001'], request: 'Made-up: send the DoC and the test reports of batch SEED-BT-0001.', dueOn: due }, 201)).request
    expect(request).toMatchObject({ status: 'OPEN', due: { state: 'DUE_SOON', daysLeft: 5 }, style: { code: 'SEED-JKT-02' }, law: expect.stringContaining('2019/1020'), may: { entry: true } })
    expect(request.number).toMatch(/^AR-\d{4}-\d{4}$/)
    expect(await no('keeper', 'POST', '/compliance/authority-requests', { companyId: T.companyA, authorityName: 'Made-up', marketCode: 'IT', channel: 'EMAIL', receivedAt: received, request: 'x', dueOn: '2020-01-01' }, 400)).toMatchObject({ issues: [{ path: 'body/dueOn' }] })
  })

  it('opens its register entry once, names its evidence, and is answered by the person', async () => {
    request = (await ok('keeper', 'POST', `/compliance/authority-requests/${request.id}/register-entry`, { version: request.version })).request
    expect(request.entry).toMatchObject({ kind: 'AUTHORITY_REQUEST', status: 'OPEN' })
    const entry = await ok('viewer', 'GET', `/compliance/register/${request.entry.id}`)
    expect(entry.entry).toMatchObject({ kind: 'AUTHORITY_REQUEST', source: { type: 'AuthorityRequest', id: request.id }, batchNumbers: ['SEED-BT-0001'] })
    await no('keeper', 'POST', `/compliance/authority-requests/${request.id}/register-entry`, { version: request.version }, 409)
    expect(await no('keeper', 'POST', `/compliance/authority-requests/${request.id}/evidence`, { version: request.version, packId: newId() }, 400)).toMatchObject({ issues: [{ path: 'body/packId' }] })
    const answered = (await ok('keeper', 'POST', `/compliance/authority-requests/${request.id}/answer`, { version: request.version, answerSummary: 'Made-up: the DoC and two test reports sent by PEC.' })).request
    expect(answered).toMatchObject({ status: 'ANSWERED', due: { state: 'ANSWERED', daysLeft: null }, answeredBy: { id: idOf('actor') } })
    expect((await no('keeper', 'PATCH', `/compliance/authority-requests/${request.id}`, { version: answered.version, dueOn: due }, 409)).message).toContain('only its note')
    const surveillance = await ok('viewer', 'GET', `/compliance/register/${request.entry.id}/surveillance`)
    expect(surveillance.requests.map((row: Json) => row.number)).toEqual([request.number])
    const list = await ok('viewer', 'GET', '/compliance/authority-requests')
    expect(list.tiles.answeredThisYear).toBeGreaterThanOrEqual(1)
    expect((await ok('companyB', 'GET', '/compliance/authority-requests')).requests).toEqual([])
  })
})

describe('a database refusal is a 409 in words, never a 500', () => {
  it('turns a recall guard sentence into a conflict', async () => {
    const refusal = Object.assign(new Error('driver'), { meta: { driverAdapterError: { cause: { originalCode: '23514', originalMessage: 'recall: recall action x started: its scope only widens (nothing it calls back is taken out)' } } } })
    await expect(guarded(() => Promise.reject(refusal))).rejects.toMatchObject({ code: 'conflict', message: 'Recall action x started: its scope only widens (nothing it calls back is taken out).' })
    // Through the database: narrowing a started scope by hand is refused by the guard.
    const system = callerFor(h.database, systemContext(T.tenant, newId()))
    await expect(
      guarded(() => system.withClient((client) => client.recallAction.update({ where: { id: seeded.actionIds.active }, data: { workOrderIds: [] }, select: { id: true } }))),
    ).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('only widens') })
  })
})
