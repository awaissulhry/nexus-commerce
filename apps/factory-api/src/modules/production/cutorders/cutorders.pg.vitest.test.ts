import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { cutOrders as cutOrdersExport } from '../../../platform/exports/sources/cut-orders'
import cutOrderIndexer from '../../../platform/search/indexers/cut-order'
import { completeContext, testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Cut orders and cut tickets (B-W2b-112; MES-034, MES-037, MES-041, MES-043) through the app's real routes on a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security and the …_cutting_room_w2b_guards triggers
 * are real), tenant A from EVERY seed, tenant B bare. Made up here: two released work orders of black SEED-JKT-02 (their cells
 * take the grey lining and the black leather), a lining lot of 300 m tagged into rolls of two shades, two widths and two
 * shrinkage groups, and a label printer. In order:
 *   - the cells waiting per material; a fabric cut order over both work orders (marker, ratio, plies, two lays) and its refusals;
 *   - re-planned, released with a ticket per lay; rolls by shade, width and shrinkage: the candidates, the proposal, allocation
 *     and its refusals, a roll taken off;
 *   - at the table: the ticket's card, the start scan, the end scan once the lay was counted (B-W2b-116's spread and count
 *     routes), the cut order CUT with its last lay; ply stickers numbered, printed, voided and numbered again;
 *   - a leather cut order: its ticket voided and replaced, started, finished; back to planning and cancelled; the scopes.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/production/cutorders`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'cutorders-a'
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
const idem = () => `co-${run}-${++serial}`

const id = (key: string) => seedUuid(NS, key)
const A = {
  tenant: id('tenant'),
  actor: id('actor'),
  companyA: id('company:A'),
  siteA1: id('site:A1'),
  siteB1: id('site:B1'),
  companyB: id('company:B'),
  brand: id('party:P1'),
  style: id('production:style:JKT-02'),
  blk: id('production:colourway:JKT-02:BLK'),
  lining: id('product:item:lining'),
  liningGrey: id('product:item-colour:lining:GRY'),
  leather: id('product:item:leather'),
  leatherBlack: id('product:item-colour:leather:BLK'),
  bin: id('inventory:location:A1-STORE-01'),
  station: id('site:A1:station:CUT-01'),
  device: id('device:A1:cutting'),
  deviceB1: id('device:B1:cutting'),
  operator: id('worker:A1:operator'),
  operatorB1: id('worker:B1:operator'),
}
const tenantB = newId()
const printer = newId()

const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const PLAN: Permission[] = ['production.cutting.view', 'production.cutorders.manage', 'print.view', 'print.labels']
const FLOOR: Permission[] = ['floor.work', 'production.cut', 'print.view', 'print.labels']
const SESSIONS: Record<string, SessionContext> = {
  planner: office(A.tenant, [grant(PLAN)]),
  viewer: office(A.tenant, [grant(['production.cutting.view'])]),
  orders: office(A.tenant, [grant(['workorders.view', 'workorders.manage', 'workorders.release'])]),
  keeper: office(A.tenant, [grant(['inventory.stock.view', 'inventory.receive', 'inventory.rolls.manage'])]),
  companyB: office(A.tenant, [grant(PLAN, { companies: [A.companyB] })]),
  otherTenant: office(tenantB, [grant(PLAN)]),
  floor: { audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1, deviceId: A.device, grants: [grant(FLOOR, { companies: [A.companyA], sites: [A.siteA1] })] },
  floorB1: { audience: 'floor', tenantId: A.tenant, actorId: A.operatorB1, siteId: A.siteB1, deviceId: A.deviceB1, grants: [grant(FLOOR, { companies: [A.companyB], sites: [A.siteB1] })] },
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
type Method = 'GET' | 'POST' | 'PUT'
const call = (session: string, method: Method, url: string, payload?: unknown, key: string = idem()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const refusal = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row) => row.payload)
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : [])
const MONEY = /cost|price|margin|amount|wage|valuation/i
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction(work, { timeout: 30_000 }))

/** A CONFIRMED order of black SEED-JKT-02 and its released work order (the work-order routes). */
async function releasedWorkOrder(tag: string, sizes: Record<string, number>): Promise<Json> {
  const orderId = newId()
  const lineId = newId()
  const pieces = Object.values(sizes).reduce((sum, value) => sum + value, 0)
  await asOffice(async (tx) => {
    await tx.salesOrder.create({
      data: { id: orderId, companyId: A.companyA, partyId: A.brand, number: `T-${run}-${tag}`, status: 'CONFIRMED', orderDate: new Date('2026-10-20T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-10T00:00:00.000Z'), depositRequired: false },
      select: { id: true },
    })
    await tx.salesOrderLine.create({
      data: { id: lineId, companyId: A.companyA, orderId, partyId: A.brand, seq: 10, kind: 'SIZE_GRID', styleId: A.style, colourwayId: A.blk, quantity: pieces, unitPrice: '100.000000', netAmount: pieces * 10_000, vatRatePct: '22.00', vatAmount: pieces * 2_200, siteId: A.siteA1 },
      select: { id: true },
    })
    for (const [size, quantity] of Object.entries(sizes)) await tx.salesOrderLineSize.create({ data: { id: newId(), lineId, partyId: A.brand, size, quantity }, select: { id: true } })
  })
  const { workOrder } = await ok('orders', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: lineId, sizes: Object.entries(sizes).map(([size, quantity]) => ({ size, quantity })) }] }, 201)
  const released = await ok('orders', 'POST', `/production/work-orders/${workOrder.id}/release`, { materialOverride: { reason: 'The lining arrives tomorrow' } })
  return released.workOrder
}
const cellOf = (workOrder: Json, size: string): string => workOrder.cells.find((cell: Json) => cell.size === size).id

const WO: Record<'a' | 'b', Json> = {} as Record<'a' | 'b', Json>
const R: Record<string, Json> = {}
const lotId = newId()

beforeAll(async () => {
  db = await migratedDatabase('production_cutorders')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  await admin(`INSERT INTO "Tenant" (id, slug, name) VALUES ($1, 'cutorders-b', 'Gruppo Nuovo')`, [tenantB])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  WO.a = await releasedWorkOrder('A', { '50': 20, '52': 30 })
  WO.b = await releasedWorkOrder('B', { '52': 10, '54': 20 })
  // A grey lining lot of 300 m at A1-STORE-01, tagged into rolls through the rolls route (made-up figures).
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "qualityStatus", "qualityDecidedAt", "receivedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, 'RELEASED', now(), now())`,
    [lotId, A.tenant, A.companyA, A.siteA1, A.lining, A.liningGrey, `T-${run}-LIN`],
  )
  await admin(
    `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt") VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, '300.0000', 'M', '300.0000', $9, now())`,
    [newId(), A.tenant, A.companyA, A.siteA1, A.lining, A.liningGrey, lotId, A.bin, `cutorders-${run}-lot`],
  )
  const tagged = await ok('keeper', 'POST', `/inventory/lots/${lotId}/rolls`, {
    locationId: A.bin,
    rolls: [
      { length: '60', widthCm: '150', shade: 'A', shrinkageGroup: 'S1', supplierRollRef: 'one' },
      { length: '50', widthCm: '150', shade: 'A', shrinkageGroup: 'S1', supplierRollRef: 'two' },
      { length: '60', widthCm: '150', shade: 'B', shrinkageGroup: 'S1', supplierRollRef: 'three' },
      { length: '60', widthCm: '130', shade: 'A', shrinkageGroup: 'S1', supplierRollRef: 'narrow' },
      { length: '60', widthCm: '150', shade: 'A', shrinkageGroup: 'S2', supplierRollRef: 'shrinks' },
      { length: '5', widthCm: '150', shade: 'A', shrinkageGroup: 'S1', supplierRollRef: 'end' },
    ],
  }, 201)
  for (const roll of tagged.rolls as Json[]) R[roll.supplierRollRef] = roll
  await admin(`INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", dpi, "labelWidthMm", "labelHeightMm") VALUES ($1, $2, $3, $4, 'LBL-CUT', 'Cutting label printer', 'LABEL_ZPL', 'FAKE', 'test-label:9100', 203, 100, 60)`, [printer, A.tenant, A.companyA, A.siteA1])
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

