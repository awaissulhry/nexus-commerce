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
 * Picking & kits (B-W2a-58; design warehouse.picking, SCR-237; PLN-086) and the lead's follow-ups of #973 and #948 on the
 * local stack, with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login:
 * row-level security, the grants and the …_quality_plant_w2a_guards triggers are real), the factory-db seeds up to
 * production with the HOLD reasons (SEED-WO-0001 in progress, SEED-WO-0002 a draft), a made-up certificate, made-up
 * stock at A1 (black leather by the hide, one grey lining lot, protectors) and three released work orders of one black
 * jacket each, made through the work-order routes. Quality holds are placed and lifted by SQL (the holds module's own
 * tests cover its routes); everything else goes through the routes. Every name and number is made up.
 *   - a lot or a hide under an ACTIVE quality hold is not offered by the pick list, is listed as held with the hold, is
 *     out of the plan's material readiness, and an issue of it is refused in words (409, never the database's 500);
 *     lifting the hold offers it again;
 *   - the pick lists of many work orders: readiness word, lines picked, kit state, team, the saved rows and tiles;
 *   - Create pick lists reserves what each work order needs, oldest first, never the same hide twice, refuses a draft,
 *     and a second time reserves nothing; the sheets show each line's reservations and where they lie.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/inventory/issue`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'pick-kits-a'
const idOf = (key: string) => seedUuid(NS, key)
const firstId = (key: string) => `00000000${idOf(key).slice(8)}`
const A = {
  tenant: idOf('tenant'),
  actor: idOf('actor'),
  companyA: idOf('company:A'),
  siteA1: idOf('site:A1'),
  brand: idOf('party:P1'),
  style: idOf('production:style:JKT-02'),
  blk: idOf('production:colourway:JKT-02:BLK'),
  leather: idOf('product:item:leather'),
  lining: idOf('product:item:lining'),
  protector: idOf('product:item:protector'),
  leatherBLK: idOf('product:item-colour:leather:BLK'),
  liningGRY: idOf('product:item-colour:lining:GRY'),
  store: idOf('inventory:location:A1-STORE'),
  bin: idOf('inventory:location:A1-STORE-01'),
  deviceA1: idOf('device:A1:cutting'),
  operatorA1: idOf('worker:A1:operator'),
  seededWorkOrder: idOf('production:work-order:WO-0001'),
  draftWorkOrder: firstId('production:work-order:WO-0002'),
}

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  planner: office([grant(['workorders.view', 'workorders.manage', 'workorders.release', 'planning.view'])]),
  /** The warehouse role's part: stock, picking, reserving. */
  warehouse: office([grant(['inventory.stock.view', 'inventory.issue', 'inventory.reserve'])]),
  /** Sees stock, reserves nothing. */
  viewer: office([grant(['inventory.stock.view'])]),
  floor: {
    audience: 'floor',
    tenantId: A.tenant,
    actorId: A.operatorA1,
    siteId: A.siteA1,
    deviceId: A.deviceA1,
    grants: [grant(['floor.work', 'inventory.issue', 'inventory.locations.view'], [A.companyA], [A.siteA1])],
  },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `kits-${run}-${++keys}`
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
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction(work))
const lineOf = (list: Json, itemId: string, colourId: string | null): Json => (list.lines as Json[]).find((line) => line.itemId === itemId && line.itemColourId === colourId)!
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
const MONEY = /cost|price|margin|amount|wage|valuation/i

const hides: Record<string, { id: string; code: string }> = {}
const lots: Record<string, { id: string; code: string }> = {}

