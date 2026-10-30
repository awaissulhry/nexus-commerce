import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedReturns, type ReturnsSeed } from '../../../../../../packages/factory-db/seed/returns'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { fanOut } from '../../../platform/notifications/fan-out'
import { systemContext } from '../../../platform/outbox/system'

/**
 * Customer complaints (B-W2a-65; SAL-416 the record, QHS-113 triage, QHS-115 severity and the safety escalation) on the
 * local stack: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the
 * …_sales_w2a_guards complaint and register triggers are real), the real app with test sessions. Tenant A from the
 * factory-db seeds up to returns: the customer P1 with SEED-SO-0002 and SH-0001, SEED-CMP-0001 (a safety complaint, its
 * alert raised and not acknowledged), the serial-tracked garments SEED-SN-0001…3 (SEED-JKT-03, batch SEED-BT-0003).
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/quality/complaints`.
 */

let h: Harness
let app: FastifyInstance
let seeded: ReturnsSeed

const NS = 'w2a65-complaints-a'
const idIn = (key: string) => seedUuid(NS, key)
const T = idIn('tenant')
const companyA = idIn('company:A')
const companyB = idIn('company:B')
const P1 = idIn('party:P1')
const TODAY = businessDate(new Date())
const YEAR = TODAY.slice(0, 4)
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }, { id: companyB, code: 'B' }] }
const plusDays = (days: number) => {
  const at = new Date(`${TODAY}T00:00:00.000Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const key = (label = 'k'): string => `complaints-${label}-${++counter}-${newId()}`

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (permissions: Permission[], companies: Grant['companies'] = 'all', actorId = newId()): (() => SessionContext) => () => ({ audience: 'office', tenantId: T, actorId, grants: [grant(permissions, companies)] })
const VIEW: Permission[] = ['quality.complaints.view']
const SESSIONS: Record<string, () => SessionContext> = {
  sales: office([...VIEW, 'quality.complaints.log', 'threads.read', 'threads.post', 'money.price']),
  quality: office([...VIEW, 'quality.complaints.log', 'quality.complaints.manage', 'compliance.register.view', 'quality.ncr.view', 'sales.repairs.view', 'threads.read']),
  registrar: office([...VIEW, 'quality.complaints.manage', 'compliance.register.view', 'compliance.register.manage']),
  owner: office([...VIEW, 'quality.complaints.acknowledge', 'compliance.register.view']),
  viewer: office(VIEW),
  companyB: office([...VIEW, 'quality.complaints.log', 'quality.complaints.manage'], [companyB]),
}

async function call(session: string, method: Method, url: string, body?: unknown, idempotencyKey = key(session)) {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': idempotencyKey }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(session: string, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
async function refused(session: string, method: Method, url: string, body: unknown, status: number): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body.error
}
const events = async (type: string, subject: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id`, [type, subject])).map((row) => row.payload)
const recordOf = async (complaintId: string, session = 'quality') => (await ok(session, 'GET', `/quality/complaints/${complaintId}`)).complaint
const held = (complaint: Json, action: string) => (complaint.actions as Json[]).find((entry) => entry.action === action)?.held ?? null
const log = async (body: Json = {}, session = 'sales') => (await ok(session, 'POST', '/quality/complaints', { companyId: companyA, partyId: P1, channel: 'EMAIL', description: 'The zip of the jacket broke on the first day.', ...body }, 201)).complaint

let qualityUserId = ''
let ownerUserId = ''

