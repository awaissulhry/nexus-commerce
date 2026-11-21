import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { stageNoticeKey } from '@nexus/factory-domain/production-brand/notices'
import type { BrandStage } from '@nexus/factory-domain/production-brand/stages'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../../platform/outbox/system'
import { orderHistory } from '../../sales/portal-orders/store'
import { productionTwoBrands, twoBrandIds, twoBrandSessions, type OfficeSession, type ProductionTwoBrands } from '../testing/two-brands'
import { brandKeeperHandler, CLEAR_BRAND_STAGE, keepOrder, SET_BRAND_STAGE, STAGE_TOLD } from './keeper'
import { STAGE_UNTOLD } from './keeper' // B-SC-004

/**
 * B-MS-005 — the office sets an order's stage by hand, changes it and clears it (set-the-stage-by-hand plan.md D1–D9, design A;
 * review fixes R1, R4, R6, R9, R11, R12, R15, R19). The Owner rule 2026-11-16: "One brand must not be able to see anything related
 * to any other brand. But we, as the production unit, should be able to see it all. And manage it all as well."
 *
 * On a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, BrandOrderProduction's guard —
 * `stage` equals the hand stage while it stands, the setter an active office person — and the partner role's hidden columns are
 * real), the core, auth, roles, files, production and numbering seeds and the production two-brand harness (brand A = the seeds'
 * P1, brand B = the threads' second brand). The test makes its own orders of one goods line (status set by the admin pool, the
 * database's rules off for that one statement, as the keeper's tests do), a work order through the real route, a bundle copied
 * from the seed's (the floor's CUT), and a customer's pause (an ACTIVE BRAND hold). The setters are the seeds' owner and member:
 * real active office people (the guard refuses anyone else).
 *
 *   - R1: an In production order with NO production state and no work order (as SEED-SO-W39-02) set to Cutting: the row is made,
 *     the stage Cutting, the customer told once ("Cutting has started": the first stage Preparing is never news).
 *   - a Planner sets Sewing over Preparing: one stage_reached, one STAGE_TOLD marker; the partner role reads the plain Sewing and
 *     never the hand columns.
 *   - refusals in words: Something else without a note, a note of two lines or too long (400); the stage the customer reads
 *     already — also the LIVE floor's while the keeper's stored stage lags behind (R12) — the floor's own stage while a hand stage
 *     stands, a Confirmed order (R4), the customer's own pause (R19; our own hold allows it), a stale version and a null version
 *     beside a row (R9), a Clear with none (409); Sales (403); nothing written, nothing told.
 *   - B-SC-004 (stage control B): Ready to ship by hand taken (told by hand, the status stays quality's); Preparing set back over
 *     a told Cutting — one correction, the stages above untold, and Clear back to Cutting tells it again by hand; a stage moved
 *     back inside its window is left untold silently, never corrected.
 *   - the wall (R11): office.p2 on A's order and on an unknown id — PUT and DELETE — "Sales order not found.", word for word; no
 *     audit row about A's order.
 *   - Change higher: told; Change lower inside the window: written, the stage it leaves untold (never corrected); Clear: the live
 *     floor's stage on its own day (R15), nothing told; set → cancelled → the keeper gives back where the work reached, on the
 *     floor's own day.
 *   - R6: the SalesOrder audit rows carry from → to as `stage` and never a `status` key; the portal's order history reads nothing new.
 *
 * Every name and note is made up. Run with `env -u FACTORY_REDIS_URL node scripts/factory/run-pg-tests.mjs modules/production/brand/stage`.
 */

vi.setConfig({ testTimeout: 120_000 })

type Json = Record<string, any>
type Method = 'PUT' | 'DELETE'
const ns = 'ms-b02-stage'
const ids = twoBrandIds(ns)
const owner = seedUuid(ns, 'actor')
const member = seedUuid(ns, 'user:member')
const MANAGE: Permission[] = ['orders.view', 'workorders.view', 'workorders.manage', 'production.brand.manage']
const office = (actorId: string, permissions: Permission[], parties: 'all' | string[] = 'all'): OfficeSession => ({ audience: 'office', tenantId: ids.tenantId, actorId, grants: [{ permissions, companies: 'all', sites: 'all', parties }] })
const SESSIONS: Record<string, OfficeSession> = {
  ...twoBrandSessions(ids.tenantId, ids.a, ids.b, MANAGE),
  // The seeds' owner and member: active office people, a Planner's right (production.brand.manage) over every customer.
  'office.planner': office(owner, MANAGE),
  'office.planner2': office(member, MANAGE),
  // Sales: sees the order and its production, never sets its stage.
  'office.sales': office(newId(), ['orders.view', 'workorders.view']),
}
const NOTE = 'Made-up: the tablets in the cutting room were down all morning.'

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let colourwayId = ''
let seededBundle = ''

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const lit = (value: string): string => {
  if (!isUuid(value)) throw new Error(`not an id: ${value}`)
  return `'${value}'`
}
/** One statement with the database's rules off (the harness's way to place facts made elsewhere). */
const raw = (statements: string): Promise<unknown> => db.admin.query(`BEGIN; SET LOCAL session_replication_role = replica; ${statements} COMMIT;`)
const system = () => callerFor(database, systemContext(ids.tenantId, `t-${newId()}`))

