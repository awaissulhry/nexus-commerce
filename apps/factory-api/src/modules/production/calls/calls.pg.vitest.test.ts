import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAndon, type AndonSeed } from '../../../../../../packages/factory-db/seed/andon'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPlant } from '../../../../../../packages/factory-db/seed/plant'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type RequestContext, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addRole, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { applyQueued } from '../../../platform/floor-sync/kinds'
import { fanOut } from '../../../platform/notifications/fan-out'
import { systemContext } from '../../../platform/outbox/system'

/**
 * Help calls (B-W2b-35; MES-142, MES-143, MES-144, MES-145, MES-147, MES-137) on the local stack with the app's real
 * routes: a throwaway PostgreSQL 17 database from the migrations (the runtime logins: row-level security, the column grants
 * and the …_floor_work_w2b_guards triggers on HelpCallType and HelpCall are real), the factory-db seeds of two tenants up to
 * the line's signals (plant A1 names workers and its operator acknowledged the notice, its team leader did not; B1 names
 * stations; A1's help-call types MATERIAL and MAINTENANCE answered by the line team L1-A, TEAM_LEADER by the site's team
 * leaders, all booking the waiting to WAIT_HELP; a SOLVED material call with its waiting block and an open maintenance call
 * at SEW-02), the standard reason lists, the plant (a maintenance job at A1), and made-up tablets at SEW-01, SEW-02, B1's
 * SEW-01 and a line tablet of L1 (no station). Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/production/calls`.
 */

let h: Harness
let app: FastifyInstance
let andon: AndonSeed

const ns = { a: 'calls-a', b: 'calls-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  actor: idOf(ns.a, 'actor'),
  member: idOf(ns.a, 'user:member'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  siteB1: idOf(ns.a, 'site:B1'),
  lineL1: idOf(ns.a, 'site:A1:line:L1'),
  sew1: idOf(ns.a, 'site:A1:station:SEW-01'),
  sew2: idOf(ns.a, 'site:A1:station:SEW-02'),
  b1Sew1: idOf(ns.a, 'site:B1:station:SEW-01'),
  operator: idOf(ns.a, 'worker:A1:operator'),
  lead: idOf(ns.a, 'worker:A1:lead'),
  b1Operator: idOf(ns.a, 'worker:B1:operator'),
  wo1: idOf(ns.a, 'production:work-order:WO-0001'),
  bundle1: idOf(ns.a, 'production:bundle:WO-0001:1'),
  teamA: idOf(ns.a, 'people:team:A1:L1-A'),
  teamB: idOf(ns.a, 'people:team:B1:L1-B'),
  sewTablet: newId(),
  sew2Tablet: newId(),
  lineTablet: newId(),
  b1Tablet: newId(),
}
const B = { tenant: idOf(ns.b, 'tenant') }
const TENANT: TestTenant = { id: A.tenant, slug: ns.a, companies: [{ id: A.companyA, code: 'A' }, { id: A.companyB, code: 'B' }] }

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId, actorId, grants })
const floorAt = (deviceId: string, actorId: string, permissions: Permission[], site = { companyId: A.companyA, siteId: A.siteA1 }): SessionContext => ({
  audience: 'floor',
  tenantId: A.tenant,
  actorId,
  siteId: site.siteId,
  deviceId,
  grants: [{ permissions, companies: [site.companyId], sites: [site.siteId], parties: 'all' }],
})
const ALL: Permission[] = ['production.calls.view', 'production.calls.answer', 'production.calls.manage']
const RESPONDER: Permission[] = ['floor.work', 'floor.lead', 'production.calls.view', 'production.calls.answer']
const SESSIONS: Record<string, SessionContext> = {
  manager: office(A.tenant, [grant(ALL)], A.actor),
  viewer: office(A.tenant, [grant(['production.calls.view'])]),
  companyB: office(A.tenant, [grant(ALL, [A.companyB])]),
  otherTenant: office(B.tenant, [grant(ALL)]),
  operator: floorAt(A.sewTablet, A.operator, ['floor.work']),
  operatorAtSew2: floorAt(A.sew2Tablet, A.operator, ['floor.work']),
  operatorOnLine: floorAt(A.lineTablet, A.operator, ['floor.work']),
  lead: floorAt(A.lineTablet, A.lead, RESPONDER),
  b1Operator: floorAt(A.b1Tablet, A.b1Operator, ['floor.work'], { companyId: A.companyB, siteId: A.siteB1 }),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `t-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key ?? freshKey() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
const callRow = async (id: string) => (await admin('SELECT status::text AS status, "workerId", "employeeId", "lineId", "seenAt", "seenById", "onTheWayAt", "onTheWayById", "solvedAt", "solvedById", "cancelledById", "resolutionCode", "outcomeRecordType", note, version FROM "HelpCall" WHERE id = $1', [id]))[0]!
const eventsOf = async (type: string, subject: string) => admin('SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id', [type, subject])
const waitingOf = async (callId: string) => admin('SELECT b.status::text AS status, b.source::text AS source, b."workerId", b."stationId", b."startedAt", b."endedAt", c.code FROM "OffStandardEntry" b JOIN "OffStandardCode" c ON c.id = b."codeId" WHERE b."helpCallId" = $1 ORDER BY b."startedAt"', [callId])
const auditOf = async (recordId: string) => admin('SELECT action, before, after, reason FROM "AuditLog" WHERE "recordId" = $1 ORDER BY "at", id', [recordId])
let cid = 0
const clientId = () => `call-${run}-${++cid}`
/** Person words that must never travel in a list, a board, a count or an event. */
const PERSON_KEYS = /^(workerId|employeeId|caller|seenById|onTheWayById|solvedById|cancelledById|createdById|userId)$/

/** The worker's fan-out over the outbox rows of these types written since the mark; how many notifications it made. */
let mark = new Date(0)
async function fanOutSince(types: readonly string[]): Promise<number> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = ANY($2) AND "occurredAt" >= $3 ORDER BY "occurredAt", id`, [A.tenant, types, mark])
  let made = 0
  for (const row of rows) {
    const envelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }
    made += await fanOut(callerFor(h.database, systemContext(A.tenant, `test-${row.id}`)), envelope)
  }
  mark = new Date()
  return made
}

