import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { daysFrom } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * The planning rules per item (B-W2b-318; PLN-006 lot sizing, PLN-008 plan by style, colour or size, PLN-081 scrap and
 * yield, PLN-082 calculated delays, PLN-084 the item's requirement profile, PLN-088 scarce material by priority, and
 * PLN-068's size-run setting) on the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security, grants and the …_planning_depth_w2b_guards triggers are real), the
 * factory-db seeds up to production (W1's planning seeds: SEED-SO-0002 BLK 1/2/1 RED 1/1/1 for 4 Dec on WO-0001 and the
 * DRAFT WO-0002, SEED-SO-0001 BLK 2/4/2 RED 1/2/1 for 18 Dec; black leather 553.28 ft² gross, 51.8 usable, 315 on
 * SEED-PO-0001), SEED-JKT-01's revision released. No assertion rests on today being before or after a seeded day.
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/planning/lot-sizing/`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = 'rules-a'
const idOf = (key: string) => seedUuid(ns, key)
const A = {
  tenant: idOf('tenant'),
  actor: idOf('actor'),
  companyA: idOf('company:A'),
  siteA1: idOf('site:A1'),
  leather: idOf('product:item:leather'),
  leatherBLK: idOf('product:item-colour:leather:BLK'),
  jkt01: idOf('product:style:JKT-01'),
  jkt01Rev: idOf('product:revision:JKT-01:1'),
  so1: idOf('sales:SO1'),
}

const VIEW: Permission[] = ['planning.view']
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  planner: office([...VIEW, 'planning.run', 'planning.items.manage', 'planning.strategy.manage', 'planning.settings.manage']),
  // The buyer keeps what it buys by (planning.items.manage), not how garments are planned (no planning.strategy.manage).
  buyer: office([...VIEW, 'planning.items.manage']),
  viewer: office(VIEW),
  floor: { audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: idOf('site:A1'), deviceId: newId(), grants: [grant(['floor.work', 'planning.view'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `rules-test-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, idempotencyKey?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, idempotencyKey?: string): Promise<Json> {
  const response = await call(session, method, url, payload, idempotencyKey)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const runPlan = () => ok('planner', 'POST', '/planning/runs', { siteId: A.siteA1 }, 201, key())
const latest = () => ok('planner', 'GET', `/planning/runs/latest?siteId=${A.siteA1}`)
const black = async (): Promise<Json> => (await latest()).lines.find((entry: Json) => entry.item.id === A.leather && entry.colour?.id === A.leatherBLK)
const profileUrl = `/planning/item-profile?siteId=${A.siteA1}&itemId=${A.leather}&itemColourId=${A.leatherBLK}`
const sum = (values: readonly string[]) => values.reduce((total, value) => total + Math.round(Number(value) * 10_000), 0) / 10_000
let leatherRow: Json

beforeAll(async () => {
  db = await migratedDatabase('planning_rules')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  // SEED-JKT-01's revision released: SEED-SO-0001 is planned too (and proposed as planned work orders).
  await admin(`UPDATE "Style" SET status = 'ACTIVE' WHERE id = $1`, [A.jkt01])
  await admin(`UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2 WHERE id = $1`, [A.jkt01Rev, A.actor])
  // SEED-JKT-01's black SKUs as finished garments (made up), so a plan level can be set on them.
  for (const size of ['48', '50', '52', '54', '56']) {
    await admin(
      `INSERT INTO "Item" (id, "tenantId", code, name, "nameI18n", kind, sourcing, tracking, "baseUom", "purchaseUom", "consumptionUom", "variantId")
       SELECT $1, $2, $3, $3, jsonb_build_object('en', $3::text, 'it', $3::text), 'FINISHED', 'MAKE', 'NONE', 'PCS', 'PCS', 'PCS', v.id FROM "Variant" v WHERE v.id = $4`,
      [idOf(`rules:item:JKT-01-BLK-${size}`), A.tenant, `T-JKT-01-BLK-${size}`, idOf(`product:variant:JKT-01:BLK:${size}`)],
    )
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 480_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the rules per item on the item parameters (PLN-006, PLN-008, PLN-081, PLN-082)', { timeout: 90_000 }, () => {
  it('keeps lot sizing, scrap and yield and the delay days with W2a’s fields, in words; refuses what breaks a rule', async () => {
    const created = await ok('buyer', 'POST', '/planning/item-parameters', { siteId: A.siteA1, itemId: A.leather, itemColourId: A.leatherBLK, lotSizing: 'FIXED', fixedLotQty: '105', scrapPct: '5', delayDays: 2 }, 201, key())
    leatherRow = created.parameters
    expect(leatherRow).toMatchObject({ method: 'ORDERS', lotSizing: 'FIXED', fixedLotQty: '105.0000', lotPeriodDays: null, planLevel: null, scrapPct: '5.00', yieldPct: null, delayDays: 2, version: 1 })
    expect(leatherRow.rules).toMatchObject({ lotSizing: 'Each order brings 105 FT2, as many as the need takes.', planLevel: null, delay: expect.stringMatching(/^2 days between arrival and use/) })
    expect(leatherRow.rules.scrapYield).toMatch(/multiplied by 1\.05 \(5 % scrap\)/)
    // Refused in words, with the field.
    const fixedAlone = await refused('buyer', 'PATCH', `/planning/item-parameters/${leatherRow.id}`, { version: 1, lotSizing: 'PERIOD' }, 400)
    expect(fixedAlone.issues.map((issue: Json) => issue.path)).toEqual(['body/lotPeriodDays'])
    const level = await refused('planner', 'PATCH', `/planning/item-parameters/${leatherRow.id}`, { version: 1, planLevel: 'SKU' }, 400)
    expect(level.message).toBe('Only a finished garment or a component is planned by style, colour or size; a material is planned per colour.')
    await refused('buyer', 'PATCH', `/planning/item-parameters/${leatherRow.id}`, { version: 1, yieldPct: '0' }, 400)
    await refused('viewer', 'PATCH', `/planning/item-parameters/${leatherRow.id}`, { version: 1, delayDays: 3 }, 403)
    // The audit row and the event carry the change.
    const audit = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id`, [leatherRow.id])
    expect(audit.at(-1)!.after).toMatchObject({ lotSizing: 'FIXED', fixedLotQty: '105.0000', scrapPct: '5.00', delayDays: 2 })
    const events = await admin(`SELECT type, payload FROM "OutboxEvent" WHERE subject = $1`, [leatherRow.id])
    expect(events.map((event) => [event.type, event.payload.change])).toEqual([['planning.item_parameters_changed', 'CREATED']])
  })

  it('a plan level is how garments are planned: a finished garment only, with planning.strategy.manage too', async () => {
    const item = idOf('rules:item:JKT-01-BLK-52')
    const error = await refused('buyer', 'POST', '/planning/item-parameters', { siteId: A.siteA1, itemId: item, planLevel: 'SKU' }, 403)
    expect(error.code).toBe('forbidden')
    const created = await ok('planner', 'POST', '/planning/item-parameters', { siteId: A.siteA1, itemId: item, planLevel: 'SKU' }, 201, key())
    expect(created.parameters).toMatchObject({ planLevel: 'SKU', lotSizing: 'LOT_FOR_LOT', rules: { planLevel: 'Each size is a planned work order of its own.' } })
    // The buyer may still change what it buys by on that row, never its level.
    await ok('buyer', 'PATCH', `/planning/item-parameters/${created.parameters.id}`, { version: created.parameters.version, note: 'made-up note' })
  })
})

describe('the size-run setting (PLN-068; B-W2b-293’s gap)', { timeout: 60_000 }, () => {
  it('PATCH /planning/settings/:siteId keeps the rule and the groups; refused in words; one grid clears them', async () => {
    const groups = await ok('planner', 'PATCH', `/planning/settings/${A.siteA1}`, { sizeRunRule: 'SIZE_GROUPS', sizeGroups: [['48', '50'], ['52', '54', '56']] }, 200, key())
    expect(groups.settings).toMatchObject({ sizeRunRule: 'SIZE_GROUPS', sizeGroups: [['48', '50'], ['52', '54', '56']] })
    expect(groups.changed).toEqual(expect.arrayContaining(['sizeRunRule', 'sizeGroups']))
    const twice = await refused('planner', 'PATCH', `/planning/settings/${A.siteA1}`, { version: groups.settings.version, sizeGroups: [['48', '50'], ['50']] }, 400)
    expect(twice.message).toBe('Size 50 is in two groups: a size is in one group only.')
    await refused('buyer', 'PATCH', `/planning/settings/${A.siteA1}`, { version: groups.settings.version, sizeRunRule: 'ONE_GRID' }, 403)
    expect((await ok('viewer', 'GET', `/planning/settings/${A.siteA1}`)).settings).toMatchObject({ sizeRunRule: 'SIZE_GROUPS' })
  })
})

describe('the run by the rules (PLN-006, PLN-081, PLN-008)', { timeout: 120_000 }, () => {
  it('scrap multiplies the need; FIXED lots size the suggestion; SKU splits the black jacket by size, the red by the site’s groups', async () => {
    await runPlan()
    const line = await black()
    // What the garments take × 1.05, less what is already issued to WO-0001 (53.2 ft², not scaled): (553.28 + 53.2) × 1.05
    // − 53.2 = 583.604, each order line and size rounded up once.
    expect(Number(line.grossQuantity)).toBeGreaterThanOrEqual(583.604)
    expect(Number(line.grossQuantity)).toBeLessThan(583.8)
    expect(Number(line.netQuantity)).toBeGreaterThan(0)
    // The next order is one lot of 105 ft² (the leather is bought by the hide: whole hides of it).
    expect(Number(line.suggestedBaseQuantity)).toBeGreaterThanOrEqual(105)
    expect(Number(line.suggestedBaseQuantity)).toBeLessThan(105 + 52.5)
    const profile = await ok('viewer', 'GET', profileUrl)
    expect(profile.lots.list[0]).toMatchObject({ seq: 1, quantity: '105.0000' })
    expect(sum(profile.lots.list.map((lot: Json) => lot.quantity))).toBeGreaterThanOrEqual(Number(profile.uncovered))
    expect(profile.lots.list.every((lot: Json) => lot.quantity === '105.0000')).toBe(true)
    // Plan by size: SEED-SO-0001's black jacket one planned work order per size; the red one by the site's size groups.
    const planned = (await ok('viewer', 'GET', `/planning/planned-orders?siteId=${A.siteA1}`)).plannedOrders as Json[]
    const jackets = planned.filter((row) => row.style.id === A.jkt01)
    const blk = jackets.filter((row) => row.colourway.code === 'BLK')
    expect(blk.length).toBeGreaterThan(1)
    expect(blk.every((row) => row.sizes.length === 1 && row.sizeGroup === row.sizes[0].size)).toBe(true)
    const red = jackets.filter((row) => row.colourway.code === 'RED')
    expect(red.length).toBeGreaterThan(0)
    expect(red.every((row) => ['48-50', '52-56'].includes(row.sizeGroup))).toBe(true)
  })
})

describe('the item’s requirement profile (PLN-084) and the calculated delays (PLN-082)', { timeout: 90_000 }, () => {
  it('week by week: demand, receipts, the plan’s lots, projected stock and ATP, each cell naming its orders', async () => {
    const profile = await ok('viewer', 'GET', `${profileUrl}&weeks=8`)
    expect(profile).toMatchObject({ item: { id: A.leather, code: 'SEED-LEA-100' }, colour: { id: A.leatherBLK, code: 'BLK' }, uom: 'FT2', onHand: '51.8000', allocation: 'DATE', horizon: { weeks: 8 } })
    expect(profile.parameters).toMatchObject({ itemPlanningId: leatherRow.id, lotSizing: 'FIXED', delayDays: 2 })
    expect(profile.requirements.length).toBe(1)
    const rows = profile.rows as Json[]
    expect(sum(rows.map((row) => row.demand))).toBe(Number(profile.totals.demand))
    expect(sum(rows.map((row) => row.receipts))).toBe(Number(profile.totals.receipts))
    expect(Number(profile.totals.receipts)).toBe(315)
    const last = rows.at(-1)!
    expect(Number(last.projected)).toBeCloseTo(51.8 + 315 - Number(profile.totals.demand), 4)
    expect(Number(last.projectedWithPlan)).toBeCloseTo(Number(last.projected) + Number(profile.totals.planned), 4)
    const withDemand = rows.find((row) => row.demandRefs.length > 0)!
    expect(withDemand.demandRefs[0]).toMatchObject({ order: { number: expect.stringMatching(/^SEED-SO-000[12]$/) }, orderLine: { seq: expect.any(Number) } })
    expect(rows.flatMap((row) => row.receiptRefs).find((ref: Json) => ref.kind === 'PURCHASE_ORDER')).toMatchObject({ purchaseOrder: { number: 'SEED-PO-0001' } })
    // No money anywhere.
    expect(JSON.stringify(profile)).not.toMatch(/price|cost|amount/i)
  })

  it('a need the supply cannot meet says its earliest day: lead time and delay days, past the closures', async () => {
    // Bought 366 days ahead at most: every short demand is late, whatever today is.
    await ok('planner', 'PATCH', `/planning/item-parameters/${leatherRow.id}`, { version: leatherRow.version, buyLeadTimeDays: 366 }, 200, key())
    const profile = await ok('viewer', 'GET', profileUrl)
    expect(profile.earliest).toMatchObject({ leadTimeDays: 366, delayDays: 2 })
    expect(daysFrom(profile.today, profile.earliest.arrival)).toBeGreaterThanOrEqual(366)
    expect(profile.earliest.usable >= profile.earliest.arrival).toBe(true)
    expect(profile.delays.length).toBeGreaterThan(0)
    for (const delay of profile.delays as Json[]) expect(daysFrom(delay.needDate, delay.earliest)).toBe(delay.daysLate)
    const planned = (profile.delays as Json[]).find((delay) => delay.source === 'PLANNED')!
    expect(planned.earliest).toBe(profile.earliest.usable)
    expect(planned.words).toMatch(/SEED-LEA-100 BLK .*days late\.$/)
    const site = await ok('viewer', 'GET', `/planning/delays?siteId=${A.siteA1}`)
    expect(site.tiles.delayedDemands).toBeGreaterThan(0)
    const mine = (site.demands as Json[]).filter((row) => row.materials.some((entry: Json) => entry.item.id === A.leather && entry.colour?.id === A.leatherBLK))
    expect(mine.length).toBeGreaterThan(0)
    expect(site.materials.find((row: Json) => row.item.id === A.leather && row.colour?.id === A.leatherBLK)).toMatchObject({ leadTimeDays: 366, delayDays: 2, action: 'BUY' })
    expect(site.demands.every((row: Json, index: number, all: Json[]) => index === 0 || all[index - 1]!.daysLate >= row.daysLate)).toBe(true)
  })
})

describe('scarce material by the backlog’s priority (PLN-088)', { timeout: 120_000 }, () => {
  it('a ranked order gets the hides first, the lower one is short instead; the run plans it so', async () => {
    const url = `/planning/allocation-priority?siteId=${A.siteA1}&itemId=${A.leather}&itemColourId=${A.leatherBLK}`
    const shortOf = (material: Json, number: string) => sum(material.parts.filter((entry: Json) => entry.order.number === number).map((entry: Json) => entry.short))
    const before = (await ok('viewer', 'GET', url)).materials[0]
    expect(before).toMatchObject({ allocation: 'DATE', ranked: false })
    expect(before.parts[0].order.number).toBe('SEED-SO-0002')
    expect(shortOf(before, 'SEED-SO-0001')).toBeGreaterThan(0)
    // The planner ranks SEED-SO-0001 first (the backlog's rank: B-W2b-317 writes it; here by SQL).
    await admin(`UPDATE "SalesOrder" SET "backlogRank" = 1 WHERE id = $1`, [A.so1])
    const after = await ok('viewer', 'GET', url)
    expect(after.tiles).toMatchObject({ byPriority: 1, rankedOrders: 1 })
    const material = after.materials[0]
    expect(material).toMatchObject({ allocation: 'PRIORITY', ranked: true })
    expect(material.parts[0].order).toMatchObject({ number: 'SEED-SO-0001', rank: 1 })
    expect(shortOf(material, 'SEED-SO-0001')).toBeLessThan(shortOf(before, 'SEED-SO-0001'))
    expect(shortOf(material, 'SEED-SO-0002')).toBeGreaterThan(shortOf(before, 'SEED-SO-0002'))
    expect(material.parts[0].words).toMatch(/^SEED-SO-0001 \(rank 1\) line/)
    expect(material.words).toMatch(/shared by the backlog's rank/)
    // The run nets the same way: the need day is now SEED-SO-0002's.
    await runPlan()
    const line = await black()
    const so2Days = material.parts.filter((entry: Json) => entry.order.number === 'SEED-SO-0002' && Number(entry.short) > 0).map((entry: Json) => entry.day).sort()
    expect(line.needDate).toBe(so2Days[0])
    expect((await ok('viewer', 'GET', profileUrl)).allocation).toBe('PRIORITY')
  })

  it('another tenant’s or the floor’s caller sees none of it', async () => {
    await refused('floor', 'GET', `/planning/allocation-priority?siteId=${A.siteA1}`, undefined, 403)
    await refused('floor', 'GET', profileUrl, undefined, 403)
    await refused('floor', 'GET', `/planning/delays?siteId=${A.siteA1}`, undefined, 403)
  })
})
