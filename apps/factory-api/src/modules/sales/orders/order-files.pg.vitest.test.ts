import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds and fixtures are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seedFile } from '../../../../../../packages/factory-db/src/seed-files'
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
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from '../../production/testing/two-brands'

/**
 * B-SA-036 — every file of one sales order for the office (`GET /sales/orders/:orderId/files`, `POST …/files/:fileId/open`): Sales
 * page plan N9, P14, R7; 13-backend B11; review BW-1. The Owner rule 2026-11-16: "One brand must not be able to see anything related
 * to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."
 *
 * On the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login), the
 * gateway on the local Redis and the FAKE file store in a temporary folder (the 60-second links are real presigned GETs), the core,
 * auth, roles, files, production and numbering seeds (Brand Alpha = the seeds' P1) and the production two-brand harness (each brand's
 * DRAFT work order, Beta's on SEED-SO-B001, and a work order made before the one-customer rule with a cell of each brand). The test
 * adds, on Alpha's order: an order sheet shared with Alpha and one office only, a line artwork, a measurement sheet, a file on
 * Alpha's work order and one on the mixed work order; and copies of the order sheet (as Use on made them): on Alpha's own line, on
 * Alpha's other order SEED-SO-0002, and an old copy on Beta's order (made before the write rule: the admin pool, its rules off).
 * Sessions: `office.all` (every customer), `office.p1` / `office.p2` (one customer each) with every right here, and Alpha's person
 * with orders.view and files.read only. Every answer Beta's person got is scanned for Alpha's names, numbers, file names and ids.
 * Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/orders/order-files`.
 */

const ns = 'sa036-order-files'
const ids = twoBrandIds(ns)
const companyA = seedUuid(ns, 'company:A')
const PERMISSIONS: Permission[] = ['orders.view', 'workorders.view', 'workorders.manage', 'files.read', 'threads.read', 'sales.measurements.view', 'quality.inspections.view', 'shipping.view', 'invoices.view']
const grant = (permissions: Permission[], parties: Grant['parties']): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const session = (...grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: ids.tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  ...twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS),
  // Alpha's person with the order and the files only: no work orders, no measurements.
  'office.p1.thin': session(grant(['orders.view', 'files.read'], [ids.a])),
}
const B_SESSIONS = new Set(['office.p2'])

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let aMarkers: Marker[]
let redis: TestRedis | undefined
let localRoot = ''
const files = { shared: '', office: '', artwork: '', measure: '', onWorkOrder: '', onMixed: '', copyOnLine: '', copyOnOtherOrder: '', copyOnBeta: '' }
let otherOrder = { id: '', number: '' }

type Json = Record<string, any>
const seenByB: { readonly url: string; readonly body: unknown }[] = []
async function call(sessionName: string, method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; body: Json; raw: string }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': sessionName }, ...(method === 'POST' ? { payload: (body ?? {}) as object } : {}) })
  const parsed = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  if (B_SESSIONS.has(sessionName)) seenByB.push({ url, body: parsed })
  return { status: response.statusCode, body: parsed, raw: response.body }
}
async function ok(sessionName: string, method: 'GET' | 'POST', url: string, body?: unknown): Promise<Json> {
  const answer = await call(sessionName, method, url, body)
  expect(answer.status, `${method} ${url}: ${answer.raw.slice(0, 600)}`).toBe(200)
  return answer.body
}
async function notFound(sessionName: string, method: 'GET' | 'POST', url: string, words: string, body?: unknown): Promise<void> {
  const answer = await call(sessionName, method, url, body)
  expect([answer.status, answer.body.error?.message], `${method} ${url}`).toEqual([404, words])
}
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const lit = (value: string): string => {
  if (!isUuid(value)) throw new Error(`not an id: ${value}`)
  return `'${value}'`
}
const listOf = (orderId: string) => `/sales/orders/${orderId}/files`
const openOf = (orderId: string, fileId: string) => `/sales/orders/${orderId}/files/${fileId}/open`
const groupOf = (list: Json, key: string): Json => (list.groups as Json[]).find((group) => group.key === key) ?? {}
const everyFile = (list: Json): Json[] => (list.groups as Json[]).flatMap((group) => group.files as Json[])
const fileOfList = (list: Json, fileId: string): Json | undefined => everyFile(list).find((file) => file.id === fileId)

