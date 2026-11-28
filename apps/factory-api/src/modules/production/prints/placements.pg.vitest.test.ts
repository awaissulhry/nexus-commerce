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
import { placedOf } from './placements'

/**
 * Place the scan code (owb- order workflow, S3 ss2b; settle L8; design § 5f; factory-db ScanCodePlacement of wave owb-ssw) on the local
 * stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (ScanCodePlacement's guard is real), the
 * factory-db shipping seed, a made-up copy of SEED-SO-0002 (SO-PLACE-1) with a made-up design PDF on its first line, printed and started
 * by Sales; two office designers made up (one followed onto the order, one not). Every name and number is made up. WRITTEN, NOT RUN
 * (Owner rule: tests at the end). Run with `node scripts/factory/run-pg-tests.mjs placements`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let seedA: ShippingSeed

const ns = 'placements'
const idOf = (key: string) => seedUuid(ns, key)
const A = { tenant: idOf('tenant'), companyA: idOf('company:A'), siteA1: idOf('site:A1') }
const DESIGNER_ON = newId()
const DESIGNER_OFF = newId()

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const fromTemplate = (key: string): Permission[] => {
  const template = templateOf(key)!
  return [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)]
}
const SESSIONS: Record<string, SessionContext> = {
  sales: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(fromTemplate('sales'))] },
  designerOn: { audience: 'office', tenantId: A.tenant, actorId: DESIGNER_ON, grants: [grant(fromTemplate('designer'))] },
  designerOff: { audience: 'office', tenantId: A.tenant, actorId: DESIGNER_OFF, grants: [grant(fromTemplate('designer'))] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const v4 = (expression: string, salt: string): string => {
  const hash = `md5(${expression}::text || '${salt}')`
  return `(substr(${hash}, 1, 8) || '-' || substr(${hash}, 9, 4) || '-4' || substr(${hash}, 14, 3) || '-8' || substr(${hash}, 18, 3) || '-' || substr(${hash}, 21, 12))::uuid`
}
const ids: Record<string, string> = {}

beforeAll(async () => {
  db = await migratedDatabase('placements')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  seedA = await seedShipping({ db: database, namespace: ns })
  const salt = 'so-place-1'
  await admin(`
    CREATE TEMP TABLE o AS SELECT * FROM "SalesOrder" WHERE id = '${seedA.quality.production.salesOrderId}';
    CREATE TEMP TABLE l AS SELECT * FROM "SalesOrderLine" WHERE "orderId" = (SELECT id FROM o);
    CREATE TEMP TABLE s AS SELECT * FROM "SalesOrderLineSize" WHERE "lineId" IN (SELECT id FROM l);
    UPDATE s SET id = ${v4('id', salt)}, "lineId" = ${v4('"lineId"', salt)};
    UPDATE l SET id = ${v4('id', salt)}, "orderId" = ${v4('"orderId"', salt)}, "quoteLineId" = NULL;
    UPDATE o SET id = ${v4('id', salt)}, number = 'SO-PLACE-1', "quoteVersionId" = NULL, "customerRef" = 'SO-PLACE-1-PO', "customerSeq" = NULL, status = 'CONFIRMED';
    INSERT INTO "SalesOrder" SELECT * FROM o; INSERT INTO "SalesOrderLine" SELECT * FROM l; INSERT INTO "SalesOrderLineSize" SELECT * FROM s;
    DROP TABLE o, l, s;`)
  const order = (await admin<{ id: string; partyId: string }>(`SELECT id, "partyId" FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SO-PLACE-1'`, [A.tenant]))[0]!
  ids.order = order.id
  ids.line = (await admin<{ id: string }>(`SELECT id FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq LIMIT 1`, [order.id]))[0]!.id
  if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])).length === 0) {
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), A.tenant])
  }
  // The line's design page: a made-up PDF filed as ARTWORK on the order line (only the row matters).
  ids.file = newId()
  const store = (await admin<{ id: string }>(`SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2' ORDER BY id LIMIT 1`, [A.tenant]))[0]!.id
  await admin(
    `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status, visibility, category, "availableAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'SalesOrderLine', $4, 'DOCUMENT', 'mockup.pdf', 'application/pdf', 4000, repeat('d', 64), $5, $6, 'AVAILABLE', '{OFFICE}'::"FileAudience"[], 'ARTWORK', now(), now(), now())`,
    [ids.file, A.tenant, A.companyA, ids.line, store, `t/${A.tenant}/c/${A.companyA}/2026/${ids.file}`],
  )
  // Two office designers (made up); one is put on the order (a follower, as S2's people writer does).
  await database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => {
    for (const [id, email] of [[DESIGNER_ON, 'dina.on@factory-a.example.com'], [DESIGNER_OFF, 'dario.off@factory-a.example.com']] as const) {
      await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'OFFICE' }, select: { id: true } })
    }
    await client.recordFollower.create({ data: { id: newId(), recordType: 'SalesOrder', recordId: order.id, userId: DESIGNER_ON, reason: 'ADDED' }, select: { id: true } })
  })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-placements-test-'))
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

const url = () => `/production/orders/${ids.order}/placements/${ids.line}`
const A4 = { pageWidthMm: 210, pageHeightMm: 297 }

describe('b.1 Place the scan code: the rules and who', () => {
  it('smaller than 20 mm or off the page is refused (400); a designer not on the order gets the not-found of an unknown one', async () => {
    const small = await call('sales', 'PUT', url(), { fileId: ids.file, page: 1, xMm: 10, yMm: 10, sizeMm: 19, ...A4 })
    expect(small.statusCode, small.body).toBe(400)
    expect(small.json().error.issues[0].path).toBe('body/sizeMm')
    const off = await call('sales', 'PUT', url(), { fileId: ids.file, page: 1, xMm: 200, yMm: 10, sizeMm: 20, ...A4 })
    expect(off.statusCode, off.body).toBe(400)
    expect(off.json().error.issues[0].path).toBe('body/xMm')
    const unknown = await call('designerOff', 'GET', `/production/orders/${newId()}/placements`)
    const walled = await call('designerOff', 'GET', `/production/orders/${ids.order}/placements`)
    expect([unknown.statusCode, walled.statusCode]).toEqual([404, 404])
    expect(walled.json().error.message).toBe(unknown.json().error.message)
    expect((await call('designerOff', 'PUT', url(), { fileId: ids.file, page: 1, xMm: 10, yMm: 10, sizeMm: 25, ...A4 })).statusCode).toBe(404)
    // Not a design file of the line.
    expect((await call('sales', 'PUT', url(), { fileId: newId(), page: 1, xMm: 10, yMm: 10, sizeMm: 25, ...A4 })).json().error.issues[0].path).toBe('body/fileId')
  })

  it('the designer on the order places it; a second save moves it at its version (one row); ONE audit row each', async () => {
    const placed = await ok('designerOn', 'PUT', url(), { fileId: ids.file, page: 1, xMm: 175.5, yMm: 12, sizeMm: 25, ...A4 })
    expect(placed).toMatchObject({ salesOrderLineId: ids.line, fileId: ids.file, page: 1, xMm: 175.5, yMm: 12, sizeMm: 25, version: 1, placedBy: { name: 'dina.on' } })
    const stale = await call('sales', 'PUT', url(), { fileId: ids.file, page: 1, xMm: 150, yMm: 12, sizeMm: 25, ...A4, version: 9 })
    expect(stale.statusCode, stale.body).toBe(409)
    const moved = await ok('sales', 'PUT', url(), { fileId: ids.file, page: 1, xMm: 150, yMm: 20, sizeMm: 30, ...A4, version: placed.version })
    expect(moved).toMatchObject({ xMm: 150, yMm: 20, sizeMm: 30, version: 2 })
    expect(await admin(`SELECT count(*)::int AS n FROM "ScanCodePlacement" WHERE "salesOrderLineId" = $1`, [ids.line])).toEqual([{ n: 1 }])
    expect(await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'production.placeScanCode' AND "recordType" = 'ScanCodePlacement'`)).toEqual([{ n: 2 }])
    expect((await ok('designerOn', 'GET', `/production/orders/${ids.order}/placements`)).placements).toEqual([expect.objectContaining({ xMm: 150, yMm: 20, sizeMm: 30, version: 2 })])
  })
})

describe('b.2 the preview, the sheet and the Design desk read the place', () => {
  it('the preview counts it; placedOf gives the desk 1 of 1', async () => {
    const preview = await ok('sales', 'GET', `/production/orders/${ids.order}/print-start`)
    expect(preview.placed).toEqual({ done: 1, of: 1 })
    expect((preview.pages as Json[]).find((page) => page.salesOrderLineId === ids.line)).toMatchObject({ fileId: ids.file, placed: true })
    const desk = await database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) => placedOf(client, { orderIds: [ids.order!] }))
    expect(desk.get(ids.order!)).toEqual({ done: 1, of: 1 })
  })

  it('the sheet carries the saved place on the design page', async () => {
    const version = (await admin<{ version: number }>(`SELECT version FROM "SalesOrder" WHERE id = $1`, [ids.order]))[0]!.version
    await ok('sales', 'POST', `/production/orders/${ids.order}/print-and-start`, { version, materialReason: 'Test: leather on its way' })
    const sheet = await ok('sales', 'GET', `/production/orders/${ids.order}/print-sheet`)
    expect((sheet.pages as Json[]).find((page) => page.salesOrderLineId === ids.line)).toMatchObject({ fileId: ids.file, page: 1, placement: { xMm: 150, yMm: 20, sizeMm: 30 } })
  })
})
