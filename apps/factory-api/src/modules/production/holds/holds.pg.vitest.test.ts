import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { releaseHold } from '../../quality/holds/holds'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from '../testing/two-brands'

/**
 * B-PR-21 — the plain production hold, and PW-03 for its routes (production plan §5 "holds (one dialog)", 08-backend §4.5, R-22;
 * the Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production
 * unit, should be able to see it all. And manage it all as well.").
 *
 * On the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: the
 * WorkOrderHold_guard, WorkOrder_production_holds and the work order and quality hold triggers are real), the core, auth, roles,
 * files, production, numbering and reasons seeds (brand A = the seeds' P1; the HOLD and PRODUCTION_HOLD reason lists) and the
 * production two-brand harness (each brand's DRAFT work order of its own order line, a mixed one made before the one-customer
 * rule); more single-piece drafts of B's line through the real route. Sessions: `office.all` (every customer), `office.p1` /
 * `office.p2` (one customer each), B's viewer without workorders.hold. A quality release is an e-signature: the route asks the
 * office's step-up, so the test calls quality's own release command with another office person.
 *
 *   - place: the reason of the PRODUCTION_HOLD list, the office's note (the office's only), the words the customer reads; the
 *     draft goes ON_HOLD under it with the reason's words (never the note); events and the audit row; the release check names it;
 *   - refusals in words: a quality reason, a reason that asks a note, words on two lines, a cancelled work order, no right;
 *   - two production holds: lifting one keeps the work order held under the other; the last lift puts it back to DRAFT;
 *   - BOTH WAYS ROUND: a quality release lifts the work order only when no production hold remains, a production lift only when
 *     no quality hold remains — it stays held under the hold still standing;
 *   - Hold N: one hold per work order, all or none;
 *   - PW-03: B's person gets 404 on A's work order's hold routes and A's hold, in the words of an unknown id; the production unit
 *     places and lifts on every customer's work order. Every answer B's people got is scanned for A's names, codes and ids.
 * Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/holds`.
 */

const ns = 'pr3b-production-holds'
const ids = twoBrandIds(ns)
const PERMISSIONS: Permission[] = ['workorders.view', 'workorders.manage', 'workorders.hold', 'quality.holds.view', 'quality.holds.place']
const grant = (permissions: Permission[], parties: Grant['parties']): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const SESSIONS: Record<string, SessionContext> = {
  ...twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS),
  // B's person who reads work orders but holds none.
  'office.p2.viewer': { audience: 'office', tenantId: ids.tenantId, actorId: newId(), grants: [grant(['workorders.view'], [ids.b])] },
}
const B_SESSIONS = new Set(['office.p2', 'office.p2.viewer'])

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let aMarkers: Marker[]
const drafts = { b2: '', b3: '', b4: '', cancelled: '' }

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const seenByB: { readonly url: string; readonly body: unknown }[] = []
async function call(sessionName: string, method: Method, url: string, body?: unknown): Promise<{ status: number; body: Json; raw: string }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': sessionName, ...(method === 'POST' ? { 'idempotency-key': newId() } : {}) }, ...(method === 'POST' ? { payload: (body ?? {}) as object } : {}) })
  const parsed = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  if (B_SESSIONS.has(sessionName)) seenByB.push({ url, body: parsed })
  return { status: response.statusCode, body: parsed, raw: response.body }
}
async function ok(sessionName: string, method: Method, url: string, body?: unknown, status = method === 'POST' ? 201 : 200): Promise<Json> {
  const answer = await call(sessionName, method, url, body)
  expect(answer.status, `${method} ${url}: ${answer.raw}`).toBe(status)
  return answer.body
}
async function refused(sessionName: string, method: Method, url: string, body: unknown, status: number): Promise<Json> {
  const answer = await call(sessionName, method, url, body)
  expect(answer.status, `${method} ${url}: ${answer.raw}`).toBe(status)
  return answer.body.error as Json
}
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const holdsOf = (workOrderId: string) => `/production/work-orders/${workOrderId}/holds`
const liftOf = (workOrderId: string, holdId: string) => `/production/work-orders/${workOrderId}/holds/${holdId}/lift`
const workOrderRow = async (id: string) =>
  (await admin<{ status: string; heldFromStatus: string | null; holdReason: string | null; holdRecordType: string | null; holdRecordId: string | null }>(`SELECT status::text, "heldFromStatus"::text AS "heldFromStatus", "holdReason", "holdRecordType", "holdRecordId" FROM "WorkOrder" WHERE id = $1`, [id]))[0]!
