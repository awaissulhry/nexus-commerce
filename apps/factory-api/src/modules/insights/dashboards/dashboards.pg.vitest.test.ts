import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { DASHBOARD_KEYS } from '@nexus/factory-domain/insights/dashboards/boards'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * The dashboards (B-W2b-434; ANA-002, ANA-003, ANA-004; design home.dashboards) on the local stack with the app's real routes and
 * EVERY factory-db seed (made up), the facts rebuilt first: the picker (my role first, the panels I may see, the scope's
 * companies and sites), the five numbers equal to the KPI library's values (one calculation) with their source and freshness, a
 * number the person may not read replaced by the next allowed one, the scope (a company, a site; a number kept per company says
 * so), the Owner's view by company and site ("N of M sites"), Needs action from the person's Today, the on-time weeks per company,
 * the work in progress by stage, and the person's own arrangement saved on the server (a pinned report, a stale version, the
 * refusals in words, back to the dashboard's order). Run with `node scripts/factory/run-pg-tests.mjs modules/insights/dashboards`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'PUT' | 'DELETE' | 'POST'

// A rebuild reads 92 days of every company's records: more than the 5 s default on a loaded machine.
vi.setConfig({ testTimeout: 180_000 })

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'insights-dashboards434'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')

const PEOPLE = { owner: newId(), planner: newId(), sales: newId(), admin: newId(), seedOwner: '' } as Record<string, string>
const ROLE_OF: Record<string, string> = { owner: 'owner', planner: 'planner', sales: 'sales', admin: 'admin' }
const SESSIONS: Record<string, SessionContext> = {}
const grantOf = (role: string): Grant => {
  const template = templateOf(role)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }
}

let h: Harness
let app: FastifyInstance
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const run = randomBytes(4).toString('hex')
let keys = 0

