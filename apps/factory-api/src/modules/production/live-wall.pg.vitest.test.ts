import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { EVERY_PARTY_WORDS, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { EVENT_CATALOGUE } from '@nexus/factory-domain/events/catalogue'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { liveMessageFor, liveViewFor, partyIdsOf } from '@nexus/factory-domain/events/live'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedCutting, type CuttingSeed } from '../../../../../packages/factory-db/seed/cutting'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedHolds, type HoldsSeed } from '../../../../../packages/factory-db/seed/holds'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../packages/factory-db/seed/production'
import { seed as seedQuality, type QualitySeed } from '../../../../../packages/factory-db/seed/quality'
import { seed as seedReasons } from '../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import type { AnyExportSource } from '../../platform/exports/source'
import { capacityLoad } from '../../platform/exports/sources/capacity'
import { cutOrders as cutOrderExport } from '../../platform/exports/sources/cut-orders'
import { inspections as inspectionExport } from '../../platform/exports/sources/inspections'
import { mps } from '../../platform/exports/sources/mps'
import { mrp } from '../../platform/exports/sources/mrp'
import { ncrs as ncrExport } from '../../platform/exports/sources/ncrs'
import { reportListKey, reportSourceOf } from '../../platform/exports/sources/reports'
import { scheduleBoard } from '../../platform/exports/sources/schedule-board'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from './testing/two-brands'

/**
 * B-PR-09 (production plan §2, the brand wall; wall test PW-04: "an office person limited to brand B gets no live message about
 * brand A's records and no A row in any export; a several-brand event reaches only every-brand readers"). Owner rule 2026-11-16:
 * "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be able to see
 * it all. And manage it all as well."
 *
 * On the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login, so
 * row-level security and the one-customer guards are real), the core, files, production, numbering, reasons, holds, quality and
 * cutting seeds (brand A = the seeds' P1: WO-0001, its inspections, SEED-NCR-0001, the cut orders SEED-CO-0001…3) and the
 * production two-brand harness (./testing/two-brands.ts: brand B = the threads' second brand, a work order each and a mixed one
 * made before the rule). The production unit (office.all) changes work orders, places and edits holds and cancels cut orders of
 * A, of B, of both and of the mixed work order through the real routes; then:
 *
 *   live     every event those commands wrote (the outbox) names the right customers, and what each office person's live screen
 *            receives of it (factory-domain events/live.ts liveViewFor — the SSE endpoint's own function): office.p2 (limited
 *            to B) nothing of A's, of both, or of the mixed work order; B's own; office.all everything;
 *   exports  the files of cut orders, inspections (and releases), NCRs and the schedule board read as office.p2 hold no row of
 *            A's (with `?party=` of A: nothing), the production unit's `?party=` of B only B's; a published version of the
 *            board, capacity, the material plan, the master schedule and the daily production report are refused to office.p2
 *            in words that name no customer;
 *   scan     nothing office.p2 received (live views, file rows) names anything of A (its names, codes, numbers, ids).
 *
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/live-wall`.
 */

const ns = 'pr09-live'
const ids = twoBrandIds(ns)
const PERMISSIONS: Permission[] = [
  'workorders.view',
  'workorders.manage',
  'quality.holds.view',
  'quality.holds.place',
  'quality.inspections.view',
  'quality.ncr.view',
  'production.cutting.view',
  'production.cutorders.manage',
  'planning.view',
  'views.export',
  'home.reports.view',
  'production.reports.view',
]
const SESSIONS: Record<string, SessionContext> = twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS)
const site = seedUuid(ns, 'site:A1')
const line = seedUuid(ns, 'site:A1:line:L1')
const company = seedUuid(ns, 'company:A')

