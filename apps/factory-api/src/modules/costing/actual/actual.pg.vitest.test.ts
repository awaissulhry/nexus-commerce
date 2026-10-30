import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAccounting, type AccountingSeed } from '../../../../../../packages/factory-db/seed/accounting'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { buildApp } from '../../../core/app'
import { SYSTEM_ACTOR_ID, testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { chooseMethod } from '../method/method'
import { costingHandlers } from './handlers'

/**
 * Standard vs actual on the local stack (B-W2a-21; FIN-024, FIN-025, FIN-026, FIN-027, FIN-033, FIN-038) with the app's
 * real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the
 * …_money_w2a_guards triggers are real), the factory-db seeds up to accounting (SEED-WO-0001 in progress: the hide H1
 * issued at 4.20 ft², the standing sewing scan 2 × 96.5 minutes, their two cost entries; the frozen material standards
 * from 2026-10-01 — leather 4.20, lining 3.10, protectors 6.50 —; the tenant-wide rates; September 2026 HARD-locked;
 * the costing method UNDECIDED). The worker's handler is called with the outbox's own events. Every figure is made up and
 * worked out by hand below. Run with `node scripts/factory/run-pg-tests.mjs modules/costing`.
 *
 * The jacket per garment (B-W1-16's sheet at the frozen standards, 0 % overhead): labour 59.90 every size (cut 14 × 0.50,
 * sew 96.5 × 0.40 ÷ 0.80, inspect 8 × 0.45, pack 3.5 × 0.30); material: size 50 leather 43 × 1.12 = 48.16 ft² × 4.20 =
 * 202.272 + lining 1.89 m × 3.10 = 5.859 + protectors 13.00 = 221.131; size 52 211.68 + 5.859 + 13 = 230.539; size 54
 * 223.44 + 5.859 + 13 = 242.299. SEED-WO-0001: BLK 50 ×1, 52 ×2, 54 ×1, RED 50, 52, 54 ×1 = 7 garments: material
 * 1,618.477, labour 419.30, together 2,037.777 → 2,037.78.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seeded: AccountingSeed

const NS = 'costing-actual'
const id = (key: string) => seedUuid(NS, key)
const tenant = id('tenant')
const companyA = id('company:A')
const companyB = id('company:B')
const siteA = id('site:A1')
const style = id('production:style:JKT-02')
const blk = id('production:colourway:JKT-02:BLK')
const leather = id('product:item:leather')
const lining = id('product:item:lining')
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `t-${run}-${++keys}`

const grain = (permissions: readonly string[], companies: Grant['companies'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[], actorId = newId()): SessionContext => ({ audience: 'office', tenantId: tenant, actorId, grants })
const fromTemplate = (name: string): SessionContext => {
  const role = templateOf(name)!
  return office([grain([...role.permissions, ...role.grains.map((g) => `money.${g}`)])])
}
const SESSIONS: Record<string, SessionContext> = {
  finance: fromTemplate('finance'),
  sales: fromTemplate('sales'),
  production: office([grain(['workorders.view', 'production.rework', 'production.finish', 'inventory.issue', 'inventory.reverse', 'inventory.stock.view', 'production.scrap', 'production.scrap.view'])]),
  viewer: office([grain(['workorders.view', 'money.cost'])]),
  companyB: office([grain(['costing.view', 'costing.ledger.manage', 'money.cost'], [companyB])]),
  otherTenant: { audience: 'office', tenantId: newId(), actorId: newId(), grants: [grain(['costing.view', 'money.cost'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown, withKey = method !== 'GET') =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(withKey ? { 'idempotency-key': key() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : []
const MONEY = /cost|amount|total|variance|value|perMinute|movedToStock|onWorkOrder|scrapLost|scrapFromStock|breakdown/i

const system = () => callerFor(database, { audience: 'system', tenantId: tenant, actorId: SYSTEM_ACTOR_ID, grants: [], requestId: newId() })
/** The worker's handler on the outbox's own events of a subject (the newest of a type first). */
async function handle(type: string, where: (payload: Json) => boolean) {
  const rows = await admin<{ id: string; type: string; version: number; payload: Json; occurredAt: Date }>('SELECT id, type, version, payload, "occurredAt" FROM "OutboxEvent" WHERE type = $1 ORDER BY "occurredAt" DESC, id DESC', [type])
  const row = rows.find((event) => where(event.payload))
  expect(row, `no ${type} event`).toBeDefined()
  const envelope = { eventId: row!.id, type: row!.type, version: row!.version, tenantId: tenant, payload: row!.payload, occurredAt: row!.occurredAt.toISOString() } as unknown as EventEnvelope
  await costingHandlers()[0]!.handle(envelope, { caller: system(), attempt: 1 })
}
const entriesOf = async (workOrderId: string) =>
  admin<{ id: string; kind: string; amount: number; quantity: string | null; minutes: string | null; idempotencyKey: string; reversalOfId: string | null; costingMethod: string; stockMoveId: string | null; operationScanId: string | null }>(
    'SELECT id, kind::text, amount, quantity::text, minutes::text, "idempotencyKey", "reversalOfId", "costingMethod"::text AS "costingMethod", "stockMoveId", "operationScanId" FROM "WorkOrderCostEntry" WHERE "workOrderId" = $1 ORDER BY "createdAt", id',
    [workOrderId],
  )
const rowOf = async (session = 'finance') => (await ok(session, 'GET', `/costing/work-orders?companyId=${companyA}`)).rows.find((row: Json) => row.workOrder.number === 'SEED-WO-0001')
const detailOf = async (session = 'finance') => (await ok(session, 'GET', `/costing/work-orders/${seeded.money.shipping.quality.production.workOrderId}`)).detail

beforeAll(async () => {
  db = await migratedDatabase('costing_actual')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  await seedPrivacy({ db: database, namespace: NS })
  seeded = await seedAccounting({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  const production = seeded.money.shipping.quality.production
  // A made-up tablet at the inspection bench QC-01.
  const qcTablet = newId()
  await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, 'Made-up QC tablet', 'TABLET', 'ACTIVE', now())`, [qcTablet, tenant, companyA, siteA, id('site:A1:station:QC-01')])
  SESSIONS.qc = { audience: 'floor', tenantId: tenant, actorId: production.operatorId, siteId: siteA, deviceId: qcTablet, grants: [{ permissions: ['floor.work', 'production.scan'], companies: [companyA], sites: [siteA], parties: 'all' }] }
  // Plant A1's finished-goods place (made up): B-W2a-12 puts finished garments there.
  await admin(`INSERT INTO "Location" (id, "tenantId", "companyId", "siteId", code, name, kind) VALUES ($1, $2, $3, $4, 'A1-FG', 'Finished goods', 'FINISHED_GOODS')`, [newId(), tenant, companyA, siteA])
  SESSIONS.floor = {
    audience: 'floor',
    tenantId: tenant,
    actorId: production.operatorId,
    siteId: siteA,
    deviceId: production.deviceId,
    grants: [{ permissions: ['floor.work', 'production.scan'], companies: [companyA], sites: [siteA], parties: 'all' }],
  }
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

const wo = () => seeded.money.shipping.quality.production.workOrderId
const variants = async () => admin<{ id: string; sku: string; size: string; colourwayId: string }>('SELECT id, sku, size, "colourwayId" FROM "Variant" WHERE "styleId" = $1 ORDER BY sku', [style])

describe('the costing method stays the accountant\'s (FIN-025)', () => {
  it('is UNDECIDED: every cost is provisional, nothing locked', async () => {
    const { method } = await ok('finance', 'GET', `/costing/method?companyId=${companyA}`)
    expect(method).toMatchObject({ companyId: companyA, method: 'UNDECIDED', provisional: true, from: 'TENANT', locked: false, open: true, entries: 2, choices: ['STANDARD', 'MOVING_AVERAGE', 'FIFO'] })
    expect(method.words).toMatch(/not chosen yet.*provisional/)
    await refused('otherTenant', 'GET', `/costing/method?companyId=${companyA}`, undefined, 404)
  })
})

describe('estimated vs actual before any garment has a standard (FIN-033)', () => {
  it('compares SEED-WO-0001 with its estimate at release; sales sees no figure', async () => {
    const row = await rowOf()
    // Estimate: the frozen need × the standards of 15 Nov (material 1,618.477) + 7 × 59.90 (419.30) = 2,037.78.
    // Actual so far: the hide 223.44 + the sewing 96.50 = 319.94.
    expect(row).toMatchObject({ basis: 'ESTIMATE', standardTotal: null, estimateTotal: 203_778, estimateComplete: true, actualTotal: 31_994, movedToStock: 0, variance: 31_994 - 203_778, provisional: true, final: false, entries: 2 })
    expect(row.workOrder).toMatchObject({ number: 'SEED-WO-0001', status: 'IN_PROGRESS', pieces: 7 })
    const list = await ok('finance', 'GET', `/costing/work-orders?companyId=${companyA}`)
    expect(list.rows.map((entry: Json) => entry.workOrder.number)).not.toContain('SEED-WO-0002') // a draft
    expect(list.tiles).toMatchObject({ overStandard: 0, currency: 'EUR', wipValue: null })
    const sales = await rowOf('sales')
    expect(keysOf(sales).filter((name) => MONEY.test(name) && name !== 'estimateComplete')).toEqual([])
    expect(sales).toMatchObject({ basis: 'ESTIMATE', biggestReason: 'MATERIAL_USAGE' })
    await refused('viewer', 'GET', '/costing/work-orders', undefined, 403)
    expect((await ok('otherTenant', 'GET', '/costing/work-orders')).rows).toEqual([])
    await refused('companyB', 'GET', `/costing/work-orders/${wo()}`, undefined, 404)
  })
})

describe('standard cost per item (FIN-024)', () => {
  let standards: Record<string, Json> = {}
  const std = (code: string): Json => standards[code]!

  it("prepares each SKU's standard from its cost sheet; a frozen one is left alone, in words", async () => {
    const skus = await variants()
    const answer = await ok('finance', 'POST', '/costing/standards/prepare', { companyId: companyA, validFrom: '2026-10-01', items: [...skus.map((sku) => ({ variantId: sku.id })), { itemId: lining }] })
    expect(answer.skipped).toEqual([expect.objectContaining({ itemId: lining, reason: 'A standard of SEED-LIN-200 from 2026-10-01 is frozen already.' })])
    standards = Object.fromEntries(answer.prepared.map((standard: Json) => [standard.item.code, standard]))
    expect(Object.keys(standards).sort()).toEqual(skus.map((sku) => sku.sku))
    expect(std('SEED-JKT-02-BLK-52')).toMatchObject({ status: 'DRAFT', source: 'ROLLUP', currency: 'EUR', materialCost: '230.539', labourCost: '59.9', subcontractCost: '0', overheadCost: '0', unitCost: '290.439', labourMinutes: '122', inForce: false })
    expect(std('SEED-JKT-02-RED-50')).toMatchObject({ unitCost: '281.031' })
    expect(std('SEED-JKT-02-BLK-54')).toMatchObject({ unitCost: '302.199', item: expect.objectContaining({ kind: 'FINISHED', baseUom: 'PCS' }) })
    expect(std('SEED-JKT-02-BLK-52').breakdown).toMatchObject({ basis: 'ROLLUP', size: '52', colourwayId: blk, materials: expect.arrayContaining([expect.objectContaining({ itemId: leather, unitCost: '4.2' })]) })
    // Sales holds costing.view without the cost grain: the standard, never its figures.
    const seen = (await ok('sales', 'GET', `/costing/standards/${std('SEED-JKT-02-BLK-52').id}`)).standard
    expect(keysOf(seen).filter((name) => MONEY.test(name))).toEqual([])
    await refused('sales', 'POST', '/costing/standards/prepare', { companyId: companyA, validFrom: '2026-10-01', items: [{ itemId: lining }] }, 403)
  })

  it('freezes once; refused in words inside a locked period or over another frozen standard', async () => {
    const blk52 = std('SEED-JKT-02-BLK-52')
    // A receipt into finished goods before the standard is frozen has no value: it waits, said so.
    const cell = seeded.money.shipping.quality.production.cellIds['BLK-52']
    const finished = await ok('production', 'POST', `/production/work-orders/${wo()}/finished`, { cells: [{ cellId: cell, quantity: 1 }] }, 201)
    expect(finished.report).toMatchObject({ pieces: 1, valued: false })
    const waiting = await ok('finance', 'POST', `/costing/work-orders/${wo()}/post`)
    expect(waiting).toMatchObject({ posted: [], provisional: true, waiting: [expect.objectContaining({ code: 'NOT_VALUED', sourceType: 'StockMove', sourceId: finished.report.moveIds[0] })] })

    const frozen = await ok('finance', 'POST', `/costing/standards/${blk52.id}/freeze`, { version: blk52.version })
    expect(frozen.standard).toMatchObject({ status: 'FROZEN', inForce: true, frozenAt: expect.any(String) })
    expect(frozen.ended).toBeNull()
    // The receipt that waited is valued at 290.439 now, and the work order's completion posted: −290.44.
    expect(frozen.valued).toMatchObject({ moves: 1, workOrders: [{ id: wo(), number: 'SEED-WO-0001' }], skipped: [] })
    expect((await entriesOf(wo())).filter((entry) => entry.kind === 'COMPLETION')).toEqual([expect.objectContaining({ amount: -29_044, quantity: '-1.0000', idempotencyKey: `move:${finished.report.moveIds[0]}`, costingMethod: 'UNDECIDED' })])
    expect((await refused('finance', 'POST', `/costing/standards/${blk52.id}/freeze`, { version: frozen.standard.version }, 409)).message).toBe('This standard is frozen already.')

    // A standard typed for 15 September: inside the HARD-locked September.
    const typed = (await ok('finance', 'POST', '/costing/standards', { companyId: companyA, itemId: blk52.item.id, validFrom: '2026-09-15', validTo: '2026-09-30', materialCost: '200', labourCost: '50' }, 201)).standard
    expect(typed).toMatchObject({ status: 'DRAFT', source: 'MANUAL', unitCost: '250' })
    expect((await refused('finance', 'POST', `/costing/standards/${typed.id}/freeze`, { version: typed.version }, 409)).message).toBe('2026-09-15 is in the locked period 2026-09-01 to 2026-09-30: a standard is frozen from a day after it.')
    expect(await ok('finance', 'POST', `/costing/standards/${typed.id}/discard`, { version: typed.version })).toEqual({ id: typed.id, discarded: true })

    // Leather from 15 January 2027: the open 4.20 from October ends on 14 January.
    const next = (await ok('finance', 'POST', '/costing/standards', { companyId: companyA, itemId: leather, validFrom: '2027-01-15', source: 'PURCHASE', materialCost: '4.4' }, 201)).standard
    const leatherFrozen = await ok('finance', 'POST', `/costing/standards/${next.id}/freeze`, { version: next.version })
    expect(leatherFrozen.ended).toMatchObject({ id: seeded.standardCostIds.leather, validFrom: '2026-10-01', validTo: '2027-01-14', status: 'FROZEN' })
    // The seeded DRAFT from 1 January 2027 would now overlap the one frozen from 15 January.
    const draft = (await ok('finance', 'GET', `/costing/standards/${seeded.standardCostIds.nextLeather}`)).standard
    expect((await refused('finance', 'POST', `/costing/standards/${draft.id}/freeze`, { version: draft.version }, 409)).message).toBe(
      'The standard frozen from 2026-10-01 to 2027-01-14 covers 2027-01-01; its end is set already: start this one after 2027-01-14.',
    )
    // Frozen standards never change but for their end (the DB holds it too).
    await expect(admin('UPDATE "StandardCost" SET "unitCost" = 1, "materialCost" = 1 WHERE id = $1', [blk52.id])).rejects.toThrow(/FROZEN for its period/)
    await expect(admin('DELETE FROM "StandardCost" WHERE id = $1', [blk52.id])).rejects.toThrow(/never deleted/)
  })

  it('lists the standards in force; the work order now compares with its garments\' standards', async () => {
    for (const code of Object.keys(standards).filter((sku) => sku.startsWith('SEED-JKT-02') && sku !== 'SEED-JKT-02-BLK-52')) {
      const standard = standards[code]!
      await ok('finance', 'POST', `/costing/standards/${standard.id}/freeze`, { version: standard.version })
    }
    const inForce = await ok('finance', 'GET', `/costing/standards?companyId=${companyA}&on=2026-11-15&kind=FINISHED&q=JKT-02`)
    expect(inForce.standards).toHaveLength(6)
    expect(inForce.standards.every((standard: Json) => standard.status === 'FROZEN' && standard.breakdown === undefined)).toBe(true)
    const row = await rowOf()
    // Standard: Σ 7 garments = 2,037.78 (the estimate's figure: one sheet). Actual: 319.94 so far, 290.44 moved to stock.
    expect(row).toMatchObject({ basis: 'STANDARD', standardTotal: 203_778, actualTotal: 31_994, movedToStock: -29_044, variance: 31_994 - 203_778, variancePct: '-84.30', over: false })
  })
})

describe('actual material from issues and scrap, labour from scans, the ledger (FIN-026, FIN-027, FIN-038)', () => {
  const lot = () => seeded.money.shipping.quality.production.inventory.liningLotId
  const bin = () => seeded.money.shipping.quality.production.inventory.locations.bin

  it('posts an issue at its lot value through the worker; a repeated event posts nothing', async () => {
    const issued = await ok('production', 'POST', `/inventory/picking/work-orders/${wo()}/issue`, { lotId: lot(), quantity: '2' }, 201)
    const moveId = issued.issue.moves[0].id
    await handle('inventory.moved', (payload) => payload.moveId === moveId)
    await handle('inventory.moved', (payload) => payload.moveId === moveId)
    // 2 m at the lot's 3.10 = 6.20; compared with the lining's 3.10 standard.
    expect((await entriesOf(wo())).filter((entry) => entry.stockMoveId === moveId)).toEqual([expect.objectContaining({ kind: 'MATERIAL', amount: 620, quantity: '2.0000', idempotencyKey: `move:${moveId}` })])
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'work_order_cost.posted' AND subject = $1`, [wo()])
    expect(events.some((event) => event.payload.kinds.includes('MATERIAL') && event.payload.number === 'SEED-WO-0001')).toBe(true)
  })

  it('takes a return off, and a reversed return back on', async () => {
    const back = await ok('production', 'POST', `/inventory/picking/work-orders/${wo()}/return`, { lotId: lot(), quantity: '0.5', toLocationId: bin() }, 201)
    const returnId = back.return.move.id
    const posted = await ok('finance', 'POST', `/costing/work-orders/${wo()}/post`, undefined, 201)
    expect(posted.posted).toEqual([expect.objectContaining({ kind: 'MATERIAL', event: 'RETURN', quantity: '-0.5', amount: -155, document: expect.objectContaining({ type: 'StockMove', id: returnId }) })])
    const reversed = await ok('production', 'POST', `/inventory/picking/moves/${returnId}/reverse`, { note: 'Returned to the wrong order.' }, 201)
    const reversalMoveId = reversed.reversal.moves[0].id
    await handle('inventory.moved', (payload) => payload.moveId === reversalMoveId)
    const entries = await entriesOf(wo())
    const original = entries.find((entry) => entry.stockMoveId === returnId && entry.reversalOfId === null)!
    expect(entries.find((entry) => entry.reversalOfId === original.id)).toMatchObject({ kind: 'MATERIAL', amount: 155, quantity: '0.5000', stockMoveId: reversalMoveId })
  })

  it('charges material scrapped from stock for the work order', async () => {
    const scrap = await ok('production', 'POST', '/production/scrap/stock', { workOrderId: wo(), reasonCode: 'STAIN', lines: [{ itemId: lining, lotId: lot(), fromLocationId: bin(), quantity: '1' }] }, 201)
    await handle('inventory.moved', (payload) => payload.moveId === scrap.scrap.moves[0].id)
    expect((await entriesOf(wo())).filter((entry) => entry.kind === 'SCRAP')).toEqual([expect.objectContaining({ amount: 310, quantity: '1.0000', stockMoveId: scrap.scrap.moves[0].id })])
  })

  it('earns labour from floor scans, per work order; an undo reverses it; scrapped garments are recorded', async () => {
    const production = seeded.money.shipping.quality.production
    const report = async (n: number, payload: Json) => {
      const clientScanId = `cost-${run}-${n}`
      const response = await app.inject({ method: 'POST', url: payload.undo ? `/production/scans/${payload.undo}/undo` : '/production/scans', headers: { 'x-test-session': 'qc', 'idempotency-key': clientScanId }, payload: { clientScanId, ...(payload.undo ? {} : payload) } })
      expect(response.statusCode, response.body).toBeLessThan(300)
      return response.json().scan.id as string
    }
    // Inspection at QC-01: 2 jackets × 8 minutes = 16 minutes × 0.45 = 7.20.
    const first = await report(1, { bundleId: production.bundleIds[1], workOrderOperationId: production.operationIds.qc, good: 2 })
    await handle('production.scan_recorded', (payload) => payload.scanId === first)
    const labour = (await entriesOf(wo())).find((entry) => entry.operationScanId === first)!
    expect(labour).toMatchObject({ kind: 'LABOUR', minutes: '16.0000', amount: 720, idempotencyKey: `scan:${first}` })
    // Undone at once on the tablet: its labour comes off.
    const undo = await report(2, { undo: first })
    await handle('production.scan_recorded', (payload) => payload.scanId === undo)
    expect((await entriesOf(wo())).find((entry) => entry.reversalOfId === labour.id)).toMatchObject({ kind: 'LABOUR', minutes: '-16.0000', amount: -720, operationScanId: undo })
    // Reported again: 1 good (3.60) and 1 scrapped for a stain: its leather is recorded, amount 0 (charged at the issue).
    const again = await report(3, { bundleId: production.bundleIds[1], workOrderOperationId: production.operationIds.qc, good: 1, scrap: [{ reason: 'STAIN', quantity: 1 }] })
    await handle('production.scan_recorded', (payload) => payload.scanId === again)
    const entries = await entriesOf(wo())
    expect(entries.find((entry) => entry.idempotencyKey === `scan:${again}`)).toMatchObject({ kind: 'LABOUR', minutes: '8.0000', amount: 360 })
    expect(entries.find((entry) => entry.idempotencyKey === `scan-scrap:${again}:${leather}`)).toMatchObject({ kind: 'SCRAP', amount: 0, operationScanId: again })
    // No column of the ledger names a person.
    const columns = await admin<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'WorkOrderCostEntry'`)
    expect(columns.map((column) => column.column_name).filter((name) => /worker|person|employee/i.test(name))).toEqual([])
  })

  it("waits, in words, for a rework's scrap the ledger cannot name (opened by hand, without its scan)", async () => {
    const production = seeded.money.shipping.quality.production
    const [bundle] = await admin<{ cell: string }>(`SELECT "workOrderSizeId" AS cell FROM "Bundle" WHERE id = $1`, [production.bundleIds[1]])
    const opened = await ok('production', 'POST', '/production/rework', { workOrderId: wo(), workOrderSizeId: bundle!.cell, bundleId: production.bundleIds[1], foundAtOperationId: production.operationIds.qc, reworkAtOperationId: production.operationIds.sew, quantity: 1, reasonCode: 'RESTITCH', split: false }, 201)
    const rework = opened.rework
    const started = await ok('production', 'POST', `/production/rework/${rework.id}/start`, { version: rework.version }, 201)
    await ok('production', 'POST', `/production/rework/${rework.id}/done`, { version: started.rework.version, good: 0, scrap: 1 }, 201)
    const before = (await entriesOf(wo())).length
    await handle('production.rework_moved', (payload) => payload.reworkId === rework.id && payload.status === 'DONE')
    expect((await entriesOf(wo())).length).toBe(before)
    const answer = await ok('finance', 'POST', `/costing/work-orders/${wo()}/post`)
    expect(answer.posted).toEqual([])
    expect(answer.waiting).toEqual([expect.objectContaining({ code: 'NO_SCAN', sourceType: 'ReworkOrder', sourceId: rework.id })])
  })

  it('reverses an entry by hand once, with its reason; a reversal is not reversed', async () => {
    const scrap = (await entriesOf(wo())).find((entry) => entry.kind === 'SCRAP')!
    await refused('sales', 'POST', `/costing/entries/${scrap.id}/reverse`, { reason: 'Not ours.' }, 403)
    await refused('companyB', 'POST', `/costing/entries/${scrap.id}/reverse`, { reason: 'Not ours.' }, 404)
    const answer = await ok('finance', 'POST', `/costing/entries/${scrap.id}/reverse`, { reason: 'The stain was the supplier\'s: claimed.' }, 201)
    expect(answer.entry).toMatchObject({ id: scrap.id, event: 'STOCK_SCRAP', reversedBy: { id: answer.reversals[0].id, reason: "The stain was the supplier's: claimed." } })
    expect(answer.reversals).toEqual([expect.objectContaining({ kind: 'SCRAP', event: 'REVERSAL', amount: -310, reversalOfId: scrap.id, provisional: true })])
    expect((await refused('finance', 'POST', `/costing/entries/${scrap.id}/reverse`, { reason: 'Again.' }, 409)).message).toMatch(/^This entry was reversed on \d{4}-\d{2}-\d{2} \(The stain was the supplier's: claimed.\): an entry is reversed once.$/)
    expect((await refused('finance', 'POST', `/costing/entries/${answer.reversals[0].id}/reverse`, { reason: 'Undo the undo.' }, 409)).message).toMatch(/^This entry is a reversal/)
    // Append-only for every login.
    await expect(admin('UPDATE "WorkOrderCostEntry" SET amount = 1 WHERE id = $1', [scrap.id])).rejects.toThrow()
    await expect(admin('DELETE FROM "WorkOrderCostEntry" WHERE id = $1', [scrap.id])).rejects.toThrow()
  })

  it('lists the ledger with its events and documents, never a person; sales sees no figure', async () => {
    const { entries } = await ok('finance', 'GET', `/costing/ledger?workOrderId=${wo()}&limit=200`)
    expect(new Set(entries.map((entry: Json) => entry.event))).toEqual(new Set(['ISSUE', 'RETURN', 'REVERSAL', 'STOCK_SCRAP', 'LABOUR', 'COMPLETION', 'SCAN_SCRAP']))
    expect(keysOf(entries).filter((name) => /createdBy|worker|person/i.test(name))).toEqual([])
    const issue = entries.find((entry: Json) => entry.event === 'ISSUE' && entry.item?.code === 'SEED-LEA-100')
    expect(issue).toMatchObject({ amount: 22_344, unitCost: '4.2', standardUnitCost: '4.2', quantity: '53.2', method: 'UNDECIDED', provisional: true, document: expect.objectContaining({ type: 'StockMove' }) })
    const sales = await ok('sales', 'GET', `/costing/ledger?workOrderId=${wo()}`)
    expect(keysOf(sales.entries).filter((name) => MONEY.test(name))).toEqual([])
    expect((await ok('finance', 'GET', `/costing/ledger?workOrderId=${wo()}&kind=LABOUR`)).entries.every((entry: Json) => entry.kind === 'LABOUR')).toBe(true)
  })

  it("the work order's cost: a bridge that adds up to the variance, labour per operation, materials per lot", async () => {
    const detail = await detailOf()
    // Actual: material 223.44 + 6.20 − 1.55 + 1.55 + 3.10 − 3.10 = 229.64; labour 96.50 + 7.20 − 7.20 + 3.60 = 100.10:
    // 329.74 so far; 290.44 moved to finished goods (at standard): 39.30 left on the work order.
    expect(detail.actual).toMatchObject({ material: 22_964, labour: 10_010, total: 32_974, movedToStock: -29_044, onWorkOrder: 3_930, scrapFromStock: 0 })
    // The scrapped garment's leather at the issue's 4.20: 3.3333 ft² → 14.00.
    expect(detail.actual.scrapLost).toBe(1_400)
    expect(detail.bridge.reduce((sum: number, step: Json) => sum + step.amount, 0)).toBe(detail.variance)
    expect(detail.variance).toBe(32_974 - 203_778)
    const sewing = detail.labour.find((row: Json) => row.operation.seq === 20)
    expect(sewing).toMatchObject({ plannedMinutes: '675.5', earnedMinutes: '193', amount: 9_650, perMinute: '0.5' })
    expect(detail.labour.find((row: Json) => row.operation.seq === 30)).toMatchObject({ earnedMinutes: '8', amount: 360 })
    expect(keysOf(detail.labour).filter((name) => /worker|person/i.test(name))).toEqual([])
    const liningRow = detail.materials.find((row: Json) => row.item.code === 'SEED-LIN-200')
    expect(liningRow).toMatchObject({ plannedQuantity: '13.23', issuedQuantity: '2', amount: 620, standardUnitCost: '3.1' })
    expect(detail.parts.find((part: Json) => part.part === 'MATERIAL')).toMatchObject({ planned: 161_848, actual: 22_964 })
    expect(detail.scrap.map((row: Json) => row.event).sort()).toEqual(['REVERSAL', 'SCAN_SCRAP', 'STOCK_SCRAP'])
    expect(detail.words).toMatch(/provisional/)
    expect(detail.standardMissing).toEqual([])
  })
})

describe('the costing method locks with the first entry posted under it (FIN-025)', () => {
  it('is chosen by the accountant, locked in the same command as the next entry, then held', async () => {
    const manager = callerFor(database, { audience: 'office', tenantId: tenant, actorId: newId(), grants: [grain(['costing.view', 'costing.method.manage'])], requestId: newId() })
    const chosen = await chooseMethod(manager, { companyId: companyA, method: 'STANDARD', reason: "The accountant's letter of 30 October." })
    expect(chosen).toMatchObject({ companyId: companyA, method: 'STANDARD', from: 'COMPANY', provisional: false, locked: false, open: true })
    // The company's own row keeps the tenant-wide overhead it copied (0 %): nothing else changes.
    expect((await admin('SELECT "overheadPct"::text AS pct, "methodLockedAt" FROM "CostingSettings" WHERE id = $1', [companyA]))[0]).toEqual({ pct: '0.0000', methodLockedAt: null })
    // The next entry (1 m of lining issued) posts under STANDARD and locks it, in the same command.
    const lot = seeded.money.shipping.quality.production.inventory.liningLotId
    const issued = await ok('production', 'POST', `/inventory/picking/work-orders/${wo()}/issue`, { lotId: lot, quantity: '1' }, 201)
    await handle('inventory.moved', (payload) => payload.moveId === issued.issue.moves[0].id)
    expect((await entriesOf(wo())).find((entry) => entry.stockMoveId === issued.issue.moves[0].id)).toMatchObject({ kind: 'MATERIAL', amount: 310, costingMethod: 'STANDARD' })
    const view = (await ok('finance', 'GET', `/costing/method?companyId=${companyA}`)).method
    expect(view).toMatchObject({ method: 'STANDARD', locked: true, open: false, lockedById: SYSTEM_ACTOR_ID })
    expect(view.words).toMatch(/locked since \d{4}-\d{2}-\d{2}: cost entries rely on it, and changing it would revalue them/)
    const settings = await admin<{ version: number }>('SELECT version FROM "CostingSettings" WHERE id = $1', [companyA])
    await expect(chooseMethod(manager, { companyId: companyA, method: 'FIFO', version: settings[0]!.version })).rejects.toThrow(/locked since .*: cost entries rely on it, and changing it would revalue them/)
    await expect(admin('UPDATE "CostingSettings" SET "costingMethod" = \'FIFO\' WHERE id = $1', [companyA])).rejects.toThrow(/never changes/)
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'costing_method.changed' ORDER BY "occurredAt"`)
    expect(events.map((event) => event.payload.change)).toEqual(['chosen', 'locked'])
  })
})
