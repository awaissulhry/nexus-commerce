import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { fixedClock } from '@nexus/factory-domain/core/time'
import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedHolds, type HoldsSeed } from '../../../../../../packages/factory-db/seed/holds'
import { seed as seedShipping, type ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { useTraceClock } from './trace'

/**
 * The trace both ways (B-W2a-27; SCM-240, SCM-241) on the local stack, with the app's real routes: a throwaway PostgreSQL
 * 17 database from the migrations (the runtime login: row-level security is real) and the factory-db seeds of two
 * tenants. Tenant A's world: lot SEED-LOT-LEA-01 (receipt SEED-GR-0001 from P2) with hides SEED-HIDE-0001 (issued whole
 * to SEED-WO-0001, cut, two bundles of sleeves naming the cut) and SEED-HIDE-0002 (on hold at the cutting table);
 * SEED-WO-0001 (batch SEED-BT-0001, batch-tracked) shipped BLK 50 and RED 52 on SEED-SH-0001 to P1 with DDT 144/2026
 * (143/2026 cancelled); SEED-WO-0003 (serial-tracked, nothing issued) with three serials and one garment on the DRAFT
 * SEED-SH-0002; the opening-stock lining lot SEED-LOT-LIN-01. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/inventory/trace`.
 */

type Json = Record<string, any>

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let world: ShippingSeed
let holds: HoldsSeed

const ns = { a: 'trace-a', b: 'trace-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = { tenant: idOf(ns.a, 'tenant'), companyA: idOf(ns.a, 'company:A'), companyB: idOf(ns.a, 'company:B'), siteA1: idOf(ns.a, 'site:A1'), P1: idOf(ns.a, 'party:P1'), P2: idOf(ns.a, 'party:P2') }
const B = { tenant: idOf(ns.b, 'tenant') }

const VIEW: Permission = 'inventory.stock.view'
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties })
const SESSIONS: Record<string, SessionContext> = {
  warehouse: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant([VIEW, 'parties.view'])] },
  stockOnly: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant([VIEW])] },
  partyP2: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant([VIEW]), grant(['parties.view'], 'all', [A.P2])] },
  companyB: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant([VIEW, 'parties.view'], [A.companyB])] },
  partiesOnly: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['parties.view'])] },
  otherTenant: { audience: 'office', tenantId: B.tenant, actorId: newId(), grants: [grant([VIEW, 'parties.view'])] },
  floor: { audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: A.siteA1, deviceId: newId(), grants: [{ permissions: [VIEW], companies: [A.companyA], sites: [A.siteA1], parties: 'all' }] },
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
async function ok(session: string, url: string): Promise<Json> {
  const response = await call(session, url)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const trace = (session: string, kind: string, id: string, direction = 'BOTH') => ok(session, `/inventory/trace?kind=${kind}&id=${id}&direction=${direction}`)
const find = (session: string, code: string) => ok(session, `/inventory/trace/find?code=${encodeURIComponent(code)}`)
const nodesOf = (body: Json, kind: string) => body.nodes.filter((node: Json) => node.kind === kind).map((node: Json) => `${node.code}:${node.reach}`).sort()
const node = (body: Json, kind: string, id: string) => body.nodes.find((row: Json) => row.key === `${kind}:${id}`)
const gaps = (body: Json) => body.gaps.map((gap: Json) => `${gap.code}:${gap.severity}`).sort()

beforeAll(async () => {
  db = await migratedDatabase('inventory_trace')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: database, namespace })
  holds = await seedHolds({ db: database, namespace: ns.a })
  world = await seedShipping({ db: database, namespace: ns.a })
  await seedShipping({ db: database, namespace: ns.b })
  useTraceClock(fixedClock('2026-12-01T09:00:00.000Z'))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      clock: fixedClock('2026-12-01T09:00:00.000Z'),
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
      logger: false,
    },
  )
}, 240_000)

