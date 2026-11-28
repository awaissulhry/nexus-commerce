import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Clock } from '@nexus/factory-domain/core/time'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAndon, type AndonSeed } from '../../../../../../packages/factory-db/seed/andon'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seedDepartmentId } from '../../../../../../packages/factory-db/seed/product'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type RequestContext, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { answerAsk, openDesignerAsks, takeAsk } from './asks'
import { runCallEscalation } from './escalation'

/**
 * owb-fl3 (S5 server B; order workflow pick C) — problems and asks on a phone, on the local stack with the app's real routes: a
 * throwaway PostgreSQL 17 database from the migrations (the runtime logins, row-level security and the help-call guards are
 * real), the factory-db seeds up to the line's signals (plant A1 names workers; its help-call types include the floor's problems
 * MATERIAL, DAMAGED, UNCLEAR, MACHINE, PAPER and asks ASK_LOGO … ASK_OTHER, escalating after 10 minutes; plant B1 has PAPER only),
 * and a made-up PHONE of A1's operator whose session's department pick is set by hand (POST /floor/session/department is fl1's).
 * Written, not run (Owner rule: checks at the end). Every name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/production/calls/floor-calls`.
 *
 * Walls: a phone call without a department pick → NO_STATION in words; a call of another site's type → 404; a file on someone
 * else's call refused; escalation sets escalatedAt once and never for SOLVED / CANCELLED; the floor's read of a basket's calls
 * carries no person and no office note beyond the answer; another customer's basket is not found in the office.
 */

let h: Harness
let app: FastifyInstance
let andon: AndonSeed

const ns = { a: 'calls-floor-a', b: 'calls-floor-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  actor: idOf(ns.a, 'actor'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  siteB1: idOf(ns.a, 'site:B1'),
  sew1: idOf(ns.a, 'site:A1:station:SEW-01'),
  sew2: idOf(ns.a, 'site:A1:station:SEW-02'),
  operator: idOf(ns.a, 'worker:A1:operator'),
  lead: idOf(ns.a, 'worker:A1:lead'),
  wo1: idOf(ns.a, 'production:work-order:WO-0001'),
  bundle1: idOf(ns.a, 'production:bundle:WO-0001:1'),
  sewing: seedDepartmentId(ns.a, 4),
  molding: seedDepartmentId(ns.a, 8),
  phone: newId(),
  phoneSession: newId(),
  sew2Tablet: newId(),
}

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId, grants })
const floorAt = (deviceId: string, actorId: string, permissions: Permission[]): SessionContext => ({
  audience: 'floor',
  tenantId: A.tenant,
  actorId,
  siteId: A.siteA1,
  deviceId,
  grants: [{ permissions, companies: [A.companyA], sites: [A.siteA1], parties: 'all' }],
})
const SESSIONS: Record<string, SessionContext> = {
  manager: office([grant(['production.calls.view', 'production.calls.answer', 'production.calls.manage'])], A.actor),
  companyB: office([grant(['production.calls.view', 'production.calls.answer'], [A.companyB])]),
  phone: floorAt(A.phone, A.operator, ['floor.work', 'production.scan']),
  sew2: floorAt(A.sew2Tablet, A.lead, ['floor.work']),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `fl3-${run}-${++keys}`
let cid = 0
const clientId = () => `call-${run}-${++cid}`
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': freshKey() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: 'GET' | 'POST', url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
const PERSON_KEYS = /^(workerId|employeeId|caller|seenBy|seenById|onTheWayById|solvedById|cancelledById|createdById|userId|name|note)$/
const at = (date: Date): Clock => ({ now: () => date }) as Clock
const quiet = { info() {}, warn() {}, error() {} } as never
const typeOf = async (code: string, siteId = A.siteA1) => (await admin<{ id: string }>('SELECT id FROM "HelpCallType" WHERE "siteId" = $1 AND code = $2', [siteId, code]))[0]!.id
const pick = async (departmentId: string | null, stationId: string | null) => admin('UPDATE "FloorSession" SET "departmentId" = $2, "stationId" = $3 WHERE id = $1', [A.phoneSession, departmentId, stationId])
const callRow = async (id: string) => (await admin('SELECT status::text AS status, "stationId", "escalatedAt", "resolutionNote", spot FROM "HelpCall" WHERE id = $1', [id]))[0]!

beforeAll(async () => {
  h = await startHarness('calls-floor')
  for (const namespace of [ns.a, ns.b]) {
    await seedCore({ db: h.database, namespace })
    await seedReasons({ db: h.database, namespace })
    const seeded = await seedAndon({ db: h.database, namespace })
    await seedNumbering({ db: h.database, namespace })
    if (namespace === ns.a) andon = seeded
  }
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) =>
    applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }),
  )
  // The operator's own phone (PHONE mode, their personal device) with a live session; a tablet at SEW-02.
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", mode, "personalWorkerId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, 'PHONE', $5, 'Operator phone', 'HANDHELD', 'ACTIVE', now())`, [A.phone, A.tenant, A.companyA, A.siteA1, A.operator])
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", mode, name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, 'STATION', 'Sewing tablet 2', 'TABLET', 'ACTIVE', now())`, [A.sew2Tablet, A.tenant, A.companyA, A.siteA1, A.sew2])
  await admin(
    `INSERT INTO "FloorSession" (id, "tenantId", "siteId", "deviceId", "workerId", "tokenHash", "startedAt", "lastSeenAt", "idleExpiresAt", "endsAt") VALUES ($1, $2, $3, $4, $5, $6, now(), now(), now() + interval '1 hour', now() + interval '8 hours')`,
    [A.phoneSession, A.tenant, A.siteA1, A.phone, A.operator, randomBytes(32).toString('hex')],
  )
  await admin('UPDATE "Device" SET "currentSessionId" = $2, "inUseSince" = now() WHERE id = $1', [A.phone, A.phoneSession])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

