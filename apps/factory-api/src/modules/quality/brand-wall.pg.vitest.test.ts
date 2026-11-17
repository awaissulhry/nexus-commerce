import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { EVERY_PARTY_WORDS, type Permission } from '@nexus/factory-domain/core/permissions'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedHolds, type HoldsSeed } from '../../../../../packages/factory-db/seed/holds'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../packages/factory-db/seed/production'
import { seed as seedQuality, type QualitySeed } from '../../../../../packages/factory-db/seed/quality'
import { seed as seedReasons } from '../../../../../packages/factory-db/seed/reasons'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from '../production/testing/two-brands'

/**
 * B-PR-06 (production plan §2, the brand wall; 06-tree §0.6 PW-06 "quality lists" and PW-03 "the record and every tab read";
 * Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production
 * unit, should be able to see it all. And manage it all as well."): quality's reads behind the wall, on the local stack with
 * the app's real routes — a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and
 * the guards are real), the core, files, production, numbering, reasons and holds seeds (which bring quality: brand A = the
 * seeds' P1 owns every seeded inspection, release, SEED-NCR-0001; the hold of a hide and SEED-NCR-0002 of it name no
 * customer), and the production two-brand harness (brand B = the threads' second brand, a draft work order each and one mixed
 * before the rule). Brand B gets an inspection, an in-process check and an NCR of its own (A's seeded rows copied onto B's
 * work order), and holds are placed through the real route: A's work order alone, B's alone, both (several customers).
 *
 * A person limited to B (office.p2) gets only B's rows and the rows that name no customer; every record of A (and of several
 * customers, and of the mixed work order) answers as an unknown id; what counts every customer (quality reports, a line's DHU
 * and roving board) is refused in words that name none; every answer B's person got is scanned for A's names, codes,
 * numbers and ids. The production unit (office.all) sees and manages it all. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/quality/brand-wall`.
 */