afterAll(async () => {
  useTraceClock(undefined)
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

const inventory = () => world.quality.production.inventory
const leatherLot = () => inventory().leatherLotId
const [hide1, hide2] = [() => inventory().hideIds[0], () => inventory().hideIds[1]]
const workOrder = () => world.quality.production.workOrderId

describe('find: one field, any code (design lt-trace)', () => {
  it('recognises a batch number, a hide tag or the tannery number, a serial, a lot, a shipment and its DDTs, letter case aside', async () => {
    expect((await find('warehouse', 'seed-bt-0001')).matches).toEqual([expect.objectContaining({ kind: 'WORK_ORDER', id: workOrder(), code: 'SEED-WO-0001', matchedBy: 'BATCH_NUMBER' })])
    expect((await find('warehouse', 'SEED-WO-0001')).matches).toEqual([expect.objectContaining({ kind: 'WORK_ORDER', matchedBy: 'WORK_ORDER_NUMBER' })])
    expect((await find('warehouse', 'SEED-HIDE-0001')).matches).toEqual([expect.objectContaining({ kind: 'HIDE', id: hide1(), matchedBy: 'HIDE_TAG', label: 'Hide of lot SEED-LOT-LEA-01' })])
    expect((await find('warehouse', 't-58102')).matches).toEqual([expect.objectContaining({ kind: 'HIDE', id: hide2(), matchedBy: 'TANNERY_NUMBER' })])
    expect((await find('warehouse', 'SEED-LOT-LEA-01')).matches).toEqual([expect.objectContaining({ kind: 'LOT', id: leatherLot(), matchedBy: 'LOT_CODE' })])
    const [serial] = await admin<{ serial: string }>('SELECT serial FROM "GarmentSerial" WHERE id = $1', [world.quality.serialIds[1]])
    expect((await find('warehouse', serial!.serial.toLowerCase())).matches).toEqual([expect.objectContaining({ kind: 'SERIAL', id: world.quality.serialIds[1], matchedBy: 'SERIAL' })])
    expect((await find('warehouse', 'SEED-SH-0002')).matches).toEqual([expect.objectContaining({ kind: 'SHIPMENT', id: world.draftShipmentId, matchedBy: 'SHIPMENT_NUMBER' })])
    expect((await find('warehouse', '144/2026')).matches).toEqual([expect.objectContaining({ kind: 'SHIPMENT', id: world.shipmentId, matchedBy: 'DDT_NUMBER', label: 'DDT 144/2026 · SHIPPED' })])
    expect((await find('warehouse', '143/2026')).matches).toEqual([expect.objectContaining({ kind: 'SHIPMENT', id: world.shipmentId, label: 'DDT 143/2026 (cancelled) · SHIPPED' })])
    // A DDT for another reason (the repair's 145/2026) carries no shipment: nothing to trace from it here.
    expect((await find('warehouse', '145/2026')).matches).toEqual([])
  })

  it('an old bundle ticket finds the bundle on its new one', async () => {
    const [reprinted] = await admin<{ id: string; code: string; old: string }>(`SELECT id, code, "replacedCodes"[1] AS old FROM "Bundle" WHERE cardinality("replacedCodes") > 0 AND "workOrderId" = $1`, [workOrder()])
    const found = await find('warehouse', reprinted!.old)
    expect(found.matches).toEqual([expect.objectContaining({ kind: 'BUNDLE', id: reprinted!.id, code: reprinted!.code, matchedBy: 'OLD_BUNDLE_TICKET' })])
    expect((await find('warehouse', reprinted!.code)).matches).toEqual([expect.objectContaining({ kind: 'BUNDLE', matchedBy: 'BUNDLE_TICKET' })])
  })

  it('says in words what it cannot read; finds nothing of a company or tenant the caller does not reach', async () => {
    expect(await find('warehouse', 'NOT-A-CODE-9')).toEqual({ code: 'NOT-A-CODE-9', matches: [], problem: null })
    const foreign = formatScanId({ type: 'HIDE', tenantTag: tenantTag(B.tenant) === tenantTag(A.tenant) ? '00' : tenantTag(B.tenant), ref: 7 })
    expect((await find('warehouse', foreign)).problem).toBe('This label belongs to another factory.')
    const location = formatScanId({ type: 'LOCATION', tenantTag: tenantTag(A.tenant), ref: 3 })
    expect((await find('warehouse', location)).problem).toContain('This is a location label')
    expect((await find('companyB', 'SEED-BT-0001')).matches).toEqual([])
    expect((await find('otherTenant', 'SEED-HIDE-0001')).matches.map((row: Json) => row.id)).not.toContain(hide1())
  })
})

describe('forward: where a lot went (SCM-241)', () => {
  it('the leather lot: its hides, the work order its hide went to, the bundles naming the cut, the shipment by size and the customer', async () => {
    const body = await trace('warehouse', 'LOT', leatherLot(), 'FORWARD')
    expect(body.start).toEqual({ key: `LOT:${leatherLot()}`, kind: 'LOT', id: leatherLot(), code: 'SEED-LOT-LEA-01' })
    expect(body.asOf).toBe('2026-12-01T09:00:00.000Z')
    expect(nodesOf(body, 'HIDE')).toEqual(['SEED-HIDE-0001:EXACT', 'SEED-HIDE-0002:EXACT'])
    expect(nodesOf(body, 'WORK_ORDER')).toEqual(['SEED-WO-0001:EXACT'])
    expect(nodesOf(body, 'BUNDLE')).toHaveLength(2)
    expect(body.nodes.filter((row: Json) => row.kind === 'BUNDLE').every((row: Json) => row.reach === 'EXACT')).toBe(true)
    // Batch-tracked: SEED-SH-0001 names the size BLK 50, not the bundle.
    expect(nodesOf(body, 'SHIPMENT')).toEqual(['SEED-SH-0001:POSSIBLE'])
    expect(body.nodes.find((row: Json) => row.kind === 'CUSTOMER')).toMatchObject({ id: A.P1, reach: 'POSSIBLE', received: true, party: { id: A.P1, code: expect.any(String) }, restricted: [] })
    expect(body.customersReceived).toEqual({ exact: 0, possible: 1 })
    expect(gaps(body)).toEqual(['BATCH_TRACKED:COARSE'])
    expect(body.gaps[0].message).toContain('SEED-WO-0001')
    // The issue edge carries the hide's area; the hide on hold at the cutting table says so.
    expect(body.edges).toContainEqual(expect.objectContaining({ from: `HIDE:${hide1()}`, to: `WORK_ORDER:${workOrder()}`, link: 'ISSUED', exact: true, quantity: '53.2000', uom: 'FT2' }))
    expect(node(body, 'HIDE', hide2()).holds).toEqual([expect.objectContaining({ id: holds.holdId, reasonCode: expect.any(String) })])
    expect(node(body, 'LOT', leatherLot()).lot).toMatchObject({ qualityStatus: 'RELEASED', crVi: { status: 'PASS' }, item: { baseUom: 'FT2', tracking: 'HIDE' } })
    expect(body.levels.map((level: Json) => level.kind)).toEqual(['LOT', 'HIDE', 'WORK_ORDER', 'CELL', 'BUNDLE', 'SHIPMENT', 'CUSTOMER'])
    // Never a cost, a price or a worker.
    expect(JSON.stringify(body)).not.toMatch(/cost|price|margin|wage|worker/i)
  })

  it('a work order (its batch) forward is whole: its shipment and customer exactly, only the live DDT', async () => {
    const body = await trace('warehouse', 'WORK_ORDER', workOrder(), 'FORWARD')
    expect(nodesOf(body, 'SHIPMENT')).toEqual(['SEED-SH-0001:EXACT'])
    expect(node(body, 'SHIPMENT', world.shipmentId).shipment).toMatchObject({ status: 'SHIPPED', left: true, ddtNumbers: ['144/2026'] })
    expect(body.customersReceived).toEqual({ exact: 1, possible: 0 })
    expect(body.gaps).toEqual([])
    const cells = body.nodes.filter((row: Json) => row.kind === 'CELL')
    expect(cells.map((row: Json) => row.code).sort()).toEqual(['BLK 50', 'BLK 52', 'BLK 54', 'RED 50', 'RED 52', 'RED 54'])
    expect(cells.find((row: Json) => row.code === 'BLK 50').cell).toMatchObject({ shipped: 1, packed: 0 })
  })

  it('the opening lining lot was never issued: the lot alone, its stock on hand', async () => {
    const body = await trace('warehouse', 'LOT', inventory().liningLotId, 'FORWARD')
    expect(body.nodes.map((row: Json) => row.kind)).toEqual(['LOT'])
    expect(body.nodes[0].lot).toMatchObject({ onHand: '120.0000', scrapped: '0.0000' })
  })
})

describe('backward: where it came from (SCM-240)', () => {
  it('a shipment that left: its sizes, every bundle of them as possible, the hide, the lot, the receipt and the supplier', async () => {
    const body = await trace('warehouse', 'SHIPMENT', world.shipmentId, 'BACKWARD')
    expect(nodesOf(body, 'CELL')).toEqual(['BLK 50:EXACT', 'RED 52:EXACT'])
    expect(nodesOf(body, 'WORK_ORDER')).toEqual(['SEED-WO-0001:EXACT'])
    expect(nodesOf(body, 'HIDE')).toEqual(['SEED-HIDE-0001:POSSIBLE'])
    expect(nodesOf(body, 'LOT')).toEqual(['SEED-LOT-LEA-01:POSSIBLE'])
    expect(nodesOf(body, 'RECEIPT')).toEqual(['SEED-GR-0001:POSSIBLE'])
    expect(node(body, 'RECEIPT', inventory().receiptId).receipt).toMatchObject({ status: 'POSTED', supplierDdtNumber: expect.any(String) })
    expect(body.nodes.find((row: Json) => row.kind === 'SUPPLIER')).toMatchObject({ id: A.P2, party: { id: A.P2 } })
    expect(nodesOf(body, 'CUSTOMER')).toEqual([])
    expect(gaps(body)).toEqual(['BATCH_TRACKED:COARSE'])
  })

  it('the work order (its batch) took the hide exactly: the lot, the receipt, the purchase order line and the supplier', async () => {
    const body = await trace('warehouse', 'WORK_ORDER', workOrder(), 'BACKWARD')
    expect(nodesOf(body, 'HIDE')).toEqual(['SEED-HIDE-0001:EXACT'])
    expect(nodesOf(body, 'LOT')).toEqual(['SEED-LOT-LEA-01:EXACT'])
    expect(node(body, 'LOT', leatherLot()).lot.purchaseOrder).toMatchObject({ id: inventory().supply.purchaseOrderId, lineSeq: expect.any(Number) })
    expect(body.nodes.find((row: Json) => row.kind === 'SUPPLIER')).toMatchObject({ id: A.P2, reach: 'EXACT' })
    expect(body.edges).toContainEqual(expect.objectContaining({ from: `SUPPLIER:${A.P2}`, to: `RECEIPT:${inventory().receiptId}`, link: 'SUPPLIED' }))
  })

  it('a serial given before its bundle, of a work order with nothing issued: the broken link is named, never skipped', async () => {
    const serialId = world.quality.serialIds[1]
    const body = await trace('warehouse', 'SERIAL', serialId, 'BACKWARD')
    expect(node(body, 'SERIAL', serialId).sides).toEqual(['START'])
    expect(nodesOf(body, 'LOT')).toEqual([])
    expect(gaps(body)).toEqual(['NO_ISSUE:BROKEN', 'SERIAL_WITHOUT_BUNDLE:COARSE'])
    expect(body.gaps.find((gap: Json) => gap.code === 'NO_ISSUE').message).toBe('Work order SEED-WO-0003 has no material issued or cut on record: the trace cannot reach its lots.')
  })

  it('a draft shipment: its garment carries no serial on record; its customer has not received it', async () => {
    const body = await trace('warehouse', 'SHIPMENT', world.draftShipmentId, 'BOTH')
    expect(gaps(body)).toEqual(['LINE_WITHOUT_SERIALS:COARSE', 'NO_ISSUE:BROKEN'])
    expect(body.nodes.find((row: Json) => row.kind === 'CUSTOMER')).toMatchObject({ id: A.P1, reach: 'EXACT', received: false, sides: ['FORWARD'] })
    expect(body.customersReceived).toEqual({ exact: 0, possible: 0 })
  })

  it('opening stock has no receipt and no supplier: said in words', async () => {
    const body = await trace('warehouse', 'LOT', inventory().liningLotId, 'BACKWARD')
    expect(gaps(body)).toEqual(['NO_SUPPLIER:BROKEN', 'OPENING_STOCK:BROKEN'])
    expect(body.gaps.find((gap: Json) => gap.code === 'OPENING_STOCK').message).toContain('SEED-LOT-LIN-01 came in as opening stock')
  })
})

describe('both ways and the reader’s rights', () => {
  it('BOTH from a hide: the lot and supplier behind it, the work order, bundles, shipment and customer ahead', async () => {
    const body = await trace('warehouse', 'HIDE', hide1())
    expect(body.direction).toBe('BOTH')
    expect(node(body, 'HIDE', hide1()).sides).toEqual(['START'])
    expect(node(body, 'LOT', leatherLot()).sides).toEqual(['BACKWARD'])
    expect(nodesOf(body, 'SHIPMENT')).toEqual(['SEED-SH-0001:POSSIBLE'])
    // Backward never walks forward again: the other hide of the lot is not reached.
    expect(node(body, 'HIDE', hide2())).toBeUndefined()
  })

  it('without parties.view the supplier and the customer are counted, never named', async () => {
    const body = await trace('stockOnly', 'WORK_ORDER', workOrder())
    const parties = body.nodes.filter((row: Json) => row.kind === 'SUPPLIER' || row.kind === 'CUSTOMER')
    expect(parties).toHaveLength(2)
    expect(parties.every((row: Json) => row.party === null && row.code === null && row.restricted.join() === 'parties.view')).toBe(true)
    expect(body.restricted).toEqual([{ permission: 'parties.view', nodes: 2 }])
    expect(body.customersReceived).toEqual({ exact: 1, possible: 0 })
  })

  it('parties.view on P2 only: the supplier P2 is named, the customer P1 is not', async () => {
    const body = await trace('partyP2', 'WORK_ORDER', workOrder())
    expect(body.nodes.find((row: Json) => row.kind === 'SUPPLIER').party).toMatchObject({ id: A.P2 })
    expect(body.nodes.find((row: Json) => row.kind === 'CUSTOMER')).toMatchObject({ party: null, restricted: ['parties.view'] })
  })

  it('refusals: another company or tenant is not found, the floor and a caller without stock.view are forbidden, a bad kind is a 400', async () => {
    const url = `/inventory/trace?kind=LOT&id=${leatherLot()}`
    expect((await call('companyB', url)).statusCode).toBe(404)
    expect((await call('otherTenant', url)).statusCode).toBe(404)
    expect((await call('floor', url)).statusCode).toBe(403)
    expect((await call('partiesOnly', url)).statusCode).toBe(403)
    expect((await call('warehouse', `/inventory/trace?kind=LOT&id=${newId()}`)).statusCode).toBe(404)
    expect((await call('warehouse', `/inventory/trace?kind=PALLET&id=${leatherLot()}`)).statusCode).toBe(400)
    expect((await call('warehouse', `/inventory/trace?kind=LOT&id=${leatherLot()}&direction=SIDEWAYS`)).statusCode).toBe(400)
    expect((await call('floor', '/inventory/trace/find?code=SEED-BT-0001')).statusCode).toBe(403)
  })
})
