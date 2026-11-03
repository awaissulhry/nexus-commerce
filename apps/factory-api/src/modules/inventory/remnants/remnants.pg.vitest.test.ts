import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Remnants and finding hides (B-W2b-100; SCM-254 remnant stock, SCM-206 one shade lot per order, SCM-214 choose hides at the
 * pick, SCM-257 find hides for a job) on the local stack with the app's real routes: a throwaway PostgreSQL 17 database from
 * the migrations (the runtime login: row-level security, the grants and the …_leather_stock_w2b_guards Remnant guard are
 * real), the factory-db seeds up to production (SEED-JKT-02 of black leather by the hide), reasons and numbering, and on top
 * made-up black leather at A1: lot BLK (hides of shade 1, one of shade 2, one of an out-of-shade group) and lot OLD (no
 * shade). Released work orders of one jacket each are made through the work-order routes. Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/inventory/remnants`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = 'remnants-a'
const idOf = (key: string) => seedUuid(ns, key)
const A = {
  tenant: idOf('tenant'),
  actor: idOf('actor'),
  companyA: idOf('company:A'),
  siteA1: idOf('site:A1'),
  brand: idOf('party:P1'),
  style: idOf('production:style:JKT-02'),
  blk: idOf('production:colourway:JKT-02:BLK'),
  leather: idOf('product:item:leather'),
  leatherBLK: idOf('product:item-colour:leather:BLK'),
  store: idOf('inventory:location:A1-STORE'),
  bin: idOf('inventory:location:A1-STORE-01'),
  cut: idOf('inventory:location:A1-CUT'),
  deviceA1: idOf('device:A1:cutting'),
  operatorA1: idOf('worker:A1:operator'),
}

const STOCK: Permission[] = ['inventory.issue', 'inventory.reverse', 'inventory.stock.view', 'inventory.reserve', 'inventory.scrap', 'inventory.transfer']
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  planner: office([grant(['workorders.view', 'workorders.manage', 'workorders.release'])]),
  warehouse: office([grant(STOCK)]),
  manager: office([grant([...STOCK, 'inventory.shade.override'])]),
  viewer: office([grant(['inventory.stock.view'])]),
  floor: { audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: A.siteA1, deviceId: A.deviceA1, grants: [{ permissions: ['floor.work', 'inventory.issue', 'inventory.locations.view'], companies: [A.companyA], sites: [A.siteA1], parties: 'all' }] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `rm-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'POST' ? { 'idempotency-key': freshKey() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const pathOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction(work))
const issue = (workOrderId: string, body: Json, session = 'floor') => call(session, 'POST', `/inventory/picking/work-orders/${workOrderId}/issue`, body)
const giveBack = (workOrderId: string, body: Json, session = 'floor') => call(session, 'POST', `/inventory/picking/work-orders/${workOrderId}/return`, body)
const remnantsOf = (hideId: string) => admin<{ id: string; code: string; state: string; locationId: string | null; baseArea: string; moveId: string }>(`SELECT id, code, state, "locationId", "baseArea"::text AS "baseArea", "moveId" FROM "Remnant" WHERE "hideId" = $1 ORDER BY id`, [hideId])

// ---- made-up stock and work orders ----------------------------------------------------------------------------------------

const hides: Record<string, { id: string; code: string }> = {}
const lots: Record<string, { id: string; code: string }> = {}