async function call(person: string, method: Method, url: string, payload?: unknown) {
  const response = await app.inject({ method, url, headers: { 'x-test-session': person, ...(method !== 'GET' ? { 'idempotency-key': `k434-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(person: string, method: Method, url: string, payload?: unknown): Promise<Json> {
  const answer = await call(person, method, url, payload)
  expect(answer.status, `${person} ${method} ${url}: ${JSON.stringify(answer.body).slice(0, 600)}`).toBe(200)
  return answer.body
}
async function no(person: string, method: Method, url: string, payload: unknown, status: number): Promise<string[]> {
  const answer = await call(person, method, url, payload)
  expect(answer.status, `${person} ${method} ${url}: ${JSON.stringify(answer.body).slice(0, 600)}`).toBe(status)
  return ((answer.body.error?.issues ?? []) as Json[]).map((issue) => issue.path)
}

const today = () => businessDate(new Date())

beforeAll(async () => {
  h = await startHarness('insights_dash434')
  h.clock.set(new Date())
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  for (const [person, role] of Object.entries(ROLE_OF)) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], T, `k434-${person}-${run}@example.com`, `Made-up ${person}`])
    SESSIONS[person] = { audience: 'office', tenantId: T, actorId: PEOPLE[person]!, grants: [grantOf(role)] }
  }
  // "My role first" reads the person's roles in force: give each made-up person their system role.
  for (const [person, role] of Object.entries(ROLE_OF)) {
    const roleId = (await admin<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = $2`, [T, role]))[0]!.id
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "validFrom") VALUES ($1, $2, $3, $4, true, now() - interval '1 day')`, [newId(), T, PEOPLE[person], roleId])
  }
  // The seeded owner, whose owner-group arrangement B-W2b-381's seed wrote.
  PEOPLE.seedOwner = (await admin<{ userId: string }>(`SELECT "userId" FROM "DashboardLayout" WHERE "tenantId" = $1 AND "dashboardKey" = 'owner-group'`, [T]))[0]!.userId
  SESSIONS.seedOwner = { audience: 'office', tenantId: T, actorId: PEOPLE.seedOwner, grants: [grantOf('owner')] }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  await ok('owner', 'POST', '/insights/facts/rebuild', { from: plusDays(today(), -92), to: today() })
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('which dashboard (ANA-001, ANA-002)', () => {
  it('lists every dashboard with my role first, the panels I may see and the companies and sites I reach', async () => {
    const owner = await ok('owner', 'GET', '/insights/dashboards')
    expect(owner.boards.map((board: Json) => board.key)).toEqual([...DASHBOARD_KEYS])
    expect(owner.boards[0]).toMatchObject({ key: 'owner-group', mine: true, panels: ['numbers', 'needs-action', 'trends', 'by-company', 'wip'] })
    expect(owner.companies.length).toBeGreaterThanOrEqual(2)
    expect(owner.companies.find((company: Json) => company.id === companyA).sites.length).toBeGreaterThan(0)
    const planner = await ok('planner', 'GET', '/insights/dashboards')
    expect(planner.boards[0]).toMatchObject({ key: 'planner', mine: true })
    // Sales has no production reports: the work in progress is absent from its dashboards, never a locked box.
    const sales = await ok('sales', 'GET', '/insights/dashboards')
    expect(sales.boards[0]).toMatchObject({ key: 'sales', mine: true, panels: ['numbers', 'needs-action', 'trends'] })
    // Without the KPI library, no dashboard.
    expect((await call('admin', 'GET', '/insights/dashboards')).status).toBe(403)
  })
})

describe('the numbers (ANA-003, ANA-004)', () => {
  it('reads five KPIs through their one calculation, with the source, the freshness, 12 periods and the records behind each', async () => {
    const answer = await ok('owner', 'GET', '/insights/dashboards/owner-group/numbers?period=MONTH')
    expect(answer.numbers.map((number: Json) => number.kpiKey)).toEqual(['sales.orders_in', 'delivery.shipped_on_time', 'delivery.otif', 'production.wip_value', 'sales.order_margin'])
    expect(answer.withheld).toEqual([])
    for (const number of answer.numbers as Json[]) {
      const library = await ok('owner', 'GET', `/insights/kpis/${number.kpiKey}/value?period=MONTH&periods=12`)
      expect(number.value, number.kpiKey).toEqual(library.value)
      expect(number.periods.map((period: Json) => period.value), number.kpiKey).toEqual(library.periods.map((period: Json) => period.value))
      expect(number.problem, number.kpiKey).toBe(library.problem)
      expect(number.periods).toHaveLength(12)
      expect(number.period.kind).toBe('MONTH')
      expect(number.sources.length).toBeGreaterThan(0)
      expect(number.name.en.length).toBeGreaterThan(0)
      expect(number.stale).toBe(false)
    }
    const orders = answer.numbers[0]
    expect(orders).toMatchObject({ unit: 'MONEY', grain: 'PRICE', sources: ['ORDERS'], currency: 'EUR', drill: { kind: 'REPORT', key: 'sales.orders-in' }, standsFor: null, wholeCompany: false })
    expect(orders.asOf).not.toBeNull()
    expect(answer.numbers[2]).toMatchObject({ sources: ['DELIVERY'], drill: { kind: 'LIST', api: '/insights/kpis/drills/otif' } })
  })

  it('gives a number I may not read to the next allowed one, and names what it stands in for', async () => {
    const answer = await ok('planner', 'GET', '/insights/dashboards/owner-group/numbers')
    expect(answer.period).toBe('MONTH')
    expect(answer.numbers.map((number: Json) => [number.kpiKey, number.standsFor?.kpiKey ?? null])).toEqual([
      ['production.output', 'sales.orders_in'],
      ['delivery.shipped_on_time', null],
      ['delivery.otif', null],
      ['production.wip_pieces', 'production.wip_value'],
      ['sales.order_lines_in', 'sales.order_margin'],
    ])
    expect(answer.withheld).toEqual(['sales.orders_in', 'production.wip_value', 'sales.order_margin'])
    expect(answer.numbers[0].standsFor.name.en).toBe('Orders in')
    // No money reaches a person without the grain, nor a cost figure.
    expect(JSON.stringify(answer)).not.toContain('"currency":"EUR"')
  })

  it('reads a company, or a site of it (a number kept per company says so); a place outside my reach is not found', async () => {
    const company = await ok('owner', 'GET', `/insights/dashboards/plant-manager/numbers?period=WEEK&companyId=${companyA}`)
    for (const number of company.numbers as Json[]) {
      const library = await ok('owner', 'GET', `/insights/kpis/${number.kpiKey}/value?period=WEEK&periods=12&companyId=${companyA}`)
      expect(number.value, number.kpiKey).toEqual(library.value)
    }
    const site = (await admin<{ id: string }>(`SELECT id FROM "Site" WHERE "tenantId" = $1 AND "companyId" = $2 AND status = 'ACTIVE' ORDER BY code LIMIT 1`, [T, companyA]))[0]!.id
    const atSite = await ok('owner', 'GET', `/insights/dashboards/plant-manager/numbers?period=WEEK&siteId=${site}`)
    const output = (atSite.numbers as Json[]).find((number) => number.kpiKey === 'production.output')!
    expect(output.wholeCompany).toBe(false)
    expect(output.value).toEqual((await ok('owner', 'GET', `/insights/kpis/production.output/value?period=WEEK&periods=12&companyId=${companyA}&siteId=${site}`)).value)
    const orderToStart = (atSite.numbers as Json[]).find((number) => number.kpiKey === 'production.order_to_start_days')
    if (orderToStart) expect(orderToStart.wholeCompany).toBe(true)
    expect((await call('owner', 'GET', `/insights/dashboards/plant-manager/numbers?companyId=${newId()}`)).status).toBe(404)
    expect((await call('owner', 'GET', `/insights/dashboards/plant-manager/numbers?siteId=${newId()}`)).status).toBe(404)
    expect((await call('owner', 'GET', '/insights/dashboards/nobody/numbers')).status).toBe(400)
  })
})

describe('by company and site (ANA-002)', () => {
  it('gives the Owner the same numbers per company and, for those kept per site, per site, with how many sites were read', async () => {
    const answer = await ok('owner', 'GET', '/insights/dashboards/owner-group/by-company')
    expect(answer.columns.map((column: Json) => column.kpiKey)).toEqual(['sales.orders_in', 'delivery.shipped_on_time', 'delivery.otif', 'production.wip_value', 'sales.order_margin'])
    expect(answer.columns.find((column: Json) => column.kpiKey === 'production.wip_value').perSite).toBe(true)
    const companyRow = (answer.rows as Json[]).find((row) => row.company.id === companyA && row.site === null)!
    const library = await ok('owner', 'GET', `/insights/kpis/sales.orders_in/value?period=MONTH&periods=1&companyId=${companyA}`)
    expect(companyRow.cells[0].value).toEqual(library.value)
    expect(companyRow.sites.of).toBeGreaterThanOrEqual(companyRow.sites.read)
    const siteRows = (answer.rows as Json[]).filter((row) => row.company.id === companyA && row.site !== null)
    expect(siteRows.length).toBeGreaterThan(0)
    // Orders are kept per company: a site's cell says so instead of repeating the company's figure.
    expect(siteRows[0]!.cells[0]).toMatchObject({ perCompanyOnly: true, value: null })
    expect((await call('owner', 'GET', '/insights/dashboards/sales/by-company')).status).toBe(404)
  })
})

describe('needs action, on time, work piling up', () => {
  it('lists at most five kinds of exception from my Today, the worst first, and how many in all', async () => {
    const answer = await ok('owner', 'GET', '/insights/dashboards/needs-action')
    const todayAnswer = await ok('owner', 'GET', '/home/today?category=ALERT&include=ALERTS&limit=50')
    expect(answer.all).toBe(todayAnswer.counts.tiles.find((tile: Json) => tile.tile === 'ALERT').count)
    expect(answer.rows.length).toBeLessThanOrEqual(5)
    const ranks = (answer.rows as Json[]).map((row) => ['HIGH', 'MEDIUM', 'LOW'].indexOf(row.severity))
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks)
    expect((answer.rows as Json[]).reduce((sum, row) => sum + row.count, 0)).toBeLessThanOrEqual(answer.all)
  })

  it('draws on-time per week for 12 weeks with the target, one line per company, equal to the KPI', async () => {
    const all = await ok('owner', 'GET', '/insights/dashboards/trends')
    expect(all).toMatchObject({ target: 95, kpi: { kpiKey: 'delivery.shipped_on_time', unit: 'PERCENT' } })
    expect(all.weeks).toHaveLength(12)
    expect(all.values).toEqual((await ok('owner', 'GET', '/insights/kpis/delivery.shipped_on_time/value?period=WEEK&periods=12')).periods.map((period: Json) => period.value))
    expect(all.series.length).toBeGreaterThanOrEqual(2)
    const library = await ok('owner', 'GET', `/insights/kpis/delivery.shipped_on_time/value?period=WEEK&periods=12&companyId=${companyA}`)
    expect(all.series.find((line: Json) => line.company.id === companyA).values).toEqual(library.periods.map((period: Json) => period.value))
    const one = await ok('owner', 'GET', `/insights/dashboards/trends?companyId=${companyA}`)
    expect(one.series).toEqual([])
    expect(one.values).toEqual(library.periods.map((period: Json) => period.value))
  })

  it('shows the garments waiting at each stage with their age, as the work-in-progress KPI’s records; refused without them', async () => {
    const answer = await ok('owner', 'GET', '/insights/dashboards/wip')
    const drill = await ok('owner', 'GET', '/insights/kpis/drills/wip')
    expect(answer.overall).toEqual({ workOrders: drill.overall.workOrders, pieces: drill.overall.pieces, waiting: drill.overall.waiting })
    expect((answer.stages as Json[]).reduce((sum, stage) => sum + stage.waiting, 0)).toBe(answer.overall.waiting)
    for (const stage of answer.stages as Json[]) expect(Object.values(stage.ageing as Record<string, number>).reduce((sum, count) => sum + count, 0)).toBe(stage.waiting)
    expect((await call('sales', 'GET', '/insights/dashboards/wip')).status).toBe(403)
  })
})

describe('arrange, saved on the server per person (pop:arrange, DB1:01)', () => {
  it('reads the seeded arrangement against the dashboard today', async () => {
    const seeded = await ok('seedOwner', 'GET', '/insights/dashboards/owner-group/layout')
    expect(seeded.saved).toBe(true)
    expect(seeded.panels.map((panel: Json) => `${panel.id}${panel.hidden ? '-' : ''}`)).toEqual(['numbers', 'needs-action', 'trends', 'by-company-', 'wip'])
  })

  it('saves my order, widths and a pinned report; a stale version, a bad panel and hidden numbers are refused in words; back to the dashboard’s order', async () => {
    const first = await ok('planner', 'GET', '/insights/dashboards/planner/layout')
    expect(first).toMatchObject({ saved: false, version: 0, updatedAt: null })
    const wanted = [
      { id: 'numbers', hidden: false, width: 'FULL' },
      { id: 'trends', hidden: false, width: 'TWO_THIRDS' },
      { id: 'report:planning.adherence', hidden: false, width: 'HALF' },
      { id: 'report:sales.late-orders', hidden: false, width: 'HALF' },
      { id: 'needs-action', hidden: true, width: 'HALF' },
      { id: 'wip', hidden: false, width: 'FULL' },
    ]
    const saved = await ok('planner', 'PUT', '/insights/dashboards/planner/layout', { panels: wanted, version: 0 })
    expect(saved).toMatchObject({ saved: true, version: 1, panels: wanted })
    expect((await ok('planner', 'GET', '/insights/dashboards/planner/layout')).panels).toEqual(wanted)
    // Mine only: the owner's planner dashboard is still the dashboard's own order.
    expect((await ok('owner', 'GET', '/insights/dashboards/planner/layout')).saved).toBe(false)
    expect(await no('planner', 'PUT', '/insights/dashboards/planner/layout', { panels: wanted, version: 0 }, 409)).toEqual(['version'])
    expect(await no('planner', 'PUT', '/insights/dashboards/planner/layout', { panels: [...wanted, { id: 'by-company', hidden: false, width: 'FULL' }], version: 1 }, 400)).toEqual(['body/panels/6/id'])
    expect(await no('planner', 'PUT', '/insights/dashboards/planner/layout', { panels: [{ id: 'numbers', hidden: true, width: 'FULL' }], version: 1 }, 400)).toEqual(['body/panels/0/hidden'])
    const audit = await admin<{ n: string }>(`SELECT count(*)::text AS n FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'DashboardLayout' AND "recordId" = (SELECT id FROM "DashboardLayout" WHERE "tenantId" = $1 AND "userId" = $2)`, [T, PEOPLE.planner!])
    expect(Number(audit[0]!.n)).toBe(1)
    const reset = await ok('planner', 'DELETE', '/insights/dashboards/planner/layout?version=1')
    expect(reset).toMatchObject({ saved: false, version: 0 })
    expect(reset.panels.map((panel: Json) => panel.id)).toEqual(['numbers', 'needs-action', 'trends', 'wip'])
    expect((await call('planner', 'DELETE', '/insights/dashboards/planner/layout?version=1')).status).toBe(404)
    expect((await call('admin', 'GET', '/insights/dashboards/planner/layout')).status).toBe(403)
  })
})