const floorCaller = (session: string) => callerFor(h.database, { ...(SESSIONS[session] as SessionContext), requestId: `test-${run}-${session}` } as RequestContext)

beforeAll(async () => {
  h = await startHarness('calls')
  for (const namespace of [ns.a, ns.b]) {
    await seedCore({ db: h.database, namespace })
    await seedReasons({ db: h.database, namespace })
    const seeded = await seedAndon({ db: h.database, namespace })
    await seedNumbering({ db: h.database, namespace })
    await seedPlant({ db: h.database, namespace })
    if (namespace === ns.a) andon = seeded
  }
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) =>
    applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }),
  )
  // The line team's lead (E2) answers from the office too: their account gets the floor supervisor's role.
  await addRole(h, TENANT, A.member, 'floor_supervisor')
  const device = `INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", "lineId", mode, name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, $6, $7::"DeviceMode", $8, 'TABLET', 'ACTIVE', now())`
  await admin(device, [A.sewTablet, A.tenant, A.companyA, A.siteA1, A.sew1, null, 'STATION', 'Sewing tablet 1'])
  await admin(device, [A.sew2Tablet, A.tenant, A.companyA, A.siteA1, A.sew2, null, 'STATION', 'Sewing tablet 2'])
  await admin(device, [A.lineTablet, A.tenant, A.companyA, A.siteA1, null, A.lineL1, 'LINE', 'Line 1 tablet'])
  await admin(device, [A.b1Tablet, A.tenant, A.companyB, A.siteB1, A.b1Sew1, null, 'STATION', 'B1 sewing tablet'])
  mark = new Date()
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

let qualityTypeId: string
let materialCallId: string
let leadCallId: string

