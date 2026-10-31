import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { loadReports, processReports, useReports } from './registry'
import { defineReport } from './report'

/**
 * Home › Reports and My numbers (B-W2a-79; ANA-001, ANA-029, ANA-034) on the local stack with EVERY factory-db seed (in
 * name order, as the seed command runs them): the library says what each person may run; every report of the pack runs
 * for the owner; a report obeys the person's lists (scopes), grains (a column of a grain they lack is not in the answer)
 * and the small-group rule (a test report through the real pipeline and the real grain filter); filters and groups
 * refuse what the report does not know; the numbers come per lens, money only with its grain. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/insights/reports`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'insights-reports79'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]

const PEOPLE = { owner: newId(), planner: newId(), sales: newId(), inspector: newId(), admin: newId() } as const
type Person = keyof typeof PEOPLE
const ROLES: Record<Person, { readonly role: string; readonly companies: Grant['companies'] }> = {
  owner: { role: 'owner', companies: 'all' },
  planner: { role: 'planner', companies: 'all' },
  sales: { role: 'sales', companies: [companyA] },
  inspector: { role: 'quality_inspector', companies: 'all' },
  admin: { role: 'admin', companies: 'all' },
}
function grantOf(person: Person): Grant {
  const { role, companies } = ROLES[person]
  const template = templateOf(role)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies, sites: 'all', parties: 'all' }
}
const session = (person: Person): SessionContext => ({ audience: 'office', tenantId: T, actorId: PEOPLE[person], grants: [grantOf(person)] })

async function call(person: Person, url: string): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method: 'GET', url, headers: { 'x-test-session': person } })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(person: Person, url: string): Promise<Json> {
  const answer = await call(person, url)
  expect(answer.status, `${person} ${url}: ${JSON.stringify(answer.body).slice(0, 400)}`).toBe(200)
  return answer.body
}
const issuePaths = (body: Json): string[] => ((body.error?.issues ?? []) as Json[]).map((issue) => issue.path)
const columnsOf = (body: Json): string[] => (body.columns as Json[]).map((column) => column.key)

beforeAll(async () => {
  h = await startHarness('insights_reports79')
  h.clock.set(new Date())
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: unknown; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [T])).map((row) => [row.key, row.id]))
  for (const [person, { role, companies }] of Object.entries(ROLES)) {
    const userId = PEOPLE[person as Person]
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, T, `r79-${person}@example.com`, `Person ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, $5, $6::uuid[], now() - interval '1 day')`, [
      newId(),
      T,
      userId,
      roleIds.get(role),
      companies === 'all',
      companies === 'all' ? [] : companies,
    ])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => (String(request.headers['x-test-session']) in PEOPLE ? session(String(request.headers['x-test-session']) as Person) : null)) },
  )
}, 600_000)

afterAll(async () => {
  useReports(undefined)
  await app?.close()
  await h?.close()
}, 60_000)

describe('the library says what each person may run (ANA-029, ANA-034)', () => {
  it('lists the whole pack with each report’s state; refuses a person without home.reports.view', async () => {
    const owner = await ok('owner', '/reports')
    expect(owner.reports).toHaveLength(14)
    expect((owner.reports as Json[]).every((report) => report.state === 'READY')).toBe(true)
    const planner = await ok('planner', '/reports')
    const state = (key: string) => (planner.reports as Json[]).find((report) => report.key === key)
    expect(state('finance.stock-value')).toMatchObject({ state: 'NEEDS_GRAIN', grain: 'cost' })
    expect(state('sales.margin-by-order')).toMatchObject({ state: 'NO_ACCESS', grain: null })
    expect(state('sales.open-orders')).toMatchObject({ state: 'READY' })
    expect((await call('admin', '/reports')).status).toBe(403)
  })
})

describe('every report of the pack runs, as its readers see it', () => {
  it('runs every report for the owner, every column there, totals and groups computed', async () => {
    for (const report of processReports()) {
      const body = await ok('owner', `/reports/${report.key}/results`)
      expect(columnsOf(body), report.key).toEqual(report.columns.map((column) => column.key))
      expect(body.rights, report.key).toBeNull()
      expect(body.totals.rows, report.key).toBe((body.rows as Json[]).length)
      if (report.groupBy) expect(body.groupBy, report.key).toBe(report.groupBy)
    }
  })

  it('leaves out the columns of grains the person lacks and says so (planner: no price; sales: no cost)', async () => {
    const owner = await ok('owner', '/reports/sales.open-orders/results')
    expect(columnsOf(owner)).toContain('netAmount')
    expect((owner.rows as Json[]).some((row) => typeof row.cells.netAmount === 'number')).toBe(true)
    const planner = await ok('planner', '/reports/sales.open-orders/results')
    expect(columnsOf(planner)).not.toContain('netAmount')
    expect((planner.rows as Json[]).every((row) => !('netAmount' in row.cells))).toBe(true)
    expect(planner.totals.sums).not.toHaveProperty('netAmount')
    expect(planner.rights).toEqual({ leftOut: ['price'], hiddenGroups: 0 })
    const sales = await ok('sales', '/reports/sales.margin-by-order/results')
    expect(columnsOf(sales)).toEqual(expect.arrayContaining(['netAmount', 'quotedMarginPct', 'estimateMarginPct']))
    expect(columnsOf(sales)).not.toContain('estimateCost')
    expect(sales.rights.leftOut).toEqual(['cost'])
  })

  it('refuses a run the person may not make, in words: a list outside the role, a grain the report is about', async () => {
    const access = await call('planner', '/reports/sales.margin-by-order/results')
    expect(access.status).toBe(403)
    expect(issuePaths(access.body)).toEqual(['permission/costing.view'])
    const grain = await call('planner', '/reports/finance.stock-value/results')
    expect(grain.status).toBe(403)
    expect(issuePaths(grain.body)).toEqual(['grain/cost'])
    expect((await call('planner', '/reports/finance.stock-value/schedule')).status).toBe(403)
    // About stays readable: the definition is not data.
    expect((await ok('planner', '/reports/finance.stock-value')).leftOut.grains).toEqual(['cost'])
  })

  it('reads the rows in the person’s own scope: sales of company A see company A’s orders only', async () => {
    const owner = await ok('owner', '/reports/sales.open-orders/results')
    const sales = await ok('sales', '/reports/sales.open-orders/results')
    const companyOf = new Map((await admin<{ id: string; companyId: string }>(`SELECT id, "companyId" FROM "SalesOrder" WHERE "tenantId" = $1`, [T])).map((row) => [row.id, row.companyId]))
    expect((sales.rows as Json[]).every((row) => companyOf.get(row.record.id) === companyA)).toBe(true)
    expect((owner.rows as Json[]).length).toBeGreaterThanOrEqual((sales.rows as Json[]).length)
  })

  it('answers what it applied, groups by a groupable column, and refuses what the report does not know', async () => {
    const week = await ok('owner', '/reports/sales.orders-in/results?period=LAST_8_WEEKS')
    expect(week.applied).toEqual([{ key: 'period', value: 'LAST_8_WEEKS', label: 'Last 8 weeks' }])
    expect(week.range.from < week.range.to).toBe(true)
    const grouped = await ok('owner', '/reports/production.wip-by-stage/results?group=style')
    expect(grouped.groupBy).toBe('style')
    expect((grouped.groups as Json[]).reduce((sum, group) => sum + group.rows, 0)).toBe(grouped.totals.rows)
    expect((await ok('owner', '/reports/production.wip-by-stage/results?group=none')).groups).toBeNull()
    const badPeriod = await call('owner', '/reports/sales.orders-in/results?period=NEXT_YEAR')
    expect(badPeriod.status).toBe(400)
    expect(issuePaths(badPeriod.body)).toEqual(['querystring/period'])
    expect(issuePaths((await call('owner', '/reports/production.wip-by-stage/results?group=pieces')).body)).toEqual(['querystring/group'])
    expect((await call('owner', `/reports/production.wip-by-stage/results?site=${newId()}`)).status).toBe(404)
    expect((await call('owner', '/reports/sales.no-such/results')).status).toBe(404)
  })

  it('a report’s schedule: the daily production report lists who gets it; another is not scheduled', async () => {
    const daily = await ok('owner', '/reports/production.daily/schedule')
    expect(daily).toMatchObject({ mail: 'production.daily', schedulable: true, manage: '/production/reports' })
    expect(await ok('owner', '/reports/sales.late-orders/schedule')).toMatchObject({ mail: null, schedulable: false, subscriptions: [] })
  })
})

describe('the run’s pipeline: grains through the real filter, groups of fewer than 5 people hidden', () => {
  it('drops money of a grain the person lacks and blanks the people figure of a small group, saying both', async () => {
    const real = await loadReports(fileURLToPath(new URL('../../..', import.meta.url)))
    const pipeline = defineReport({
      key: 'production.test-pipeline',
      area: 'production',
      title: 'Pipeline',
      question: 'Does the pipeline hold?',
      permission: 'workorders.view',
      needs: null,
      columns: [
        { key: 'lane', label: 'Lane', kind: 'text' },
        { key: 'good', label: 'Good', kind: 'number', sum: true },
        { key: 'efficiencyPct', label: 'Efficiency', kind: 'percent', people: true },
        { key: 'netAmount', label: 'Value', kind: 'money', grain: 'price', sum: true },
        { key: 'scrapCost', label: 'Cost', kind: 'money', grain: 'cost', sum: true },
      ],
      filters: [],
      groupBy: null,
      sources: 'Test',
      definition: 'Test',
      numbers: [],
      mail: null,
      formats: ['CSV'],
      read: async () => ({
        complete: true,
        rows: [
          { id: 'big', record: null, currency: 'EUR', people: 12, cells: { lane: 'L1', good: 10, efficiencyPct: '91.0', netAmount: 1000, scrapCost: 400 } },
          { id: 'small', record: null, currency: 'EUR', people: 3, cells: { lane: 'L2', good: 4, efficiencyPct: '88.0', netAmount: 500, scrapCost: 200 } },
        ],
      }),
    })
    useReports([...real, pipeline])
    try {
      const owner = await ok('owner', '/reports/production.test-pipeline/results')
      expect((owner.rows as Json[]).map((row) => row.cells)).toEqual([
        { lane: 'L1', good: 10, efficiencyPct: '91.0', netAmount: 1000, scrapCost: 400 },
        { lane: 'L2', good: 4, efficiencyPct: null, netAmount: 500, scrapCost: 200 },
      ])
      expect(owner.totals.sums).toEqual({ good: 14, netAmount: 1500, scrapCost: 600 })
      expect(owner.rights).toEqual({ leftOut: [], hiddenGroups: 1 })
      const planner = await ok('planner', '/reports/production.test-pipeline/results')
      expect((planner.rows as Json[]).map((row) => row.cells)).toEqual([
        { lane: 'L1', good: 10, efficiencyPct: '91.0' },
        { lane: 'L2', good: 4, efficiencyPct: null },
      ])
      expect(planner.totals.sums).toEqual({ good: 14 })
      expect(planner.rights).toEqual({ leftOut: ['price', 'cost'], hiddenGroups: 1 })
    } finally {
      useReports(undefined)
    }
  })
})

describe('My numbers on Today (ANA-001)', () => {
  it('per lens the person has, three to five numbers, money only with its grain, none failing', async () => {
    const owner = await ok('owner', '/home/numbers')
    expect((owner.lenses as Json[]).map((lens) => lens.lens)).toEqual(['ORDERS', 'WORK_ORDERS', 'PURCHASE_ORDERS', 'INVOICES', 'LOTS'])
    for (const lens of owner.lenses as Json[]) {
      expect(lens.numbers.length, lens.lens).toBeGreaterThanOrEqual(3)
      expect(lens.numbers.length, lens.lens).toBeLessThanOrEqual(5)
      for (const number of lens.numbers as Json[]) expect(number.problem, `${number.key}: ${number.problem}`).not.toBe('UNAVAILABLE')
    }
    const inThisWeek = (owner.lenses as Json[])[0]!.numbers.find((number: Json) => number.key === 'orders.inThisWeek')
    expect(inThisWeek.spark).toHaveLength(8)
    const planner = await ok('planner', '/home/numbers')
    const plannerNumbers = (planner.lenses as Json[]).flatMap((lens) => lens.numbers as Json[])
    expect(plannerNumbers.some((number) => number.unit === 'MONEY' || number.grain !== null)).toBe(false)
    expect((planner.lenses as Json[]).map((lens) => lens.lens)).toEqual(['ORDERS', 'WORK_ORDERS', 'PURCHASE_ORDERS'])
    expect(((await ok('inspector', '/home/numbers')).lenses as Json[]).map((lens) => lens.lens)).toEqual(['WORK_ORDERS', 'LOTS'])
    expect((await ok('admin', '/home/numbers')).lenses).toEqual([])
    const late = (owner.lenses as Json[])[0]!.numbers.find((number: Json) => number.key === 'orders.late')
    expect(late).toMatchObject({ target: { value: 0, direction: 'AT_MOST' }, list: { api: '/sales/orders', query: { late: 'true' } }, report: { key: 'sales.late-orders' } })
    expect(late.targetWord).toBe(late.value === 0 ? 'ON_TARGET' : 'ABOVE_TARGET')
  })
})
