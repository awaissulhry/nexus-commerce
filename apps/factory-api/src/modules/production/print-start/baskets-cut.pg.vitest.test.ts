import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { readCuts } from '../../sales/change-requests/store'
import { readStages } from '../../sales/order-changes/stages'

/**
 * Guard 6 of baskets made at print (owb- order workflow, S3 ss2 step 2.4; PL-review § 4 guards 1–3, 6; G10) on the local stack with
 * the app's real routes and the cutting world of bundles/tracked.pg (seeds core, privacy, production, numbering; a made-up
 * certificate of SEED-JKT-02; a made-up lot of black hides at A1): an order printed and started by Sales (its two baskets made at
 * print, site A1's switch on) → hide 1 cut for it → the bench's "Make bundles" ATTACHES the cut to the baskets (no new bundle, no
 * new code; production.bundle_created now, once per basket) → hide 2 cut → "Make bundles" GROWS their entries (the database's
 * G10 (b): old ones stay) → the lot of hide 2 reaches the basket (the trace's link: Bundle.cutLogIds → CutLog.hideId → Hide.lotId).
 * Before the first cut the customer's stage is not "Cutting" (guard 3: the change-request and order-change readers). Every name
 * and number is made up. WRITTEN, NOT RUN (Owner rule: tests at the end). Run with `node scripts/factory/run-pg-tests.mjs baskets-cut`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = 'baskets-cut'
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
  bin: idOf('inventory:location:A1-STORE-01'),
  deviceA1: idOf('device:A1:cutting'),
  operatorA1: idOf('worker:A1:operator'),
}

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const sales = templateOf('sales')!
const FLOOR: Permission[] = ['floor.work', 'production.cut', 'production.bundles', 'production.scan', 'production.serials', 'inventory.issue', 'print.view', 'print.labels']
const SESSIONS: Record<string, SessionContext> = {
  sales: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant([...sales.permissions, ...sales.grains.map((grain) => grainPermission(grain) as Permission)])] },
  floor: { audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: A.siteA1, deviceId: A.deviceA1, grants: [grant(FLOOR, [A.companyA], [A.siteA1])] },
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `bc-${run}-${++keys}`
let events = 0
const clientEvent = () => `bc-ce-${run}-${++events}`
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction(work, { timeout: 30_000 }))
const inScope = <T>(work: (client: any) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, work)

const hides: Record<string, { id: string; code: string; lotId: string }> = {}
/** One lot of big black hides at A1 (made-up facts, as tracked.pg's). */
async function addLot(keyList: string[]) {
  const lotId = newId()
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "dyeBatch", shade, "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, '77A', 'A', 'RELEASED', now(), true, '3.000', 'PASS', '1.100', 'LOT_REPORT', '2026-10-01', '2026-10-05T08:00:00Z')`,
    [lotId, A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, `BC-${run}-LOT`],
  )
  for (const key of keyList) {
    const hideId = newId()
    hides[key] = { id: hideId, code: `BC-${run}-${key}`, lotId }
    await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea", grade, "thicknessMm") VALUES ($1, $2, $3, $4, $5, $6, '1000.0000', 'FT2', '1000.0000', 'A', '1.10')`, [hideId, A.tenant, A.siteA1, lotId, A.leather, hides[key].code])
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt")
       VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, '1000.0000', 'FT2', '1000.0000', $10, now())`,
      [newId(), A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, lotId, hideId, A.bin, `baskets-cut-${run}-${key}`],
    )
  }
}

const ids: Record<string, string> = {}

beforeAll(async () => {
  db = await migratedDatabase('baskets_cut')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedPrivacy({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await asOffice(async (tx) => {
    const certificateId = newId()
    await tx.certificate.create({
      data: { id: certificateId, holderPartyId: A.brand, standard: 'EN 17092-3:2020', ppeClass: 'AA', number: `BC-${run}-CERT`, notifiedBodyName: 'Made-up Notified Body', notifiedBodyNumber: '9999', modelReference: 'SEED-JKT-02', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2030-12-31T00:00:00.000Z'), status: 'VALID', statusChangedAt: new Date() },
      select: { id: true },
    })
    await tx.certificateCoverage.create({ data: { id: newId(), certificateId, styleId: A.style, sizes: ['50', '52'] }, select: { id: true } })
    // A CONFIRMED order of two black SEED-JKT-02 in size 50 (made up), made at A1.
    ids.order = newId()
    ids.line = newId()
    await tx.salesOrder.create({
      data: { id: ids.order, companyId: A.companyA, partyId: A.brand, number: `BC-${run}-SO`, status: 'CONFIRMED', orderDate: new Date('2026-10-20T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-10T00:00:00.000Z'), depositRequired: false },
      select: { id: true },
    })
    await tx.salesOrderLine.create({
      data: { id: ids.line, companyId: A.companyA, orderId: ids.order, partyId: A.brand, seq: 10, kind: 'SIZE_GRID', styleId: A.style, colourwayId: A.blk, quantity: 2, unitPrice: '100.000000', netAmount: 20_000, vatRatePct: '22.00', vatAmount: 4_400, siteId: A.siteA1 },
      select: { id: true },
    })
    await tx.salesOrderLineSize.create({ data: { id: newId(), lineId: ids.line, partyId: A.brand, size: '50', quantity: 2 }, select: { id: true } })
  })
  await addLot(['H1', 'H2'])
  // Site A1 makes its baskets at print (made-up fact: the base seed turns it on at A1; set here in case this seed set did not).
  await admin(
    `INSERT INTO "ProductionSettings" (id, "tenantId", "companyId", "siteId", "basketsAtPrint") VALUES ($1, $2, $3, $1, true) ON CONFLICT (id) DO UPDATE SET "basketsAtPrint" = true`,
    [A.siteA1, A.tenant, A.companyA],
  )
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

const basketsOf = () => admin<{ id: string; code: string; cutLogIds: string[] }>(`SELECT b.id, b.code, b."cutLogIds"::text[] AS "cutLogIds" FROM "Bundle" b WHERE b."workOrderId" = $1 AND b."madeAtPrint" ORDER BY b.code`, [ids.workOrder])
const cutLogs = () => admin<{ id: string; hideId: string }>(`SELECT id, "hideId" FROM "CutLog" WHERE "workOrderId" = $1 AND "reversalOfId" IS NULL ORDER BY "serverTime", id`, [ids.workOrder])
const created = async (bundleIds: readonly string[]) => (await admin(`SELECT 1 FROM "OutboxEvent" WHERE type = 'production.bundle_created' AND payload->>'bundleId' = ANY($1::text[])`, [bundleIds])).length

async function cut(hideKey: string): Promise<void> {
  const cells = await admin<{ id: string }>(`SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1`, [ids.workOrder])
  const response = await call('floor', 'POST', `/production/cutting/work-orders/${ids.workOrder}/cuts`, { clientEventId: clientEvent(), code: hides[hideKey]!.code, lines: cells.map((cell) => ({ workOrderSizeId: cell.id, sets: 1 })) }, freshKey())
  expect(response.statusCode, response.body).toBe(201)
}

describe('guard 6: cut into baskets made at print, then trace a lot to a garment', () => {
  it('printed and started by Sales: two baskets, no cut entry; the customer’s stage is not "Cutting" (guard 3)', async () => {
    const version = (await admin<{ version: number }>(`SELECT version FROM "SalesOrder" WHERE id = $1`, [ids.order]))[0]!.version
    const printed = await ok('sales', 'POST', `/production/orders/${ids.order}/print-and-start`, { version, materialReason: 'Test: the leather is at A1' })
    expect(printed.baskets).toBe(2)
    ids.workOrder = printed.workOrders[0].id
    const baskets = await basketsOf()
    expect(baskets.map((basket) => basket.cutLogIds)).toEqual([[], []])
    expect(await created(baskets.map((basket) => basket.id))).toBe(0)
    const cuts = await inScope((client) => readCuts(client, [ids.line!]))
    expect(cuts.size).toBe(0)
    const stages = await inScope((client) => readStages(client, [ids.line!]))
    expect(JSON.stringify(stages)).not.toContain('"CUT"')
  })

  it('hide 1 cut, then "Make bundles": the cut goes ON the baskets (no new bundle, no new code); bundle_created once per basket now', async () => {
    await cut('H1')
    const codes = (await basketsOf()).map((basket) => basket.code)
    const made = await ok('floor', 'POST', `/production/bundles/work-orders/${ids.workOrder}/bundles`, { printerId: null }, 201, freshKey())
    expect(made.bundles).toEqual([])
    const [first] = await cutLogs()
    const baskets = await basketsOf()
    expect(baskets.map((basket) => basket.code)).toEqual(codes)
    expect(baskets.map((basket) => basket.cutLogIds)).toEqual([[first!.id], [first!.id]])
    expect(await admin(`SELECT count(*)::int AS n FROM "Bundle" WHERE "workOrderId" = $1`, [ids.workOrder])).toEqual([{ n: 2 }])
    expect(await created(baskets.map((basket) => basket.id))).toBe(2)
    // Now the cell IS cut: the reader says so (from the cut log and the attached baskets).
    expect((await inScope((client) => readCuts(client, [ids.line!]))).size).toBe(1)
  })

  it('hide 2 cut, then "Make bundles" again: the entries GROW (old first), no second bundle_created; nothing new cut: refused in the print words', async () => {
    await cut('H2')
    await ok('floor', 'POST', `/production/bundles/work-orders/${ids.workOrder}/bundles`, { printerId: null }, 201, freshKey())
    const [first, second] = await cutLogs()
    const baskets = await basketsOf()
    expect(baskets.map((basket) => basket.cutLogIds)).toEqual([[first!.id, second!.id], [first!.id, second!.id]])
    expect(await created(baskets.map((basket) => basket.id))).toBe(2)
    const again = await call('floor', 'POST', `/production/bundles/work-orders/${ids.workOrder}/bundles`, { printerId: null }, freshKey())
    expect(again.statusCode, again.body).toBe(409)
    expect(again.json().error.message).toMatch(/^Baskets were made at print: the cuts go on them/)
  })

  it('the lot trace from hide 2 reaches the basket (Bundle.cutLogIds → CutLog → Hide → Lot)', async () => {
    const reached = await admin<{ bundleId: string }>(
      `SELECT DISTINCT b.id AS "bundleId" FROM "Bundle" b JOIN "CutLog" c ON c.id = ANY(b."cutLogIds") JOIN "Hide" h ON h.id = c."hideId" WHERE h.id = $1 AND h."lotId" = $2 AND b."madeAtPrint"`,
      [hides.H2!.id, hides.H2!.lotId],
    )
    expect(reached.map((row) => row.bundleId).sort()).toEqual((await basketsOf()).map((basket) => basket.id).sort())
  })

  // PL-review § 4 guard 4: a basket made at print with no report is WAITING (not CUTTING, never "stuck"): S5 fl2's where.ts
  // (owb-fl2 step 1b) — not on main when this was written.
  it.todo('a basket made at print with no report is at WAITING, not CUTTING, and the 4-hour stuck alarm never fires for it (S5 fl2)')
})
