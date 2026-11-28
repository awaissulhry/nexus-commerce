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
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping, type ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
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
 * "Print and start the work" and "Print again" (owb- order workflow, S3 ss2 steps 2.2 + 2.3; settles L1, L6, L7, L8) on the local
 * stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security,
 * the work order and bundle guards, OrderPrint's append-only and check triggers are real), the factory-db shipping seed (its
 * released WO-0001 shows the style is ready to make), three made-up copies of SEED-SO-0002 for the same customer (made-up facts,
 * as consolidate.pg's copies): SO-PRINT-ON (site A1, which the seed turns baskets at print ON), SO-PRINT-OFF (its lines at a
 * second plant with the switch off) and SO-PRINT-DEPOSIT (a deposit asked and not paid). Every name and number is made up.
 * WRITTEN, NOT RUN (Owner rule: tests at the end). Run with `node scripts/factory/run-pg-tests.mjs print-start`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let seedA: ShippingSeed

const ns = 'print-start'
const idOf = (key: string) => seedUuid(ns, key)
const A = { tenant: idOf('tenant'), companyA: idOf('company:A'), siteA1: idOf('site:A1'), customer: idOf('party:P1') }
const PLANT2 = newId()

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const fromTemplate = (key: string): Permission[] => {
  const template = templateOf(key)!
  return [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)]
}
const SESSIONS: Record<string, SessionContext> = {
  // The real Sales template: production.print.start, never workorders.manage nor workorders.release.
  sales: office([grant(fromTemplate('sales'))]),
  designer: office([grant(fromTemplate('designer'))]),
  planner: office([grant(['workorders.view', 'workorders.manage', 'workorders.release', 'orders.view'])]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const call = (session: string, method: Method, url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
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

const v4 = (expression: string, salt: string): string => {
  const hash = `md5(${expression}::text || '${salt}')`
  return `(substr(${hash}, 1, 8) || '-' || substr(${hash}, 9, 4) || '-4' || substr(${hash}, 14, 3) || '-8' || substr(${hash}, 18, 3) || '-' || substr(${hash}, 21, 12))::uuid`
}
/** SEED-SO-0002 copied as `number` (its lines and sizes too), CONFIRMED, no work order yet. */
const copyOrderSql = (sourceId: string, number: string): string => {
  const salt = number.toLowerCase()
  return `
    CREATE TEMP TABLE o AS SELECT * FROM "SalesOrder" WHERE id = '${sourceId}';
    CREATE TEMP TABLE l AS SELECT * FROM "SalesOrderLine" WHERE "orderId" = (SELECT id FROM o);
    CREATE TEMP TABLE s AS SELECT * FROM "SalesOrderLineSize" WHERE "lineId" IN (SELECT id FROM l);
    UPDATE s SET id = ${v4('id', salt)}, "lineId" = ${v4('"lineId"', salt)};
    UPDATE l SET id = ${v4('id', salt)}, "orderId" = ${v4('"orderId"', salt)}, "quoteLineId" = NULL;
    UPDATE o SET id = ${v4('id', salt)}, number = '${number}', "quoteVersionId" = NULL, "customerRef" = '${number}-PO', "customerSeq" = NULL, status = 'CONFIRMED';
    INSERT INTO "SalesOrder" SELECT * FROM o;
    INSERT INTO "SalesOrderLine" SELECT * FROM l;
    INSERT INTO "SalesOrderLineSize" SELECT * FROM s;
    DROP TABLE o, l, s;`
}
const orderId = async (number: string) => (await admin<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2`, [A.tenant, number]))[0]!.id
const piecesOf = async (id: string) => (await admin<{ n: number }>(`SELECT coalesce(sum(s.quantity), 0)::int AS n FROM "SalesOrderLineSize" s JOIN "SalesOrderLine" l ON l.id = s."lineId" WHERE l."orderId" = $1`, [id]))[0]!.n
const workOrdersOf = (id: string) => admin<{ id: string; number: string; status: string }>(`SELECT DISTINCT w.id, w.number, w.status::text AS status FROM "WorkOrder" w JOIN "WorkOrderSize" c ON c."workOrderId" = w.id JOIN "SalesOrderLine" l ON l.id = c."salesOrderLineId" WHERE l."orderId" = $1 ORDER BY w.number`, [id])
const basketsOf = (id: string) => admin<{ id: string; code: string; madeAtPrint: boolean; cutLogIds: string[]; quantity: number }>(`SELECT b.id, b.code, b."madeAtPrint", b."cutLogIds"::text[] AS "cutLogIds", b.quantity FROM "Bundle" b JOIN "WorkOrderSize" c ON c.id = b."workOrderSizeId" JOIN "SalesOrderLine" l ON l.id = c."salesOrderLineId" WHERE l."orderId" = $1 ORDER BY b.code`, [id])
// Filled in order by the cases below (each case reads only the ids an earlier case set).
const ids = {} as { deposit: string; off: string; on: string; print: string }

beforeAll(async () => {
  db = await migratedDatabase('print_start')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  seedA = await seedShipping({ db: database, namespace: ns })
  const so2 = seedA.quality.production.salesOrderId
  for (const number of ['SO-PRINT-ON', 'SO-PRINT-OFF', 'SO-PRINT-DEPOSIT']) await admin(copyOrderSql(so2, number))
  ids.on = await orderId('SO-PRINT-ON')
  ids.off = await orderId('SO-PRINT-OFF')
  ids.deposit = await orderId('SO-PRINT-DEPOSIT')
  // Site A1 makes its baskets at print (the base seed turns it on there; set again here, made-up fact).
  await force(`UPDATE "ProductionSettings" SET "basketsAtPrint" = true WHERE id = $1`, [A.siteA1])
  // A second plant of company A with the switch off (a copy of site A1's row: its work centres and settings), for SO-PRINT-OFF.
  await force(`INSERT INTO "Site" SELECT * FROM jsonb_populate_record(NULL::"Site", (SELECT to_jsonb(s) || jsonb_build_object('id', $1::uuid, 'code', 'SEED-A2', 'name', 'Seed plant A2') FROM "Site" s WHERE id = $2))`, [PLANT2, A.siteA1])
  await force(`INSERT INTO "WorkCentre" SELECT * FROM jsonb_populate_record(NULL::"WorkCentre", (SELECT to_jsonb(w) || jsonb_build_object('id', ${v4('w.id', 'a2')}, 'siteId', $1::uuid) FROM "WorkCentre" w WHERE w.id = x.id)) FROM "WorkCentre" x WHERE x."siteId" = $2`, [PLANT2, A.siteA1])
  await force(`INSERT INTO "ProductionSettings" SELECT * FROM jsonb_populate_record(NULL::"ProductionSettings", (SELECT to_jsonb(p) || jsonb_build_object('id', $1::uuid, 'siteId', $1::uuid, 'basketsAtPrint', false) FROM "ProductionSettings" p WHERE id = $2)) ON CONFLICT DO NOTHING`, [PLANT2, A.siteA1])
  await force(`UPDATE "SalesOrderLine" SET "siteId" = $2 WHERE "orderId" = $1`, [ids.off, PLANT2])
  // SO-PRINT-DEPOSIT asks a deposit that is not paid (the release's DEPOSIT check refuses).
  await force(`UPDATE "SalesOrder" SET "depositRequired" = true WHERE id = $1`, [ids.deposit])
  if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])).length === 0) {
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), A.tenant])
  }
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-print-start-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
}, 180_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

const start = (id: string) => `/production/orders/${id}/print-and-start`
const versionOf = async (id: string) => (await admin<{ version: number }>(`SELECT version FROM "SalesOrder" WHERE id = $1`, [id]))[0]!.version

describe('2.2 who may print and start', () => {
  it('the designer has no such right (403); another customer’s order answers as unknown', async () => {
    expect((await call('designer', 'GET', `/production/orders/${ids.on}/print-start`)).statusCode).toBe(403)
    expect((await call('designer', 'POST', start(ids.on), { version: await versionOf(ids.on) })).statusCode).toBe(403)
    expect((await refused('sales', 'GET', `/production/orders/${newId()}/print-start`, undefined, 404)).message).toBe('Sales order not found.')
  })
})

describe('2.2 the preview: what it would do', () => {
  it('READY, the work orders still to make, the baskets where the site makes them at print', async () => {
    const preview = await ok('sales', 'GET', `/production/orders/${ids.on}/print-start`)
    expect(preview).toMatchObject({ orderId: ids.on, state: 'READY', printedAt: null, basketsAtPrint: true })
    expect((preview.workOrders as Json[]).every((row) => row.workOrderId === null && row.number === null)).toBe(true)
    expect(preview.baskets.count).toBe(await piecesOf(ids.on))
    expect(JSON.stringify(preview)).not.toMatch(/legalName|price|amount/i)
  })
})

describe('2.2 print and start (sales, without workorders.manage)', () => {
  it('a DEPOSIT refusal rolls back the drafts, the baskets and the print: 409 with every problem as an issue', async () => {
    const error = await refused('sales', 'POST', start(ids.deposit), { version: await versionOf(ids.deposit), materialReason: 'Test: leather on its way' }, 409)
    expect(error.issues.map((issue: Json) => issue.path)).toContain('problem/DEPOSIT')
    expect(await workOrdersOf(ids.deposit)).toEqual([])
    expect(await basketsOf(ids.deposit)).toEqual([])
    expect(await admin(`SELECT 1 FROM "OrderPrint" WHERE "salesOrderId" = $1`, [ids.deposit])).toEqual([])
  })

  it('switch on: the work orders released, one basket a piece, all made at print, no bundle_created; the FIRST print; the event', async () => {
    const version = await versionOf(ids.on)
    const preview = await ok('sales', 'GET', `/production/orders/${ids.on}/print-start`)
    if (preview.needsMaterialReason) {
      const short = await refused('sales', 'POST', start(ids.on), { version }, 409)
      expect(short.message).toMatch(/Material is short/)
    }
    const printed = await ok('sales', 'POST', start(ids.on), { version, materialReason: 'Test: leather on its way' })
    ids.print = printed.printId
    expect(printed.baskets).toBe(await piecesOf(ids.on))
    const workOrders = await workOrdersOf(ids.on)
    expect(workOrders.length).toBeGreaterThan(0)
    expect(workOrders.every((row) => row.status === 'RELEASED')).toBe(true)
    expect(printed.workOrders.map((row: Json) => row.id).sort()).toEqual(workOrders.map((row) => row.id).sort())
    const baskets = await basketsOf(ids.on)
    expect(baskets).toHaveLength(printed.baskets)
    expect(baskets.every((basket) => basket.madeAtPrint && basket.cutLogIds.length === 0 && basket.quantity === 1)).toBe(true)
    expect(await admin(`SELECT 1 FROM "OutboxEvent" WHERE type = 'production.bundle_created' AND payload->>'bundleId' = ANY($1::text[])`, [baskets.map((basket) => basket.id)])).toEqual([])
    expect(await admin(`SELECT kind::text AS kind, cards FROM "OrderPrint" WHERE "salesOrderId" = $1`, [ids.on])).toEqual([{ kind: 'FIRST', cards: [] }])
    expect((await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'production.order_print_started' AND subject = $1`, [ids.on])).map((row) => row.payload)).toEqual([expect.objectContaining({ printId: ids.print, baskets: printed.baskets, partyId: A.customer })])
    const [audit] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1 AND action = 'production.printAndStart'`, [ids.on])
    expect(audit!.after).toMatchObject({ printId: ids.print, baskets: printed.baskets })
  })

  it('a second FIRST print is refused in words; the preview says PRINTED', async () => {
    const again = await refused('sales', 'POST', start(ids.on), { version: await versionOf(ids.on) }, 409)
    expect(again.issues[0].path).toBe('refusal/PRINTED')
    expect(again.message).toMatch(/^Printed on .*Use Print again/)
    expect((await ok('sales', 'GET', `/production/orders/${ids.on}/print-start`)).state).toBe('PRINTED')
  })

  it('switch off: the work orders released, no basket', async () => {
    const printed = await ok('sales', 'POST', start(ids.off), { version: await versionOf(ids.off), materialReason: 'Test: leather on its way' })
    expect(printed.baskets).toBe(0)
    expect((await workOrdersOf(ids.off)).every((row) => row.status === 'RELEASED')).toBe(true)
    expect(await basketsOf(ids.off)).toEqual([])
  })
})

describe('2.3 print again (the same codes) and the sheet', () => {
  it('AGAIN keeps every code, writes no BundleReprint; the PAPER call of a ticked basket is SOLVED, another stays open', async () => {
    const baskets = await basketsOf(ids.on)
    const [first, second] = baskets
    const codes = baskets.map((basket) => basket.code)
    // Two "Page lost or damaged" calls of the floor (made-up facts: copies of a seeded call row, on two baskets).
    const paper = (await admin<{ id: string }>(`SELECT id FROM "HelpCallType" WHERE "siteId" = $1 AND code = 'PAPER'`, [A.siteA1]))[0]
    expect(paper, 'the base seeds a PAPER call type at the demo site').toBeDefined()
    const station = (await admin<{ id: string; lineId: string | null }>(`SELECT id, "lineId" FROM "Station" WHERE "siteId" = $1 ORDER BY code LIMIT 1`, [A.siteA1]))[0]!
    const workOrderOf = async (bundleId: string) => (await admin<{ workOrderId: string }>(`SELECT "workOrderId" FROM "Bundle" WHERE id = $1`, [bundleId]))[0]!.workOrderId
    const calls: string[] = []
    for (const basket of [first!, second!]) {
      const callId = newId()
      await force(`INSERT INTO "HelpCall" (id, "tenantId", "siteId", "typeId", "stationId", "lineId", "workOrderId", "bundleId", status, "sentAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'SENT', now())`, [callId, A.tenant, A.siteA1, paper!.id, station.id, station.lineId, await workOrderOf(basket.id), basket.id])
      calls.push(callId)
    }
    const again = await ok('sales', 'POST', `/production/orders/${ids.on}/prints`, { reason: 'LOST', pages: [], cards: [{ bundleId: first!.id }] }, 201)
    expect(again).toEqual({ printId: expect.any(String), printNo: 2, solvedCalls: 1 })
    expect((await basketsOf(ids.on)).map((basket) => basket.code)).toEqual(codes)
    expect(await admin(`SELECT 1 FROM "BundleReprint" WHERE "bundleId" = ANY($1::uuid[])`, [baskets.map((basket) => basket.id)])).toEqual([])
    expect(await admin(`SELECT status::text AS status, "resolutionCode" FROM "HelpCall" WHERE id = ANY($1::uuid[]) ORDER BY "bundleId" = $2 DESC`, [calls, first!.id])).toEqual([
      { status: 'SOLVED', resolutionCode: 'PRINTED_AGAIN' },
      { status: 'SENT', resolutionCode: null },
    ])
  })

  it('a small change writes ONE note for the floor per work order of the pieces ticked; its words are required', async () => {
    const lineId = (await admin<{ id: string }>(`SELECT id FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq LIMIT 1`, [ids.on]))[0]!.id
    expect((await refused('sales', 'POST', `/production/orders/${ids.on}/prints`, { reason: 'SMALL_CHANGE', pages: [{ salesOrderLineId: lineId, page: 1 }], cards: [] }, 400)).issues[0].path).toBe('body/note')
    await ok('sales', 'POST', `/production/orders/${ids.on}/prints`, { reason: 'SMALL_CHANGE', note: 'The logo moves 2 cm left.', pages: [{ salesOrderLineId: lineId, page: 1 }], cards: [] }, 201)
    const notes = await admin<{ recordId: string; bodyText: string; forFloor: boolean }>(
      `SELECT t."recordId", m."bodyText", m."forFloor" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'WorkOrder' AND m."bodyText" LIKE 'The design changed:%'`,
    )
    const touched = (await admin<{ id: string }>(`SELECT DISTINCT c."workOrderId" AS id FROM "WorkOrderSize" c WHERE c."salesOrderLineId" = $1`, [lineId])).map((row) => row.id)
    expect(notes.map((note) => note.recordId).sort()).toEqual(touched.sort())
    expect(notes.every((note) => note.forFloor && note.bodyText === 'The design changed: The logo moves 2 cm left.')).toBe(true)
    expect((await admin(`SELECT 1 FROM "OutboxEvent" WHERE type = 'production.floor_note_posted' AND payload->>'salesOrderId' = $1`, [ids.on])).length).toBe(touched.length)
  })

  it('the sheet: the customer CODE, never a name or a price; codes and work order numbers; print numbers; the current sheet', async () => {
    const sheet = await ok('sales', 'GET', `/production/orders/${ids.on}/print-sheet?printId=${ids.print}`)
    expect(sheet).toMatchObject({ printId: ids.print, kind: 'FIRST', order: { number: 'SO-PRINT-ON', customerCode: expect.any(String) } })
    expect(JSON.stringify(sheet)).not.toMatch(/legalName|tradeName|Seed Customer One|price|amount/i)
    expect((sheet.cards as Json[]).every((card) => card.code.startsWith('BN') && card.printNo === 1 && card.shipped === false)).toBe(true)
    const current = await ok('sales', 'GET', `/production/orders/${ids.on}/print-sheet`)
    expect(current.cards).toHaveLength((await basketsOf(ids.on)).length)
    expect((current.cards as Json[]).some((card) => card.printNo === 2)).toBe(true)
    expect((await refused('sales', 'GET', `/production/orders/${ids.deposit}/print-sheet`, undefined, 404)).message).toBe('Nothing was printed yet: Print and start the work first.')
  })
})
