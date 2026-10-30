import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedSubcontract, type SubcontractSeed } from '../../../../../../packages/factory-db/seed/subcontract'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, useFiles, type FilesRuntime } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'

/**
 * Subcontracting (B-W2a-25; SCM-138, SCM-140, SCM-141, SCM-142) on the local stack, with the app's real routes: a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the grants and the
 * …_supply_w2a_guards subcontract triggers, the DDT and cost-ledger guards are real), the factory-db seeds (WO-0001
 * IN_PROGRESS with its sewing operation, the workshop P2 with its location A1-TERZ-P2, SEED-SC-0001 DRAFT for the same
 * sewing, 120 m of grey lining lot SEED-LOT-LIN-01 in bin A1-STORE-01, two bundles of sleeves), the local file store for
 * the DDT's PDF, and sessions from the test authenticator. The routing's sewing step is made an outside operation of P2
 * here (5.25 a piece, 7 transit days). Every name, number and fee is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/purchasing/subcontracting`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let files: FilesRuntime
let seed: SubcontractSeed

const ns = { a: 'subcontract-a', b: 'subcontract-b' } as const
const idOf = (key: string) => seedUuid(ns.a, key)
const A = {
  tenant: idOf('tenant'),
  actor: idOf('actor'),
  companyA: idOf('company:A'),
  siteA1: idOf('site:A1'),
  P1: idOf('party:P1'),
  P2: idOf('party:P2'),
  lining: idOf('product:item:lining'),
  liningGrey: idOf('product:item-colour:lining:GRY'),
}
const YEAR = businessDate(new Date()).slice(0, 4)
const TODAY = businessDate(new Date())
const W2: string = newId()

const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  buyer: office(A.tenant, [grant(['purchasing.view', 'purchasing.subcontract.manage', 'money.cost', 'inventory.locations.view', 'inventory.locations.manage'])]),
  warehouse: office(A.tenant, [grant(['purchasing.view', 'purchasing.subcontract.kit', 'purchasing.subcontract.receive', 'shipping.view', 'shipping.ddt.issue', 'shipping.ddt.cancel', 'files.read'])]),
  kitNoDdt: office(A.tenant, [grant(['purchasing.view', 'purchasing.subcontract.kit'])]),
  planner: office(A.tenant, [grant(['purchasing.view'])]),
  otherWorkshop: office(A.tenant, [grant(['purchasing.view', 'purchasing.subcontract.manage', 'money.cost'], [A.P1])]),
  otherTenant: office(seedUuid(ns.b, 'tenant'), [grant(['purchasing.view', 'purchasing.subcontract.manage', 'money.cost'])]),
  floor: { audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: A.siteA1, deviceId: newId(), grants: [{ permissions: ['floor.work', 'purchasing.view', 'purchasing.subcontract.kit'], companies: [A.companyA], sites: [A.siteA1], parties: 'all' }] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `subcontract-test-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, idempotencyKey: string | undefined = method === 'GET' ? undefined : key()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const url = (id: string, rest = '') => `/purchasing/subcontracting/orders/${id}${rest}`
const eventsOf = async (subject: string) => (await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])).map((row) => row.type)
const TYPED_DDT = { transportBy: 'SENDER', packages: 2, grossWeightKg: '6.5', appearance: 'Scatole di cartone' } as const

let bin = ''
let liningLot = ''
let bundles: { id: string; code: string; quantity: number }[] = []

beforeAll(async () => {
  db = await migratedDatabase('subcontracting')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: database, namespace })
  seed = await seedSubcontract({ db: database, namespace: ns.a })
  await seedNumbering({ db: database, namespace: ns.a })
  bin = (await admin<{ id: string }>(`SELECT id FROM "Location" WHERE "tenantId" = $1 AND code = 'A1-STORE-01'`, [A.tenant]))[0]!.id
  liningLot = (await admin<{ id: string }>(`SELECT id FROM "Lot" WHERE "tenantId" = $1 AND code = 'SEED-LOT-LIN-01'`, [A.tenant]))[0]!.id
  bundles = await admin(`SELECT id, code, quantity FROM "Bundle" WHERE "workOrderId" = $1 ORDER BY code`, [seed.production.workOrderId])
  // The released revision's sewing step done by the workshop P2 (a released routing is frozen: its guard is off for this).
  await admin(`ALTER TABLE "RoutingOperation" DISABLE TRIGGER "RoutingOperation_revision_guard"`)
  await admin(
    `UPDATE "RoutingOperation" r SET "supplierId" = $1, "pricePerPiece" = 5.25, "transitDays" = 7
       FROM "WorkOrderOperation" o WHERE o.id = $2 AND r."revisionId" = o."styleRevisionId" AND r.seq = o."routingSeq"`,
    [A.P2, seed.production.operationIds.sew],
  )
  await admin(`ALTER TABLE "RoutingOperation" ENABLE TRIGGER "RoutingOperation_revision_guard"`)
  // A second made-up workshop of company A, and a supplier that does no outside work.
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles, status, country, currency, language) VALUES ($1, $2, $3, 'SC-W2', 'ORGANISATION', 'Second Workshop Srl', '{SUBCONTRACTOR}', 'ACTIVE', 'IT', 'EUR', 'it')`, [W2, A.tenant, A.companyA])
  // Made-up legal data (c.c. art. 2250) and the tenant's FAKE file store, as the DDT needs them.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [A.companyA])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'DDT', 'MAIN', $4, 'YEARLY', '{N}/{YYYY}', true) ON CONFLICT DO NOTHING`, [newId(), A.tenant, A.companyA, YEAR])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SUBCONTRACT', 'MAIN', $4, 'YEARLY', 'SC-{YYYY}-{N:4}', false) ON CONFLICT DO NOTHING`, [newId(), A.tenant, A.companyA, YEAR])
  await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1 AND kind IN ('DDT', 'SUBCONTRACT')`, [A.tenant])
  if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])).length === 0) {
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), A.tenant])
  }
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-subcontract-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  files = createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) })
  useFiles(files)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 240_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe("a workshop's stock location (SCM-141; the locations API takes its party)", () => {
  it('names its workshop exactly for kind SUBCONTRACTOR, one per workshop and site', async () => {
    const base = { siteId: A.siteA1, name: 'Workshop place', kind: 'SUBCONTRACTOR' }
    expect((await refused('buyer', 'POST', '/inventory/locations', { ...base, code: 'A1-TERZ-X' }, 400)).issues[0].path).toBe('body/partyId')
    expect((await refused('buyer', 'POST', '/inventory/locations', { ...base, code: 'A1-TERZ-X', partyId: A.P1 }, 400)).message).toContain('no subcontractor')
    expect((await refused('buyer', 'POST', '/inventory/locations', { ...base, code: 'A1-BIN-X', kind: 'BIN', partyId: W2 }, 400)).message).toContain('Only a SUBCONTRACTOR')
    expect((await refused('buyer', 'POST', '/inventory/locations', { ...base, code: 'A1-TERZ-P2B', partyId: A.P2 }, 409)).message).toContain('A1-TERZ-P2')
    const made = await ok('buyer', 'POST', '/inventory/locations', { ...base, code: 'A1-TERZ-W2', partyId: W2 }, 201)
    expect(made.location).toMatchObject({ code: 'A1-TERZ-W2', kind: 'SUBCONTRACTOR', partyId: W2 })
  })

  it('never retypes a location to or from a workshop location', async () => {
    const tree = await ok('buyer', 'GET', `/inventory/locations?siteId=${A.siteA1}`)
    const place = tree.sites[0].locations.find((row: Json) => row.code === 'A1-TERZ-P2')
    expect(place.partyId).toBe(A.P2)
    expect((await refused('buyer', 'PATCH', `/inventory/locations/${place.id}`, { version: place.version, kind: 'BIN' }, 400)).issues[0].path).toBe('body/kind')
    const store = tree.sites[0].locations.find((row: Json) => row.code === 'A1-STORE-01')
    expect((await refused('buyer', 'PATCH', `/inventory/locations/${store.id}`, { version: store.version, kind: 'SUBCONTRACTOR' }, 400)).issues[0].path).toBe('body/kind')
  })
})

let order: Json

describe('a subcontract order from an outside operation (SCM-138)', () => {
  it("shows what the work order may send out: the routing step's workshop, fee and transit days, the pieces already ordered", async () => {
    const outside = await ok('buyer', 'GET', `/purchasing/subcontracting/work-orders/${seed.production.workOrderId}/outside-operations`)
    const sew = outside.operations.find((row: Json) => row.id === seed.production.operationIds.sew)
    expect(sew).toMatchObject({ outside: { workshop: { id: A.P2 }, pricePerPiece: '5.250000', transitDays: 7 }, ordered: 7 })
    expect(outside.workshops).toEqual([expect.objectContaining({ id: A.P2, locations: [expect.objectContaining({ id: seed.locationId })] })])
    expect(outside.cells.reduce((sum: number, cell: Json) => sum + cell.quantity, 0)).toBe(7)
    const planner = await ok('planner', 'GET', `/purchasing/subcontracting/work-orders/${seed.production.workOrderId}/outside-operations`)
    expect(planner.operations.find((row: Json) => row.id === seed.production.operationIds.sew).outside).not.toHaveProperty('pricePerPiece')
  })

  it('refuses more pieces of an operation than the work order makes across live orders', async () => {
    const error = await refused('buyer', 'POST', '/purchasing/subcontracting/orders', { workOrderId: seed.production.workOrderId, operations: [{ workOrderOperationId: seed.production.operationIds.sew }] }, 400)
    expect(error.issues[0]).toMatchObject({ path: 'body/operations/0/pieces', message: expect.stringContaining('7 piece(s) of operation') })
  })

  it("cancels the seed's draft with a reason, then makes the order with the routing step's defaults and the kit planned", async () => {
    const seedOrder = (await ok('buyer', 'GET', url(seed.orderId))).order
    const cancelled = await ok('buyer', 'POST', url(seed.orderId, '/cancel'), { version: seedOrder.version, reason: 'Made again from the routing' })
    expect(cancelled.order).toMatchObject({ status: 'CANCELLED', cancelReason: 'Made again from the routing', kit: { state: 'NONE', cancelled: 1 } })

    const body = { workOrderId: seed.production.workOrderId, operations: [{ workOrderOperationId: seed.production.operationIds.sew }], planKit: true, note: 'Sew the jackets.' }
    const idempotencyKey = key()
    const first = await call('buyer', 'POST', '/purchasing/subcontracting/orders', body, idempotencyKey)
    expect(first.statusCode, first.body).toBe(201)
    order = first.json().order
    expect(order).toMatchObject({
      status: 'DRAFT',
      number: `SC-${YEAR}-0001`,
      workshop: { id: A.P2 },
      location: { id: seed.locationId, code: 'A1-TERZ-P2' },
      currency: 'EUR',
      netAmount: 3675,
      pieces: { ordered: 7, sent: 0 },
      kit: { state: 'TO_SEND' },
      actions: { issue: null },
    })
    expect(order.operations).toEqual([expect.objectContaining({ seq: 10, pieces: 7, pricePerPiece: '5.250000', netAmount: 3675, workOrderOperation: expect.objectContaining({ id: seed.production.operationIds.sew }) })])
    expect(order.operations[0].sizes).toHaveLength(6)
    expect(order.expectedBackDate! >= TODAY).toBe(true)
    const lining = order.kitLines.find((line: Json) => line.item.id === A.lining)
    expect(lining).toMatchObject({ status: 'PLANNED', uom: 'M', colour: { id: A.liningGrey } })
    expect(order.kitLines.every((line: Json) => line.item.tracking !== 'HIDE')).toBe(true)
    // The same Idempotency-Key answers the same order.
    const again = await call('buyer', 'POST', '/purchasing/subcontracting/orders', body, idempotencyKey)
    expect(again.json().order.id).toBe(order.id)
  })

  it('shows no fee or amount to a role without the cost grain, and refuses the act to a role without the permission', async () => {
    const seen = (await ok('planner', 'GET', url(order.id))).order
    expect(seen).not.toHaveProperty('netAmount')
    expect(seen.operations[0]).not.toHaveProperty('pricePerPiece')
    await refused('planner', 'POST', url(order.id, '/issue'), { version: order.version }, 403)
    await refused('otherWorkshop', 'GET', url(order.id), undefined, 404)
    await refused('otherTenant', 'GET', url(order.id), undefined, 404)
    await refused('floor', 'GET', url(order.id), undefined, 403)
  })

  it('changes pieces per size on the draft (the sizes add up), keeping the amount the sum of its operations', async () => {
    const operation = order.operations[0]
    expect((await refused('buyer', 'PATCH', url(order.id, `/operations/${operation.id}`), { version: order.version, pieces: 5 }, 400)).issues[0].path).toBe('body/sizes')
    const sizes = operation.sizes.map((size: Json) => ({ workOrderSizeId: size.workOrderSizeId, pieces: size.pieces }))
    // One piece less in the first cell with more than one: six pieces in all.
    const cell = sizes.findIndex((size: Json) => size.pieces > 1)
    sizes[cell].pieces -= 1
    const six = sizes.filter((size: Json) => size.pieces > 0)
    order = (await ok('buyer', 'PATCH', url(order.id, `/operations/${operation.id}`), { version: order.version, pieces: 6, sizes: six })).order
    expect(order.operations[0]).toMatchObject({ pieces: 6, netAmount: 3150 })
    expect(order.netAmount).toBe(3150)
  })

  it('says why it cannot be issued (in words), then issues it', async () => {
    order = (await ok('buyer', 'PATCH', url(order.id, `/operations/${order.operations[0].id}`), { version: order.version, pricePerPiece: '0' })).order
    expect(order.actions.issue).toContain('no fee per piece')
    expect((await refused('buyer', 'POST', url(order.id, '/issue'), { version: order.version }, 409)).message).toContain('Line 10 (')
    order = (await ok('buyer', 'PATCH', url(order.id, `/operations/${order.operations[0].id}`), { version: order.version, pricePerPiece: '5.25' })).order
    order = (await ok('buyer', 'POST', url(order.id, '/issue'), { version: order.version })).order
    expect(order).toMatchObject({ status: 'ISSUED', netAmount: 3150, issuedAt: expect.any(String), actions: { issue: expect.any(String), send: null } })
    expect((await refused('buyer', 'PATCH', url(order.id, `/operations/${order.operations[0].id}`), { version: order.version, pieces: 1 }, 409)).message).toContain('only while it is a draft')
  })
})

let ddtId = ''

describe('the kit out with its DDT for work on our behalf (SCM-140), stock at the workshop (SCM-141)', () => {
  it("refuses the DDT to a role that may send the kit but not issue DDTs", async () => {
    const lining = order.kitLines.find((line: Json) => line.item.id === A.lining)
    const error = await refused('kitNoDdt', 'POST', url(order.id, '/kit/send'), { version: order.version, lines: [{ lineId: lining.id, fromLocationId: bin, lotId: liningLot }], ddt: TYPED_DDT }, 403)
    expect(error.message).toContain('shipping.ddt.issue')
  })

  it('moves the lining into the workshop’s place, counts the pieces out, issues the DDT with the bundles, AT_WORKSHOP', async () => {
    // Keep only the lining on the kit (the plan may hold other materials not in stock here).
    for (const line of order.kitLines.filter((row: Json) => row.item.id !== A.lining)) order = (await ok('buyer', 'DELETE', url(order.id, `/kit/${line.id}?version=${order.version}`))).order
    const lining = order.kitLines.find((line: Json) => line.item.id === A.lining)
    const answer = await ok(
      'warehouse',
      'POST',
      url(order.id, '/kit/send'),
      { version: order.version, lines: [{ lineId: lining.id, fromLocationId: bin, lotId: liningLot }], pieces: [{ operationId: order.operations[0].id, pieces: 6 }], bundles: bundles.map((bundle) => ({ bundleId: bundle.id })), ddt: TYPED_DDT },
      201,
    )
    order = answer.order
    expect(order).toMatchObject({ status: 'AT_WORKSHOP', pieces: { sent: 6, atWorkshop: 6 }, kit: { state: 'SENT' } })
    expect(order).not.toHaveProperty('netAmount')
    const sent = order.kitLines.find((line: Json) => line.id === lining.id)
    expect(sent).toMatchObject({ status: 'SENT', lot: { id: liningLot }, moveId: answer.moveIds[0], ddt: { id: answer.ddt.id, cancelled: false } })
    expect(answer.ddt).toMatchObject({ number: expect.stringMatching(new RegExp(`/${YEAR}$`)), pdfProblem: null, file: expect.objectContaining({ id: expect.any(String) }) })
    ddtId = answer.ddt.id
    const [move] = await admin('SELECT reason, "toLocationId", "lotId", "baseQuantity"::text AS base FROM "StockMove" WHERE id = $1', [answer.moveIds[0]])
    expect(move).toMatchObject({ reason: 'TRANSFER', toLocationId: seed.locationId, lotId: liningLot })
    const [ddt] = await admin<{ reason: string; lines: Json[]; sourceType: string }>('SELECT reason, lines, "sourceType" FROM "Ddt" WHERE id = $1', [ddtId])
    expect(ddt!.reason).toBe('WORK_ON_ACCOUNT')
    expect(ddt!.sourceType).toBe('SubcontractOrder')
    expect(ddt!.lines.map((line) => line.sourceLineId)).toEqual([lining.id, ...bundles.map(() => null)])
    expect(ddt!.lines.slice(1).map((line) => line.code)).toEqual(bundles.map((bundle) => bundle.code))
    expect(order.ddts).toEqual([expect.objectContaining({ id: ddtId, cancelled: false, kitLineIds: [lining.id] })])
  })

  it("shows our stock at the workshop (still ours: its value only with the cost grain)", async () => {
    const buyer = await ok('buyer', 'GET', `/purchasing/subcontracting/stock?partyId=${A.P2}`)
    const sent = order.kitLines.find((line: Json) => line.item.id === A.lining)
    expect(buyer.rows).toEqual([expect.objectContaining({ workshop: expect.objectContaining({ id: A.P2 }), location: expect.objectContaining({ id: seed.locationId }), lot: expect.objectContaining({ id: liningLot }), onHand: sent.baseQuantity, value: expect.any(Number) })])
    expect(buyer.workshops).toEqual([expect.objectContaining({ lines: 1, value: buyer.rows[0].value })])
    const warehouse = await ok('warehouse', 'GET', '/purchasing/subcontracting/stock')
    expect(warehouse.rows[0]).not.toHaveProperty('value')
    expect(warehouse.rows[0]).not.toHaveProperty('unitCost')
  })

  it('takes back a kit line that never left only once its DDT is cancelled, and refuses cancelling an order that is out', async () => {
    const extra = (await ok('buyer', 'POST', url(order.id, '/kit'), { version: order.version, lines: [{ itemId: A.lining, itemColourId: A.liningGrey, lotId: liningLot, quantity: '1.5' }] }, 201)).order
    const line = extra.kitLines.find((row: Json) => row.status === 'PLANNED')
    const lonely = (await ok('warehouse', 'POST', url(order.id, '/kit/send'), { version: extra.version, lines: [{ lineId: line.id, fromLocationId: bin }], ddt: null }, 201)).order
    const back = (await ok('warehouse', 'POST', url(order.id, `/kit/${line.id}/return`), { version: lonely.version, reason: 'Wrong roll picked' })).order
    expect(back.kitLines.find((row: Json) => row.id === line.id)).toMatchObject({ status: 'PLANNED', moveId: null, ddt: null })
    expect(back.status).toBe('AT_WORKSHOP')
    const lining = back.kitLines.find((row: Json) => row.ddt?.id === ddtId)
    expect((await refused('warehouse', 'POST', url(order.id, `/kit/${lining.id}/return`), { version: back.version, reason: 'never left' }, 409)).message).toContain('Cancel the DDT first')
    expect((await refused('buyer', 'POST', url(order.id, '/cancel'), { version: back.version, reason: 'no' }, 409)).message).toContain('at the workshop')
    order = (await ok('buyer', 'DELETE', url(order.id, `/kit/${line.id}?version=${back.version}`))).order
  })
})

describe('goods back by bundle (SCM-142), the fee on the cost ledger', () => {
  it('takes pieces back per operation and bundle, and unused lining back into our bin: PARTLY_RECEIVED, the fee posted', async () => {
    const [b1] = bundles
    const answer = await ok(
      'warehouse',
      'POST',
      url(order.id, '/receive'),
      {
        version: order.version,
        lines: [
          { operationId: order.operations[0].id, bundleId: b1!.id, good: b1!.quantity, defective: 0, scrapped: 0 },
          { operationId: order.operations[0].id, good: 1, defective: 1, scrapped: 0, reason: 'Seam open on one jacket' },
        ],
        returns: [{ itemId: A.lining, lotId: liningLot, quantity: '2', toLocationId: bin }],
        supplierDdt: { number: 'W-77', date: TODAY },
      },
      201,
    )
    order = answer.order
    const back = b1!.quantity + 2
    expect(order).toMatchObject({ status: 'PARTLY_RECEIVED', pieces: { sent: 6, backGood: b1!.quantity + 1, backDefective: 1, atWorkshop: 6 - back } })
    expect(answer.receipt).toMatchObject({ supplierDdt: { number: 'W-77' }, lines: [expect.objectContaining({ bundle: expect.objectContaining({ id: b1!.id, code: b1!.code }), good: b1!.quantity }), expect.objectContaining({ bundle: null, defective: 1, reason: 'Seam open on one jacket' })], returns: [expect.objectContaining({ quantity: '2', toLocation: expect.objectContaining({ id: bin }) })] })
    expect(answer.ledger).toEqual({ posted: 1, waiting: [] })
    const [entry] = await admin<{ amount: number; key: string }>(`SELECT amount, "idempotencyKey" AS key FROM "WorkOrderCostEntry" WHERE "subcontractOrderId" = $1 AND kind = 'SUBCONTRACT'`, [order.id])
    expect(entry).toEqual({ amount: (b1!.quantity + 1) * 525, key: `subcontract:${order.operations[0].id}:1` })
    const stock = await ok('buyer', 'GET', `/purchasing/subcontracting/stock?locationId=${seed.locationId}`)
    const sent = order.kitLines.find((line: Json) => line.item.id === A.lining && line.status === 'SENT')
    expect(stock.rows[0].onHand).toBe((Number(sent.baseQuantity) - 2).toFixed(4))
    // The record reads it back from its audit row.
    const record = (await ok('warehouse', 'GET', url(order.id))).order
    expect(record.receipts).toHaveLength(1)
    expect(record.receipts[0].lines[0].bundle.code).toBe(b1!.code)
  })

  it('refuses more than is at the workshop, and a bundle back more than it holds', async () => {
    const [b1] = bundles
    expect((await refused('warehouse', 'POST', url(order.id, '/receive'), { version: order.version, lines: [{ operationId: order.operations[0].id, good: 9, defective: 0, scrapped: 0 }] }, 400)).message).toContain('at the workshop')
    expect((await refused('warehouse', 'POST', url(order.id, '/receive'), { version: order.version, lines: [{ operationId: order.operations[0].id, bundleId: b1!.id, good: 1, defective: 0, scrapped: 0 }] }, 400)).message).toContain('came back already')
    expect((await refused('warehouse', 'POST', url(order.id, '/receive'), { version: order.version - 1, lines: [{ operationId: order.operations[0].id, good: 1, defective: 0, scrapped: 0 }] }, 409)).code).toBeDefined()
  })

  it('is RECEIVED once every piece is back, posts the rest of the fee, and closes', async () => {
    const rest = order.pieces.atWorkshop
    const answer = await ok('warehouse', 'POST', url(order.id, '/receive'), { version: order.version, lines: [{ operationId: order.operations[0].id, good: rest - 1, defective: 0, scrapped: 1 }] }, 201)
    order = answer.order
    expect(order).toMatchObject({ status: 'RECEIVED', pieces: { atWorkshop: 0, scrapped: 1 }, actions: { close: null } })
    const entries = await admin<{ amount: number }>(`SELECT amount FROM "WorkOrderCostEntry" WHERE "subcontractOrderId" = $1 AND kind = 'SUBCONTRACT' ORDER BY "idempotencyKey"`, [order.id])
    expect(entries.reduce((sum, row) => sum + row.amount, 0)).toBe(order.pieces.backGood * 525)
    order = (await ok('buyer', 'POST', url(order.id, '/close'), { version: order.version })).order
    expect(order.status).toBe('CLOSED')
    expect(await eventsOf(order.id)).toEqual(
      expect.arrayContaining(['subcontract_order.created', 'subcontract_order.updated', 'subcontract_order.issued', 'subcontract_order.kit_sent', 'ddt.source_issued', 'subcontract_order.kit_returned', 'subcontract_order.received', 'subcontract_order.closed']),
    )
  })

  it('lists the orders with their tiles', async () => {
    const list = await ok('buyer', 'GET', '/purchasing/subcontracting/orders?open=false')
    expect(list.items.map((row: Json) => row.number)).toEqual(expect.arrayContaining([order.number, 'SEED-SC-0001']))
    expect(list.items.find((row: Json) => row.id === order.id)).toMatchObject({ status: 'CLOSED', services: [expect.objectContaining({ code: expect.any(String) })], kit: { state: 'SENT' } })
    const open = await ok('buyer', 'GET', '/purchasing/subcontracting/orders')
    expect(open.items.map((row: Json) => row.id)).not.toContain(order.id)
    const counts = await ok('buyer', 'GET', '/purchasing/subcontracting/orders/counts')
    expect(counts).toEqual({ kitToSend: 0, atWorkshops: 0, dueBackThisWeek: 0, late: 0 })
  })
})
