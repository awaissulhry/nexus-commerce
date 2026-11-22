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
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains' // B-OF-033
// The factory-db seeds and fixtures are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedMoney } from '../../../../../../packages/factory-db/seed/money' // B-OF-003: SH-0001's DDTs (143 annulled) and SO-0002's draft TD24
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
// B-OP-050: the small preview's key, as the strip job derives it.
import { smallKeyOf } from '../../../platform/files/thumbs/small'

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
  // B-OF-033: Alpha's person who sees prices too.
  'office.p1.prices': session(grant([...PERMISSIONS, grainPermission('price') as Permission], [ids.a])),
  // B-OF-001: Alpha's person who adds, deletes and shares files and keeps tasks (the doors the read's `may` names).
  'office.p1.acts': session(grant([...PERMISSIONS, 'files.upload', 'files.delete', 'files.manage', 'tasks.manage', 'threads.post'], [ids.a])),
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
    // B-PT-013: + TECH_PACK (the customer's tech pack, after the lines).
    expect((list.groups as Json[]).map((group) => group.key)).toEqual(['ORDER', 'LINES', 'TECH_PACK', 'REQUESTS', 'PRODUCTION', 'QUALITY', 'SHIPMENTS', 'RETURNS'])
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

// ── B-OP-050 (order page plan N7, R-14): the cards' previews in one call, and who added each file ──
describe('B-OP-050: POST …/files/previews — small pictures and PDF links in one walled call; who added each file', { timeout: 60_000 }, () => {
  const previewsOf = (orderId: string) => `/sales/orders/${orderId}/files/previews`
  const presigns = async (): Promise<number> => Number((await admin<{ n: string }>(`SELECT count(*) AS n FROM "IntegrationCall" WHERE operation = 'files.presign_download'`))[0]!.n)
  const presignsOfKey = async (key: string): Promise<number> => Number((await admin<{ n: string }>(`SELECT count(*) AS n FROM "IntegrationCall" WHERE operation = 'files.presign_download' AND "requestSummary"->>'key' = $1`, [key]))[0]!.n)
  const officePerson = newId()
  const worker = newId()
  let made = 0
  /** A made-up file of Alpha's order, as the office's runtime login writes it (the database's file rules apply). */
  async function cardFile(name: string, options: { readonly contentType?: string; readonly kind?: 'DOCUMENT' | 'PHOTO'; readonly sizeBytes?: number; readonly category?: 'MEASUREMENTS'; readonly visibility?: ('OFFICE' | 'FLOOR' | 'PARTNER')[]; readonly createdById?: string } = {}): Promise<{ id: string; storageKey: string }> {
    const id = newId()
    const at = new Date(Date.now() - 30 * 60_000 + ++made * 1000)
    const visibility = options.visibility ?? ['OFFICE']
    await database.withScope({ audience: 'office', tenantId: ids.tenantId, actorId: newId() }, (client) =>
      client.storedFile.create({
        data: seedFile(ids.tenantId, {
          id,
          companyId: companyA,
          recordType: 'SalesOrder',
          recordId: w.a.salesOrderId,
          kind: options.kind ?? 'DOCUMENT',
          ...(options.category ? { category: options.category } : {}),
          originalName: name,
          contentType: options.contentType ?? 'application/pdf',
          sizeBytes: options.sizeBytes ?? 2048,
          storeAccountId: seedUuid(ns, 'files:account:r2'),
          storageKey: `t/${ids.tenantId}/c/${companyA}/2026/${newId()}`,
          status: 'AVAILABLE',
          availableAt: at,
          visibility,
          ...(visibility.includes('FLOOR') ? { floorSiteId: seedUuid(ns, 'site:A1') } : {}),
          ...(visibility.includes('PARTNER') ? { partyId: ids.a } : {}),
          ...(options.createdById ? { createdById: options.createdById } : {}),
          createdAt: at,
          updatedAt: at,
        }),
        select: { id: true },
      }),
    )
    const [row] = await admin<{ storageKey: string }>('SELECT "storageKey" FROM "StoredFile" WHERE id = $1', [id])
    return { id, storageKey: row!.storageKey }
  }
  /** The strip job's result on a picture, as it records it (its small preview's key is derived from the stripped copy's). */
  async function withSmall(file: { readonly id: string; readonly storageKey: string }): Promise<string> {
    const thumbnailKey = file.storageKey.replace(/[0-9a-f-]{36}$/, newId())
    await admin(`UPDATE "StoredFile" SET "thumbnailKey" = $2, "exifStrippedAt" = now() WHERE id = $1`, [file.id, thumbnailKey])
    return smallKeyOf(thumbnailKey)
  }
  const audited = (fileId: string, audience: 'PARTNER' | 'FLOOR', actorId: string) =>
    admin(`INSERT INTO "AuditLog" (id, "tenantId", "companyId", "siteId", "partyId", audience, "actorId", action, "recordType", "recordId", "requestId") VALUES ($1, $2, $3, $4, $5, $6::"AuditAudience", $7, $8, 'StoredFile', $9, $10)`, [
      newId(),
      ids.tenantId,
      companyA,
      audience === 'FLOOR' ? seedUuid(ns, 'site:A1') : null,
      audience === 'PARTNER' ? ids.a : null,
      audience,
      actorId,
      audience === 'PARTNER' ? 'portal.attachFile' : 'production.floorPhoto',
      fileId,
      newId(),
    ])
  const cards = { picture: { id: '', storageKey: '' }, notYet: { id: '', storageKey: '' }, bigPdf: { id: '', storageKey: '' }, sheet: { id: '', storageKey: '' }, byPerson: { id: '', storageKey: '' }, byFloor: { id: '', storageKey: '' }, byCustomer: { id: '', storageKey: '' } }
  let smallKey = ''

  beforeAll(async () => {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, 'otto.files@seed-a.example', 'Otto Files', 'ACTIVE')`, [officePerson, ids.tenantId])
    cards.picture = await cardFile('T-OP050 sleeve photo.jpg', { kind: 'PHOTO', contentType: 'image/jpeg' })
    smallKey = await withSmall(cards.picture)
    cards.notYet = await cardFile('T-OP050 collar photo.jpg', { kind: 'PHOTO', contentType: 'image/jpeg' })
    cards.bigPdf = await cardFile('T-OP050 tech pack.pdf', { sizeBytes: 4 * 1024 * 1024 })
    cards.sheet = await cardFile('T-OP050 sizes.csv', { contentType: 'text/csv' })
    cards.byPerson = await cardFile('T-OP050 by Otto.pdf', { createdById: officePerson })
    cards.byFloor = await cardFile('T-OP050 floor photo.jpg', { kind: 'PHOTO', contentType: 'image/jpeg', visibility: ['OFFICE', 'FLOOR'] })
    await audited(cards.byFloor.id, 'FLOOR', worker)
    cards.byCustomer = await cardFile('T-OP050 from the customer.pdf', { visibility: ['OFFICE', 'PARTNER'] })
    await audited(cards.byCustomer.id, 'PARTNER', newId())
  })

  it('in the order asked: a picture\'s small preview (never the original), a PDF\'s inline link (≤ 3 MiB), body data LOCKED, the rest by kind; an id not in the read is absent', async () => {
    const before = await presigns()
    // op-fx3: the measurement sheet was opened by a test above (its own opening is recorded); this call adds no line of its own.
    const measureOpens = async () => (await admin(`SELECT id FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'sales.orderFileOpened' AND after->>'fileId' = $2`, [ids.tenantId, files.measure])).length
    const measureOpensBefore = await measureOpens()
    const asked = [cards.picture.id, cards.notYet.id, files.shared, cards.bigPdf.id, files.measure, cards.sheet.id, newId(), files.copyOnOtherOrder]
    const answer = await ok('office.all', 'POST', previewsOf(w.a.salesOrderId), { fileIds: asked })
    expect(answer.previews.map((row: Json) => [row.fileId, row.kind, row.small !== null, row.pdfDrawable, row.inline !== null, row.later])).toEqual([
      [cards.picture.id, 'PICTURE', true, false, false, false],
      // Not made yet (the strip job still to run): null, the card shows its kind.
      [cards.notYet.id, 'PICTURE', false, false, false, false],
      [files.shared, 'PDF', false, true, true, false],
      // Over 3 MiB: opened to be seen.
      [cards.bigPdf.id, 'PDF', false, false, false, false],
      // Body data: no address, nothing recorded (the click's own opening is).
      [files.measure, 'LOCKED', false, false, false, false],
      [cards.sheet.id, 'OTHER', false, false, false, false],
    ])
    expect(answer.previews[0]).toMatchObject({ versionNo: 1, small: { url: expect.any(String), expiresAt: expect.any(String) } })
    expect(Date.parse(answer.previews[2].inline.expiresAt) - Date.now()).toBeLessThanOrEqual(61_000)
    // Two presigns: the picture's SMALL key (never its original) and the PDF; none for the locked sheet or the large PDF.
    expect((await presigns()) - before).toBe(2)
    expect(await presignsOfKey(smallKey)).toBe(1)
    expect(await presignsOfKey(cards.picture.storageKey)).toBe(0)
    expect(await presignsOfKey(cards.bigPdf.storageKey)).toBe(0)
    expect(await measureOpens()).toBe(measureOpensBefore)
    // Never the generic preview route.
    expect(JSON.stringify(answer)).not.toMatch(/\/files\/[0-9a-f-]{36}\/preview/)
  })

  it('at most 24 ids, each once; at most 8 addresses a call — the rest say `later`, never a missing preview', async () => {
    const tooMany = await call('office.all', 'POST', previewsOf(w.a.salesOrderId), { fileIds: Array.from({ length: 25 }, () => newId()) })
    expect(tooMany.status).toBe(400)
    const twice = await call('office.all', 'POST', previewsOf(w.a.salesOrderId), { fileIds: [files.shared, files.shared] })
    expect([twice.status, twice.body.error?.message]).toEqual([400, 'Each file once: the same file was asked twice.'])
    const pictures: string[] = []
    for (let index = 0; index < 10; index += 1) {
      const picture = await cardFile(`T-OP050 batch ${index}.jpg`, { kind: 'PHOTO', contentType: 'image/jpeg' })
      await withSmall(picture)
      pictures.push(picture.id)
    }
    const before = await presigns()
    const answer = await ok('office.all', 'POST', previewsOf(w.a.salesOrderId), { fileIds: pictures })
    expect((await presigns()) - before).toBe(8)
    expect(answer.previews.map((row: Json) => [row.small !== null, row.later])).toEqual([...Array.from({ length: 8 }, () => [true, false]), [false, true], [false, true]])
    // Asked again, the two left come.
    const rest = await ok('office.all', 'POST', previewsOf(w.a.salesOrderId), { fileIds: pictures.slice(8) })
    expect(rest.previews.map((row: Json) => [row.small !== null, row.later])).toEqual([
      [true, false],
      [true, false],
    ])
  })

  it('the files read names who added each file: an office person, "the floor" (never the worker), this order\'s customer; the system\'s own none', async () => {
    const list = await ok('office.all', 'GET', listOf(w.a.salesOrderId))
    const customer = (await admin<{ name: string }>('SELECT coalesce("tradeName", "legalName") AS name FROM "Party" WHERE id = $1', [ids.a]))[0]!.name
    expect(fileOfList(list, cards.byPerson.id)?.addedBy).toEqual({ kind: 'PERSON', name: 'Otto Files' })
    expect(fileOfList(list, cards.byFloor.id)?.addedBy).toEqual({ kind: 'FLOOR', name: null })
    expect(fileOfList(list, cards.byCustomer.id)?.addedBy).toEqual({ kind: 'CUSTOMER', name: customer })
    expect(fileOfList(list, cards.sheet.id)?.addedBy).toBeNull()
    expect(JSON.stringify(list)).not.toContain(worker)
  })

  it('the wall: Beta\'s person gets the words of an unknown order; Alpha\'s ids through Beta\'s own order are absent; a reader without the measurements right never sees body data', async () => {
    const unknown = await call('office.p2', 'POST', previewsOf(newId()), { fileIds: [files.shared] })
    const walled = await call('office.p2', 'POST', previewsOf(w.a.salesOrderId), { fileIds: [files.shared, cards.picture.id] })
    expect([walled.status, walled.body.error?.message]).toEqual([404, 'Sales order not found.'])
    expect([walled.status, walled.body.error?.message]).toEqual([unknown.status, unknown.body.error?.message])
    const through = await ok('office.p2', 'POST', previewsOf(w.b.salesOrderId), { fileIds: [files.shared, cards.picture.id, files.copyOnBeta] })
    expect(through.previews).toEqual([])
    // Alpha's own person without workorders.view and the measurements right: the mixed work order's file and the sheet are absent.
    const thin = await ok('office.p1.thin', 'POST', previewsOf(w.a.salesOrderId), { fileIds: [files.measure, files.onMixed, files.onWorkOrder, files.shared] })
    expect(thin.previews.map((row: Json) => row.fileId)).toEqual([files.shared])
  })

  // B-OF-006 (order files tab, PR S3.2; F7-B4): a picture whose type never gets a small preview says so: the card stops asking.
  it('B-OF-006: a HEIC picture reads never: true; a JPEG whose small preview is not made yet never: false', async () => {
    const heic = await cardFile('T-OF006 sleeve.heic', { kind: 'PHOTO', contentType: 'image/jpeg' })
    await admin(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE "StoredFile" SET "contentType" = 'image/heic' WHERE id = ${lit(heic.id)}; COMMIT;`)
    const answer = await ok('office.all', 'POST', previewsOf(w.a.salesOrderId), { fileIds: [heic.id, cards.notYet.id] })
    expect(answer.previews.map((row: Json) => [row.fileId, row.kind, row.small, row.later, row.never])).toEqual([
      [heic.id, 'PICTURE', null, false, true],
      [cards.notYet.id, 'PICTURE', null, false, false],
    ])
  })
})
// ── end B-OP-050 ──

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

