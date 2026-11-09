import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../core/app'
import type { CommandCaller } from '../../../core/command'
import { testAuthenticator, withContextClient, type RequestContext, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applyQueued } from '../../../platform/floor-sync/kinds'
import { switchOnPerformance } from '../../people/privacy/testing/performance-gate'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedSchedule } from '../../../../../../packages/factory-db/seed/schedule'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'

/**
 * The repair station and second quality (B-W2b-126; MES-132, MES-133) through the app's real routes on a throwaway PostgreSQL 17
 * database from the migrations (the runtime logins: row-level security, the column grants and the …_cutting_room_w2b_guards
 * triggers on ReworkOrder and GarmentDowngrade are real), on the factory-db seeds' plant A1: SEED-WO-0001 in progress with its
 * seeded OPEN rework (one garment of BLK-52 sent back to sewing), the finished-goods place A1-FG and the SKU's finished item.
 * Made-up tablets at the sewing station (the rework's work centre), at another station and with no station. Every name and
 * number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/repair`.
 */

const NS = 'w2b126-repair'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const siteA1 = idOf('site:A1')
const operator = idOf('worker:A1:operator')
const seededRework = idOf('schedule:rework:WO-0001:1')
const finishedItem = `ffffffff${idOf('schedule:item:SEED-JKT-02-BLK-52').slice(8)}`
const finishedPlace = `ffffffff${idOf('schedule:location:A1-FG').slice(8)}`
const quarantine = idOf('inventory:location:A1-QUA')
const repairTablet = newId()
const otherTablet = newId()
const shelfTablet = newId()
const manager = newId()

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let repairStation: string
let workOrder: string
let bundle: { id: string; code: string }

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const floorGrant = (permissions: Permission[]): Grant[] => [{ permissions, companies: [companyA], sites: [siteA1], parties: 'all' }]
const REPAIR: Permission[] = ['floor.work', 'production.repair', 'production.rework']
const OFFICE: Permission[] = ['production.scrap.view', 'production.downgrade', 'production.rework', 'workorders.view']
const SESSIONS: Record<string, SessionContext> = {
  repair: { audience: 'floor', tenantId: T, actorId: operator, siteId: siteA1, deviceId: repairTablet, grants: floorGrant(REPAIR) },
  other: { audience: 'floor', tenantId: T, actorId: operator, siteId: siteA1, deviceId: otherTablet, grants: floorGrant(REPAIR) },
  shelf: { audience: 'floor', tenantId: T, actorId: operator, siteId: siteA1, deviceId: shelfTablet, grants: floorGrant(REPAIR) },
  noRepair: { audience: 'floor', tenantId: T, actorId: operator, siteId: siteA1, deviceId: repairTablet, grants: floorGrant(['floor.work', 'production.rework']) },
  manager: { audience: 'office', tenantId: T, actorId: manager, grants: [grant(OFFICE)] },
  viewer: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['production.scrap.view'])] },
  nobody: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['workorders.view'])] },
}