async function addLot(spec: { key: string; itemId: string; colourId: string | null; crVi?: 'PASS'; receivedAt: string; stock: { locationId: string; quantity: string; uom: string; hide?: string }[] }) {
  const lotId = newId()
  const code = `K-${run}-${spec.key}`
  lots[spec.key] = { id: lotId, code }
  const leather = spec.crVi !== undefined
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'RELEASED', now(), $8, $9, $10, $11, $12, $13, $14)`,
    [lotId, A.tenant, A.companyA, A.siteA1, spec.itemId, spec.colourId, code, leather, leather ? '3.000' : null, leather ? 'PASS' : 'NOT_REQUIRED', leather ? '1.100' : null, leather ? 'LOT_REPORT' : null, leather ? '2026-10-01' : null, new Date(spec.receivedAt)],
  )
  for (const [index, entry] of spec.stock.entries()) {
    const hideId = entry.hide ? newId() : null
    if (hideId) {
      hides[entry.hide!] = { id: hideId, code: `K-${run}-${entry.hide}` }
      await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea") VALUES ($1, $2, $3, $4, $5, $6, $7, 'FT2', $7)`, [hideId, A.tenant, A.siteA1, lotId, spec.itemId, `K-${run}-${entry.hide}`, entry.quantity])
    }
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt")
       VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, $10, $11, $10, $12, now())`,
      [newId(), A.tenant, A.companyA, A.siteA1, spec.itemId, spec.colourId, lotId, hideId, entry.locationId, entry.quantity, entry.uom, `kits-test-${code}-${index}`],
    )
  }
}

/** A quality hold placed at the table (made up), by SQL: the holds module's tests cover its own routes. */
async function placeHold(subjectType: 'Lot' | 'Hide', subjectIds: readonly string[]): Promise<string> {
  const holdId = newId()
  await admin(
    `INSERT INTO "QualityHold" (id, "tenantId", "companyId", "siteId", "subjectType", "subjectIds", "reasonCode", "reasonNote", "placedAt", "placedById", "createdById", "number")
     VALUES ($1, $2, $3, $4, $5, $6::uuid[], 'QUALITY_CHECK', 'A shade difference seen at the table (made up).', '2026-11-21T09:00:00Z', $7, $7, 'HLD-T-' || gen_random_uuid())`,
    [holdId, A.tenant, A.companyA, A.siteA1, subjectType, [...subjectIds], A.actor],
  )
  return holdId
}
/** The hold released, by SQL (a releaser who did not place it, with a made-up signature). */
const liftHold = (holdId: string) =>
  admin(`UPDATE "QualityHold" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2, "releaseNote" = 'Shade checked (made up).', "releaseSignatureSha256" = 'made-up-signature', version = version + 1 WHERE id = $1`, [holdId, newId()])

async function salesOrder(pieces: number): Promise<string> {
  const orderId = newId()
  const lineId = newId()
  await asOffice(async (tx) => {
    await tx.salesOrder.create({
      data: {
        id: orderId,
        companyId: A.companyA,
        partyId: A.brand,
        number: `K-${run}-SO`,
        status: 'CONFIRMED',
        orderDate: new Date('2026-10-20T00:00:00.000Z'),
        taxMode: 'IT_B2B',
        billTo: { legalName: 'Made-up customer' },
        shipTo: { name: 'Made-up workshop' },
        promiseDate: new Date('2026-12-10T00:00:00.000Z'),
        depositRequired: false,
      },
      select: { id: true },
    })
    await tx.salesOrderLine.create({
      data: { id: lineId, companyId: A.companyA, orderId, partyId: A.brand, seq: 10, kind: 'SIZE_GRID', styleId: A.style, colourwayId: A.blk, quantity: pieces, unitPrice: '100.000000', netAmount: pieces * 10_000, vatRatePct: '22.00', vatAmount: pieces * 2_200, siteId: A.siteA1 },
      select: { id: true },
    })
    await tx.salesOrderLineSize.create({ data: { id: newId(), lineId, partyId: A.brand, size: '50', quantity: pieces }, select: { id: true } })
  })
  return lineId
}

async function releasedWorkOrder(lineId: string): Promise<Json> {
  const { workOrder } = await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: lineId, sizes: [{ size: '50', quantity: 1 }] }] }, 201)
  const released = await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/release`, {})
  expect(released.workOrder.status).toBe('RELEASED')
  return released.workOrder
}

const WO: Record<'one' | 'two' | 'three', Json> = {} as never
const rowOf = (answer: Json, workOrderId: string): Json | undefined => (answer.rows as Json[]).find((row) => row.workOrder.id === workOrderId)
const materialOf = (row: Json, itemId: string): Json => (row.readiness.materials as Json[]).find((material) => material.itemId === itemId)!

