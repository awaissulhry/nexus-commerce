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
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'

/**
 * Goods back from a workshop as records, and the outside operation reported at receive back (B-W2b-10; the follow-up of
 * B-W2a-25 and B-W2a-76, on B-W2b-01's tables) on the local stack with the app's real routes: a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: grants, row-level security and the subcontract and scan triggers are
 * real), the factory-db seeds (WO-0001 IN_PROGRESS, the workshop P2 with its place A1-TERZ-P2), its sewing step done by
 * P2, and three made-up whole-garment bundles of the work order. The office issues the order, sends the bundles, and
 * takes them back in three receipts. Every name, number and fee is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/purchasing/subcontracting/receive-back`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seed: SubcontractSeed
let redis: TestRedis
let connection: Redis
let localRoot: string

const ns = { a: 'receive-back-a', b: 'receive-back-b' } as const
const idOf = (key: string) => seedUuid(ns.a, key)
const A = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1'), P2: idOf('party:P2') }
const YEAR = businessDate(new Date()).slice(0, 4)
const buyerId = newId()

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const OFFICE: Permission[] = ['purchasing.view', 'purchasing.subcontract.manage', 'purchasing.subcontract.kit', 'purchasing.subcontract.receive', 'workorders.view', 'costing.view', 'costing.ledger.manage']
const SESSIONS: Record<string, SessionContext> = {
  buyer: { audience: 'office', tenantId: A.tenant, actorId: buyerId, grants: [grant(OFFICE)] },
  /** May read orders but not receive goods back. */
  viewer: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['purchasing.view', 'workorders.view'])] },
  /** Receives goods back for company B only. */
  companyB: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(OFFICE, [A.companyB])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `receive-back-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const office = (id: string, rest = '') => `/purchasing/subcontracting/orders/${id}${rest}`

let order: Json
let operation: Json
let bundles: { id: string; code: string; quantity: number }[] = []
const wip = async () => ok('buyer', 'GET', `/production/scans/work-orders/${seed.production.workOrderId}/wip`)
const opOf = (view: Json, id: string) => (view.operations as Json[]).find((row) => row.operationId === id)!
const nextOp = async () => (await admin<{ id: string }>(`SELECT id FROM "WorkOrderOperation" WHERE "workOrderId" = $1 AND seq > (SELECT seq FROM "WorkOrderOperation" WHERE id = $2) AND "scanRequired" ORDER BY seq LIMIT 1`, [seed.production.workOrderId, seed.production.operationIds.sew]))[0]!.id
const receive = (lines: Json[], extra: Json = {}) => call('buyer', 'POST', office(order.id, '/receive'), { version: order.version, lines, ...extra })

beforeAll(async () => {
  db = await migratedDatabase('receive_back')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: database, namespace })
  seed = await seedSubcontract({ db: database, namespace: ns.a })
  await seedNumbering({ db: database, namespace: ns.a })
  // The released revision's sewing step done by the workshop P2 (a released routing is frozen: its guard is off for this).
  await admin(`ALTER TABLE "RoutingOperation" DISABLE TRIGGER "RoutingOperation_revision_guard"`)
  await admin(
    `UPDATE "RoutingOperation" r SET "supplierId" = $1, "pricePerPiece" = 5.25, "transitDays" = 7
       FROM "WorkOrderOperation" o WHERE o.id = $2 AND r."revisionId" = o."styleRevisionId" AND r.seq = o."routingSeq"`,
    [A.P2, seed.production.operationIds.sew],
  )
  await admin(`ALTER TABLE "RoutingOperation" ENABLE TRIGGER "RoutingOperation_revision_guard"`)
  // Three made-up whole-garment bundles (the seed's bundles carry sleeves only): 2, 1 and 1 garments.
  const cells = await admin<{ id: string }>(`SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1 ORDER BY id LIMIT 3`, [seed.production.workOrderId])
  for (const [index, quantity] of [2, 1, 1].entries()) {
    await admin(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [newId(), A.tenant, A.siteA1, seed.production.workOrderId, cells[index % cells.length]!.id, `T-RB-${run}-${index + 1}`, quantity])
  }
  bundles = await admin(`SELECT id, code, quantity FROM "Bundle" WHERE "workOrderId" = $1 AND part IS NULL ORDER BY code`, [seed.production.workOrderId])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SUBCONTRACT', 'MAIN', $4, 'YEARLY', 'SC-{YYYY}-{N:4}', false) ON CONFLICT DO NOTHING`, [newId(), A.tenant, A.companyA, YEAR])
  await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1 AND kind = 'SUBCONTRACT'`, [A.tenant])
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, 'Made-up buyer', 'ACTIVE')`, [buyerId, A.tenant, `${buyerId}@example.test`])
  // The tenant's FAKE file store (the kit send's DDT seam reads the files runtime, even with no DDT now).
  if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])).length === 0) {
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), A.tenant])
  }
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-receive-back-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  // The office's order for the sewing step, without a kit, issued; the seed's draft cancelled.
  const seedOrder = (await ok('buyer', 'GET', office(seed.orderId))).order
  await ok('buyer', 'POST', office(seed.orderId, '/cancel'), { version: seedOrder.version, reason: 'Made again for the receive-back test' })
  order = (await ok('buyer', 'POST', '/purchasing/subcontracting/orders', { workOrderId: seed.production.workOrderId, operations: [{ workOrderOperationId: seed.production.operationIds.sew }] }, 201)).order
  order = (await ok('buyer', 'POST', office(order.id, '/issue'), { version: order.version })).order
  operation = order.operations[0]
}, 240_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('the bundles that go out are records (SubcontractBundle)', () => {
  it('the kit send writes one row per bundle with its garments; a bundle sent again with the order is refused in words', async () => {
    const sent = await ok('buyer', 'POST', office(order.id, '/kit/send'), { version: order.version, bundles: bundles.map((bundle) => ({ bundleId: bundle.id })), ddt: null }, 201)
    order = sent.order
    expect(order.status).toBe('AT_WORKSHOP')
    const rows = await admin(`SELECT "bundleId", quantity, "createdById" FROM "SubcontractBundle" WHERE "subcontractOrderId" = $1 ORDER BY quantity DESC, "bundleId"`, [order.id])
    expect(rows).toHaveLength(3)
    expect(rows).toEqual(expect.arrayContaining(bundles.map((bundle) => ({ bundleId: bundle.id, quantity: bundle.quantity, createdById: buyerId }))))
    const again = await call('buyer', 'POST', office(order.id, '/kit/send'), { version: order.version, bundles: [{ bundleId: bundles[1]!.id }], ddt: null })
    expect(again.statusCode, again.body).toBe(400)
    expect(again.json().error).toMatchObject({ message: `Bundle ${bundles[1]!.code} went out with this order already.`, issues: [{ path: 'body/bundles/0/bundleId' }] })
  })
})

