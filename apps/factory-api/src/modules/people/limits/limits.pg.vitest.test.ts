import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { callerFor } from '../../../core/command'
import type { Log } from '../../../core/queue'
import { runAlertEvaluation } from '../../../platform/alerts/engine'
import { fanOut } from '../../../platform/notifications/fan-out'
import { systemContext } from '../../../platform/outbox/system'
import { grant, keysOf, local, openWorld, pathsOf, ROME, type Json, type World } from '../overtime/testing'

/**
 * Working-time limits (B-W2b-42; MES-232; design people.settings "Working-time limits") through the app's real routes on a
 * throwaway PostgreSQL 17: the limits a company keeps, the warnings before one is broken from the time people worked and
 * the roster ahead, and who is alerted. D.Lgs. 66/2003 arts. 4, 5, 7; Statuto dei Lavoratori art. 4 (the warnings of a
 * person are behind the ATTENDANCE gate; a list shows no name and no figure; an alert names a site and a limit). Run with
 * `node scripts/factory/run-pg-tests.mjs modules/people/limits`.
 */

const NS = 'w2b42-limits'
let w: World
const today = businessDate(new Date(), ROME)
const yesterday = plusDays(today, -1)
const companyBody = () => ({ companyId: w.T.companyA, siteId: null, kind: 'OVERTIME_YEARLY_CAP', version: null, limitMinutes: 12000, action: 'WARN', alertRoles: ['admin'], source: 'CCNL', legalReference: 'SAMPLE CCNL art. 7' })
const log: Log = { info: () => undefined, warn: () => undefined, error: () => undefined }

beforeAll(async () => {
  w = await openWorld('w2b42_limits', NS, (T) => ({
    planner: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['people.shifts.view'])] },
    onlyOneCompany: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['people.limits.manage'], [T.companyA])] },
  }))
  await seedRoles({ db: w.database, namespace: NS })
}, 600_000)

afterAll(async () => {
  await w?.close()
}, 60_000)