beforeAll(async () => {
  db = await migratedDatabase('pick_kits')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  await seedCore({ db: database, namespace: NS })
  await seedProduction({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  await seedReasons({ db: database, namespace: NS })
  await asOffice(async (tx) => {
    const certificateId = newId()
    await tx.certificate.create({
      data: {
        id: certificateId,
        holderPartyId: A.brand,
        standard: 'EN 17092-3:2020',
        ppeClass: 'AA',
        number: `K-${run}-CERT`,
        notifiedBodyName: 'Made-up Notified Body',
        notifiedBodyNumber: '9999',
        modelReference: 'SEED-JKT-02',
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validTo: new Date('2030-12-31T00:00:00.000Z'),
        status: 'VALID',
        statusChangedAt: new Date(),
      },
      select: { id: true },
    })
    await tx.certificateCoverage.create({ data: { id: newId(), certificateId, styleId: A.style, sizes: ['50', '52'] }, select: { id: true } })
  })
  const ft2 = (hide: string) => ({ locationId: A.bin, quantity: '55.0000', uom: 'FT2', hide })
  await addLot({ key: 'BLK', itemId: A.leather, colourId: A.leatherBLK, crVi: 'PASS', receivedAt: '2026-10-05T08:00:00.000Z', stock: ['H1', 'H2', 'H3', 'H4'].map(ft2) })
  await addLot({ key: 'LIN', itemId: A.lining, colourId: A.liningGRY, receivedAt: '2026-10-07T08:00:00.000Z', stock: [{ locationId: A.bin, quantity: '30.0000', uom: 'M' }] })
  await addLot({ key: 'PRO', itemId: A.protector, colourId: null, receivedAt: '2026-10-07T08:00:00.000Z', stock: [{ locationId: A.store, quantity: '100.0000', uom: 'PCS' }] })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  const line = await salesOrder(3)
  WO.one = await releasedWorkOrder(line)
  WO.two = await releasedWorkOrder(line)
  WO.three = await releasedWorkOrder(line)
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

// ---- quality holds in the pick list, readiness and the issue (the lead's follow-ups of #973 and #948) ----------------------

describe('stock under a quality hold is out of the pick list and of readiness, and its issue is refused in words', () => {
  it('a held lot is not offered, is listed as held with its hold, counts as missing in readiness, and comes back when the hold is lifted', async () => {
    // Every grey lining lot of A1: the seeded one and ours (one hold over both, as a supplier warning would).
    const seeded = await admin<{ id: string; code: string }>(`SELECT id, code FROM "Lot" WHERE "tenantId" = $1 AND "siteId" = $2 AND "itemId" = $3 AND "itemColourId" = $4 AND id <> $5`, [A.tenant, A.siteA1, A.lining, A.liningGRY, lots.LIN!.id])
    const liningLots = [lots.LIN!.code, ...seeded.map((lot) => lot.code)].sort()
    const before = await ok('warehouse', 'GET', `/inventory/picking/work-orders/${WO.one.id}`)
    expect(lineOf(before, A.lining, A.liningGRY).usable.candidates.map((candidate: Json) => candidate.lotCode).sort()).toEqual(liningLots)
    const readyBefore = rowOf(await ok('warehouse', 'GET', '/inventory/picking/pick-lists'), WO.one.id)!
    expect(materialOf(readyBefore, A.lining).word).toBe('NOT_BOOKED')

    const holdId = await placeHold('Lot', [lots.LIN!.id, ...seeded.map((lot) => lot.id)])
    const held = await ok('warehouse', 'GET', `/inventory/picking/work-orders/${WO.one.id}`)
    const lining = lineOf(held, A.lining, A.liningGRY)
    expect(lining.usable).toEqual({ onHand: '0.0000', candidates: [], more: 0 })
    expect((lining.held as Json[]).map((entry) => entry.lotCode)).toEqual(liningLots)
    expect((lining.held as Json[]).find((entry) => entry.lotId === lots.LIN!.id)).toEqual(
      {
        reason: 'QUALITY_HOLD',
        words: `Lot ${lots.LIN!.code} is on hold (Quality check, since 21 Nov 2026): its stock is not issued until quality releases the hold.`,
        lotId: lots.LIN!.id,
        lotCode: lots.LIN!.code,
        onHand: '30.0000',
        hides: 0,
        hideId: null,
        hideCode: null,
        hold: { id: holdId, subjectType: 'Lot', reasonCode: 'QUALITY_CHECK', reasonIt: expect.any(String), reasonEn: 'Quality check', placedAt: '2026-11-21T09:00:00.000Z' },
      },
    )
    // Readiness (planning's, the one the release check and the board read): the held lining is not stock any more.
    const readyHeld = rowOf(await ok('warehouse', 'GET', '/inventory/picking/pick-lists'), WO.one.id)!
    expect(materialOf(readyHeld, A.lining)).toMatchObject({ word: 'NOT_ENOUGH', inStock: '0.0000' })
    expect(readyHeld.readiness.word).toBe('NOT_ENOUGH')
    const planning = await ok('planner', 'GET', `/planning/work-orders/${WO.one.id}/readiness`)
    expect((planning.readiness.materials as Json[]).find((material) => material.itemId === A.lining)).toMatchObject({ word: 'NOT_ENOUGH', inStock: '0.0000' })
    // The issue of the held lot, office or floor: a 409 in the hold's words, nothing posted.
    const moves = async () => Number((await admin<{ n: string }>(`SELECT count(*)::int AS n FROM "StockMove" WHERE "lotId" = $1 AND reason = 'ISSUE'`, [lots.LIN!.id]))[0]!.n)
    const error = await refused('floor', 'POST', `/inventory/picking/work-orders/${WO.one.id}/issue`, { code: lots.LIN!.code, quantity: '1.0000' }, 409)
    expect(refusalOf(error)).toBe('refusal/QUALITY_HOLD')
    expect(error.message).toBe((lining.held as Json[]).find((entry) => entry.lotId === lots.LIN!.id)!.words)
    expect(refusalOf(await refused('warehouse', 'POST', `/inventory/picking/work-orders/${WO.one.id}/issue`, { lotId: lots.LIN!.id }, 409))).toBe('refusal/QUALITY_HOLD')
    expect(await moves()).toBe(0)
    // Create pick lists reserves nothing of it: the lining stays short.
    const created = await ok('warehouse', 'POST', '/inventory/picking/pick-lists', { siteId: A.siteA1, workOrderIds: [WO.three.id] }, 201)
    expect(created.results[0].reserved.filter((pick: Json) => pick.lotCode === lots.LIN!.code)).toEqual([])
    expect(created.results[0].short).toEqual([expect.objectContaining({ itemCode: expect.any(String), quantity: lineOf(held, A.lining, A.liningGRY).toIssue, baseUom: 'M' })])

    await liftHold(holdId)
    const lifted = await ok('warehouse', 'GET', `/inventory/picking/work-orders/${WO.one.id}`)
    expect(lineOf(lifted, A.lining, A.liningGRY).usable.candidates.map((candidate: Json) => candidate.lotCode).sort()).toEqual(liningLots)
    expect(lineOf(lifted, A.lining, A.liningGRY).held).toEqual([])
    expect(materialOf(rowOf(await ok('warehouse', 'GET', '/inventory/picking/pick-lists'), WO.one.id)!, A.lining).word).toBe('NOT_BOOKED')
  })

  it('a held hide is not offered (its lot still is), is held with its hold, and its issue by its tag is refused in words', async () => {
    const holdId = await placeHold('Hide', [hides.H1!.id])
    const list = await ok('floor', 'GET', `/inventory/picking/work-orders/${WO.one.id}`)
    const leather = lineOf(list, A.leather, A.leatherBLK)
    const codes = (leather.usable.candidates as Json[]).map((candidate) => candidate.hideCode)
    expect(codes).not.toContain(hides.H1!.code)
    expect(codes).toEqual(expect.arrayContaining([hides.H2!.code, hides.H3!.code, hides.H4!.code]))
    expect(leather.held).toEqual([expect.objectContaining({ reason: 'QUALITY_HOLD', lotCode: lots.BLK!.code, hideId: hides.H1!.id, hideCode: hides.H1!.code, onHand: '55.0000', hides: 1, hold: expect.objectContaining({ id: holdId, subjectType: 'Hide' }) })])
    const error = await refused('floor', 'POST', `/inventory/picking/work-orders/${WO.one.id}/issue`, { code: hides.H1!.code }, 409)
    expect(refusalOf(error)).toBe('refusal/QUALITY_HOLD')
    expect(error.message).toBe(`Hide ${hides.H1!.code} is on hold (Quality check, since 21 Nov 2026): it is not issued until quality releases the hold.`)
    // The floor never sees money, the held entries neither.
    expect(keysOf(list).filter((key) => MONEY.test(key))).toEqual([])
    // Readiness: with every other black hide on hand held too, no black leather is stock for the plan any more.
    const leatherInStock = async () => materialOf(rowOf(await ok('warehouse', 'GET', '/inventory/picking/pick-lists?limit=200'), WO.one.id)!, A.leather).inStock as string
    expect(Number(await leatherInStock())).toBeGreaterThan(0)
    const others = await admin<{ id: string }>(
      `SELECT h.id FROM "Hide" h JOIN "Lot" l ON l.id = h."lotId" WHERE h."tenantId" = $1 AND h."siteId" = $2 AND l."itemColourId" = $3 AND h.id <> $4
          AND (SELECT coalesce(sum(CASE WHEN m."toLocationId" IS NOT NULL THEN m."baseQuantity" ELSE 0 END) - sum(CASE WHEN m."fromLocationId" IS NOT NULL THEN m."baseQuantity" ELSE 0 END), 0) FROM "StockMove" m WHERE m."hideId" = h.id) > 0`,
      [A.tenant, A.siteA1, A.leatherBLK, hides.H1!.id],
    )
    const allHeld = await placeHold('Hide', others.map((row) => row.id))
    try {
      expect(await leatherInStock()).toBe('0.0000')
    } finally {
      await liftHold(allHeld)
      await liftHold(holdId)
    }
    expect(Number(await leatherInStock())).toBeGreaterThan(0)
    expect((lineOf(await ok('floor', 'GET', `/inventory/picking/work-orders/${WO.one.id}`), A.leather, A.leatherBLK).usable.candidates as Json[]).map((candidate) => candidate.hideCode)).toContain(hides.H1!.code)
  })
})

// ---- the pick lists of many work orders ------------------------------------------------------------------------------------

describe('Picking & kits (SCR-237): one row per work order with readiness, lines picked, kit state and team', () => {
  it('lists the released, in-progress and held work orders (no draft), with the saved rows and tiles, and no money', async () => {
    const answer = await ok('viewer', 'GET', '/inventory/picking/pick-lists?limit=200')
    const numbers = (answer.rows as Json[]).map((row) => row.workOrder.number)
    expect(numbers).toEqual(expect.arrayContaining([WO.one.number, WO.two.number, WO.three.number, 'SEED-WO-0001']))
    expect(numbers).not.toContain('SEED-WO-0002')
    const one = rowOf(answer, WO.one.id)!
    expect(one).toMatchObject({ workOrder: { status: 'RELEASED', pieces: 1, style: { code: 'SEED-JKT-02' }, onHold: null }, kit: { status: 'OPEN', location: null }, pickList: { created: false, reservations: 0 }, pickedBy: [], startedAt: null, finishedAt: null })
    expect(one.lines).toEqual({ all: 3, picked: 0, short: 3 })
    expect(answer.tiles.all).toBe(answer.rows.length)
    expect(answer.sites).toEqual(expect.arrayContaining([expect.objectContaining({ id: A.siteA1, code: 'A1' })]))
    const toCreate = await ok('viewer', 'GET', '/inventory/picking/pick-lists?view=toCreate&limit=200')
    expect((toCreate.rows as Json[]).map((row) => row.workOrder.id)).toEqual(expect.arrayContaining([WO.one.id, WO.two.id]))
    expect((toCreate.rows as Json[]).map((row) => row.workOrder.id)).not.toContain(WO.three.id)
    expect(toCreate.total).toBe(answer.tiles.toCreate)
    const searched = await ok('viewer', 'GET', `/inventory/picking/pick-lists?q=${encodeURIComponent(WO.two.number)}`)
    expect((searched.rows as Json[]).map((row) => row.workOrder.id)).toEqual([WO.two.id])
    const paged = await ok('viewer', 'GET', '/inventory/picking/pick-lists?limit=2')
    expect(paged.rows).toHaveLength(2)
    expect(paged.nextCursor).toBe('2')
    expect(keysOf(answer).filter((key) => MONEY.test(key))).toEqual([])
  })

  it('Create pick lists reserves each work order its need, oldest first and never the same hide twice; a second time reserves nothing', async () => {
    const created = await ok('warehouse', 'POST', '/inventory/picking/pick-lists', { siteId: A.siteA1, workOrderIds: [WO.one.id, WO.two.id, A.draftWorkOrder] }, 201)
    expect(created.created).toBe(2)
    const [one, two, draft] = created.results as [Json, Json, Json]
    expect(one).toMatchObject({ workOrderId: WO.one.id, outcome: 'CREATED', refusal: null })
    expect(two).toMatchObject({ workOrderId: WO.two.id, outcome: 'CREATED', refusal: null })
    expect(draft).toMatchObject({ workOrderId: A.draftWorkOrder, number: 'SEED-WO-0002', outcome: 'REFUSED', refusal: { code: 'NOT_RELEASED' } })
    const leatherOf = (result: Json) => (result.reserved as Json[]).filter((pick) => pick.kind === 'HIDE').map((pick) => pick.hideCode)
    expect(leatherOf(one).length).toBeGreaterThan(0)
    expect(leatherOf(one).filter((code: string) => leatherOf(two).includes(code))).toEqual([])
    const rows = await admin<{ workOrderId: string; hideId: string | null; note: string }>(`SELECT "workOrderId", "hideId", note FROM "Reservation" WHERE "workOrderId" = ANY($1::uuid[]) AND status = 'ACTIVE'`, [[WO.one.id, WO.two.id]])
    expect(rows.every((row) => row.note === 'Pick list (Warehouse › Picking & kits)')).toBe(true)
    expect(new Set(rows.flatMap((row) => (row.hideId ? [row.hideId] : []))).size).toBe(rows.filter((row) => row.hideId).length)

    const list = await ok('viewer', 'GET', '/inventory/picking/pick-lists?limit=200')
    expect(rowOf(list, WO.one.id)!.pickList).toMatchObject({ created: true })
    expect(materialOf(rowOf(list, WO.one.id)!, A.protector)).toMatchObject({ word: 'RECEIVED' })
    const again = await ok('warehouse', 'POST', '/inventory/picking/pick-lists', { siteId: A.siteA1, workOrderIds: [WO.one.id] }, 201)
    expect(again).toEqual({ created: 0, results: [expect.objectContaining({ workOrderId: WO.one.id, outcome: 'NOTHING_TO_RESERVE', reserved: [] })] })
    expect((await refused('viewer', 'POST', '/inventory/picking/pick-lists', { siteId: A.siteA1, workOrderIds: [WO.one.id] }, 403)).code).toBe('forbidden')
    expect(paths(await refused('warehouse', 'POST', '/inventory/picking/pick-lists', { siteId: A.siteA1, workOrderIds: [] }, 400))).toEqual(['body/workOrderIds'])
  })

  it('the sheets show each line with its reservations and where they lie; an issue by the floor makes the kit PARTLY with its team', async () => {
    const { sheets } = await ok('viewer', 'GET', `/inventory/picking/pick-lists/sheet?workOrderIds=${WO.one.id},${WO.two.id}`)
    expect((sheets as Json[]).map((sheet) => sheet.workOrder.id)).toEqual([WO.one.id, WO.two.id])
    const leather = lineOf(sheets[0], A.leather, A.leatherBLK)
    expect(leather.pick.proposed).toEqual([])
    expect(leather.pick.reservations.length).toBeGreaterThan(0)
    expect(leather.pick.reservations[0]).toMatchObject({ status: 'ACTIVE', lotCode: lots.BLK!.code, locations: [expect.objectContaining({ locationCode: 'A1-STORE-01' })] })
    const reservedHide = leather.pick.reservations[0].hideCode as string
    const issued = await call('floor', 'POST', `/inventory/picking/work-orders/${WO.one.id}/issue`, { code: reservedHide })
    expect(issued.statusCode, issued.body).toBe(201)
    const row = rowOf(await ok('viewer', 'GET', '/inventory/picking/pick-lists?limit=200'), WO.one.id)!
    expect(row.kit.status).toBe('PARTLY')
    expect(row.startedAt).not.toBeNull()
    expect(row.pickedBy).toEqual([{ kind: 'TEAM', name: expect.any(String) }])
    expect((await refused('viewer', 'GET', `/inventory/picking/pick-lists/sheet?workOrderIds=${newId()}`, undefined, 404)).code).toBe('not_found')
    expect(paths(await refused('viewer', 'GET', '/inventory/picking/pick-lists/sheet?workOrderIds=nope', undefined, 400))).toEqual(['querystring/workOrderIds'])
  })
})

const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
