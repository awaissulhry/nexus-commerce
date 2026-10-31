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
 * Subcontract kits on the floor (B-W2a-76; SCM-140, SCM-142; design floor.kits SCR-181) on the local stack with the app's
 * real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: the floor's grants are real, so
 * the floor reads no subcontract order itself), the factory-db seeds (WO-0001 IN_PROGRESS, the workshop P2 with its place
 * A1-TERZ-P2, SEED-SC-0001, 120 m of grey lining lot SEED-LOT-LIN-01 in bin A1-STORE-01), two made-up whole-garment
 * bundles of the sewing cells, the local file store for the DDT's PDF, and floor sessions from the test authenticator.
 * The office prepares and issues the order (B-W2a-25's routes); the tablet sends the kit and takes it back. Every name,
 * number and fee is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/purchasing/subcontracting/floor`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let files: FilesRuntime
let seed: SubcontractSeed

const ns = { a: 'subcontract-floor-a', b: 'subcontract-floor-b' } as const
const idOf = (key: string) => seedUuid(ns.a, key)
const A = {
  tenant: idOf('tenant'),
  companyA: idOf('company:A'),
  companyB: idOf('company:B'),
  siteA1: idOf('site:A1'),
  siteB1: idOf('site:B1'),
  P2: idOf('party:P2'),
  lining: idOf('product:item:lining'),
}
const YEAR = businessDate(new Date()).slice(0, 4)

const officeGrant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const tablet = (siteId: string, companyId: string, permissions: Permission[], tenantId: string = A.tenant): SessionContext => ({
  audience: 'floor',
  tenantId,
  actorId: newId(),
  siteId,
  deviceId: newId(),
  grants: [{ permissions, companies: [companyId], sites: [siteId], parties: 'all' }],
})
const KITS: Permission[] = ['floor.work', 'purchasing.subcontract.kit', 'purchasing.subcontract.receive', 'inventory.locations.view']
const SESSIONS: Record<string, SessionContext> = {
  buyer: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [officeGrant(['purchasing.view', 'purchasing.subcontract.manage', 'money.cost'])] },
  /** The warehouse tablet at A1 with the operator's template. */
  floor: tablet(A.siteA1, A.companyA, KITS),
  /** A tablet whose person may receive goods back but not send kits. */
  receiver: tablet(A.siteA1, A.companyA, ['floor.work', 'purchasing.subcontract.receive']),
  /** A tablet whose person may do neither. */
  picker: tablet(A.siteA1, A.companyA, ['floor.work', 'inventory.issue']),
  /** A tablet of another site. */
  floorB1: tablet(A.siteB1, A.companyB, KITS),
  otherTenant: tablet(seedUuid(ns.b, 'site:A1'), seedUuid(ns.b, 'company:A'), KITS, seedUuid(ns.b, 'tenant')),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `kits-floor-${run}-${++keys}`
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
const office = (id: string, rest = '') => `/purchasing/subcontracting/orders/${id}${rest}`
const kits = (id: string, rest = '') => `/purchasing/subcontracting/kits/${id}${rest}`
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : []
const moneyKeys = (value: unknown) => keysOf(value).filter((name) => /price|amount|cost|value|fee/i.test(name))
const DDT = { transportBy: 'SENDER', packages: 1, grossWeightKg: '4.2', appearance: 'Scatole di cartone' } as const

let bin = ''
let liningLot = ''
let whole: { id: string; code: string; quantity: number }[] = []
let order: Json

beforeAll(async () => {
  db = await migratedDatabase('kits_floor')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: database, namespace })
  seed = await seedSubcontract({ db: database, namespace: ns.a })
  await seedNumbering({ db: database, namespace: ns.a })
  bin = (await admin<{ id: string }>(`SELECT id FROM "Location" WHERE "tenantId" = $1 AND code = 'A1-STORE-01'`, [A.tenant]))[0]!.id
  liningLot = (await admin<{ id: string }>(`SELECT id FROM "Lot" WHERE "tenantId" = $1 AND code = 'SEED-LOT-LIN-01'`, [A.tenant]))[0]!.id
  // The released revision's sewing step done by the workshop P2 (a released routing is frozen: its guard is off for this).
  await admin(`ALTER TABLE "RoutingOperation" DISABLE TRIGGER "RoutingOperation_revision_guard"`)
  await admin(
    `UPDATE "RoutingOperation" r SET "supplierId" = $1, "pricePerPiece" = 5.25, "transitDays" = 7
       FROM "WorkOrderOperation" o WHERE o.id = $2 AND r."revisionId" = o."styleRevisionId" AND r.seq = o."routingSeq"`,
    [A.P2, seed.production.operationIds.sew],
  )
  await admin(`ALTER TABLE "RoutingOperation" ENABLE TRIGGER "RoutingOperation_revision_guard"`)
  // Two made-up whole-garment bundles of the work order's first two cells (the seed's bundles carry sleeves only).
  const cells = await admin<{ id: string }>(`SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1 ORDER BY id LIMIT 2`, [seed.production.workOrderId])
  for (const [index, cell] of cells.entries()) {
    await admin(`INSERT INTO "Bundle" (id, "tenantId", "siteId", "workOrderId", "workOrderSizeId", code, quantity) VALUES ($1, $2, $3, $4, $5, $6, 1)`, [newId(), A.tenant, A.siteA1, seed.production.workOrderId, cell!.id, `T-BN-${run}-${index + 1}`])
  }
  whole = await admin(`SELECT id, code, quantity FROM "Bundle" WHERE "workOrderId" = $1 AND part IS NULL ORDER BY code`, [seed.production.workOrderId])
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
  localRoot = mkdtempSync(join(tmpdir(), 'factory-kits-floor-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  files = createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) })
  useFiles(files)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )

  // The office prepares the order: the seed's draft cancelled, a new one with the lining only on its kit, issued.
  const seedOrder = (await ok('buyer', 'GET', office(seed.orderId))).order
  await ok('buyer', 'POST', office(seed.orderId, '/cancel'), { version: seedOrder.version, reason: 'Made again for the floor test' })
  order = (await ok('buyer', 'POST', '/purchasing/subcontracting/orders', { workOrderId: seed.production.workOrderId, operations: [{ workOrderOperationId: seed.production.operationIds.sew }], planKit: true }, 201)).order
  for (const line of order.kitLines.filter((row: Json) => row.item.id !== A.lining)) order = (await ok('buyer', 'DELETE', office(order.id, `/kit/${line.id}?version=${order.version}`))).order
  order = (await ok('buyer', 'POST', office(order.id, '/issue'), { version: order.version })).order
}, 240_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

let kit: Json

describe('the tablet finds the order and reads its kit (no fee anywhere)', () => {
  it('lists the site’s orders to send, finds one by its number, and refuses the list to a person who may not send', async () => {
    const list = await ok('floor', 'GET', '/purchasing/subcontracting/kits?mode=send')
    expect(list.orders.map((row: Json) => row.number)).toContain(order.number)
    expect(list.orders.find((row: Json) => row.id === order.id)).toMatchObject({ status: 'ISSUED', workshop: { code: expect.any(String) }, kit: { planned: 1, sent: 0 } })
    expect(moneyKeys(list)).toEqual([])
    const found = await ok('floor', 'GET', `/purchasing/subcontracting/kits?mode=send&code=${encodeURIComponent(order.number.toLowerCase())}`)
    expect(found.found).toMatchObject({ id: order.id, status: 'ISSUED' })
    expect((await ok('floor', 'GET', '/purchasing/subcontracting/kits?mode=send&code=SEED-SC-0001')).found).toMatchObject({ status: 'CANCELLED' })
    expect((await ok('floor', 'GET', '/purchasing/subcontracting/kits?mode=send&code=NOPE')).found).toBeNull()
    await refused('receiver', 'GET', '/purchasing/subcontracting/kits?mode=send', undefined, 403)
    await refused('picker', 'GET', '/purchasing/subcontracting/kits?mode=receive', undefined, 403)
    expect((await ok('floorB1', 'GET', '/purchasing/subcontracting/kits?mode=send')).orders.map((row: Json) => row.id)).not.toContain(order.id)
  })

  it('reads the kit: the lining with where it lies, the bundles of the cells, nothing at the workshop yet', async () => {
    kit = (await ok('floor', 'GET', kits(order.id))).order
    expect(moneyKeys(kit)).toEqual([])
    const lining = kit.kitLines.find((line: Json) => line.item.id === A.lining)
    expect(lining).toMatchObject({ status: 'PLANNED', sources: [expect.objectContaining({ location: expect.objectContaining({ id: bin, code: 'A1-STORE-01' }), lot: expect.objectContaining({ id: liningLot }), covers: true })] })
    expect(kit.bundles.map((bundle: Json) => bundle.id)).toEqual(expect.arrayContaining(whole.map((bundle) => bundle.id)))
    expect(kit.bundles.every((bundle: Json) => bundle.sent === false)).toBe(true)
    expect(kit.actions).toMatchObject({ send: null, receive: expect.stringContaining('Nothing is at the workshop') })
    // Another site's tablet, another tenant's and a person with neither permission find nothing.
    await refused('floorB1', 'GET', kits(order.id), undefined, 404)
    await refused('otherTenant', 'GET', kits(order.id), undefined, 404)
    await refused('picker', 'GET', kits(order.id), undefined, 404)
    // The office's own routes stay closed to the floor.
    await refused('floor', 'GET', office(order.id), undefined, 403)
  })
})

describe('Send a kit (SCM-140): the lining and the bundles go out with the DDT for work on our behalf', () => {
  it('refuses a send to a person who may only receive, and one without its Idempotency-Key', async () => {
    const lining = kit.kitLines.find((line: Json) => line.item.id === A.lining)
    const body = { version: kit.version, lines: [{ lineId: lining.id, fromLocationId: bin, lotId: liningLot }], bundles: whole.map((bundle) => ({ bundleId: bundle.id })), ddt: DDT }
    await refused('receiver', 'POST', kits(order.id, '/send'), body, 403)
    const bare = await call('floor', 'POST', kits(order.id, '/send'), body, '')
    expect(bare.statusCode, bare.body).toBe(400)
  })

  it('moves the lining to the workshop, counts the bundles’ garments out, issues the DDT and stores its PDF for the floor', async () => {
    const lining = kit.kitLines.find((line: Json) => line.item.id === A.lining)
    const answer = await ok('floor', 'POST', kits(order.id, '/send'), { version: kit.version, lines: [{ lineId: lining.id, fromLocationId: bin, lotId: liningLot }], bundles: whole.map((bundle) => ({ bundleId: bundle.id })), ddt: DDT }, 201)
    kit = answer.order
    expect(answer.ddt).toMatchObject({ number: expect.stringMatching(new RegExp(`/${YEAR}$`)), pdf: true, pdfProblem: null })
    expect(kit).toMatchObject({ status: 'AT_WORKSHOP', operations: [expect.objectContaining({ sent: whole.length, atWorkshop: whole.length })] })
    expect(kit.kitLines.find((line: Json) => line.id === lining.id)).toMatchObject({ status: 'SENT', from: expect.objectContaining({ id: bin }), atWorkshop: lining.baseQuantity, ddtNumber: answer.ddt.number })
    expect(kit.bundles.filter((bundle: Json) => bundle.sent).map((bundle: Json) => bundle.id).sort()).toEqual(whole.map((bundle) => bundle.id).sort())
    expect(moneyKeys(answer)).toEqual([])
    const [ddt] = await admin<{ reason: string; transportBy: string }>(`SELECT reason::text AS reason, "transportBy"::text AS "transportBy" FROM "Ddt" WHERE id = $1`, [answer.ddt.id])
    expect(ddt).toEqual({ reason: 'WORK_ON_ACCOUNT', transportBy: 'SENDER' })
    // The audit row names the tablet inside the one record; the command ran as the tenant's system.
    const [audit] = await admin<{ audience: string; after: Json }>(`SELECT audience::text AS audience, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'purchasing.subcontract.sendKit'`, [order.id])
    expect(audit).toMatchObject({ audience: 'SYSTEM', after: { floor: { deviceId: (SESSIONS.floor as { deviceId: string }).deviceId } } })
    // The DDT's PDF, as a presigned GET of this order's DDT only.
    const pdf = await ok('floor', 'GET', kits(order.id, `/ddts/${answer.ddt.id}/pdf`))
    expect(pdf.download.url).toEqual(expect.any(String))
    await refused('floor', 'GET', kits(order.id, `/ddts/${newId()}/pdf`), undefined, 404)
    await refused('floorB1', 'GET', kits(order.id, `/ddts/${answer.ddt.id}/pdf`), undefined, 404)
  })

  it('answers a stale version with a conflict (the office changed the order meanwhile)', async () => {
    const error = await refused('floor', 'POST', kits(order.id, '/send'), { version: kit.version - 1, bundles: [{ bundleId: whole[0]!.id }], ddt: DDT }, 409)
    expect(error.code).toBeDefined()
  })
})

describe('Receive back (SCM-142): bundle by bundle, one rejected, the unused lining back where it came from', () => {
  it('lists the order to receive, takes the first bundle back good and the second rejected with its reason', async () => {
    expect((await ok('receiver', 'GET', '/purchasing/subcontracting/kits?mode=receive')).orders.map((row: Json) => row.id)).toContain(order.id)
    const operation = kit.operations[0]
    const lining = kit.kitLines.find((line: Json) => line.item.id === A.lining)
    const answer = await ok(
      'receiver',
      'POST',
      kits(order.id, '/receive'),
      {
        version: kit.version,
        lines: [
          { operationId: operation.id, bundleId: whole[0]!.id, good: 1, defective: 0, scrapped: 0 },
          { operationId: operation.id, bundleId: whole[1]!.id, good: 0, defective: 1, scrapped: 0, reason: 'Open seam' },
        ],
        returns: [{ itemId: A.lining, lotId: liningLot, itemColourId: lining.colour?.id ?? null, quantity: '1', toLocationId: lining.from.id }],
        supplierDdt: { number: 'W-DDT-9' },
      },
      201,
    )
    expect(answer.receipt).toMatchObject({ good: 1, defective: 1, scrapped: 0, bundles: 2, returned: 1 })
    kit = answer.order
    expect(kit.operations[0]).toMatchObject({ backGood: 1, backDefective: 1, atWorkshop: whole.length - 2 })
    expect(kit.bundles.find((bundle: Json) => bundle.id === whole[1]!.id).back).toEqual([{ operationId: operation.id, good: 0, defective: 1, scrapped: 0 }])
    expect(kit.kitLines.find((line: Json) => line.id === lining.id).atWorkshop).toBe((Number(lining.baseQuantity) - 1).toFixed(4))
    expect(moneyKeys(answer)).toEqual([])
    // The fee for the good piece is on the work order's cost ledger (the office's rule, the same command body).
    const [entry] = await admin<{ amount: number }>(`SELECT amount FROM "WorkOrderCostEntry" WHERE "subcontractOrderId" = $1 AND kind = 'SUBCONTRACT'`, [order.id])
    expect(entry).toEqual({ amount: 525 })
    const [audit] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'purchasing.subcontract.receiveBack'`, [order.id])
    expect(audit!.after).toMatchObject({ floor: { deviceId: expect.any(String) }, supplierDdt: { number: 'W-DDT-9' } })
  })

  it('refuses a bundle back twice, and a send to a person who may only receive', async () => {
    const operation = kit.operations[0]
    expect((await refused('receiver', 'POST', kits(order.id, '/receive'), { version: kit.version, lines: [{ operationId: operation.id, bundleId: whole[0]!.id, good: 1, defective: 0, scrapped: 0 }] }, 400)).message).toMatch(/came back already|at the workshop/)
    await refused('receiver', 'POST', kits(order.id, '/send'), { version: kit.version, bundles: [], ddt: DDT }, 403)
  })
})