/** The events B-PR-09 makes name their customer, by the key that names it. */
const ONE_WORK_ORDER = ['workorder.created', 'workorder.changed', 'workorder.priority_changed', 'workorder.status_changed']
const SHARED = ['quality.hold_placed', 'quality.hold_changed', 'cut_order.changed']

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let quality: QualitySeed
let holdsSeed: HoldsSeed
let cutting: CuttingSeed
/** What must never reach brand B: A's markers, the mixed work order, A's quality records and cut orders. */
let aMarkers: Marker[]
const holds = { a: '', b: '', both: '', mixed: '' }
const cuts = { a: '', b: '', both: '', mixed: '' }
const bRows = { inspectionId: newId(), ncrId: newId() }
const plans = { published: newId() }
/** Everything office.p2 received (live views and file rows), for the scan at the end. */
const seenByB: unknown[] = []

type Json = Record<string, any>
async function call(session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<{ status: number; body: Json; raw: string }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  if (session === 'office.p2') seenByB.push(body)
  return { status: response.statusCode, body, raw: response.body }
}
async function ok(session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.status, answer.raw).toBe(status)
  return answer.body
}
const admin = async <T = Json>(text: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(text, values)).rows as T[]
const sql = (value: string): string => {
  if (!isUuid(value)) throw new Error(`not an id: ${value}`)
  return `'${value}'`
}
const actorOf = (session: string): Actor => ({ audience: 'office', tenantId: ids.tenantId, grants: SESSIONS[session]!.grants })
const callerOf = (session: string) => callerFor(database, { ...SESSIONS[session]!, requestId: newId() } as never)
/** One file's rows as a person exports the screen at `address` (the source's own read, as the worker runs it). */
async function exportRows(source: AnyExportSource, session: string, address: string): Promise<Json[]> {
  const page = await source.read(callerOf(session), source.query(new URLSearchParams(address)), null, 500, { locale: 'en' })
  if (session === 'office.p2') seenByB.push(page.rows)
  return page.rows as Json[]
}
const versionOf = async (table: 'WorkOrder' | 'QualityHold' | 'CutOrder', id: string) => (await admin<{ version: number }>(`SELECT version FROM "${table}" WHERE id = $1`, [id]))[0]!.version

