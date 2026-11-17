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
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from '../testing/two-brands'

/**
 * B-PR-44 — the order files of a work order, PW-16 (production plan L16, Owner point N1: "every order already has all its
 * details in the PDF files or in the thread"; the Owner rule 2026-11-16: "One brand must not be able to see anything related to
 * any other brand. But we, as the production unit, should be able to see it all. And manage it all as well.").
 *
 * On the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login), the
 * gateway on the local Redis and the FAKE file store in a temporary folder (the 60-second links are real presigned GETs), the
 * core, auth, roles, files, production and numbering seeds (brand A = the seeds' P1) and the production two-brand harness (each
 * brand's DRAFT work order of its own order line, B's on the threads' SEED-SO-B001 with its file and thread, and a mixed work
 * order made before the one-customer rule). The test's admin pool adds, per brand, made-up files on the order and on its line
 * (the line's artwork, a measurement sheet), A's line made from one of A's quote lines with artwork of its own, and a
 * made-to-measure profile revision per brand with its worksheet versions on the work order's cells. Sessions: `office.all`
 * (every customer), `office.p1` / `office.p2` (one customer each), and B's people with less (no measurements right, no files
 * right, files of one company only), and one of every customer's work orders who reads only B's files.
 *
 *   - GET /production/work-orders/:id/order-files: one group per order, its files, its lines' (and quote line's) artwork, the
 *     newest worksheet with the measurements right only (else counted), the order's thread ref.
 *   - POST …/order-files/:fileId/open: the 60-second preview or download through its own wall; body data recorded.
 *   - PW-16: B's person gets 404 on A's order files and on opening A's file (the words of an unknown id); the worksheet only with
 *     the measurements right; a mixed work order shows each group only to people who read that customer's files.
 *
 * Every answer B's people got is scanned for A's names, codes, numbers, file names and ids. Every name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/production/order-files`.
 */

const ns = 'pr2b-order-files'
const ids = twoBrandIds(ns)
const companyA = seedUuid(ns, 'company:A')
const companyB = seedUuid(ns, 'company:B')
const PERMISSIONS: Permission[] = [
  'workorders.view',
  // The harness makes each brand's draft through the real route.
  'workorders.manage',
  'files.read',
  'threads.read',
  'sales.measurements.view',
]
const grant = (permissions: Permission[], parties: Grant['parties'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties })
const session = (...grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: ids.tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  ...twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS),
  // B's person without the measurements right and without threads.
  'office.p2.thin': session(grant(['workorders.view', 'files.read'], [ids.b])),
  // B's person with work orders but no files right.
  'office.p2.blind': session(grant(['workorders.view'], [ids.b])),
  // B's person who reads files of company A only.
  'office.p2.companyA': session(grant(['workorders.view', 'files.read', 'threads.read', 'sales.measurements.view'], [ids.b], [companyA])),
  // Every customer's work orders (so the mixed one), but only B's files, threads and measurements.
  'office.all.p2files': session(grant(['workorders.view'], 'all'), grant(['files.read', 'threads.read', 'sales.measurements.view'], [ids.b])),
}
const B_SESSIONS = new Set(['office.p2', 'office.p2.thin', 'office.p2.blind', 'office.p2.companyA', 'office.all.p2files'])

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let aMarkers: Marker[]
let redis: TestRedis | undefined
let localRoot = ''
const files = {
  a: { order: '', artwork: '', measure: '', quote: '' },
  b: { order: '', artwork: '', measure: '', otherCompany: '' },
}
const mtm = { a: { profile: newId(), v1: newId() }, b: { profile: newId(), v1: newId(), v2: newId() } }

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
  expect(answer.status, `${method} ${url}: ${answer.raw}`).toBe(200)
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
const listOf = (workOrderId: string) => `/production/work-orders/${workOrderId}/order-files`
const openOf = (workOrderId: string, fileId: string) => `/production/work-orders/${workOrderId}/order-files/${fileId}/open`
const groupOf = (list: Json, orderId: string): Json => (list.groups as Json[]).find((group) => group.order.id === orderId) ?? {}
const names = (group: Json): string[] => (group.files as Json[]).map((file) => file.name).sort()

