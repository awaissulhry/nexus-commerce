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
import { businessDate, businessDayRange } from '@nexus/factory-domain/core/time'
import { eventEnvelope } from '@nexus/factory-domain/events/envelope'
import { MEASURES } from '@nexus/factory-domain/insights/kpis/measures'
import { KPI_CATALOGUE } from '@nexus/factory-domain/insights/kpis/registry'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { factsHandler, rebuildAllTenants } from '../facts/jobs'

/**
 * The metric layer (B-W2b-428; ANA-012, ANA-028, ANA-069, ANA-070) on the local stack with the app's real routes and EVERY
 * factory-db seed (made up): the facts rebuilt from the records (twice: the same rows, a later stamp), equal to what the
 * records say (orders, the daily production report and its hours, the cost ledger's balance, the receipts); the KPI library
 * with the seeded versions and the code's calculations; the standard KPIs installed and where they are used; a version
 * drafted, changed, put in force (the one before superseded), withdrawn, and every refusal in words; a KPI's value as the
 * person's scope and grains allow (a customer-limited person computed live); the facts per day, hour and shift; the event
 * handler and the hour's job. Run with `node scripts/factory/run-pg-tests.mjs modules/insights/kpis`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'

// A rebuild reads 60 days of every company's records: more than the 5 s default on a loaded machine.
vi.setConfig({ testTimeout: 120_000 })

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'insights-kpis428'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')

const PEOPLE = { owner: newId(), planner: newId(), sales: newId(), narrow: newId(), production: newId(), admin: newId() } as const
type Person = keyof typeof PEOPLE
const ROLE_OF: Record<Person, string> = { owner: 'owner', planner: 'planner', sales: 'sales', narrow: 'sales', production: 'production_manager', admin: 'admin' }
const SESSIONS: Record<string, SessionContext> = {}
const grantOf = (role: string, parties: Grant['parties'] = 'all'): Grant => {
  const template = templateOf(role)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties }
}

let h: Harness
let app: FastifyInstance
let partyNarrow = ''
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
/** Made-up floor rows written past the floor's own guards (the test plants what a tablet would have sent). */
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await h.db.admin.query('SET session_replication_role = replica')
  try {
    await h.db.admin.query(sql, values)
  } finally {
    await h.db.admin.query('SET session_replication_role = DEFAULT')
  }
}
const run = randomBytes(4).toString('hex')
let keys = 0