describe('receive back: the receipt as records and the outside operation reported (the scan names the receipt line)', () => {
  let firstScan: Json

  it('writes the receipt with its lines and reports each bundle at the outside operation: no worker, station or device', async () => {
    const [big, small] = bundles
    const response = await receive(
      [
        { operationId: operation.id, bundleId: big!.id, good: 1, defective: 0, scrapped: 0 },
        { operationId: operation.id, bundleId: small!.id, good: 0, defective: 1, scrapped: 0, reason: 'CLEANING' },
      ],
      { supplierDdt: { number: 'W-101', date: businessDate(new Date()) }, note: 'First parcel' },
    )
    expect(response.statusCode, response.body).toBe(201)
    const answer = response.json()
    order = answer.order
    expect(answer.outside).toEqual([
      expect.objectContaining({ bundleId: big!.id, bundleCode: big!.code, kind: 'REPORT', goodQuantity: 1, scrapQuantity: 0, reworkQuantity: 0, words: null, operation: expect.objectContaining({ id: seed.production.operationIds.sew }) }),
      expect.objectContaining({ bundleId: small!.id, kind: 'REPORT', goodQuantity: 0, reworkQuantity: 1, words: null }),
    ])
    const [receipt] = await admin(`SELECT id, seq, "workshopDdtNumber", note, "deviceId", "createdById", cardinality("returnMoveIds") AS moves FROM "SubcontractReceipt" WHERE "subcontractOrderId" = $1`, [order.id])
    expect(receipt).toMatchObject({ id: answer.receipt.id, seq: 1, workshopDdtNumber: 'W-101', note: 'First parcel', deviceId: null, createdById: buyerId, moves: 0 })
    const lines = await admin(`SELECT id, seq, "bundleId", "goodQuantity" AS good, "defectiveQuantity" AS defective, "reasonCode", "reasonNote" FROM "SubcontractReceiptLine" WHERE "receiptId" = $1 ORDER BY seq`, [receipt!.id])
    expect(lines).toEqual([
      expect.objectContaining({ seq: 10, bundleId: big!.id, good: 1, defective: 0, reasonCode: null, reasonNote: null }),
      expect.objectContaining({ seq: 20, bundleId: small!.id, good: 0, defective: 1, reasonCode: 'CLEANING', reasonNote: null }),
    ])
    const scans = await admin(
      `SELECT id, kind::text, "subcontractReceiptLineId" AS line, "workerId", "stationId", "deviceId", "createdById", "clientScanId", "goodQuantity" AS good, "reworkQuantity" AS rework FROM "OperationScan" WHERE id = ANY($1::uuid[]) ORDER BY "goodQuantity" DESC`,
      [answer.outside.map((entry: Json) => entry.scanId)],
    )
    expect(scans).toEqual([
      expect.objectContaining({ kind: 'REPORT', line: lines[0]!.id, workerId: null, stationId: null, deviceId: null, createdById: buyerId, clientScanId: `receipt-line:${lines[0]!.id}`, good: 1, rework: 0 }),
      expect.objectContaining({ kind: 'REPORT', line: lines[1]!.id, workerId: null, stationId: null, deviceId: null, good: 0, rework: 1 }),
    ])
    firstScan = scans[0]!
    // The rework garment keeps its reason as the scan's line (an active code of the REWORK list).
    expect(await admin(`SELECT kind::text, "reasonCode", quantity FROM "OperationScanDefect" WHERE "scanId" = $1`, [scans[1]!.id])).toEqual([{ kind: 'REWORK', reasonCode: 'CLEANING', quantity: 1 }])
    expect(await admin(`SELECT payload->>'postedBy' AS by FROM "OutboxEvent" WHERE type = 'production.scan_recorded' AND payload->>'scanId' = $1`, [firstScan.id])).toEqual([{ by: 'OFFICE' }])
    // The next operation takes what the workshop passed (the good garment), and WIP counts the outside operation.
    const view = await wip()
    expect(opOf(view, seed.production.operationIds.sew)).toMatchObject({ good: 1, rework: 1 })
    expect(opOf(view, await nextOp())).toMatchObject({ arrived: 1 })
    // The record reads the receipt from its tables.
    const record = (await ok('buyer', 'GET', office(order.id))).order
    expect(record.receipts).toEqual([expect.objectContaining({ id: receipt!.id, supplierDdt: { number: 'W-101', date: businessDate(new Date()) }, lines: [expect.objectContaining({ bundle: expect.objectContaining({ id: big!.id }), good: 1 }), expect.objectContaining({ defective: 1, reason: 'CLEANING' })] })])
  })

  it('a later receipt of the same bundle adds to the report the earlier one made (a correction by the office person who receives)', async () => {
    const [big] = bundles
    const response = await receive([{ operationId: operation.id, bundleId: big!.id, good: 0, defective: 0, scrapped: 1, reason: 'Burnt by the press' }])
    expect(response.statusCode, response.body).toBe(201)
    const answer = response.json()
    order = answer.order
    expect(answer.outside).toEqual([expect.objectContaining({ bundleId: big!.id, kind: 'CORRECTION', goodQuantity: 1, scrapQuantity: 1, reworkQuantity: 0, words: null })])
    const [correction] = await admin(`SELECT "correctsId", "approvedById", reason, "subcontractReceiptLineId" AS line FROM "OperationScan" WHERE id = $1`, [answer.outside[0].scanId])
    expect(correction).toEqual({ correctsId: firstScan.id, approvedById: buyerId, reason: `Receipt 2 of subcontract order ${order.number}: 1 more garment(s) back from the workshop.`, line: null })
    // A free reason is kept as the line's words.
    expect(await admin(`SELECT "reasonCode", "reasonNote" FROM "SubcontractReceiptLine" WHERE "receiptId" = $1`, [answer.receipt.id])).toEqual([{ reasonCode: null, reasonNote: 'Burnt by the press' }])
    expect(opOf(await wip(), seed.production.operationIds.sew)).toMatchObject({ good: 1, scrap: 1, rework: 1 })
  })

  it('a bundle received while its work order is on hold is not reported, in words; the office reports it from the line later, once', async () => {
    const third = bundles[2]!
    await admin(`UPDATE "WorkOrder" SET status = 'ON_HOLD', "heldFromStatus" = status, "heldAt" = now(), "holdReason" = 'Made-up seam check' WHERE id = $1`, [seed.production.workOrderId])
    const response = await receive([{ operationId: operation.id, bundleId: third.id, good: 1, defective: 0, scrapped: 0 }])
    expect(response.statusCode, response.body).toBe(201)
    const answer = response.json()
    order = answer.order
    expect(answer.outside).toEqual([expect.objectContaining({ bundleId: third.id, scanId: null, kind: null, words: expect.stringContaining('is ON_HOLD: bundle') })])
    expect(answer.outside[0].words).toContain('Report at the operation')
    const [line] = await admin<{ id: string }>(`SELECT id FROM "SubcontractReceiptLine" WHERE "receiptId" = $1`, [answer.receipt.id])
    // Still on hold: refused in words. Another company's person and one without the receive permission find no line.
    const held = await call('buyer', 'POST', `/production/scans/receipt-lines/${line!.id}/report`)
    expect(held.statusCode, held.body).toBe(409)
    expect(held.json().error.message).toContain('is ON_HOLD')
    expect((await call('companyB', 'POST', `/production/scans/receipt-lines/${line!.id}/report`)).statusCode).toBe(404)
    expect((await call('viewer', 'POST', `/production/scans/receipt-lines/${line!.id}/report`)).statusCode).toBe(403)
    await admin(`UPDATE "WorkOrder" SET status = "heldFromStatus", "heldFromStatus" = NULL, "heldAt" = NULL, "holdReason" = NULL WHERE id = $1`, [seed.production.workOrderId])
    const reported = await ok('buyer', 'POST', `/production/scans/receipt-lines/${line!.id}/report`, undefined, 201)
    expect(reported.report).toMatchObject({ receiptLineId: line!.id, bundleId: third.id, kind: 'REPORT', goodQuantity: 1, words: null })
    expect(await admin(`SELECT "subcontractReceiptLineId" AS line, "workerId", "stationId", "deviceId" FROM "OperationScan" WHERE id = $1`, [reported.report.scanId])).toEqual([{ line: line!.id, workerId: null, stationId: null, deviceId: null }])
    const twice = await call('buyer', 'POST', `/production/scans/receipt-lines/${line!.id}/report`)
    expect(twice.statusCode, twice.body).toBe(409)
    expect(twice.json().error.message).toBe('This receipt line is reported at its operation already.')
  })

  it('the outside operation posts no labour to the work order (the workshop’s fee is its SUBCONTRACT entry)', async () => {
    const posted = await ok('buyer', 'POST', `/costing/work-orders/${seed.production.workOrderId}/post`, {}, 201)
    const outside = await admin<{ id: string }>(`SELECT id FROM "OperationScan" WHERE "workOrderId" = $1 AND "clientScanId" LIKE 'receipt-line:%'`, [seed.production.workOrderId])
    expect(outside.length).toBe(4)
    // Not even waiting for a labour rate (the seed's own floor scans wait for one).
    expect((posted.waiting as Json[]).filter((entry) => outside.some((row) => row.id === entry.sourceId))).toEqual([])
    expect(await admin(`SELECT 1 FROM "WorkOrderCostEntry" WHERE kind = 'LABOUR' AND "operationScanId" = ANY($1::uuid[])`, [outside.map((row) => row.id)])).toEqual([])
    expect((await admin(`SELECT count(*)::int AS n FROM "WorkOrderCostEntry" WHERE kind = 'SUBCONTRACT' AND "subcontractOrderId" = $1`, [order.id]))[0]!.n).toBeGreaterThan(0)
  })
})
