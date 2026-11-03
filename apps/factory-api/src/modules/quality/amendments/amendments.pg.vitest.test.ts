import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedInspectionPlans, type InspectionPlansSeed } from '../../../../../../packages/factory-db/seed/inspection-plans'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedQuality, type QualitySeed } from '../../../../../../packages/factory-db/seed/quality'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * Locked results with amendments (B-W2b-123; QHS-145) on the local stack: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security and the …_inspection_plans_w2b_guards triggers are real: the record
 * and its rows are frozen, InspectionAmendment is append-only and refuses an answer by who asked), the real app. Tenant A
 * from the factory-db seeds up to quality (WO-0001's PASSED inspection on W1's checklist with one minor defect, an OPEN one)
 * and inspection plans (SEED-IIN-0002 DECIDED with a note amendment asked and countersigned; the decided roving check).
 * The second signature uses the harness's real sign-in: two office quality inspectors with two-factor (step-up). Every name
 * and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/quality/amendments`.
 */

let h: Harness
let app: FastifyInstance
let quality: QualitySeed
let plans: InspectionPlansSeed

const NS = 'w2b123-amend-a'
const idIn = (key: string) => seedUuid(NS, key)
const T = idIn('tenant')
const companyA = idIn('company:A')
const companyB = idIn('company:B')
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }, { id: companyB, code: 'B' }] }

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const key = () => `amend-${++counter}-${newId()}`

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (permissions: Permission[], companies: Grant['companies'] = 'all', actorId = newId()): SessionContext => ({ audience: 'office', tenantId: T, actorId, grants: [grant(permissions, companies)] })
const VIEW: Permission[] = ['quality.inspections.view', 'quality.incoming.view', 'quality.inprocess.view']
const SESSIONS: Record<string, SessionContext> = {
  viewer: office(VIEW),
  asker: office([...VIEW, 'quality.amendments.request']),
  companyB: office([...VIEW, 'quality.amendments.request', 'quality.amendments.sign'], [companyB]),
  signer: office([...VIEW, 'quality.amendments.sign']),
}

async function call(session: string, method: Method, url: string, body?: unknown) {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(body === undefined ? {} : { payload: body as object }) })
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
async function as(person: Person, method: Method, url: string, body: unknown, status: number): Promise<Json> {
  const answer = await person.browser.send(method, url, body, { headers: { 'idempotency-key': key() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
const events = async (type: string, subject: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id`, [type, subject])).map((row) => row.payload)

