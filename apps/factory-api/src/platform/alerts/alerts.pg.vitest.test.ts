import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { presetDeadline } from '@nexus/factory-domain/invoicing/from-shipment/deadlines'
import { plusCalendarDays } from '@nexus/factory-domain/timers/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../packages/factory-db/seed/roles'
import { seed as seedCompliance } from '../../../../../packages/factory-db/seed/compliance'
import { seed as seedHolds } from '../../../../../packages/factory-db/seed/holds'
import { seed as seedAlerts } from '../../../../../packages/factory-db/seed/alerts'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor, COMMAND_SETTINGS } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import type { Log } from '../../core/queue'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { startHarness, type Harness } from '../auth/sessions/testing/harness'
import { fanOut } from '../notifications/fan-out'
import { systemContext } from '../outbox/system'
import { fireDueTimers } from '../timers/fire'
import { alertsRecheckHandler, evaluateKind, runAlertEvaluation } from './engine'

/**
 * Exception rules, stored alerts and date timers (B-W2a-33; ANA-036, PLT-100) on the local stack: a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security and the …_platform_w2a_guards triggers are real),
 * the factory-db seeds up to the holds (orders, purchase orders, DDTs, a quality hold), the certificates and the alerts
 * seed (four built-in rules and their alerts and timers), people with live role assignments (the recipients and the
 * fan-out read them) and test sessions holding the same template grants. The engine, the timers and the fan-out run as the
 * scheduler and the worker would, on a clock the test moves. Run with `node scripts/factory/run-pg-tests.mjs platform/alerts`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'alerts-w2a33'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
/** Moves test data past its own guards (the admin's session only), then back. */
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}

const PEOPLE = { owner: newId(), planner: newId(), quality: newId(), buyer: newId(), finance: newId(), outsider: newId(), reader: newId() } as const
type Person = keyof typeof PEOPLE
const ROLES: Record<Person, { readonly role: string; readonly companies: 'all' | string[] }> = {
  owner: { role: 'owner', companies: 'all' },
  planner: { role: 'planner', companies: 'all' },
  quality: { role: 'quality_inspector', companies: 'all' },
  buyer: { role: 'buyer', companies: 'all' },
  finance: { role: 'finance', companies: 'all' },
  outsider: { role: 'planner', companies: ['B'] },
  reader: { role: 'read_only', companies: 'all' },
}
const companiesOf = (person: Person): Grant['companies'] => (ROLES[person].companies === 'all' ? 'all' : [companyB])
function grantOf(person: Person): Grant {
  const template = templateOf(ROLES[person].role)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: companiesOf(person), sites: 'all', parties: 'all' }
}
const session = (person: Person): SessionContext => ({ audience: 'office', tenantId: T, actorId: PEOPLE[person], grants: [grantOf(person)] })

async function call(person: Person, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': person }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(person: Person, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(person, method, url, payload)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
const issuePaths = (body: Json): string[] => ((body.error?.issues ?? []) as Json[]).map((issue) => issue.path)

let at = new Date()
const clock = { now: () => at }
const settings = { ...COMMAND_SETTINGS, clock }
const errors: string[] = []
const log: Log = { info: () => undefined, warn: () => undefined, error: (fields, message) => errors.push(`${message} ${JSON.stringify(fields)}`) }
const system = () => callerFor(h.database, systemContext(T, `test-${newId()}`))
const evaluate = () => runAlertEvaluation({ database: h.database, log, clock })
const fire = () => fireDueTimers({ database: h.database, log, clock })

/** The worker's fan-out over every outbox row of these types (a row fanned out before answers 0); how many notifications were made. */
async function fanOutSince(types: readonly string[]): Promise<number> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = ANY($2) ORDER BY "occurredAt", id`, [T, types])
  let made = 0
  for (const row of rows) {
    const envelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }
    made += await fanOut(system(), envelope)
  }
  return made
}

const ids = {} as { so1: string; so2: string; so3: string; po3: string; hold: string; cert: string; ddt: string; seededHoldAlert: string }
const alertOf = (kind: string, recordId: string) => one(`SELECT * FROM "Alert" WHERE "ruleKind" = $1 AND "recordId" = $2 ORDER BY occurrence DESC LIMIT 1`, [kind, recordId])
const ruleOf = (kind: string) => one(`SELECT * FROM "AlertRule" WHERE "tenantId" = $1 AND "ruleKind" = $2 AND "builtIn" ORDER BY "createdAt" LIMIT 1`, [T, kind])

beforeAll(async () => {
  h = await startHarness('alerts_w2a33')
  at = new Date()
  h.clock.set(at)
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedCompliance({ db: h.database, namespace: NS })
  await seedHolds({ db: h.database, namespace: NS })
  await seedAlerts({ db: h.database, namespace: NS })
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [T])).map((row) => [row.key, row.id]))
  for (const [person, { role, companies }] of Object.entries(ROLES)) {
    const userId = PEOPLE[person as Person]
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, T, `w2a33-${person}@example.com`, `Person ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, $5, $6::uuid[], now() - interval '30 days')`, [
      newId(),
      T,
      userId,
      roleIds.get(role),
      companies === 'all',
      companies === 'all' ? [] : [companyB],
    ])
  }
  const today = businessDate(at)
  const order = async (number: string) => (await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2`, [T, number])).id
  ids.so1 = await order('SEED-SO-0001')
  ids.so2 = await order('SEED-SO-0002')
  ids.so3 = await order('SEED-SO-0003')
  // SO1 two days late (the seeded alert keeps it), SO2 promised in two days and still CONFIRMED (at risk), SO3 far away.
  await force(`UPDATE "SalesOrder" SET "promiseDate" = $2::date, status = 'CONFIRMED' WHERE id = $1`, [ids.so1, plusCalendarDays(today, -2)])
  await force(`UPDATE "SalesOrder" SET "promiseDate" = $2::date, status = 'CONFIRMED' WHERE id = $1`, [ids.so2, plusCalendarDays(today, 2)])
  await force(`UPDATE "SalesOrder" SET "promiseDate" = $2::date WHERE id = $1`, [ids.so3, plusCalendarDays(today, 40)])
  // SEED-PO-0002 sent three days ago, no answer; the hold placed 30 hours ago; SEED-CERT-0002's last valid day in 20 days.
  ids.po3 = (await one<{ id: string }>(`SELECT id FROM "PurchaseOrder" WHERE "tenantId" = $1 AND number = 'SEED-PO-0002'`, [T])).id
  await force(`UPDATE "PurchaseOrder" SET status = 'SENT', "sentAt" = $2 WHERE id = $1`, [ids.po3, new Date(at.getTime() - 3 * 86_400_000)])
  ids.hold = (await one<{ id: string }>(`SELECT id FROM "QualityHold" WHERE "tenantId" = $1 AND status = 'ACTIVE' LIMIT 1`, [T])).id
  await force(`UPDATE "QualityHold" SET "placedAt" = $2 WHERE id = $1`, [ids.hold, new Date(at.getTime() - 30 * 3_600_000)])
  ids.cert = (await one<{ id: string }>(`SELECT id FROM "Certificate" WHERE "tenantId" = $1 AND number = 'SEED-CERT-0002'`, [T])).id
  await force(`UPDATE "Certificate" SET "validTo" = $2::date WHERE id = $1`, [ids.cert, plusCalendarDays(today, 20)])
  // DDT 144/2026 (143 was cancelled): its goods not invoiced yet (the seed's invoice of them taken out, test data only).
  ids.ddt = (await one<{ id: string }>(`SELECT id FROM "Ddt" WHERE "tenantId" = $1 AND number = '144/2026'`, [T])).id
  await force(`DELETE FROM "InvoiceLine" WHERE "ddtId" = $1`, [ids.ddt])
  ids.seededHoldAlert = (await one<{ id: string }>(`SELECT id FROM "Alert" WHERE "tenantId" = $1 AND "ruleKind" = 'HOLD_TOO_LONG'`, [T])).id
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => (String(request.headers['x-test-session']) in PEOPLE ? session(String(request.headers['x-test-session']) as Person) : null)) },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
})