describe('the help-call types and who answers them (MES-144; production.settings "Help-call routing")', () => {
  it('lists the site’s types with their words, team (or the site’s team leaders), members, waiting code and use', async () => {
    const answer = await ok('manager', 'GET', `/production/calls/types?siteId=${A.siteA1}`)
    expect(answer.canManage).toBe(true)
    expect(answer.types.map((type: Json) => type.code)).toEqual(['MATERIAL', 'MAINTENANCE', 'TEAM_LEADER'])
    const [material, maintenance, teamLeader] = answer.types
    expect(material).toMatchObject({ kind: 'MATERIAL', labelEn: 'Material', labelIt: 'Materiale', icon: 'package', codeListed: true, responder: { kind: 'TEAM', team: { code: 'L1-A' }, members: 3 }, escalateAfterMinutes: 10, waitingCode: { code: 'WAIT_HELP' }, usedCount: 1, openCount: 0 })
    expect(maintenance).toMatchObject({ openCount: 1, responder: { kind: 'TEAM' } })
    expect(teamLeader).toMatchObject({ kind: 'SUPERVISOR', responder: { kind: 'TEAM_LEADERS', team: null, members: 1 }, escalateAfterMinutes: null })
    expect((await ok('viewer', 'GET', `/production/calls/types?siteId=${A.siteA1}`)).canManage).toBe(false)
    expect((await call('companyB', 'GET', `/production/calls/types?siteId=${A.siteA1}`)).statusCode).toBe(404)
  })

  it('adds a type from an active help-call code; REFUSED: the same code twice, a code not in the list, a team of another site, an indirect waiting code, 300 minutes', async () => {
    const created = await ok('manager', 'POST', '/production/calls/types', { siteId: A.siteA1, code: 'quality', kind: 'QUALITY', responderTeamId: A.teamA, escalateAfterMinutes: 15 }, 201)
    qualityTypeId = created.type.id
    expect(created.type).toMatchObject({ code: 'QUALITY', kind: 'QUALITY', sortOrder: 40, active: true, responder: { kind: 'TEAM', members: 3 }, labelEn: 'Quality' })
    expect((await eventsOf('help_call_type.changed', qualityTypeId))[0]!.payload).toEqual({ typeId: qualityTypeId, code: 'QUALITY', kind: 'QUALITY', change: 'ADDED', fields: [] })
    expect(refusalOf(await no('manager', 'POST', '/production/calls/types', { siteId: A.siteA1, code: 'QUALITY', kind: 'QUALITY' }, 409))).toBe('refusal/CODE_TAKEN')
    expect(refusalOf(await no('manager', 'POST', '/production/calls/types', { siteId: A.siteA1, code: 'NOT_LISTED', kind: 'OTHER' }, 409))).toBe('refusal/CODE_NOT_LISTED')
    expect(refusalOf(await no('manager', 'POST', '/production/calls/types', { siteId: A.siteA1, code: 'SAFETY', kind: 'OTHER', responderTeamId: A.teamB }, 409))).toBe('refusal/TEAM_NOT_ACTIVE')
    expect(refusalOf(await no('manager', 'POST', '/production/calls/types', { siteId: A.siteA1, code: 'SAFETY', kind: 'OTHER', offStandardCodeId: andon.codeIds.CLEANING }, 409))).toBe('refusal/WAITING_CODE')
    expect(refusalOf(await no('manager', 'POST', '/production/calls/types', { siteId: A.siteA1, code: 'SAFETY', kind: 'OTHER', escalateAfterMinutes: 300 }, 400))).toBe('body/escalateAfterMinutes')
    expect((await call('viewer', 'POST', '/production/calls/types', { siteId: A.siteA1, code: 'SAFETY', kind: 'OTHER' })).statusCode).toBe(403)
  })

  it('changes a type’s routing at its version and switches it off; REFUSED: its kind, a stale version', async () => {
    expect(refusalOf(await no('manager', 'PATCH', `/production/calls/types/${qualityTypeId}`, { version: 1, kind: 'MACHINE' }, 409))).toBe('refusal/KIND_FIXED')
    const changed = await ok('manager', 'PATCH', `/production/calls/types/${qualityTypeId}`, { version: 1, escalateAfterMinutes: 20, offStandardCodeId: andon.codeIds.WAIT_HELP })
    expect(changed.type).toMatchObject({ version: 2, escalateAfterMinutes: 20, waitingCode: { code: 'WAIT_HELP' } })
    const audit = (await auditOf(qualityTypeId)).at(-1)!
    expect(audit).toMatchObject({ action: 'production.changeCallType', before: { escalateAfterMinutes: 15, offStandardCodeId: null }, after: { escalateAfterMinutes: 20, offStandardCodeId: andon.codeIds.WAIT_HELP } })
    expect((await call('manager', 'PATCH', `/production/calls/types/${qualityTypeId}`, { version: 1, sortOrder: 5 })).statusCode).toBe(409)
    const off = await ok('manager', 'PATCH', `/production/calls/types/${qualityTypeId}`, { version: 2, active: false })
    expect(off.type).toMatchObject({ active: false, version: 3 })
    expect((await eventsOf('help_call_type.changed', qualityTypeId)).at(-1)!.payload).toMatchObject({ change: 'SWITCHED_OFF', fields: ['active'] })
  })
})