const CO: Record<string, Json> = {}

describe('cut orders over several work orders (MES-034)', () => {
  it('lists the cells waiting per material and colour', async () => {
    const waiting = await ok('viewer', 'GET', `/production/cut-orders/waiting?siteId=${A.siteA1}`)
    const lining = waiting.groups.find((group: Json) => group.item.id === A.lining && group.colour?.id === A.liningGrey)
    expect(lining).toMatchObject({ kind: 'FABRIC', siteId: A.siteA1 })
    const mine = lining.cells.filter((cell: Json) => [WO.a.id, WO.b.id].includes(cell.workOrder.id))
    expect(mine.map((cell: Json) => `${cell.workOrder.id === WO.a.id ? 'A' : 'B'} ${cell.size} ${cell.left}`).sort()).toEqual(['A 50 20', 'A 52 30', 'B 52 10', 'B 54 20'])
    // The seed's cut orders already cut every cell of SEED-WO-0001 in the lining: none of them waits.
    expect(lining.cells.some((cell: Json) => cell.workOrder.number === 'SEED-WO-0001')).toBe(false)
    expect(waiting.groups.some((group: Json) => group.kind === 'LEATHER' && group.item.id === A.leather)).toBe(true)
    // The protector is tracked by lot but counted in pieces: no cut order cuts it.
    expect(waiting.groups.every((group: Json) => group.item.code !== 'SEED-PRO-300')).toBe(true)
  })

  it('plans a fabric cut order over both work orders, and refuses what does not fit', async () => {
    const body = {
      siteId: A.siteA1,
      kind: 'FABRIC',
      itemId: A.lining,
      itemColourId: A.liningGrey,
      stationId: A.station,
      dueDate: '2026-12-01',
      marker: { name: 'MK-T1', length: '2', uom: 'M', widthCm: '140' },
      plies: 10,
      lays: [6, 4],
      lines: [
        { workOrderSizeId: cellOf(WO.a, '50'), ratio: 2 },
        { workOrderSizeId: cellOf(WO.a, '52'), ratio: 3 },
        { workOrderSizeId: cellOf(WO.b, '52'), ratio: 1 },
        { workOrderSizeId: cellOf(WO.b, '54'), ratio: 2 },
      ],
    }
    const made = await ok('planner', 'POST', '/production/cut-orders', body, 201)
    CO.fabric = made
    expect(made.cutOrder).toMatchObject({ kind: 'FABRIC', status: 'PLANNED', garments: 80, plies: 10, lays: { count: 2, cut: 0, open: 2 }, station: { code: 'CUT-01' }, dueDate: '2026-12-01' })
    expect(made.cutOrder.number).toMatch(/^CO-\d{4}-\d{4}$/)
    expect(made.cutOrder.marker).toMatchObject({ name: 'MK-T1', length: '2.0000', uom: 'M', widthCm: '140.00', ratio: '50:2 · 52:4 · 54:2', garmentsPerPly: 8 })
    expect(made.cutOrder.words).toEqual({ it: '2 materassi · 10 strati · 80 capi', en: '2 lays · 10 plies · 80 garments' })
    expect(made.cutOrder.workOrders.map((order: Json) => order.id).sort()).toEqual([WO.a.id, WO.b.id].sort())
    expect(made.lines.map((line: Json) => [line.size, line.ratio, line.plies, line.quantity])).toEqual([
      ['50', 2, 10, 20],
      ['52', 3, 10, 30],
      ['52', 1, 10, 10],
      ['54', 2, 10, 20],
    ])
    expect(made.lays.map((lay: Json) => [lay.seq, lay.plies, lay.status])).toEqual([
      [1, 6, 'PLANNED'],
      [2, 4, 'PLANNED'],
    ])
    expect(made.can).toEqual({ edit: true, release: true, backToPlanning: false, cancel: true, allocate: false })
    expect(keysOf(made).filter((key) => MONEY.test(key))).toEqual([])
    expect((await events('cut_order.changed')).at(-1)).toMatchObject({ cutOrderId: made.cutOrder.id, change: 'PLANNED', status: 'PLANNED' })

    // Every garment of these cells is on it now: another cut order of the lining gets none of them.
    const full = await refused('planner', 'POST', '/production/cut-orders', { ...body, plies: 1, lays: undefined, lines: [{ workOrderSizeId: cellOf(WO.a, '50'), ratio: 1 }] }, 409)
    expect(refusal(full)).toBe('refusal/CELL_FULL')
    expect(full.message).toContain('so 0 are left, not 1')
    // The lining is not leather; the lays add up to the plies; a cell once; a draft work order is not cut.
    expect(refusal(await refused('planner', 'POST', '/production/cut-orders', { siteId: A.siteA1, kind: 'LEATHER', itemId: A.lining, lines: [{ workOrderSizeId: cellOf(WO.a, '50'), quantity: 1 }] }, 409))).toBe('refusal/NOT_A_CUT_MATERIAL')
    expect(refusal(await refused('planner', 'POST', '/production/cut-orders', { ...body, lays: [6, 5] }, 400))).toBe('body/lays')
    expect(refusal(await refused('planner', 'POST', '/production/cut-orders', { ...body, lines: [body.lines[0], body.lines[0]] }, 400))).toBe('body/lines/1/workOrderSizeId')
    const draftCell = (await admin<{ id: string }>(`SELECT z.id FROM "WorkOrderSize" z JOIN "WorkOrder" w ON w.id = z."workOrderId" WHERE w.number = 'SEED-WO-0002' AND w."tenantId" = $1`, [A.tenant]))[0]!.id
    expect(refusal(await refused('planner', 'POST', '/production/cut-orders', { ...body, plies: 1, lays: undefined, lines: [{ workOrderSizeId: draftCell, ratio: 1 }] }, 409))).toBe('refusal/WORK_ORDER_NOT_OPEN')
    // Who may: read-only is refused, another company's planner and another tenant do not see it.
    await refused('viewer', 'POST', '/production/cut-orders', body, 403)
    await refused('floor', 'POST', '/production/cut-orders', body, 403)
    await refused('companyB', 'GET', `/production/cut-orders/${made.cutOrder.id}`, undefined, 404)
    await refused('otherTenant', 'GET', `/production/cut-orders/${made.cutOrder.id}`, undefined, 404)
    const list = await ok('viewer', 'GET', `/production/cut-orders?siteId=${A.siteA1}&q=MK-T1`)
    expect(list.rows.map((row: Json) => row.id)).toEqual([made.cutOrder.id])
    expect((await ok('viewer', 'GET', '/production/cut-orders?view=all&kind=LEATHER')).rows.every((row: Json) => row.kind === 'LEATHER')).toBe(true)
    expect((await ok('viewer', 'GET', '/production/cut-orders')).tiles.planned).toBeGreaterThanOrEqual(2)
  })

  it('re-plans while PLANNED: the lays follow the new split', async () => {
    const before = CO.fabric!
    const replanned = await ok('planner', 'PUT', `/production/cut-orders/${before.cutOrder.id}`, {
      version: before.cutOrder.version,
      stationId: A.station,
      marker: { name: 'MK-T1', length: '2', uom: 'M', widthCm: '140' },
      plies: 10,
      lays: [5, 3, 2],
      lines: before.lines.map((line: Json) => ({ workOrderSizeId: line.workOrderSizeId, ratio: line.ratio })),
    })
    expect(replanned.lays.map((lay: Json) => [lay.seq, lay.plies, lay.status])).toEqual([
      [1, 5, 'PLANNED'],
      [2, 3, 'PLANNED'],
      [3, 2, 'PLANNED'],
    ])
    const back = await ok('planner', 'PUT', `/production/cut-orders/${before.cutOrder.id}`, {
      version: replanned.cutOrder.version,
      stationId: A.station,
      marker: { name: 'MK-T1', length: '2', uom: 'M', widthCm: '140' },
      plies: 10,
      lays: [6, 4],
      lines: before.lines.map((line: Json) => ({ workOrderSizeId: line.workOrderSizeId, ratio: line.ratio })),
    })
    expect(back.lays.map((lay: Json) => [lay.seq, lay.plies, lay.status])).toEqual([
      [1, 6, 'PLANNED'],
      [2, 4, 'PLANNED'],
      [3, 2, 'CANCELLED'],
    ])
    expect(back.cutOrder.lays).toEqual({ count: 2, cut: 0, open: 2 })
    // A stale version is refused.
    expect((await refused('planner', 'PUT', `/production/cut-orders/${before.cutOrder.id}`, { version: before.cutOrder.version, plies: 10, lines: back.lines.map((line: Json) => ({ workOrderSizeId: line.workOrderSizeId, ratio: line.ratio })) }, 409)).issues).toEqual([
      { path: 'version', message: `The current version is ${back.cutOrder.version}.` },
    ])
    CO.fabric = back
  })

  it('releases it with a ticket per lay', async () => {
    const released = await ok('planner', 'POST', `/production/cut-orders/${CO.fabric!.cutOrder.id}/release`, { version: CO.fabric!.cutOrder.version })
    expect(released.cutOrder.status).toBe('RELEASED')
    expect(released.tickets.map((ticket: Json) => [ticket.laySeq, ticket.status])).toEqual([
      [1, 'OPEN'],
      [2, 'OPEN'],
    ])
    expect(released.tickets.every((ticket: Json) => ticket.code === ticket.number && /^CTA-\d{4}-\d{5}$/.test(ticket.number))).toBe(true)
    expect(released.lays.slice(0, 2).map((lay: Json) => lay.ticket?.number)).toEqual(released.tickets.map((ticket: Json) => ticket.number))
    expect(released.can).toMatchObject({ edit: false, release: false, backToPlanning: true, cancel: true, allocate: true })
    expect((await events('cut_ticket.changed')).filter((event) => event.cutOrderId === released.cutOrder.id).map((event) => event.change)).toEqual(['MADE', 'MADE'])
    // The plan is frozen now.
    expect(refusal(await refused('planner', 'PUT', `/production/cut-orders/${released.cutOrder.id}`, { version: released.cutOrder.version, plies: 10, lines: released.lines.map((line: Json) => ({ workOrderSizeId: line.workOrderSizeId, ratio: line.ratio })) }, 409))).toBe('refusal/NOT_PLANNED')
    CO.fabric = released
  })
})