const ns = 'pr06-quality-wall'
const ids = twoBrandIds(ns)
const PERMISSIONS: Permission[] = [
  'workorders.view',
  'workorders.manage',
  'quality.inspections.view',
  'quality.inspections.record',
  'quality.holds.view',
  'quality.holds.place',
  'quality.ncr.view',
  'quality.ncr.raise',
  'quality.inprocess.view',
  'quality.inprocess.record',
  'quality.reports.view',
  'shipping.view',
  'production.scan',
]
const SESSIONS: Record<string, SessionContext> = twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS)

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let quality: QualitySeed
let holdsSeed: HoldsSeed
/** B's own rows, and A's (and several customers') holds. */
const bRows = { inspectionId: '', checkId: '', ncrId: '', holdId: '' }
const aRows = { checkId: '', holdId: '', bothHoldId: '', mixedHoldId: '' }
let lineId = ''
let aMarkers: Marker[]

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'
interface Seen {
  readonly url: string
  readonly status: number
  readonly body: unknown
}
const seenByB: Seen[] = []
let keys = 0
async function call(session: string, method: Method, url: string, payload?: unknown, record = true): Promise<{ status: number; body: Json; raw: string }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `pr06-${++keys}-${newId()}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  if (session === 'office.p2' && record) seenByB.push({ url: `${method} ${url}`, status: response.statusCode, body: Object.keys(body).length > 0 ? body : response.body })
  return { status: response.statusCode, body, raw: response.body }
}
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.status, `${method} ${url}: ${answer.raw}`).toBe(status)
  return answer.body
}
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const sql = (value: string): string => {
  if (!isUuid(value)) throw new Error(`not an id: ${value}`)
  return `'${value}'`
}
const idsOf = (rows: readonly Json[], key = 'id') => rows.map((row) => row[key] as string)

/** The same answer as an unknown id: status and words. */
async function asUnknown(session: string, url: (id: string) => string, id: string, words: string) {
  const unknown = newId()
  const theirs = await call(session, 'GET', url(id))
  const none = await call(session, 'GET', url(unknown), undefined, false)
  expect([theirs.status, none.status], `${url(id)}: ${theirs.raw}`).toEqual([404, 404])
  expect(theirs.body.error?.message, url(id)).toBe(words)
  expect(none.body.error?.message).toBe(words)
}

beforeAll(async () => {
  db = await migratedDatabase('pr06_quality_wall')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedFiles({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await seedReasons({ db: database, namespace: ns })
  holdsSeed = await seedHolds({ db: database, namespace: ns })
  quality = await seedQuality({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  // The seeded quality is A's (the seeds' P1).
  expect((await admin<{ partyId: string }>(`SELECT "partyId" FROM "WorkOrder" WHERE id IN ($1, $2)`, [quality.production.workOrderId, quality.serialWorkOrderId])).map((row) => row.partyId)).toEqual([w.a.partyId, w.a.partyId])

  // B's own rows: A's OPEN inspection and SEED-NCR-0001 copied onto B's work order (the NCR about our own collection's style),
  // and an in-process check on each brand's work order (the database's rules off for these statements, as the harness does).
  bRows.inspectionId = newId()
  bRows.ncrId = newId()
  bRows.checkId = newId()
  aRows.checkId = newId()
  const check = (id: string, workOrderId: string) =>
    `INSERT INTO "InProcessCheck" ("id", "tenantId", "companyId", "siteId", "kind", "status", "workOrderId", "createdAt", "updatedAt") VALUES (${sql(id)}, ${sql(w.tenantId)}, ${sql(w.companyId)}, ${sql(w.siteId)}, 'ROVING', 'OPEN', ${sql(workOrderId)}, now(), now());`
  await db.admin.query(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     INSERT INTO "Inspection" SELECT (jsonb_populate_record(NULL::"Inspection", to_jsonb(i) || jsonb_build_object('id', ${sql(bRows.inspectionId)}, 'workOrderId', ${sql(w.b.workOrderId)}, 'number', 'T-PR06-INS-B'))).* FROM "Inspection" i WHERE i.id = ${sql(quality.openInspectionId)};
     INSERT INTO "Nonconformance" SELECT (jsonb_populate_record(NULL::"Nonconformance", to_jsonb(n) || jsonb_build_object('id', ${sql(bRows.ncrId)}, 'number', 'T-PR06-NCR-B', 'title', 'Beta seam check', 'workOrderId', ${sql(w.b.workOrderId)}, 'styleId', ${sql(w.styleId)}, 'colourwayId', NULL, 'sourceType', NULL, 'sourceId', NULL))).* FROM "Nonconformance" n WHERE n.id = ${sql(holdsSeed.openNcrId)};
     ${check(bRows.checkId, w.b.workOrderId)}
     ${check(aRows.checkId, quality.production.workOrderId)}
     COMMIT;`,
  )
  // Holds through the real route: A's work order alone, B's alone, both (several customers), the mixed one (no customer).
  const place = async (subjectIds: string[]) => (await ok('office.all', 'POST', '/quality/holds', { subjectType: 'WorkOrder', subjectIds, reasonCode: 'QUALITY_CHECK' }, 201)).hold.id as string
  aRows.holdId = await place([w.a.workOrderId])
  bRows.holdId = await place([w.b.workOrderId])
  aRows.bothHoldId = await place([w.a.workOrderId, w.b.workOrderId])
  aRows.mixedHoldId = await place([w.mixed.workOrderId])
  lineId = (await admin<{ id: string }>(`SELECT id FROM "Line" WHERE "tenantId" = $1 AND "siteId" = $2 ORDER BY code LIMIT 1`, [w.tenantId, w.siteId]))[0]!.id

  // What must never reach B: A's markers, the mixed work order, and A's quality records (ids and numbers).
  const records = await admin<{ text: string }>(
    `SELECT id::text AS text FROM "Inspection" WHERE "workOrderId" IN ($1, $2, $3)
     UNION ALL SELECT number FROM "Inspection" WHERE "workOrderId" IN ($1, $2, $3) AND number IS NOT NULL
     UNION ALL SELECT id::text FROM "QualityRelease" WHERE "workOrderId" IN ($1, $2)
     UNION ALL SELECT number FROM "QualityRelease" WHERE "workOrderId" IN ($1, $2) AND number IS NOT NULL
     UNION ALL SELECT id::text FROM "QualityHold" WHERE id IN ($4, $5, $6)
     UNION ALL SELECT number FROM "QualityHold" WHERE id IN ($4, $5, $6) AND number IS NOT NULL
     UNION ALL SELECT id::text FROM "Nonconformance" WHERE id = $7
     UNION ALL SELECT number FROM "Nonconformance" WHERE id = $7
     UNION ALL SELECT $8`,
    [quality.production.workOrderId, quality.serialWorkOrderId, w.a.workOrderId, aRows.holdId, aRows.bothHoldId, aRows.mixedHoldId, holdsSeed.openNcrId, aRows.checkId],
  )
  aMarkers = [...(await markersOf(db, w.a.partyId)), { label: 'mixed work order', text: w.mixed.number }, { label: 'mixed work order', text: w.mixed.workOrderId }, ...records.map((row) => ({ label: 'A quality record', text: row.text }))]
}, 400_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the production unit sees and manages it all (office.all)', { timeout: 60_000 }, () => {
  it('lists every customer’s inspections, releases, holds, NCRs and checks; the customer filter narrows them', async () => {
    const inspections = idsOf((await ok('office.all', 'GET', '/quality/inspections?limit=200')).inspections)
    expect(inspections).toEqual(expect.arrayContaining([quality.openInspectionId, quality.passedInspectionId, quality.serialInspectionId, bRows.inspectionId]))
    expect(idsOf((await ok('office.all', 'GET', `/quality/inspections?limit=200&partyId=${w.b.partyId}`)).inspections)).toEqual([bRows.inspectionId])
    expect(idsOf((await ok('office.all', 'GET', '/quality/releases?limit=200')).releases)).toEqual(expect.arrayContaining([quality.releaseIds['BLK-50'], ...quality.serialReleaseIds]))
    expect((await ok('office.all', 'GET', `/quality/releases?limit=200&partyId=${w.b.partyId}`)).releases).toEqual([])
    const holds = idsOf((await ok('office.all', 'GET', '/quality/holds')).holds)
    expect(holds).toEqual(expect.arrayContaining([holdsSeed.holdId, aRows.holdId, bRows.holdId, aRows.bothHoldId, aRows.mixedHoldId]))
    expect(idsOf((await ok('office.all', 'GET', `/quality/holds?partyId=${w.b.partyId}`)).holds).sort()).toEqual([bRows.holdId, aRows.bothHoldId].sort())
    expect((await ok('office.all', 'GET', '/quality/holds/counts')).counts.open).toBe(holds.length)
    const ncrs = idsOf((await ok('office.all', 'GET', '/quality/ncr?open=false')).items)
    expect(ncrs).toEqual(expect.arrayContaining([holdsSeed.openNcrId, holdsSeed.ncrId, bRows.ncrId]))
    expect(idsOf((await ok('office.all', 'GET', `/quality/ncr?open=false&partyId=${w.b.partyId}`)).items)).toEqual([bRows.ncrId])
    expect(idsOf((await ok('office.all', 'GET', `/quality/inprocess/checks?siteId=${w.siteId}`)).checks)).toEqual(expect.arrayContaining([aRows.checkId, bRows.checkId]))
  })

  it('opens A’s and B’s records, the mixed work order’s hold, and reads the reports and the line’s views', async () => {
    await ok('office.all', 'GET', `/quality/inspections/${quality.openInspectionId}`)
    await ok('office.all', 'GET', `/quality/final/work-orders/${quality.production.workOrderId}`)
    await ok('office.all', 'GET', `/quality/releases/${quality.releaseIds['BLK-50']}`)
    await ok('office.all', 'GET', `/quality/holds/${aRows.bothHoldId}`)
    await ok('office.all', 'GET', `/quality/holds/${aRows.mixedHoldId}`)
    await ok('office.all', 'GET', `/quality/ncr/${holdsSeed.openNcrId}`)
    await ok('office.all', 'GET', `/quality/inprocess/checks/${aRows.checkId}`)
    await ok('office.all', 'GET', '/quality/reports/kpis')
    await ok('office.all', 'GET', `/quality/inprocess/dhu?lineId=${lineId}`)
    await ok('office.all', 'GET', `/quality/inprocess/roving?lineId=${lineId}`)
  })
})