interface Person {
  readonly id: string
  readonly browser: Browser
  readonly secret: string
}
const signedIn = async (email: string): Promise<Person> => {
  const user = await addUser(h, TENANT, { email, role: 'quality_inspector' })
  const browser = new Browser(h.app)
  const answer = await browser.signIn(TENANT.slug, user.email, user.password)
  if (answer.body && (answer.body as Json).status !== 'signed_in') throw new Error(`sign-in ${email}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return { id: user.id, browser, secret: await enrolTotp(h, browser) }
}
let qa1: Person
let qa2: Person

beforeAll(async () => {
  h = await startHarness('quality_amendments')
  await seedCore({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  quality = await seedQuality({ db: h.database, namespace: NS })
  plans = await seedInspectionPlans({ db: h.database, namespace: NS })
  // The system roles as the templates hold them now (quality.amendments.* for the quality inspector).
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  qa1 = await signedIn('qa1.amend@example.com')
  qa2 = await signedIn('qa2.amend@example.com')
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

let defectId = ''
let zoneRequest = ''

describe('a signed record and what a correction may change', () => {
  it('lists the fields of a signed final inspection with what stands now; a viewer may ask nothing', async () => {
    const view = await ok('viewer', 'GET', `/quality/inspections/${quality.passedInspectionId}/amendments`)
    expect(view.record).toMatchObject({ type: 'Inspection', status: 'PASSED', signed: true, amended: false })
    expect(view.may).toEqual({ request: false, sign: false })
    expect(view.corrections).toEqual([])
    expect(view.words.locked).toMatch(/correction is an amendment with a second signature/)
    const fields = view.fields.map((field: Json) => `${field.row?.type ?? 'record'}:${field.field}`)
    expect(fields).toContain('record:note')
    expect(fields.some((field: string) => /^record:checklist\.[A-Z0-9_]+\.note$/.test(field))).toBe(true)
    expect(fields).toEqual(expect.arrayContaining(['InspectionDefect:zone', 'InspectionDefect:causeCodeId', 'InspectionDefect:note', 'InspectionDefect:description']))
    defectId = view.fields.find((field: Json) => field.row?.type === 'InspectionDefect').row.id
  })

  it('refuses an open record, a field no correction takes, a row of another record, a short reason; another company sees nothing', async () => {
    expect((await refused('asker', 'POST', `/quality/inspections/${quality.openInspectionId}/amendments`, { field: 'note', after: 'x', reason: 'Too early.' }, 409)).issues[0].path).toBe('refusal/NOT_SIGNED')
    expect((await refused('asker', 'POST', `/quality/inspections/${quality.passedInspectionId}/amendments`, { field: 'quantity', row: { type: 'InspectionDefect', id: defectId }, after: '3', reason: 'More found.' }, 400)).issues[0].path).toBe('body/field')
    expect((await refused('asker', 'POST', `/quality/inspections/${quality.passedInspectionId}/amendments`, { field: 'zone', row: { type: 'InspectionDefect', id: quality.openDefectId }, after: 'BACK', reason: 'Wrong row.' }, 400)).issues[0].path).toBe('body/row')
    expect((await refused('asker', 'POST', `/quality/inspections/${quality.passedInspectionId}/amendments`, { field: 'note', after: 'x', reason: 'no' }, 400)).issues[0].path).toBe('body/reason')
    expect((await refused('viewer', 'POST', `/quality/inspections/${quality.passedInspectionId}/amendments`, { field: 'note', after: 'x', reason: 'Not mine.' }, 403)).code).toBe('forbidden')
    expect((await call('companyB', 'GET', `/quality/inspections/${quality.passedInspectionId}/amendments`)).status).toBe(404)
  })
})

describe('the second signature (QHS-145)', () => {
  it('asks: a REQUEST signed by who asks, the value before the API\'s, nothing on the record changes', async () => {
    const before = (await admin<{ zone: string | null }>('SELECT zone FROM "InspectionDefect" WHERE id = $1', [defectId]))[0]!.zone
    const answer = await as(qa1, 'POST', `/quality/inspections/${quality.passedInspectionId}/amendments`, { field: 'zone', row: { type: 'InspectionDefect', id: defectId }, after: 'ELBOW_L', reason: 'The defect was pinned at the wrong place.' }, 201)
    zoneRequest = answer.amendmentId
    const correction = answer.amendments.corrections.find((entry: Json) => entry.id === zoneRequest)
    expect(correction).toMatchObject({ field: 'zone', before, after: 'ELBOW_L', afterWords: expect.stringMatching(/^(Left elbow|Gomito sinistro)$/), state: 'WAITING', mine: true, ref: null, answer: null })
    expect(correction.signatureSha256).toMatch(/^[0-9a-f]{64}$/)
    const field = answer.amendments.fields.find((entry: Json) => entry.row?.id === defectId && entry.field === 'zone')
    expect(field).toMatchObject({ value: before, waiting: zoneRequest, amendedBy: null })
    const [row] = await admin('SELECT kind, "signedById", field, "recordType", "recordId", after FROM "InspectionAmendment" WHERE id = $1', [zoneRequest])
    expect(row).toMatchObject({ kind: 'REQUEST', signedById: qa1.id, field: 'zone', recordType: 'InspectionDefect', recordId: defectId, after: 'ELBOW_L' })
    expect(await events('inspection_amendment.requested', quality.passedInspectionId)).toEqual([expect.objectContaining({ amendmentId: zoneRequest, recordType: 'Inspection', field: 'zone', rowType: 'InspectionDefect' })])
    expect((await admin('SELECT reason FROM "AuditLog" WHERE action = $1 AND "recordId" = $2', ['quality.requestAmendment', quality.passedInspectionId]))[0]).toMatchObject({ reason: 'The defect was pinned at the wrong place.' })
  })

  it('one request at a time on a field; the queue lists it for the second person', async () => {
    expect((await refused('asker', 'POST', `/quality/inspections/${quality.passedInspectionId}/amendments`, { field: 'zone', row: { type: 'InspectionDefect', id: defectId }, after: 'BACK', reason: 'Another view.' }, 409)).issues[0].path).toBe('refusal/WAITING')
    const queue = await ok('signer', 'GET', '/quality/amendments')
    expect(queue.amendments.map((entry: Json) => entry.id)).toContain(zoneRequest)
    expect(queue.amendments.find((entry: Json) => entry.id === zoneRequest)).toMatchObject({ state: 'WAITING', maySign: true, mine: false, record: { type: 'Inspection', id: quality.passedInspectionId } })
    expect((await ok('companyB', 'GET', '/quality/amendments?state=all')).amendments).toEqual([])
  })

  it('who asked never signs; the second person signs only with a fresh code', async () => {
    // Past the window of the codes typed when they enrolled.
    h.clock.advance(6 * 60_000)
    expect((await as(qa1, 'POST', `/quality/amendments/${zoneRequest}/sign`, {}, 409)).error.issues[0].path).toBe('refusal/SAME_PERSON')
    expect((await as(qa2, 'POST', `/quality/amendments/${zoneRequest}/sign`, {}, 403)).error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    await stepUp(h, qa2.browser, qa2.secret)
    const signed = await as(qa2, 'POST', `/quality/amendments/${zoneRequest}/sign`, {}, 201)
    const correction = signed.amendments.corrections.find((entry: Json) => entry.id === zoneRequest)
    expect(correction).toMatchObject({ state: 'SIGNED', ref: 1, answer: { kind: 'SIGNED', by: { id: qa2.id } } })
    expect(signed.amendments.record.amended).toBe(true)
    expect(signed.amendments.fields.find((entry: Json) => entry.row?.id === defectId && entry.field === 'zone')).toMatchObject({ value: 'ELBOW_L', amendedBy: zoneRequest, waiting: null })
    // The signed record never changed: what stands is the record with its signed corrections.
    expect((await admin('SELECT zone FROM "InspectionDefect" WHERE id = $1', [defectId]))[0]!.zone).not.toBe('ELBOW_L')
    expect(await events('inspection_amendment.answered', quality.passedInspectionId)).toEqual([expect.objectContaining({ requestId: zoneRequest, answer: 'SIGNED' })])
    expect((await as(qa2, 'POST', `/quality/amendments/${zoneRequest}/sign`, {}, 409)).error.issues[0].path).toBe('refusal/ANSWERED')
  })

  it('refused with the reason: the value stays as it was', async () => {
    const asked = await as(qa2, 'POST', `/quality/inspections/${quality.passedInspectionId}/amendments`, { field: 'note', after: 'Checked under the wrong light.', reason: 'The note was left out.' }, 201)
    expect((await as(qa1, 'POST', `/quality/amendments/${asked.amendmentId}/refuse`, { reason: 'x' }, 400)).error.issues[0].path).toBe('body/reason')
    const answer = await as(qa1, 'POST', `/quality/amendments/${asked.amendmentId}/refuse`, { reason: 'The light was right; the note is not needed.' }, 201)
    expect(answer.amendments.corrections.find((entry: Json) => entry.id === asked.amendmentId)).toMatchObject({ state: 'REFUSED', ref: null, answer: { kind: 'REFUSED', reason: 'The light was right; the note is not needed.' } })
    expect(answer.amendments.fields.find((entry: Json) => entry.row === null && entry.field === 'note').amendedBy).toBeNull()
  })

  it('the database is the last word: amendments are append-only and an answer by who asked is refused', async () => {
    await expect(admin('UPDATE "InspectionAmendment" SET reason = $2 WHERE id = $1', [zoneRequest, 'changed'])).rejects.toThrow(/append-only/)
    await expect(admin('DELETE FROM "InspectionAmendment" WHERE id = $1', [zoneRequest])).rejects.toThrow(/append-only/)
  })
})

describe('incoming inspections and in-process checks', () => {
  it('reads the seeded correction of SEED-IIN-0002 as signed, and takes a hide note', async () => {
    const view = await ok('viewer', 'GET', `/quality/incoming/${plans.decidedIncomingId}/amendments`)
    expect(view.record).toMatchObject({ type: 'IncomingInspection', status: 'DECIDED', signed: true, amended: true })
    expect(view.corrections[0]).toMatchObject({ id: plans.amendmentId, field: 'note', state: 'SIGNED', ref: 1 })
    expect(view.fields.find((field: Json) => field.row === null && field.field === 'note').value).toBe('Hide 2 went back to the tannery.')
    const hide = view.fields.find((field: Json) => field.row?.type === 'IncomingHideResult')
    const asked = await as(qa1, 'POST', `/quality/incoming/${plans.decidedIncomingId}/amendments`, { field: 'note', row: { type: hide.row.type, id: hide.row.id }, after: 'Scar near the butt.', reason: 'Written on paper at the dock.' }, 201)
    expect(asked.amendments.corrections.find((entry: Json) => entry.id === asked.amendmentId)).toMatchObject({ row: { type: 'IncomingHideResult', id: hide.row.id }, state: 'WAITING' })
  })

  it('a decided in-process check takes a note correction; an open one is refused', async () => {
    const check = await ok('viewer', 'GET', `/quality/inprocess/checks/${plans.rovingId}/amendments`)
    expect(check.record).toMatchObject({ type: 'InProcessCheck', signed: true })
    await as(qa2, 'POST', `/quality/inprocess/checks/${plans.rovingId}/amendments`, { field: 'note', after: 'Seen at 10:40.', reason: 'Time left out.' }, 201)
    expect((await refused('asker', 'POST', `/quality/inprocess/checks/${plans.rovingId}/amendments`, { field: 'pieces', after: '9', reason: 'Counted again.' }, 400)).issues[0].path).toBe('body/field')
  })
})