async function call(session: string, method: Method, url: string, payload?: unknown): Promise<{ status: number; body: Json; raw: string }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, 'idempotency-key': newId() }, ...(payload === undefined ? {} : { payload: payload as object }) })
  const body = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  return { status: response.statusCode, body, raw: response.body }
}
async function ok(session: string, method: Method, url: string, payload?: unknown): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.status, `${method} ${url}: ${answer.raw.slice(0, 600)}`).toBe(200)
  return answer.body
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const answer = await call(session, method, url, payload)
  expect(answer.status, `${method} ${url}: ${answer.raw.slice(0, 600)}`).toBe(status)
  return answer.body.error ?? {}
}
const stageUrl = (orderId: string) => `/production/brand-orders/${orderId}/stage`
const set = (session: string, orderId: string, body: Json) => ok(session, 'PUT', stageUrl(orderId), body)
const clear = (session: string, orderId: string, version: number) => ok(session, 'DELETE', `${stageUrl(orderId)}?version=${version}`)

const rowOf = (orderId: string) =>
  one<Json>(
    `SELECT id, stage::text AS stage, "stageAt", "stageSet"::text AS "stageSet", "stageSetReason"::text AS reason, "stageSetNote" AS note, "stageSetAt" AS "setAt", "stageSetById" AS "setById", version FROM "BrandOrderProduction" WHERE key = $1`,
    [`brand-production:${orderId}`],
  )
const hasRow = async (orderId: string) => (await admin(`SELECT 1 FROM "BrandOrderProduction" WHERE key = $1`, [`brand-production:${orderId}`])).length > 0
const versionOf = async (orderId: string): Promise<number> => (await rowOf(orderId)).version as number

interface Told {
  readonly id: string
  readonly subject: string
  readonly payload: Json
}
const told = (): Promise<Told[]> => admin<Told>(`SELECT id, subject, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'brand_production.stage_reached' ORDER BY "occurredAt", id`, [ids.tenantId])
const toldSince = async (before: readonly Told[], orderId: string): Promise<Json[]> => {
  const seen = new Set(before.map((event) => event.id))
  return (await told()).filter((event) => !seen.has(event.id) && event.subject === orderId).map((event) => event.payload)
}
const markersOf = async (orderId: string): Promise<string[]> =>
  (await admin<{ after: Json }>(`SELECT a.after FROM "AuditLog" a JOIN "BrandOrderProduction" p ON p.id = a."recordId" WHERE a."recordType" = 'BrandOrderProduction' AND a.action = $2 AND p.key = $1 ORDER BY a.at, a.id`, [`brand-production:${orderId}`, STAGE_TOLD])).map((row) => row.after.stage as string)
