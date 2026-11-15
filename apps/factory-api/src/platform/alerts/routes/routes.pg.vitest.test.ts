import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { plusCalendarDays } from '@nexus/factory-domain/timers/rules'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedHolds } from '../../../../../../packages/factory-db/seed/holds'
import { seed as seedAlerts } from '../../../../../../packages/factory-db/seed/alerts'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import type { Log } from '../../../core/queue'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../auth/sessions/testing/harness'
import { fanOut } from '../../notifications/fan-out'
import { systemContext } from '../../outbox/system'
import { runAlertEvaluation } from '../engine'

/**
 * Alert routing by place and role (B-W2b-435; ANA-041) on the local stack: a throwaway PostgreSQL 17 database from the migrations
 * (the runtime login: row-level security and the …_insights_depth_w2b_guards triggers are real), the factory-db seeds up to the
 * holds and the alerts seed, people with live role assignments (the fan-out reads them). A rule's routes are read with their
 * choices, added and removed through the real routes (each refusal in words), and the worker's fan-out tells a covered place's
 * routed people instead of the rule's own role. Run with `node scripts/factory/run-pg-tests.mjs platform/alerts/routes`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'alert-routes-w2b435'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const siteA1 = idOf('site:A1')
const siteB1 = idOf('site:B1')
const lineA1 = idOf('site:A1:line:L1')

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}

const PEOPLE = { owner: newId(), planner: newId(), finance: newId(), quality: newId() } as const
type Person = keyof typeof PEOPLE
const ROLE: Record<Person, string> = { owner: 'owner', planner: 'planner', finance: 'finance', quality: 'quality_inspector' }
function grantOf(person: Person): Grant {
  const template = templateOf(ROLE[person])!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }
}
const session = (person: Person): SessionContext => ({ audience: 'office', tenantId: T, actorId: PEOPLE[person], grants: [grantOf(person)] })

let keys = 0
async function call(person: Person, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': person, ...(method !== 'GET' ? { 'idempotency-key': `w2b435-route-${++keys}-${newId()}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(person: Person, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(person, method, url, payload)
  expect(answer.status, JSON.stringify(answer.body).slice(0, 600)).toBe(status)
  return answer.body
}
const issuePaths = (body: Json): string[] => ((body.error?.issues ?? []) as Json[]).map((issue) => issue.path)

let at = new Date()
const clock = { now: () => at }
const log: Log = { info: () => undefined, warn: () => undefined, error: () => undefined }
const system = () => callerFor(h.database, systemContext(T, `test-${newId()}`))

async function fanOutSince(types: readonly string[]): Promise<number> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = ANY($2) ORDER BY "occurredAt", id`, [T, types])
  let made = 0
  for (const row of rows) {
    const envelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }
    made += await fanOut(system(), envelope)
  }
  return made
}

let lateRule: string
let so2: string
let roles: Map<string, string>

beforeAll(async () => {
  h = await startHarness('alert_routes435')
  at = new Date()
  h.clock.set(at)
  for (const seed of [seedCore, seedAuth, seedRoles, seedCompliance, seedHolds, seedAlerts]) await seed({ db: h.database, namespace: NS })
  roles = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [T])).map((row) => [row.key, row.id]))
  for (const person of Object.keys(PEOPLE) as Person[]) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], T, `w2b435-${person}@example.com`, `Made-up ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "validFrom") VALUES ($1, $2, $3, $4, true, now() - interval '30 days')`, [newId(), T, PEOPLE[person], roles.get(ROLE[person])])
  }
  // SEED-SO-0002 promised in two days and still CONFIRMED: the built-in "order at risk" rule (it tells the planner) raises it.
  so2 = (await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0002'`, [T])).id
  await force(`UPDATE "SalesOrder" SET "promiseDate" = $2::date, status = 'CONFIRMED' WHERE id = $1`, [so2, plusCalendarDays(businessDate(at), 2)])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => (String(request.headers['x-test-session']) in PEOPLE ? session(String(request.headers['x-test-session']) as Person) : null)) },
  )
  // The scheduler's first pass makes every built-in rule.
  await runAlertEvaluation({ database: h.database, log, clock })
  lateRule = (await one<{ id: string }>(`SELECT id FROM "AlertRule" WHERE "tenantId" = $1 AND "ruleKind" = 'ORDER_LATE_RISK' AND "builtIn" ORDER BY "createdAt" LIMIT 1`, [T])).id
}, 180_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
})

describe("a rule's routes (ANA-041)", () => {
  it('reads none yet, with the roles, people and places a route may name; a reader without the rules right only reads', async () => {
    const owner = await ok('owner', 'GET', `/alerts/rules/${lateRule}/routes`)
    expect(owner).toMatchObject({ ruleId: lateRule, routes: [], canChange: true, max: 50 })
    expect(owner.choices.roles.some((role: Json) => role.key === 'finance')).toBe(true)
    expect(owner.choices.people.map((person: Json) => person.id)).toEqual(expect.arrayContaining([PEOPLE.finance, PEOPLE.quality]))
    // A rule of every company: every company whole, its sites and their lines; the customers.
    const a = owner.choices.companies.find((company: Json) => company.id === companyA)
    expect(a).toMatchObject({ whole: true })
    expect(a.sites.find((site: Json) => site.id === siteA1).lines.map((line: Json) => line.id)).toContain(lineA1)
    expect(owner.choices.customers.length).toBeGreaterThan(0)
    const planner = await ok('planner', 'GET', `/alerts/rules/${lateRule}/routes`)
    expect(planner).toMatchObject({ canChange: false, choices: null })
    // The rules list says how many routes each rule keeps.
    expect((await ok('owner', 'GET', `/alerts/rules/${lateRule}`)).rule.routes).toBe(0)
  })

  it('adds a route of company A to one person, and refuses twice, an unknown place, a planner, a role and a person both', async () => {
    const added = await ok('owner', 'POST', `/alerts/rules/${lateRule}/routes`, { scope: 'COMPANY', scopeId: companyA, userId: PEOPLE.finance }, 201)
    expect(added.route).toMatchObject({ scope: 'COMPANY', scopeId: companyA, who: { kind: 'PERSON', id: PEOPLE.finance, name: 'Made-up finance' } })
    expect(issuePaths((await call('owner', 'POST', `/alerts/rules/${lateRule}/routes`, { scope: 'COMPANY', scopeId: companyA, userId: PEOPLE.finance })).body)).toEqual(['route/DUPLICATE'])
    expect(issuePaths((await call('owner', 'POST', `/alerts/rules/${lateRule}/routes`, { scope: 'LINE', scopeId: newId(), roleId: roles.get('quality_inspector') })).body)).toEqual(['route/PLACE'])
    expect((await call('planner', 'POST', `/alerts/rules/${lateRule}/routes`, { scope: 'SITE', scopeId: siteA1, roleId: roles.get('planner') })).status).toBe(403)
    expect((await call('owner', 'POST', `/alerts/rules/${lateRule}/routes`, { scope: 'SITE', scopeId: siteA1, roleId: roles.get('planner'), userId: PEOPLE.finance })).status).toBe(400)
    const read = await ok('owner', 'GET', `/alerts/rules/${lateRule}/routes`)
    expect(read.routes).toHaveLength(1)
    expect((await ok('owner', 'GET', `/alerts/rules/${lateRule}`)).rule.routes).toBe(1)
    const event = await one(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'alert.route_added' ORDER BY "occurredAt" DESC LIMIT 1`, [T])
    expect(event.payload).toMatchObject({ ruleId: lateRule, scope: 'COMPANY', scopeId: companyA })
  })

  it("never routes wider than the rule: a company A rule refuses company B's site", async () => {
    const rule = await ok('owner', 'POST', '/alerts/rules', { ruleKind: 'ORDER_LATE_RISK', name: 'Late at A', threshold: { daysBeforePromise: 3 }, severity: 'WARNING', companyId: companyA, siteId: null, recipientRoleId: roles.get('planner'), channels: ['IN_APP'], cooldownMinutes: 1440, enabled: false }, 201)
    expect(issuePaths((await call('owner', 'POST', `/alerts/rules/${rule.rule.id}/routes`, { scope: 'SITE', scopeId: siteB1, roleId: roles.get('quality_inspector') })).body)).toEqual(['route/WIDER'])
    await ok('owner', 'POST', `/alerts/rules/${rule.rule.id}/routes`, { scope: 'SITE', scopeId: siteA1, roleId: roles.get('quality_inspector') }, 201)
    // The database holds the same rule: a route written past the command's check is refused in words.
    await expect(admin(`INSERT INTO "AlertRoute" (id, "tenantId", "ruleId", scope, "scopeId", "roleId", key) VALUES ($1, $2, $3, 'SITE', $4, $5, $6)`, [newId(), T, rule.rule.id, siteB1, roles.get('planner'), `route:${rule.rule.id}:SITE:${siteB1}:role:${roles.get('planner')}`])).rejects.toThrow(/never widens its rule/)
  })

  it('tells the routed person of the place, not the rule’s own role (the fan-out)', async () => {
    const run = await runAlertEvaluation({ database: h.database, log, clock })
    expect(run.failed).toBe(0)
    expect(await fanOutSince(['alert.raised'])).toBeGreaterThan(0)
    const alert = await one(`SELECT id FROM "Alert" WHERE "ruleKind" = 'ORDER_LATE_RISK' AND "recordId" = $1 ORDER BY occurrence DESC LIMIT 1`, [so2])
    const told = (await admin(`SELECT "userId" FROM "Notification" WHERE "tenantId" = $1 AND anchor = $2`, [T, `alert:${alert.id}`])).map((row) => row.userId)
    expect(told).toEqual([PEOPLE.finance])
  })

  it('removes a route (again: 404); the rule tells its own role again', async () => {
    const route = (await ok('owner', 'GET', `/alerts/rules/${lateRule}/routes`)).routes[0]
    expect((await call('planner', 'DELETE', `/alerts/routes/${route.id}`)).status).toBe(403)
    await ok('owner', 'DELETE', `/alerts/routes/${route.id}`)
    expect((await call('owner', 'DELETE', `/alerts/routes/${route.id}`)).status).toBe(404)
    expect((await ok('owner', 'GET', `/alerts/rules/${lateRule}`)).rule.routes).toBe(0)
    expect((await one(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'alert.route_removed'`, [T])).n).toBe(1)
    const audit = await one(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'AlertRule' AND "recordId" = $2 AND action = 'alerts.removeRoute'`, [T, lateRule])
    expect(audit.n).toBe(1)
  })
})