describe('one tap from the station (MES-142, MES-143, MES-137)', () => {
  it('shows the tablet’s station, the site’s active types as tiles and no open call', async () => {
    const state = await ok('operator', 'GET', '/production/calls/station')
    expect(state).toMatchObject({ subject: 'WORKER', station: { id: A.sew1, code: 'SEW-01', line: { id: A.lineL1 } }, open: [] })
    expect(state.tiles.map((tile: Json) => tile.type.code)).toEqual(['MATERIAL', 'MAINTENANCE', 'TEAM_LEADER'])
    expect(state.tiles.every((tile: Json) => tile.open === null)).toBe(true)
  })

  it('sends a material call naming the work order, the bundle and what is missing; the caller and line are known', async () => {
    const sent = await ok('operator', 'POST', '/production/calls/station', { typeId: andon.typeIds.material, clientEventId: clientId(), workOrderId: A.wo1, bundleId: A.bundle1, note: 'Lining for size 52: two metres.' }, 201)
    materialCallId = sent.call.id
    expect(sent).toMatchObject({ existing: false, replayed: false, call: { status: 'SENT', station: { code: 'SEW-01' }, line: { code: 'L1' }, workOrder: { number: 'SEED-WO-0001' }, responderTeam: { code: 'L1-A' }, caller: { kind: 'WORKER', name: 'Seed Worker A1-1' }, bookWaiting: true, coming: null } })
    const [operator] = await admin('SELECT "employeeId" FROM "Worker" WHERE id = $1', [A.operator])
    expect(operator!.employeeId).toEqual(expect.any(String))
    expect(await callRow(materialCallId)).toMatchObject({ status: 'SENT', workerId: A.operator, employeeId: operator!.employeeId, lineId: A.lineL1 })
    const [raised] = await eventsOf('help_call.raised', materialCallId)
    expect(raised!.payload).toMatchObject({ callId: materialCallId, kind: 'MATERIAL', code: 'MATERIAL', stationId: A.sew1, lineId: A.lineL1, workOrderId: A.wo1, bundleId: A.bundle1, by: 'FLOOR' })
    expect(keysOf(raised!.payload).filter((key) => PERSON_KEYS.test(key))).toEqual([])
    expect((await auditOf(materialCallId))[0]).toMatchObject({ action: 'production.sendCall', after: { stationId: A.sew1, workerId: A.operator } })
    // MES-148: the station's waiting books to the type's off-standard code (WAIT_HELP) while the call is open.
    expect(await waitingOf(materialCallId)).toMatchObject([{ status: 'OPEN', source: 'HELP_CALL', workerId: A.operator, stationId: A.sew1, code: 'WAIT_HELP', endedAt: null }])
    expect(sent.call).toMatchObject({ waitingBooked: true, waiting: { code: 'WAIT_HELP', status: 'OPEN', endedAt: null } })
    expect((await eventsOf('production.off_standard_started', (await admin('SELECT id FROM "OffStandardEntry" WHERE "helpCallId" = $1', [materialCallId]))[0]!.id))).toHaveLength(1)
  })

  it('a second tap shows the open call, never a second one; a queued call sent again is made once', async () => {
    const again = await ok('operator', 'POST', '/production/calls/station', { typeId: andon.typeIds.material, clientEventId: clientId() }, 200)
    expect(again).toMatchObject({ existing: true, replayed: false, call: { id: materialCallId } })
    const id = clientId()
    const first = await ok('operator', 'POST', '/production/calls/station', { typeId: andon.typeIds.teamLeader, clientEventId: id }, 201)
    const resent = await ok('operator', 'POST', '/production/calls/station', { typeId: andon.typeIds.teamLeader, clientEventId: id }, 200)
    expect(resent).toMatchObject({ replayed: true, call: { id: first.call.id } })
    expect((await admin('SELECT count(*)::int AS n FROM "HelpCall" WHERE "stationId" = $1 AND status::text IN (\'SENT\', \'SEEN\', \'ON_THE_WAY\')', [A.sew1]))[0]!.n).toBe(2)
    // The station cancels the team-leader call it did not mean.
    const cancelled = await ok('operator', 'POST', `/production/calls/station/${first.call.id}/cancel`, {})
    expect(cancelled.call).toMatchObject({ status: 'CANCELLED', timeline: [{ step: 'SENT' }, { step: 'CANCELLED', by: { kind: 'WORKER', name: 'Seed Worker A1-1' } }] })
    // The operator already waits on the material call: that block covers the time, no second one.
    expect(await waitingOf(first.call.id)).toEqual([])
  })

  it('REFUSED: a switched-off type, a tablet with no station, another station without being the team leader, a bundle of another work order', async () => {
    expect(refusalOf(await no('operator', 'POST', '/production/calls/station', { typeId: qualityTypeId, clientEventId: clientId() }, 409))).toBe('refusal/TYPE_INACTIVE')
    expect(refusalOf(await no('operatorOnLine', 'POST', '/production/calls/station', { typeId: andon.typeIds.material, clientEventId: clientId() }, 409))).toBe('refusal/NO_STATION')
    expect(refusalOf(await no('operator', 'POST', '/production/calls/station', { typeId: andon.typeIds.material, clientEventId: clientId(), stationId: A.sew2 }, 409))).toBe('refusal/OTHER_STATION')
    expect(refusalOf(await no('operator', 'POST', '/production/calls/station', { typeId: andon.typeIds.maintenance, clientEventId: clientId(), bundleId: A.bundle1 }, 400))).toBe('body/workOrderId')
    expect((await call('operator', 'POST', '/production/calls/station', { typeId: andon.typeIds.material, clientEventId: 'has spaces' })).statusCode).toBe(400)
  })

  it('the team leader calls for another station of the line (MES-137: the lead requests extra material); a worker who has not acknowledged the notice is not named', async () => {
    const sent = await ok('lead', 'POST', '/production/calls/station', { typeId: andon.typeIds.teamLeader, clientEventId: clientId(), stationId: A.sew2, note: 'Recut needed at SEW-02.' }, 201)
    leadCallId = sent.call.id
    expect(sent.call).toMatchObject({ station: { code: 'SEW-02' }, caller: null, responderTeam: null })
    expect(await callRow(leadCallId)).toMatchObject({ workerId: null, employeeId: null })
    // Whose waiting it is at SEW-02 is not known: nothing is booked.
    expect(await waitingOf(leadCallId)).toEqual([])
  })

  it('adds words to the open call at its station; REFUSED: from another station', async () => {
    const answer = await ok('operator', 'POST', `/production/calls/station/${materialCallId}/details`, { note: 'Lining for size 52: three metres.' })
    expect(answer.call.note).toBe('Lining for size 52: three metres.')
    expect((await eventsOf('help_call.changed', materialCallId))[0]!.payload).toMatchObject({ change: 'DETAILS', outcomeRecordType: null })
    expect(refusalOf(await no('operatorAtSew2', 'POST', `/production/calls/station/${materialCallId}/details`, { note: 'x' }, 409))).toBe('refusal/NOT_THIS_STATION')
  })

  it('tells the responder team’s office people (ALERT), never the caller; the site’s team leaders for a type with no team', async () => {
    const made = await fanOutSince(['help_call.raised'])
    expect(made).toBeGreaterThanOrEqual(2)
    const told = await admin('SELECT "userId", category::text AS category, "messageKey", "recordType", "recordId", "recordLabel" FROM "Notification" WHERE "recordType" = \'HelpCall\' ORDER BY "createdAt", id')
    expect(told.find((row) => row.recordId === materialCallId)).toMatchObject({ userId: A.member, category: 'ALERT', messageKey: 'notifications.calls.raised', recordLabel: 'SEW-01' })
    expect(told.find((row) => row.recordId === leadCallId)).toMatchObject({ userId: A.member, recordLabel: 'SEW-02' })
    expect(told.every((row) => row.userId === A.member)).toBe(true)
  })
})