describe('rolls by shade, width and shrinkage (MES-037)', () => {
  it('says what each roll gives and why not, and proposes one shade and shrinkage group per lay', async () => {
    const answer = await ok('viewer', 'GET', `/production/cut-orders/${CO.fabric!.cutOrder.id}/rolls`)
    expect(answer.perPlyMetres).toBe('2.0000')
    const byRef = (ref: string) => answer.rolls.find((roll: Json) => roll.id === R[ref]!.id)
    expect(byRef('one')).toMatchObject({ plies: 30, refusal: null, shade: 'A', shrinkageGroup: 'S1' })
    expect(byRef('two')).toMatchObject({ plies: 25, refusal: null })
    expect(byRef('narrow').refusal).toMatchObject({ code: 'ROLL_TOO_NARROW' })
    expect(byRef('end')).toMatchObject({ plies: 2, refusal: null })
    expect(answer.lays.map((lay: Json) => [lay.seq, lay.plies, lay.allocated, lay.proposable])).toEqual([
      [1, 6, 0, true],
      [2, 4, 0, true],
    ])
    // Each lay from ONE shade and shrinkage group, covering it.
    const rolls = new Map(answer.rolls.map((roll: Json) => [roll.id, roll]))
    for (const lay of answer.proposal) {
      expect(lay.short).toBe(0)
      expect(lay.rolls.reduce((sum: number, roll: Json) => sum + roll.plies, 0)).toBe(lay.need)
      const groups = new Set(lay.rolls.map((roll: Json) => JSON.stringify([(rolls.get(roll.rollId) as Json).shade, (rolls.get(roll.rollId) as Json).shadeGroup?.id ?? null, (rolls.get(roll.rollId) as Json).shrinkageGroup])))
      expect(groups.size).toBe(1)
      expect(lay.rolls.every((roll: Json) => (rolls.get(roll.rollId) as Json).refusal === null)).toBe(true)
    }
    expect(answer.words.en).toMatch(/^Lay 1: /)
    await refused('companyB', 'GET', `/production/cut-orders/${CO.fabric!.cutOrder.id}/rolls`, undefined, 404)
  })

  it('allocates rolls to a lay, and refuses another shade, another shrinkage group, a narrow or short roll, too many plies', async () => {
    const [lay1, lay2] = CO.fabric!.lays as Json[]
    const url = (lay: Json) => `/production/cut-orders/${CO.fabric!.cutOrder.id}/lays/${lay.id}/rolls`
    const one = await ok('planner', 'POST', url(lay1!), { version: lay1!.version, rolls: [{ rollId: R.one!.id, plies: 6 }] }, 201)
    expect(one.allocation).toMatchObject({ layId: lay1!.id, allocated: 6 })
    expect(one.lays[0]).toMatchObject({ allocated: 6, shade: 'A', shrinkageGroup: 'S1' })
    expect(one.lays[0].rolls.map((roll: Json) => [roll.code, roll.plies])).toEqual([[R.one!.code, 6]])
    const lay2Version = one.lays[1].version
    expect(refusal(await refused('planner', 'POST', url(lay2!), { version: lay2Version, rolls: [{ rollId: R.two!.id, plies: 2 }, { rollId: R.three!.id, plies: 2 }] }, 409))).toBe('refusal/MIXED_SHADE')
    expect(refusal(await refused('planner', 'POST', url(lay2!), { version: lay2Version, rolls: [{ rollId: R.two!.id, plies: 2 }, { rollId: R.shrinks!.id, plies: 2 }] }, 409))).toBe('refusal/MIXED_SHRINKAGE')
    expect(refusal(await refused('planner', 'POST', url(lay2!), { version: lay2Version, rolls: [{ rollId: R.narrow!.id, plies: 2 }] }, 409))).toBe('refusal/ROLL_TOO_NARROW')
    const short = await refused('planner', 'POST', url(lay2!), { version: lay2Version, rolls: [{ rollId: R.end!.id, plies: 3 }] }, 409)
    expect(refusal(short)).toBe('refusal/ROLL_SHORT')
    expect(short.message).toContain('gives 2 plies')
    expect(refusal(await refused('planner', 'POST', url(lay2!), { version: lay2Version, rolls: [{ rollId: R.two!.id, plies: 5 }] }, 409))).toBe('refusal/LAY_FULL')
    // What lay 1 plans of roll one (6 plies, 12 m) is not free for another lay: 24 plies are left of it.
    const candidates = await ok('viewer', 'GET', `/production/cut-orders/${CO.fabric!.cutOrder.id}/rolls`)
    expect(candidates.rolls.find((roll: Json) => roll.id === R.one!.id)).toMatchObject({ planned: '12.0000', plies: 24 })
    expect(candidates.rolls.find((roll: Json) => roll.id === R.one!.id).allocatedTo).toEqual([{ cutOrderNumber: CO.fabric!.cutOrder.number, laySeq: 1, plies: 6 }])
    // The lay of another shade: a warning on the cut order, not a refusal.
    const two = await ok('planner', 'POST', url(lay2!), { version: lay2Version, rolls: [{ rollId: R.three!.id, plies: 4 }] }, 201)
    expect(two.warnings.map((warning: Json) => warning.code)).toEqual(['SHADES_ACROSS_LAYS'])
    // Taken off again (a roll of shade A replaces it).
    const taken = await ok('planner', 'POST', `${url(lay2!)}/${two.lays[1].rolls[0].id}/remove`, { version: two.lays[1].version })
    expect(taken.lays[1]).toMatchObject({ allocated: 0, rolls: [] })
    const final = await ok('planner', 'POST', url(lay2!), { version: taken.lays[1].version, rolls: [{ rollId: R.two!.id, plies: 4 }] }, 201)
    expect(final.warnings).toEqual([])
    await refused('viewer', 'POST', url(lay2!), { version: final.lays[1].version, rolls: [{ rollId: R.two!.id, plies: 1 }] }, 403)
    expect((await events('cut_order.changed')).filter((event) => event.cutOrderId === CO.fabric!.cutOrder.id).map((event) => event.change)).toEqual([
      'PLANNED',
      'PLAN_CHANGED',
      'PLAN_CHANGED',
      'RELEASED',
      'ROLLS_ALLOCATED',
      'ROLLS_ALLOCATED',
      'ROLLS_REMOVED',
      'ROLLS_ALLOCATED',
    ])
    CO.fabric = final
  })
})