async function addLot(key: string, receivedAt: string, entries: { hide: string; area: string; shade?: string | null; group?: { label: string; outOfShade: boolean } }[]) {
  const lotId = newId()
  const code = `T-${run}-${key}`
  lots[key] = { id: lotId, code }
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'RELEASED', now(), true, '3.000', 'PASS', '1.100', 'LOT_REPORT', '2026-10-01', $8)`,
    [lotId, A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, code, new Date(receivedAt)],
  )
  for (const [index, entry] of entries.entries()) {
    const hideId = newId()
    hides[entry.hide] = { id: hideId, code: `T-${run}-${entry.hide}` }
    let groupId: string | null = null
    if (entry.group) {
      groupId = newId()
      await admin(`INSERT INTO "ShadeGroup" (id, "tenantId", "itemId", "itemColourId", "lotSiteId", "lotId", label, "outOfShade") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
        groupId,
        A.tenant,
        A.leather,
        A.leatherBLK,
        A.siteA1,
        lotId,
        entry.group.label,
        entry.group.outOfShade,
      ])
    }
    await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea", shade, "shadeGroupId") VALUES ($1, $2, $3, $4, $5, $6, $7, 'FT2', $7, $8, $9)`, [
      hideId,
      A.tenant,
      A.siteA1,
      lotId,
      A.leather,
      hides[entry.hide]!.code,
      entry.area,
      entry.group?.label ?? entry.shade ?? null,
      groupId,
    ])
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt")
       VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, $10, 'FT2', $10, $11, now() - interval '2 days')`,
      [newId(), A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, lotId, hideId, A.bin, entry.area, `rm-test-${code}-${index}`],
    )
  }
}

async function salesOrder(suffix: string): Promise<string> {
  const orderId = newId()
  const lineId = newId()
  await asOffice(async (tx) => {
    await tx.salesOrder.create({
      data: { id: orderId, companyId: A.companyA, partyId: A.brand, number: `T-${run}-SO-${suffix}`, status: 'CONFIRMED', orderDate: new Date('2026-10-20T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-10T00:00:00.000Z'), depositRequired: false },
      select: { id: true },
    })
    await tx.salesOrderLine.create({
      data: { id: lineId, companyId: A.companyA, orderId, partyId: A.brand, seq: 10, kind: 'SIZE_GRID', styleId: A.style, colourwayId: A.blk, quantity: 8, unitPrice: '100.000000', netAmount: 80_000, vatRatePct: '22.00', vatAmount: 17_600, siteId: A.siteA1 },
      select: { id: true },
    })
    await tx.salesOrderLineSize.create({ data: { id: newId(), lineId, partyId: A.brand, size: '50', quantity: 8 }, select: { id: true } })
  })
  return lineId
}

async function releasedWorkOrder(lineId: string): Promise<Json> {
  const { workOrder } = await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: lineId, sizes: [{ size: '50', quantity: 1 }] }] }, 201)
  // The seed's own work orders already count on most of the leather: released on the planner's override (this file tests the pick).
  return (await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/release`, { version: workOrder.version, materialOverride: { reason: 'Made-up test: remnants and shades decide' } })).workOrder
}

const WO: Record<'shade' | 'rem' | 'rem2' | 'w1' | 'find', Json> = {} as never