describe('a person limited to customer B (office.p2) never meets customer A', { timeout: 60_000 }, () => {
  it('PW-06: the quality lists and their counts hold only B’s rows and the rows of no customer', async () => {
    const inspections = idsOf((await ok('office.p2', 'GET', '/quality/inspections?limit=200')).inspections)
    expect(inspections).toEqual([bRows.inspectionId])
    expect((await ok('office.p2', 'GET', `/quality/inspections?limit=200&partyId=${w.a.partyId}`)).inspections).toEqual([])
    expect((await ok('office.p2', 'GET', '/quality/releases?limit=200')).releases).toEqual([])
    // The bench: no work order of A's (B's own is a draft: nothing to inspect).
    expect((await ok('office.p2', 'GET', '/quality/final/work-orders?limit=50')).workOrders).toEqual([])
    // Holds: B's and the hide's (a material names no customer); never A's, both customers' nor the mixed work order's.
    const holds = idsOf((await ok('office.p2', 'GET', '/quality/holds')).holds)
    expect(holds.sort()).toEqual([holdsSeed.holdId, bRows.holdId].sort())
    expect((await ok('office.p2', 'GET', `/quality/holds?partyId=${w.a.partyId}`)).holds).toEqual([])
    expect((await ok('office.p2', 'GET', '/quality/holds/counts')).counts.open).toBe(2)
    // NCRs: B's and the hide's.
    const ncrs = idsOf((await ok('office.p2', 'GET', '/quality/ncr?open=false')).items)
    expect(ncrs).toContain(bRows.ncrId)
    expect(ncrs).not.toContain(holdsSeed.openNcrId)
    const board = (await ok('office.p2', 'GET', '/quality/ncr/board')).lanes as Json[]
    expect(board.flatMap((lane) => idsOf(lane.cards))).not.toContain(holdsSeed.openNcrId)
    const counts = (await ok('office.p2', 'GET', '/quality/ncr/counts')).counts
    const all = (await ok('office.all', 'GET', '/quality/ncr/counts')).counts
    expect(counts.open).toBeLessThan(all.open)
    // In-process checks: B's, never A's.
    const checks = idsOf((await ok('office.p2', 'GET', `/quality/inprocess/checks?siteId=${w.siteId}`)).checks)
    expect(checks).toContain(bRows.checkId)
    expect(checks).not.toContain(aRows.checkId)
    // The inspector queue: no row of A's work orders.
    const queue = (await ok('office.p2', 'GET', '/quality/queue')).rows as Json[]
    expect(queue.map((row) => row.workOrder?.id).filter(Boolean)).not.toEqual(expect.arrayContaining([quality.production.workOrderId]))
  })

  it('PW-06: what counts every customer (quality reports, a line’s DHU and roving board, a site’s charges) is refused in words that name none', async () => {
    for (const url of ['/quality/reports/kpis', '/quality/reports/trend', '/quality/reports/compare', '/quality/reports/incoming', `/quality/inprocess/dhu?lineId=${lineId}`, `/quality/inprocess/roving?lineId=${lineId}`, `/quality/inprocess/charges?lineId=${lineId}`]) {
      const answer = await call('office.p2', 'GET', url)
      expect(answer.status, `${url}: ${answer.raw}`).toBe(403)
      expect(answer.body.error.message).toBe(EVERY_PARTY_WORDS.en)
    }
  })

  it('PW-03: every record of A (and of several customers, and of the mixed work order) answers as an unknown id', async () => {
    await asUnknown('office.p2', (id) => `/quality/inspections/${id}`, quality.openInspectionId, 'Inspection not found.')
    await asUnknown('office.p2', (id) => `/quality/inspections/${id}/sheet`, quality.passedInspectionId, 'Inspection not found.')
    await asUnknown('office.p2', (id) => `/quality/inspections/${id}/reports`, quality.passedInspectionId, 'Inspection not found.')
    await asUnknown('office.p2', (id) => `/quality/final/work-orders/${id}`, quality.production.workOrderId, 'Work order not found.')
    await asUnknown('office.p2', (id) => `/quality/final/work-orders/${id}`, w.mixed.workOrderId, 'Work order not found.')
    await asUnknown('office.p2', (id) => `/quality/final/work-orders/${id}/plans`, quality.serialWorkOrderId, 'Work order not found.')
    await asUnknown('office.p2', (id) => `/quality/releases/${id}`, quality.releaseIds['BLK-52'], 'Release not found.')
    for (const holdId of [aRows.holdId, aRows.bothHoldId, aRows.mixedHoldId]) {
      await asUnknown('office.p2', (id) => `/quality/holds/${id}`, holdId, 'Hold not found.')
      await asUnknown('office.p2', (id) => `/quality/holds/${id}/affected`, holdId, 'Hold not found.')
    }
    await asUnknown('office.p2', (id) => `/quality/ncr/${id}`, holdsSeed.openNcrId, 'NCR not found.')
    await asUnknown('office.p2', (id) => `/quality/ncr/${id}/cost`, holdsSeed.openNcrId, 'NCR not found.')
    await asUnknown('office.p2', (id) => `/quality/ncr/prefill?recordType=WorkOrder&recordId=${id}`, quality.production.workOrderId, 'Work Order not found.')
    await asUnknown('office.p2', (id) => `/quality/ncr/prefill?recordType=Inspection&recordId=${id}`, quality.passedInspectionId, 'Inspection not found.')
    await asUnknown('office.p2', (id) => `/quality/inprocess/checks/${id}`, aRows.checkId, 'Check not found.')
    // The evidence trail of A's batch, as an unknown batch.
    const batch = (await admin<{ batchNumber: string }>(`SELECT "batchNumber" FROM "WorkOrder" WHERE id = $1`, [quality.production.workOrderId]))[0]!.batchNumber
    const theirs = await call('office.p2', 'GET', `/quality/evidence?batch=${encodeURIComponent(batch)}`, undefined, false)
    const none = await call('office.p2', 'GET', '/quality/evidence?batch=T-NO-SUCH-BATCH', undefined, false)
    expect([theirs.status, theirs.body.error?.message]).toEqual([none.status, none.body.error?.message])
    // A scanned code of A's work order leads nowhere, as an unknown code (only the typed code differs).
    const number = (await admin<{ number: string }>(`SELECT number FROM "WorkOrder" WHERE id = $1`, [quality.production.workOrderId]))[0]!.number
    const scanned = await call('office.p2', 'GET', `/quality/queue/scan?code=${encodeURIComponent(number)}`, undefined, false)
    const unknown = await call('office.p2', 'GET', '/quality/queue/scan?code=T-NO-SUCH-CODE', undefined, false)
    expect(scanned.status).toBe(unknown.status)
    expect(scanned.raw.replaceAll(number, '<code>')).toBe(unknown.raw.replaceAll('T-NO-SUCH-CODE', '<code>'))
  })

  it('PW-03: a hold of A’s goods is neither previewed nor placed, and an inspection of A’s is not set due (as unknown ids); nothing is written', async () => {
    const unknown = newId()
    const preview = (await ok('office.p2', 'POST', '/quality/holds/preview', { subjectType: 'WorkOrder', subjectIds: [quality.production.workOrderId, unknown] })).subjects as Json[]
    const [ofA, ofUnknown] = preview.map(({ id: _id, ...row }) => row)
    expect(ofA).toEqual(ofUnknown)
    const placed = await call('office.p2', 'POST', '/quality/holds', { subjectType: 'WorkOrder', subjectIds: [quality.production.workOrderId], reasonCode: 'QUALITY_CHECK' })
    const placedUnknown = await call('office.p2', 'POST', '/quality/holds', { subjectType: 'WorkOrder', subjectIds: [unknown], reasonCode: 'QUALITY_CHECK' }, false)
    expect([placed.status, placed.body.error?.issues]).toEqual([placedUnknown.status, placedUnknown.body.error?.issues])
    const version = (await admin<{ version: number }>(`SELECT version FROM "Inspection" WHERE id = $1`, [quality.openInspectionId]))[0]!.version
    const due = await call('office.p2', 'POST', '/quality/inspections/due', { inspections: [{ id: quality.openInspectionId, version }], dueAt: new Date(Date.now() + 7 * 86_400_000).toISOString() })
    expect([due.status, due.body.error?.message]).toEqual([404, 'Inspection not found.'])
    expect((await admin(`SELECT version, "dueAt" FROM "Inspection" WHERE id = $1`, [quality.openInspectionId]))[0]).toMatchObject({ version, dueAt: null })
    expect((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "QualityHold" WHERE $1 = ANY("subjectIds") AND "createdAt" > now() - interval '1 hour'`, [quality.production.workOrderId]))[0]!.n).toBe(0)
  })

  it('B’s person still works with B’s own records (the wall takes nothing away from its customer)', async () => {
    await ok('office.p2', 'GET', `/quality/inspections/${bRows.inspectionId}`)
    await ok('office.p2', 'GET', `/quality/holds/${bRows.holdId}`)
    await ok('office.p2', 'GET', `/quality/holds/${holdsSeed.holdId}`)
    await ok('office.p2', 'GET', `/quality/ncr/${bRows.ncrId}`)
    await ok('office.p2', 'GET', `/quality/inprocess/checks/${bRows.checkId}`)
    await ok('office.p2', 'GET', `/quality/ncr/prefill?recordType=WorkOrder&recordId=${w.b.workOrderId}`)
  })

  it('no answer B’s person got names A: not its names, codes, orders, work orders, inspections, releases, holds, NCRs or ids', () => {
    expect(seenByB.length).toBeGreaterThan(25)
    const found = seenByB.flatMap((entry) => findMarkers(entry.body, aMarkers).map((marker) => `${entry.url} → ${marker}`))
    expect(found).toEqual([])
  })
})

describe('symmetric: a person limited to customer A (office.p1)', { timeout: 60_000 }, () => {
  it('sees A’s inspections, holds and NCRs, never B’s, both customers’ hold nor the mixed one', async () => {
    const inspections = idsOf((await ok('office.p1', 'GET', '/quality/inspections?limit=200')).inspections)
    expect(inspections).toContain(quality.openInspectionId)
    expect(inspections).not.toContain(bRows.inspectionId)
    const holds = idsOf((await ok('office.p1', 'GET', '/quality/holds')).holds)
    expect(holds).toContain(aRows.holdId)
    expect(holds).not.toEqual(expect.arrayContaining([bRows.holdId]))
    expect(holds).not.toContain(aRows.bothHoldId)
    expect(holds).not.toContain(aRows.mixedHoldId)
    const ncrs = idsOf((await ok('office.p1', 'GET', '/quality/ncr?open=false')).items)
    expect(ncrs).toContain(holdsSeed.openNcrId)
    expect(ncrs).not.toContain(bRows.ncrId)
    expect((await call('office.p1', 'GET', `/quality/holds/${aRows.bothHoldId}`)).status).toBe(404)
    expect((await call('office.p1', 'GET', `/quality/inspections/${bRows.inspectionId}`)).status).toBe(404)
  })
})
