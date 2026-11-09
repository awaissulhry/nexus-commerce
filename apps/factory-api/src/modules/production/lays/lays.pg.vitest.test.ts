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
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Lays at the table and the reconciliation of a cut order (B-W2b-116; MES-038, MES-039, MES-045, MES-046) through the app's real
 * routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the
 * …_cutting_room_w2b_guards triggers are real), tenant A from EVERY seed. Made up here: two released work orders of black
 * SEED-JKT-02, a grey lining lot of 300 m tagged into rolls (two shades, one end), a fabric cut order over both (marker 2 m, ratio
 * 50:2 · 52:4 · 54:2, lays of 6 and 4 plies) released with its tickets (B-W2b-112's routes). In order:
 *   - lay 1 at the table: spread from its started ticket, the allocated roll confirmed, a roll scanned, mixing shades refused, a
 *     full lay refused, Undo last roll; both ends counted (a difference refused and stored nowhere); a roll after the count sends
 *     it back; cut by the end scan; its fabric used confirmed, which issues it to both work orders roll by roll, and corrected;
 *   - lay 2: three plies of four; the cut order CUT; the reconciliation waits for the fabric used, asks a variance reason where cut
 *     differs from ordered, writes one row per line and RECONCILES the cut order; nothing changes after;
 *   - the seed's leather cut order (one line reconciled, one not) reconciled from the cut log; the scopes.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/production/lays`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'lays-a'
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
const idem = () => `lay-${run}-${++serial}`

const id = (key: string) => seedUuid(NS, key)
const A = {
  tenant: id('tenant'),
  actor: id('actor'),
  companyA: id('company:A'),
  companyB: id('company:B'),
  siteA1: id('site:A1'),
  siteB1: id('site:B1'),
  brand: id('party:P1'),
  style: id('production:style:JKT-02'),
  blk: id('production:colourway:JKT-02:BLK'),
  lining: id('product:item:lining'),
  liningGrey: id('product:item-colour:lining:GRY'),
  bin: id('inventory:location:A1-STORE-01'),
  station: id('site:A1:station:CUT-01'),
  device: id('device:A1:cutting'),
  deviceB1: id('device:B1:cutting'),
  operator: id('worker:A1:operator'),
  operatorB1: id('worker:B1:operator'),
}

const grant = (permissions: readonly Permission[], scope: Partial<Grant> = {}): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const PLAN: Permission[] = ['production.cutting.view', 'production.cutorders.manage', 'production.cut', 'inventory.issue', 'inventory.issue.over']
const FLOOR: Permission[] = ['floor.work', 'production.cut']
const SESSIONS: Record<string, SessionContext> = {
  planner: office([grant(PLAN)]),
  viewer: office([grant(['production.cutting.view'])]),
  orders: office([grant(['workorders.view', 'workorders.manage', 'workorders.release'])]),
  keeper: office([grant(['inventory.stock.view', 'inventory.receive', 'inventory.rolls.manage'])]),
  companyB: office([grant(PLAN, { companies: [A.companyB] })]),
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
      data: { id: orderId, companyId: A.companyA, partyId: A.brand, number: `L-${run}-${tag}`, status: 'CONFIRMED', orderDate: new Date('2026-10-20T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-10T00:00:00.000Z'), depositRequired: false },
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
const CO: Json = {}

beforeAll(async () => {
  db = await migratedDatabase('production_lays')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  WO.a = await releasedWorkOrder('A', { '50': 20, '52': 30 })
  WO.b = await releasedWorkOrder('B', { '52': 10, '54': 20 })
  // A grey lining lot of 300 m at A1-STORE-01, tagged into rolls through the rolls route (made-up figures).
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "qualityStatus", "qualityDecidedAt", "receivedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, 'RELEASED', now(), now())`,
    [lotId, A.tenant, A.companyA, A.siteA1, A.lining, A.liningGrey, `L-${run}-LIN`],
  )
  await admin(
    `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt") VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, '300.0000', 'M', '300.0000', $9, now())`,
    [newId(), A.tenant, A.companyA, A.siteA1, A.lining, A.liningGrey, lotId, A.bin, `lays-${run}-lot`],
  )
  const tagged = await ok('keeper', 'POST', `/inventory/lots/${lotId}/rolls`, {
    locationId: A.bin,
    rolls: [
      { length: '60', widthCm: '150', shade: 'A', shrinkageGroup: 'S1', supplierRollRef: 'one' },
      { length: '50', widthCm: '150', shade: 'A', shrinkageGroup: 'S1', supplierRollRef: 'two' },
      { length: '60', widthCm: '150', shade: 'B', shrinkageGroup: 'S1', supplierRollRef: 'three' },
      { length: '5', widthCm: '150', shade: 'A', shrinkageGroup: 'S1', supplierRollRef: 'end' },
    ],
  }, 201)
  for (const roll of tagged.rolls as Json[]) R[roll.supplierRollRef] = roll
  // The office plans and releases a fabric cut order over both work orders, and allocates roll one to lay 1 (B-W2b-112).
  const made = await ok('planner', 'POST', '/production/cut-orders', {
    siteId: A.siteA1,
    kind: 'FABRIC',
    itemId: A.lining,
    itemColourId: A.liningGrey,
    stationId: A.station,
    marker: { name: 'MK-L1', length: '2', uom: 'M', widthCm: '140' },
    plies: 10,
    lays: [6, 4],
    lines: [
      { workOrderSizeId: cellOf(WO.a, '50'), ratio: 2 },
      { workOrderSizeId: cellOf(WO.a, '52'), ratio: 3 },
      { workOrderSizeId: cellOf(WO.b, '52'), ratio: 1 },
      { workOrderSizeId: cellOf(WO.b, '54'), ratio: 2 },
    ],
  }, 201)
  const released = await ok('planner', 'POST', `/production/cut-orders/${made.cutOrder.id}/release`, { version: made.cutOrder.version })
  const allocated = await ok('planner', 'POST', `/production/cut-orders/${made.cutOrder.id}/lays/${released.lays[0].id}/rolls`, { version: released.lays[0].version, rolls: [{ rollId: R.one!.id, plies: 6 }] }, 201)
  Object.assign(CO, allocated)
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

const lay = (index: number): Json => CO.lays[index]
const ticket = (index: number): Json => CO.tickets[index]
const issuesOf = async (layId: string) =>
  admin<{ workOrderId: string; quantity: string; idempotencyKey: string }>(`SELECT "workOrderId", quantity::text, "idempotencyKey" FROM "StockMove" WHERE "tenantId" = $1 AND reason = 'ISSUE' AND "idempotencyKey" LIKE $2 ORDER BY "idempotencyKey"`, [A.tenant, `lay-fabric:${layId}:%`])

describe('the lay report at the table (MES-038)', () => {
  it('is spread from its started ticket; the allocated roll counts as spread', async () => {
    const before = await ok('floor', 'GET', `/production/lays/${lay(0).id}`)
    expect(before.lay).toMatchObject({ seq: 1, of: 2, plies: 6, status: 'PLANNED', plyMetres: '2.0000', counted: null })
    expect(before.rolls.map((roll: Json) => [roll.code, roll.plies, roll.used])).toEqual([[R.one!.code, 6, '12.0000']])
    expect(before.refusal).toMatchObject({ code: 'TICKET_NOT_STARTED' })
    expect(before.can).toEqual({ spread: false, count: false, fabricUsed: false })
    expect(keysOf(before).filter((key) => MONEY.test(key) || /worker/i.test(key))).toEqual([])
    expect(refusal(await refused('floor', 'POST', `/production/lays/${lay(0).id}/spread`, {}, 409))).toBe('refusal/TICKET_NOT_STARTED')
    await refused('floorB1', 'GET', `/production/lays/${lay(0).id}`, undefined, 404)
    await refused('viewer', 'GET', `/production/lays/${lay(0).id}`, undefined, 403)

    await ok('floor', 'POST', '/production/cut-tickets/start', { code: ticket(0).code })
    const short = await refused('floor', 'POST', `/production/lays/${lay(0).id}/spread`, { layLength: '190', uom: 'CM' }, 409)
    expect(refusal(short)).toBe('refusal/PLY_TOO_SHORT')
    expect(short.message).toBe('Lay 1: a ply of 190 cm is shorter than the marker (2 m).')
    const started = await ok('floor', 'POST', `/production/lays/${lay(0).id}/spread`, { layLength: '205', uom: 'CM' })
    expect(started).toMatchObject({ lay: { status: 'SPREADING', layLength: '205.0000', lengthUom: 'CM', plyMetres: '2.0500' }, spread: { plies: 6, rolls: 1, needed: 0 }, replayed: false })
    expect(started.spread.words).toEqual({ en: '6 plies · lay 2.05 m · 1 roll', it: '6 strati · materasso 2,05 m · 1 rotolo' })
  })

  it('confirms the allocated roll, takes a scanned roll, refuses another shade and a full lay, and undoes the last roll', async () => {
    const url = `/production/lays/${lay(0).id}/rolls`
    // The allocated roll scanned: its row takes what the table spread from it.
    const confirmed = await ok('floor', 'POST', url, { code: R.one!.code, plies: 4, splices: 1, endLoss: '30', uom: 'CM' }, 201)
    expect(confirmed.rolls.map((roll: Json) => [roll.code, roll.plies, roll.splices, roll.endLoss, roll.used])).toEqual([[R.one!.code, 4, 1, '0.3000', '8.5000']])
    expect(confirmed.spread).toMatchObject({ plies: 4, needed: 2 })
    expect(refusal(await refused('floor', 'POST', url, { code: R.three!.code }, 409))).toBe('refusal/MIXED_SHADE')
    // A roll scanned as it is printed or in lower case; its plies default to what the lay still needs.
    const two = await ok('floor', 'POST', url, { code: R.two!.code.toLowerCase() }, 201)
    expect(two.rolls.map((roll: Json) => [roll.code, roll.plies])).toEqual([
      [R.one!.code, 4],
      [R.two!.code, 2],
    ])
    expect(two.spread).toMatchObject({ plies: 6, rolls: 2, needed: 0, used: '12.6000' })
    const full = await refused('floor', 'POST', url, { code: R.end!.code }, 409)
    expect(refusal(full)).toBe('refusal/LAY_FULL')
    const undone = await ok('floor', 'POST', `${url}/undo`, { layRollId: two.rolls[1].id })
    expect(undone.rolls.map((roll: Json) => roll.code)).toEqual([R.one!.code])
    expect(refusal(await refused('floor', 'POST', `${url}/undo`, { layRollId: newId() }, 409))).toBe('refusal/NOT_LAST_ROLL')
    // The end roll (5 m) gives one ply of 2.05 m once 1 m is lost at its end: two are refused in words.
    const shortRoll = await refused('floor', 'POST', url, { code: R.end!.code, plies: 2, endLoss: '1' }, 409)
    expect(refusal(shortRoll)).toBe('refusal/ROLL_SHORT')
    expect(shortRoll.message).toBe(`Roll ${R.end!.code} has 5 m for this lay: 1 ply of 2.05 m, not 2. If it is longer, the warehouse measures it again.`)
    const again = await ok('floor', 'POST', url, { rollId: R.two!.id, plies: 2 }, 201)
    expect(again.spread).toMatchObject({ plies: 6, rolls: 2 })
    // A correction of a roll of the report.
    const corrected = await ok('floor', 'POST', `${url}/${again.rolls[1].id}`, { splices: 2 })
    expect(corrected.rolls[1]).toMatchObject({ plies: 2, splices: 2 })
    expect((await events('lay.changed')).filter((event) => event.layId === lay(0).id).map((event) => event.change)).toEqual(['SPREAD_STARTED', 'ROLL_CHANGED', 'ROLL_SPREAD', 'ROLL_UNDONE', 'ROLL_SPREAD', 'ROLL_CHANGED'])
  })
})

describe('the count at both ends (MES-039)', () => {
  it('refuses a difference in the design\'s words and stores nothing; equal to the plies spread → CHECKED', async () => {
    const url = `/production/lays/${lay(0).id}/count`
    const differ = await refused('floor', 'POST', url, { left: 6, right: 5 }, 409)
    expect(refusal(differ)).toBe('refusal/PLIES_DIFFER')
    expect(differ.message).toBe('Left 6, right 5. Recount before cutting.')
    expect((await admin(`SELECT status, "plyCountLeft", "plyCountRight" FROM "Lay" WHERE id = $1`, [lay(0).id]))[0]).toEqual({ status: 'SPREADING', plyCountLeft: null, plyCountRight: null })
    expect(refusal(await refused('floor', 'POST', url, { left: 5, right: 5 }, 409))).toBe('refusal/COUNT_NOT_SPREAD')
    const checked = await ok('floor', 'POST', url, { left: 6, right: 6 })
    expect(checked.lay).toMatchObject({ status: 'CHECKED', counted: { left: 6, right: 6 } })
    // A roll taken off after the count sends the lay back to spreading; the count is taken again.
    const back = await ok('floor', 'POST', `/production/lays/${lay(0).id}/rolls/undo`, {})
    expect(back.lay).toMatchObject({ status: 'SPREADING', counted: null })
    await ok('floor', 'POST', `/production/lays/${lay(0).id}/rolls`, { code: R.two!.code, plies: 2 }, 201)
    await ok('floor', 'POST', url, { left: 6, right: 6 })
    expect(refusal(await refused('floor', 'POST', `/production/lays/${lay(0).id}/fabric-used`, {}, 409))).toBe('refusal/LAY_NOT_CUT')
    const cut = await ok('floor', 'POST', '/production/cut-tickets/finish', { code: ticket(0).code })
    expect(cut).toMatchObject({ ticket: { status: 'DONE' }, lay: { status: 'CUT', counted: 6 } })
    expect(refusal(await refused('floor', 'POST', `/production/lays/${lay(0).id}/rolls`, { code: R.two!.code, plies: 1 }, 409))).toBe('refusal/LAY_NOT_OPEN')
    expect((await events('lay.changed')).filter((event) => event.layId === lay(0).id).slice(-5).map((event) => event.change)).toEqual(['COUNTED', 'BACK_TO_SPREADING', 'ROLL_UNDONE', 'ROLL_SPREAD', 'COUNTED'])
  })
})

describe('fabric used at cut finish (MES-046)', () => {
  it('shows the estimate, the lay report and the difference; the first confirmation issues the fabric roll by roll', async () => {
    const before = await ok('floor', 'GET', `/production/lays/${lay(0).id}`)
    expect(before.fabricUsed).toMatchObject({ posted: false, uom: 'M', plies: 6, estimated: '12.0000', recorded: '12.6000', confirmed: null, words: { en: '0.6 m more than the estimate (+5%).', it: '0,6 m in più della stima (+5%).' } })
    expect(before.can.fabricUsed).toBe(true)
    // An over-issue is the office's: the floor may not give its reason.
    await refused('floor', 'POST', `/production/lays/${lay(0).id}/fabric-used`, { overIssueReason: 'More fabric' }, 403)
    const key = idem()
    const confirmed = await ok('floor', 'POST', `/production/lays/${lay(0).id}/fabric-used`, {}, 200, key)
    expect(confirmed.fabricUsed).toMatchObject({ posted: true, confirmed: '12.6000', estimated: '12.0000', recorded: '12.6000' })
    // B-W2b-221 (PRD-105): company A's tolerance (the seed's ProductSettings) warns above 3 % for the lining: +5 % is a warning.
    expect(confirmed.warnings).toEqual([{ code: 'CONSUMPTION_ABOVE_TOLERANCE', message: '12.6 m of fabric is 0.6 m more than the estimate of 12 m (+5%): above the 3% tolerance.' }])
    expect((await ok('floor', 'POST', `/production/lays/${lay(0).id}/fabric-used`, {}, 200, key)).replayed).toBe(true)
    // Roll one gave 4 × 2.05 + 0.3 = 8.5 m, roll two 2 × 2.05 = 4.1 m; each split 5 : 3 between the work orders (garments a ply).
    const issues = await issuesOf(lay(0).id)
    const of = (rollId: string, workOrderId: string) => issues.filter((row) => row.idempotencyKey.startsWith(`lay-fabric:${lay(0).id}:${rollId}:${workOrderId}`)).map((row) => row.quantity)
    expect(of(R.one!.id, WO.a.id)).toEqual(['5.3125'])
    expect(of(R.one!.id, WO.b.id)).toEqual(['3.1875'])
    expect(of(R.two!.id, WO.a.id)).toEqual(['2.5625'])
    expect(of(R.two!.id, WO.b.id)).toEqual(['1.5375'])
    const rolls = await admin<{ id: string; lengthLeft: string; state: string }>(`SELECT id, "lengthLeft"::text, state FROM "FabricRoll" WHERE id = ANY($1::uuid[]) ORDER BY code`, [[R.one!.id, R.two!.id]])
    expect(new Map(rolls.map((row) => [row.id, [row.lengthLeft, row.state]]))).toEqual(
      new Map([
        [R.one!.id, ['51.5000', 'PARTIAL']],
        [R.two!.id, ['45.9000', 'PARTIAL']],
      ]),
    )
    // B-W2b-221 (PRD-105): with "must match", a figure that differs is refused until a note explains it (the database's owner sets it).
    await admin(`UPDATE "ProductSettings" SET "consumptionTolerance" = 'MATCH', "consumptionTolerancePct" = NULL WHERE id = $1`, [A.companyA])
    const unexplained = await refused('planner', 'POST', `/production/lays/${lay(0).id}/fabric-used`, { confirmed: '1290', uom: 'CM' }, 409)
    expect(refusal(unexplained)).toBe('refusal/CONSUMPTION_MUST_MATCH')
    expect(unexplained.message).toBe('The fabric used must match the estimate: 12.9 m is 0.9 m more than the estimate of 12 m (+7.5%). Say why in a note, or confirm 12 m.')
    // The cutter's correction changes the confirmed figure only.
    const corrected = await ok('planner', 'POST', `/production/lays/${lay(0).id}/fabric-used`, { confirmed: '1290', uom: 'CM', note: 'Two plies laid again' })
    expect(corrected.fabricUsed).toMatchObject({ confirmed: '12.9000', note: 'Two plies laid again', words: { en: '0.9 m more than the estimate (+7.5%).' } })
    expect(corrected.warnings).toEqual([])
    await admin(`UPDATE "ProductSettings" SET "consumptionTolerance" = 'WARN_ABOVE', "consumptionTolerancePct" = 3 WHERE id = $1`, [A.companyA])
    expect(await issuesOf(lay(0).id)).toHaveLength(4)
    const consumed = await events('cut_consumption.changed')
    expect(consumed.map((event) => [event.change, event.moveIds.length, event.workOrderIds.length])).toEqual([
      ['CONFIRMED', 4, 2],
      ['CORRECTED', 0, 0],
    ])
    expect((await events('fabric_roll.changed')).filter((event) => event.change === 'ISSUED').map((event) => event.rollId).sort()).toEqual([R.one!.id, R.two!.id].sort())
  })
})

describe('cut against ordered (MES-045)', () => {
  it('waits for every lay\'s fabric used, asks a reason where cut differs, and reconciles the cut order', async () => {
    // Lay 2: three plies of four (the lay ends short), cut; the cut order is CUT.
    await ok('floor', 'POST', '/production/cut-tickets/start', { code: ticket(1).code })
    await ok('floor', 'POST', `/production/lays/${lay(1).id}/spread`, {})
    // Through the tablet's queue (kept offline, applied in its order): the roll, a count that differs, the count.
    const queued = (seq: number, kind: string, payload: Json) => ({ clientEventId: `lay-${run}-q${seq}`, seq, kind, occurredAt: new Date(Date.now() - 60_000 + seq * 1000).toISOString(), workerId: A.operator, payload: { layId: lay(1).id, ...payload } })
    const sent = await ok('floor', 'POST', '/floor/sync', {
      events: [queued(1, 'production.lay.roll', { code: R.two!.code, plies: 3, endReturned: '39.9' }), queued(2, 'production.lay.count', { left: 3, right: 2 }), queued(3, 'production.lay.count', { left: 3, right: 3 })],
    })
    expect(sent.events.map((event: Json) => [event.status, event.refusal?.code ?? null])).toEqual([
      ['accepted', null],
      ['refused', 'PLIES_DIFFER'],
      ['accepted', null],
    ])
    const cut = await ok('floor', 'POST', '/production/cut-tickets/finish', { code: ticket(1).code })
    expect(cut.cutOrder.status).toBe('CUT')
    const url = `/production/cut-orders/${CO.cutOrder.id}`
    const waiting = await ok('viewer', 'GET', `${url}/reconciliation`)
    expect(waiting.refusal).toMatchObject({ code: 'FABRIC_NOT_CONFIRMED', message: expect.stringContaining('lay 2') })
    expect(waiting.can.reconcile).toBe(false)
    const record = await ok('viewer', 'GET', url)
    expect(refusal(await refused('planner', 'POST', `${url}/reconcile`, { version: record.cutOrder.version }, 409))).toBe('refusal/FABRIC_NOT_CONFIRMED')
    await ok('floor', 'POST', `/production/lays/${lay(1).id}/fabric-used`, {})

    const preview = await ok('planner', 'GET', `${url}/reconciliation`)
    expect(preview.refusal).toBeNull()
    expect(preview.can.reconcile).toBe(true)
    // 9 plies cut of 10: every line is short by its ratio.
    expect(preview.lines.map((line: Json) => [line.size, line.ordered, line.cut, line.difference, line.needsReason])).toEqual([
      ['50', 20, 18, -2, true],
      ['52', 30, 27, -3, true],
      ['52', 10, 9, -1, true],
      ['54', 20, 18, -2, true],
    ])
    expect(preview.sizes).toEqual([
      { size: '50', ordered: 20, cut: 18, recut: 0, difference: -2 },
      { size: '52', ordered: 40, cut: 36, recut: 0, difference: -4 },
      { size: '54', ordered: 20, cut: 18, recut: 0, difference: -2 },
    ])
    expect(preview.material.sum).toEqual({ estimated: '18.0000', recorded: '18.6000', used: '18.9000', issued: '18.6000', endLoss: '0.3000', endsReturned: '39.9000' })
    expect(preview.words).toEqual({ en: '80 ordered · 72 cut (−8)', it: '80 ordinati · 72 tagliati (−8)' })
    expect(keysOf(preview).filter((key) => MONEY.test(key))).toEqual([])

    const lines = preview.lines as Json[]
    const missing = await refused('planner', 'POST', `${url}/reconcile`, { version: record.cutOrder.version, lines: lines.slice(1).map((line) => ({ lineId: line.id, reasonCode: 'PLIES_SHORT' })) }, 400)
    expect(missing.issues.map((issue: Json) => issue.path)).toEqual(['body/lines/reasonCode'])
    const other = await refused('planner', 'POST', `${url}/reconcile`, { version: record.cutOrder.version, lines: lines.map((line, index) => ({ lineId: line.id, reasonCode: index === 0 ? 'OTHER' : 'PLIES_SHORT' })) }, 400)
    expect(other.issues.map((issue: Json) => issue.path)).toEqual(['body/lines/0/note'])
    await refused('viewer', 'POST', `${url}/reconcile`, { version: record.cutOrder.version, lines: [] }, 403)
    await refused('companyB', 'POST', `${url}/reconcile`, { version: record.cutOrder.version, lines: [] }, 404)
    const done = await ok('planner', 'POST', `${url}/reconcile`, { version: record.cutOrder.version, lines: lines.map((line, index) => ({ lineId: line.id, reasonCode: index === 0 ? 'OTHER' : 'PLIES_SHORT', ...(index === 0 ? { note: 'The last roll ran out' } : {}) })) })
    expect(done.cutOrder.status).toBe('RECONCILED')
    expect(done.lines.every((line: Json) => line.reconciled !== null)).toBe(true)
    const rows = await admin<{ cutQuantity: number; varianceReasonCode: string }>(`SELECT "cutQuantity", "varianceReasonCode" FROM "CutReconciliation" WHERE "cutOrderId" = $1 ORDER BY "cutQuantity", "varianceReasonCode"`, [CO.cutOrder.id])
    expect(rows.map((row) => [row.cutQuantity, row.varianceReasonCode])).toEqual([
      [9, 'PLIES_SHORT'],
      [18, 'OTHER'],
      [18, 'PLIES_SHORT'],
      [27, 'PLIES_SHORT'],
    ])
    expect((await events('cut_order.reconciled')).filter((event) => event.cutOrderId === CO.cutOrder.id)).toEqual([
      expect.objectContaining({ status: 'RECONCILED', lines: 4, variances: 4, garmentsOrdered: 80, garmentsCut: 72, workOrderIds: [WO.a.id, WO.b.id].sort() }),
    ])
    // Nothing changes after: not reconciled twice, the fabric used is closed.
    const after = await ok('viewer', 'GET', url)
    expect(after.cutOrder.reconciledAt).not.toBeNull()
    expect(refusal(await refused('planner', 'POST', `${url}/reconcile`, { version: after.cutOrder.version }, 409))).toBe('refusal/NOT_CUT')
    expect(refusal(await refused('planner', 'POST', `/production/lays/${lay(0).id}/fabric-used`, { confirmed: '13' }, 409))).toBe('refusal/CONSUMPTION_CLOSED')
  })

  it('reconciles a leather cut order from the cut log, keeping the line reconciled before', async () => {
    const [order] = await admin<{ id: string; version: number }>(`SELECT id, version FROM "CutOrder" WHERE "tenantId" = $1 AND number = 'SEED-CO-0002'`, [A.tenant])
    const preview = await ok('planner', 'GET', `/production/cut-orders/${order!.id}/reconciliation`)
    expect(preview.material).toBeNull()
    expect(preview.lines.filter((line: Json) => line.reconciled !== null)).toHaveLength(1)
    const open = preview.lines.filter((line: Json) => line.reconciled === null) as Json[]
    expect(open).toHaveLength(1)
    const done = await ok('planner', 'POST', `/production/cut-orders/${order!.id}/reconcile`, {
      version: order!.version,
      lines: open.filter((line) => line.needsReason).map((line) => ({ lineId: line.id, reasonCode: 'MISCUT' })),
    })
    expect(done.cutOrder.status).toBe('RECONCILED')
    expect(await admin(`SELECT count(*)::int AS n FROM "CutReconciliation" WHERE "cutOrderId" = $1`, [order!.id])).toEqual([{ n: 2 }])
  })
})