async function call(person: Person, method: Method, url: string, payload?: unknown) {
  const response = await app.inject({ method, url, headers: { 'x-test-session': person, ...(method !== 'GET' ? { 'idempotency-key': `k428-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(person: Person, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(person, method, url, payload)
  expect(answer.status, `${person} ${method} ${url}: ${JSON.stringify(answer.body).slice(0, 600)}`).toBe(status)
  return answer.body
}
async function no(person: Person, method: Method, url: string, payload: unknown, status: number): Promise<string[]> {
  const answer = await call(person, method, url, payload)
  expect(answer.status, `${person} ${method} ${url}: ${JSON.stringify(answer.body).slice(0, 600)}`).toBe(status)
  return ((answer.body.error?.issues ?? []) as Json[]).map((issue) => issue.path)
}

const today = () => businessDate(new Date())
const FROM = () => plusDays(today(), -60)
const factsOf = (measure: string, where = '') => admin<{ day: string; siteId: string | null; lineId: string | null; value: string | null; priceAmount: number | null; costAmount: number | null; rebuiltAt: Date }>(
  `SELECT to_char(day, 'YYYY-MM-DD') AS day, "siteId", "lineId", value::text AS value, "priceAmount", "costAmount", "rebuiltAt" FROM "FactDaily" WHERE "tenantId" = $1 AND "measureKey" = $2 ${where} ORDER BY day, "siteId" NULLS FIRST, "lineId" NULLS FIRST`,
  [T, measure],
)

beforeAll(async () => {
  h = await startHarness('insights_kpis428')
  h.clock.set(new Date())
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  // A customer with orders: the person limited to it reads the order KPIs live.
  partyNarrow = (await admin<{ partyId: string }>(`SELECT "partyId" FROM "SalesOrder" WHERE "tenantId" = $1 AND status <> 'CANCELLED' GROUP BY "partyId" ORDER BY count(*) DESC, "partyId" LIMIT 1`, [T]))[0]!.partyId
  for (const [person, role] of Object.entries(ROLE_OF) as Array<[Person, string]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], T, `k428-${person}-${run}@example.com`, `Made-up ${person}`])
    SESSIONS[person] = { audience: 'office', tenantId: T, actorId: PEOPLE[person], grants: [grantOf(role, person === 'narrow' ? [partyNarrow] : 'all')] }
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the facts, rebuilt from the records (ANA-069)', () => {
  it('rebuilds 60 days of every company; again the same rows, stamped later; a range out of bounds is refused in words', async () => {
    const first = await ok('owner', 'POST', '/insights/facts/rebuild', { from: FROM(), to: today() })
    expect(first.sources).toEqual(['ORDERS', 'SHIPMENTS', 'PRODUCTION', 'WIP', 'RECEIPTS', 'DELIVERY', 'LEAD_TIMES', 'WORK_ORDERS', 'LEATHER', 'MARGIN', 'SUPPLY'])
    expect(first.companies.length).toBeGreaterThanOrEqual(2)
    const rows = await admin<{ key: string; n: string; v: string | null; p: number | null; c: number | null; at: Date }>(`SELECT key, value::text AS v, "priceAmount" AS p, "costAmount" AS c, "rebuiltAt" AS at FROM "FactDaily" WHERE "tenantId" = $1 ORDER BY key`, [T])
    const again = await ok('owner', 'POST', '/insights/facts/rebuild', { from: FROM(), to: today() })
    expect(again.companies).toEqual(first.companies)
    const after = await admin<{ key: string; v: string | null; p: number | null; c: number | null; at: Date }>(`SELECT key, value::text AS v, "priceAmount" AS p, "costAmount" AS c, "rebuiltAt" AS at FROM "FactDaily" WHERE "tenantId" = $1 ORDER BY key`, [T])
    expect(after.map(({ key, v, p, c }) => ({ key, v, p, c }))).toEqual(rows.map(({ key, v, p, c }) => ({ key, v, p, c })))
    expect(after[0]!.at.getTime()).toBeGreaterThanOrEqual(rows[0]!.at.getTime())
    // Every company keeps a row per day and company measure: a day rebuilt says so, zeros too.
    expect((await factsOf('orders.lines_in', `AND "companyId" = '${companyA}'`)).length).toBe(61)
    expect(await no('owner', 'POST', '/insights/facts/rebuild', { from: plusDays(today(), -100), to: today() }, 400)).toEqual(['body/from'])
    expect(await no('owner', 'POST', '/insights/facts/rebuild', { from: today(), to: plusDays(today(), 5) }, 400)).toEqual(['body/to'])
    expect((await call('planner', 'POST', '/insights/facts/rebuild', { from: today(), to: today() })).status).toBe(403)
  })

  it('counts what the records say: order lines and value by order date, the cost ledger’s balance, receipt lines', async () => {
    const lines = await admin<{ day: string; n: string; v: string }>(
      `SELECT to_char(o."orderDate", 'YYYY-MM-DD') AS day, count(l.id)::text AS n, (SELECT sum(o2."netAmount") FROM "SalesOrder" o2 WHERE o2."companyId" = $2 AND o2.status <> 'CANCELLED' AND o2."orderDate" = o."orderDate")::text AS v
         FROM "SalesOrder" o JOIN "SalesOrderLine" l ON l."orderId" = o.id
        WHERE o."tenantId" = $1 AND o."companyId" = $2 AND o.status <> 'CANCELLED' AND o."orderDate" BETWEEN $3::date AND $4::date GROUP BY o."orderDate"`,
      [T, companyA, FROM(), today()],
    )
    expect(lines.length).toBeGreaterThan(0)
    const facts = new Map((await factsOf('orders.lines_in', `AND "companyId" = '${companyA}'`)).map((row) => [row.day, row.value]))
    const value = new Map((await factsOf('orders.value', `AND "companyId" = '${companyA}'`)).map((row) => [row.day, row.priceAmount]))
    for (const row of lines) {
      expect(facts.get(row.day), row.day).toBe(`${row.n}.0000`)
      expect(String(value.get(row.day)), row.day).toBe(row.v)
    }
    const end = businessDayRange(today(), 'Europe/Rome').end
    const ledger = await admin<{ siteId: string; total: string }>(`SELECT "siteId", sum(amount)::text AS total FROM "WorkOrderCostEntry" WHERE "tenantId" = $1 AND "occurredAt" < $2 GROUP BY "siteId"`, [T, end])
    expect(ledger.length).toBeGreaterThan(0)
    for (const row of ledger) {
      const wip = await factsOf('wip.cost', `AND "siteId" = '${row.siteId}' AND day = '${today()}'::date`)
      expect(String(wip[0]?.costAmount), row.siteId).toBe(row.total)
    }
    const receipts = await admin<{ siteId: string; n: string }>(
      `SELECT r."siteId", count(l.id)::text AS n FROM "GoodsReceipt" r JOIN "GoodsReceiptLine" l ON l."receiptId" = r.id WHERE r."tenantId" = $1 AND r.status = 'POSTED' AND r."postedAt" >= $2 AND r."postedAt" < $3 GROUP BY r."siteId"`,
      [T, businessDayRange(FROM(), 'Europe/Rome').start, end],
    )
    for (const row of receipts) {
      const facts = await factsOf('receipts.lines', `AND "siteId" = '${row.siteId}'`)
      expect(facts.reduce((total, fact) => total + Number(fact.value), 0), row.siteId).toBe(Number(row.n))
    }
  })

  it('counts the floor as the daily production report does, per site and line, and its hours add up to the day', async () => {
    // Two made-up reports at a line's station yesterday (08:10 and 10:20 on the site's clock), on a whole-garment bundle.
    const station = (await admin<{ id: string; siteId: string; lineId: string; workCentreId: string; timezone: string }>(
      `SELECT st.id, st."siteId", st."lineId", st."workCentreId", s.timezone FROM "Station" st JOIN "Site" s ON s.id = st."siteId" WHERE st."tenantId" = $1 AND st."lineId" IS NOT NULL ORDER BY st.code LIMIT 1`,
      [T],
    ))[0]!
    const op = (await admin<{ id: string; workOrderId: string; cell: string }>(
      `SELECT o.id, o."workOrderId", (SELECT b."workOrderSizeId" FROM "Bundle" b WHERE b."workOrderId" = o."workOrderId" LIMIT 1) AS cell FROM "WorkOrderOperation" o
        WHERE o."tenantId" = $1 AND o."workCentreId" = $2 AND o."scanRequired" AND EXISTS (SELECT 1 FROM "Bundle" b WHERE b."workOrderId" = o."workOrderId" AND b."siteId" = $3) ORDER BY o.seq DESC LIMIT 1`,
      [T, station.workCentreId, station.siteId],
    ))[0]!
    const day = plusDays(today(), -1)
    const at = (minute: number) => new Date(businessDayRange(day, station.timezone).start.getTime() + minute * 60_000)
    const bundleId = newId()
    await force(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity) VALUES ($1, $2, $3, $4, $5, $6, 10)`, [bundleId, T, station.siteId, op.workOrderId, op.cell, `K428-BN-${run}`])
    for (const [minute, good, scrap] of [[8 * 60 + 10, 5, 0], [10 * 60 + 20, 3, 1]] as const) {
      await force(
        `INSERT INTO "OperationScan" (id, "tenantId", "siteId", "workOrderId", "workOrderOperationId", "bundleId", kind, "goodQuantity", "scrapQuantity", "stationId", "clientScanId", "serverTime") VALUES ($1, $2, $3, $4, $5, $6, 'REPORT', $7, $8, $9, $10, $11)`,
        [newId(), T, station.siteId, op.workOrderId, op.id, bundleId, good, scrap, station.id, `k428-${run}-${minute}`, at(minute)],
      )
    }
    await ok('owner', 'POST', '/insights/facts/rebuild', { from: day, to: day })
    const daily = await ok('owner', 'GET', `/production/reports/daily?siteId=${station.siteId}&date=${day}`)
    expect(daily.totals.good).toBeGreaterThanOrEqual(8)
    const site = await factsOf('production.output_pieces', `AND "siteId" = '${station.siteId}' AND "lineId" IS NULL AND day = '${day}'::date`)
    expect(Number(site[0]!.value)).toBe(daily.totals.good)
    const scrap = await factsOf('production.scrap_pieces', `AND "siteId" = '${station.siteId}' AND "lineId" IS NULL AND day = '${day}'::date`)
    expect(Number(scrap[0]!.value)).toBe(daily.totals.scrap)
    const lane = (daily.lanes as Json[]).find((entry) => entry.kind === 'LINE' && entry.id === station.lineId)!
    const line = await factsOf('production.output_pieces', `AND "lineId" = '${station.lineId}' AND day = '${day}'::date`)
    expect(Number(line[0]!.value)).toBe(lane.good)
    // Per hour: 5 in the 08:00 hour, 3 in the 10:00 hour of the site's clock; the hours add up to the day.
    const byHour = await ok('owner', 'GET', `/insights/facts?measure=production.output_pieces&from=${day}&to=${day}&by=HOUR&siteId=${station.siteId}`)
    const hourOf = (minute: number) => (byHour.rows as Json[]).find((row) => row.hourStart === at(minute - (minute % 60)).toISOString())
    expect(Number(hourOf(8 * 60)?.value)).toBeGreaterThanOrEqual(5)
    expect(Number(hourOf(10 * 60)?.value)).toBeGreaterThanOrEqual(3)
    expect((byHour.rows as Json[]).reduce((total, row) => total + Number(row.value), 0)).toBe(daily.totals.good)
    // Per shift of the site's calendar: each shift holds the hours inside it.
    const byShift = await ok('owner', 'GET', `/insights/facts?measure=production.output_pieces&from=${day}&to=${day}&by=SHIFT&siteId=${station.siteId}`)
    for (const row of byShift.rows as Json[]) {
      const inside = (byHour.rows as Json[]).filter((hour) => hour.hourStart >= row.shift.start && hour.hourStart < row.shift.end).reduce((total, hour) => total + Number(hour.value), 0)
      expect(Number(row.value), row.shift.label).toBe(inside)
    }
    expect(await no('owner', 'GET', `/insights/facts?measure=orders.value&from=${today()}&to=${today()}&by=HOUR`, undefined, 400)).toEqual(['querystring/by'])
    expect(await no('owner', 'GET', `/insights/facts?measure=production.output_pieces&from=${today()}&to=${today()}&by=SHIFT`, undefined, 400)).toEqual(['querystring/siteId'])
  })

  it('reads a measure only with its list permission and grain (403 in words); the measures say what I may read', async () => {
    // A person and a measure whose list they do not hold; a person and a measure whose list they hold but not its money grain.
    const people: Person[] = ['planner', 'sales', 'production']
    const pairs = people.flatMap((person) => MEASURES.map((measure) => ({ person, measure, template: templateOf(ROLE_OF[person])! })))
    const outside = pairs.find(({ measure, template }) => !template.permissions.includes(measure.permission))!
    expect(outside, 'a measure outside a role').toBeTruthy()
    expect(await no(outside.person, 'GET', `/insights/facts?measure=${outside.measure.key}&from=${FROM()}&to=${today()}`, undefined, 403)).toEqual([`permission/${outside.measure.permission}`])
    const ungrained = pairs.find(({ measure, template }) => measure.grain && template.permissions.includes(measure.permission) && !template.grains.includes(measure.grain))
    if (ungrained) expect(await no(ungrained.person, 'GET', `/insights/facts?measure=${ungrained.measure.key}&from=${FROM()}&to=${today()}`, undefined, 403)).toEqual([`grain/${ungrained.measure.grain}`])
    const measures = await ok(outside.person, 'GET', '/insights/measures')
    const readable = new Map((measures.measures as Json[]).map((measure) => [measure.key, measure.readable]))
    expect(readable.get(outside.measure.key)).toBe(false)
    expect((await ok('production', 'GET', '/insights/measures')).measures.find((measure: Json) => measure.key === 'production.output_pieces').readable).toBe(true)
    expect((measures.companies as Json[]).find((company) => company.id === companyA)?.lastRebuiltAt).toBeTruthy()
    expect((await call('admin', 'GET', '/insights/measures')).status).toBe(403)
  })
})

describe('the KPI library and its versions (ANA-012)', () => {
  it('lists every KPI of the code and of the database, with the calculation, the version shown and where it is used', async () => {
    const library = await ok('owner', 'GET', '/insights/kpis')
    const keyOf = (key: string) => (library.kpis as Json[]).find((kpi) => kpi.key === key)
    for (const file of KPI_CATALOGUE) expect(keyOf(file.key)?.calculation?.measures, file.key).toBeTruthy()
    // Seeded: on-time in full v2 in force and v3 drafted; B-W2b-429 gave it its calculation (the versions name its facts).
    expect(keyOf('delivery.otif')).toMatchObject({ calculation: { measures: ['orders.lines_shipped_on_time', 'orders.lines_due'] }, inForce: { kpiVersion: 2 }, drafts: 1, uses: 3, measuresDiffer: false })
    // Seeded order margin names other facts than its calculation reads (made before the calculation).
    expect(keyOf('sales.order_margin')).toMatchObject({ measuresDiffer: true, inForce: { kpiVersion: 1 } })
    expect(keyOf('production.scrap_rate')).toMatchObject({ measuresDiffer: false })
    // Not installed yet: the standard words come from the code.
    expect(keyOf('production.output')).toMatchObject({ shown: null, standardWords: { nameEn: 'Pieces made' } })
    expect((await call('admin', 'GET', '/insights/kpis')).status).toBe(403)
  })

  it('installs the standard KPIs and where they are used; a second sync changes nothing; manage only', async () => {
    expect((await call('planner', 'POST', '/insights/kpis/sync')).status).toBe(403)
    const first = await ok('owner', 'POST', '/insights/kpis/sync')
    expect(first.installed).toEqual([
      'delivery.order_to_ship_days',
      'delivery.otif_current',
      'delivery.shipped_on_time',
      'production.leather_yield',
      'production.order_to_start_days',
      'production.output',
      'production.wip_age_days',
      'production.wip_pieces',
      'purchasing.receipt_lines',
      'sales.margin_actual',
      'sales.margin_quoted',
      'sales.order_lines_in',
      'sales.orders_in',
      'sales.quote_to_order_days',
    ])
    const added = first.usesAdded.map((use: Json) => `${use.kpiKey}:${use.usedIn}:${use.useKey}`)
    expect(added.filter((use: string) => use.endsWith(':today'))).toEqual(['delivery.shipped_on_time:DASHBOARD:today', 'production.output:DASHBOARD:today', 'sales.orders_in:DASHBOARD:today'])
    // B-W2b-434: the dashboards' numbers and charts are uses too (the seeded owner-group use of OTIF was there already).
    expect(added).toEqual(expect.arrayContaining(['sales.orders_in:DASHBOARD:owner-group', 'production.output:DASHBOARD:plant-manager', 'delivery.otif:DASHBOARD:planner']))
    expect(added).not.toContain('delivery.otif:DASHBOARD:owner-group')
    expect(first.usesRemoved).toEqual([])
    const second = await ok('owner', 'POST', '/insights/kpis/sync')
    expect(second).toMatchObject({ installed: [], usesAdded: [], usesRemoved: [] })
    const output = await ok('owner', 'GET', '/insights/kpis/production.output')
    expect(output.versions).toHaveLength(1)
    expect(output.versions[0]).toMatchObject({ kpiVersion: 1, state: 'ACTIVE', activatedBy: 'Made-up owner', owner: { key: 'production_manager' } })
    expect(output.usedIn.map((use: Json) => use.useKey)).toEqual(['line-leader', 'owner-group', 'plant-manager', 'quality', 'today'])
    // The seeded uses of readers no registry owns stay (a report, an alert rule kind), beside the dashboards that read it.
    const otif = (await ok('owner', 'GET', '/insights/kpis/delivery.otif')).usedIn.map((use: Json) => `${use.usedIn}:${use.useKey}`).sort()
    expect(otif).toEqual(['ALERT:ORDER_LATE_RISK', 'DASHBOARD:buyer', 'DASHBOARD:owner-group', 'DASHBOARD:planner', 'DASHBOARD:quality', 'DASHBOARD:sales', 'REPORT:sales.late-orders'])
  })

  it('drafts a new version from the one in force, changes it, puts it in force; the one before is superseded and kept', async () => {
    const v1 = (await ok('owner', 'GET', '/insights/kpis/production.output')).versions[0]
    const draft = await ok('owner', 'POST', '/insights/kpis/production.output/versions', { basedOnId: v1.id, changeNote: 'The definition names the work centres too (made up).', definitionEn: 'Good pieces at each line’s or work centre’s last operation, on the site’s day (made up).' }, 201)
    expect(draft).toMatchObject({ kpiKey: 'production.output', kpiVersion: 2, version: 1 })
    const edited = await ok('owner', 'PATCH', `/insights/kpis/versions/${draft.id}`, { version: 1, nameEn: 'Pieces made (v2)' })
    expect(edited.version).toBe(2)
    expect(await no('owner', 'PATCH', `/insights/kpis/versions/${draft.id}`, { version: 1, nameEn: 'stale' }, 409)).toEqual(['version'])
    expect(await no('owner', 'PATCH', `/insights/kpis/versions/${draft.id}`, { version: 2, nameIt: '' }, 400)).toEqual(['body/nameIt'])
    expect(await no('owner', 'PATCH', `/insights/kpis/versions/${v1.id}`, { version: v1.version, nameEn: 'x' }, 409)).toEqual(['refusal/NOT_DRAFT'])
    const active = await ok('owner', 'POST', `/insights/kpis/versions/${draft.id}/activate`, { version: 2 })
    expect(active).toMatchObject({ kpiVersion: 2, supersededId: v1.id })
    const record = await ok('owner', 'GET', '/insights/kpis/production.output')
    expect(record.versions.map((version: Json) => [version.kpiVersion, version.state])).toEqual([
      [2, 'ACTIVE'],
      [1, 'SUPERSEDED'],
    ])
    expect(record.versions[0]).toMatchObject({ basedOnId: v1.id, changeNote: 'The definition names the work centres too (made up).', nameEn: 'Pieces made (v2)', createdBy: 'Made-up owner' })
    expect(record.versions[1]).toMatchObject({ endedBy: 'Made-up owner' })
    expect(record.shown.kpiVersion).toBe(2)
    expect(await no('owner', 'DELETE', `/insights/kpis/versions/${v1.id}?version=${record.versions[1].version}`, undefined, 409)).toEqual(['refusal/NOT_DRAFT'])
  })

  it('refuses in words: another calculation, another KPI’s version, an unknown measure, a person without manage', async () => {
    const scrap = (await ok('owner', 'GET', '/insights/kpis/production.scrap_rate')).versions[0]
    const other = await ok('owner', 'POST', '/insights/kpis/production.scrap_rate/versions', { basedOnId: scrap.id, changeNote: 'Scrap over the scrap only (made up).', measureKeys: ['production.scrap_pieces'] }, 201)
    expect(await no('owner', 'POST', `/insights/kpis/versions/${other.id}/activate`, { version: 1 }, 409)).toEqual(['refusal/MEASURES_DIFFER'])
    await ok('owner', 'DELETE', `/insights/kpis/versions/${other.id}?version=1`)
    expect(await no('owner', 'POST', '/insights/kpis/production.output/versions', { basedOnId: scrap.id, changeNote: 'x' }, 409)).toEqual(['refusal/BASED_ON_OTHER_KPI'])
    expect(await no('owner', 'POST', '/insights/kpis/production.scrap_rate/versions', { basedOnId: scrap.id, changeNote: 'x', measureKeys: ['production.nope'] }, 400)).toEqual(['body/measureKeys'])
    expect(await no('owner', 'POST', '/insights/kpis/production.scrap_rate/versions', { basedOnId: scrap.id, changeNote: 'x', ownerRoleId: newId() }, 400)).toEqual(['body/ownerRoleId'])
    const otif = (await ok('owner', 'GET', '/insights/kpis/delivery.otif')).versions.find((version: Json) => version.state === 'DRAFT')
    // The seeded draft reads the facts B-W2b-429 builds: it can be put in force now (an unknown measure: the unit test).
    expect(await ok('owner', 'POST', `/insights/kpis/versions/${otif.id}/activate`, { version: otif.version })).toMatchObject({ kpiVersion: 3 })
    expect((await call('planner', 'POST', '/insights/kpis/production.scrap_rate/versions', { basedOnId: scrap.id, changeNote: 'x' })).status).toBe(403)
  })

  it('withdraws a KPI with its uses; then nothing is in force to withdraw', async () => {
    const lines = await ok('owner', 'GET', '/insights/kpis/sales.order_lines_in')
    const retired = await ok('owner', 'POST', '/insights/kpis/sales.order_lines_in/retire', { version: lines.versions[0].version })
    // B-W2b-434: three dashboards read it (owner-group as a stand-in, sales, finance): their uses go with it.
    expect(retired).toMatchObject({ kpiVersion: 1, usesRemoved: 3 })
    expect((await ok('owner', 'GET', '/insights/kpis/sales.order_lines_in')).versions[0]).toMatchObject({ state: 'RETIRED', endedBy: 'Made-up owner' })
    expect(await no('owner', 'POST', '/insights/kpis/sales.order_lines_in/retire', { version: 1 }, 409)).toEqual(['refusal/NOT_IN_FORCE'])
  })
})

describe('one calculation for every reader (ANA-070)', () => {
  it('gives Today’s key numbers the same values as the KPI library', async () => {
    const numbers = await ok('owner', 'GET', '/home/numbers')
    const number = (key: string): Json => (numbers.lenses as Json[]).flatMap((lens) => lens.numbers as Json[]).find((entry) => entry.key === key)!
    const orders = await ok('owner', 'GET', '/insights/kpis/sales.orders_in/value?period=WEEK&periods=8')
    expect(number('orders.inThisWeek')).toMatchObject({ value: orders.value === null ? null : Number(orders.value), problem: null })
    expect(number('orders.inThisWeek').spark).toEqual((orders.periods as Json[]).map((period) => (period.value === null ? null : Number(period.value))))
    expect(orders).toMatchObject({ unit: 'MONEY', grain: 'PRICE', period: { kind: 'WEEK' }, currency: 'EUR', live: false, stale: false })
    expect(number('production.goodLastDay').problem).toBeNull()
    expect(number('orders.shippedOnTime').problem).not.toBe('UNAVAILABLE')
  })

  it('reads a value in my scope: no money without its grain, a customer-limited person live on their own orders, by site and line', async () => {
    const planner = templateOf('planner')!
    const margin = await ok('planner', 'GET', '/insights/kpis/sales.order_margin/value')
    if (!planner.permissions.includes('costing.view')) expect(margin).toMatchObject({ value: null, problem: 'NO_ACCESS' })
    else if (!planner.grains.includes('margin')) expect(margin).toMatchObject({ value: null, problem: 'NEEDS_GRAIN' })
    const anchor = (await admin<{ day: string }>(`SELECT to_char(max("orderDate"), 'YYYY-MM-DD') AS day FROM "SalesOrder" WHERE "partyId" = $1 AND status <> 'CANCELLED' AND "orderDate" <= now()`, [partyNarrow]))[0]!.day
    const narrow = await ok('narrow', 'GET', `/insights/kpis/sales.orders_in/value?period=MONTH&periods=1&day=${anchor}`)
    const expected = (await admin<{ total: string | null }>(
      `SELECT sum("netAmount")::text AS total FROM "SalesOrder" WHERE "partyId" = $1 AND status <> 'CANCELLED' AND date_trunc('month', "orderDate") = date_trunc('month', $2::date) AND "orderDate" <= $3::date`,
      [partyNarrow, anchor, today()],
    ))[0]!.total
    expect(narrow).toMatchObject({ live: true, value: expected ?? '0' })
    const all = await ok('sales', 'GET', `/insights/kpis/sales.orders_in/value?period=MONTH&periods=1&day=${anchor}`)
    expect(all.live).toBe(false)
    expect(Number(all.value)).toBeGreaterThanOrEqual(Number(narrow.value))
    const fiscal = await call('owner', 'GET', '/insights/kpis/sales.orders_in/value?period=FISCAL_YEAR')
    expect(fiscal.status).toBe(400)
    expect((await ok('owner', 'GET', `/insights/kpis/sales.orders_in/value?period=FISCAL_YEAR&companyId=${companyA}&periods=1`)).period.key).toMatch(/^FY\d{4}$/)
    expect((await call('owner', 'GET', '/insights/kpis/nothing.here/value')).status).toBe(404)
    const wip = await ok('production', 'GET', '/insights/kpis/production.wip_value/value')
    expect(wip.problem === 'NO_ACCESS' || wip.problem === 'NEEDS_GRAIN' || wip.problem === null).toBe(true)
  })
})

describe('the facts kept fresh (ANA-069)', () => {
  it('rebuilds a company’s day after an event (quiet for 5 minutes after a rebuild), and every tenant by the hour', async () => {
    const caller = callerFor(h.database, systemContext(T, `k428-${run}`))
    const envelope = (type: string) =>
      eventEnvelope.parse({ eventId: newId(), type, version: 1, context: 'inventory', tenantId: T, companyId: companyA, siteId: null, subject: companyA, correlationId: newId(), causationId: null, source: 'test', occurredAt: new Date().toISOString(), payload: {} })
    // Just rebuilt: the event waits for the hour's rebuild.
    const before = await factsOf('receipts.lines', `AND "companyId" = '${companyA}' AND day = '${today()}'::date`)
    await factsHandler().handle(envelope('inventory.receipt_posted') as never, { caller, attempt: 1 })
    expect((await factsOf('receipts.lines', `AND "companyId" = '${companyA}' AND day = '${today()}'::date`)).map((row) => row.rebuiltAt.getTime())).toEqual(before.map((row) => row.rebuiltAt.getTime()))
    // Today's receipts facts gone (a rebuild deletes and writes): the event rebuilds them.
    await admin(`DELETE FROM "FactDaily" WHERE "tenantId" = $1 AND "companyId" = $2 AND "measureKey" = 'receipts.lines' AND day = $3::date`, [T, companyA, today()])
    await factsHandler().handle(envelope('inventory.receipt_posted') as never, { caller, attempt: 1 })
    expect((await factsOf('receipts.lines', `AND "companyId" = '${companyA}' AND day = '${today()}'::date`)).length).toBe(before.length)
    const hourly = await rebuildAllTenants({ database: h.database, log: { info: () => {}, warn: () => {}, error: () => {} } }, 'HOURLY', { back: 1, skip: 0 })
    expect(hourly.failed).toBe(0)
    expect(hourly.companies).toBeGreaterThanOrEqual(2)
  })
})