/** A made-up file of a record, written as the office's runtime login writes rows (the database's file rules apply). */
let minute = 0
async function fileOn(recordType: string, recordId: string, originalName: string, extra: { readonly category?: 'ARTWORK' | 'MEASUREMENTS'; readonly companyId?: string } = {}): Promise<string> {
  const id = newId()
  const companyId = extra.companyId ?? companyA
  const at = new Date(Date.now() - 60 * 60_000 + ++minute * 60_000)
  await database.withScope({ audience: 'office', tenantId: ids.tenantId, actorId: newId() }, (client) =>
    client.storedFile.create({
      data: seedFile(ids.tenantId, {
        id,
        companyId,
        recordType,
        recordId,
        kind: 'DOCUMENT',
        ...(extra.category ? { category: extra.category } : {}),
        originalName,
        contentType: 'application/pdf',
        sizeBytes: 2048,
        storeAccountId: seedUuid(ns, 'files:account:r2'),
        storageKey: `t/${ids.tenantId}/c/${companyId}/2026/${newId()}`,
        status: 'AVAILABLE',
        availableAt: at,
        visibility: ['OFFICE'],
        createdAt: at,
        updatedAt: at,
      }),
      select: { id: true },
    }),
  )
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('pr2b_order_files')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const seed of [seedCore, seedAuth, seedRoles, seedFiles]) await seed({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  // The seeded file store's bursts are production settings.
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [ids.tenantId])
  // Files as the app uses them: the gateway on the local Redis (this run's own prefix), the FAKE store in a temporary folder.
  redis = testRedis()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-pr2b-order-files-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: redis.connect(), prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(w.a.partyId).toBe(ids.a)

  // A's line made from one of A's quote lines (one no order line names yet, when there is one), whose artwork travels with it.
  const [quoteLine] = await admin<{ id: string }>(
    `SELECT q.id FROM "QuoteLine" q WHERE q."tenantId" = $1 AND q."partyId" = $2 ORDER BY EXISTS (SELECT 1 FROM "SalesOrderLine" l WHERE l."quoteLineId" = q.id), q.seq, q.id LIMIT 1`,
    [ids.tenantId, ids.a],
  )
  expect(quoteLine, "a quote line of A's (the sales seed's)").toBeDefined()
  // A made-to-measure profile revision per brand with its worksheet PDFs (B: two versions), on the work orders' cells.
  const sheetA = await fileOn('MeasurementProfile', mtm.a.profile, 'T-PR2B-A rider worksheet v1.pdf')
  const sheetB1 = await fileOn('MeasurementProfile', mtm.b.profile, 'T-PR2B-B rider worksheet v1.pdf')
  const sheetB2 = await fileOn('MeasurementProfile', mtm.b.profile, 'T-PR2B-B rider worksheet v2.pdf')
  const profile = (id: string, partyId: string, rider: string) =>
    `INSERT INTO "MeasurementProfile" (id, "tenantId", "partyId", "riderName", "garmentType", revision, measurements, "takenAt", "takenBy", "privacyNoticeRef", "privacyNoticeAt")
     VALUES (${lit(id)}, ${lit(ids.tenantId)}, ${lit(partyId)}, '${rider}', 'JACKET', 1, '{"chest": {"value": "100.0", "unit": "cm"}}'::jsonb, now(), 'T-PR2B fitter', 'T-PR2B notice', now());`
  const sheet = (id: string, profileId: string, version: number, fileId: string, number: string) =>
    `INSERT INTO "GeneratedDocument" (id, "tenantId", "companyId", "recordType", "recordId", kind, version, fingerprint, language, number, "fileId")
     VALUES (${lit(id)}, ${lit(ids.tenantId)}, ${lit(companyA)}, 'MeasurementProfile', ${lit(profileId)}, 'MTM_WORKSHEET', ${version}, 'pr2b-${version}', 'it', '${number}', ${lit(fileId)});`
  await admin(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     ${profile(mtm.a.profile, ids.a, 'T-PR2B rider of A')}
     ${profile(mtm.b.profile, ids.b, 'T-PR2B rider of B')}
     ${sheet(mtm.a.v1, mtm.a.profile, 1, sheetA, 'T-PR2B-MTM-A-1')}
     ${sheet(mtm.b.v1, mtm.b.profile, 1, sheetB1, 'T-PR2B-MTM-B-1')}
     ${sheet(mtm.b.v2, mtm.b.profile, 2, sheetB2, 'T-PR2B-MTM-B-2')}
     UPDATE "WorkOrderSize" SET "measurementProfileId" = ${lit(mtm.a.profile)} WHERE "workOrderId" = ${lit(w.a.workOrderId)};
     UPDATE "WorkOrderSize" SET "measurementProfileId" = ${lit(mtm.b.profile)} WHERE "workOrderId" = ${lit(w.b.workOrderId)};
     UPDATE "SalesOrderLine" SET "quoteLineId" = ${lit(quoteLine!.id)} WHERE id = ${lit(w.a.salesOrderLineId)};
     COMMIT;`,
  )
  files.a.order = await fileOn('SalesOrder', w.a.salesOrderId, 'T-PR2B-A order sheet.pdf')
  files.a.artwork = await fileOn('SalesOrderLine', w.a.salesOrderLineId, 'T-PR2B-A logo artwork.pdf', { category: 'ARTWORK' })
  files.a.measure = await fileOn('SalesOrder', w.a.salesOrderId, 'T-PR2B-A measurement sheet.pdf', { category: 'MEASUREMENTS' })
  files.a.quote = await fileOn('QuoteLine', quoteLine!.id, 'T-PR2B-A quote artwork.pdf', { category: 'ARTWORK' })
  files.b.order = await fileOn('SalesOrder', w.b.salesOrderId, 'T-PR2B-B order sheet.pdf')
  files.b.artwork = await fileOn('SalesOrderLine', w.b.salesOrderLineId, 'T-PR2B-B logo artwork.pdf', { category: 'ARTWORK' })
  files.b.measure = await fileOn('SalesOrder', w.b.salesOrderId, 'T-PR2B-B measurement sheet.pdf', { category: 'MEASUREMENTS' })
  files.b.otherCompany = await fileOn('SalesOrder', w.b.salesOrderId, 'T-PR2B-B company two notes.pdf', { companyId: companyB })

  aMarkers = [
    ...(await markersOf(db, w.a.partyId)),
    ...Object.values(files.a).map((text) => ({ label: 'A file id', text })),
    ...['T-PR2B-A order sheet.pdf', 'T-PR2B-A logo artwork.pdf', 'T-PR2B-A measurement sheet.pdf', 'T-PR2B-A quote artwork.pdf', 'T-PR2B-MTM-A-1'].map((text) => ({ label: 'A file', text })),
    { label: 'A profile', text: mtm.a.profile },
    { label: 'A worksheet', text: mtm.a.v1 },
    { label: 'A order', text: w.a.salesOrderId },
    { label: 'A line', text: w.a.salesOrderLineId },
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

describe('GET /production/work-orders/:id/order-files: the order’s own files, nobody re-types (L16)', { timeout: 60_000 }, () => {
  it('lists, for the production unit, the order’s files, its line’s artwork, the newest worksheet and the order thread', async () => {
    const list = await ok('office.all', 'GET', listOf(w.b.workOrderId))
    expect(list.workOrder).toEqual({ id: w.b.workOrderId, number: w.b.workOrderNumber })
    expect(list.ordersLeftOut).toBe(0)
    expect((list.groups as Json[]).map((group) => group.order.id)).toEqual([w.b.salesOrderId])
    const group = groupOf(list, w.b.salesOrderId)
    const [order] = await admin<{ number: string; customerRef: string | null }>(`SELECT number, "customerRef" FROM "SalesOrder" WHERE id = $1`, [w.b.salesOrderId])
    expect(group.order).toMatchObject({ id: w.b.salesOrderId, number: order!.number, customerRef: order!.customerRef })
    expect(group.thread).toEqual({ recordType: 'SalesOrder', recordId: w.b.salesOrderId, threadId: w.second.threadId })
    expect(names(group)).toEqual(['Seed second brand label artwork.pdf', 'T-PR2B-B company two notes.pdf', 'T-PR2B-B logo artwork.pdf', 'T-PR2B-B measurement sheet.pdf', 'T-PR2B-B order sheet.pdf'])
    const byName = (name: string): Json => (group.files as Json[]).find((file) => file.name === name) ?? {}
    expect(byName('T-PR2B-B order sheet.pdf')).toMatchObject({ id: files.b.order, from: 'ORDER', line: null, contentType: 'application/pdf', kind: 'DOCUMENT', category: null, bodyData: false, versionNo: 1 })
    expect(byName('T-PR2B-B logo artwork.pdf')).toMatchObject({ id: files.b.artwork, from: 'LINE', line: { id: w.b.salesOrderLineId, seq: 900 }, category: 'ARTWORK', bodyData: false })
    expect(byName('T-PR2B-B measurement sheet.pdf')).toMatchObject({ id: files.b.measure, from: 'ORDER', category: 'MEASUREMENTS', bodyData: true })
    // Newest first.
    const times = (group.files as Json[]).map((file) => Date.parse(file.at))
    expect(times).toEqual([...times].sort((x, y) => y - x))
    // The newest worksheet version of the line's profile revision, opened only by the made-to-measure route.
    expect(group.worksheets).toEqual([{ documentId: mtm.b.v2, profileId: mtm.b.profile, line: { id: w.b.salesOrderLineId, seq: 900 }, version: 2, number: 'T-PR2B-MTM-B-2', language: 'it', createdAt: expect.any(String) }])
    expect([group.measurementsLeftOut, group.filesLeftOut]).toEqual([0, 0])
    // The generic preview is never linked: the answer carries no address at all.
    expect(JSON.stringify(list)).not.toMatch(/\/files\/|https?:/)
  })

  it('takes a line’s artwork from the quote line it was made from; an order of no thread yet has a null thread id', async () => {
    const group = groupOf(await ok('office.all', 'GET', listOf(w.a.workOrderId)), w.a.salesOrderId)
    expect(names(group)).toEqual(expect.arrayContaining(['T-PR2B-A logo artwork.pdf', 'T-PR2B-A measurement sheet.pdf', 'T-PR2B-A order sheet.pdf', 'T-PR2B-A quote artwork.pdf']))
    expect((group.files as Json[]).find((file) => file.id === files.a.quote)).toMatchObject({ from: 'QUOTE_LINE', line: { id: w.a.salesOrderLineId, seq: 900 }, category: 'ARTWORK' })
    expect(group.thread).toEqual({ recordType: 'SalesOrder', recordId: w.a.salesOrderId, threadId: null })
    expect(group.worksheets.map((sheet: Json) => [sheet.documentId, sheet.version])).toEqual([[mtm.a.v1, 1]])
  })
})

describe('PW-16: B’s person never reaches A’s order files', { timeout: 60_000 }, () => {
  it('404 on A’s work order’s files and on opening A’s file, in the words of an unknown id', async () => {
    const unknown = newId()
    await notFound('office.p2', 'GET', listOf(unknown), 'Work order not found.')
    await notFound('office.p2', 'GET', listOf(w.a.workOrderId), 'Work order not found.')
    await notFound('office.p2', 'POST', openOf(w.a.workOrderId, files.a.order), 'Work order not found.')
    // A's file asked through B's own work order: as unknown as a made-up id.
    await notFound('office.p2', 'POST', openOf(w.b.workOrderId, newId()), 'File not found.')
    for (const fileId of Object.values(files.a)) await notFound('office.p2', 'POST', openOf(w.b.workOrderId, fileId), 'File not found.')
    // The mixed work order made before the rule is every customer's: not B's person's.
    await notFound('office.p2', 'GET', listOf(w.mixed.workOrderId), 'Work order not found.')
    // And the other way round: A's person never reaches B's.
    await notFound('office.p1', 'GET', listOf(w.b.workOrderId), 'Work order not found.')
  })

  it('B’s person lists and opens B’s own files: the 60-second preview or download through the walled route', async () => {
    const group = groupOf(await ok('office.p2', 'GET', listOf(w.b.workOrderId)), w.b.salesOrderId)
    expect(group.files.length).toBe(5)
    const preview = await ok('office.p2', 'POST', openOf(w.b.workOrderId, files.b.order), {})
    expect(preview).toMatchObject({ file: { id: files.b.order, name: 'T-PR2B-B order sheet.pdf', contentType: 'application/pdf' }, open: { mode: 'inline', method: 'GET' } })
    const lives = Date.parse(preview.open.expiresAt) - Date.now()
    expect(lives).toBeGreaterThan(0)
    expect(lives).toBeLessThanOrEqual(61_000)
    expect((await ok('office.p2', 'POST', openOf(w.b.workOrderId, files.b.artwork), { mode: 'download' })).open).toMatchObject({ mode: 'download', method: 'GET' })
    // A plain file's opening writes nothing; a measurement sheet's is recorded on its order (who looked, when).
    const opened = async (fileId: string) => (await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'production.orderFileOpened' AND after->>'fileId' = $2`, [ids.tenantId, fileId])).length
    expect(await opened(files.b.order)).toBe(0)
    await ok('office.p2', 'POST', openOf(w.b.workOrderId, files.b.measure), {})
    const [row] = await admin<{ recordType: string; recordId: string; actorId: string; after: Json }>(`SELECT "recordType", "recordId", "actorId", after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'production.orderFileOpened'`, [ids.tenantId])
    expect(row).toMatchObject({ recordType: 'SalesOrder', recordId: w.b.salesOrderId, actorId: (SESSIONS['office.p2'] as { readonly actorId: string }).actorId, after: { workOrderId: w.b.workOrderId, fileId: files.b.measure, category: 'MEASUREMENTS' } })
  })

  it('the worksheet and the measurement sheet only with the measurements right: others read how many were left out', async () => {
    const thin = groupOf(await ok('office.p2.thin', 'GET', listOf(w.b.workOrderId)), w.b.salesOrderId)
    expect(names(thin)).toEqual(['Seed second brand label artwork.pdf', 'T-PR2B-B company two notes.pdf', 'T-PR2B-B logo artwork.pdf', 'T-PR2B-B order sheet.pdf'])
    expect(thin.worksheets).toEqual([])
    expect(thin.measurementsLeftOut).toBe(2)
    // No threads right: no "Order thread".
    expect(thin.thread).toBeNull()
    await notFound('office.p2.thin', 'POST', openOf(w.b.workOrderId, files.b.measure), 'File not found.')
    // The worksheet opens only by the made-to-measure route, with the measurements right (a person without it is refused by the
    // route itself), each opening recorded.
    expect((await call('office.p2.thin', 'POST', `/sales/mtm/profiles/${mtm.b.profile}/worksheets/${mtm.b.v2}/open`, {})).status).toBe(403)
    const sheet = await ok('office.p2', 'POST', `/sales/mtm/profiles/${mtm.b.profile}/worksheets/${mtm.b.v2}/open`, {})
    expect(sheet.worksheet).toMatchObject({ id: mtm.b.v2, version: 2 })
    expect((await admin(`SELECT 1 FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'mtm.worksheetOpened' AND "recordId" = $2`, [ids.tenantId, mtm.b.profile])).length).toBe(1)
    // A's worksheet: as unknown to B's person as any.
    await notFound('office.p2', 'POST', `/sales/mtm/profiles/${mtm.a.profile}/worksheets/${mtm.a.v1}/open`, 'Measurement profile not found.')
  })

  it('without the files right the order is counted, never named; a file of another company is counted, never named', async () => {
    const blind = await ok('office.p2.blind', 'GET', listOf(w.b.workOrderId))
    expect([blind.groups, blind.ordersLeftOut]).toEqual([[], 1])
    await notFound('office.p2.blind', 'POST', openOf(w.b.workOrderId, files.b.order), 'File not found.')
    const companyOnly = groupOf(await ok('office.p2.companyA', 'GET', listOf(w.b.workOrderId)), w.b.salesOrderId)
    expect(names(companyOnly)).not.toContain('T-PR2B-B company two notes.pdf')
    expect(companyOnly.filesLeftOut).toBe(1)
    await notFound('office.p2.companyA', 'POST', openOf(w.b.workOrderId, files.b.otherCompany), 'File not found.')
  })

  it('a legacy mixed work order: one group per order, each only for people who read that customer’s files', async () => {
    const all = await ok('office.all', 'GET', listOf(w.mixed.workOrderId))
    expect((all.groups as Json[]).map((group) => group.order.id).sort()).toEqual([w.a.salesOrderId, w.b.salesOrderId].sort())
    expect(all.ordersLeftOut).toBe(0)
    expect(names(groupOf(all, w.a.salesOrderId))).toContain('T-PR2B-A order sheet.pdf')
    // Every customer's work orders, B's files only: B's group, A's counted and never named.
    const onlyB = await ok('office.all.p2files', 'GET', listOf(w.mixed.workOrderId))
    expect((onlyB.groups as Json[]).map((group) => group.order.id)).toEqual([w.b.salesOrderId])
    expect(onlyB.ordersLeftOut).toBe(1)
    expect(groupOf(onlyB, w.b.salesOrderId).thread).toEqual({ recordType: 'SalesOrder', recordId: w.b.salesOrderId, threadId: w.second.threadId })
    await notFound('office.all.p2files', 'POST', openOf(w.mixed.workOrderId, files.a.order), 'File not found.')
    expect((await ok('office.all.p2files', 'POST', openOf(w.mixed.workOrderId, files.b.order), {})).file.id).toBe(files.b.order)
  })
})

describe('what B’s people were answered (T00 scan)', () => {
  it('no answer B’s people got names A: not its names, code, orders, files, worksheets, work orders or ids', () => {
    expect(seenByB.length).toBeGreaterThan(20)
    const found = seenByB.flatMap((entry) => findMarkers(entry.body, aMarkers).map((marker) => `${entry.url} → ${marker}`))
    expect(found).toEqual([])
  })
})