/** Every audit row about an order: its own and its production row's. */
const auditsAbout = async (orderId: string): Promise<number> =>
  (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "recordId" = $1 OR "recordId" IN (SELECT id FROM "BrandOrderProduction" WHERE "salesOrderId" = $1)`, [orderId])).n
const orderAudits = (orderId: string) =>
  admin<{ action: string; before: Json; after: Json; reason: string | null }>(`SELECT action, before, after, reason FROM "AuditLog" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1 AND action IN ($2, $3) ORDER BY at, id`, [orderId, SET_BRAND_STAGE, CLEAR_BRAND_STAGE])
const reachedOf = async (orderId: string) => [...(await system().withClient((client) => orderHistory(client, orderId))).reached.entries()].map(([status, at]) => [status, at.toISOString()])

/** A made-up order of a customer with one goods line (sizes 50 × 2, 52 × 2), at the status asked. */
async function newOrder(partyId: string, label: string, status = 'IN_PRODUCTION'): Promise<{ orderId: string; lineId: string }> {
  const orderId = newId()
  const lineId = newId()
  await database.withScope({ audience: 'office', tenantId: ids.tenantId, actorId: owner }, (client) =>
    client.$transaction(async (tx) => {
      await tx.salesOrder.create({
        data: { id: orderId, companyId: w.companyId, partyId, number: `T-MS005-${label}-${orderId.slice(-6)}`, customerRef: `T-MS005-PO-${orderId.slice(-6)}`, status: 'CONFIRMED', orderDate: new Date('2026-11-05T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-18T00:00:00.000Z') },
        select: { id: true },
      })
      await tx.salesOrderLine.create({
        data: { id: lineId, companyId: w.companyId, orderId, partyId, seq: 10, kind: 'SIZE_GRID', styleId: w.styleId, colourwayId, quantity: 4, unitPrice: '100.000000', netAmount: 40_000, vatRatePct: '22.00', vatAmount: 8_800 },
        select: { id: true },
      })
      await tx.salesOrderLineSize.createMany({ data: [['50', 2], ['52', 2]].map(([size, quantity]) => ({ id: newId(), lineId, partyId, size: size as string, quantity: quantity as number })) })
    }),
  )
  if (status !== 'CONFIRMED') await raw(`UPDATE "SalesOrder" SET status = '${status}' WHERE id = ${lit(orderId)};`)
  return { orderId, lineId }
}

/** A work order of the order's line through the real route (DRAFT), and its cell of size 50. */
async function workOrderOf(lineId: string): Promise<{ workOrderId: string; cellId: string }> {
  const made = await app.inject({ method: 'POST', url: '/production/work-orders', headers: { 'x-test-session': 'office.planner' }, payload: { siteId: w.siteId, lines: [{ salesOrderLineId: lineId, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 2 }] }] } })
  expect(made.statusCode, made.body).toBe(201)
  const workOrderId = (made.json() as { workOrder: { id: string } }).workOrder.id
  return { workOrderId, cellId: (await one<{ id: string }>(`SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1 AND size = '50'`, [workOrderId])).id }
}

/** A copy of the seed's bundle on a cell (cut: the floor's CUT signal), placed without the keeper running. */
async function bundleOn(workOrderId: string, cellId: string): Promise<void> {
  const id = newId()
  await raw(`INSERT INTO "Bundle" SELECT (jsonb_populate_record(NULL::"Bundle", to_jsonb(b) || jsonb_build_object('id', ${lit(id)}, 'workOrderId', ${lit(workOrderId)}, 'workOrderSizeId', ${lit(cellId)}, 'code', 'T-MS005-BN-${id.slice(-8)}', 'replacedCodes', '[]'::jsonb, 'clientEventId', NULL, 'status', 'ACTIVE'))).* FROM "Bundle" b WHERE b.id = ${lit(seededBundle)};`)
}

/** An ACTIVE hold on a work order (BRAND: the customer's own pause; PRODUCTION: our own). */
async function holdOn(workOrderId: string, partyId: string, kind: 'BRAND' | 'PRODUCTION'): Promise<string> {
  const holdId = newId()
  await raw(`INSERT INTO "WorkOrderHold" (id, "tenantId", "companyId", "siteId", "workOrderId", "partyId", kind, "reasonCode", status, "placedAt", "placedById") VALUES (${lit(holdId)}, ${lit(ids.tenantId)}, ${lit(w.companyId)}, ${lit(w.siteId)}, ${lit(workOrderId)}, ${lit(partyId)}, '${kind}', 'OTHER', 'ACTIVE', now(), ${lit(owner)});
    UPDATE "WorkOrder" SET status = 'ON_HOLD', "heldFromStatus" = 'DRAFT', "heldAt" = now(), "heldById" = ${lit(owner)}, "holdReason" = 'Made-up hold', "holdRecordType" = 'WorkOrderHold', "holdRecordId" = ${lit(holdId)} WHERE id = ${lit(workOrderId)};`)
  return holdId
}
const lift = (holdId: string, workOrderId: string) =>
  raw(`UPDATE "WorkOrderHold" SET status = 'LIFTED', "liftedAt" = now(), "liftedById" = ${lit(owner)}, "liftReason" = 'Made-up resume' WHERE id = ${lit(holdId)};
    UPDATE "WorkOrder" SET status = 'DRAFT', "heldFromStatus" = NULL, "heldAt" = NULL, "heldById" = NULL, "holdReason" = NULL, "holdRecordType" = NULL, "holdRecordId" = NULL WHERE id = ${lit(workOrderId)};`)

beforeAll(async () => {
  db = await migratedDatabase('ms_b02_stage')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const seed of [seedCore, seedAuth, seedRoles, seedFiles]) await seed({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(w.a.partyId).toBe(ids.a)
  colourwayId = (await one<{ colourwayId: string }>(`SELECT "colourwayId" FROM "SalesOrderLine" WHERE id = $1`, [w.a.salesOrderLineId])).colourwayId
  const seedWo = (await one<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = 'SEED-WO-0001'`, [ids.tenantId])).id
  seededBundle = (await one<{ id: string }>(`SELECT id FROM "Bundle" WHERE "workOrderId" = $1 ORDER BY id LIMIT 1`, [seedWo])).id
  // The setters are real active office people (the database's guard refuses anyone else).
  expect(await admin(`SELECT id FROM "User" WHERE id IN ($1, $2) AND status = 'ACTIVE' AND audience = 'OFFICE'`, [owner, member])).toHaveLength(2)
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('B-MS-005: set the stage by hand (production.brand.manage)', () => {
  it('R1: an In production order with no production state and no work order, set to Cutting — the row is made, Cutting, the customer told once', async () => {
    const { orderId } = await newOrder(ids.a, 'R1')
    expect(await hasRow(orderId)).toBe(false)
    const before = await told()
    const answer = await set('office.planner', orderId, { stage: 'CUTTING', reasonCode: 'OUTAGE', note: `  ${NOTE}  `, version: null })
    expect(answer).toEqual({
      orderId,
      floor: 'PREPARING',
      stage: 'CUTTING',
      byHand: { stage: 'CUTTING', reasonCode: 'OUTAGE', note: NOTE, setAt: expect.any(String), setBy: { id: owner, name: 'Seed Owner' } },
      version: 2,
    })
    expect(await rowOf(orderId)).toMatchObject({ stage: 'CUTTING', stageSet: 'CUTTING', reason: 'OUTAGE', note: NOTE, setById: owner, version: 2 })
    // Made at Preparing (its first-stage marker), then Cutting from Preparing: the customer's notice rule tells Cutting alone.
    const events = await toldSince(before, orderId)
    // B-MS-008: the set's tell says it was by hand (its notice waits the undo window); the keeper's first stage does not.
    expect(events).toEqual([
      { orderId, partyId: ids.a, stage: 'PREPARING', previous: null },
      { orderId, partyId: ids.a, stage: 'CUTTING', previous: 'PREPARING', byHand: true },
    ])
    expect(events.map((event) => stageNoticeKey(event as { stage: BrandStage; previous: BrandStage | null }, 'CUTTING')).filter((key) => key !== null)).toEqual(['portal.production.cutting'])
    expect(await markersOf(orderId)).toEqual(['PREPARING', 'CUTTING'])
  })

  it('a Planner sets Sewing over Preparing: one stage_reached, one STAGE_TOLD; the customer’s role reads the plain stage, never the hand columns', async () => {
    const { orderId } = await newOrder(ids.b, 'SEW')
    await keepOrder(system(), orderId, { what: 'test' })
    const made = await rowOf(orderId)
    expect(made).toMatchObject({ stage: 'PREPARING', stageSet: null })
    const before = await told()
    const answer = await set('office.planner', orderId, { stage: 'SEWING', reasonCode: 'FEW_PEOPLE', version: made.version })
    expect(answer).toMatchObject({ floor: 'PREPARING', stage: 'SEWING', byHand: { stage: 'SEWING', reasonCode: 'FEW_PEOPLE', note: null }, version: made.version + 1 })
    expect(await toldSince(before, orderId)).toEqual([{ orderId, partyId: ids.b, stage: 'SEWING', previous: 'PREPARING', byHand: true }]) // B-MS-008
    expect(await markersOf(orderId)).toEqual(['PREPARING', 'SEWING'])
    // B's portal role: the plain Sewing of its own order; each of the five columns is denied.
    const portalB = { audience: 'partner' as const, tenantId: ids.tenantId, actorId: w.second.userId, partyId: ids.b }
    expect(await database.withScope(portalB, (client) => client.$queryRawUnsafe<Json[]>(`SELECT stage::text AS stage FROM "BrandOrderProduction" WHERE "salesOrderId" = '${orderId}'::uuid`))).toEqual([{ stage: 'SEWING' }])
    for (const column of ['stageSet', 'stageSetReason', 'stageSetNote', 'stageSetAt', 'stageSetById']) {
      await expect(database.withScope(portalB, (client) => client.$queryRawUnsafe(`SELECT "${column}" FROM "BrandOrderProduction" LIMIT 1`)), column).rejects.toThrow(/permission denied/)
    }
  })

  it('refused in words: the stage the customer reads already (409), Something else without a note, a note of two lines or too long (400); nothing written, nothing told', async () => {
    const { orderId } = await newOrder(ids.a, 'ASK')
    await keepOrder(system(), orderId, { what: 'test' })
    const version = await versionOf(orderId)
    const before = await told()
    // B-SC-004: Preparing is no longer refused as such — here it is the stage the customer reads already.
    expect((await refused('office.planner', 'PUT', stageUrl(orderId), { stage: 'PREPARING', reasonCode: 'OUTAGE', version }, 409)).message).toBe('The customer already reads Preparing.')
    const other = await refused('office.planner', 'PUT', stageUrl(orderId), { stage: 'SEWING', reasonCode: 'OTHER', note: '   ', version }, 400)
    expect(other.issues).toEqual([{ path: 'body/note', message: 'Something else needs a note.' }])
    await refused('office.planner', 'PUT', stageUrl(orderId), { stage: 'SEWING', reasonCode: 'OUTAGE', note: 'Made-up first line\nand a second one', version }, 400)
    await refused('office.planner', 'PUT', stageUrl(orderId), { stage: 'SEWING', reasonCode: 'OUTAGE', note: 'x'.repeat(201), version }, 400)
    expect(await rowOf(orderId)).toMatchObject({ stage: 'PREPARING', stageSet: null, version })
    expect(await toldSince(before, orderId)).toEqual([])
  })

  it('R12: the LIVE floor’s stage — the keeper has not followed the cut yet — is the one the customer reads: 409 in words; nothing written, nothing told', async () => {
    const { orderId, lineId } = await newOrder(ids.a, 'FLOOR')
    const { workOrderId, cellId } = await workOrderOf(lineId)
    await keepOrder(system(), orderId, { what: 'test' })
    await bundleOn(workOrderId, cellId)
    // The stored stage still reads Preparing; the floor's is Cutting.
    const stored = await rowOf(orderId)
    expect(stored.stage).toBe('PREPARING')
    const before = await told()
    expect((await refused('office.planner', 'PUT', stageUrl(orderId), { stage: 'CUTTING', reasonCode: 'OUTAGE', version: stored.version }, 409)).message).toBe('The customer already reads Cutting.')
    expect(await rowOf(orderId)).toMatchObject({ stage: 'PREPARING', stageSet: null, version: stored.version })
    expect(await toldSince(before, orderId)).toEqual([])
    // Ahead of the live floor it is taken; the floor's own Cutting, reached in this same command, is told first.
    const answer = await set('office.planner', orderId, { stage: 'SEWING', reasonCode: 'OUTAGE', version: stored.version })
    expect(answer).toMatchObject({ floor: 'CUTTING', stage: 'SEWING', byHand: { stage: 'SEWING' } })
    expect((await toldSince(before, orderId)).map((event) => [event.stage, event.previous])).toEqual([['CUTTING', 'PREPARING'], ['SEWING', 'CUTTING']])
  })

  it('R4, R19: a Confirmed order and the customer’s own pause are refused in words (409); during our own hold it is taken', async () => {
    const confirmed = await newOrder(ids.a, 'CONF', 'CONFIRMED')
    expect((await refused('office.planner', 'PUT', stageUrl(confirmed.orderId), { stage: 'CUTTING', reasonCode: 'OUTAGE', version: null }, 409)).message).toBe(
      'Production has not started yet: a stage is set by hand only once the order is in production.',
    )
    // Refused: no row was left behind by the keeper's pass of the refused command.
    expect(await hasRow(confirmed.orderId)).toBe(false)

    const paused = await newOrder(ids.a, 'PAUSE')
    const { workOrderId } = await workOrderOf(paused.lineId)
    await keepOrder(system(), paused.orderId, { what: 'test' })
    const pause = await holdOn(workOrderId, ids.a, 'BRAND')
    expect((await refused('office.planner', 'PUT', stageUrl(paused.orderId), { stage: 'CUTTING', reasonCode: 'OUTSIDE', version: await versionOf(paused.orderId) }, 409)).message).toBe("Paused at the customer's request: lift the pause first.")
    expect((await rowOf(paused.orderId)).stageSet).toBeNull()
    await lift(pause, workOrderId)
    await holdOn(workOrderId, ids.a, 'PRODUCTION')
    expect(await set('office.planner', paused.orderId, { stage: 'CUTTING', reasonCode: 'OUTSIDE', version: await versionOf(paused.orderId) })).toMatchObject({ stage: 'CUTTING', byHand: { reasonCode: 'OUTSIDE' } })
  })

  it('R9: a stale version and a null version beside a row are 409 with the path `version`; Sales is forbidden (403)', async () => {
    const { orderId } = await newOrder(ids.a, 'VER')
    await keepOrder(system(), orderId, { what: 'test' })
    const version = await versionOf(orderId)
    for (const sent of [version - 1 || 99, null]) {
      const stale = await refused('office.planner', 'PUT', stageUrl(orderId), { stage: 'SEWING', reasonCode: 'OUTAGE', version: sent }, 409)
      expect(stale.message, String(sent)).toMatch(/changed since it was read/)
      expect(stale.issues.map((issue: Json) => issue.path)).toEqual(['version'])
    }
    // A version sent where no production state exists yet is stale too.
    const fresh = await newOrder(ids.a, 'VER2')
    expect((await refused('office.planner', 'PUT', stageUrl(fresh.orderId), { stage: 'SEWING', reasonCode: 'OUTAGE', version: 1 }, 409)).issues.map((issue: Json) => issue.path)).toEqual(['version'])
    expect(await hasRow(fresh.orderId)).toBe(false)
    // Sales sees it, never sets it.
    await refused('office.sales', 'PUT', stageUrl(orderId), { stage: 'SEWING', reasonCode: 'OUTAGE', version }, 403)
    await refused('office.sales', 'DELETE', `${stageUrl(orderId)}?version=${version}`, undefined, 403)
    expect(await rowOf(orderId)).toMatchObject({ stageSet: null, version })
  })

  it('R11: office.p2 on A’s order and on an unknown id — PUT and DELETE — "Sales order not found.", word for word; no audit row about A’s order', async () => {
    const { orderId } = await newOrder(ids.a, 'WALL')
    await keepOrder(system(), orderId, { what: 'test' })
    // Whatever A's order's state (here: the floor already at Preparing, a Preparing asked), B's person meets the unknown id's words.
    const audits = await auditsAbout(orderId)
    const version = await versionOf(orderId)
    const answers: string[] = []
    for (const target of [orderId, newId()]) {
      answers.push((await refused('office.p2', 'PUT', stageUrl(target), { stage: 'PREPARING', reasonCode: 'OUTAGE', version }, 404)).message)
      answers.push((await refused('office.p2', 'PUT', stageUrl(target), { stage: 'SEWING', reasonCode: 'OUTAGE', version: null }, 404)).message)
      answers.push((await refused('office.p2', 'DELETE', `${stageUrl(target)}?version=${version}`, undefined, 404)).message)
    }
    expect(new Set(answers)).toEqual(new Set(['Sales order not found.']))
    expect(await auditsAbout(orderId)).toBe(audits)
    expect(await rowOf(orderId)).toMatchObject({ stageSet: null, version })
    // The production unit manages it.
    expect(await set('office.planner', orderId, { stage: 'SEWING', reasonCode: 'OUTAGE', version })).toMatchObject({ stage: 'SEWING' })
  })
})