describe('the line view and the line TV (MES-147)', () => {
  it('shows each station of the line by its call state, no name and no output; the line tablet reads its own line', async () => {
    const board = await ok('lead', 'GET', '/production/calls/board')
    expect(board.line).toMatchObject({ id: A.lineL1, code: 'L1' })
    const byCode = Object.fromEntries(board.stations.map((station: Json) => [station.code, station]))
    expect(byCode['SEW-01']).toMatchObject({ state: 'CALLING', material: true })
    expect(byCode['SEW-02']).toMatchObject({ state: 'CALLING', material: false })
    expect(byCode['SEW-02'].calls.map((row: Json) => row.code).sort()).toEqual(['MAINTENANCE', 'TEAM_LEADER'])
    expect(board.canAnswer).toBe(true)
    expect(keysOf(board).filter((key) => PERSON_KEYS.test(key))).toEqual([])
    expect((await ok('manager', 'GET', `/production/calls/board?lineId=${A.lineL1}`)).stations).toHaveLength(2)
    expect((await call('manager', 'GET', '/production/calls/board')).statusCode).toBe(400)
    expect((await call('operator', 'GET', '/production/calls/board')).statusCode).toBe(403)
  })
})

describe('Sent → Seen → On the way → Solved, with times (MES-145)', () => {
  it('the team leader is on the way: the call is seen at the same moment, by them; REFUSED: seen again, an operator answering', async () => {
    const answer = await ok('lead', 'POST', `/production/calls/${materialCallId}/on-the-way`, {})
    expect(answer.call).toMatchObject({ status: 'ON_THE_WAY', coming: { step: 'ON_THE_WAY', by: { kind: 'WORKER', name: 'Seed Worker A1-2' }, team: { code: 'L1-A' } } })
    const row = await callRow(materialCallId)
    expect(row).toMatchObject({ status: 'ON_THE_WAY', seenById: A.lead, onTheWayById: A.lead })
    expect(row.seenAt).toEqual(row.onTheWayAt)
    expect((await eventsOf('help_call.answered', materialCallId))[0]!.payload).toMatchObject({ step: 'ON_THE_WAY', status: 'ON_THE_WAY', actor: 'RESPONDER', by: 'FLOOR' })
    expect(refusalOf(await no('lead', 'POST', `/production/calls/${materialCallId}/seen`, {}, 409))).toBe('refusal/ALREADY_ON_THE_WAY')
    expect((await call('operator', 'POST', `/production/calls/${materialCallId}/seen`, {})).statusCode).toBe(403)
  })

  it('the station sees who is coming, and closes its own call: "It’s solved"; REFUSED: solved again', async () => {
    const state = await ok('operator', 'GET', '/production/calls/station')
    expect(state.tiles.find((tile: Json) => tile.type.code === 'MATERIAL').open).toMatchObject({ id: materialCallId, coming: { by: { name: 'Seed Worker A1-2' } } })
    const solved = await ok('operator', 'POST', `/production/calls/station/${materialCallId}/solve`, {})
    expect(solved.call).toMatchObject({ status: 'SOLVED', open: false, openSeconds: null })
    expect(solved.call.timeline.map((step: Json) => step.step)).toEqual(['SENT', 'SEEN', 'ON_THE_WAY', 'SOLVED'])
    expect(solved.call.times.resolveSeconds).toBeGreaterThanOrEqual(0)
    expect(await callRow(materialCallId)).toMatchObject({ status: 'SOLVED', solvedById: A.operator })
    // The waiting ends with the call: WAIT_HELP needs no approval, so it is approved as it ends.
    const [waited] = await waitingOf(materialCallId)
    expect(waited).toMatchObject({ status: 'APPROVED', source: 'HELP_CALL' })
    expect(new Date(waited!.endedAt).toISOString()).toBe(solved.call.solvedAt)
    expect(refusalOf(await no('operator', 'POST', `/production/calls/station/${materialCallId}/solve`, {}, 409))).toBe('refusal/SOLVED')
  })

  it('the office sees the maintenance call and solves it with how; cancels the team-leader call with the reason; REFUSED: a solved call cancelled', async () => {
    const maintenance = andon.callIds[1]
    const seen = await ok('manager', 'POST', `/production/calls/${maintenance}/seen`, { version: 1 })
    expect(seen.call).toMatchObject({ status: 'SEEN', seenBy: { kind: 'USER' } })
    expect(await callRow(maintenance)).toMatchObject({ seenById: A.actor })
    expect((await call('manager', 'POST', `/production/calls/${maintenance}/solve`, { version: 1, resolutionCode: 'FIXED' })).statusCode).toBe(409)
    const solved = await ok('manager', 'POST', `/production/calls/${maintenance}/solve`, { version: 2, resolutionCode: 'FIXED', resolutionNote: 'Needle plate tightened.' })
    expect(solved.call).toMatchObject({ status: 'SOLVED', resolutionCode: 'FIXED', resolutionNote: 'Needle plate tightened.' })
    expect(refusalOf(await no('manager', 'POST', `/production/calls/${maintenance}/cancel`, { reason: 'Sent by mistake.' }, 409))).toBe('refusal/SOLVED')
    const cancelled = await ok('manager', 'POST', `/production/calls/${leadCallId}/cancel`, { reason: 'Recut done already.' })
    expect(cancelled.call.status).toBe('CANCELLED')
    expect((await auditOf(leadCallId)).at(-1)).toMatchObject({ action: 'production.cancelCall', reason: 'Recut done already.' })
  })

  it('names what a call led to once (a maintenance job of the site); REFUSED: twice, a record that is not of the site', async () => {
    const [job] = await admin<{ id: string }>('SELECT id::text FROM "MaintenanceJob" WHERE "siteId" = $1 ORDER BY id LIMIT 1', [A.siteA1])
    expect(refusalOf(await no('manager', 'POST', `/production/calls/${andon.callIds[1]}/outcome`, { recordType: 'MaintenanceJob', recordId: newId() }, 400))).toBe('body/recordId')
    const named = await ok('manager', 'POST', `/production/calls/${andon.callIds[1]}/outcome`, { recordType: 'MaintenanceJob', recordId: job!.id })
    expect(named.call.outcome).toEqual({ recordType: 'MaintenanceJob', recordId: job!.id })
    expect(refusalOf(await no('manager', 'POST', `/production/calls/${andon.callIds[1]}/outcome`, { recordType: 'MaintenanceJob', recordId: job!.id }, 409))).toBe('refusal/OUTCOME_NAMED')
  })
})