/** A made-up file of a record, written as the office's runtime login writes rows (the database's file rules apply). */
let minute = 0
async function fileOn(recordType: string, recordId: string, originalName: string, extra: { readonly category?: 'ARTWORK' | 'MEASUREMENTS'; readonly sharedWith?: string } = {}): Promise<string> {
  const id = newId()
  const at = new Date(Date.now() - 60 * 60_000 + ++minute * 60_000)
  await database.withScope({ audience: 'office', tenantId: ids.tenantId, actorId: newId() }, (client) =>
    client.storedFile.create({
      data: seedFile(ids.tenantId, {
        id,
        companyId: companyA,
        recordType,
        recordId,
        kind: 'DOCUMENT',
        ...(extra.category ? { category: extra.category } : {}),
        originalName,
        contentType: 'application/pdf',
        sizeBytes: 2048,
        storeAccountId: seedUuid(ns, 'files:account:r2'),
        storageKey: `t/${ids.tenantId}/c/${companyA}/2026/${newId()}`,
        status: 'AVAILABLE',
        availableAt: at,
        visibility: extra.sharedWith ? ['OFFICE', 'PARTNER'] : ['OFFICE'],
        ...(extra.sharedWith ? { partyId: extra.sharedWith } : {}),
        createdAt: at,
        updatedAt: at,
      }),
      select: { id: true },
    }),
  )
  return id
}