/** B-W2b-116's routes at the table: the lay spread from its allocated rolls, both ends counted. */
async function countLay(layId: string, plies: number) {
  await ok('floor', 'POST', `/production/lays/${layId}/spread`, {})
  await ok('floor', 'POST', `/production/lays/${layId}/count`, { left: plies, right: plies })
}

describe('cut tickets at the table (MES-041) and ply numbering (MES-043)', () => {
  it('starts from the ticket, scans it at the start and at the end once the lay is counted', async () => {
    const [ticket1, ticket2] = CO.fabric!.tickets as Json[]
    const card = await ok('floor', 'GET', `/production/cut-tickets/scan?code=${encodeURIComponent(ticket1!.code.toLowerCase())}`)
    expect(card.cutOrder).toMatchObject({ number: CO.fabric!.cutOrder.number, ratio: '50:2 · 52:4 · 54:2', plies: 10, marker: { name: 'MK-T1', words: { en: '2 m', it: '2 m' } } })
    expect(card.lay).toMatchObject({ seq: 1, of: 2, plies: 6, status: 'PLANNED', counted: null })
    expect(card.lay.rolls.map((roll: Json) => roll.code)).toEqual([R.one!.code])
    expect(card.next).toMatchObject({ next: 'START', refusal: null, words: { en: 'Scan to start cutting.' } })
    expect(keysOf(card).filter((key) => MONEY.test(key) || /worker/i.test(key))).toEqual([])
    const waiting = await ok('floor', 'GET', '/production/cut-tickets/waiting')
    expect(waiting.tickets.filter((ticket: Json) => ticket.cutOrder.id === CO.fabric!.cutOrder.id).map((ticket: Json) => [ticket.laySeq, ticket.ratio])).toEqual([
      [1, '50:2 · 52:4 · 54:2'],
      [2, '50:2 · 52:4 · 54:2'],
    ])
    await refused('floorB1', 'GET', `/production/cut-tickets/scan?code=${ticket1!.code}`, undefined, 404)

    const started = await ok('floor', 'POST', '/production/cut-tickets/start', { code: ticket1!.code })
    expect(started).toMatchObject({ ticket: { status: 'STARTED' }, cutOrder: { status: 'IN_PROGRESS' }, next: { next: 'FINISH' }, replayed: false })
    expect(refusal(await refused('floor', 'POST', '/production/cut-tickets/start', { code: ticket1!.code }, 409))).toBe('refusal/TICKET_STARTED')
    const early = await refused('floor', 'POST', '/production/cut-tickets/finish', { code: ticket1!.code }, 409)
    expect(refusal(early)).toBe('refusal/PLIES_NOT_COUNTED')
    expect(early.message).toBe('Lay 1 is planned: count its plies at both ends before the cut is done.')
    expect(refusal(await refused('floor', 'POST', '/production/cut-tickets/finish', { code: ticket2!.code }, 409))).toBe('refusal/TICKET_NOT_STARTED')
    await refused('planner', 'POST', '/production/cut-tickets/start', { code: ticket2!.code }, 403)
    // Back to planning is refused once a ticket was scanned (the cut order runs).
    const running = await ok('viewer', 'GET', `/production/cut-orders/${CO.fabric!.cutOrder.id}`)
    expect(refusal(await refused('planner', 'POST', `/production/cut-orders/${CO.fabric!.cutOrder.id}/unrelease`, { version: running.cutOrder.version, reason: 'Wrong marker' }, 409))).toBe('refusal/NOT_AT_TABLE')

    await countLay(CO.fabric!.lays[0].id, 6)
    const finished = await ok('floor', 'POST', '/production/cut-tickets/finish', { code: ticket1!.code })
    expect(finished).toMatchObject({ ticket: { status: 'DONE' }, lay: { status: 'CUT', counted: 6 }, cutOrder: { status: 'IN_PROGRESS' }, next: { next: 'NONE' } })
    expect(refusal(await refused('floor', 'POST', '/production/cut-tickets/finish', { code: ticket1!.code }, 409))).toBe('refusal/TICKET_DONE')
    // The same scan resent under its key answers what it did.
    const key = idem()
    await ok('floor', 'POST', '/production/cut-tickets/start', { code: ticket2!.code }, 200, key)
    expect((await ok('floor', 'POST', '/production/cut-tickets/start', { code: ticket2!.code }, 200, key)).replayed).toBe(true)
    const audit = await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id`, [ticket1!.id])
    expect(audit.map((row) => row.action)).toEqual(['production.startCutTicket', 'production.finishCutTicket'])
  })

  it('numbers a counted lay\'s plies with stickers, prints them, voids a misprint and numbers again', async () => {
    const lay1 = CO.fabric!.lays[0] as Json
    const made = await ok('floor', 'POST', `/production/lays/${lay1.id}/ply-runs`, { parts: ['Body lining', 'Sleeve lining'], printerId: null, language: 'en' }, 201)
    // 8 garments a ply × 2 parts = 16 stickers a ply; 6 plies.
    expect(made).toMatchObject({ stickersPerPly: 16, run: { firstPly: 1, lastPly: 6, labelCount: 96, status: 'PLANNED', parts: ['Body lining', 'Sleeve lining'] }, job: null })
    expect(made.preview).toHaveLength(16)
    expect(made.preview[0]).toEqual(['Ply 1 · 50', 'Body lining', `${CO.fabric!.cutOrder.number} · Lay 1 · 1/2`])
    const again = await refused('floor', 'POST', `/production/lays/${lay1.id}/ply-runs`, { parts: ['Body lining'], printerId: null }, 409)
    expect(refusal(again)).toBe('refusal/PLIES_NUMBERED')
    // Lay 2 is not counted yet.
    expect(refusal(await refused('floor', 'POST', `/production/lays/${CO.fabric!.lays[1].id}/ply-runs`, { parts: ['Body lining'], printerId: null }, 409))).toBe('refusal/PLIES_NOT_COUNTED')
    // Printed on the cutting label printer: one job of 96 stickers, the run PRINTED.
    const printed = await ok('floor', 'POST', `/production/ply-runs/${made.run.id}/print`, { printerId: printer, language: 'it' })
    expect(printed.run).toMatchObject({ status: 'PRINTED' })
    expect(printed.job).toMatchObject({ printerId: printer, status: 'QUEUED', labelKind: 'PLY' })
    const zpl = (await admin<{ zpl: string }>(`SELECT zpl FROM "PrintJob" WHERE id = $1`, [printed.job.id]))[0]!.zpl
    expect(zpl.match(/\^XA/g)).toHaveLength(96)
    // Text goes through ^FH: the middle dot is its UTF-8 bytes.
    expect(zpl).toContain('Strato 6 _C2_B7 54')
    const stickers = await ok('floor', 'GET', `/production/ply-runs/${made.run.id}/stickers?language=en`)
    expect(stickers.stickers).toHaveLength(96)
    expect(stickers.stickers.at(-1)).toMatchObject({ ply: 6, size: '54', garment: 2, garments: 2, part: 'Sleeve lining' })
    const voided = await ok('floor', 'POST', `/production/ply-runs/${made.run.id}/void`, { version: printed.run.version, reason: 'Printer jammed' })
    expect(voided.run).toMatchObject({ status: 'VOID', voidReason: 'Printer jammed' })
    const second = await ok('floor', 'POST', `/production/lays/${lay1.id}/ply-runs`, { parts: ['Body lining'], firstPly: 1, lastPly: 3, printerId: null }, 201)
    expect(second.run).toMatchObject({ seq: 2, firstPly: 1, lastPly: 3, labelCount: 24 })
    expect((await events('ply_run.changed')).map((event) => event.change)).toEqual(['MADE', 'PRINTED', 'VOIDED', 'MADE'])
  })

  it('cuts the last lay: the cut order is CUT; the office prints and voids tickets', async () => {
    const ticket2 = CO.fabric!.tickets[1] as Json
    // The office prints a ticket on the label printer (it is STARTED: the table still works from it).
    const printed = await ok('planner', 'POST', `/production/cut-tickets/${ticket2.id}/print`, { printerId: printer, language: 'en' })
    expect(printed.job).toMatchObject({ printerId: printer, labelKind: 'CUT_TICKET', scanId: ticket2.code })
    expect(printed.label).toMatchObject({ title: expect.stringContaining('Lay 2/2 · 4 plies') })
    expect(printed.ticket.printedAt).not.toBeNull()
    const zpl = (await admin<{ zpl: string }>(`SELECT zpl FROM "PrintJob" WHERE id = $1`, [printed.job.id]))[0]!.zpl
    expect(zpl).toContain(`^FD${ticket2.code}^FS`)
    await countLay(CO.fabric!.lays[1].id, 4)
    const finished = await ok('floor', 'POST', '/production/cut-tickets/finish', { code: ticket2.code })
    expect(finished).toMatchObject({ ticket: { status: 'DONE' }, lay: { status: 'CUT' }, cutOrder: { status: 'CUT' } })
    const record = await ok('viewer', 'GET', `/production/cut-orders/${CO.fabric!.cutOrder.id}`)
    expect(record.cutOrder).toMatchObject({ status: 'CUT', lays: { count: 2, cut: 2, open: 0 }, tickets: { open: 0, started: 0, done: 2 } })
    expect(record.cutOrder.cutAt).not.toBeNull()
    expect(record.can).toEqual({ edit: false, release: false, backToPlanning: false, cancel: false, allocate: false })
    expect((await events('cut_order.changed')).filter((event) => event.cutOrderId === CO.fabric!.cutOrder.id).slice(-2).map((event) => event.change)).toEqual(['STARTED', 'CUT'])
    expect(refusal(await refused('planner', 'POST', `/production/cut-tickets/${ticket2.id}/print`, {}, 409))).toBe('refusal/TICKET_DONE')
  })
})

describe('leather cut orders, back to planning and cancel', () => {
  it('voids a lost ticket with its replacement, then cuts with the new one', async () => {
    const made = await ok('planner', 'POST', '/production/cut-orders', { siteId: A.siteA1, kind: 'LEATHER', itemId: A.leather, itemColourId: A.leatherBlack, lines: [{ workOrderSizeId: cellOf(WO.a, '50'), quantity: 5 }] }, 201)
    expect(made.cutOrder).toMatchObject({ kind: 'LEATHER', plies: null, marker: null, garments: 5, words: { en: '5 garments' } })
    expect(made.lays).toEqual([])
    const released = await ok('planner', 'POST', `/production/cut-orders/${made.cutOrder.id}/release`, { version: made.cutOrder.version })
    expect(released.tickets.map((ticket: Json) => [ticket.layId, ticket.status])).toEqual([[null, 'OPEN']])
    const lost = released.tickets[0] as Json
    const replaced = await ok('planner', 'POST', `/production/cut-tickets/${lost.id}/void`, { version: lost.version, reason: 'Lost at the table', replace: true })
    expect(replaced.voided).toMatchObject({ status: 'VOID', voidReason: 'Lost at the table' })
    expect(replaced.replacement).toMatchObject({ status: 'OPEN' })
    expect(replaced.replacement.number).not.toBe(lost.number)
    const old = await refused('floor', 'POST', '/production/cut-tickets/start', { code: lost.code }, 409)
    expect(refusal(old)).toBe('refusal/TICKET_VOID')
    expect(old.message).toContain('Lost at the table')
    await ok('floor', 'POST', '/production/cut-tickets/start', { code: replaced.replacement.code })
    const done = await ok('floor', 'POST', '/production/cut-tickets/finish', { code: replaced.replacement.code })
    expect(done).toMatchObject({ ticket: { status: 'DONE' }, lay: null, cutOrder: { status: 'CUT' } })
    expect(refusal(await refused('planner', 'POST', `/production/cut-orders/${made.cutOrder.id}/cancel`, { version: (await ok('viewer', 'GET', `/production/cut-orders/${made.cutOrder.id}`)).cutOrder.version, reason: 'Too late' }, 409))).toBe('refusal/NOT_OPEN')
  })

  it('sends a released cut order back to planning (its tickets voided) and cancels it; its garments are free again', async () => {
    const made = await ok('planner', 'POST', '/production/cut-orders', { siteId: A.siteA1, kind: 'LEATHER', itemId: A.leather, itemColourId: A.leatherBlack, lines: [{ workOrderSizeId: cellOf(WO.b, '52'), quantity: 3 }] }, 201)
    const released = await ok('planner', 'POST', `/production/cut-orders/${made.cutOrder.id}/release`, { version: made.cutOrder.version })
    const back = await ok('planner', 'POST', `/production/cut-orders/${made.cutOrder.id}/unrelease`, { version: released.cutOrder.version, reason: 'Wrong table' })
    expect(back.cutOrder).toMatchObject({ status: 'PLANNED', releasedAt: null })
    expect(back.tickets.map((ticket: Json) => [ticket.status, ticket.voidReason])).toEqual([['VOID', 'Back to planning: Wrong table']])
    const waitingBefore = await ok('viewer', 'GET', `/production/cut-orders/waiting?itemId=${A.leather}&itemColourId=${A.leatherBlack}`)
    const cellBefore = waitingBefore.groups[0].cells.find((cell: Json) => cell.workOrderSizeId === cellOf(WO.b, '52'))
    expect(cellBefore).toMatchObject({ onCutOrders: 3, left: 7 })
    const cancelled = await ok('planner', 'POST', `/production/cut-orders/${made.cutOrder.id}/cancel`, { version: back.cutOrder.version, reason: 'The order changed' })
    expect(cancelled.cutOrder).toMatchObject({ status: 'CANCELLED', cancelReason: 'The order changed' })
    const waitingAfter = await ok('viewer', 'GET', `/production/cut-orders/waiting?itemId=${A.leather}&itemColourId=${A.leatherBlack}`)
    expect(waitingAfter.groups[0].cells.find((cell: Json) => cell.workOrderSizeId === cellOf(WO.b, '52'))).toMatchObject({ onCutOrders: 0, left: 10 })
    const audit = await admin<{ action: string; reason: string | null }>(`SELECT action, reason FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id`, [made.cutOrder.id])
    expect(audit.map((row) => [row.action, row.reason])).toEqual([
      ['production.planCutOrder', null],
      ['production.releaseCutOrder', null],
      ['production.unreleaseCutOrder', 'Wrong table'],
      ['production.cancelCutOrder', 'The order changed'],
    ])
  })
})

describe('search and export of cut orders', () => {
  it('indexes a cut order by number, material and work orders; exports the list as it reads', async () => {
    const [entry] = await asOffice((tx) => cutOrderIndexer.read(tx, { ids: [CO.fabric!.cutOrder.id] }, 10))
    expect(entry).toMatchObject({ recordId: CO.fabric!.cutOrder.id, companyId: A.companyA, siteId: A.siteA1, partyId: null, number: CO.fabric!.cutOrder.number, status: 'CUT' })
    expect(entry!.words).toEqual(expect.arrayContaining(['SEED-LIN-200', 'MK-T1', 'fabric', WO.a.number, WO.b.number]))
    const caller = callerFor(database, completeContext(SESSIONS.viewer!, newId()))
    const page = await cutOrdersExport.read(caller, cutOrdersExport.query(new URLSearchParams('view=all&q=MK-T1')), null, 50)
    expect((page.rows as Json[]).map((row) => row.number)).toEqual([CO.fabric!.cutOrder.number])
    const words = (code: string) => (cutOrdersExport.words!.en as Record<string, string>)[code] ?? code
    expect(cutOrdersExport.columns.lays!.value(page.rows[0], words)).toBe('2 of 2 cut')
  })
})