// ── B-PT-013 (order production tab R13) ──
/**
 * The customer's tech pack in the order's files: the TECH_PACK group lists the files of the inquiry the order came from (the
 * inquiries' own finder), each at its version in force, marked {named, inForce, newer}; opened through the order's own route. Without
 * sales.inquiries.view the files are counted, never named; a priced pack file is counted for a reader without the price grain; a file
 * whose record cannot be placed (unknown scope) is counted only; an inquiry of another customer linked to an order by mistake gives no
 * group. The inquiries and files are made up (the admin pool writes the inquiry rows and the second version of a series, its rules
 * off for that; the files are written as the office writes them).
 */
describe('B-PT-013: the customer’s tech pack in the order’s files, at its version in force, fail closed', { timeout: 60_000 }, () => {
  const inquiry = { id: newId(), number: 'T-PT013-INQ-1' }
  const wrong = { inquiry: newId(), order: newId(), file: '' }
  const pack = { v1: '', v2: '', chart: '', priced: '', ghost: '' }

  beforeAll(async () => {
    SESSIONS['pt.inquiries'] = session(grant([...PERMISSIONS, 'sales.inquiries.view'], 'all'))
    SESSIONS['pt.price'] = session(grant([...PERMISSIONS, 'sales.inquiries.view', 'money.price'], 'all'))
    const t = lit(ids.tenantId)
    // Alpha's inquiry of this order (by its quote when the order has one, and by the order itself: the finder takes either).
    await admin(
      `BEGIN;
       SET LOCAL session_replication_role = replica;
       INSERT INTO "Inquiry" (id, "tenantId", "companyId", number, source, "receivedAt", "partyId", request, "salesOrderId", "quoteId")
         SELECT ${lit(inquiry.id)}, ${t}, o."companyId", '${inquiry.number}', 'OFFICE', now(), o."partyId", 'Made-up: a jacket like the sample', o.id, (SELECT v."quoteId" FROM "QuoteVersion" v WHERE v.id = o."quoteVersionId")
         FROM "SalesOrder" o WHERE o.id = ${lit(w.a.salesOrderId)};
       COMMIT;`,
    )
    pack.v1 = await fileOn('Inquiry', inquiry.id, 'T-PT013 tech pack.pdf')
    pack.v2 = newId()
    await admin(
      `BEGIN;
       SET LOCAL session_replication_role = replica;
       INSERT INTO "StoredFile" SELECT (jsonb_populate_record(NULL::"StoredFile", to_jsonb(f) || jsonb_build_object('id', ${lit(pack.v2)}, 'seriesId', f.id, 'versionNo', 2, 'originalName', 'T-PT013 tech pack v2.pdf', 'storageKey', 't/${ids.tenantId}/c/${companyA}/2026/${newId()}'))).* FROM "StoredFile" f WHERE f.id = ${lit(pack.v1)};
       COMMIT;`,
    )
    pack.chart = await fileOn('Inquiry', inquiry.id, 'T-PT013 size chart.pdf')
    pack.priced = await fileOn('Inquiry', inquiry.id, 'T-PT013 target costing.pdf')
    pack.ghost = newId()
    await admin(
      `BEGIN;
       SET LOCAL session_replication_role = replica;
       UPDATE "StoredFile" SET priced = true WHERE id = ${lit(pack.priced)};
       INSERT INTO "StoredFile" SELECT (jsonb_populate_record(NULL::"StoredFile", to_jsonb(f) || jsonb_build_object('id', ${lit(pack.ghost)}, 'recordId', ${lit(newId())}, 'originalName', 'T-PT013 unplaced.pdf', 'storageKey', 't/${ids.tenantId}/c/${companyA}/2026/${newId()}'))).* FROM "StoredFile" f WHERE f.id = ${lit(pack.chart)};
       UPDATE "Inquiry" SET "techPackFileIds" = ARRAY[${[pack.v1, pack.chart, pack.priced, pack.ghost].map(lit).join(', ')}]::uuid[], "techPackVersion" = 'v1' WHERE id = ${lit(inquiry.id)};
       COMMIT;`,
    )
    // A fresh order of Alpha with no quote, and an inquiry of BETA naming it by mistake (made before any rule: the admin pool).
    const [owner] = await admin<{ companyId: string }>(`SELECT "companyId" FROM "SalesOrder" WHERE id = $1`, [w.a.salesOrderId])
    await database.withScope({ audience: 'office', tenantId: ids.tenantId, actorId: seedUuid(ns, 'actor') }, (client) =>
      client.salesOrder.create({
        data: { id: wrong.order, companyId: owner!.companyId, partyId: ids.a, number: 'T-PT013-SO-W', customerRef: 'T-PT013-PO-W', status: 'CONFIRMED', orderDate: new Date('2026-11-03T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' } },
        select: { id: true },
      }),
    )
    await admin(
      `BEGIN;
       SET LOCAL session_replication_role = replica;
       INSERT INTO "Inquiry" (id, "tenantId", "companyId", number, source, "receivedAt", "partyId", request, "salesOrderId")
         VALUES (${lit(wrong.inquiry)}, ${t}, ${lit(owner!.companyId)}, 'T-PT013-INQ-B', 'OFFICE', now(), ${lit(ids.b)}, 'Made-up: Beta asks', ${lit(wrong.order)});
       COMMIT;`,
    )
    wrong.file = await fileOn('Inquiry', wrong.inquiry, 'T-PT013 Beta pack.pdf')
    await admin(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE "Inquiry" SET "techPackFileIds" = ARRAY[${lit(wrong.file)}]::uuid[] WHERE id = ${lit(wrong.inquiry)}; COMMIT;`)
  })

  it('the pack at its version in force (v2 of the tech pack, "newer than the request"), from the inquiry; the named v1 never listed', async () => {
    const group = groupOf(await ok('pt.inquiries', 'GET', listOf(w.a.salesOrderId)), 'TECH_PACK')
    expect(group.words).toEqual({ it: 'Scheda tecnica del cliente', en: "Customer's tech pack" })
    const byId = new Map((group.files as Json[]).map((file) => [file.id as string, file]))
    expect([...byId.keys()].sort()).toEqual([pack.v2, pack.chart].sort())
    expect(byId.get(pack.v2)).toMatchObject({ name: 'T-PT013 tech pack v2.pdf', versionNo: 2, from: { type: 'Inquiry', id: inquiry.id, label: inquiry.number }, techPack: { named: 1, inForce: true, newer: true } })
    expect(byId.get(pack.chart)).toMatchObject({ techPack: { named: 1, inForce: true, newer: false } })
    // A priced file for a reader without the price grain, and a file whose record cannot be placed: counted, never named.
    expect({ pricedLeftOut: group.pricedLeftOut, leftOut: group.leftOut }).toEqual({ pricedLeftOut: 1, leftOut: 1 })
    // Every other file of the order says it is no tech pack file.
    for (const file of everyFile(await ok('pt.inquiries', 'GET', listOf(w.a.salesOrderId)))) if (!byId.has(file.id)) expect(file.techPack, file.id).toBeNull()
  })

  it('a reader who sees prices gets the priced pack file too; the unplaced one stays counted', async () => {
    const group = groupOf(await ok('pt.price', 'GET', listOf(w.a.salesOrderId)), 'TECH_PACK')
    expect((group.files as Json[]).map((file) => file.id).sort()).toEqual([pack.v2, pack.chart, pack.priced].sort())
    expect({ pricedLeftOut: group.pricedLeftOut, leftOut: group.leftOut }).toEqual({ pricedLeftOut: 0, leftOut: 1 })
  })

  it('without sales.inquiries.view: every pack file counted, never named', async () => {
    const answer = await call('office.all', 'GET', listOf(w.a.salesOrderId))
    const group = groupOf(answer.body, 'TECH_PACK')
    expect(group).toMatchObject({ files: [], leftOut: 4 })
    for (const name of ['T-PT013 tech pack', 'T-PT013 size chart', 'T-PT013 target costing', inquiry.number]) expect(answer.raw).not.toContain(name)
  })

  it('opens through the order’s own route (the one viewer); the named, superseded v1 and the unplaced file do not open', async () => {
    const opened = await ok('pt.inquiries', 'POST', openOf(w.a.salesOrderId, pack.v2), { mode: 'preview' })
    expect(opened.file).toMatchObject({ id: pack.v2, name: 'T-PT013 tech pack v2.pdf' })
    for (const fileId of [pack.v1, pack.ghost, pack.priced]) await notFound('pt.inquiries', 'POST', openOf(w.a.salesOrderId, fileId), 'File not found.')
    await notFound('office.all', 'POST', openOf(w.a.salesOrderId, pack.v2), 'File not found.')
  })

  it('fail closed: an inquiry of another customer linked to Alpha’s order by mistake gives no group; Beta’s person never reaches Alpha’s pack', async () => {
    const answer = await call('pt.inquiries', 'GET', listOf(wrong.order))
    expect(answer.status).toBe(200)
    expect(groupOf(answer.body, 'TECH_PACK')).toMatchObject({ files: [], leftOut: 0, pricedLeftOut: 0 })
    expect(answer.raw).not.toContain('T-PT013 Beta pack')
    await notFound('pt.inquiries', 'POST', openOf(wrong.order, wrong.file), 'File not found.')
    await notFound('office.p2', 'GET', listOf(w.a.salesOrderId), 'Sales order not found.')
    await notFound('office.p2', 'POST', openOf(w.a.salesOrderId, pack.v2), 'Sales order not found.')
  })
})
// ── end B-PT-013 ──

// ---- B-OF-033 (order files tab, PR S2.3; 13-backend §2): the asks for files ride on the order's files read ----------------------
describe('B-OF-033: the order’s asks for files in its files read — counted, never named, where the reader may not read them', { timeout: 60_000 }, () => {
  const ask = { priced: '', floor: '' }
  const owner = () => seedUuid(ns, 'actor')
  const office = () => ({ audience: 'office' as const, tenantId: ids.tenantId, actorId: owner() })

  beforeAll(async () => {
    const [floorRole] = await admin<{ id: string; name: string }>(`SELECT id, name FROM "Role" WHERE "tenantId" = $1 AND audience = 'FLOOR' AND "archivedAt" IS NULL ORDER BY key LIMIT 1`, [ids.tenantId])
    ask.priced = newId()
    ask.floor = newId()
    // Written as the asks' commands write them (modules/sales/file-asks), in the office scope: the guard is real.
    await database.withScope(office(), (client) =>
      client.fileAsk.createMany({
        data: [
          { id: ask.priced, companyId: companyA, partyId: ids.a, salesOrderId: w.a.salesOrderId, target: 'SALES_ORDER', words: 'T-OF033 the proforma at 41.50 a jacket', fileKind: 'DOCUMENT', priced: true, addressee: 'PERSON', addresseeUserId: owner(), dueOn: new Date('2026-11-20T00:00:00.000Z'), askedById: owner() },
          { id: ask.floor, companyId: companyA, partyId: ids.a, siteId: w.siteId, salesOrderId: w.a.salesOrderId, target: 'WORK_ORDER', workOrderId: w.a.workOrderId, words: 'T-OF033 photos of the cut panels', fileKind: 'PHOTO', addressee: 'FLOOR_ROLE', addresseeRoleId: floorRole!.id, dueOn: new Date('2026-12-20T00:00:00.000Z'), askedById: owner() },
        ],
      }),
    )
    // The floor's photo answers the floor ask (as B-OF-034 writes it: no one named).
    await database.withScope(office(), (client) => client.fileAsk.update({ where: { id: ask.floor }, data: { status: 'ARRIVED', fileIds: [files.onWorkOrder], answeredAt: new Date(), answeredById: null, version: 2 }, select: { id: true } }))
  })

  it('a reader without prices reads a priced ask counted, its words null; one who sees prices reads them', async () => {
    const thin = (await ok('office.p1', 'GET', listOf(w.a.salesOrderId))).asks as Json[]
    const priced = thin.find((row) => row.id === ask.priced)!
    expect(priced).toMatchObject({ status: 'OPEN', words: null, priced: true, lastReason: null, lands: { type: 'SalesOrder', id: w.a.salesOrderId }, who: { kind: 'PERSON' }, forMe: false })
    expect(priced.lateDays).toBeGreaterThan(0)
    expect(priced.may).toEqual({ answer: false, decide: false, change: false })
    expect(JSON.stringify(thin)).not.toContain('41.50')
    const seen = (await ok('office.p1.prices', 'GET', listOf(w.a.salesOrderId))).asks as Json[]
    expect(seen.find((row) => row.id === ask.priced)?.words).toBe('T-OF033 the proforma at 41.50 a jacket')
  })

  it('a floor answer reads "by the floor" (never a worker), arrived first; the file says which ask it answered', async () => {
    const list = await ok('office.p1', 'GET', listOf(w.a.salesOrderId))
    const asks = list.asks as Json[]
    expect(asks[0]!.id).toBe(ask.floor)
    expect(asks[0]).toMatchObject({ status: 'ARRIVED', lateDays: 0, lands: { type: 'WorkOrder', id: w.a.workOrderId, label: w.a.workOrderNumber, step: null }, who: { kind: 'FLOOR_ROLE' }, answered: { by: { kind: 'FLOOR' }, fileIds: [files.onWorkOrder], held: 0 } })
    expect(asks[0]!.answered.by).toEqual({ kind: 'FLOOR' })
    expect(fileOfList(list, files.onWorkOrder)?.askId).toBe(ask.floor)
    expect(fileOfList(list, files.office)?.askId).toBeNull()
    expect(list.asksLeftOut).toBe(0)
    expect(list.customerAsks).toEqual([])
  })

  it('an ask on a work order the reader does not reach is counted, never listed', async () => {
    const list = await ok('office.p1.thin', 'GET', listOf(w.a.salesOrderId))
    expect((list.asks as Json[]).map((row) => row.id)).not.toContain(ask.floor)
    expect(list.asksLeftOut).toBe(1)
  })
})
// ---- end B-OF-033

// ---- B-OF-001 / B-OF-002 / B-OF-003 (order files tab, PR S3.1; 13-backend §3): each file's facts, held files, papers ------------
describe('B-OF-001…003: versions, what keeps a file, papers Nexus made, the true audiences, held files, an annulled DDT, a credit note', { timeout: 120_000 }, () => {
  const made = { v1: '', v2: '', confirmation: '', foreignCopy: '', ownHeld: '', otherHeld: '', ddtPaper: '', creditPaper: '', shipment: '', ddt: '' }
  const plant = async (sql: string, values: unknown[] = []) => {
    await admin('BEGIN')
    try {
      await admin("SET LOCAL session_replication_role = 'replica'")
      await admin(sql, values)
      await admin('COMMIT')
    } catch (error) {
      await admin('ROLLBACK')
      throw error
    }
  }
  /** A copy of row `id` of "StoredFile" with `changes`, planted (the owner, triggers off). */
  const plantFile = (sourceId: string, changes: Json) =>
    plant(`INSERT INTO "StoredFile" SELECT * FROM jsonb_populate_record(NULL::"StoredFile", (SELECT to_jsonb(f) || $1::jsonb FROM "StoredFile" f WHERE f.id = $2::uuid))`, [JSON.stringify({ storageKey: `t/${ids.tenantId}/c/${companyA}/2026/${newId()}`, ...changes }), sourceId])

  beforeAll(async () => {
    // Versions: v1 then v2 of one series, v1 superseded; v2 on legal hold.
    made.v1 = await fileOn('SalesOrder', w.a.salesOrderId, 'T-OF001 cutting plan.pdf')
    made.v2 = newId()
    await plantFile(made.v1, { id: made.v2, seriesId: made.v1, versionNo: 2, legalHold: true })
    await plant(`UPDATE "StoredFile" SET "supersededAt" = now() WHERE id = $1::uuid`, [made.v1])
    // A confirmation PDF Nexus made (an ORDER_CONFIRMATION generated document): never deleted, born priced by its kind.
    made.confirmation = await fileOn('SalesOrder', w.a.salesOrderId, 'T-OF001 order confirmation.pdf')
    await plant(`INSERT INTO "GeneratedDocument" (id, "tenantId", "companyId", "recordType", "recordId", kind, version, fingerprint, language, "fileId") VALUES ($1, $2, $3, 'SalesOrder', $4, 'ORDER_CONFIRMATION', 1, 'made-up', 'it', $5)`, [newId(), ids.tenantId, companyA, w.a.salesOrderId, made.confirmation])
    // A copy on Alpha's order of Beta's file, shared with Alpha: its content is another customer's — never "Customer".
    made.foreignCopy = newId()
    await plantFile(files.office, { id: made.foreignCopy, sourceFileId: w.second.fileId, visibility: ['OFFICE', 'PARTNER'], partyId: ids.a, originalName: 'T-OF001 old copy.pdf' })
    // Held by the virus scan: one the reader uploaded, one someone else did.
    made.ownHeld = await fileOn('SalesOrder', w.a.salesOrderId, 'T-OF002 my scan.pdf')
    made.otherHeld = await fileOn('SalesOrderLine', w.a.salesOrderLineId, 'T-OF002 their scan.pdf')
    const reader = (SESSIONS['office.p1'] as { readonly actorId: string }).actorId
    await plant(`UPDATE "StoredFile" SET status = 'QUARANTINED', "quarantineReason" = 'scan_pending', "scanStatus" = 'PENDING', "availableAt" = NULL, "createdById" = $2::uuid WHERE id = $1::uuid`, [made.ownHeld, reader])
    await plant(`UPDATE "StoredFile" SET status = 'QUARANTINED', "quarantineReason" = 'scan_pending', "scanStatus" = 'INFECTED', "availableAt" = NULL, "createdById" = $2::uuid WHERE id = $1::uuid`, [made.otherHeld, newId()])
    // SEED-SO-0002's SH-0001 with DDT 143/2026 cancelled (the shipping seed) and the draft TD24 (the money seed): a paper of the
    // annulled DDT, and a credit note of the TD24 with a paper of its own.
    await seedMoney({ db: database, namespace: ns })
    const [ddt] = await admin<{ id: string; shipmentId: string }>(`SELECT d.id, d."shipmentId" FROM "Ddt" d WHERE d."tenantId" = $1 AND EXISTS (SELECT 1 FROM "DdtCancellation" c WHERE c."ddtId" = d.id) ORDER BY d.id LIMIT 1`, [ids.tenantId])
    made.ddt = ddt!.id
    made.shipment = ddt!.shipmentId
    made.ddtPaper = await fileOn('Ddt', made.ddt, 'T-OF003 DDT 143.pdf')
    const [draft] = await admin<{ id: string }>(`SELECT id FROM "Invoice" WHERE "tenantId" = $1 AND "salesOrderId" = $2 AND "docType" = 'TD24' ORDER BY id LIMIT 1`, [ids.tenantId, otherOrder.id])
    const credit = newId()
    await plant(`INSERT INTO "Invoice" SELECT * FROM jsonb_populate_record(NULL::"Invoice", (SELECT to_jsonb(i) || $1::jsonb FROM "Invoice" i WHERE i.id = $2::uuid))`, [JSON.stringify({ id: credit, docType: 'TD04', creditOfId: draft!.id, salesOrderId: null, shipmentId: null, number: null, xmlFileId: null, pdfFileId: null }), draft!.id])
    made.creditPaper = await fileOn('Invoice', credit, 'T-OF003 credit note.pdf')
  })

  it('each file: its version, its series and how many versions it keeps, what keeps it, fiscal, priced', async () => {
    const list = await ok('office.p1', 'GET', listOf(w.a.salesOrderId))
    expect(fileOfList(list, made.v1)).toBeUndefined()
    expect(fileOfList(list, made.v2)).toMatchObject({ version: 1, seriesId: made.v1, versions: 2, kept: { legalHold: true, retainUntil: null }, fiscal: false, priced: false, made: null, bornPriced: false })
    expect(fileOfList(list, files.office)).toMatchObject({ seriesId: null, versions: 1, audiences: [] })
  })

  it('a confirmation Nexus made reads made: GENERATED and bornPriced; the true audiences: a share with this customer, an old foreign copy', async () => {
    const list = await ok('office.p1', 'GET', listOf(w.a.salesOrderId))
    expect(fileOfList(list, made.confirmation)).toMatchObject({ made: 'GENERATED', bornPriced: true })
    expect(fileOfList(list, files.shared)?.audiences).toEqual(['CUSTOMER'])
    const all = await ok('office.all', 'GET', listOf(w.a.salesOrderId))
    expect(fileOfList(all, made.foreignCopy)).toMatchObject({ audience: 'CUSTOMER_CAN_SEE', audiences: [] })
  })

  it('held files: counted per group; the reader’s OWN as a card, another’s only counted', async () => {
    const list = await ok('office.p1', 'GET', listOf(w.a.salesOrderId))
    expect(groupOf(list, 'ORDER').heldCount).toBeGreaterThanOrEqual(1)
    expect(groupOf(list, 'LINES').heldCount).toBeGreaterThanOrEqual(1)
    expect(list.held).toEqual([{ id: made.ownHeld, name: 'T-OF002 my scan.pdf', group: 'ORDER', at: expect.any(String), reason: 'SCAN_PENDING' }])
    expect(fileOfList(list, made.ownHeld)).toBeUndefined()
    expect(JSON.stringify(list)).not.toContain('T-OF002 their scan.pdf')
  })

  it('papers: an annulled DDT’s paper says so and names its shipment; a credit note of the order’s invoice is listed', async () => {
    const list = await ok('office.all', 'GET', listOf(otherOrder.id))
    const ddtPaper = fileOfList(list, made.ddtPaper)!
    expect(ddtPaper.from).toMatchObject({ type: 'Ddt', id: made.ddt, state: 'ANNULLED', shipment: { id: made.shipment, label: expect.any(String) } })
    // of-fx5s (W-12): the shipment's day shipped (Rome) and its LIVE DDT's own number — never the annulled one this paper is of.
    const [facts] = await admin<{ shippedOn: string | null; live: string | null; annulled: string }>(
      `SELECT to_char((s."shippedAt" AT TIME ZONE 'Europe/Rome')::date, 'YYYY-MM-DD') AS "shippedOn",
              (SELECT d.number FROM "Ddt" d WHERE d."shipmentId" = s.id AND NOT EXISTS (SELECT 1 FROM "DdtCancellation" c WHERE c."ddtId" = d.id) ORDER BY d."documentDate" DESC, d.number DESC LIMIT 1) AS live,
              (SELECT number FROM "Ddt" WHERE id = $2::uuid) AS annulled
         FROM "Shipment" s WHERE s.id = $1::uuid`,
      [made.shipment, made.ddt],
    )
    expect(facts!.shippedOn, 'SH-0001 left (the shipping seed)').not.toBeNull()
    expect(facts!.live, 'DDT 144 replaced the annulled 143 (the shipping seed)').not.toBeNull()
    expect(ddtPaper.from.shipment).toEqual({ id: made.shipment, label: expect.any(String), shippedOn: facts!.shippedOn, ddtNumber: facts!.live })
    expect(ddtPaper.from.shipment.ddtNumber).not.toBe(facts!.annulled)
    expect(groupOf(list, 'SHIPMENTS').files.map((file: Json) => file.id)).toContain(made.creditPaper)
    expect(fileOfList(list, made.creditPaper)?.from).toMatchObject({ type: 'Invoice', state: null, shipment: null })
  })

  it('may: the doors over THIS order’s scope by the reader’s rights', async () => {
    expect((await ok('office.p1', 'GET', listOf(w.a.salesOrderId))).may).toEqual({ upload: false, delete: false, share: false, ask: false, askCustomer: false })
    expect((await ok('office.p1.acts', 'GET', listOf(w.a.salesOrderId))).may).toEqual({ upload: true, delete: true, share: true, ask: true, askCustomer: false })
  })
})
// ---- end B-OF-001 / B-OF-002 / B-OF-003