type Json = Record<string, any>
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `repair-${run}-${++keys}`
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(sql, values)).rows as Row[]
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown, key: string | null = method === 'GET' ? null : freshKey()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key ?? (method === 'GET' ? null : freshKey()))
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, url: string, payload: unknown, code: string, status = 409): Promise<Json> {
  const response = await call(session, 'POST', url, payload)
  expect(response.statusCode, response.body).toBe(status)
  const body = response.json()
  expect(String(body.error?.issues?.[0]?.path ?? ''), response.body).toBe(`refusal/${code}`)
  return body.error
}
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
const PERSON = /^(worker|workerId|operator|createdBy|createdById|actorId|displayName|scannedInBy|scannedOutBy|person)$/
const MONEY = /cost|price|margin|amount|wage|valuation|value/i
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY id`, [T, type])).map((row) => row.payload)
const reworkRow = async (id: string) => (await admin(`SELECT status, "repairInAt", "repairStationId", "repairOutAt", "goodQuantity", "scrapQuantity", "startedAt", "doneAt" FROM "ReworkOrder" WHERE id = $1`, [id]))[0]!
const callerAs = (session: string): CommandCaller => ({
  factoryContext: { ...SESSIONS[session]!, requestId: newId() } as RequestContext,
  withClient(work) {
    return withContextClient(database, this.factoryContext!, work)
  },
})

beforeAll(async () => {
  db = await migratedDatabase('production_repair')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedSchedule({ db: database, namespace: NS })
  await seedPrivacy({ db: database, namespace: NS })
  const rework = (await admin<{ workOrderId: string; bundleId: string; workCentreId: string }>(
    `SELECT r."workOrderId", r."bundleId", o."workCentreId" FROM "ReworkOrder" r JOIN "WorkOrderOperation" o ON o.id = r."reworkAtOperationId" WHERE r.id = $1`,
    [seededRework],
  ))[0]!
  workOrder = rework.workOrderId
  bundle = (await admin<{ id: string; code: string }>(`SELECT id, code FROM "Bundle" WHERE id = $1`, [rework.bundleId]))[0]!
  repairStation = (await admin<{ id: string }>(`SELECT id FROM "Station" WHERE "tenantId" = $1 AND "siteId" = $2 AND "workCentreId" = $3 ORDER BY code LIMIT 1`, [T, siteA1, rework.workCentreId]))[0]!.id
  const otherStation = (await admin<{ id: string }>(`SELECT id FROM "Station" WHERE "tenantId" = $1 AND "siteId" = $2 AND "workCentreId" <> $3 ORDER BY code LIMIT 1`, [T, siteA1, rework.workCentreId]))[0]!.id
  for (const [id, station, name] of [
    [repairTablet, repairStation, 'Repair tablet'],
    [otherTablet, otherStation, 'Another station tablet'],
    [shelfTablet, null, 'Warehouse tablet'],
  ] as const) {
    await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, $6, 'TABLET', 'ACTIVE', now())`, [id, T, companyA, siteA1, station, name])
  }
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status, "requireMfa", "updatedAt") VALUES ($1, $2, $3, 'Made-up Manager', 'ACTIVE', false, now())`, [manager, T, `repair-${run}@example.com`])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the repair queue on the floor', () => {
  it("lists the site's open rework, this station's first, with what to redo and never a person", async () => {
    const queue = await ok('repair', 'GET', '/production/repair/station')
    expect(queue.station).toMatchObject({ id: repairStation })
    const row = queue.rows.find((entry: Json) => entry.reworkId === seededRework)
    expect(row).toMatchObject({ state: 'WAITING', here: true, quantity: 1, bundle: { id: bundle.id, code: bundle.code }, reason: { code: 'ALIGNMENT' }, workOrder: { id: workOrder, number: 'SEED-WO-0001' }, cell: { size: '52' }, station: null, inAt: null, held: false })
    expect(row.description).toContain('Left sleeve')
    expect(queue.counts).toMatchObject({ here: 1, waiting: 1, inRepair: 0 })
    expect(keysOf(queue).filter((key) => PERSON.test(key) || MONEY.test(key))).toEqual([])
  })

  it("is another station's row elsewhere, and nobody's without the repair right", async () => {
    const other = await ok('other', 'GET', '/production/repair/station')
    expect(other.rows.find((entry: Json) => entry.reworkId === seededRework)).toMatchObject({ here: false })
    expect(other.counts.here).toBe(0)
    expect((await call('noRepair', 'GET', '/production/repair/station')).statusCode).toBe(403)
    expect((await call('manager', 'GET', '/production/repair/station')).statusCode).toBe(403)
  })
})

describe('scans in and out', () => {
  it('refuses another bundle and a tablet with no station, in words, writing nothing', async () => {
    const wrong = await refused('repair', `/production/repair/${seededRework}/in`, { code: 'BN-NOT-THIS' }, 'NOT_THIS_BUNDLE')
    expect(wrong.issues.find((issue: Json) => issue.path === 'fix').message).toContain(bundle.code)
    await refused('shelf', `/production/repair/${seededRework}/in`, { code: bundle.code }, 'NO_STATION')
    await refused('repair', `/production/repair/${seededRework}/out`, { good: 1, scrap: 0 }, 'NOT_IN')
    expect(await reworkRow(seededRework)).toMatchObject({ status: 'OPEN', repairInAt: null, repairStationId: null })
  })

  it('scans the bundle in: the rework starts at this station, once; a retry answers from the receipt', async () => {
    const key = freshKey()
    const first = await ok('repair', 'POST', `/production/repair/${seededRework}/in`, { code: bundle.code.toLowerCase() }, 201, key)
    expect(first.repair).toMatchObject({ reworkId: seededRework, status: 'IN_PROGRESS', step: 'IN', row: { state: 'IN_REPAIR', here: true, station: { id: repairStation } } })
    const again = await ok('repair', 'POST', `/production/repair/${seededRework}/in`, { code: bundle.code.toLowerCase() }, 200, key)
    expect(again.replayed).toBe(true)
    const stored = await reworkRow(seededRework)
    expect(stored).toMatchObject({ status: 'IN_PROGRESS', repairStationId: repairStation })
    expect(stored.repairInAt).toEqual(stored.startedAt)
    await refused('other', `/production/repair/${seededRework}/in`, { code: bundle.code }, 'ALREADY_IN')
    const [event] = await events('production.repair_scanned')
    expect(event).toMatchObject({ reworkId: seededRework, step: 'IN', stationId: repairStation, status: 'IN_PROGRESS', repairOutAt: null, minutes: null })
    expect(keysOf(event).filter((name) => PERSON.test(name))).toEqual([])
    const queue = await ok('other', 'GET', '/production/repair/station')
    expect(queue.rows.find((entry: Json) => entry.reworkId === seededRework)).toMatchObject({ state: 'IN_REPAIR', here: false, station: { id: repairStation } })
  })

  it('scans it out with the garments that came out good and scrapped; the rework is done and the minutes kept apart', async () => {
    await refused('repair', `/production/repair/${seededRework}/out`, { good: 2, scrap: 0 }, 'COUNTS_DO_NOT_ADD_UP')
    const scansBefore = (await admin(`SELECT 1 FROM "OperationScan" WHERE "tenantId" = $1`, [T])).length
    // A tablet clock before the scan in: never earlier than it.
    const before = new Date(new Date((await reworkRow(seededRework)).repairInAt).getTime() - 60_000).toISOString()
    const out = await ok('repair', 'POST', `/production/repair/${seededRework}/out`, { code: bundle.code, good: 0, scrap: 1, occurredAt: before }, 201)
    expect(out.repair).toMatchObject({ status: 'DONE', step: 'OUT', goodQuantity: 0, scrapQuantity: 1, row: null })
    // The floor's answers carry times, never a duration (F2): the minutes are the office's (the repair record).
    expect(keysOf(out)).not.toContain('minutes')
    expect(keysOf(await ok('repair', 'GET', '/production/repair/station'))).not.toContain('minutes')
    const stored = await reworkRow(seededRework)
    expect(stored).toMatchObject({ status: 'DONE', goodQuantity: 0, scrapQuantity: 1 })
    expect(stored.repairOutAt).toEqual(stored.repairInAt)
    await refused('repair', `/production/repair/${seededRework}/out`, { good: 0, scrap: 1 }, 'WRONG_STATE')
    expect((await ok('repair', 'GET', '/production/repair/station')).rows.find((entry: Json) => entry.reworkId === seededRework)).toBeUndefined()
    // No earnings entry and no operation scan for the repair: its minutes are the rework's own.
    expect((await admin(`SELECT 1 FROM "OperationScan" WHERE "tenantId" = $1`, [T])).length).toBe(scansBefore)
  })

  it('takes a scan kept offline with the tablet time when believable', async () => {
    const opened = await ok('manager', 'POST', '/production/rework', { workOrderId: workOrder, bundleId: bundle.id, reworkAtOperationId: await reworkAtOf(seededRework), quantity: 1, reasonCode: 'ALIGNMENT', split: false }, 201)
    const reworkId = opened.rework.id as string
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString()
    const event = { clientEventId: `rp-${newId()}`, kind: 'production.repair.scan' as const, occurredAt: tenMinutesAgo, payload: { reworkId, step: 'IN', code: bundle.code } }
    expect(await applyQueued(callerAs('repair'), event, { key: `${repairTablet}.${event.clientEventId}` })).toMatchObject({ status: 'accepted', result: { type: 'ReworkOrder', id: reworkId } })
    expect(await applyQueued(callerAs('repair'), event, { key: `${repairTablet}.${event.clientEventId}` })).toMatchObject({ status: 'duplicate' })
    expect(new Date((await reworkRow(reworkId)).repairInAt).toISOString()).toBe(tenMinutesAgo)
    const outEvent = { clientEventId: `rp-${newId()}`, kind: 'production.repair.scan' as const, payload: { reworkId, step: 'OUT' } }
    expect(await applyQueued(callerAs('repair'), outEvent, { key: `${repairTablet}.${outEvent.clientEventId}` })).toMatchObject({ status: 'refused' })
    const done = { clientEventId: `rp-${newId()}`, kind: 'production.repair.scan' as const, payload: { reworkId, step: 'OUT', good: 1, scrap: 0 } }
    expect(await applyQueued(callerAs('repair'), done, { key: `${repairTablet}.${done.clientEventId}` })).toMatchObject({ status: 'accepted' })
    const record = (await ok('manager', 'GET', `/production/repair/${reworkId}`)).repair
    expect(record).toMatchObject({ status: 'DONE', state: null, goodQuantity: 1, scrapQuantity: 0, station: { id: repairStation } })
    expect(record.minutes).toBeGreaterThanOrEqual(9)
  })
})

async function reworkAtOf(reworkId: string): Promise<string> {
  return (await admin<{ id: string }>(`SELECT "reworkAtOperationId" AS id FROM "ReworkOrder" WHERE id = $1`, [reworkId]))[0]!.id
}

describe("a rework's repair in the office", () => {
  it('says where it stood and the minutes, and who scanned only behind the PERFORMANCE gate', async () => {
    const closed = (await ok('manager', 'GET', `/production/repair/${seededRework}`)).repair
    expect(closed).toMatchObject({ reworkId: seededRework, status: 'DONE', station: { id: repairStation }, minutes: 0, scannedInBy: null, scannedOutBy: null, workerHidden: true })
    const off = await switchOnPerformance(admin, { tenantId: T, companyId: companyA, siteId: siteA1, byId: manager })
    try {
      const open = (await ok('manager', 'GET', `/production/repair/${seededRework}`)).repair
      expect(open).toMatchObject({ scannedInBy: { id: operator }, scannedOutBy: { id: operator }, workerHidden: false })
    } finally {
      await off()
    }
    expect((await call('nobody', 'GET', `/production/repair/${seededRework}`)).statusCode).toBe(403)
  })
})

describe('second quality instead of scrap', () => {
  // A rework of whole garments (no part bundle), opened by hand in the office and finished with one garment scrapped.
  let whole: string
  const source = () => ({ reworkOrderId: whole })

  it("holds a cut piece's scrap (the seeded sleeves) with its reason before anything is chosen", async () => {
    const options = await ok('manager', 'GET', `/production/downgrades/options?reworkOrderId=${seededRework}`)
    expect(options).toMatchObject({ scrapped: 1, held: { code: 'NOT_A_GARMENT' } })
    await refused('manager', '/production/downgrades', { reworkOrderId: seededRework, quantity: 1, reasonCode: 'STAIN', target: 'SKU', toLocationId: quarantine, ppeConfirmed: true }, 'NOT_A_GARMENT')
  })

  it("reads what a whole garment's scrap can still send, the SKU, the places and that the style is protective", async () => {
    const cell = (await admin<{ id: string }>(`SELECT "workOrderSizeId" AS id FROM "ReworkOrder" WHERE id = $1`, [seededRework]))[0]!.id
    const opened = await ok('manager', 'POST', '/production/rework', { workOrderId: workOrder, workOrderSizeId: cell, reworkAtOperationId: await reworkAtOf(seededRework), quantity: 1, reasonCode: 'ALIGNMENT' }, 201)
    whole = opened.rework.id
    expect((await ok('manager', 'GET', `/production/downgrades/options?reworkOrderId=${whole}`)).held).toMatchObject({ code: 'NOT_SCRAP' })
    await ok('manager', 'POST', `/production/rework/${whole}/done`, { version: opened.rework.version, good: 0, scrap: 1 }, 201)
    const options = await ok('manager', 'GET', `/production/downgrades/options?reworkOrderId=${whole}`)
    expect(options).toMatchObject({ source: { type: 'REWORK', id: whole }, bundle: null, scrapped: 1, downgraded: 0, left: 1, approval: null, ppe: true, held: null, may: true })
    expect(options.sku).not.toBeNull()
    expect(options.places.find((place: Json) => place.id === finishedPlace)).toMatchObject({ finishedGoods: true })
    expect(options.places.find((place: Json) => place.id === quarantine)).toMatchObject({ finishedGoods: false })
    expect((await ok('viewer', 'GET', `/production/downgrades/options?reworkOrderId=${whole}`)).may).toBe(false)
  })

  it('refuses in words: a protective garment unconfirmed, the SKU into finished goods, more than scrapped, OTHER without words', async () => {
    const base = { ...source(), quantity: 1, reasonCode: 'STAIN', target: 'SKU', toLocationId: quarantine }
    await refused('manager', '/production/downgrades', base, 'PPE_CONFIRM')
    await refused('manager', '/production/downgrades', { ...base, ppeConfirmed: true, toLocationId: finishedPlace }, 'SKU_IN_FINISHED_GOODS')
    await refused('manager', '/production/downgrades', { ...base, ppeConfirmed: true, quantity: 2 }, 'MORE_THAN_SCRAPPED')
    await refused('manager', '/production/downgrades', { ...base, ppeConfirmed: true, reasonCode: 'OTHER' }, 'REASON_WORDS')
    expect((await call('viewer', 'POST', '/production/downgrades', { ...base, ppeConfirmed: true })).statusCode).toBe(403)
    expect(await admin(`SELECT 1 FROM "StockMove" WHERE "idempotencyKey" LIKE 'production.downgrade:%'`)).toEqual([])
  })

  it('puts the garment into the place as the SKU in one command, with the reason, valued as a finished garment; once', async () => {
    const answer = await ok('manager', 'POST', '/production/downgrades', { ...source(), quantity: 1, reasonCode: 'STAIN', note: 'A mark on the back panel', target: 'SKU', toLocationId: quarantine, ppeConfirmed: true }, 201)
    const made = answer.downgrade
    expect(made).toMatchObject({ quantity: 1, reasonCode: 'STAIN', target: 'SKU', place: { id: quarantine }, source: { type: 'REWORK', id: whole }, withdrawn: null })
    const [move] = await admin(`SELECT reason, "itemId", "toLocationId", "fromLocationId", quantity::text AS quantity, "workOrderId", "reasonCode", "idempotencyKey" FROM "StockMove" WHERE id = $1`, [made.moveId])
    expect(move).toEqual({ reason: 'ADJUSTMENT', itemId: finishedItem, toLocationId: quarantine, fromLocationId: null, quantity: '1.0000', workOrderId: workOrder, reasonCode: 'STAIN', idempotencyKey: `production.downgrade:${made.id}:1` })
    // Valued as a finished garment is: at its frozen standard when finance froze one (the seed has none: not valued yet).
    expect(await admin(`SELECT 1 FROM "StockValuation" WHERE "moveId" = $1`, [made.moveId])).toHaveLength(0)
    const [row] = await admin(`SELECT "variantId", "secondQualityItemId", "reworkOrderId", "sourceScanId", "createdById", "moveId" FROM "GarmentDowngrade" WHERE id = $1`, [made.id])
    // B-W2b-219: the row names its second-quality move (posted first, under its key).
    expect(row).toMatchObject({ secondQualityItemId: null, reworkOrderId: whole, sourceScanId: null, createdById: manager, moveId: made.moveId })
    expect(row!.variantId).not.toBeNull()
    expect((await events('production.garments_downgraded')).at(-1)).toMatchObject({ downgradeId: made.id, quantity: 1, target: 'SKU', moveId: made.moveId, toLocationId: quarantine })
    await refused('manager', '/production/downgrades', { ...source(), quantity: 1, reasonCode: 'STAIN', target: 'SKU', toLocationId: quarantine, ppeConfirmed: true }, 'MORE_THAN_SCRAPPED')
    const list = await ok('viewer', 'GET', '/production/downgrades')
    expect(list.downgrades.find((entry: Json) => entry.id === made.id)).toMatchObject({ place: { code: 'A1-QUA' } })
    expect(list.garments.today).toBe(1)
    expect(keysOf(list).filter((key) => PERSON.test(key) || MONEY.test(key))).toEqual([])
    expect((await call('nobody', 'GET', '/production/downgrades')).statusCode).toBe(403)
  })

  it('withdraws a wrong downgrade once: the garment comes out of the place again', async () => {
    const [row] = await admin<{ id: string; version: number }>(`SELECT id, version FROM "GarmentDowngrade" WHERE "reworkOrderId" = $1 AND "voidedAt" IS NULL`, [whole])
    expect((await call('manager', 'POST', `/production/downgrades/${row!.id}/withdraw`, { version: row!.version + 5, reason: 'Wrong row' })).statusCode).toBe(409)
    const answer = await ok('manager', 'POST', `/production/downgrades/${row!.id}/withdraw`, { version: row!.version, reason: 'Downgraded the wrong garment' }, 201)
    expect(answer.downgrade).toMatchObject({ withdrawn: { reason: 'Downgraded the wrong garment' } })
    const [back] = await admin(`SELECT reason, "fromLocationId", "toLocationId", "reversalOfId" FROM "StockMove" WHERE id = $1`, [answer.downgrade.withdrawnMoveId])
    expect(back).toEqual({ reason: 'ADJUSTMENT', fromLocationId: quarantine, toLocationId: null, reversalOfId: answer.downgrade.moveId })
    await refused('manager', `/production/downgrades/${row!.id}/withdraw`, { version: row!.version + 1, reason: 'Again' }, 'ALREADY_WITHDRAWN')
    expect((await ok('viewer', 'GET', '/production/downgrades')).garments.today).toBe(0)
    expect((await events('production.downgrade_withdrawn')).at(-1)).toMatchObject({ downgradeId: row!.id, moveId: answer.downgrade.withdrawnMoveId })
    // Withdrawn, its garment is free to go to second quality again.
    expect((await ok('manager', 'GET', `/production/downgrades/options?reworkOrderId=${whole}`)).left).toBe(1)
  })

  it('B-W2b-219: a downgrade made before the move column (no moveId) is still read and withdrawn by its key', async () => {
    const made = (await ok('manager', 'POST', '/production/downgrades', { ...source(), quantity: 1, reasonCode: 'STAIN', target: 'SKU', toLocationId: quarantine, ppeConfirmed: true }, 201)).downgrade
    // As a row from before the column: no moveId (the guards set aside for this one statement, as an old row was written).
    await db.admin.query('BEGIN')
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await db.admin.query('UPDATE "GarmentDowngrade" SET "moveId" = NULL WHERE id = $1', [made.id])
    await db.admin.query('COMMIT')
    const listed = (await ok('viewer', 'GET', '/production/downgrades')).downgrades.find((entry: Json) => entry.id === made.id)
    expect(listed).toMatchObject({ moveId: made.moveId, place: { id: quarantine } })
    const [row] = await admin<{ version: number }>(`SELECT version FROM "GarmentDowngrade" WHERE id = $1`, [made.id])
    const answer = await ok('manager', 'POST', `/production/downgrades/${made.id}/withdraw`, { version: row!.version, reason: 'Old row withdrawn' }, 201)
    const [back] = await admin(`SELECT "reversalOfId" FROM "StockMove" WHERE id = $1`, [answer.downgrade.withdrawnMoveId])
    expect(back).toEqual({ reversalOfId: made.moveId })
  })
})