interface Outbox {
  readonly envelope: EventEnvelope
  readonly payload: Json
}
/** The outbox rows of these types in the tenant, as the relay hands them on. */
async function outbox(types: readonly string[]): Promise<Outbox[]> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = ANY($2) ORDER BY "occurredAt", id`, [ids.tenantId, [...types]])
  return rows.map((row) => ({
    payload: row.payload as Json,
    envelope: { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload },
  }))
}
/** What one office person's live screen receives of an outbox row (null: nothing). */
function liveOf(row: Outbox, session: string) {
  const message = liveMessageFor(row.envelope, EVENT_CATALOGUE.get(row.envelope.type, row.envelope.version))
  expect(message, `${row.envelope.type} shows on a live screen`).not.toBeNull()
  const view = liveViewFor(message!, actorOf(session), EVENT_CATALOGUE)
  if (session === 'office.p2' && view) seenByB.push(view)
  return view
}

beforeAll(async () => {
  db = await migratedDatabase('pr09_live_wall')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedFiles({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await seedReasons({ db: database, namespace: ns })
  holdsSeed = await seedHolds({ db: database, namespace: ns })
  quality = await seedQuality({ db: database, namespace: ns })
  cutting = await seedCutting({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  // The seeded production, quality and cutting are A's (the seeds' P1).
  expect((await admin<{ partyId: string }>(`SELECT "partyId" FROM "WorkOrder" WHERE id = $1`, [quality.production.workOrderId]))[0]!.partyId).toBe(w.a.partyId)

  // B's own records, and the shared ones: A's OPEN inspection and SEED-NCR-0001 copied onto B's work order; SEED-CO-0003 (A's
  // PLANNED cut order) copied three times — onto a cell of B's work order, onto one of A's and one of B's, onto a cell of the
  // mixed work order; working-plan bars (a whole work order each) of A, B and the mixed one, and a published version holding
  // them (the database's rules off for these statements, as the harness does).
  const cellOf = async (workOrderId: string) => (await admin<{ id: string }>(`SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1 ORDER BY size LIMIT 1`, [workOrderId]))[0]!.id
  const cells = { b: await cellOf(w.b.workOrderId), mixed: await cellOf(w.mixed.workOrderId) }
  cuts.a = cutting.cutOrderIds.planned
  cuts.b = newId()
  cuts.both = newId()
  cuts.mixed = newId()
  const cutCopy = (id: string, number: string) =>
    `INSERT INTO "CutOrder" SELECT (jsonb_populate_record(NULL::"CutOrder", to_jsonb(c) || jsonb_build_object('id', ${sql(id)}, 'number', '${number}'))).* FROM "CutOrder" c WHERE c.id = ${sql(cuts.a)};`
  const lineCopy = (cutOrderId: string, workOrderId: string, cellId: string | null, seq: number) =>
    `INSERT INTO "CutOrderLine" SELECT (jsonb_populate_record(NULL::"CutOrderLine", to_jsonb(l) || jsonb_build_object('id', ${sql(newId())}, 'cutOrderId', ${sql(cutOrderId)}, 'seq', ${seq}, 'workOrderId', ${sql(workOrderId)}${cellId ? `, 'workOrderSizeId', ${sql(cellId)}` : ''}))).* FROM "CutOrderLine" l WHERE l.id = ${sql(cutting.lineIds.planned)};`
  const working = (await admin<{ id: string }>(`SELECT id FROM "PlanVersion" WHERE "siteId" = $1 AND kind = 'WORKING'`, [site]))[0]?.id ?? newId()
  const bar = (planId: string, kind: 'WORKING' | 'PUBLISHED', workOrderId: string) =>
    `INSERT INTO "ScheduleSlot" ("id", "tenantId", "siteId", "planVersionId", "planKind", "workOrderId", "lineId", "startAt", "endAt", "minutes") VALUES (${sql(newId())}, ${sql(w.tenantId)}, ${sql(site)}, ${sql(planId)}, '${kind}', ${sql(workOrderId)}, ${sql(line)}, now() + interval '1 day', now() + interval '1 day 2 hours', 120);`
  await db.admin.query(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     INSERT INTO "Inspection" SELECT (jsonb_populate_record(NULL::"Inspection", to_jsonb(i) || jsonb_build_object('id', ${sql(bRows.inspectionId)}, 'workOrderId', ${sql(w.b.workOrderId)}, 'number', 'T-PR09-INS-B'))).* FROM "Inspection" i WHERE i.id = ${sql(quality.openInspectionId)};
     INSERT INTO "Nonconformance" SELECT (jsonb_populate_record(NULL::"Nonconformance", to_jsonb(n) || jsonb_build_object('id', ${sql(bRows.ncrId)}, 'number', 'T-PR09-NCR-B', 'title', 'Beta seam check', 'workOrderId', ${sql(w.b.workOrderId)}, 'styleId', ${sql(w.styleId)}, 'colourwayId', NULL, 'sourceType', NULL, 'sourceId', NULL))).* FROM "Nonconformance" n WHERE n.id = ${sql(holdsSeed.openNcrId)};
     ${cutCopy(cuts.b, 'T-PR09-CO-B')}
     ${lineCopy(cuts.b, w.b.workOrderId, cells.b, 1)}
     ${cutCopy(cuts.both, 'T-PR09-CO-AB')}
     ${lineCopy(cuts.both, quality.production.workOrderId, null, 1)}
     ${lineCopy(cuts.both, w.b.workOrderId, cells.b, 2)}
     ${cutCopy(cuts.mixed, 'T-PR09-CO-MIX')}
     ${lineCopy(cuts.mixed, w.mixed.workOrderId, cells.mixed, 1)}
     INSERT INTO "PlanVersion" ("id", "tenantId", "companyId", "siteId", "kind") SELECT ${sql(working)}, ${sql(w.tenantId)}, ${sql(company)}, ${sql(site)}, 'WORKING' WHERE NOT EXISTS (SELECT 1 FROM "PlanVersion" WHERE id = ${sql(working)});
     INSERT INTO "PlanVersion" ("id", "tenantId", "companyId", "siteId", "kind", "number", "coversFrom", "coversTo", "effectiveFrom", "publishedAt") SELECT ${sql(plans.published)}, ${sql(w.tenantId)}, ${sql(company)}, ${sql(site)}, 'PUBLISHED', COALESCE(max(number), 0) + 1, current_date, current_date + 5, now(), now() FROM "PlanVersion" WHERE "siteId" = ${sql(site)} AND kind = 'PUBLISHED';
     ${bar(working, 'WORKING', quality.production.workOrderId)}
     ${bar(working, 'WORKING', w.b.workOrderId)}
     ${bar(working, 'WORKING', w.mixed.workOrderId)}
     ${bar(plans.published, 'PUBLISHED', quality.production.workOrderId)}
     ${bar(plans.published, 'PUBLISHED', w.b.workOrderId)}
     COMMIT;`,
  )

  // The production unit manages it all, through the real routes.
  // Work orders: priority and rush (workorder.changed + workorder.priority_changed) of A's, B's and the mixed one.
  for (const workOrderId of [w.a.workOrderId, w.b.workOrderId, w.mixed.workOrderId]) {
    await ok('office.all', 'PATCH', `/production/work-orders/${workOrderId}`, { version: await versionOf('WorkOrder', workOrderId), priority: 7, rush: true })
  }
  // Holds: A's work order alone, B's alone, both (several customers), the mixed one (no customer); each puts its work orders
  // ON_HOLD (workorder.status_changed); a note on B's and on both (quality.hold_changed).
  const place = async (subjectIds: string[]) => (await ok('office.all', 'POST', '/quality/holds', { subjectType: 'WorkOrder', subjectIds, reasonCode: 'QUALITY_CHECK' }, 201)).hold.id as string
  holds.a = await place([w.a.workOrderId])
  holds.b = await place([w.b.workOrderId])
  holds.both = await place([w.a.workOrderId, w.b.workOrderId])
  holds.mixed = await place([w.mixed.workOrderId])
  for (const holdId of [holds.b, holds.both]) await ok('office.all', 'PATCH', `/quality/holds/${holdId}`, { version: await versionOf('QualityHold', holdId), note: 'Made-up: check the seams again.' })
  // Cut orders: A's, B's, both customers' and the mixed one's cancelled (cut_order.changed).
  for (const cutOrderId of [cuts.a, cuts.b, cuts.both, cuts.mixed]) {
    await ok('office.all', 'POST', `/production/cut-orders/${cutOrderId}/cancel`, { version: await versionOf('CutOrder', cutOrderId), reason: 'Made-up: planned twice.' })
  }

  const records = await admin<{ text: string }>(
    `SELECT id::text AS text FROM "Inspection" WHERE "workOrderId" IN ($1, $2)
     UNION ALL SELECT number FROM "Inspection" WHERE "workOrderId" IN ($1, $2) AND number IS NOT NULL
     UNION ALL SELECT id::text FROM "QualityRelease" WHERE "workOrderId" = $1
     UNION ALL SELECT id::text FROM "QualityHold" WHERE id IN ($3, $4, $5)
     UNION ALL SELECT number FROM "QualityHold" WHERE id IN ($3, $4, $5)
     UNION ALL SELECT id::text FROM "Nonconformance" WHERE id = $6
     UNION ALL SELECT number FROM "Nonconformance" WHERE id = $6
     UNION ALL SELECT id::text FROM "CutOrder" WHERE id IN ($7, $8, $9)
     UNION ALL SELECT number FROM "CutOrder" WHERE id IN ($7, $8, $9)`,
    [quality.production.workOrderId, w.a.workOrderId, holds.a, holds.both, holds.mixed, holdsSeed.openNcrId, cuts.a, cuts.both, cuts.mixed],
  )
  aMarkers = [...(await markersOf(db, w.a.partyId)), { label: 'mixed work order', text: w.mixed.number }, { label: 'mixed work order', text: w.mixed.workOrderId }, ...records.map((row) => ({ label: 'A record', text: row.text }))]
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('live updates name their brand (PW-04)', { timeout: 120_000 }, () => {
  it("every work order, hold and cut order event names the customers of the record it is about (ids only)", async () => {
    const parties = new Map((await admin<{ id: string; partyId: string | null }>(`SELECT id, "partyId" FROM "WorkOrder" WHERE "tenantId" = $1`, [ids.tenantId])).map((row) => [row.id, row.partyId]))
    const one = await outbox(ONE_WORK_ORDER)
    // The harness's creates, then three changes, three priorities and three holds' moves to ON_HOLD at least.
    expect(one.length).toBeGreaterThanOrEqual(2 + 3 + 3 + 3)
    for (const row of one) {
      expect(Object.hasOwn(row.payload, 'partyId'), `${row.envelope.type} of ${row.payload.number} names its customer`).toBe(true)
      expect(row.payload.partyId, `${row.envelope.type} of ${row.payload.number}`).toBe(parties.get(row.payload.workOrderId as string) ?? null)
    }
    const placed = new Map((await outbox(['quality.hold_placed'])).map((row) => [row.payload.holdId as string, row.payload.partyIds]))
    expect(placed.get(holds.a)).toEqual([w.a.partyId])
    expect(placed.get(holds.b)).toEqual([w.b.partyId])
    expect(placed.get(holds.both)).toEqual([w.a.partyId, w.b.partyId].sort())
    expect(placed.get(holds.mixed)).toEqual([])
    const changed = new Map((await outbox(['quality.hold_changed'])).map((row) => [row.payload.holdId as string, row.payload.partyIds]))
    expect(changed.get(holds.b)).toEqual([w.b.partyId])
    expect(changed.get(holds.both)).toEqual([w.a.partyId, w.b.partyId].sort())
    const cutRows = (await outbox(['cut_order.changed'])).filter((row) => row.payload.change === 'CANCELLED')
    const cutParties = new Map(cutRows.map((row) => [row.payload.cutOrderId as string, row.payload.partyIds]))
    expect(cutParties.get(cuts.a)).toEqual([w.a.partyId])
    expect(cutParties.get(cuts.b)).toEqual([w.b.partyId])
    expect(cutParties.get(cuts.both)).toEqual([w.a.partyId, w.b.partyId].sort())
    expect(cutParties.get(cuts.mixed)).toEqual([])
    // As the database names them: the customers of the cut order's lines' work orders (partyIdsOf: none when one names none).
    for (const row of cutRows) {
      const lines = await admin<{ partyId: string | null }>(`SELECT w."partyId" FROM "CutOrderLine" l JOIN "WorkOrder" w ON w.id = l."workOrderId" WHERE l."cutOrderId" = $1`, [row.payload.cutOrderId])
      expect(row.payload.partyIds).toEqual(partyIdsOf(lines.map((entry) => entry.partyId)))
    }
  })

  it("a person limited to brand B receives no live message about brand A's records, of both brands, or of the mixed work order; B's own reach them", async () => {
    const rows = await outbox([...ONE_WORK_ORDER, ...SHARED])
    const ofA = (row: Outbox) => row.payload.workOrderId === w.a.workOrderId || row.payload.workOrderId === quality.production.workOrderId || [holds.a, cuts.a].includes(row.payload.holdId ?? row.payload.cutOrderId)
    const ofB = (row: Outbox) => row.payload.workOrderId === w.b.workOrderId || [holds.b, cuts.b].includes(row.payload.holdId ?? row.payload.cutOrderId)
    const shared = (row: Outbox) => row.payload.workOrderId === w.mixed.workOrderId || [holds.both, holds.mixed, cuts.both, cuts.mixed].includes(row.payload.holdId ?? row.payload.cutOrderId)
    expect(rows.filter(ofA).length).toBeGreaterThan(0)
    expect(rows.filter(ofB).length).toBeGreaterThan(0)
    expect(rows.filter(shared).length).toBeGreaterThan(0)
    for (const row of rows) {
      const what = `${row.envelope.type} ${row.payload.number ?? row.payload.holdId}`
      // The production unit sees it all.
      expect(liveOf(row, 'office.all'), what).not.toBeNull()
      if (ofA(row)) {
        expect(liveOf(row, 'office.p2'), `B never hears of A's ${what}`).toBeNull()
        expect(liveOf(row, 'office.p1'), `A hears of its own ${what}`).not.toBeNull()
      } else if (ofB(row)) {
        expect(liveOf(row, 'office.p2'), `B hears of its own ${what}`).not.toBeNull()
        expect(liveOf(row, 'office.p1'), `A never hears of B's ${what}`).toBeNull()
      } else if (shared(row)) {
        // Several brands, or a work order of no customer: every-brand readers only.
        expect(liveOf(row, 'office.p2'), `B never hears of the shared ${what}`).toBeNull()
        expect(liveOf(row, 'office.p1'), `A never hears of the shared ${what}`).toBeNull()
      }
    }
  })
})