describe('the office’s Help calls (production.calls SCR-142): per call and line, never per person', () => {
  it('lists the calls without naming a floor worker; a call’s record names the caller and who took each step', async () => {
    const all = await ok('manager', 'GET', `/production/calls?siteId=${A.siteA1}&view=all`)
    expect(all.calls.length).toBeGreaterThanOrEqual(5)
    expect(keysOf(all).filter((key) => PERSON_KEYS.test(key))).toEqual([])
    const material = all.calls.find((row: Json) => row.id === materialCallId)
    expect(material).toMatchObject({ status: 'SOLVED', seenBy: { kind: 'WORKER', name: null }, times: { responseSeconds: expect.any(Number) } })
    expect((await ok('manager', 'GET', `/production/calls?siteId=${A.siteA1}`)).calls.every((row: Json) => row.open)).toBe(true)
    expect((await ok('manager', 'GET', `/production/calls?kind=MATERIAL&view=all`)).calls.every((row: Json) => row.type.kind === 'MATERIAL')).toBe(true)
    expect((await ok('companyB', 'GET', `/production/calls?view=all`)).calls.filter((row: Json) => row.siteId === A.siteA1)).toEqual([])
    const record = await ok('manager', 'GET', `/production/calls/${materialCallId}`)
    expect(record).toMatchObject({ canAnswer: true, call: { caller: { kind: 'WORKER', name: 'Seed Worker A1-1' }, timeline: [{ step: 'SENT', by: null }, { step: 'SEEN', by: { name: 'Seed Worker A1-2' } }, { step: 'ON_THE_WAY' }, { step: 'SOLVED', by: { name: 'Seed Worker A1-1' } }] } })
    const seeded = await ok('manager', 'GET', `/production/calls/${andon.callIds[0]}`)
    expect(seeded.call).toMatchObject({ waitingBooked: true, waiting: { code: 'WAIT_HELP', status: 'APPROVED' } })
    expect((await call('otherTenant', 'GET', `/production/calls/${materialCallId}`)).statusCode).toBe(404)
  })

  it('counts the tiles and today’s median response time; calls by hour by kind and line', async () => {
    const counts = await ok('manager', 'GET', `/production/calls/counts?siteId=${A.siteA1}`)
    expect(counts.tiles.OPEN).toBe(0)
    expect(counts.tiles.ANSWERED_TODAY).toBe(1)
    expect(counts.medianResponseSeconds).toEqual(expect.any(Number))
    expect(counts.waitingMinutes).toBe(5)
    const day = await ok('manager', 'GET', `/production/calls/by-hour?siteId=${A.siteA1}`)
    expect(day.hours).toHaveLength(24)
    expect(day.hours.reduce((sum: number, hour: Json) => sum + hour.calls, 0)).toBe(3)
    expect(day.byKind.find((row: Json) => row.kind === 'MATERIAL')).toMatchObject({ calls: 1, answered: 1 })
    expect(day.lines).toEqual([{ id: A.lineL1, code: 'L1', name: expect.any(String) }])
    expect(keysOf(day).filter((key) => PERSON_KEYS.test(key))).toEqual([])
  })
})