let problemCallId: string
let askCallId: string

describe('the windows’ tiles: problems and asks are help-call types by code (settle 5)', () => {
  it('lists the site’s ACTIVE problem types in its order, and the asks with who answers them', async () => {
    const problems = await ok('phone', 'GET', '/production/calls/station/types?for=PROBLEM')
    expect(problems.types.map((type: Json) => type.code)).toEqual(['MATERIAL', 'DAMAGED', 'UNCLEAR', 'MACHINE', 'PAPER'])
    expect(problems.types.every((type: Json) => type.to === null && type.active === true && type.escalateAfterMinutes === 10)).toBe(true)
    expect(problems.none).toBeNull()
    const asks = await ok('phone', 'GET', '/production/calls/station/types?for=ASK')
    expect(asks.types.map((type: Json) => [type.code, type.to])).toEqual([
      ['ASK_LOGO', 'DESIGNER'],
      ['ASK_PATCH', 'DESIGNER'],
      ['ASK_TO_PATCH', 'TEAM_LEADER'],
      ['ASK_UNCLEAR', 'DESIGNER'],
      ['ASK_OTHER', 'TEAM_LEADER'],
    ])
    // BASE-LANDED "known red" closed: the codes are in the HELP_CALL reason list now (words, not the bare code).
    expect(asks.types[0]).toMatchObject({ labelEn: 'Ask: logo missing', labelIt: 'Domanda: manca il logo' })
  })

  it('a switched-off type is not shown; none left → a sentence, never an empty box', async () => {
    await admin('UPDATE "HelpCallType" SET active = false WHERE "siteId" = $1 AND code LIKE $2', [A.siteA1, 'ASK_%'])
    const asks = await ok('phone', 'GET', '/production/calls/station/types?for=ASK')
    expect(asks.types).toEqual([])
    expect(asks.none).toMatch(/no ask tiles/)
    await admin('UPDATE "HelpCallType" SET active = true WHERE "siteId" = $1 AND code LIKE $2', [A.siteA1, 'ASK_%'])
  })
})