const events = async (type: string, holdOrOrder: string) =>
  (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND (payload->>'holdId' = $3 OR payload->>'workOrderId' = $3) ORDER BY "occurredAt", id`, [ids.tenantId, type, holdOrOrder])).map((row) => row.payload)
const activeHolds = async (workOrderId: string) => Number((await admin<{ n: string }>(`SELECT count(*) AS n FROM "WorkOrderHold" WHERE "workOrderId" = $1 AND status = 'ACTIVE'`, [workOrderId]))[0]!.n)

/** Quality's release, by another office person than the one who placed it (the route's step-up is the route's). */
async function releaseQuality(holdId: string, version: number): Promise<Json> {
  const releaser = callerFor(database, { audience: 'office', tenantId: ids.tenantId, actorId: newId(), grants: [grant(['quality.holds.view', 'quality.holds.release'], 'all')], requestId: newId() })
  return (await releaseHold(releaser, holdId, { version, notMakerStatement: true })) as Json
}

/** A single-piece DRAFT of an order line, through the real route. */
async function draftOf(salesOrderLineId: string, size: string): Promise<string> {
  const made = await ok('office.all', 'POST', '/production/work-orders', { siteId: w.siteId, lines: [{ salesOrderLineId, sizes: [{ size, quantity: 1 }] }] })
  return made.workOrder.id as string
}

beforeAll(async () => {
  db = await migratedDatabase('pr3b_prod_holds') // fix-pr-3: a label of at most 20 letters (migratedDatabase)
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const seed of [seedCore, seedAuth, seedRoles, seedFiles]) await seed({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await seedReasons({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(w.a.partyId).toBe(ids.a)
  // B's line keeps 2 of size 50 and 2 of size 54 open (the harness took 2 + 2, the mixed one a 52).
  drafts.b2 = await draftOf(w.b.salesOrderLineId, '50')
  drafts.b3 = await draftOf(w.b.salesOrderLineId, '50')
  drafts.b4 = await draftOf(w.b.salesOrderLineId, '54')
  drafts.cancelled = await draftOf(w.b.salesOrderLineId, '54')
  await ok('office.all', 'POST', `/production/work-orders/${drafts.cancelled}/cancel`, { reason: 'Made-up: made by mistake' }, 200)
  aMarkers = [...(await markersOf(db, w.a.partyId)), { label: 'A work order', text: w.a.workOrderId }, { label: 'A order', text: w.a.salesOrderId }]
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('B-PR-21 a plain production hold: placed with a reason and the words the customer reads', { timeout: 60_000 }, () => {
  let holdId = ''

  it('holds the draft: ON_HOLD under the production hold with the reason’s words (never the office’s note); events and the audit row', async () => {
    const note = 'Made-up: the supplier ships the lining on Friday (office only).'
    const brandWords = 'We wait for a material and tell you the new date.'
    const placed = await ok('office.p2', 'POST', holdsOf(w.b.workOrderId), { reasonCode: 'MATERIAL_MISSING', note, brandWords })
    holdId = placed.hold.id
    expect(placed.held).toBe(true)
    expect(placed.hold).toMatchObject({ workOrderId: w.b.workOrderId, kind: 'PRODUCTION', status: 'ACTIVE', reasonCode: 'MATERIAL_MISSING', reason: 'Material missing', note, brandWords, customerReads: brandWords, requestId: null, liftedAt: null, liftedBy: null, liftReason: null, version: 1 })
    expect(placed.workOrder).toMatchObject({ id: w.b.workOrderId, number: w.b.workOrderNumber, status: 'ON_HOLD', hold: { reason: 'Material missing', fromStatus: 'DRAFT', recordType: 'WorkOrderHold', recordId: holdId } })
    // The floor reads the work order's hold reason: the reason's words, never the office's note.
    expect(await workOrderRow(w.b.workOrderId)).toEqual({ status: 'ON_HOLD', heldFromStatus: 'DRAFT', holdReason: 'Material missing', holdRecordType: 'WorkOrderHold', holdRecordId: holdId })

    expect(await events('work_order_hold.placed', holdId)).toEqual([{ holdId, workOrderId: w.b.workOrderId, number: w.b.workOrderNumber, siteId: w.siteId, partyId: ids.b, kind: 'PRODUCTION', requestId: null }])
    expect(await events('workorder.status_changed', w.b.workOrderId)).toEqual([{ workOrderId: w.b.workOrderId, number: w.b.workOrderNumber, partyId: ids.b, from: 'DRAFT', to: 'ON_HOLD' }])
    const [audit] = await admin<{ recordType: string; after: Json }>(`SELECT "recordType", after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'production.placeHold' AND "recordId" = $2`, [ids.tenantId, w.b.workOrderId])
    expect(audit).toMatchObject({ recordType: 'WorkOrder', after: { holdId, kind: 'PRODUCTION', reasonCode: 'MATERIAL_MISSING', status: 'ON_HOLD', heldFromStatus: 'DRAFT' } })

    const list = await ok('office.p2', 'GET', holdsOf(w.b.workOrderId))
    expect(list.qualityHoldsActive).toBe(0)
    expect(list.holds.map((hold: Json) => [hold.id, hold.status, hold.customerReads])).toEqual([[holdId, 'ACTIVE', brandWords]])
    expect(list.workOrder).toMatchObject({ status: 'ON_HOLD', hold: { recordType: 'WorkOrderHold', recordId: holdId } })
  })

  it('the release check names the production hold once, lifted by Production (not by Quality)', async () => {
    const check = await ok('office.p2', 'GET', `/production/work-orders/${w.b.workOrderId}/release-check`)
    const holds = (check.checks as Json[]).find((entry) => entry.code === 'HOLDS')!
    expect(holds.state).toBe('BLOCKED')
    expect(holds.problems).toEqual([{ path: 'checks/HOLDS', message: expect.stringMatching(/^On hold since \d{4}-\d{2}-\d{2}: Material missing\. Lift the production hold first\.$/) }])
  })

  it('a customer without its own words reads the reason’s words', async () => {
    const placed = await ok('office.all', 'POST', holdsOf(drafts.b4), { reasonCode: 'CAPACITY' })
    expect(placed.hold).toMatchObject({ brandWords: null, note: null, customerReads: 'Capacity' })
    await ok('office.all', 'POST', liftOf(drafts.b4, placed.hold.id), { version: 1, reason: 'Made-up: a line freed up' }, 200)
    expect((await workOrderRow(drafts.b4)).status).toBe('DRAFT')
  })

  it('refuses in words: a quality reason, a reason that asks a note, words on two lines, a cancelled work order, no right to hold', async () => {
    const quality = await refused('office.p2', 'POST', holdsOf(drafts.b3), { reasonCode: 'QUALITY_CHECK' }, 400)
    expect(quality.issues).toEqual([{ path: 'body/reasonCode', message: 'Pick an active reason of the production hold list.' }])
    const other = await refused('office.p2', 'POST', holdsOf(drafts.b3), { reasonCode: 'OTHER' }, 400)
    expect(other.issues).toEqual([{ path: 'body/note', message: 'Other needs a note: say what is missing or wrong.' }])
    const lines = await refused('office.p2', 'POST', holdsOf(drafts.b3), { reasonCode: 'CAPACITY', brandWords: 'one\ntwo' }, 400)
    expect(lines.issues).toEqual([{ path: 'body/brandWords', message: 'One line, without line breaks.' }])
    const cancelled = await refused('office.p2', 'POST', holdsOf(drafts.cancelled), { reasonCode: 'CAPACITY' }, 409)
    expect(cancelled.message).toMatch(/^Work order .+ is cancelled: nothing is left to hold\.$/)
    expect((await refused('office.p2.viewer', 'POST', holdsOf(drafts.b3), { reasonCode: 'CAPACITY' }, 403)).code).toBe('forbidden')
    // The viewer reads them.
    expect((await ok('office.p2.viewer', 'GET', holdsOf(w.b.workOrderId))).holds).toHaveLength(1)
    expect(await activeHolds(drafts.b3)).toBe(0)
    expect(await activeHolds(drafts.cancelled)).toBe(0)
    // A lift says why, at the version read.
    expect((await refused('office.p2', 'POST', liftOf(w.b.workOrderId, holdId), { version: 1, reason: '  ' }, 400)).issues).toEqual([{ path: 'body/reason', message: 'Say why the hold is lifted.' }])
    expect((await refused('office.p2', 'POST', liftOf(w.b.workOrderId, holdId), { version: 7, reason: 'Made-up: arrived' }, 409)).code).toBe('conflict')
    expect((await refused('office.p2.viewer', 'POST', liftOf(w.b.workOrderId, holdId), { version: 1, reason: 'Made-up: arrived' }, 403)).code).toBe('forbidden')
  })

  it('a second production hold keeps it held; lifting one keeps it ON_HOLD under the other; the last lift puts it back to DRAFT', async () => {
    const second = await ok('office.p2', 'POST', holdsOf(w.b.workOrderId), { reasonCode: 'OTHER', note: 'Made-up: the pattern is checked again.' })
    expect(second.held).toBe(false)
    expect((await workOrderRow(w.b.workOrderId)).holdRecordId).toBe(holdId)
    expect(await events('workorder.status_changed', w.b.workOrderId)).toHaveLength(1)

    const first = await ok('office.p2', 'POST', liftOf(w.b.workOrderId, holdId), { version: 1, reason: 'Made-up: the lining arrived' }, 200)
    expect(first).toMatchObject({ lifted: false, stillHeldBy: { quality: 0, production: 1 }, hold: { id: holdId, status: 'LIFTED', liftReason: 'Made-up: the lining arrived', version: 2 } })
    expect(await workOrderRow(w.b.workOrderId)).toEqual({ status: 'ON_HOLD', heldFromStatus: 'DRAFT', holdReason: 'Other', holdRecordType: 'WorkOrderHold', holdRecordId: second.hold.id })
    // A lifted hold never changes.
    expect((await refused('office.p2', 'POST', liftOf(w.b.workOrderId, holdId), { version: 2, reason: 'Made-up: again' }, 409)).message).toBe('This hold is lifted already: a lifted hold never changes.')

    const last = await ok('office.p2', 'POST', liftOf(w.b.workOrderId, second.hold.id), { version: 1, reason: 'Made-up: pattern fine' }, 200)
    expect(last).toMatchObject({ lifted: true, stillHeldBy: { quality: 0, production: 0 }, workOrder: { status: 'DRAFT', hold: null } })
    expect(await workOrderRow(w.b.workOrderId)).toEqual({ status: 'DRAFT', heldFromStatus: null, holdReason: null, holdRecordType: null, holdRecordId: null })
    expect((await events('work_order_hold.lifted', second.hold.id))[0]).toMatchObject({ holdId: second.hold.id, partyId: ids.b, kind: 'PRODUCTION', requestId: null })
    expect((await events('workorder.status_changed', w.b.workOrderId)).at(-1)).toMatchObject({ from: 'ON_HOLD', to: 'DRAFT' })
    const list = await ok('office.p2', 'GET', holdsOf(w.b.workOrderId))
    expect(list.holds.map((hold: Json) => hold.status)).toEqual(['LIFTED', 'LIFTED'])
    expect(list.workOrder.hold).toBeNull()
  })
})

describe('B-PR-21 both ways round: the work order leaves ON_HOLD only when no hold names it any more', { timeout: 60_000 }, () => {
  it('quality first: the quality release keeps it held under the production hold; the production lift then puts it back', async () => {
    const quality = await ok('office.all', 'POST', '/quality/holds', { subjectType: 'WorkOrder', subjectIds: [drafts.b2], reasonCode: 'QUALITY_CHECK', reasonNote: 'Made-up: stitching sample out of tolerance' })
    expect(quality.workOrdersHeld).toEqual([expect.objectContaining({ id: drafts.b2, from: 'DRAFT' })])
    const production = await ok('office.p2', 'POST', holdsOf(drafts.b2), { reasonCode: 'CAPACITY' })
    expect(production.held).toBe(false)
    expect((await ok('office.p2', 'GET', holdsOf(drafts.b2))).qualityHoldsActive).toBe(1)

    const released = await releaseQuality(quality.hold.id, quality.hold.version)
    expect(released.workOrdersLifted).toEqual([])
    expect(await workOrderRow(drafts.b2)).toEqual({ status: 'ON_HOLD', heldFromStatus: 'DRAFT', holdReason: 'Capacity', holdRecordType: 'WorkOrderHold', holdRecordId: production.hold.id })

    const lifted = await ok('office.p2', 'POST', liftOf(drafts.b2, production.hold.id), { version: 1, reason: 'Made-up: capacity found' }, 200)
    expect(lifted).toMatchObject({ lifted: true, stillHeldBy: { quality: 0, production: 0 }, workOrder: { status: 'DRAFT' } })
  })

  it('production first: the production lift keeps it held under the quality hold; the quality release then puts it back', async () => {
    const production = await ok('office.p2', 'POST', holdsOf(drafts.b2), { reasonCode: 'MACHINE' })
    expect(production.held).toBe(true)
    const quality = await ok('office.all', 'POST', '/quality/holds', { subjectType: 'WorkOrder', subjectIds: [drafts.b2], reasonCode: 'QUALITY_CHECK', reasonNote: 'Made-up: shade check' })
    // Already ON_HOLD: the quality hold stands beside the production one.
    expect(quality.workOrdersHeld).toEqual([])
    expect((await workOrderRow(drafts.b2)).holdRecordId).toBe(production.hold.id)

    const lifted = await ok('office.p2', 'POST', liftOf(drafts.b2, production.hold.id), { version: 1, reason: 'Made-up: the machine runs again' }, 200)
    expect(lifted).toMatchObject({ lifted: false, stillHeldBy: { quality: 1, production: 0 }, workOrder: { status: 'ON_HOLD', hold: { recordType: 'QualityHold', recordId: quality.hold.id } } })
    const row = await workOrderRow(drafts.b2)
    expect(row).toMatchObject({ status: 'ON_HOLD', heldFromStatus: 'DRAFT', holdRecordType: 'QualityHold', holdRecordId: quality.hold.id })
    expect(row.holdReason).toMatch(/shade check/)

    const released = await releaseQuality(quality.hold.id, quality.hold.version)
    expect(released.workOrdersLifted).toEqual([expect.objectContaining({ id: drafts.b2, to: 'DRAFT' })])
    expect((await workOrderRow(drafts.b2)).status).toBe('DRAFT')
  })
})

describe('B-PR-21 Hold N with a production reason: one hold per work order, all or none', { timeout: 60_000 }, () => {
  it('refuses the whole list in words when one work order takes no hold, or one is named twice; then holds every one', async () => {
    const before = Number((await admin<{ n: string }>(`SELECT count(*) AS n FROM "WorkOrderHold" WHERE "tenantId" = $1`, [ids.tenantId]))[0]!.n)
    const one = await refused('office.p2', 'POST', '/production/work-orders/holds', { workOrderIds: [drafts.b3, drafts.cancelled], reasonCode: 'CAPACITY' }, 409)
    expect(one.message).toMatch(/is cancelled: nothing is left to hold\.$/)
    const twice = await refused('office.p2', 'POST', '/production/work-orders/holds', { workOrderIds: [drafts.b3, drafts.b3], reasonCode: 'CAPACITY' }, 400)
    expect(twice.issues).toEqual([{ path: 'body/workOrderIds/1', message: 'Name each work order once.' }])
    expect(Number((await admin<{ n: string }>(`SELECT count(*) AS n FROM "WorkOrderHold" WHERE "tenantId" = $1`, [ids.tenantId]))[0]!.n)).toBe(before)
    expect((await workOrderRow(drafts.b3)).status).toBe('DRAFT')

    const placed = await ok('office.p2', 'POST', '/production/work-orders/holds', { workOrderIds: [drafts.b3, drafts.b4], reasonCode: 'TECHNICAL_QUESTION', brandWords: 'We check a detail of your design.' })
    expect(placed.workOrders.map((entry: Json) => [entry.id, entry.status, entry.held])).toEqual([
      [drafts.b3, 'ON_HOLD', true],
      [drafts.b4, 'ON_HOLD', true],
    ])
    expect(placed.holds.map((hold: Json) => [hold.workOrderId, hold.kind, hold.customerReads])).toEqual([
      [drafts.b3, 'PRODUCTION', 'We check a detail of your design.'],
      [drafts.b4, 'PRODUCTION', 'We check a detail of your design.'],
    ])
    expect(await activeHolds(drafts.b3)).toBe(1)
    expect(await activeHolds(drafts.b4)).toBe(1)
  })
})

describe('PW-03 the hold routes behind the brand wall', { timeout: 60_000 }, () => {
  it('B’s person: A’s work order and the mixed one are not found on every hold route, in the words of an unknown id', async () => {
    const unknown = newId()
    for (const workOrderId of [unknown, w.a.workOrderId, w.mixed.workOrderId]) {
      expect((await refused('office.p2', 'GET', holdsOf(workOrderId), undefined, 404)).message).toBe('Work order not found.')
      expect((await refused('office.p2', 'POST', holdsOf(workOrderId), { reasonCode: 'CAPACITY' }, 404)).message).toBe('Work order not found.')
      expect((await refused('office.p2', 'POST', liftOf(workOrderId, newId()), { version: 1, reason: 'Made-up' }, 404)).message).toBe('Work order not found.')
    }
    // Hold N with A's work order among B's: refused at its place in the list, as a made-up id is.
    const withA = await refused('office.p2', 'POST', '/production/work-orders/holds', { workOrderIds: [drafts.b2, w.a.workOrderId], reasonCode: 'CAPACITY' }, 400)
    const withUnknown = await refused('office.p2', 'POST', '/production/work-orders/holds', { workOrderIds: [drafts.b2, unknown], reasonCode: 'CAPACITY' }, 400)
    expect(withA.issues).toEqual([{ path: 'body/workOrderIds/1', message: 'Work order not found.' }])
    expect([withA.message, withA.issues]).toEqual([withUnknown.message, withUnknown.issues])
    expect(await activeHolds(drafts.b2)).toBe(0)
    expect(await activeHolds(w.a.workOrderId)).toBe(0)
    // And the other way round: A's person never reaches B's.
    expect((await refused('office.p1', 'GET', holdsOf(w.b.workOrderId), undefined, 404)).message).toBe('Work order not found.')
  })

  it('the production unit holds and lifts on every customer’s work order; B’s person never reaches A’s hold, even through B’s own work order', async () => {
    const onA = await ok('office.all', 'POST', holdsOf(w.a.workOrderId), { reasonCode: 'PAYMENT', note: 'Made-up: deposit not in yet.' })
    expect(onA.hold).toMatchObject({ kind: 'PRODUCTION', workOrderId: w.a.workOrderId })
    expect((await ok('office.all', 'GET', holdsOf(w.a.workOrderId))).holds).toHaveLength(1)
    // A's hold asked through B's own work order: as unknown as a made-up id.
    expect((await refused('office.p2', 'POST', liftOf(w.b.workOrderId, onA.hold.id), { version: 1, reason: 'Made-up' }, 404)).message).toBe('Hold not found.')
    expect((await refused('office.p2', 'POST', liftOf(w.b.workOrderId, newId()), { version: 1, reason: 'Made-up' }, 404)).message).toBe('Hold not found.')
    expect((await refused('office.p2', 'POST', liftOf(w.a.workOrderId, onA.hold.id), { version: 1, reason: 'Made-up' }, 404)).message).toBe('Work order not found.')
    expect(await activeHolds(w.a.workOrderId)).toBe(1)
    // B's person wrote no audit row about A.
    const p2 = (SESSIONS['office.p2'] as { readonly actorId: string }).actorId
    expect(await admin(`SELECT 1 FROM "AuditLog" WHERE "actorId" = $1 AND "recordId" = ANY($2::uuid[])`, [p2, [w.a.workOrderId, onA.hold.id]])).toEqual([])
    const lifted = await ok('office.all', 'POST', liftOf(w.a.workOrderId, onA.hold.id), { version: 1, reason: 'Made-up: deposit paid' }, 200)
    expect(lifted).toMatchObject({ lifted: true, workOrder: { status: 'DRAFT' } })
    // The hold events name A only, so only people who reach A see them live.
    expect((await events('work_order_hold.placed', onA.hold.id))[0]).toMatchObject({ partyId: ids.a })
  })

  it('no answer B’s people got names anything of A’s', () => {
    const leaks = seenByB.flatMap((seen) => findMarkers(JSON.stringify(seen.body), aMarkers).map((marker) => `${seen.url}: ${marker}`))
    expect(leaks).toEqual([])
  })
})