describe('the engine (scheduler and worker)', () => {
  it('makes the missing built-in rules, raises what the rules find, keeps what is open, clears what no rule finds', async () => {
    const before = (await one(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE "tenantId" = $1`, [T])).n
    const run = await evaluate()
    expect(errors).toEqual([])
    // B-W2b-24: + INTEGRATION_FAILING (4 built-ins made; nothing fails in the seed, so it raises nothing).
    expect(run.builtIns).toBe(4)
    expect((await admin(`SELECT "ruleKind" FROM "AlertRule" WHERE "tenantId" = $1 AND "builtIn" ORDER BY 1`, [T])).map((row) => row.ruleKind)).toEqual([
      'APPROVAL_OVERDUE',
      'CERTIFICATE_EXPIRING',
      'HOLD_TOO_LONG',
      'INTEGRATION_FAILING',
      'INVOICE_DEADLINE',
      'MATERIAL_SHORT',
      'ORDER_LATE_RISK',
      'PO_NOT_CONFIRMED',
    ])
    // A new built-in rule tells the holders of its system role.
    expect((await ruleOf('INVOICE_DEADLINE')).recipientRoleId).toBe((await one(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'finance'`, [T])).id)
    const so2 = await alertOf('ORDER_LATE_RISK', ids.so2)
    expect(so2).toMatchObject({ state: 'OPEN', occurrence: 1, recordLabel: 'SEED-SO-0002', dedupeKey: `ORDER_LATE_RISK:${ids.so2}`, companyId: companyA })
    expect(so2.facts).toMatchObject({ daysLeft: 2, late: false, daysBeforePromise: 3 })
    // SO1's seeded alert stays the one open alert of its key; SO3 is far away.
    expect(await admin(`SELECT occurrence, state FROM "Alert" WHERE "recordId" = $1`, [ids.so1])).toEqual([{ occurrence: 1, state: 'OPEN' }])
    expect(await admin(`SELECT id FROM "Alert" WHERE "recordId" = $1`, [ids.so3])).toEqual([])
    expect(await alertOf('PO_NOT_CONFIRMED', ids.po3)).toMatchObject({ state: 'OPEN', facts: { days: 3, threshold: 2 } })
    const hold = await alertOf('HOLD_TOO_LONG', ids.hold)
    expect(hold).toMatchObject({ state: 'OPEN', recordType: 'QualityHold', facts: { hours: 30, threshold: 24, subjectType: 'Hide' } })
    expect(hold.recordLabel).toMatch(/HIDE/)
    // The seeded alert of a lot no hold names any more: cleared by the system, with its history.
    expect(await one(`SELECT state, resolution, "resolvedById", "resolveNote" FROM "Alert" WHERE id = $1`, [ids.seededHoldAlert])).toEqual({ state: 'RESOLVED', resolution: 'CLEARED', resolvedById: null, resolveNote: null })
    expect(await admin(`SELECT verb, "actorId" FROM "AlertEvent" WHERE "alertId" = $1 AND verb = 'RESOLVED'`, [ids.seededHoldAlert])).toEqual([{ verb: 'RESOLVED', actorId: null }])
    expect(await admin(`SELECT verb, facts FROM "AlertEvent" WHERE "alertId" = $1`, [so2.id])).toEqual([{ verb: 'RAISED', facts: so2.facts }])
    // A DATE rule sets one timer per record: DDT 144/2026 waits for its invoice (by its customer's preset, B-W2a-54: per
    // shipment its 12 days, monthly the 15th of the next month; 3 working days before).
    const timer = await one(`SELECT "timerKey", status, "dueAt", "fireAt", "recordLabel" FROM "DueTimer" WHERE "recordId" = $1`, [ids.ddt])
    expect(timer).toMatchObject({ timerKey: 'INVOICE_DEADLINE:-3d', status: 'PENDING', recordLabel: '144/2026' })
    const ddtRow = await one(`SELECT d.number, to_char(d."documentDate", 'YYYY-MM-DD') AS d, p."invoiceTiming"::text AS timing FROM "Ddt" d JOIN "Party" p ON p.id = d."partyId" WHERE d.id = $1`, [ids.ddt])
    expect(businessDate(timer.dueAt)).toBe(presetDeadline({ number: ddtRow.number, date: ddtRow.d }, ddtRow.timing === 'MONTHLY' ? 'TD24' : 'TD01', businessDate(at)).dueBy)
    // The switched-off certificate rule sets nothing.
    expect(await admin(`SELECT id FROM "DueTimer" WHERE "recordId" = $1`, [ids.cert])).toEqual([])
    const events = await admin(`SELECT type, count(*)::int AS n FROM "OutboxEvent" WHERE "tenantId" = $1 AND type IN ('alert.raised', 'alert.resolved', 'alert.rule_changed') GROUP BY type ORDER BY type`, [T])
    expect(events).toEqual([
      { type: 'alert.raised', n: 3 },
      { type: 'alert.resolved', n: 1 },
      { type: 'alert.rule_changed', n: 4 },
    ])
    expect((await one(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE "tenantId" = $1`, [T])).n).toBe(before + 8)
  })

  it('a second pass (a replay, the next tick) raises nothing twice and writes nothing at all', async () => {
    const audits = (await one(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "tenantId" = $1`, [T])).n
    const run = await evaluate()
    expect(run).toMatchObject({ builtIns: 0, raised: 0, cleared: 0, timersSet: 0, timersCancelled: 0, failed: 0 })
    expect((await one(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "tenantId" = $1`, [T])).n).toBe(audits)
  })

  it('tells the rule recipients once (the fan-out), never the people outside the place or without the record', async () => {
    expect(await fanOutSince(['alert.raised'])).toBeGreaterThan(0)
    expect(await fanOutSince(['alert.raised'])).toBe(0)
    const so2 = await alertOf('ORDER_LATE_RISK', ids.so2)
    const told = await admin(`SELECT "userId", category, "messageKey", anchor FROM "Notification" WHERE "tenantId" = $1 AND anchor = $2`, [T, `alert:${so2.id}`])
    expect(told).toEqual([{ userId: PEOPLE.planner, category: 'ALERT', messageKey: 'notifications.alert.raised', anchor: `alert:${so2.id}` }])
    const hold = await alertOf('HOLD_TOO_LONG', ids.hold)
    expect((await admin(`SELECT "userId" FROM "Notification" WHERE anchor = $1`, [`alert:${hold.id}`])).map((row) => row.userId)).toEqual([PEOPLE.quality])
    const bell = await ok('planner', 'GET', '/notifications?tab=SYSTEM')
    expect((bell.items as Json[]).find((item) => item.anchor === `alert:${so2.id}`)).toMatchObject({ category: 'ALERT', sentence: 'Alert on SEED-SO-0002: Order at risk of being late' })
  })
})

describe('the alerts (home.alerts)', () => {
  it('lists what each person may see, with the tiles; nobody sees another company or a record they cannot open', async () => {
    const planner = await ok('planner', 'GET', '/alerts')
    const labels = (planner.items as Json[]).map((item) => item.record.label)
    expect(labels).toEqual(expect.arrayContaining(['SEED-SO-0001', 'SEED-SO-0002', 'SEED-PO-0002']))
    // The planner does not see holds (no quality.holds.view).
    expect((planner.items as Json[]).some((item) => item.ruleKind === 'HOLD_TOO_LONG')).toBe(false)
    const tile = (body: Json, name: string) => (body.tiles as Json[]).find((entry) => entry.tile === name)!.count
    // Open for me: the order alerts (the planner role); the PO alert tells the buyer.
    expect(tile(planner, 'OPEN_FOR_ME')).toBe(2)
    const mine = await ok('planner', 'GET', '/alerts?tile=OPEN_FOR_ME')
    expect((mine.items as Json[]).map((item) => item.record.label).sort()).toEqual(['SEED-SO-0001', 'SEED-SO-0002'])
    expect((mine.items as Json[]).every((item) => item.forMe && item.verbs.includes('ACKNOWLEDGE'))).toBe(true)
    const so2 = (planner.items as Json[]).find((item) => item.record.label === 'SEED-SO-0002')!
    expect(so2).toMatchObject({ kindLabel: 'Orders at risk of being late', ruleName: 'Order at risk of being late', severity: 'WARNING', state: 'OPEN', words: { key: 'alerts.ORDER_LATE_RISK.AT_RISK' } })
    expect(so2.sentence).toMatch(/^Order SEED-SO-0002 is promised for .* \(2 days left\) and is not ready\.$/)
    expect(JSON.stringify(planner)).not.toMatch(/netAmount|price|cost/i)
    // Planner over company B only: none of company A's alerts.
    const outsider = await ok('outsider', 'GET', '/alerts')
    expect((outsider.items as Json[]).filter((item) => item.companyId === companyA)).toEqual([])
    expect(tile(outsider, 'OPEN_FOR_ME')).toBe(0)
    // Read-only sees them, may do nothing.
    const reader = await ok('reader', 'GET', '/alerts')
    expect((reader.items as Json[]).length).toBeGreaterThan(0)
    expect((reader.items as Json[]).every((item) => item.verbs.length === 0 && !item.forMe)).toBe(true)
    expect((await call('reader', 'POST', `/alerts/${so2.id}/acknowledge`, { version: so2.version })).status).toBe(403)
    const quality = await ok('quality', 'GET', '/alerts?tile=OPEN_FOR_ME')
    expect((quality.items as Json[]).map((item) => item.ruleKind)).toEqual(['HOLD_TOO_LONG'])
  })

  it('one alert: what, why, its record, its history and the similar open alerts', async () => {
    const so2 = await alertOf('ORDER_LATE_RISK', ids.so2)
    const read = await ok('planner', 'GET', `/alerts/${so2.id}`)
    expect(read.alert).toMatchObject({ id: so2.id, record: { type: 'SalesOrder', id: ids.so2, label: 'SEED-SO-0002' }, facts: { daysLeft: 2 } })
    expect(read.rule.sentence).toMatch(/^When an order is promised within 3 days and is not ready, or is late, tell Planner by the bell at most once a day\.$/)
    expect((read.history as Json[]).map((entry) => [entry.verb, entry.actor])).toEqual([['RAISED', null]])
    expect((read.similar as Json[]).map((entry) => entry.record.label)).toContain('SEED-SO-0001')
    expect((await call('outsider', 'GET', `/alerts/${so2.id}`)).status).toBe(404)
  })

  it('B-W2a-78: who an alert may be given to — the same check as the assign; the dialog\'s roles and places', async () => {
    const so2 = await alertOf('ORDER_LATE_RISK', ids.so2)
    const people = (await ok('planner', 'GET', `/alerts/${so2.id}/assignees`)).people as Json[]
    const named = people.map((person) => person.id)
    // Who sees the order at company A and handles alerts there; never the quality inspector (no orders.view), the planner
    // of company B only, or the read-only person (no alerts.handle).
    expect(named).toEqual(expect.arrayContaining([PEOPLE.owner, PEOPLE.planner, PEOPLE.finance]))
    for (const outside of [PEOPLE.quality, PEOPLE.outsider, PEOPLE.reader]) expect(named).not.toContain(outside)
    expect(people.find((person) => person.id === PEOPLE.planner)).toEqual({ id: PEOPLE.planner, name: 'Person planner', me: true })
    expect((await call('reader', 'GET', `/alerts/${so2.id}/assignees`)).status).toBe(403)
    expect((await call('outsider', 'GET', `/alerts/${so2.id}/assignees`)).status).toBe(404)
    // The list's "Site" column: the order's company by name (an order has no site).
    const company = await one<{ name: string }>(`SELECT coalesce("tradeName", "legalName") AS name FROM "Company" WHERE id = $1`, [companyA])
    expect((await ok('planner', 'GET', `/alerts/${so2.id}`)).alert.placeLabel).toBe(company.name)
    // The rule dialog: every office role, and the places the reader may keep rules for (the owner: everywhere).
    const choices = await ok('owner', 'GET', '/alerts/rules/choices')
    const plannerRole = (await one<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'planner'`, [T])).id
    expect(choices.roles as Json[]).toContainEqual({ id: plannerRole, name: expect.any(String), key: 'planner' })
    expect(choices.everywhere).toBe(true)
    expect((choices.companies as Json[]).filter((company) => [companyA, companyB].includes(company.id)).map((company) => company.wholeCompany)).toEqual([true, true])
    expect((await call('planner', 'GET', '/alerts/rules/choices')).status).toBe(403)
  })

  it('acknowledge, assign, snooze, resolve with a note: each in its history with the same actor and time; refusals in words', async () => {
    let so2 = (await ok('planner', 'GET', `/alerts/${(await alertOf('ORDER_LATE_RISK', ids.so2)).id}`)).alert
    const acked = (await ok('planner', 'POST', `/alerts/${so2.id}/acknowledge`, { version: so2.version })).alert
    expect(acked).toMatchObject({ state: 'ACKNOWLEDGED', acknowledged: { by: { id: PEOPLE.planner, me: true } }, verbs: ['ASSIGN', 'SNOOZE', 'RESOLVE'] })
    // A stale version, a second acknowledgement.
    expect((await call('planner', 'POST', `/alerts/${so2.id}/acknowledge`, { version: so2.version })).status).toBe(409)
    const again = await call('planner', 'POST', `/alerts/${so2.id}/acknowledge`, { version: acked.version })
    expect([again.status, issuePaths(again.body)]).toEqual([409, ['alert/ALREADY_ACKNOWLEDGED']])
    // Assign: never to someone who cannot open the order (the quality inspector has no orders.view).
    const refusedAssign = await call('planner', 'POST', `/alerts/${so2.id}/assign`, { version: acked.version, assigneeId: PEOPLE.quality })
    expect([refusedAssign.status, issuePaths(refusedAssign.body)]).toEqual([400, ['body/assigneeId']])
    so2 = (await ok('planner', 'POST', `/alerts/${so2.id}/assign`, { version: acked.version, assigneeId: PEOPLE.finance })).alert
    expect(so2.assigned).toMatchObject({ to: { id: PEOPLE.finance, name: 'Person finance' }, by: { id: PEOPLE.planner } })
    expect(await fanOutSince(['alert.assigned'])).toBe(1)
    expect(await admin(`SELECT "userId", category, "messageKey" FROM "Notification" WHERE anchor = $1 AND category = 'ASSIGNMENT'`, [`alert:${so2.id}`])).toEqual([{ userId: PEOPLE.finance, category: 'ASSIGNMENT', messageKey: 'notifications.assigned.alert' }])
    // Assigned to the finance person: no longer open for the planner, open for them.
    expect(((await ok('planner', 'GET', '/alerts?tile=OPEN_FOR_ME')).items as Json[]).map((item) => item.record.label)).toEqual(['SEED-SO-0001'])
    expect(((await ok('finance', 'GET', '/alerts?tile=OPEN_FOR_ME')).items as Json[]).map((item) => item.record.label)).toContain('SEED-SO-0002')
    // Reassign (UNASSIGNED + ASSIGNED in its history), then a snooze, then resolve.
    so2 = (await ok('planner', 'POST', `/alerts/${so2.id}/assign`, { version: so2.version, assigneeId: PEOPLE.owner })).alert
    const tooFar = await call('planner', 'POST', `/alerts/${so2.id}/snooze`, { version: so2.version, until: new Date(Date.now() + 40 * 86_400_000).toISOString() })
    expect([tooFar.status, issuePaths(tooFar.body)]).toEqual([400, ['body/until']])
    so2 = (await ok('planner', 'POST', `/alerts/${so2.id}/snooze`, { version: so2.version, until: new Date(Date.now() + 3_600_000).toISOString() })).alert
    expect(so2.snoozed).toMatchObject({ by: { id: PEOPLE.planner }, now: true })
    expect(((await ok('owner', 'GET', '/alerts')).items as Json[]).some((item) => item.id === so2.id)).toBe(false)
    expect(((await ok('owner', 'GET', '/alerts?snoozed=true')).items as Json[]).some((item) => item.id === so2.id)).toBe(true)
    const noNote = await call('planner', 'POST', `/alerts/${so2.id}/resolve`, { version: so2.version, note: '  ' })
    expect([noNote.status, issuePaths(noNote.body)]).toEqual([400, ['body/note']])
    so2 = (await ok('planner', 'POST', `/alerts/${so2.id}/resolve`, { version: so2.version, note: 'Production moved forward: ships tomorrow.' })).alert
    expect(so2).toMatchObject({ state: 'RESOLVED', resolved: { resolution: 'HANDLED', by: { id: PEOPLE.planner }, note: 'Production moved forward: ships tomorrow.' }, verbs: [] })
    const resolvedAgain = await call('planner', 'POST', `/alerts/${so2.id}/resolve`, { version: so2.version, note: 'Again.' })
    expect([resolvedAgain.status, issuePaths(resolvedAgain.body)]).toEqual([409, ['alert/RESOLVED']])
    const history = (await ok('planner', 'GET', `/alerts/${so2.id}`)).history as Json[]
    expect(history.map((entry) => entry.verb)).toEqual(['RAISED', 'ACKNOWLEDGED', 'ASSIGNED', 'UNASSIGNED', 'ASSIGNED', 'SNOOZED', 'RESOLVED'])
    expect(history.at(-1)).toMatchObject({ actor: { id: PEOPLE.planner }, note: 'Production moved forward: ships tomorrow.' })
    const tiles = (await ok('planner', 'GET', '/alerts/counts')).tiles as Json[]
    expect(tiles.find((entry) => entry.tile === 'RESOLVED_TODAY')!.count).toBeGreaterThanOrEqual(1)
  })

  it('bulk acknowledge is all or none, and names the item that is refused', async () => {
    const so1 = await alertOf('ORDER_LATE_RISK', ids.so1)
    const po = await alertOf('PO_NOT_CONFIRMED', ids.po3)
    const so2 = await alertOf('ORDER_LATE_RISK', ids.so2)
    const refusedBulk = await call('owner', 'POST', '/alerts/acknowledge', { items: [{ id: so1.id, version: so1.version }, { id: so2.id, version: so2.version }] })
    expect([refusedBulk.status, issuePaths(refusedBulk.body)]).toEqual([409, ['body/items/1/RESOLVED']])
    expect((await alertOf('ORDER_LATE_RISK', ids.so1)).state).toBe('OPEN')
    const done = await ok('owner', 'POST', '/alerts/acknowledge', { items: [{ id: so1.id, version: so1.version }, { id: po.id, version: po.version }] })
    expect((done.alerts as Json[]).map((alert) => alert.state)).toEqual(['ACKNOWLEDGED', 'ACKNOWLEDGED'])
  })

  it('raises the next occurrence only after the cooldown; an event rechecks one record at once', async () => {
    // SO2 resolved by a person while still at risk: within the rule's day nothing comes back; a day later it does.
    expect((await evaluate()).raised).toBe(0)
    at = new Date(at.getTime() + 25 * 3_600_000)
    expect((await evaluate()).raised).toBeGreaterThanOrEqual(1)
    expect(await alertOf('ORDER_LATE_RISK', ids.so2)).toMatchObject({ occurrence: 2, state: 'OPEN' })
    // The hold is released: the worker's recheck clears its alert at once.
    await force(`UPDATE "QualityHold" SET status = 'RELEASED', "releasedAt" = now() WHERE id = $1`, [ids.hold])
    const handler = alertsRecheckHandler(clock)
    const event = { eventId: newId(), type: 'quality.hold_released', version: 1, context: 'quality', tenantId: T, companyId: companyA, siteId: null, subject: ids.hold, correlationId: 'test', causationId: null, source: 'test', occurredAt: at.toISOString(), payload: { holdId: ids.hold } }
    await handler.handle(event as never, { caller: system(), attempt: 1 })
    expect(await alertOf('HOLD_TOO_LONG', ids.hold)).toMatchObject({ state: 'RESOLVED', resolution: 'CLEARED' })
    // A replay finds nothing left to do.
    await handler.handle(event as never, { caller: system(), attempt: 2 })
    expect(await admin(`SELECT count(*)::int AS n FROM "Alert" WHERE "recordId" = $1`, [ids.hold])).toEqual([{ n: 1 }])
    expect((await evaluateKind(system(), 'HOLD_TOO_LONG', settings)).raised).toBe(0)
  })
})

describe('Today (include=ALERTS)', () => {
  it('shows my open alerts in place of the W1 checks they replace; without include the answer is W1', async () => {
    const withAlerts = await ok('planner', 'GET', '/home/today?limit=200&include=ALERTS')
    const kinds = new Set((withAlerts.items as Json[]).map((item) => item.kind))
    expect(kinds.has('RULE_ALERT')).toBe(true)
    expect(kinds.has('ORDER_PROMISE')).toBe(false)
    const row = (withAlerts.items as Json[]).find((item) => item.kind === 'RULE_ALERT' && item.record.label === 'SEED-SO-0002')!
    expect(row).toMatchObject({ category: 'ALERT', record: { type: 'Alert' }, words: { sentence: { key: 'alerts.ORDER_LATE_RISK.AT_RISK' }, why: { key: 'why.RULE_ALERT.recipient' } }, decide: 'OPEN', actions: { verbs: [], snoozable: false } })
    const w1 = await ok('planner', 'GET', '/home/today?limit=200')
    expect((w1.items as Json[]).some((item) => item.kind === 'RULE_ALERT')).toBe(false)
    expect((w1.counts.byKind as Json[]).some((entry) => entry.kind === 'RULE_ALERT')).toBe(false)
    // A Today row of an alert takes none of Today's own verbs (the alert has its own).
    const verb = await call('planner', 'POST', `/home/today/rows/${encodeURIComponent(row.key)}/snooze`, { condition: row.condition, version: 0, until: null })
    expect([verb.status, issuePaths(verb.body)]).toEqual([409, ['action/NOT_AN_ALERT']])
  })
})

describe('the rules and the date timers (home.alerts Rules, admin.automation Reminders & timers)', () => {
  it('lists the rules as sentences with their numbers, recipients, last fired and fired in 7 days', async () => {
    const list = await ok('planner', 'GET', '/alerts/rules')
    // B-W2b-24: + INTEGRATION_FAILING (a rule's sentence is no record: listed to whoever reads the rules).
    expect((list.rules as Json[]).map((rule) => rule.ruleKind).sort()).toEqual(['APPROVAL_OVERDUE', 'CERTIFICATE_EXPIRING', 'HOLD_TOO_LONG', 'INTEGRATION_FAILING', 'INVOICE_DEADLINE', 'MATERIAL_SHORT', 'ORDER_LATE_RISK', 'PO_NOT_CONFIRMED'])
    const hold = (list.rules as Json[]).find((rule) => rule.ruleKind === 'HOLD_TOO_LONG')!
    expect(hold).toMatchObject({ threshold: { hours: 24 }, recipient: { name: 'Quality inspector' }, cooldownWords: 'at most once a day', enabled: true, builtIn: true, canChange: false, timers: null })
    expect(hold.place.label).toBeTruthy()
    expect(hold.fired7Days).toBeGreaterThanOrEqual(1)
    expect((list.rules as Json[]).find((rule) => rule.ruleKind === 'INVOICE_DEADLINE')).toMatchObject({ trigger: 'DATE', timers: { pending: 1 } })
    expect(list.canAdd).toBe(false)
    expect((await ok('owner', 'GET', '/alerts/rules?trigger=DATE')).rules.map((rule: Json) => rule.ruleKind).sort()).toEqual(['CERTIFICATE_EXPIRING', 'INVOICE_DEADLINE'])
  })

  it('tries numbers against the records now without saving them', async () => {
    const rule = await ruleOf('PO_NOT_CONFIRMED')
    expect(await ok('planner', 'POST', `/alerts/rules/${rule.id}/test`, { threshold: { days: 1 } })).toMatchObject({ wouldFind: 1, complete: true, sample: [{ record: { label: 'SEED-PO-0002' } }] })
    expect((await ok('planner', 'POST', `/alerts/rules/${rule.id}/test`, { threshold: { days: 30 } })).wouldFind).toBe(0)
    const bad = await call('planner', 'POST', `/alerts/rules/${rule.id}/test`, { threshold: { days: 0 } })
    expect([bad.status, issuePaths(bad.body)]).toEqual([400, ['body/threshold']])
    expect((await ruleOf('PO_NOT_CONFIRMED')).threshold).toEqual({ days: 2 })
  })

  it('a rule is changed only by who keeps the rules, never to e-mail alone; a DATE rule switched on sets its timers, which fire its alert', async () => {
    const certificateRule = await ruleOf('CERTIFICATE_EXPIRING')
    expect((await call('planner', 'PUT', `/alerts/rules/${certificateRule.id}`, { version: certificateRule.version, enabled: true })).status).toBe(403)
    const emailOnly = await call('owner', 'PUT', `/alerts/rules/${certificateRule.id}`, { version: certificateRule.version, channels: ['EMAIL'] })
    expect([emailOnly.status, issuePaths(emailOnly.body)]).toEqual([409, ['body/channels']])
    const on = (await ok('owner', 'PUT', `/alerts/rules/${certificateRule.id}`, { version: certificateRule.version, enabled: true, recipientRoleId: (await one(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'quality_inspector'`, [T])).id })).rule
    expect(on).toMatchObject({ enabled: true, recipient: { name: 'Quality inspector' }, version: certificateRule.version + 1 })
    expect(on.sentence.en).toBe('30 days before a certificate expires, tell Quality inspector by the bell at most once a day.')
    const run = await evaluate()
    expect(run.timersSet).toBeGreaterThanOrEqual(1)
    // The seeded PENDING timer of a certificate no record has any more: cancelled.
    expect(await one(`SELECT status, "cancelReason" FROM "DueTimer" WHERE id = $1`, [idOf('alerts:timer:certificate:pending')])).toEqual({ status: 'CANCELLED', cancelReason: 'The record no longer needs it.' })
    const timer = await one(`SELECT id, "timerKey", status FROM "DueTimer" WHERE "recordId" = $1`, [ids.cert])
    expect(timer).toMatchObject({ timerKey: 'CERTIFICATE_EXPIRY:-30d', status: 'PENDING' })
    const fired = await fire()
    expect(fired.raised).toBeGreaterThanOrEqual(1)
    expect((await one(`SELECT status FROM "DueTimer" WHERE id = $1`, [timer.id])).status).toBe('FIRED')
    const alert = await alertOf('CERTIFICATE_EXPIRING', ids.cert)
    expect(alert).toMatchObject({ state: 'OPEN', severity: 'CRITICAL', recordLabel: 'SEED-CERT-0002', facts: { daysBefore: 30, timerKey: 'CERTIFICATE_EXPIRY:-30d' } })
    expect(await admin(`SELECT type FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'timer.fired' AND subject = $2`, [T, timer.id])).toEqual([{ type: 'timer.fired' }])
    expect(await fanOutSince(['alert.raised'])).toBeGreaterThanOrEqual(1)
    expect((await admin(`SELECT "userId" FROM "Notification" WHERE anchor = $1`, [`alert:${alert.id}`])).map((row) => row.userId)).toEqual([PEOPLE.quality])
    // A fired timer never fires again, and is not set again for the same date.
    expect((await fire()).raised).toBe(0)
    expect((await evaluate()).timersSet).toBe(0)
    const timers = await ok('owner', 'GET', `/alerts/rules/${certificateRule.id}/timers`)
    expect((timers.timers as Json[]).find((entry) => entry.record.id === ids.cert)).toMatchObject({ status: 'FIRED', timerKey: 'CERTIFICATE_EXPIRY:-30d' })
    expect((await call('planner', 'GET', `/alerts/rules/${certificateRule.id}/timers`)).status).toBe(403)
    // Ten days before instead: its waiting timers go, the certificate is out of the window and its alert clears.
    const changed = (await ok('owner', 'PUT', `/alerts/rules/${on.id}`, { version: on.version, threshold: { daysBefore: 10 } })).rule
    expect(changed.threshold).toEqual({ daysBefore: 10, workingDays: false })
    await evaluate()
    expect((await alertOf('CERTIFICATE_EXPIRING', ids.cert)).resolution).toBe('CLEARED')
    expect(await one(`SELECT "timerKey", status FROM "DueTimer" WHERE "recordId" = $1 AND status = 'PENDING'`, [ids.cert])).toEqual({ timerKey: 'CERTIFICATE_EXPIRY:-10d', status: 'PENDING' })
  })

  it('a DDT near its invoice deadline: the timer fires in working days and tells finance', async () => {
    const timer = await one(`SELECT id, "fireAt", "dueAt" FROM "DueTimer" WHERE "recordId" = $1 AND status = 'PENDING'`, [ids.ddt])
    at = new Date(new Date(timer.fireAt).getTime() + 60_000)
    expect(await evaluate()).toMatchObject({ timersSet: 0, failed: 0 })
    expect((await fire()).raised).toBe(1)
    const alert = await alertOf('INVOICE_DEADLINE', ids.ddt)
    expect(alert).toMatchObject({ state: 'OPEN', recordLabel: '144/2026', facts: { daysBefore: 3, workingDays: true, dueDate: businessDate(timer.dueAt) } })
    // (The pass on that later day raised other alerts too: an order's promise now near.)
    expect(await fanOutSince(['alert.raised'])).toBeGreaterThanOrEqual(1)
    expect((await admin(`SELECT "userId" FROM "Notification" WHERE anchor = $1`, [`alert:${alert.id}`])).map((row) => row.userId)).toEqual([PEOPLE.finance])
    expect(errors).toEqual([])
  })

  it('a new rule of a kind for one company', async () => {
    const made = await call('owner', 'POST', '/alerts/rules', { ruleKind: 'HOLD_TOO_LONG', companyId: companyB, threshold: { hours: 12 }, severity: 'CRITICAL' })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.rule).toMatchObject({ ruleKind: 'HOLD_TOO_LONG', builtIn: false, threshold: { hours: 12 }, severity: 'CRITICAL', recipient: null, place: { companyId: companyB, siteId: null } })
    const site = await call('owner', 'POST', '/alerts/rules', { ruleKind: 'HOLD_TOO_LONG', siteId: newId() })
    expect([site.status, issuePaths(site.body)]).toEqual([409, ['body/siteId']])
    expect((await call('planner', 'POST', '/alerts/rules', { ruleKind: 'HOLD_TOO_LONG' })).status).toBe(403)
  })
})

describe('B-W2b-24: a connection failing (INTEGRATION_FAILING) and the restore drill reminder (RESTORE_DRILL_DUE)', () => {
  it('raises a built-in alert for a connection with no call that worked for the hours, to who sees connections; clears it when one works', async () => {
    const failing = newId()
    const paused = newId()
    const hours = (n: number) => new Date(at.getTime() - n * 3_600_000)
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, status, "lastOkAt", "lastErrorAt", "lastError", "createdAt", "updatedAt") VALUES ($1, $2, 'SES', 'mail-w2b24', 'Mail (made up)', 'FAKE', 'ACTIVE', $3, $4, 'mail.send: Error: refused', $5, $5)`, [failing, T, hours(3), hours(0.1), hours(48)])
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, status, "lastOkAt", "lastErrorAt", "createdAt", "updatedAt") VALUES ($1, $2, 'SENDCLOUD', 'paused-w2b24', 'Carrier (paused)', 'FAKE', 'PAUSED', NULL, $3, $4, $4)`, [paused, T, hours(0.1), hours(48)])
    const run = await evaluate()
    expect(errors).toEqual([])
    expect(run.failed).toBe(0)
    const alert = await alertOf('INTEGRATION_FAILING', failing)
    expect(alert).toMatchObject({ state: 'OPEN', recordType: 'IntegrationAccount', recordLabel: 'Mail (made up)', severity: 'CRITICAL', companyId: null, facts: { hours: 3, threshold: 1, never: false, provider: 'SES' } })
    expect(await admin(`SELECT id FROM "Alert" WHERE "recordId" = $1`, [paused])).toEqual([])
    expect((await ruleOf('INTEGRATION_FAILING')).recipientRoleId).toBe((await one(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'admin'`, [T])).id)
    // The owner sees it (integrations.view over every company), in words; a planner does not (no integrations.view).
    const owner = await ok('owner', 'GET', '/alerts?ruleKind=INTEGRATION_FAILING')
    expect((owner.items as Json[]).map((item) => item.sentence)).toEqual(['Connection Mail (made up) has not worked for 3 hours: its last call failed.'])
    expect(((await ok('planner', 'GET', '/alerts')).items as Json[]).some((item) => item.ruleKind === 'INTEGRATION_FAILING')).toBe(false)
    // A call works again: the system clears it.
    await admin(`UPDATE "IntegrationAccount" SET "lastOkAt" = $2 WHERE id = $1`, [failing, at])
    await evaluate()
    expect(await alertOf('INTEGRATION_FAILING', failing)).toMatchObject({ state: 'RESOLVED', resolution: 'CLEARED' })
  })

  it('tells the people who see Security & health when the restore drill timer fires (the last drill that passed named), once', async () => {
    const drill = newId()
    const drilledOn = plusCalendarDays(businessDate(at), -80)
    await admin(`INSERT INTO "RestoreDrill" (id, "tenantId", "drilledOn", environment, "backupAt", checks, result, "performedById", "requestId") VALUES ($1, $2, $3::date, 'a local copy', $4, '[{"key":"orders","match":true}]'::jsonb, 'PASSED', $5, 'test')`, [drill, T, drilledOn, new Date(`${drilledOn}T06:00:00.000Z`), PEOPLE.owner])
    const timer = newId()
    await admin(`INSERT INTO "DueTimer" (id, "tenantId", "timerKey", "recordType", "recordId", "dueAt", "fireAt", payload, "createdAt", "updatedAt") VALUES ($1, $2, 'RESTORE_DRILL_DUE:-14d', 'Tenant', $2, $3, $4, $5::jsonb, $4, $4)`, [timer, T, new Date(at.getTime() + 10 * 86_400_000), new Date(at.getTime() - 60_000), JSON.stringify({ dueOn: plusCalendarDays(drilledOn, 90) })])
    const fired = await fire()
    expect(fired.failed).toBe(0)
    expect((await one(`SELECT status FROM "DueTimer" WHERE id = $1`, [timer])).status).toBe('FIRED')
    expect(await fanOutSince(['timer.fired'])).toBeGreaterThan(0)
    const told = await admin(`SELECT "userId", category, "messageKey", "recordType", "recordId", "recordLabel" FROM "Notification" WHERE "tenantId" = $1 AND anchor = $2 ORDER BY "userId"`, [T, `drill-due:${timer}`])
    // security.view: the owner and read_only (the registry's read permissions); never the planner, buyer or quality.
    const toldIds = told.map((row) => row.userId)
    expect(toldIds).toEqual(expect.arrayContaining([PEOPLE.owner, PEOPLE.reader]))
    for (const person of ['planner', 'buyer', 'quality'] as const) expect(toldIds).not.toContain(PEOPLE[person])
    expect(told[0]).toMatchObject({ category: 'SYSTEM', messageKey: 'notifications.security.drillDue', recordType: 'RestoreDrill', recordId: drill, recordLabel: drilledOn })
    expect(await fanOutSince(['timer.fired'])).toBe(0)
    const bell = await ok('owner', 'GET', '/notifications?tab=SYSTEM')
    expect((bell.items as Json[]).find((item) => item.anchor === `drill-due:${timer}`)).toMatchObject({ sentence: `The next restore drill is due on ${plusCalendarDays(drilledOn, 90)}: the last one that passed was on ${drilledOn}` })
  })
})