describe('People settings › Working-time limits (no person in them: no gate)', () => {
  it('reads the six limits in force, with the law beside them and whom they may alert', async () => {
    const answer = await w.ok('planner', 'GET', `/people/limits?siteId=${w.T.siteA1}`)
    expect(answer.limits.map((limit: Json) => limit.kind)).toEqual(['DAILY_REST', 'WEEKLY_REST', 'WEEKLY_AVERAGE', 'BREAK_AFTER', 'OVERTIME_YEARLY_CAP', 'NIGHT_AVERAGE'])
    const rest = (answer.limits as Json[]).find((limit) => limit.kind === 'DAILY_REST')!
    expect(rest).toMatchObject({ inForce: { limitMinutes: 660, source: 'LAW', action: 'WARN' }, own: null, law: { limitMinutes: 660, legalReference: 'D.Lgs. 66/2003 art. 7' } })
    expect(answer.roles.map((role: Json) => role.key)).toContain('floor_supervisor')
    expect(answer.canManage).toBe(false)
    await w.no('nobody', 'GET', `/people/limits?siteId=${w.T.siteA1}`, undefined, 404)
  })

  it('refuses a value looser than the law without the CCNL that allows it', async () => {
    const error = await w.no('hr', 'PUT', '/people/limits', { ...companyBody(), limitMinutes: 18000, source: 'LAW', legalReference: 'D.Lgs. 66/2003 art. 5' }, 400)
    expect(pathsOf(error)).toEqual(['body/limitMinutes'])
    expect(error.message).toContain('needs the CCNL article')
  })

  it('sets a company limit with the CCNL it applies; the site reads it in force; the version guards it', async () => {
    const saved = await w.ok('hr', 'PUT', '/people/limits', companyBody())
    expect(saved).toMatchObject({ kind: 'OVERTIME_YEARLY_CAP', limitMinutes: 12000, source: 'CCNL', status: 'ACTIVE', version: 1 })
    const site = await w.ok('hr', 'GET', `/people/limits?siteId=${w.T.siteA1}`)
    expect((site.limits as Json[]).find((limit) => limit.kind === 'OVERTIME_YEARLY_CAP')).toMatchObject({ inForce: { id: saved.id, limitMinutes: 12000 }, own: null })
    await w.no('hr', 'PUT', '/people/limits', companyBody(), 409)
    const edited = await w.ok('hr', 'PUT', '/people/limits', { ...companyBody(), version: 1, limitMinutes: 13000, action: 'BLOCK' })
    expect(edited).toMatchObject({ id: saved.id, limitMinutes: 13000, action: 'BLOCK', version: 2 })
    await w.no('hr', 'PUT', '/people/limits', { ...companyBody(), version: 1 }, 409)
    const archived = await w.ok('hr', 'POST', `/people/limits/${saved.id}/archive`, { version: 2 })
    expect(archived.status).toBe('ARCHIVED')
    expect(((await w.ok('hr', 'GET', `/people/limits?siteId=${w.T.siteA1}`)).limits as Json[]).find((limit) => limit.kind === 'OVERTIME_YEARLY_CAP')).toMatchObject({ inForce: { limitMinutes: 15000, source: 'LAW' } })
    const events = await w.admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'working_time_rule.changed'`, [w.T.tenant])
    expect(events.map((event) => event.payload.change)).toEqual(['SET', 'SET', 'ARCHIVED'])
  })

  it('refuses a role that does not exist, a group limit without every company, and a site of another company', async () => {
    expect(pathsOf(await w.no('hr', 'PUT', '/people/limits', { ...companyBody(), alertRoles: ['no_such_role'] }, 400))).toEqual(['body/alertRoles'])
    await w.no('onlyOneCompany', 'PUT', '/people/limits', { ...companyBody(), companyId: null, source: 'LAW', limitMinutes: 15000, legalReference: 'D.Lgs. 66/2003 art. 5' }, 403)
    await w.no('hr', 'PUT', '/people/limits', { ...companyBody(), companyId: w.T.companyB, siteId: w.T.siteA1 }, 404)
    await w.no('viewer', 'PUT', '/people/limits', companyBody(), 403)
  })
})

describe('warnings before a limit is broken', () => {
  beforeAll(async () => {
    const { P, T } = w
    // Yesterday P1 worked to 23:00 and clocked out; tomorrow's published shift would start at 06:00 after today's to 23:00.
    await w.roster(P.P1!, yesterday, [840, 1320])
    await w.clock(P.P1!, 'IN', local('14:00', yesterday))
    await w.clock(P.P1!, 'OUT', local('23:00', yesterday))
    await w.roster(P.P1!, today, [360, 840])
    // Overtime close to a low limit the site keeps: a warning before the cap, for the supervisors too.
    await w.ok('hr', 'PUT', '/people/limits', { companyId: T.companyA, siteId: T.siteA1, kind: 'OVERTIME_YEARLY_CAP', version: null, limitMinutes: 60, action: 'WARN', alertRoles: ['floor_supervisor'], source: 'LAW', legalReference: 'D.Lgs. 66/2003 art. 5' })
  })

  it('refuses every read of a person while the gate is off, and raises no alert', async () => {
    expect(pathsOf(await w.no('hr', 'GET', `/people/limits/warnings?siteId=${w.T.siteA1}`, undefined, 409))).toContain('gate/ATTENDANCE')
    expect(pathsOf(await w.no('hr', 'GET', `/people/employees/${w.P.P1}/limits`, undefined, 409))).toContain('gate/ATTENDANCE')
    await runAlertEvaluation({ database: w.database, log })
    expect(await w.admin(`SELECT id FROM "Alert" WHERE "tenantId" = $1 AND "ruleKind" = 'WORKING_TIME_LIMIT'`, [w.T.tenant])).toEqual([])
  })

  it('lists a tone per limit with no name and no figure; one record says it in words', async () => {
    const { P } = w
    await w.openGate()
    await w.pass(yesterday)
    await w.compute(P.P1!, yesterday)
    expect((await w.entries(P.P1!, yesterday)).NIGHT).toMatchObject({ minutes: 60, status: 'PENDING' })
    const list = await w.ok('viewer', 'GET', `/people/limits/warnings?siteId=${w.T.siteA1}`)
    // What a row opens: the person's latest attendance day (their name is inside it).
    const latest = (await w.admin<{ id: string }>(`SELECT id FROM "AttendanceDay" WHERE "employeeId" = $1 ORDER BY date DESC LIMIT 1`, [P.P1]))[0]!
    const row = (list.rows as Json[]).find((entry) => entry.dayId === latest.id)!
    expect(row.checks).toEqual(expect.arrayContaining([{ rule: 'OVERTIME_YEARLY_CAP', state: 'NEAR', level: 'WARN' }, { rule: 'DAILY_REST', state: 'NEAR', level: 'WARN' }]))
    const keys = keysOf(list)
    for (const word of ['name', 'displayName', 'employeeId', 'minutes', 'values', 'usedMinutes']) expect(keys).not.toContain(word)
    expect(JSON.stringify(list)).not.toContain('(made up)')
    expect((await w.ok('viewer', 'GET', `/people/limits/warnings?siteId=${w.T.siteA1}&rule=WEEKLY_AVERAGE`)).rows).toEqual([])
    expect(pathsOf(await w.no('viewer', 'GET', `/people/limits/warnings?siteId=${w.T.siteA1}&employeeId=${P.P1}`, undefined, 400))).toContain('query/filters/employeeId')
    const record = await w.ok('viewer', 'GET', `/people/employees/${P.P1}/limits`)
    expect(record).toMatchObject({ person: { name: 'Alba Uno (made up)' }, overtime: { approvedMinutes: 0, pendingMinutes: 60, limitMinutes: 60 } })
    const cap = (record.checks as Json[]).find((check) => check.rule === 'OVERTIME_YEARLY_CAP')!
    expect(cap.state).toBe('NEAR')
    expect(cap.words).toContain('at most 1 h a year (D.Lgs. 66/2003 art. 5)')
    await w.no('planner', 'GET', `/people/employees/${P.P1}/limits`, undefined, 403)
  })

  it('raises one alert per site and limit, naming nobody, told to the roles the limit names, and clears it by itself', async () => {
    const { T } = w
    const roles = await w.admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1 AND key = 'floor_supervisor'`, [T.tenant])
    await w.admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "validFrom") VALUES ($1, $2, $3, $4, true, now() - interval '1 day')`, [newId(), T.tenant, T.member, roles[0]!.id])
    await runAlertEvaluation({ database: w.database, log })
    const alerts = await w.admin(`SELECT * FROM "Alert" WHERE "tenantId" = $1 AND "ruleKind" = 'WORKING_TIME_LIMIT' ORDER BY "dedupeKey"`, [T.tenant])
    const cap = alerts.find((alert) => alert.dedupeKey === `WORKING_TIME_LIMIT:${T.siteA1}:OVERTIME_YEARLY_CAP`)!
    expect(cap).toMatchObject({ state: 'OPEN', recordType: 'Site', recordId: T.siteA1, siteId: T.siteA1, companyId: T.companyA, facts: { limit: 'OVERTIME_YEARLY_CAP' } })
    expect(JSON.stringify(alerts)).not.toContain('(made up)')
    expect(keysOf(alerts.map((alert) => alert.facts))).toEqual(expect.not.arrayContaining(['minutes', 'employeeId', 'people']))
    const outbox = await w.admin<Json>(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'alert.raised' AND subject = $2`, [T.tenant, cap.id])
    const row = outbox[0]!
    const envelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }
    expect(await fanOut(callerFor(w.database, systemContext(T.tenant, `ot-${newId()}`)), envelope as never)).toBeGreaterThanOrEqual(1)
    const told = await w.admin(`SELECT "userId", "recordType", "recordLabel" FROM "Notification" WHERE "tenantId" = $1 AND "eventType" = 'alert.raised'`, [T.tenant])
    expect(told.map((entry) => entry.userId)).toContain(T.member)
    expect(JSON.stringify(told)).not.toContain('(made up)')
    // The gate off: the alert goes by itself.
    await w.closeGate()
    await runAlertEvaluation({ database: w.database, log })
    expect((await w.admin(`SELECT state, resolution FROM "Alert" WHERE id = $1`, [cap.id]))[0]).toMatchObject({ state: 'RESOLVED', resolution: 'CLEARED' })
  })
})