describe('B-MS-005: change and clear', () => {
  let orderId = ''
  let floorDay = ''
  let before: Told[] = []
  let history: string[][] = []

  it('Change higher: told; Change lower inside the window (B-SC-004): written, never told nor corrected; who and why follow the last act', async () => {
    ;({ orderId } = await newOrder(ids.a, 'CHG'))
    await keepOrder(system(), orderId, { what: 'test' })
    const made = await rowOf(orderId)
    floorDay = new Date(made.stageAt).toISOString()
    history = await reachedOf(orderId)
    before = await told()
    const first = await set('office.planner', orderId, { stage: 'CUTTING', reasonCode: 'OUTAGE', note: NOTE, version: made.version })
    const higher = await set('office.planner2', orderId, { stage: 'QUALITY', reasonCode: 'OUTSIDE', version: first.version })
    expect(higher).toMatchObject({ stage: 'QUALITY', byHand: { stage: 'QUALITY', reasonCode: 'OUTSIDE', note: null, setBy: { id: member, name: 'Seed Member' } } })
    const lower = await set('office.planner', orderId, { stage: 'SEWING', reasonCode: 'OTHER', note: 'Made-up: Quality check was a slip.', version: higher.version })
    expect(lower).toMatchObject({ floor: 'PREPARING', stage: 'SEWING', byHand: { stage: 'SEWING', reasonCode: 'OTHER', setBy: { id: owner } } })
    expect((await toldSince(before, orderId)).map((event) => [event.stage, event.previous])).toEqual([['CUTTING', 'PREPARING'], ['QUALITY', 'CUTTING']])
  })

  it('Clear: the live floor’s stage on its own day (R15), nothing told; a second Clear is refused in words', async () => {
    const version = await versionOf(orderId)
    const answer = await clear('office.planner', orderId, version)
    expect(answer).toEqual({ orderId, floor: 'PREPARING', stage: 'PREPARING', byHand: null, version: expect.any(Number) })
    const row = await rowOf(orderId)
    expect(row).toMatchObject({ stage: 'PREPARING', stageSet: null, reason: null, note: null, setAt: null, setById: null })
    expect(new Date(row.stageAt).toISOString()).toBe(floorDay)
    expect((await toldSince(before, orderId)).map((event) => event.stage)).toEqual(['CUTTING', 'QUALITY'])
    expect((await refused('office.planner', 'DELETE', `${stageUrl(orderId)}?version=${row.version}`, undefined, 409)).message).toBe("No stage set by hand stands on this order: the customer reads the floor's stage.")
  })

  it('R6: the order’s History rows say from → to as `stage`, the note in `after` (never in `reason`), never a `status` key; the portal’s order history reads nothing new', async () => {
    const rows = await orderAudits(orderId)
    expect(rows.map((row) => [row.action, row.before.stage, row.after.stage])).toEqual([
      [SET_BRAND_STAGE, 'PREPARING', 'CUTTING'],
      [SET_BRAND_STAGE, 'CUTTING', 'QUALITY'],
      [SET_BRAND_STAGE, 'QUALITY', 'SEWING'],
      [CLEAR_BRAND_STAGE, 'SEWING', 'PREPARING'],
    ])
    expect(rows[0]!.after).toEqual({ stage: 'CUTTING', floor: 'PREPARING', reasonCode: 'OUTAGE', note: NOTE })
    for (const row of rows) {
      expect([...Object.keys(row.before), ...Object.keys(row.after)]).not.toContain('status')
      expect(row.reason ?? '').not.toContain('Made-up')
    }
    expect(await reachedOf(orderId)).toEqual(history)
  })

  it('set by hand, then cancelled: the keeper gives back where the work reached, on the floor’s own day; nothing told', async () => {
    const { orderId: gone } = await newOrder(ids.a, 'GONE')
    await keepOrder(system(), gone, { what: 'test' })
    const made = await rowOf(gone)
    await set('office.planner', gone, { stage: 'SEWING', reasonCode: 'OUTAGE', version: made.version })
    await raw(`UPDATE "SalesOrder" SET status = 'CANCELLED' WHERE id = ${lit(gone)};`)
    const since = await told()
    const handler = brandKeeperHandler()
    const eventId = newId()
    await handler.handle(
      { eventId, type: 'sales_order.status_changed', version: 1, context: 'test', tenantId: ids.tenantId, companyId: w.companyId, siteId: null, subject: gone, correlationId: `t-${eventId}`, causationId: null, source: 'test', occurredAt: new Date().toISOString(), payload: { orderId: gone, number: 'T-MS005', from: 'IN_PRODUCTION', to: 'CANCELLED', by: 'person' } },
      { caller: system(), attempt: 1 },
    )
    const row = await rowOf(gone)
    expect(row).toMatchObject({ stage: 'PREPARING', stageSet: null, reason: null, note: null, setAt: null, setById: null })
    expect(new Date(row.stageAt).toISOString()).toBe(new Date(made.stageAt).toISOString())
    expect(await toldSince(since, gone)).toEqual([])
  })
})