describe('a phone raises a problem at its department pick (settles 2–4)', () => {
  it('REFUSED without a pick: NO_STATION, "Pick your department first."', async () => {
    await pick(null, null)
    const error = await no('phone', 'POST', '/production/calls/station', { typeId: await typeOf('DAMAGED'), clientEventId: clientId(), workOrderId: A.wo1, bundleId: A.bundle1 }, 409)
    expect(refusalOf(error)).toBe('refusal/NO_STATION')
    expect(error.message).toBe('Pick your department first.')
  })

  it('REFUSED for a department with no station at the site: the words say so', async () => {
    await pick(A.molding, null)
    const error = await no('phone', 'POST', '/production/calls/station', { typeId: await typeOf('DAMAGED'), clientEventId: clientId(), workOrderId: A.wo1, bundleId: A.bundle1 }, 409)
    expect(refusalOf(error)).toBe('refusal/NO_STATION')
    expect(error.message).toBe('This department has no station at this site. Ask the office to add one.')
  })

  it('with the pick the call goes to its station; no waiting is booked for a phone; a second tap answers the open call', async () => {
    await pick(A.sewing, A.sew1)
    const sent = await ok('phone', 'POST', '/production/calls/station', { typeId: await typeOf('DAMAGED'), clientEventId: clientId(), workOrderId: A.wo1, bundleId: A.bundle1 }, 201)
    problemCallId = sent.call.id
    expect(sent.call).toMatchObject({ station: { id: A.sew1 }, bundle: { id: A.bundle1 }, status: 'SENT' })
    expect((await callRow(problemCallId)).stationId).toBe(A.sew1)
    expect(await admin('SELECT id FROM "OffStandardEntry" WHERE "helpCallId" = $1', [problemCallId])).toEqual([])
    const again = await ok('phone', 'POST', '/production/calls/station', { typeId: await typeOf('DAMAGED'), clientEventId: clientId(), workOrderId: A.wo1 }, 200)
    expect(again).toMatchObject({ existing: true, call: { id: problemCallId } })
  })

  it('a type of another site is not found', async () => {
    expect((await call('phone', 'POST', '/production/calls/station', { typeId: await typeOf('PAPER', A.siteB1), clientEventId: clientId() })).statusCode).toBe(404)
  })
})

describe('a photo, a voice note and the spot on the caller’s own open call', () => {
  const photo = { originalName: 'damage.jpg', contentType: 'image/jpeg', sizeBytes: 2048, sha256: 'a'.repeat(64) }
  it('announces a PHOTO of the HelpCall shared with the site’s floor', async () => {
    const answer = await ok('phone', 'POST', `/production/calls/${problemCallId}/files`, photo, 201)
    expect(answer.file).toMatchObject({ recordType: 'HelpCall', recordId: problemCallId, kind: 'PHOTO', visibility: ['OFFICE', 'FLOOR'], floorSiteId: A.siteA1 })
    expect(answer.upload.method).toBe('PUT')
  })
  it('REFUSED: a voice note without its length, a video, and a file on someone else’s call', async () => {
    expect(refusalOf(await no('phone', 'POST', `/production/calls/${problemCallId}/files`, { ...photo, originalName: 'say.webm', contentType: 'audio/webm' }, 400))).toBe('body/durationSeconds')
    expect(refusalOf(await no('phone', 'POST', `/production/calls/${problemCallId}/files`, { ...photo, originalName: 'clip.mp4', contentType: 'video/mp4' }, 400))).toBe('body/contentType')
    expect(refusalOf(await no('sew2', 'POST', `/production/calls/${problemCallId}/files`, photo, 409))).toBe('refusal/NOT_YOUR_CALL')
  })
  it('sets the spot 0–8 while the call is open', async () => {
    expect((await ok('phone', 'POST', `/production/calls/${problemCallId}/spot`, { spot: 4 })).spot).toBe(4)
    expect((await callRow(problemCallId)).spot).toBe(4)
    expect((await call('phone', 'POST', `/production/calls/${problemCallId}/spot`, { spot: 9 })).statusCode).toBe(400)
  })
})