beforeAll(async () => {
  h = await startHarness('quality_complaints')
  await seedCore({ db: h.database, namespace: NS })
  seeded = await seedReturns({ db: h.database, namespace: NS })
  // The system roles as the templates hold them now (quality.complaints.* for the quality inspector).
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  for (const [kind, pattern] of [['COMPLAINT', 'CMP-{YYYY}-{N:4}'], ['PPE_REGISTER', 'REG-{YYYY}-{N:4}']] as const) {
    await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, $4, 'MAIN', $5, 'YEARLY', $6, false) ON CONFLICT DO NOTHING`, [newId(), T, companyA, kind, YEAR, pattern])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  qualityUserId = (await addUser(h, TENANT, { email: 'qa.complaints@example.com', role: 'quality_inspector' })).id
  ownerUserId = (await addUser(h, TENANT, { email: 'owner.complaints@example.com', role: 'owner' })).id
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('logging a complaint as the customer made it (SAL-416)', () => {
  it('a scanned serial alone finds the garment, its style, size, batch and customer; nothing is written', async () => {
    const preview = await ok('sales', 'POST', '/quality/complaints/preview', { serial: 'SEED-SN-0002' })
    expect(preview.draft).toMatchObject({ companyId: companyA, partyId: P1, size: expect.any(String), batchNumber: 'SEED-BT-0003' })
    expect(preview.draft.styleId).toBeTruthy()
    expect(preview.garment).toMatchObject({ batchNumber: 'SEED-BT-0003', forThisCustomer: true })
    // The customer's other open complaints (a duplicate?): the seed's safety complaint.
    expect(preview.others.map((row: Json) => row.id)).toContain(seeded.complaintId)
    expect(preview.ok).toBe(false)
    expect(preview.problems.map((problem: Json) => problem.path)).toEqual(expect.arrayContaining(['body/description', 'body/channel']))
    const unknown = await ok('sales', 'POST', '/quality/complaints/preview', { companyId: companyA, partyId: P1, serial: 'NOT-OURS-1', channel: 'PHONE', description: 'x' })
    expect(unknown.warnings.map((warning: Json) => warning.path)).toContain('body/serial')
  })

  it('logs it NEW, numbered from the COMPLAINT series, filled from our serial, its maker following it', async () => {
    const complaint = await log({ serial: 'SEED-SN-0002', customerRef: 'P1-RMA-77' })
    expect(complaint).toMatchObject({ status: 'NEW', channel: 'EMAIL', customerRef: 'P1-RMA-77', serial: 'SEED-SN-0002', batchNumber: 'SEED-BT-0003', party: { id: P1 }, category: null, safety: { state: 'NONE' } })
    expect(complaint.number).toMatch(new RegExp(`^CMP-${YEAR}-\\d{4}$`))
    expect(complaint.style).toMatchObject({ code: expect.any(String) })
    expect(complaint.evidence).toEqual({ kind: 'serial', subject: 'SEED-SN-0002' })
    expect(complaint.suggestedAnswerDueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(held(complaint, 'acknowledge')).toBe('NO_PERMISSION')
    expect(held(complaint, 'triage')).toBe('NO_PERMISSION')
    expect(await events('complaint.received', complaint.id)).toEqual([expect.objectContaining({ complaintId: complaint.id, number: complaint.number, partyId: P1, channel: 'EMAIL' })])
    // A test session's actor is no person: the maker follows only as a real office person (the live check shows it).
    expect(await admin('SELECT reason::text AS reason FROM "RecordFollower" WHERE "recordType" = $1 AND "recordId" = $2', ['Complaint', complaint.id])).toEqual([])
    // Its thread is the customer's: the record panel's Activity reads it.
    expect((await call('sales', 'GET', `/threads/Complaint/${complaint.id}`)).status).toBe(200)
  })

  it('refuses what is not the company’s and the customer’s, in words, and writes nothing', async () => {
    const before = await admin<{ n: number }>('SELECT count(*)::int AS n FROM "Complaint"')
    const error = await refused('sales', 'POST', '/quality/complaints', { companyId: companyA, partyId: P1, channel: 'PHONE', description: '   ', shipmentId: newId(), salesOrderId: newId() }, 400)
    expect(error.issues.map((issue: Json) => issue.path)).toEqual(expect.arrayContaining(['body/description', 'body/shipmentId', 'body/salesOrderId']))
    expect(await admin('SELECT count(*)::int AS n FROM "Complaint"')).toEqual(before)
    // Another company's session does not see company A's customers' complaints.
    await refused('companyB', 'POST', '/quality/complaints', { companyId: companyA, partyId: P1, channel: 'PHONE', description: 'x' }, 404)
    // Logging needs quality.complaints.log.
    await refused('viewer', 'POST', '/quality/complaints', { companyId: companyA, partyId: P1, channel: 'PHONE', description: 'x' }, 403)
  })
})

describe('the list, its tiles and the safety banner', () => {
  it('tiles count the named filters; the banner lists the raised, unacknowledged safety complaints', async () => {
    const counts = await ok('viewer', 'GET', '/quality/complaints/counts')
    expect(counts.tiles.new).toBeGreaterThanOrEqual(1)
    expect(counts.tiles.safety).toBeGreaterThanOrEqual(1)
    expect(counts.safetyAlerts.map((row: Json) => row.id)).toContain(seeded.complaintId)
    const fresh = await ok('viewer', 'GET', '/quality/complaints?view=new')
    expect(fresh.complaints.every((row: Json) => row.status === 'NEW')).toBe(true)
    const safety = await ok('viewer', 'GET', '/quality/complaints?view=safety')
    expect(safety.complaints.map((row: Json) => row.id)).toContain(seeded.complaintId)
    const found = await ok('viewer', 'GET', '/quality/complaints?view=all&q=P1-RMA-77')
    expect(found.complaints).toHaveLength(1)
    // Company B's people see none of company A's.
    expect((await ok('companyB', 'GET', '/quality/complaints?view=all')).complaints).toEqual([])
    await refused('companyB', 'GET', `/quality/complaints/${seeded.complaintId}`, undefined, 404)
  })

  it("the order's value only with the price grain; the register entry and NCRs only with their own view", async () => {
    const withPrice = (await ok('sales', 'GET', '/quality/complaints?view=safety')).complaints.find((row: Json) => row.id === seeded.complaintId)
    expect(withPrice.order).toMatchObject({ number: expect.any(String), netAmount: expect.any(Number) })
    const without = (await ok('viewer', 'GET', '/quality/complaints?view=safety')).complaints.find((row: Json) => row.id === seeded.complaintId)
    expect(without.order).toBeTruthy()
    expect(without.order.netAmount).toBeUndefined()
  })

  it('pages newest first with a cursor', async () => {
    await log({ description: 'Page one.' })
    await log({ description: 'Page two.' })
    const first = await ok('viewer', 'GET', '/quality/complaints?view=all&limit=2')
    expect(first.complaints).toHaveLength(2)
    expect(first.nextCursor).toBeTruthy()
    const second = await ok('viewer', 'GET', `/quality/complaints?view=all&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)
    expect(second.complaints.map((row: Json) => row.id)).not.toContain(first.complaints[0].id)
    await refused('viewer', 'GET', '/quality/complaints?cursor=nonsense', undefined, 400)
  })
})