describe('exports follow their walled lists (PW-04)', { timeout: 120_000 }, () => {

  const numbersOf = (rows: Json[]) => rows.map((row) => row.number as string)

  it('cut orders: office.p2 gets B’s only (never A’s, both brands’ or the mixed one’s); the customer filter follows the screen', async () => {
    const all = numbersOf(await exportRows(cutOrderExport, 'office.all', 'view=all'))
    expect(all).toEqual(expect.arrayContaining(['T-PR09-CO-B', 'T-PR09-CO-AB', 'T-PR09-CO-MIX']))
    expect(numbersOf(await exportRows(cutOrderExport, 'office.p2', 'view=all'))).toEqual(['T-PR09-CO-B'])
    expect(await exportRows(cutOrderExport, 'office.p2', `view=all&party=${w.a.partyId}`)).toEqual([])
    // The production unit's filter of B: the cut orders that cut for B (both brands' one too: it cuts a cell of B's).
    expect(numbersOf(await exportRows(cutOrderExport, 'office.all', `view=all&party=${w.b.partyId}`)).sort()).toEqual(['T-PR09-CO-AB', 'T-PR09-CO-B'])
    expect(() => cutOrderExport.query(new URLSearchParams('party=not-an-id'))).toThrow(/Not a customer/)
  })

  it('inspections and releases: office.p2 gets B’s only; the customer filter follows the screen', async () => {
    const inspectionIds = (rows: Json[]) => rows.map((entry) => entry.row.id as string)
    expect(inspectionIds(await exportRows(inspectionExport, 'office.all', 'view=all'))).toEqual(expect.arrayContaining([quality.openInspectionId, bRows.inspectionId]))
    expect(inspectionIds(await exportRows(inspectionExport, 'office.p2', 'view=all'))).toEqual([bRows.inspectionId])
    expect(await exportRows(inspectionExport, 'office.p2', `view=all&party=${w.a.partyId}`)).toEqual([])
    expect(inspectionIds(await exportRows(inspectionExport, 'office.all', `view=all&party=${w.b.partyId}`))).toEqual([bRows.inspectionId])
    expect(await exportRows(inspectionExport, 'office.p2', 'view=reversed')).toEqual([])
    expect(await exportRows(inspectionExport, 'office.all', `view=reversed&party=${w.b.partyId}`)).toEqual([])
  })

  it('NCRs: office.p2 gets B’s and the hide’s (it names no customer), never A’s; the customer filter follows the screen', async () => {
    const ncrIds = (rows: Json[]) => rows.map((row) => row.id as string)
    expect(ncrIds(await exportRows(ncrExport, 'office.all', 'view=all'))).toEqual(expect.arrayContaining([holdsSeed.openNcrId, bRows.ncrId]))
    const ofB = ncrIds(await exportRows(ncrExport, 'office.p2', 'view=all'))
    expect(ofB).toContain(bRows.ncrId)
    expect(ofB).not.toContain(holdsSeed.openNcrId)
    expect(await exportRows(ncrExport, 'office.p2', `view=all&party=${w.a.partyId}`)).toEqual([])
    expect(ncrIds(await exportRows(ncrExport, 'office.all', `view=all&party=${w.b.partyId}`))).toEqual([bRows.ncrId])
  })

  it('the schedule board: office.p2 gets the bars of B’s work orders only; a published version (every customer’s bars) is refused in words', async () => {
    const orders = (rows: Json[]) => rows.map((row) => row.workOrder as string).sort()
    const woA = (await admin<{ number: string }>(`SELECT number FROM "WorkOrder" WHERE id = $1`, [quality.production.workOrderId]))[0]!.number
    expect(orders(await exportRows(scheduleBoard, 'office.all', `site=${site}`))).toEqual(expect.arrayContaining([woA, w.b.workOrderNumber, w.mixed.number]))
    expect(orders(await exportRows(scheduleBoard, 'office.p2', `site=${site}`))).toEqual([w.b.workOrderNumber])
    expect(await exportRows(scheduleBoard, 'office.p2', `site=${site}&party=${w.a.partyId}`)).toEqual([])
    expect(orders(await exportRows(scheduleBoard, 'office.all', `site=${site}&party=${w.b.partyId}`))).toEqual([w.b.workOrderNumber])
    expect(orders(await exportRows(scheduleBoard, 'office.all', `version=${plans.published}&party=${w.b.partyId}`))).toEqual([w.b.workOrderNumber])
    await expect(exportRows(scheduleBoard, 'office.p2', `version=${plans.published}`)).rejects.toThrow(EVERY_PARTY_WORDS.en)
    const refused = await call('office.p2', 'GET', `/planning/schedule/versions/${plans.published}/board`)
    expect([refused.status, refused.body.error?.message]).toEqual([403, EVERY_PARTY_WORDS.en])
    await ok('office.all', 'GET', `/planning/schedule/versions/${plans.published}/board`)
  })

  it('capacity, the material plan, the master schedule and the daily production report need every customer: refused to office.p2 in words', async () => {
    const daily = reportSourceOf(reportListKey('production.daily'))!
    for (const source of [capacityLoad, mrp, mps, daily]) {
      expect(source.refusal!(actorOf('office.p2')), source.listKey).toBe(EVERY_PARTY_WORDS.en)
      expect(source.refusal!(actorOf('office.all')), source.listKey).toBeNull()
    }
    // The request is refused before a job is queued, in the same words; the production unit's is queued.
    const body = (listKey: string) => ({ listKey, format: 'CSV', query: `site=${site}`, columns: [{ key: 'lane', label: 'Line' }], title: 'Capacity & load', locale: 'en' })
    const refused = await call('office.p2', 'POST', '/exports', body('planning.capacity'))
    expect([refused.status, refused.body.error?.message]).toEqual([403, EVERY_PARTY_WORDS.en])
    // The report's own run walls the same: a person limited to some customers reads no line totals.
    await expect(daily.read(callerOf('office.p2'), daily.query(new URLSearchParams('')), null, 500, { locale: 'en' })).rejects.toThrow(EVERY_PARTY_WORDS.en)
    expect((await daily.read(callerOf('office.all'), daily.query(new URLSearchParams('')), null, 500, { locale: 'en' })).rows.length).toBeGreaterThan(0)
  })
})

describe('nothing brand B’s person received names brand A', { timeout: 60_000 }, () => {
  it('no live view and no file row office.p2 got holds A’s names, codes, numbers or ids', () => {
    expect(seenByB.length).toBeGreaterThan(0)
    expect(findMarkers(seenByB, aMarkers)).toEqual([])
  })
})