describe('the escalation after the type’s minutes (R53)', () => {
  it('sets escalatedAt once, with its event; never again, never for a solved call', async () => {
    const sentAt = new Date((await admin<{ sentAt: Date }>('SELECT "sentAt" FROM "HelpCall" WHERE id = $1', [problemCallId]))[0]!.sentAt)
    expect((await runCallEscalation({ database: h.database, log: quiet, clock: at(new Date(sentAt.getTime() + 9 * 60_000)) })).escalated).toBe(0)
    const first = await runCallEscalation({ database: h.database, log: quiet, clock: at(new Date(sentAt.getTime() + 11 * 60_000)) })
    expect(first.escalated).toBeGreaterThanOrEqual(1)
    const escalatedAt = (await callRow(problemCallId)).escalatedAt
    expect(escalatedAt).not.toBeNull()
    const events = await admin('SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2', ['help_call.escalated', problemCallId])
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toMatchObject({ callId: problemCallId, code: 'DAMAGED', bundleId: A.bundle1, minutes: 11 })
    await runCallEscalation({ database: h.database, log: quiet, clock: at(new Date(sentAt.getTime() + 30 * 60_000)) })
    expect((await callRow(problemCallId)).escalatedAt).toEqual(escalatedAt)
    expect(await admin('SELECT id FROM "OutboxEvent" WHERE type = $1 AND subject = $2', ['help_call.escalated', problemCallId])).toHaveLength(1)
  })

  it('a SOLVED or CANCELLED call is never escalated', async () => {
    const sent = await ok('phone', 'POST', '/production/calls/station', { typeId: await typeOf('MACHINE'), clientEventId: clientId(), workOrderId: A.wo1 }, 201)
    await ok('phone', 'POST', `/production/calls/station/${sent.call.id}/solve`, {})
    await runCallEscalation({ database: h.database, log: quiet, clock: at(new Date(Date.now() + 60 * 60_000)) })
    expect((await callRow(sent.call.id)).escalatedAt).toBeNull()
  })
})

describe('the floor’s asks to the designer (S2’s Design desk) and "An answer for you"', () => {
  it('an ask to the designer is listed ASKED, taken, answered; the basket reads the answer and nobody', async () => {
    const sent = await ok('phone', 'POST', '/production/calls/station', { typeId: await typeOf('ASK_LOGO'), clientEventId: clientId(), workOrderId: A.wo1, bundleId: A.bundle1 }, 201)
    askCallId = sent.call.id
    await ok('phone', 'POST', '/production/calls/station', { typeId: await typeOf('ASK_OTHER'), clientEventId: clientId(), workOrderId: A.wo1 }, 201)
    const managerCaller = callerFor(h.database, { ...(SESSIONS.manager as SessionContext), requestId: `fl3-${run}` } as RequestContext)
    const listed = await managerCaller.withClient((db) => openDesignerAsks(db, { companyId: A.companyA }))
    expect(listed.map((ask) => ask.typeCode)).toEqual(['ASK_LOGO'])
    expect(listed[0]).toMatchObject({ callId: askCallId, to: 'DESIGNER', state: 'ASKED', bundleId: A.bundle1, workOrderId: A.wo1 })
    expect(keysOf(listed).filter((key) => PERSON_KEYS.test(key))).toEqual([])

    await takeAsk(managerCaller, askCallId, freshKey())
    expect((await managerCaller.withClient((db) => openDesignerAsks(db, { companyId: A.companyA })))[0]!.state).toBe('TAKEN')
    await answerAsk(managerCaller, askCallId, 'The logo is on page 2 of the design.', freshKey())
    expect((await callRow(askCallId))).toMatchObject({ status: 'SOLVED', resolutionNote: 'The logo is on page 2 of the design.' })
    expect(await managerCaller.withClient((db) => openDesignerAsks(db, { companyId: A.companyA }))).toEqual([])

    const read = await ok('phone', 'GET', `/production/baskets/${A.bundle1}/calls`)
    const answered = read.calls.find((entry: Json) => entry.id === askCallId)
    expect(answered).toMatchObject({ typeCode: 'ASK_LOGO', group: 'ASK', to: 'DESIGNER', state: 'SOLVED', open: false, answer: 'The logo is on page 2 of the design.' })
    // The floor's read names nobody and carries no office note beyond the answer.
    expect(keysOf(read).filter((key) => PERSON_KEYS.test(key))).toEqual([])
    const problem = read.calls.find((entry: Json) => entry.id === problemCallId)
    expect(problem).toMatchObject({ group: 'PROBLEM', open: true, escalated: true, answer: null, spot: 4 })
  })

  it('REFUSED: taking an ask that is not the designer’s; another customer’s basket is not found in the office', async () => {
    const managerCaller = callerFor(h.database, { ...(SESSIONS.manager as SessionContext), requestId: `fl3-${run}-2` } as RequestContext)
    await expect(takeAsk(managerCaller, problemCallId, freshKey())).rejects.toMatchObject({ issues: [{ path: 'refusal/NOT_AN_ASK' }, { path: 'fix' }] })
    expect((await call('companyB', 'GET', `/production/baskets/${A.bundle1}/calls`)).statusCode).toBe(404)
    expect((await call('manager', 'GET', `/production/baskets/${A.bundle1}/calls`)).statusCode).toBe(200)
  })
})

void andon