/** A copy of a file on another record (as Use on made one: the same bytes, `sourceFileId` its source), office only. */
async function copyOf(sourceId: string, recordType: string, recordId: string): Promise<string> {
  const id = newId()
  await admin(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     INSERT INTO "StoredFile" SELECT (jsonb_populate_record(NULL::"StoredFile", to_jsonb(f) || jsonb_build_object('id', ${lit(id)}, 'recordType', '${recordType}', 'recordId', ${lit(recordId)}, 'sourceFileId', f.id, 'visibility', '{OFFICE}'::text[], 'partyId', NULL, 'storageKey', 't/${ids.tenantId}/c/${companyA}/2026/${newId()}'))).* FROM "StoredFile" f WHERE f.id = ${lit(sourceId)};
     COMMIT;`,
  )
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('sa036_order_files')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const seed of [seedCore, seedAuth, seedRoles, seedFiles]) await seed({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [ids.tenantId])
  redis = testRedis()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-sa036-order-files-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: redis.connect(), prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(w.a.partyId).toBe(ids.a)

  const [so2] = await admin<{ id: string; number: string }>(`SELECT id, number FROM "SalesOrder" WHERE id = $1`, [seedUuid(ns, 'production:sales-order:SO-0002')])
  otherOrder = so2!
  files.shared = await fileOn('SalesOrder', w.a.salesOrderId, 'T-SA036-A order sheet.pdf', { sharedWith: ids.a })
  files.office = await fileOn('SalesOrder', w.a.salesOrderId, 'T-SA036-A office notes.pdf')
  files.artwork = await fileOn('SalesOrderLine', w.a.salesOrderLineId, 'T-SA036-A logo artwork.pdf', { category: 'ARTWORK' })
  files.measure = await fileOn('SalesOrder', w.a.salesOrderId, 'T-SA036-A measurement sheet.pdf', { category: 'MEASUREMENTS' })
  files.onWorkOrder = await fileOn('WorkOrder', w.a.workOrderId, 'T-SA036-A cutting photo.pdf')
  files.onMixed = await fileOn('WorkOrder', w.mixed.workOrderId, 'T-SA036-MIX lot photo.pdf')
  files.copyOnLine = await copyOf(files.shared, 'SalesOrderLine', w.a.salesOrderLineId)
  files.copyOnOtherOrder = await copyOf(files.shared, 'SalesOrder', otherOrder.id)
  files.copyOnBeta = await copyOf(files.shared, 'SalesOrder', w.b.salesOrderId)

  aMarkers = [
    ...(await markersOf(db, w.a.partyId)),
    ...Object.values(files).map((text) => ({ label: 'A file id', text })),
    ...['T-SA036-A order sheet.pdf', 'T-SA036-A office notes.pdf', 'T-SA036-A logo artwork.pdf', 'T-SA036-A measurement sheet.pdf', 'T-SA036-A cutting photo.pdf', 'T-SA036-MIX lot photo.pdf'].map((text) => ({ label: 'A file', text })),
    { label: 'A order', text: w.a.salesOrderId },
    { label: 'A work order', text: w.a.workOrderId },
  ]
}, 300_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('GET /sales/orders/:orderId/files — every file of the order by where it comes from', { timeout: 60_000 }, () => {
  it('groups by source with who can see each file; the production unit sees the mixed work order’s file in Production', async () => {
    const list = await ok('office.all', 'GET', listOf(w.a.salesOrderId))
    expect(list.order).toMatchObject({ id: w.a.salesOrderId })
    expect((list.groups as Json[]).map((group) => group.key)).toEqual(['ORDER', 'LINES', 'REQUESTS', 'PRODUCTION', 'QUALITY', 'SHIPMENTS', 'RETURNS'])
    expect(groupOf(list, 'ORDER').words).toEqual({ it: 'Ordine e conversazione', en: 'Order & thread' })
    expect(list.cap).toBe(500)
    expect(list.truncated).toBe(false)
    expect(fileOfList(list, files.shared)).toMatchObject({ audience: 'CUSTOMER_CAN_SEE', from: { type: 'SalesOrder', id: w.a.salesOrderId }, bodyData: false })
    expect(fileOfList(list, files.office)).toMatchObject({ audience: 'OFFICE_ONLY' })
    expect(fileOfList(list, files.artwork)).toMatchObject({ from: { type: 'SalesOrderLine', id: w.a.salesOrderLineId }, line: { id: w.a.salesOrderLineId, seq: 900 }, category: 'ARTWORK' })
    expect(fileOfList(list, files.measure)).toMatchObject({ bodyData: true })
    expect((groupOf(list, 'PRODUCTION').files as Json[]).map((file) => file.id).sort()).toEqual([files.onWorkOrder, files.onMixed].sort())
    expect(groupOf(list, 'PRODUCTION').leftOut).toBe(0)
    // No address: a file opens only through the order's own route, never the generic preview.
    expect(JSON.stringify(list)).not.toMatch(/\/files\/[0-9a-f-]{36}\/preview|https?:/)
    expect(list.total).toBe(everyFile(list).length)
  })

  it('a copy is listed once: "also on" names only records of this order’s customer the reader reaches; Beta’s record is counted, never named (BW-1)', async () => {
    const list = await ok('office.all', 'GET', listOf(w.a.salesOrderId))
    // The copy on Alpha's own line is folded under the order's sheet (ORDER comes first): listed once.
    expect(fileOfList(list, files.copyOnLine)).toBeUndefined()
    const sheet = fileOfList(list, files.shared)!
    expect((sheet.alsoOn as Json[]).map((record) => `${record.type}:${record.id}`).sort()).toEqual([`SalesOrder:${otherOrder.id}`, `SalesOrderLine:${w.a.salesOrderLineId}`].sort())
    expect((sheet.alsoOn as Json[]).find((record) => record.id === otherOrder.id)?.label).toBe(otherOrder.number)
    // Beta's order: "also on 1 other record" — even for the production unit, the answer never names another customer's record.
    expect(sheet.alsoOnOther).toBe(1)
    expect(JSON.stringify(list)).not.toContain(w.b.salesOrderId)
    expect(JSON.stringify(list)).not.toContain(files.copyOnBeta)
    // Alpha's own person: the same (its other order is its own).
    const own = fileOfList(await ok('office.p1', 'GET', listOf(w.a.salesOrderId)), files.shared)!
    expect((own.alsoOn as Json[]).map((record) => record.id).sort()).toEqual([otherOrder.id, w.a.salesOrderLineId].sort())
    expect(own.alsoOnOther).toBe(1)
    // The folded copy still opens (it is one of the order's own files).
    expect((await ok('office.p1', 'POST', openOf(w.a.salesOrderId, files.copyOnLine), {})).file.id).toBe(files.copyOnLine)
  })

  it('a work order made before the one-customer rule: its file is counted, never listed, for an Alpha-limited reader', async () => {
    const list = await ok('office.p1', 'GET', listOf(w.a.salesOrderId))
    const production = groupOf(list, 'PRODUCTION')
    expect((production.files as Json[]).map((file) => file.id)).toEqual([files.onWorkOrder])
    expect(production.leftOut).toBe(1)
    expect(JSON.stringify(list)).not.toContain('T-SA036-MIX lot photo.pdf')
    expect(JSON.stringify(list)).not.toContain(w.mixed.workOrderId)
    await notFound('office.p1', 'POST', openOf(w.a.salesOrderId, files.onMixed), 'File not found.')
  })

  it('each group by its right; body data only with the measurements right, counted otherwise and refused to open', async () => {
    const thin = await ok('office.p1.thin', 'GET', listOf(w.a.salesOrderId))
    // No workorders.view: the production files are counted, never named.
    expect(groupOf(thin, 'PRODUCTION')).toMatchObject({ files: [], leftOut: 2 })
    expect(fileOfList(thin, files.measure)).toBeUndefined()
    expect(groupOf(thin, 'ORDER').measurementsLeftOut).toBe(1)
    expect(fileOfList(thin, files.shared)).toBeDefined()
    await notFound('office.p1.thin', 'POST', openOf(w.a.salesOrderId, files.measure), 'File not found.')
    await notFound('office.p1.thin', 'POST', openOf(w.a.salesOrderId, files.onWorkOrder), 'File not found.')
  })

  it('opens a file through its own route (60 seconds); opening body data is recorded on the order', async () => {
    const preview = await ok('office.all', 'POST', openOf(w.a.salesOrderId, files.shared), {})
    expect(preview).toMatchObject({ file: { id: files.shared, name: 'T-SA036-A order sheet.pdf', contentType: 'application/pdf' }, open: { mode: 'inline', method: 'GET' } })
    const lives = Date.parse(preview.open.expiresAt) - Date.now()
    expect(lives).toBeGreaterThan(0)
    expect(lives).toBeLessThanOrEqual(61_000)
    expect((await ok('office.all', 'POST', openOf(w.a.salesOrderId, files.artwork), { mode: 'download' })).open).toMatchObject({ mode: 'download', method: 'GET' })
    const opened = async (fileId: string) => admin<{ recordType: string; recordId: string; actorId: string; after: Json }>(`SELECT "recordType", "recordId", "actorId", after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'sales.orderFileOpened' AND after->>'fileId' = $2`, [ids.tenantId, fileId])
    expect(await opened(files.shared)).toEqual([])
    await ok('office.all', 'POST', openOf(w.a.salesOrderId, files.measure), {})
    expect(await opened(files.measure)).toEqual([{ recordType: 'SalesOrder', recordId: w.a.salesOrderId, actorId: (SESSIONS['office.all'] as { readonly actorId: string }).actorId, after: expect.objectContaining({ fileId: files.measure, category: 'MEASUREMENTS' }) }])
    // A file of another order is not one of this order's.
    await notFound('office.all', 'POST', openOf(w.a.salesOrderId, files.copyOnOtherOrder), 'File not found.')
  })
})

describe('the brand wall: Beta’s person never reaches Alpha’s order files', { timeout: 60_000 }, () => {
  it('404 on Alpha’s order’s files and on opening any of them, in the words of an unknown id', async () => {
    await notFound('office.p2', 'GET', listOf(newId()), 'Sales order not found.')
    await notFound('office.p2', 'GET', listOf(w.a.salesOrderId), 'Sales order not found.')
    for (const fileId of Object.values(files)) await notFound('office.p2', 'POST', openOf(w.a.salesOrderId, fileId), 'Sales order not found.')
    // Alpha's file asked through Beta's own order: as unknown as a made-up id (the old copy on Beta's order included).
    await notFound('office.p2', 'POST', openOf(w.b.salesOrderId, newId()), 'File not found.')
    for (const fileId of [files.shared, files.onMixed, files.measure]) await notFound('office.p2', 'POST', openOf(w.b.salesOrderId, fileId), 'File not found.')
  })

  it('Beta’s own order lists Beta’s files; an old copy of Alpha’s sheet on it is judged by its whole content: counted, never listed or opened (W5)', async () => {
    const list = await ok('office.p2', 'GET', listOf(w.b.salesOrderId))
    expect(everyFile(list).length).toBeGreaterThan(0)
    expect(fileOfList(list, files.copyOnBeta)).toBeUndefined()
    expect(groupOf(list, 'ORDER').leftOut).toBeGreaterThanOrEqual(1)
    await notFound('office.p2', 'POST', openOf(w.b.salesOrderId, files.copyOnBeta), 'File not found.')
    // The production unit reads it on Beta's order, and its "also on" never names Alpha's order (another customer's record).
    const all = fileOfList(await ok('office.all', 'GET', listOf(w.b.salesOrderId)), files.copyOnBeta)!
    expect(all.alsoOn).toEqual([])
    expect(all.alsoOnOther).toBeGreaterThan(0)
  })

  it('no answer Beta’s person got names Alpha: not its names, numbers, files, work orders or ids', () => {
    expect(seenByB.length).toBeGreaterThan(5)
    const found = seenByB.flatMap((entry) => findMarkers(entry.body, aMarkers).map((marker) => `${entry.url} → ${marker}`))
    expect(found).toEqual([])
  })
})