describe('triage and the safety escalation (QHS-113, QHS-115)', () => {
  it('who owns a complaint and whom a safety alert tells, from their live roles', async () => {
    const people = await ok('quality', 'GET', `/quality/complaints/people?companyId=${companyA}`)
    expect(people.owners.map((person: Json) => person.id)).toContain(qualityUserId)
    expect(people.told.map((person: Json) => person.as).sort()).toEqual(['OWNER', 'QUALITY'])
  })

  it('refuses a triage in words: no permission, an answer due before it came in, a safety one without a style, an owner who may not see it', async () => {
    const complaint = await log({ description: 'A seam opened.' })
    await refused('sales', 'POST', `/quality/complaints/${complaint.id}/triage`, { version: 1, category: 'FIT', severity: 'MINOR', ownerId: qualityUserId, answerDueOn: plusDays(5) }, 403)
    const early = await refused('quality', 'POST', `/quality/complaints/${complaint.id}/triage`, { version: 1, category: 'FIT', severity: 'MINOR', ownerId: qualityUserId, answerDueOn: plusDays(-3) }, 400)
    expect(early.issues.map((issue: Json) => issue.path)).toEqual(['body/answerDueOn'])
    const noStyle = await refused('quality', 'POST', `/quality/complaints/${complaint.id}/triage`, { version: 1, category: 'SAFETY', severity: 'CRITICAL', ownerId: qualityUserId, answerDueOn: plusDays(5) }, 400)
    expect(noStyle.issues.map((issue: Json) => issue.path)).toEqual(['body/styleId'])
    const stranger = await refused('quality', 'POST', `/quality/complaints/${complaint.id}/triage`, { version: 1, category: 'FIT', severity: 'MINOR', ownerId: newId(), answerDueOn: plusDays(5) }, 400)
    expect(stranger.issues.map((issue: Json) => issue.path)).toEqual(['body/ownerId'])
    expect((await recordOf(complaint.id)).status).toBe('NEW')
  })

  it('a SAFETY triage raises the alert, opens its PPE register entry in the same step, tells the owner and quality; it closes only once acknowledged', async () => {
    const complaint = await log({ serial: 'SEED-SN-0003', description: 'The elbow protector moved in a crash.' })
    const triaged = await ok('quality', 'POST', `/quality/complaints/${complaint.id}/triage`, { version: complaint.version, category: 'SAFETY', severity: 'CRITICAL', ownerId: qualityUserId, answerDueOn: plusDays(2) })
    expect(triaged.safetyRaised).toBe(true)
    expect(triaged.register).toMatchObject({ opened: true, reference: expect.stringMatching(new RegExp(`^REG-${YEAR}-`)) })
    expect(triaged.complaint).toMatchObject({ status: 'TRIAGED', category: 'SAFETY', severity: 'CRITICAL', ownerId: qualityUserId, answerDueOn: plusDays(2), safety: { state: 'RAISED' }, register: { id: triaged.register.entryId, risk: 'ASSESSING' } })
    const [entry] = await admin('SELECT kind::text AS kind, "sourceType", "sourceId", "partyId", "batchNumbers", serials FROM "PpeRegisterEntry" WHERE id = $1', [triaged.register.entryId])
    expect(entry).toMatchObject({ kind: 'COMPLAINT', sourceType: 'Complaint', sourceId: complaint.id, partyId: P1, batchNumbers: ['SEED-BT-0003'], serials: ['SEED-SN-0003'] })
    expect(await events('complaint.safety_raised', complaint.id)).toEqual([expect.objectContaining({ complaintId: complaint.id, registerEntryId: triaged.register.entryId })])
    expect(await events('compliance.register_entry_opened', triaged.register.entryId)).toHaveLength(1)
    // The owner follows it as its assignee; the banner shows it; "answer due in 3 days" counts it.
    expect(await admin('SELECT reason::text AS reason FROM "RecordFollower" WHERE "recordType" = $1 AND "recordId" = $2 AND "userId" = $3', ['Complaint', complaint.id, qualityUserId])).toEqual([{ reason: 'ASSIGNEE' }])
    expect((await ok('viewer', 'GET', '/quality/complaints/counts')).safetyAlerts.map((row: Json) => row.id)).toContain(complaint.id)
    expect((await ok('viewer', 'GET', '/quality/complaints?view=dueSoon')).complaints.map((row: Json) => row.id)).toContain(complaint.id)

    // The worker's fan-out: an ALERT to the owner and the quality inspector (real people), nobody else.
    const row = (await admin(`SELECT * FROM "OutboxEvent" WHERE type = 'complaint.safety_raised' AND subject = $1`, [complaint.id]))[0]!
    const envelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }
    expect(await fanOut(callerFor(h.database, systemContext(T, `test-${row.id}`)), envelope)).toBeGreaterThanOrEqual(2)
    const told = await admin(`SELECT "userId", category::text AS category, "messageKey", "recordType", "recordLabel" FROM "Notification" WHERE "eventId" = $1`, [row.id])
    expect(told.map((notice) => notice.userId)).toEqual(expect.arrayContaining([qualityUserId, ownerUserId]))
    for (const notice of told) expect(notice).toMatchObject({ category: 'ALERT', messageKey: 'notifications.complaint.safety', recordType: 'Complaint', recordLabel: complaint.number })

    // A re-triage keeps the alert and the one register entry.
    const again = await ok('quality', 'POST', `/quality/complaints/${complaint.id}/triage`, { version: triaged.complaint.version, category: 'FUNCTION', severity: 'MAJOR', ownerId: qualityUserId, answerDueOn: plusDays(4) })
    expect(again).toMatchObject({ safetyRaised: false, register: { entryId: triaged.register.entryId, opened: false }, complaint: { category: 'FUNCTION', safety: { state: 'RAISED' } } })
    expect(await events('complaint.safety_raised', complaint.id)).toHaveLength(1)

    // Close is held until the owner acknowledges; quality may not acknowledge; the owner may, once.
    const current = await recordOf(complaint.id)
    expect(held(current, 'close')).toBe('SAFETY_NOT_ACKNOWLEDGED')
    const closing = await refused('quality', 'POST', `/quality/complaints/${complaint.id}/close`, { version: current.version, reason: 'Answered by phone.' }, 409)
    expect(closing.issues).toEqual([expect.objectContaining({ path: 'held/SAFETY_NOT_ACKNOWLEDGED' })])
    await refused('quality', 'POST', `/quality/complaints/${complaint.id}/acknowledge`, { version: current.version }, 403)
    const acknowledged = (await ok('owner', 'POST', `/quality/complaints/${complaint.id}/acknowledge`, { version: current.version, note: 'Told by phone.' })).complaint
    expect(acknowledged.safety).toMatchObject({ state: 'ACKNOWLEDGED', acknowledgedAt: expect.any(String) })
    expect(held(acknowledged, 'acknowledge')).toBe('ACKNOWLEDGED')
    const twice = await refused('owner', 'POST', `/quality/complaints/${complaint.id}/acknowledge`, { version: acknowledged.version }, 409)
    expect(twice.issues).toEqual([expect.objectContaining({ path: 'held/ACKNOWLEDGED' })])
    expect(await events('complaint.safety_acknowledged', complaint.id)).toHaveLength(1)
    expect((await ok('viewer', 'GET', '/quality/complaints/counts')).safetyAlerts.map((alert: Json) => alert.id)).not.toContain(complaint.id)

    const closed = (await ok('quality', 'POST', `/quality/complaints/${complaint.id}/close`, { version: acknowledged.version, reason: 'Protector replaced under warranty; the customer accepted.' })).complaint
    expect(closed).toMatchObject({ status: 'CLOSED', closeReason: 'Protector replaced under warranty; the customer accepted.' })
    expect(held(closed, 'edit')).toBe('CLOSED')
    const after = await refused('quality', 'PATCH', `/quality/complaints/${complaint.id}`, { version: closed.version, customerRef: 'late' }, 409)
    expect(after.code).toBe('invalid_state')
  })
})