beforeAll(async () => {
  db = await migratedDatabase('remnants')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  await seedCore({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await seedReasons({ db: database, namespace: ns })
  await asOffice(async (tx) => {
    const certificateId = newId()
    await tx.certificate.create({
      data: { id: certificateId, holderPartyId: A.brand, standard: 'EN 17092-3:2020', ppeClass: 'AA', number: `T-${run}-CERT`, notifiedBodyName: 'Made-up Notified Body', notifiedBodyNumber: '9999', modelReference: 'SEED-JKT-02', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2030-12-31T00:00:00.000Z'), status: 'VALID', statusChangedAt: new Date() },
      select: { id: true },
    })
    await tx.certificateCoverage.create({ data: { id: newId(), certificateId, styleId: A.style, sizes: ['50', '52'] }, select: { id: true } })
  })
  await addLot('BLK', '2026-09-05T08:00:00.000Z', [
    { hide: 'S1A', area: '20.0000', shade: '1' },
    { hide: 'S1B', area: '20.0000', shade: '1' },
    { hide: 'S1C', area: '20.0000', shade: '1' },
    { hide: 'S1D', area: '18.0000', shade: '1' },
    { hide: 'S1E', area: '22.0000', shade: '1' },
    { hide: 'S1F', area: '21.0000', shade: '1' },
    { hide: 'S2A', area: '20.0000', shade: '2' },
    { hide: 'X1', area: '25.0000', group: { label: 'X', outOfShade: true } },
  ])
  await addLot('OLD', '2026-08-01T08:00:00.000Z', [
    { hide: 'O1', area: '30.0000' },
    { hide: 'O2', area: '35.0000' },
  ])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  const line = await salesOrder('1')
  WO.shade = await releasedWorkOrder(line)
  WO.rem = await releasedWorkOrder(line)
  WO.rem2 = await releasedWorkOrder(line)
  WO.w1 = await releasedWorkOrder(line)
  WO.find = await releasedWorkOrder(line)
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

// ---- one shade lot per order (SCM-206) and choose hides at the pick (SCM-214) -----------------------------------------------

describe('one shade lot per order at the pick (SCM-206, SCM-214)', () => {
  it('lets the first hide set the shade lot, refuses another lot or shade in words, and lets the office override with the right and a reason', async () => {
    expect((await issue(WO.shade.id, { code: hides.S1A!.code })).statusCode).toBe(201)
    const list = await ok('floor', 'GET', `/inventory/picking/work-orders/${WO.shade.id}`)
    expect(list.shadeRule).toBe('ORDER')
    const leather = (list.lines as Json[]).find((row) => row.itemId === A.leather)!
    expect(leather.hides).toEqual({ count: 1 })
    expect(leather.shadeLots).toEqual([expect.objectContaining({ lotCode: lots.BLK!.code, shadeLabel: '1' })])
    // The work order's own shade lot first; another lot or shade after it, said so.
    const candidates = leather.usable.candidates as Json[]
    const firstOther = candidates.findIndex((row) => row.sameShade === false)
    expect(candidates.slice(0, firstOther).every((row) => row.sameShade === true && row.shadeLabel === '1')).toBe(true)
    expect(candidates.find((row) => row.hideCode === hides.O1!.code)).toMatchObject({ sameShade: false, shadeLabel: null })
    expect(candidates.find((row) => row.hideCode === hides.X1!.code)).toMatchObject({ outOfShade: true, shadeLabel: 'X' })

    const otherShade = await refused('floor', 'POST', `/inventory/picking/work-orders/${WO.shade.id}/issue`, { code: hides.S2A!.code }, 409)
    expect(pathOf(otherShade)).toBe('refusal/SHADE_LOT')
    expect(otherShade.message).toContain(`is cut from lot ${lots.BLK!.code}, shade 1; hide ${hides.S2A!.code} is lot ${lots.BLK!.code}, shade 2.`)
    expect(pathOf(await refused('floor', 'POST', `/inventory/picking/work-orders/${WO.shade.id}/issue`, { code: hides.O1!.code }, 409))).toBe('refusal/SHADE_LOT')
    expect(pathOf(await refused('floor', 'POST', `/inventory/picking/work-orders/${WO.shade.id}/issue`, { code: hides.X1!.code }, 409))).toBe('refusal/OUT_OF_SHADE')
    // The floor and a person without the right cannot override; a reason too short is refused.
    await refused('floor', 'POST', `/inventory/picking/work-orders/${WO.shade.id}/issue`, { code: hides.O1!.code, shadeOverrideReason: 'The customer accepts it' }, 403)
    await refused('warehouse', 'POST', `/inventory/picking/work-orders/${WO.shade.id}/issue`, { code: hides.O1!.code, shadeOverrideReason: 'The customer accepts it' }, 403)
    await refused('manager', 'POST', `/inventory/picking/work-orders/${WO.shade.id}/issue`, { code: hides.O1!.code, shadeOverrideReason: 'ok' }, 400)
    const through = await ok('manager', 'POST', `/inventory/picking/work-orders/${WO.shade.id}/issue`, { code: hides.O1!.code, shadeOverrideReason: 'The customer accepts two shades on the lining side' }, 201)
    expect(through.issue).toMatchObject({ hideId: hides.O1!.id })
    const [audit] = await admin(`SELECT after, reason FROM "AuditLog" WHERE "recordType" = 'WorkOrder' AND "recordId" = $1 AND action = 'inventory.issue' ORDER BY at DESC LIMIT 1`, [WO.shade.id])
    expect(audit!.after).toMatchObject({ shadeOverride: true, hideId: hides.O1!.id })
    expect(audit!.reason).toBe('Shade rule overridden: The customer accepts two shades on the lining side')
    // Now mixed: the pick list names both shade lots.
    const after = (await ok('floor', 'GET', `/inventory/picking/work-orders/${WO.shade.id}`)).lines.find((row: Json) => row.itemId === A.leather)
    expect(after.shadeLots).toHaveLength(2)
    expect(after.hides).toEqual({ count: 2 })
  })
})

// ---- remnant stock (SCM-254) ----------------------------------------------------------------------------------------------------

describe('remnant stock (SCM-254): a part of a hide comes back with its own tag and lives beside its hide', () => {
  it('refuses a piece under the minimum, tags one above it (a REMNANT move), lists, looks up and records it', async () => {
    expect((await issue(WO.rem.id, { code: hides.S1B!.code })).statusCode).toBe(201)
    const small = await refused('floor', 'POST', `/inventory/picking/work-orders/${WO.rem.id}/return`, { hideId: hides.S1B!.id, quantity: '0.5', toLocationId: A.bin }, 409)
    expect(pathOf(small)).toBe('refusal/REMNANT_TOO_SMALL')
    expect(small.message).toContain('smaller than the smallest remnant kept, 1.08 ft² (0.10 m²)')

    const response = await giveBack(WO.rem.id, { hideId: hides.S1B!.id, quantity: '8', toLocationId: A.bin })
    expect(response.statusCode, response.body).toBe(201)
    const back = response.json().return
    expect(back.move).toMatchObject({ reason: 'REMNANT', toLocationId: A.bin, baseQuantity: '8.0000', hideId: hides.S1B!.id, workOrderId: WO.rem.id })
    expect(back.hideState).toBe('REMNANT')
    expect(back.remnant).toMatchObject({ baseArea: '8.0000' })
    expect(back.remnant.code).toMatch(/^RM-/)
    const [row] = await remnantsOf(hides.S1B!.id)
    expect(row).toMatchObject({ id: back.remnant.id, state: 'IN_STOCK', locationId: A.bin, baseArea: '8.0000', moveId: back.move.id })
    const [tagged] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'inventory.remnant_tagged' AND subject = $1`, [row!.id])
    expect(tagged!.payload).toMatchObject({ code: row!.code, source: 'RETURN', workOrderId: WO.rem.id, baseArea: '8.0000' })
    const [returned] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'inventory.returned' AND subject = $1 ORDER BY id DESC LIMIT 1`, [WO.rem.id])
    expect(returned!.payload).toMatchObject({ remnantId: row!.id, hideState: 'REMNANT' })

    const list = await ok('viewer', 'GET', `/inventory/remnants?siteId=${A.siteA1}`)
    expect(list.rows.map((entry: Json) => entry.code)).toContain(row!.code)
    expect(list.rows.find((entry: Json) => entry.code === row!.code)).toMatchObject({ state: 'IN_STOCK', area: { uom: 'FT2', quantity: '8.0000' }, hide: { code: hides.S1B!.code, state: 'REMNANT' }, lot: { code: lots.BLK!.code }, shade: '1', location: { id: A.bin }, move: { reason: 'REMNANT', workOrderNumber: WO.rem.number } })
    expect(list.totals[0]).toMatchObject({ uom: 'FT2', pieces: 1, area: '8.0000' })
    expect(list.totals[0].words.en).toBe('1 piece · 8.00 ft² (0.7 m²)')
    expect(list.minimum).toEqual({ area: '10', uom: 'DM2', setting: false })
    const looked = await ok('floor', 'GET', `/inventory/remnants/lookup?code=${encodeURIComponent(row!.code.toLowerCase())}`)
    expect(looked.remnant).toMatchObject({ id: row!.id, hide: { id: hides.S1B!.id } })
    const record = await ok('viewer', 'GET', `/inventory/remnants/${row!.id}`)
    expect(record.history).toEqual([expect.objectContaining({ action: 'TAGGED', cause: 'RETURN', by: null, audience: 'FLOOR' })])
    expect(record.minimum).toEqual({ baseArea: '1.0764', setting: false })
    // The floor reads no list or record; an unknown tag is not found.
    await refused('floor', 'GET', '/inventory/remnants', undefined, 403)
    await refused('floor', 'GET', '/inventory/remnants/lookup?code=RM-NOPE-00', undefined, 404)
  })

  it('issues a remnant by its own tag (ISSUED), undoes it (IN_STOCK), takes it back whole (a RETURN, the same tag at its new place)', async () => {
    const [piece] = await remnantsOf(hides.S1B!.id)
    const first = await issue(WO.rem2.id, { code: piece!.code })
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json().issue).toMatchObject({ hideId: hides.S1B!.id, baseQuantity: '8.0000' })
    expect((await remnantsOf(hides.S1B!.id))[0]!.state).toBe('ISSUED')
    expect((await ok('floor', 'POST', `/inventory/picking/issues/${first.json().issue.id}/undo`, undefined, 201)).reversal.of).toBe('ISSUE')
    expect((await remnantsOf(hides.S1B!.id))[0]!.state).toBe('IN_STOCK')

    expect((await issue(WO.rem2.id, { code: piece!.code })).statusCode).toBe(201)
    const whole = await ok('floor', 'POST', `/inventory/picking/work-orders/${WO.rem2.id}/return`, { hideId: hides.S1B!.id, quantity: '8', toLocationId: A.store }, 201)
    expect(whole.return.move.reason).toBe('RETURN')
    expect(whole.return.remnant).toBeNull()
    expect((await remnantsOf(hides.S1B!.id))[0]).toMatchObject({ state: 'IN_STOCK', locationId: A.store })
    // The office reverses that return: the piece is at the work order again.
    const reversed = await ok('warehouse', 'POST', `/inventory/picking/moves/${whole.return.move.id}/reverse`, { note: 'Returned to the wrong rack' }, 201)
    expect(reversed.reversal.of).toBe('RETURN')
    expect((await remnantsOf(hides.S1B!.id))[0]!.state).toBe('ISSUED')
    const changes = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'inventory.remnant_changed' AND subject = $1 ORDER BY id`, [piece!.id])
    expect(changes.map((event) => `${event.payload.from}>${event.payload.to}:${event.payload.cause}`)).toEqual(['IN_STOCK>ISSUED:ISSUE', 'ISSUED>IN_STOCK:ISSUE_REVERSED', 'IN_STOCK>ISSUED:ISSUE', 'ISSUED>IN_STOCK:RETURN', 'IN_STOCK>ISSUED:RETURN_REVERSED'])
  })

  it('uses the piece when a part of it comes back (a new tag), gives it back when that REMNANT is reversed, and refuses to reverse a move whose piece went on', async () => {
    const [piece] = await remnantsOf(hides.S1B!.id)
    // The office takes part of it back: valued in the same command (an office move).
    const part = await ok('warehouse', 'POST', `/inventory/picking/work-orders/${WO.rem2.id}/return`, { hideId: hides.S1B!.id, quantity: '5', toLocationId: A.bin }, 201)
    expect(part.return.move).toMatchObject({ reason: 'REMNANT', valued: true })
    const [valuation] = await admin(`SELECT quantity::text AS quantity FROM "StockValuation" WHERE "moveId" = $1`, [part.return.move.id])
    expect(valuation!.quantity).toBe('5.0000')
    let pieces = await remnantsOf(hides.S1B!.id)
    expect(pieces.map((row) => row.state)).toEqual(['USED', 'IN_STOCK'])
    expect(pieces[1]).toMatchObject({ id: part.return.remnant.id, baseArea: '5.0000' })

    // Reversing that REMNANT voids its tag and gives the used piece back to the work order.
    const undone = await ok('warehouse', 'POST', `/inventory/picking/moves/${part.return.move.id}/reverse`, { note: 'Measured wrong' }, 201)
    expect(undone.reversal.of).toBe('REMNANT')
    pieces = await remnantsOf(hides.S1B!.id)
    expect(pieces.map((row) => row.state)).toEqual(['ISSUED', 'VOID'])

    // The first REMNANT (its piece is issued now) is not reversed: the piece went on.
    const gone = await refused('warehouse', 'POST', `/inventory/picking/moves/${piece!.moveId}/reverse`, { note: 'Wrong work order' }, 409)
    expect(pathOf(gone)).toBe('refusal/REMNANT_GONE_ON')
    // The ledger's generic reverse sends it to the pick list.
    expect((await refused('warehouse', 'POST', `/inventory/moves/${piece!.moveId}/reverse`, { note: 'Wrong work order' }, 409)).message).toContain('reversed from its pick list')
  })

  it('takes a piece in stock along when its hide is moved, scraps it with its hide and brings it back with the reversal', async () => {
    const part = await ok('warehouse', 'POST', `/inventory/picking/work-orders/${WO.rem2.id}/return`, { hideId: hides.S1B!.id, quantity: '6', toLocationId: A.bin }, 201)
    const tag = part.return.remnant.id
    await ok('warehouse', 'POST', '/inventory/transfers', { siteId: A.siteA1, itemId: A.leather, itemColourId: A.leatherBLK, lotId: lots.BLK!.id, hideId: hides.S1B!.id, fromLocationId: A.bin, toLocationId: A.cut, quantity: '6', uom: 'FT2' }, 201)
    expect((await remnantsOf(hides.S1B!.id)).find((row) => row.id === tag)).toMatchObject({ state: 'IN_STOCK', locationId: A.cut })
    const written = await ok('warehouse', 'POST', '/inventory/write-offs', { siteId: A.siteA1, reasonCode: 'DAMAGED', note: 'Water stain on the offcut', lines: [{ hideId: hides.S1B!.id }] }, 201)
    expect((await remnantsOf(hides.S1B!.id)).find((row) => row.id === tag)!.state).toBe('SCRAPPED')
    const scrapMove = written.writeOff.moves[0].id
    await ok('warehouse', 'POST', `/inventory/moves/${scrapMove}/reverse`, { note: 'Found it was clean' }, 201)
    expect((await remnantsOf(hides.S1B!.id)).find((row) => row.id === tag)!.state).toBe('IN_STOCK')
  })

  it("tags a W1 remnant once (its RETURN move), where its hide's stock lies", async () => {
    expect((await issue(WO.w1.id, { code: hides.S1C!.code })).statusCode).toBe(201)
    // Before W2b a cut hide came back as a RETURN and the state REMNANT, with no tag of its own.
    const returnId = newId()
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "workOrderId", reference, "idempotencyKey", "occurredAt")
       VALUES ($1, $2, $3, $4, 'RETURN', $5, $6, $7, $8, $9, '7.0000', 'FT2', '7.0000', $10, $11, $12, now())`,
      [returnId, A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, lots.BLK!.id, hides.S1C!.id, A.bin, WO.w1.id, WO.w1.number, `rm-test-w1-${run}`],
    )
    await admin(`UPDATE "Hide" SET state = 'REMNANT', version = version + 1 WHERE id = $1`, [hides.S1C!.id])
    await refused('viewer', 'POST', '/inventory/remnants', { hideId: hides.S1C!.id }, 403)
    const tagged = await ok('warehouse', 'POST', '/inventory/remnants', { hideId: hides.S1C!.id, note: 'Tagged after W2b' }, 201)
    expect(tagged.remnant).toMatchObject({ state: 'IN_STOCK', baseArea: '7.0000', move: { id: returnId, reason: 'RETURN' }, note: 'Tagged after W2b', location: { id: A.bin } })
    expect(pathOf(await refused('warehouse', 'POST', '/inventory/remnants', { hideId: hides.S1C!.id }, 409))).toBe('refusal/TAGGED_ALREADY')
    expect(pathOf(await refused('warehouse', 'POST', '/inventory/remnants', { hideId: hides.S1D!.id }, 409))).toBe('refusal/NOT_A_REMNANT')
  })
})

// ---- find hides for a job (SCM-257) and the shade rule at the reserve (SCM-206) -------------------------------------------------

describe('find hides for a job (SCM-257) and reserving one shade lot (SCM-206)', () => {
  it("proposes ONE shade lot covering the work order's need, then reserves it; another shade lot is refused unless overridden", async () => {
    const found = await ok('viewer', 'GET', `/inventory/reservations/find-hides?workOrderId=${WO.find.id}`)
    expect(found).toMatchObject({ item: { id: A.leather }, workOrder: { id: WO.find.id, issued: '0.0000', reserved: '0.0000' }, need: { source: 'WORK_ORDER' }, rule: 'ORDER', ordersShadeLots: [] })
    const need = Number(found.need.baseArea)
    expect(need).toBeGreaterThan(20)
    expect(found.proposal.covers).toBe(true)
    const first = found.lots[0]
    expect(first.key).toBe(found.proposal.lotKey)
    expect(found.lots.slice(1).every((lot: Json) => lot.shadeWarning)).toBe(true)
    expect(found.outOfShade.map((row: Json) => row.hideCode)).toEqual([hides.X1!.code])
    expect(found.proposal.words.en).toMatch(/^\d+ hides? · [\d.,]+ of [\d.,]+ ft² ✓$/)
    // Filters: a shade group that holds only the out-of-shade hide finds nothing to propose; an area replaces the need.
    const asked = await ok('viewer', 'GET', `/inventory/reservations/find-hides?siteId=${A.siteA1}&itemId=${A.leather}&itemColourId=${A.leatherBLK}&area=30&uom=FT2`)
    expect(asked).toMatchObject({ workOrder: null, need: { baseArea: '30.0000', source: 'ASKED' } })
    expect(Number(asked.proposal.area)).toBeGreaterThanOrEqual(30)

    const reserved = await ok('warehouse', 'POST', '/inventory/reservations', { siteId: A.siteA1, workOrderId: WO.find.id, lines: found.proposal.hideIds.map((hideId: string) => ({ hideId })) }, 201)
    expect(reserved.reservations).toHaveLength(found.proposal.hideIds.length)
    // The work order's lot is now its own shade lot: it comes first, and the need counts what is reserved.
    const again = await ok('viewer', 'GET', `/inventory/reservations/find-hides?workOrderId=${WO.find.id}`)
    expect(again.ordersShadeLots.length).toBe(1)
    expect(Number(again.workOrder.reserved)).toBeGreaterThan(0)

    const otherLot = (found.lots as Json[]).find((lot) => lot.key !== found.proposal.lotKey)!
    const otherHide = otherLot.hides[0].hideId
    const refusal = await refused('warehouse', 'POST', '/inventory/reservations', { siteId: A.siteA1, workOrderId: WO.find.id, lines: [{ hideId: otherHide }] }, 409)
    expect(pathOf(refusal)).toBe('body/lines/0/refusal/SHADE_LOT')
    await refused('warehouse', 'POST', '/inventory/reservations', { siteId: A.siteA1, workOrderId: WO.find.id, shadeOverrideReason: 'Customer accepts it', lines: [{ hideId: otherHide }] }, 403)
    const through = await ok('manager', 'POST', '/inventory/reservations', { siteId: A.siteA1, workOrderId: WO.find.id, shadeOverrideReason: 'Customer accepts the second shade', lines: [{ hideId: otherHide }] }, 201)
    const [audit] = await admin(`SELECT after, reason FROM "AuditLog" WHERE "recordType" = 'Reservation' AND "recordId" = $1`, [through.reservations[0].id])
    expect(audit).toMatchObject({ after: expect.objectContaining({ shadeOverride: true }), reason: 'Shade rule overridden: Customer accepts the second shade' })
  })
})
