import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction, type ProductionSeed } from '../../../../../packages/factory-db/seed/production'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from './testing/two-brands'

/**
 * F-PR-17 (production plan §5 "Floor now: held work shown; Customer column; no silent cap"; 09-design R11 "Nothing hidden
 * silently: held and blocked work shown; every capped list says '5 of 11 · See all'"; wall test PW-06 "Floor now: rep-B sees
 * only B rows"). Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the
 * production unit, should be able to see it all. And manage it all as well."
 *
 * On the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login), the
 * core, files, production and numbering seeds (brand A = the seeds' P1: SEED-WO-0001 in progress), the production two-brand
 * harness, and, written by the test's admin pool (rules off for those statements: the floor's own moves are not this step's),
 * brand B's work order and the mixed one made before the rule released, and A's draft SEED-WO-0002 put on hold with a reason.
 * GET /production/scans/wip (Floor now's work in progress): held work orders are listed with their reason, every row names its
 * customer, the answer says how many there are in all, and a page after the first is read with `offset`. Every name and number
 * is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/production/floor-now`.
 */

const ns = 'fpr17-floor-now'
const ids = twoBrandIds(ns)
// workorders.manage: the harness makes each brand's draft through the real route.
const PERMISSIONS: Permission[] = ['workorders.view', 'workorders.manage']
const SESSIONS: Record<string, SessionContext> = twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS)
const REASON = 'Made-up hold: shade difference on the first panels'

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let seeded: ProductionSeed
let heldA = ''
let aMarkers: Marker[]

type Json = Record<string, any>
const seenByB: { readonly url: string; readonly body: unknown }[] = []
async function ok(session: string, url: string): Promise<Json> {
  const response = await app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
  expect(response.statusCode, `GET ${url}: ${response.body}`).toBe(200)
  const body = response.json() as Json
  if (session === 'office.p2') seenByB.push({ url, body })
  return body
}
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const sql = (value: string): string => {
  if (!isUuid(value)) throw new Error(`not an id: ${value}`)
  return `'${value}'`
}
const wip = async (session: string, query = '') => (await ok(session, `/production/scans/wip?limit=200${query}`)) as { workOrders: Json[]; total: number }
const idsOf = (rows: readonly Json[]) => rows.map((row) => row.workOrder.id as string)

beforeAll(async () => {
  db = await migratedDatabase('fpr17_floor_now')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: ns })
  await seedFiles({ db: database, namespace: ns })
  seeded = await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  heldA = (await admin<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = 'SEED-WO-0002'`, [w.tenantId]))[0]!.id
  await admin(
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     UPDATE "WorkOrder" SET status = 'RELEASED' WHERE id IN (${sql(w.b.workOrderId)}, ${sql(w.mixed.workOrderId)});
     UPDATE "WorkOrder" SET status = 'ON_HOLD', "holdReason" = '${REASON}' WHERE id = ${sql(heldA)};
     COMMIT;`,
  )
  aMarkers = [...(await markersOf(db, w.a.partyId)), { label: 'mixed work order', text: w.mixed.number }, { label: 'mixed work order', text: w.mixed.workOrderId }]
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('Floor now’s work in progress (F-PR-17, PW-06)', { timeout: 60_000 }, () => {
  it('held work is on the floor with its reason; every row names its customer; a mixed one is the production unit’s only', async () => {
    const all = await wip('office.all')
    const row = (id: string) => all.workOrders.find((entry) => entry.workOrder.id === id)
    expect(idsOf(all.workOrders)).toEqual(expect.arrayContaining([seeded.workOrderId, heldA, w.b.workOrderId, w.mixed.workOrderId]))
    expect(row(heldA)).toMatchObject({ workOrder: { status: 'ON_HOLD' }, holdReason: REASON, customer: { id: w.a.partyId }, mixedCustomers: false })
    expect(row(seeded.workOrderId)).toMatchObject({ workOrder: { status: 'IN_PROGRESS' }, holdReason: null, customer: { id: w.a.partyId } })
    expect(row(w.b.workOrderId)).toMatchObject({ holdReason: null, customer: { id: w.b.partyId }, mixedCustomers: false })
    expect(row(w.mixed.workOrderId)).toMatchObject({ customer: null, mixedCustomers: true })
    expect(all.total).toBe(all.workOrders.length)
    // A person limited to B: B's work order only, its customer B; a person limited to A: A's (held one included), not the mixed one.
    const b = await wip('office.p2')
    expect(idsOf(b.workOrders)).toEqual([w.b.workOrderId])
    expect(b.workOrders[0]!.customer).toMatchObject({ id: w.b.partyId })
    expect(b.total).toBe(1)
    const a = await wip('office.p1')
    expect(idsOf(a.workOrders).sort()).toEqual([seeded.workOrderId, heldA].sort())
    expect(a.total).toBe(2)
    // The customer filter: inside the reader's reach only.
    expect(idsOf((await wip('office.all', `&partyId=${w.b.partyId}`)).workOrders)).toEqual([w.b.workOrderId])
    expect(await wip('office.p2', `&partyId=${w.a.partyId}`)).toEqual({ workOrders: [], total: 0, held: 0 /* B-PR-33: of them on hold (fix-pr-3) */ })
  })

  it('no silent cap: the total is every work order on the floor, and the next page starts where the first ended', async () => {
    const whole = await wip('office.all')
    expect(whole.total).toBeGreaterThanOrEqual(4)
    const first = await ok('office.all', '/production/scans/wip?limit=2')
    expect(first.workOrders).toHaveLength(2)
    expect(first.total).toBe(whole.total)
    const rest = await ok('office.all', `/production/scans/wip?limit=200&offset=2`)
    expect(rest.total).toBe(whole.total)
    expect([...idsOf(first.workOrders), ...idsOf(rest.workOrders)]).toEqual(idsOf(whole.workOrders))
  })
})

describe('what B’s person was answered (T00 scan)', () => {
  it('no answer B’s person got names A: not its names, code, orders, references, work orders or ids', () => {
    expect(seenByB.length).toBeGreaterThan(1)
    const found = seenByB.flatMap((entry) => findMarkers(entry.body, aMarkers).map((marker) => `${entry.url} → ${marker}`))
    expect(found).toEqual([])
  })
})