describe('the status moves, the facts and the register by hand', () => {
  it('investigating → answered → back to investigating; a stale version is refused', async () => {
    const complaint = await log({ description: 'The sleeves are too long.' })
    const early = await refused('quality', 'POST', `/quality/complaints/${complaint.id}/status`, { version: 1, to: 'INVESTIGATING' }, 409)
    expect(early.issues).toEqual([expect.objectContaining({ path: 'held/NOT_TRIAGED' })])
    const triaged = (await ok('quality', 'POST', `/quality/complaints/${complaint.id}/triage`, { version: 1, category: 'FIT', severity: 'MINOR', ownerId: qualityUserId, answerDueOn: plusDays(10) })).complaint
    const investigating = (await ok('quality', 'POST', `/quality/complaints/${complaint.id}/status`, { version: triaged.version, to: 'INVESTIGATING' })).complaint
    expect(investigating.status).toBe('INVESTIGATING')
    await refused('quality', 'POST', `/quality/complaints/${complaint.id}/status`, { version: triaged.version, to: 'ANSWERED' }, 409)
    const answered = (await ok('quality', 'POST', `/quality/complaints/${complaint.id}/status`, { version: investigating.version, to: 'ANSWERED', note: 'Answered by e-mail: a shorter size is on its way.' })).complaint
    expect(answered).toMatchObject({ status: 'ANSWERED', answeredAt: expect.any(String) })
    expect((await ok('viewer', 'GET', '/quality/complaints?view=answeredMonth')).complaints.map((row: Json) => row.id)).toContain(complaint.id)
    const back = (await ok('quality', 'POST', `/quality/complaints/${complaint.id}/status`, { version: answered.version, to: 'INVESTIGATING' })).complaint
    expect(back).toMatchObject({ status: 'INVESTIGATING', answeredAt: null })
    expect((await events('complaint.status_changed', complaint.id)).map((event) => `${event.from}>${event.to}`)).toEqual(['TRIAGED>INVESTIGATING', 'INVESTIGATING>ANSWERED', 'ANSWERED>INVESTIGATING'])
  })

  it('changes the facts: sales while new, quality once triaged; the audit names the fields, never the words', async () => {
    const complaint = await log({ description: 'Wrong colour delivered.' })
    const changed = await ok('sales', 'PATCH', `/quality/complaints/${complaint.id}`, { version: 1, customerRef: 'P1-77', description: 'Wrong colour delivered: red, not black.', serial: 'SEED-SN-0001' })
    expect(changed.complaint).toMatchObject({ customerRef: 'P1-77', serial: 'SEED-SN-0001', description: 'Wrong colour delivered: red, not black.' })
    expect(await events('complaint.changed', complaint.id)).toEqual([expect.objectContaining({ fields: expect.arrayContaining(['customerRef', 'description', 'serial']) })])
    const [audit] = await admin(`SELECT after FROM "AuditLog" WHERE "recordType" = 'Complaint' AND "recordId" = $1 AND after ? 'fields'`, [complaint.id])
    expect(JSON.stringify(audit)).not.toContain('red, not black')
    const triaged = (await ok('quality', 'POST', `/quality/complaints/${complaint.id}/triage`, { version: changed.complaint.version, category: 'COSMETIC', severity: 'MINOR', ownerId: qualityUserId, answerDueOn: plusDays(7) })).complaint
    await refused('sales', 'PATCH', `/quality/complaints/${complaint.id}`, { version: triaged.version, customerRef: 'P1-78' }, 403)
    const bad = await refused('quality', 'PATCH', `/quality/complaints/${complaint.id}`, { version: triaged.version, shipmentId: newId() }, 400)
    expect(bad.issues.map((issue: Json) => issue.path)).toEqual(['body/shipmentId'])
  })

  it('adds a complaint that raised no alert to the PPE register by hand (also compliance.register.manage), once', async () => {
    const complaint = await log({ serial: 'SEED-SN-0001', description: 'The reflective strip peels off.' })
    await refused('quality', 'POST', `/quality/complaints/${complaint.id}/register`, { version: complaint.version }, 403)
    const added = await ok('registrar', 'POST', `/quality/complaints/${complaint.id}/register`, { version: complaint.version, risk: 'NO' })
    expect(added.register).toMatchObject({ opened: true })
    expect(added.complaint.register).toMatchObject({ id: added.register.entryId, risk: 'NO' })
    expect(held(added.complaint, 'register')).toBe('IN_REGISTER')
    const twice = await refused('registrar', 'POST', `/quality/complaints/${complaint.id}/register`, { version: added.complaint.version }, 409)
    expect(twice.issues).toEqual([expect.objectContaining({ path: 'held/IN_REGISTER' })])
    const noStyle = await log({ description: 'No garment named.' })
    const held409 = await refused('registrar', 'POST', `/quality/complaints/${noStyle.id}/register`, { version: noStyle.version }, 409)
    expect(held409.issues).toEqual([expect.objectContaining({ path: 'held/NO_STYLE' })])
  })

  it('a NEW complaint logged by mistake closes with its reason; the guard keeps it closed', async () => {
    const complaint = await log({ description: 'Logged twice by mistake.' })
    await refused('quality', 'POST', `/quality/complaints/${complaint.id}/close`, { version: 1, reason: '  ' }, 400)
    const closed = (await ok('quality', 'POST', `/quality/complaints/${complaint.id}/close`, { version: 1, reason: 'A duplicate of an earlier complaint.' })).complaint
    expect(closed.status).toBe('CLOSED')
    await expect(admin(`UPDATE "Complaint" SET "customerRef" = 'x' WHERE id = $1`, [complaint.id])).rejects.toThrow(/CLOSED; it never changes/)
  })
})