describe('a site that records stations, and the floor’s queue', () => {
  it('B1 names nobody: neither the caller nor who closed it at the station', async () => {
    const type = await ok('manager', 'POST', '/production/calls/types', { siteId: A.siteB1, code: 'SAFETY', kind: 'OTHER' }, 201)
    expect(type.type.responder).toMatchObject({ kind: 'TEAM_LEADERS' })
    const sent = await ok('b1Operator', 'POST', '/production/calls/station', { typeId: type.type.id, clientEventId: clientId() }, 201)
    expect(sent.call.caller).toBeNull()
    await ok('b1Operator', 'POST', `/production/calls/station/${sent.call.id}/solve`, {})
    expect(await callRow(sent.call.id)).toMatchObject({ status: 'SOLVED', workerId: null, solvedById: null })
  })

  it('applies a queued call with the tablet’s time once, and queued steps: a responder’s, then the station’s own close', async () => {
    const occurredAt = new Date(Date.now() - 10 * 60_000).toISOString()
    const event = { clientEventId: clientId(), kind: 'andon.call.send' as const, occurredAt, payload: { typeId: andon.typeIds.material } }
    const sent = await applyQueued(floorCaller('operatorAtSew2'), event, { key: `${A.sew2Tablet}.${event.clientEventId}` })
    expect(sent).toMatchObject({ status: 'accepted', result: { type: 'HelpCall' } })
    const id = (sent as { result: { id: string } }).result.id
    expect((await admin('SELECT "sentAt" FROM "HelpCall" WHERE id = $1', [id]))[0]!.sentAt.toISOString()).toBe(occurredAt)
    expect(await applyQueued(floorCaller('operatorAtSew2'), event, { key: `${A.sew2Tablet}.${event.clientEventId}` })).toMatchObject({ status: 'duplicate', result: { id } })
    const comes = { clientEventId: clientId(), kind: 'andon.call.answer' as const, payload: { callId: id, step: 'ON_THE_WAY' } }
    expect(await applyQueued(floorCaller('lead'), comes, { key: `${A.lineTablet}.${comes.clientEventId}` })).toMatchObject({ status: 'accepted' })
    const close = { clientEventId: clientId(), kind: 'andon.call.answer' as const, payload: { callId: id, step: 'CANCELLED' } }
    expect(await applyQueued(floorCaller('operatorAtSew2'), close, { key: `${A.sew2Tablet}.${close.clientEventId}` })).toMatchObject({ status: 'accepted' })
    expect(await callRow(id)).toMatchObject({ status: 'CANCELLED', onTheWayById: A.lead, cancelledById: A.operator })
    expect(await waitingOf(id)).toMatchObject([{ status: 'APPROVED', workerId: A.operator, stationId: A.sew2 }])
    const refused = { clientEventId: clientId(), kind: 'andon.call.answer' as const, payload: { callId: id, step: 'SOLVED' } }
    expect(await applyQueued(floorCaller('operatorAtSew2'), refused, { key: `${A.sew2Tablet}.${refused.clientEventId}` })).toMatchObject({ status: 'refused', refusal: { code: 'CANCELLED' } })
  })
})
