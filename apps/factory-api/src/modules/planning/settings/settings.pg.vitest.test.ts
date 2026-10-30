import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCalendar } from '../../../../../../packages/factory-db/seed/calendar'
import { seed as seedPlanning } from '../../../../../../packages/factory-db/seed/planning'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'

/**
 * Planning settings (B-W2a-16; PLN-003 horizon and buckets, PLN-005 item parameters, PLN-099 reorder rules, PLN-014
 * line efficiency, PLN-115 people and units per lane) through the app's real routes on a throwaway PostgreSQL 17 database
 * from the migrations (the runtime login: row-level security is real), with the factory-db seeds' made-up tenant (its
 * calendars and its planning seed: A1's settings, item parameters and capacity). Run with
 * `node scripts/factory/run-pg-tests.mjs modules/planning`.
 */

const NS = 'w2a16-settings'
const idOf = (key: string) => seedUuid(NS, key)
const firstId = (key: string) => `00000000${idOf(key).slice(8)}`
const T = idOf('tenant')
const OTHER = newId()
const user = newId()
const companyB = idOf('company:B')
const siteA1 = idOf('site:A1')
const siteB1 = idOf('site:B1')
const lineA1 = idOf('site:A1:line:L1')
const cutB1 = idOf('site:B1:work-centre:CUT')
const item = { leather: idOf('product:item:leather'), lining: idOf('product:item:lining'), protector: idOf('product:item:protector') }
const red = idOf('product:item-colour:leather:RED')
const P1 = idOf('party:P1')
const P2 = idOf('party:P2')

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const grant = (permissions: Grant['permissions'], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const KEEP = ['planning.view', 'planning.settings.manage', 'planning.items.manage'] as const
const SESSIONS: Record<string, SessionContext> = {
  planner: { audience: 'office', tenantId: T, actorId: user, grants: [grant(KEEP)] },
  viewer: { audience: 'office', tenantId: T, actorId: user, grants: [grant(['planning.view'])] },
  // A buyer keeps item parameters, not the site's settings or the lanes.
  buyer: { audience: 'office', tenantId: T, actorId: user, grants: [grant(['planning.view', 'planning.items.manage'])] },
  // A planner of company B only: A1 is not found.
  plannerB: { audience: 'office', tenantId: T, actorId: user, grants: [grant(KEEP, { companies: [companyB], sites: 'all' })] },
  nobody: { audience: 'office', tenantId: T, actorId: user, grants: [grant(['sites.view'])] },
  other: { audience: 'office', tenantId: OTHER, actorId: user, grants: [grant(KEEP)] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(sql, values)).rows as Row[]
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const issuePaths = async (response: Promise<{ statusCode: number; json(): Json }>, status = 400) => {
  const answer = await response
  expect(answer.statusCode).toBe(status)
  return (answer.json().error.issues ?? []).map((issue: Json) => issue.path)
}
const events = (type: string) => admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [T, type])

beforeAll(async () => {
  db = await migratedDatabase('planning_settings')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedCalendar({ db: database, namespace: NS })
  await seedPlanning({ db: database, namespace: NS })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [OTHER, 'w2a16-other'])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('horizon and buckets (PLN-003)', () => {
  it("lists every site with its settings, the defaults said where a site has none", async () => {
    const { sites } = await ok('planner', 'GET', '/planning/settings')
    const a1 = sites.find((row: Json) => row.site.id === siteA1)
    const b1 = sites.find((row: Json) => row.site.id === siteB1)
    expect(a1.settings).toMatchObject({ horizonWeeks: 26, dayBucketWeeks: 2, weekBucketWeeks: 13, defaultEfficiencyPct: '85.00', scheduledRunTime: '02:00', isDefault: false, version: 1 })
    expect(b1.settings).toEqual({ horizonWeeks: 26, dayBucketWeeks: 2, weekBucketWeeks: 13, defaultEfficiencyPct: '100.00', scheduledRunTime: null, isDefault: true, version: null, updatedAt: null })
    expect((await ok('plannerB', 'GET', '/planning/settings')).sites.map((row: Json) => row.site.id)).toEqual([siteB1])
    expect((await ok('other', 'GET', '/planning/settings')).sites).toEqual([])
  })

  it("gives the plan's buckets from today: days, weeks, then months to the horizon, with no gap", async () => {
    const { horizon } = await ok('viewer', 'GET', `/planning/settings/${siteA1}`)
    const kinds = horizon.buckets.map((bucket: Json) => bucket.kind)
    expect([kinds[0], kinds.at(-1), kinds.filter((kind: string) => kind === 'WEEK').length]).toEqual(['DAY', 'MONTH', 11])
    expect(horizon.buckets[0].from).toBe(horizon.from)
    expect(horizon.buckets.at(-1).to).toBe(horizon.to)
    for (let index = 1; index < horizon.buckets.length; index++) {
      expect(Date.parse(`${horizon.buckets[index - 1].to}T00:00:00Z`) + 86_400_000).toBe(Date.parse(`${horizon.buckets[index].from}T00:00:00Z`))
    }
  })

  it('saves the first settings of a site in one command, then changes them at the version read', async () => {
    const first = await ok('planner', 'PATCH', `/planning/settings/${siteB1}`, { horizonWeeks: 20, dayBucketWeeks: 1, weekBucketWeeks: 8, defaultEfficiencyPct: '90', scheduledRunTime: '03:30' }, 200, 'settings-b1-key-0001')
    expect(first.settings).toMatchObject({ horizonWeeks: 20, dayBucketWeeks: 1, weekBucketWeeks: 8, defaultEfficiencyPct: '90.00', scheduledRunTime: '03:30', isDefault: false, version: 1 })
    expect(first.changed).toEqual(['horizonWeeks', 'dayBucketWeeks', 'weekBucketWeeks', 'defaultEfficiencyPct', 'scheduledRunTime'])
    expect(first.horizon.buckets.filter((bucket: Json) => bucket.kind === 'WEEK')).toHaveLength(7)
    // The same key and request: the stored answer.
    expect(await ok('planner', 'PATCH', `/planning/settings/${siteB1}`, { horizonWeeks: 20, dayBucketWeeks: 1, weekBucketWeeks: 8, defaultEfficiencyPct: '90', scheduledRunTime: '03:30' }, 200, 'settings-b1-key-0001')).toEqual(first)
    const second = await ok('planner', 'PATCH', `/planning/settings/${siteB1}`, { version: 1, scheduledRunTime: null })
    expect([second.settings.scheduledRunTime, second.settings.version, second.changed]).toEqual([null, 2, ['scheduledRunTime']])
    // The same values again: nothing written.
    expect((await ok('planner', 'PATCH', `/planning/settings/${siteB1}`, { version: 2, horizonWeeks: 20 })).changed).toEqual([])
    expect((await call('planner', 'PATCH', `/planning/settings/${siteB1}`, { version: 1, horizonWeeks: 21 })).statusCode).toBe(409)
    const audit = await admin('SELECT action, before, after FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id', [siteB1])
    expect(audit.filter((row) => row.action === 'planning.editSettings').map((row) => [row.before?.scheduledRunTime ?? 'none', row.after.scheduledRunTime])).toEqual([
      ['none', '03:30'],
      ['03:30', null],
    ])
    expect((await events('planning.settings_changed')).map((row) => row.payload)).toEqual([
      { siteId: siteB1, created: true, changed: ['horizonWeeks', 'dayBucketWeeks', 'weekBucketWeeks', 'defaultEfficiencyPct', 'scheduledRunTime'] },
      { siteId: siteB1, created: false, changed: ['scheduledRunTime'] },
    ])
  })

  it('refuses buckets outside the horizon, a bad efficiency or run time, and anyone who may not keep them', async () => {
    expect(await issuePaths(call('planner', 'PATCH', `/planning/settings/${siteA1}`, { version: 1, horizonWeeks: 10 }))).toEqual(['body/weekBucketWeeks'])
    expect(await issuePaths(call('planner', 'PATCH', `/planning/settings/${siteA1}`, { version: 1, dayBucketWeeks: 14 }))).toEqual(['body/dayBucketWeeks'])
    expect(await issuePaths(call('planner', 'PATCH', `/planning/settings/${siteA1}`, { version: 1, defaultEfficiencyPct: '250', scheduledRunTime: '25:00' }))).toEqual(['body/defaultEfficiencyPct', 'body/scheduledRunTime'])
    expect((await call('viewer', 'PATCH', `/planning/settings/${siteA1}`, { version: 1, horizonWeeks: 30 })).statusCode).toBe(403)
    expect((await call('buyer', 'PATCH', `/planning/settings/${siteA1}`, { version: 1, horizonWeeks: 30 })).statusCode).toBe(403)
    expect((await call('plannerB', 'GET', `/planning/settings/${siteA1}`)).statusCode).toBe(404)
    expect((await call('other', 'PATCH', `/planning/settings/${siteA1}`, { horizonWeeks: 30 })).statusCode).toBe(404)
    expect((await call('nobody', 'GET', `/planning/settings/${siteA1}`)).statusCode).toBe(403)
    expect((await ok('viewer', 'GET', `/planning/settings/${siteA1}`)).settings.version).toBe(1)
  })
})

describe('item parameters and reorder rules (PLN-005, PLN-099)', () => {
  it("lists the site's items with their own terms and the site's rows; filters by method and by having rows", async () => {
    const all = await ok('viewer', 'GET', `/planning/item-parameters?siteId=${siteA1}&limit=200`)
    const byCode = new Map(all.items.map((row: Json) => [row.item.code, row]))
    const leather = byCode.get('SEED-LEA-100') as Json
    expect(leather.defaults).toMatchObject({ sourcing: 'BUY', supplier: { id: P2 }, leadTimeDays: 14, minOrderQty: '5.0000' })
    expect(leather.item.colours.map((colour: Json) => colour.code)).toEqual(['BLK', 'RED'])
    expect(leather.parameters).toEqual([expect.objectContaining({ colour: null, method: 'ORDERS', source: 'BUY', supplier: { id: P2, code: expect.any(String), name: expect.any(String) }, safetyLeadTimeDays: 2 })])
    expect((byCode.get('SEED-LIN-200') as Json).parameters[0]).toMatchObject({ method: 'MIN_MAX', colour: { code: 'GRY' }, minStock: '50.0000', maxStock: '300.0000', orderMultiple: '50.0000', item: { baseUom: 'M' } })
    expect((await ok('viewer', 'GET', `/planning/item-parameters?siteId=${siteA1}&method=REORDER_POINT`)).items.map((row: Json) => row.item.code)).toEqual(['SEED-PRO-300'])
    const unplanned = await ok('viewer', 'GET', `/planning/item-parameters?siteId=${siteA1}&configured=false&limit=200`)
    expect(unplanned.items.every((row: Json) => row.parameters.length === 0)).toBe(true)
    expect(unplanned.items.map((row: Json) => row.item.code)).not.toContain('SEED-LEA-100')
    // Paging by code, a cursor at a time.
    const page = await ok('viewer', 'GET', `/planning/item-parameters?siteId=${siteA1}&limit=1`)
    const next = await ok('viewer', 'GET', `/planning/item-parameters?siteId=${siteA1}&limit=1&cursor=${page.nextCursor}`)
    expect([page.items.length, next.items[0].item.code > page.items[0].item.code]).toEqual([1, true])
    // The reorder rules grid: the site's reorder-point and min/max rows.
    expect((await ok('viewer', 'GET', `/planning/reorder-rules?siteId=${siteA1}`)).rules.map((rule: Json) => [rule.item.code, rule.method])).toEqual([
      ['SEED-LIN-200', 'MIN_MAX'],
      ['SEED-PRO-300', 'REORDER_POINT'],
    ])
  })

  it('sets a colour its own reorder point (one row per site, item and colour), changes it, and removes it', async () => {
    const made = await ok('buyer', 'POST', '/planning/item-parameters', { siteId: siteA1, itemId: item.leather, itemColourId: red, method: 'REORDER_POINT', reorderPoint: '100', lotSize: '210', source: 'BUY', supplierId: P2, safetyStock: '20' }, 201, 'item-red-key-0001')
    expect(made.parameters).toMatchObject({ colour: { id: red, code: 'RED' }, method: 'REORDER_POINT', reorderPoint: '100.0000', lotSize: '210.0000', safetyStock: '20.0000', version: 1 })
    expect(await ok('buyer', 'POST', '/planning/item-parameters', { siteId: siteA1, itemId: item.leather, itemColourId: red, method: 'REORDER_POINT', reorderPoint: '100', lotSize: '210', source: 'BUY', supplierId: P2, safetyStock: '20' }, 201, 'item-red-key-0001')).toEqual(made)
    const twice = await call('buyer', 'POST', '/planning/item-parameters', { siteId: siteA1, itemId: item.leather, itemColourId: red, method: 'ORDERS' })
    expect([twice.statusCode, twice.json().error.message]).toEqual([409, expect.stringContaining(made.parameters.id)])
    // Switching to min/max clears the reorder point and lot size it does not name, and says so.
    const edited = await ok('buyer', 'PATCH', `/planning/item-parameters/${made.parameters.id}`, { version: 1, method: 'MIN_MAX', minStock: '50', maxStock: '400' })
    expect([edited.parameters.method, edited.parameters.reorderPoint, edited.parameters.lotSize, edited.parameters.maxStock, edited.parameters.version, edited.cleared]).toEqual(['MIN_MAX', null, null, '400.0000', 2, ['reorderPoint', 'lotSize']])
    expect((await call('buyer', 'PATCH', `/planning/item-parameters/${made.parameters.id}`, { version: 1, safetyStock: '30' })).statusCode).toBe(409)
    expect((await ok('viewer', 'GET', `/planning/item-parameters/${made.parameters.id}`)).parameters.method).toBe('MIN_MAX')
    expect((await ok('viewer', 'GET', `/planning/reorder-rules?siteId=${siteA1}`)).rules.map((rule: Json) => rule.id)).toContain(made.parameters.id)
    expect(await ok('buyer', 'POST', `/planning/item-parameters/${made.parameters.id}/delete`, { version: 2 })).toEqual({ deleted: made.parameters.id, siteId: siteA1, itemId: item.leather })
    expect((await call('viewer', 'GET', `/planning/item-parameters/${made.parameters.id}`)).statusCode).toBe(404)
    expect((await events('planning.item_parameters_changed')).map((row) => [row.payload.change, row.payload.method, row.payload.itemColourId])).toEqual([
      ['CREATED', 'REORDER_POINT', red],
      ['EDITED', 'MIN_MAX', red],
      ['DELETED', 'MIN_MAX', red],
    ])
    const audit = await admin('SELECT action FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id', [made.parameters.id])
    expect(audit.map((row) => row.action)).toEqual(['planning.createItemParameters', 'planning.editItemParameters', 'planning.deleteItemParameters'])
  })

  it('refuses in words what the method, the source or the facts do not allow', async () => {
    const body = { siteId: siteB1, itemId: item.protector }
    expect(await issuePaths(call('buyer', 'POST', '/planning/item-parameters', { ...body, method: 'REORDER_POINT', reorderPoint: '24' }))).toEqual(['body/lotSize'])
    expect(await issuePaths(call('buyer', 'POST', '/planning/item-parameters', { ...body, method: 'MIN_MAX', minStock: '50', maxStock: '40', lotSize: '12' }))).toEqual(['body/maxStock', 'body/lotSize'])
    expect(await issuePaths(call('buyer', 'POST', '/planning/item-parameters', { ...body, supplierId: P2 }))).toEqual(['body/supplierId'])
    // A customer is no supplier; the make site is a plant of the company (B1 is company B's).
    expect(await issuePaths(call('buyer', 'POST', '/planning/item-parameters', { ...body, source: 'BUY', supplierId: P1 }))).toEqual(['body/supplierId'])
    expect(await issuePaths(call('buyer', 'POST', '/planning/item-parameters', { siteId: siteA1, itemId: item.protector, itemColourId: red, method: 'ORDERS' }))).toEqual(['body/itemColourId'])
    expect(await issuePaths(call('buyer', 'POST', '/planning/item-parameters', { siteId: siteA1, itemId: item.lining, source: 'MAKE', makeSiteId: siteB1 }))).toEqual(['body/makeSiteId'])
    expect(await issuePaths(call('buyer', 'POST', '/planning/item-parameters', { ...body, buyLeadTimeDays: 400, safetyStock: '-1' }))).toEqual(['body/buyLeadTimeDays', 'body/safetyStock'])
    expect((await call('viewer', 'POST', '/planning/item-parameters', { ...body, method: 'ORDERS' })).statusCode).toBe(403)
    expect((await call('plannerB', 'POST', '/planning/item-parameters', { siteId: siteA1, itemId: item.protector })).statusCode).toBe(404)
    const lining = firstId('planning:item:A1:lining:GRY')
    expect((await call('plannerB', 'PATCH', `/planning/item-parameters/${lining}`, { version: 1, safetyStock: '5' })).statusCode).toBe(404)
    expect((await call('other', 'GET', `/planning/item-parameters/${lining}`)).statusCode).toBe(404)
    // A make site of the same company, made at B1 for B1 itself: fine.
    const made = await ok('plannerB', 'POST', '/planning/item-parameters', { ...body, source: 'MAKE', makeSiteId: siteB1, makeLeadTimeDays: 5 }, 201)
    expect(made.parameters).toMatchObject({ source: 'MAKE', makeSite: { id: siteB1 }, makeLeadTimeDays: 5 })
  })
})

describe('lanes: line efficiency and people, work-centre units (PLN-014, PLN-115)', () => {
  it("shows each lane's planned efficiency and people, or what applies without (the site's default, the stations)", async () => {
    const lanes = await ok('viewer', 'GET', `/planning/lanes?siteId=${siteA1}`)
    expect([lanes.defaultEfficiencyPct, lanes.defaultEfficiencySource]).toEqual(['85.00', 'SITE'])
    expect(lanes.lines).toEqual([
      expect.objectContaining({ kind: 'LINE', id: lineA1, code: 'L1', stations: 2, capacity: expect.objectContaining({ plannedEfficiencyPct: '85.00', people: 8 }), effective: { efficiencyPct: '85.00', efficiencySource: 'LANE', people: 8, peopleSource: 'CAPACITY' } }),
    ])
    // The last four whole weeks, oldest first: available = 8 people × the line's working minutes (two shifts, 930 a day).
    expect(lanes.lines[0].actual).toHaveLength(4)
    for (const week of lanes.lines[0].actual) expect(week).toMatchObject({ earnedMinutes: expect.any(String), availableMinutes: expect.any(String) })
    expect(lanes.workCentres.map((lane: Json) => [lane.code, lane.workCentreKind, lane.effective.people, lane.effective.efficiencyPct])).toEqual([
      ['CUT', 'CUTTING', 2, '90.00'],
      ['PACK', 'PACKING', 1, '100.00'],
      ['QC', 'INSPECTION', 1, '100.00'],
      ['SEW', 'SEWING', 8, '85.00'],
    ])
    expect(lanes.workCentres.every((lane: Json) => lane.actual === null)).toBe(true)
    // B1 had settings saved above (90 %): its work centres have no row of their own.
    const b1 = await ok('viewer', 'GET', `/planning/lanes?siteId=${siteB1}`)
    expect(b1.workCentres.find((lane: Json) => lane.code === 'CUT').effective).toEqual({ efficiencyPct: '90.00', efficiencySource: 'SITE', people: 1, peopleSource: 'STATIONS' })
  })

  it("keeps a lane's efficiency and people: made at the first save, changed at its version; per lane, never per person", async () => {
    const madeCut = await ok('planner', 'PATCH', `/planning/work-centres/${cutB1}/capacity`, { units: 3 }, 200, 'cut-b1-key-0001')
    expect([madeCut.lane.capacity, madeCut.lane.effective, madeCut.changed]).toEqual([
      expect.objectContaining({ plannedEfficiencyPct: '90.00', people: 3, version: 1 }),
      { efficiencyPct: '90.00', efficiencySource: 'LANE', people: 3, peopleSource: 'CAPACITY' },
      ['plannedEfficiencyPct', 'people'],
    ])
    const line = await ok('planner', 'PATCH', `/planning/lines/${lineA1}/capacity`, { version: 1, plannedEfficiencyPct: '92.5', operators: null, note: 'Two new machines' })
    expect([line.lane.effective, line.changed]).toEqual([{ efficiencyPct: '92.50', efficiencySource: 'LANE', people: 2, peopleSource: 'STATIONS' }, ['plannedEfficiencyPct', 'people', 'note']])
    expect((await ok('planner', 'PATCH', `/planning/lines/${lineA1}/capacity`, { version: 2, plannedEfficiencyPct: '92.50' })).changed).toEqual([])
    expect((await call('planner', 'PATCH', `/planning/lines/${lineA1}/capacity`, { version: 1, operators: 9 })).statusCode).toBe(409)
    expect(await issuePaths(call('planner', 'PATCH', `/planning/lines/${lineA1}/capacity`, { version: 2, plannedEfficiencyPct: '201' }))).toEqual(['body/plannedEfficiencyPct'])
    expect((await call('planner', 'PATCH', `/planning/lines/${lineA1}/capacity`, { version: 2, operators: 0 })).statusCode).toBe(400)
    expect((await call('buyer', 'PATCH', `/planning/lines/${lineA1}/capacity`, { version: 2, operators: 9 })).statusCode).toBe(403)
    expect((await call('plannerB', 'PATCH', `/planning/lines/${lineA1}/capacity`, { version: 2, operators: 9 })).statusCode).toBe(404)
    expect((await call('planner', 'PATCH', `/planning/lines/${newId()}/capacity`, { operators: 9 })).statusCode).toBe(404)
    expect((await events('planning.capacity_changed')).map((row) => row.payload)).toEqual([
      { siteId: siteB1, laneKind: 'WORK_CENTRE', laneId: cutB1, change: 'CREATED', changed: ['plannedEfficiencyPct', 'people'] },
      { siteId: siteA1, laneKind: 'LINE', laneId: lineA1, change: 'EDITED', changed: ['plannedEfficiencyPct', 'people', 'note'] },
    ])
    const [audit] = await admin('SELECT action, before, after FROM "AuditLog" WHERE "recordId" = $1 AND action = $2', [lineA1, 'planning.editLineCapacity'])
    expect([audit!.before, audit!.after]).toEqual([
      expect.objectContaining({ plannedEfficiencyPct: '85.00', operators: 8 }),
      { plannedEfficiencyPct: '92.50', operators: null, note: 'Two new machines' },
    ])
    // Nothing here names a person: the lanes read has no worker, user or name of one.
    const lanes = JSON.stringify(await ok('viewer', 'GET', `/planning/lanes?siteId=${siteA1}`))
    expect(lanes).not.toMatch(/worker|displayName|actorId|createdById/i)
  })
})