// ── B-SC-004 (stage control B, "full control": any stage, forward or back; Ready by hand; a move back told as a correction) ──
describe('B-SC-004: any stage by hand, forward or back', () => {
  /** The stage markers of an order's production row, oldest first: [told | untold, stage, correction]. */
  const stageMarkersOf = async (orderId: string) =>
    (
      await admin<{ action: string; after: Json }>(
        `SELECT a.action, a.after FROM "AuditLog" a JOIN "BrandOrderProduction" p ON p.id = a."recordId" WHERE a."recordType" = 'BrandOrderProduction' AND a.action = ANY($2::text[]) AND p.key = $1 ORDER BY a.id`,
        [`brand-production:${orderId}`, [STAGE_TOLD, STAGE_UNTOLD]],
      )
    ).map((row) => [row.action === STAGE_TOLD ? 'told' : 'untold', row.after.stage, row.after.correction === true])

  it('Ready to ship by hand is taken: the customer reads it, told by hand (its notice waits the window); the order’s status stays quality’s', async () => {
    const { orderId } = await newOrder(ids.a, 'READY')
    await keepOrder(system(), orderId, { what: 'test' })
    const before = await told()
    const answer = await set('office.planner', orderId, { stage: 'READY', reasonCode: 'OUTSIDE', note: 'Made-up: packed at the outside workshop.', version: await versionOf(orderId) })
    expect(answer).toMatchObject({ floor: 'PREPARING', stage: 'READY', byHand: { stage: 'READY', reasonCode: 'OUTSIDE' } })
    expect(await rowOf(orderId)).toMatchObject({ stage: 'READY', stageSet: 'READY' })
    const events = await toldSince(before, orderId)
    expect(events).toEqual([{ orderId, partyId: ids.a, stage: 'READY', previous: 'PREPARING', byHand: true }])
    expect(stageNoticeKey(events[0] as { stage: BrandStage; previous: BrandStage | null }, 'READY')).toBe('portal.production.ready')
    // Only the stage moves: the order is still In production (Ready is quality's status), nothing is released.
    expect((await one<{ status: string }>(`SELECT status::text AS status FROM "SalesOrder" WHERE id = $1`, [orderId])).status).toBe('IN_PRODUCTION')
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "QualityRelease" r JOIN "WorkOrderSize" s ON s.id = r."workOrderSizeId" JOIN "SalesOrderLine" l ON l.id = s."salesOrderLineId" WHERE l."orderId" = $1`, [orderId])).n).toBe(0)
  })

  it('a Change at the same stage with stage, reason and note unchanged, and the floor’s own stage while a hand stage stands: 409 in words; nothing written, nothing told', async () => {
    const { orderId, lineId } = await newOrder(ids.a, 'SAME')
    const { workOrderId, cellId } = await workOrderOf(lineId)
    await bundleOn(workOrderId, cellId)
    await keepOrder(system(), orderId, { what: 'test' })
    expect((await rowOf(orderId)).stage).toBe('CUTTING')
    await set('office.planner', orderId, { stage: 'SEWING', reasonCode: 'OUTAGE', note: NOTE, version: await versionOf(orderId) })
    const version = await versionOf(orderId)
    const before = await told()
    expect((await refused('office.planner', 'PUT', stageUrl(orderId), { stage: 'SEWING', reasonCode: 'OUTAGE', note: `  ${NOTE} `, version }, 409)).message).toBe('Nothing to change: the stage set by hand already reads so, with the same reason and note.')
    expect((await refused('office.planner', 'PUT', stageUrl(orderId), { stage: 'CUTTING', reasonCode: 'OUTAGE', version }, 409)).message).toBe("Cutting is the floor's own stage: clear the stage set by hand to go back to it.")
    expect(await rowOf(orderId)).toMatchObject({ stage: 'SEWING', stageSet: 'SEWING', reason: 'OUTAGE', note: NOTE, version })
    expect(await toldSince(before, orderId)).toEqual([])
  })

  it('a Change at the same stage with another reason or note is taken: audited, the floor at the set kept, the customer told nothing', async () => {
    const orderId = (await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number LIKE 'T-MS005-SAME-%'`, [ids.tenantId])).id
    const before = await told()
    const markers = await stageMarkersOf(orderId)
    const stageAt = new Date((await rowOf(orderId)).stageAt).toISOString()
    const reason = await set('office.planner2', orderId, { stage: 'SEWING', reasonCode: 'FEW_PEOPLE', note: NOTE, version: await versionOf(orderId) })
    expect(reason).toMatchObject({ floor: 'CUTTING', stage: 'SEWING', byHand: { stage: 'SEWING', reasonCode: 'FEW_PEOPLE', note: NOTE, setBy: { id: member } } })
    const words = await set('office.planner', orderId, { stage: 'SEWING', reasonCode: 'FEW_PEOPLE', note: 'Made-up: two people off sick in the sewing room.', version: reason.version })
    expect(words).toMatchObject({ stage: 'SEWING', byHand: { reasonCode: 'FEW_PEOPLE', note: 'Made-up: two people off sick in the sewing room.', setBy: { id: owner } }, version: reason.version + 1 })
    // Only office fields changed: the stage and its day stay, no notice, no marker.
    expect(new Date((await rowOf(orderId)).stageAt).toISOString()).toBe(stageAt)
    expect(await toldSince(before, orderId)).toEqual([])
    expect(await stageMarkersOf(orderId)).toEqual(markers)
    // Audited on the order's History (Sewing → Sewing, the reason in `after`), never a `status` key; the floor at the set is the first set's.
    expect((await orderAudits(orderId)).slice(-2).map((row) => [row.before.stage, row.after.stage, row.after.reasonCode])).toEqual([
      ['SEWING', 'SEWING', 'FEW_PEOPLE'],
      ['SEWING', 'SEWING', 'FEW_PEOPLE'],
    ])
    const rowId = (await rowOf(orderId)).id as string
    const sets = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'BrandOrderProduction' AND "recordId" = $1 AND action = $2 ORDER BY id`, [rowId, SET_BRAND_STAGE])
    expect(sets.map((row) => row.after.floorAtSet)).toEqual(['CUTTING', 'CUTTING', 'CUTTING'])
  })

  it('Preparing set back over a told Cutting (a wrong cut): one correction, the stages above untold; the hand Preparing stands over the floor’s Cutting', async () => {
    const { orderId, lineId } = await newOrder(ids.b, 'BACK')
    const { workOrderId, cellId } = await workOrderOf(lineId)
    await keepOrder(system(), orderId, { what: 'test' })
    await bundleOn(workOrderId, cellId)
    // The floor's own Cutting, told at once (no window).
    await keepOrder(system(), orderId, { what: 'production.bundle_created', health: false })
    expect((await rowOf(orderId)).stage).toBe('CUTTING')
    const before = await told()
    const answer = await set('office.planner', orderId, { stage: 'PREPARING', reasonCode: 'OTHER', note: 'Made-up: the cut was logged on the wrong order.', version: await versionOf(orderId) })
    expect(answer).toMatchObject({ floor: 'CUTTING', stage: 'PREPARING', byHand: { stage: 'PREPARING', reasonCode: 'OTHER' } })
    const events = await toldSince(before, orderId)
    expect(events).toEqual([{ orderId, partyId: ids.b, stage: 'PREPARING', previous: 'CUTTING', byHand: true, correction: true }])
    expect(stageNoticeKey(events[0] as { stage: BrandStage; previous: BrandStage | null; correction?: boolean }, 'PREPARING')).toBe('portal.production.corrected_preparing')
    // Cutting counts as never told now (told again when the floor's Cutting stands again); the correction is the newest word.
    expect((await stageMarkersOf(orderId)).slice(-2)).toEqual([
      ['untold', 'CUTTING', false],
      ['told', 'PREPARING', true],
    ])
    // The keeper follows another bundle: the floor still at Cutting, where it stood at the set — the hand Preparing stands, nothing told.
    await bundleOn(workOrderId, cellId)
    await keepOrder(system(), orderId, { what: 'production.bundle_created', health: false })
    expect(await rowOf(orderId)).toMatchObject({ stage: 'PREPARING', stageSet: 'PREPARING' })
    expect(await toldSince(before, orderId)).toHaveLength(1)
  })

  it('Clear raises it back to the floor’s Cutting: the usual forward notice, by hand (its window)', async () => {
    const orderId = (await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number LIKE 'T-MS005-BACK-%'`, [ids.tenantId])).id
    const before = await told()
    expect(await clear('office.planner', orderId, await versionOf(orderId))).toMatchObject({ floor: 'CUTTING', stage: 'CUTTING', byHand: null })
    expect(await toldSince(before, orderId)).toEqual([{ orderId, partyId: ids.b, stage: 'CUTTING', previous: 'PREPARING', byHand: true }])
    const history = await orderAudits(orderId)
    expect(history.map((row) => [row.action, row.before.stage, row.after.stage]).slice(-2)).toEqual([
      [SET_BRAND_STAGE, 'CUTTING', 'PREPARING'],
      [CLEAR_BRAND_STAGE, 'PREPARING', 'CUTTING'],
    ])
    for (const row of history) expect([...Object.keys(row.before), ...Object.keys(row.after)]).not.toContain('status')
  })

  it('a stage moved back inside its window (its notice not made yet): left untold silently, never corrected', async () => {
    const { orderId } = await newOrder(ids.a, 'WIN')
    await keepOrder(system(), orderId, { what: 'test' })
    const before = await told()
    const first = await set('office.planner', orderId, { stage: 'QUALITY', reasonCode: 'OUTAGE', version: await versionOf(orderId) })
    await set('office.planner', orderId, { stage: 'CUTTING', reasonCode: 'OTHER', note: 'Made-up: Quality check was a slip.', version: first.version })
    expect((await toldSince(before, orderId)).map((event) => [event.stage, event.previous, event.correction ?? false])).toEqual([['QUALITY', 'PREPARING', false]])
    expect(await stageMarkersOf(orderId)).toEqual([
      ['told', 'PREPARING', false],
      ['told', 'QUALITY', false],
      ['untold', 'QUALITY', false],
    ])
  })
})
// ── end B-SC-004 ──
