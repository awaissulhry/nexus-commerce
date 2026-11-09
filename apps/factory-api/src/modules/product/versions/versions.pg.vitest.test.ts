import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedChanges } from '../../../../../../packages/factory-db/seed/changes'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seed as seedCutting } from '../../../../../../packages/factory-db/seed/cutting'
import { seed as seedInstructions } from '../../../../../../packages/factory-db/seed/instructions'
import { seed as seedSales } from '../../../../../../packages/factory-db/seed/sales'
import { seed as seedSizesDepth } from '../../../../../../packages/factory-db/seed/sizes-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, type CommandTx } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { mapError } from '../../../core/errors'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../../platform/outbox/system'
import { assertRevisionOpen, RevisionLockedError, revisionLockGuarded } from './lock'

/**
 * Spec versions (B-W2b-220; PRD-085, PRD-166, PRD-167, PRD-168, PRD-194, PRD-195, VS1:01) through the app's real routes on a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and every product guard are
 * real), on the seeds up to the change orders: SEED-JKT-01 revision 1 (DRAFT, with its routing in depth, measurement spec,
 * protectors and pattern pieces; quoted in SEED-Q-0001 (accepted) and SEED-Q-0002 (draft), ordered in SEED-SO-0001) and
 * SEED-JKT-02 revision 1 (RELEASED; SEED-SO-0002, SEED-WO-0001 in progress and SEED-WO-0002 a draft, and SEED-ECO-0001, a
 * draft change order whose work-in-progress lines are WO-0001 finish on the old spec and WO-0002 hold). Every person, number
 * and value is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/product/versions`.
 */

vi.setConfig({ testTimeout: 60_000 })

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'w2b220-versions'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const siteA1 = idOf('site:A1')
const siteB1 = idOf('site:B1')

const OFFICE: Permission[] = [
  'product.bom.view',
  'product.bom.manage',
  'product.bom.release',
  'product.routing.view',
  'product.routing.manage',
  'product.styles.view',
  'product.styles.manage',
  'costing.view',
  'quotes.view',
  'orders.view',
  'workorders.view',
  'money.cost',
] as Permission[]
const grant = (permissions: Permission[], sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies: 'all', sites, parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  developer: office([grant(OFFICE)]),
  viewer: office([grant(['product.bom.view'] as Permission[])]),
  planner: office([grant(['workorders.view', 'orders.view'] as Permission[])]),
  floor: { audience: 'floor', tenantId: T, actorId: newId(), siteId: siteA1, deviceId: newId(), grants: [grant(['production.scan', 'floor.work'] as Permission[], [siteA1])] },
  floorB1: { audience: 'floor', tenantId: T, actorId: newId(), siteId: siteB1, deviceId: newId(), grants: [grant(['production.scan', 'floor.work'] as Permission[], [siteB1])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `v-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
/** A fixture the seeds lack, written by the owner with the triggers off (only in this throwaway database). */
const fixture = (statements: string) => db.admin.query(`BEGIN; SET LOCAL session_replication_role = replica; ${statements}; COMMIT;`)

const styleOf = async (code: string) => (await admin<{ id: string }>('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, code]))[0]!.id
const revisionRow = async (styleId: string, revision: number) =>
  (await admin<{ id: string; version: number; status: string }>('SELECT id, version, status::text AS status FROM "StyleRevision" WHERE "styleId" = $1 AND revision = $2', [styleId, revision]))[0]!
const workOrderOf = async (number: string) => (await admin<{ id: string }>('SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = $2', [T, number]))[0]!.id
const section = (compare: Json, id: string): Json => compare.sections.find((entry: Json) => entry.id === id)

async function release(styleId: string, revision: number): Promise<void> {
  const row = await revisionRow(styleId, revision)
  await ok('developer', 'POST', `/product/styles/${styleId}/revisions/${row.id}/release`, { version: row.version })
}
async function copy(styleId: string, revision: number, changeNote: string): Promise<string> {
  const row = await revisionRow(styleId, revision)
  await ok('developer', 'POST', `/product/styles/${styleId}/revisions/${row.id}/copy`, { changeNote }, 201)
  return (await revisionRow(styleId, revision + 1)).id
}

let jacket = ''
let jacket2 = ''

beforeAll(async () => {
  db = await migratedDatabase('versions')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedCutting({ db: database, namespace: NS })
  await seedInstructions({ db: database, namespace: NS })
  await seedSizesDepth({ db: database, namespace: NS })
  await seedSales({ db: database, namespace: NS })
  await seedCosting({ db: database, namespace: NS })
  await seedChanges({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  jacket = await styleOf('SEED-JKT-01')
  jacket2 = await styleOf('SEED-JKT-02')
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('a style revised, compared and released (PRD-166, PRD-168, PRD-085, VS1:01)', () => {
  let rev1 = ''
  let rev2 = ''

  it('lists the revisions with who, when, why and the records made from them (PRD-166)', async () => {
    const { versions } = await ok('developer', 'GET', `/product/styles/${jacket}/versions`)
    expect(versions.style.code).toBe('SEED-JKT-01')
    expect(versions.current).toBeNull()
    expect(versions.revisions).toHaveLength(1)
    const [first] = versions.revisions
    rev1 = first.id
    expect(first).toMatchObject({ revision: 1, status: 'DRAFT', locked: false, lockedReason: null })
    expect(first.quoteLines).toBeGreaterThanOrEqual(2)
    expect(first.orderLines).toBeGreaterThanOrEqual(1)
    // A role that does not reach quotes, orders or work orders sees no count.
    const seen = (await ok('viewer', 'GET', `/product/styles/${jacket}/versions`)).versions.revisions[0]
    expect([seen.workOrders, seen.quoteLines, seen.orderLines]).toEqual([null, null, null])
  })

  it('compares a released revision with its edited copy, part by part, the pieces included', async () => {
    await release(jacket, 1)
    rev2 = await copy(jacket, 1, 'Longer sleeves, faster sewing.')
    // The draft's edits (a draft's parts change freely: the owner writes them here, the guards on).
    await admin(`UPDATE "BomLineSize" SET qty = qty + 1.5 WHERE "revisionId" = $1 AND size = '52' AND "bomLineId" = (SELECT id FROM "BomLine" WHERE "revisionId" = $1 AND seq = 10)`, [rev2])
    await admin(`UPDATE "RoutingOperation" SET "standardMinutes" = "standardMinutes" - 6.5 WHERE "revisionId" = $1 AND code = 'SEED-SEW-ASM'`, [rev2])
    await admin(`UPDATE "PatternPiece" SET quantity = 2 WHERE "revisionId" = $1 AND name = 'Front left'`, [rev2])

    const { compare } = await ok('developer', 'GET', `/product/styles/${jacket}/versions/compare?from=${rev1}&to=${rev2}`)
    expect(compare.before).toMatchObject({ id: rev1, revision: 1, status: 'RELEASED', label: 'Rev 1' })
    expect(compare.after).toMatchObject({ id: rev2, revision: 2, status: 'DRAFT', label: 'Rev 2', note: 'DRAFT', changeNote: 'Longer sleeves, faster sewing.' })
    expect(compare.sections.map((entry: Json) => entry.id)).toEqual(['revision', 'bom', 'routing', 'measurements', 'protectors', 'pieces'])
    // VersionCompare's input as it is: fields with their words, lines matched across, sizes, totals.
    const bom = section(compare, 'bom')
    // The leather's size 52 moved. Since B-W2b-223 the copy carries the W2b-4 BOM columns (the made-to-measure scaling of the
    // leather and the lining included), so that is the one BOM change.
    expect(bom.summary).toMatchObject({ added: 0, removed: 0, changed: 1 })
    const leather = bom.lines.find((line: Json) => line.before && line.after && line.before.sizes?.['52'] !== line.after.sizes?.['52'])
    expect(leather.label).toMatch(/^10 · /)
    expect(leather.before.fields.mtm).toMatch(/ × 1$/)
    expect(leather.after.fields.mtm).toBe(leather.before.fields.mtm)
    expect(bom.fields.find((field: Json) => field.id === 'qty')).toEqual({ id: 'qty', label: 'Quantity' })
    const routing = section(compare, 'routing')
    expect(routing.summary.changed).toBe(1)
    const sew = routing.lines.find((line: Json) => line.after?.fields.code === 'SEED-SEW-ASM')
    expect(Number(sew.before.fields.standardMinutes) - Number(sew.after.fields.standardMinutes)).toBeCloseTo(6.5)
    expect(routing.totals.find((total: Json) => total.id === 'minutesPerGarment').before).not.toBe(routing.totals.find((total: Json) => total.id === 'minutesPerGarment').after)
    // The routing in depth (B-W2b-205) is compared too: the sewing step's extra minutes per size.
    expect(Object.keys(sew.before.sizes ?? {})).toEqual(expect.arrayContaining(['54']))
    // VS1:01: the pattern pieces.
    const pieces = section(compare, 'pieces')
    expect(pieces.summary.changed).toBe(1)
    expect(pieces.lines.find((line: Json) => line.label === 'Front left').after.fields.quantity).toBe('2')
    // The measurement spec and the protectors of revision 1 (W1's copy does not carry them yet: B-W2b-224/228's).
    expect(section(compare, 'measurements').lines.length).toBeGreaterThan(0)
    expect(section(compare, 'protectors').lines.length).toBeGreaterThan(0)
    expect(compare.differs.map((entry: Json) => entry.section)).toEqual(expect.arrayContaining(['bom', 'routing', 'pieces']))
    expect(compare.words).toContain('BOM: 1 changed')
    // The cost grain: both revisions priced with today's inputs, one line per colourway, the cost per garment per size.
    expect(compare.cost).toMatchObject({ id: 'cost', currency: expect.any(String), complete: { before: expect.any(Boolean), after: expect.any(Boolean) } })
    expect(compare.cost.lines.length).toBeGreaterThan(0)
  })

  it('drops the cost for a role without the cost grain, and refuses two of the same or another style', async () => {
    const { compare } = await ok('viewer', 'GET', `/product/styles/${jacket}/versions/compare?from=${rev1}&to=${rev2}`)
    expect('cost' in compare).toBe(false)
    expect(compare.sections).toHaveLength(6)
    await no('viewer', 'GET', `/product/styles/${jacket}/versions/compare?from=${rev1}&to=${rev1}`, undefined, 400)
    const other = await revisionRow(jacket2, 1)
    await no('viewer', 'GET', `/product/styles/${jacket}/versions/compare?from=${rev1}&to=${other.id}`, undefined, 404)
    await no('floor', 'GET', `/product/styles/${jacket}/versions/compare?from=${rev1}&to=${rev2}`, undefined, 403)
  })

  it('finds the open quotes and orders left on the older revision once the new one is released (PRD-194)', async () => {
    await release(jacket, 2)
    const { drift } = await ok('developer', 'GET', `/product/styles/${jacket}/versions/drift`)
    expect(drift.current).toMatchObject({ id: rev2, revision: 2, status: 'RELEASED' })
    expect(drift.held).toEqual([])
    const quote = drift.rows.filter((row: Json) => row.kind === 'QUOTE')
    const order = drift.rows.filter((row: Json) => row.kind === 'ORDER')
    // SEED-Q-0002 is a draft: open; SEED-Q-0001 was accepted (its order carries it).
    expect(quote.map((row: Json) => row.number)).toEqual(expect.arrayContaining(['SEED-Q-0002']))
    expect(quote.map((row: Json) => row.number)).not.toContain('SEED-Q-0001')
    expect(order.map((row: Json) => row.number)).toEqual(expect.arrayContaining(['SEED-SO-0001']))
    for (const row of drift.rows) {
      expect(row).toMatchObject({ state: 'DIFFERENT', revision: { id: rev1, revision: 1, status: 'OBSOLETE' }, against: { id: rev2, revision: 2 } })
      expect(row.differs.length).toBeGreaterThan(0)
      expect(row.words).toMatch(/is on revision 1; revision 2 is the spec in force: /)
      // The cost grain: as priced against now.
      expect(row).toHaveProperty('cost')
    }
    const withCost = drift.rows.find((row: Json) => row.cost && row.cost.unitCostThen !== null && row.cost.unitCostNow !== null)
    if (withCost) expect(typeof withCost.cost.unitCostChange).toBe('string')
    // Without quotes.view, orders.view and the cost grain: nothing is shown, the kinds are named as held.
    const seen = (await ok('viewer', 'GET', `/product/styles/${jacket}/versions/drift`)).drift
    expect(seen).toMatchObject({ rows: [], held: ['QUOTE', 'ORDER'] })
  })

  it('says each locked revision is locked, in the words every write path says (PRD-167)', async () => {
    const { versions } = await ok('developer', 'GET', `/product/styles/${jacket}/versions`)
    expect(versions.current).toBe(rev2)
    expect(versions.revisions.map((row: Json) => [row.revision, row.status, row.locked])).toEqual([
      [2, 'RELEASED', true],
      [1, 'OBSOLETE', true],
    ])
    expect(versions.revisions[0].lockedReason).toBe('Revision 2 is released and locked: it cannot change. Start a new revision (a copy of it, as a draft) to change it.')
    expect(versions.revisions[0].releasedAt).not.toBeNull()
  })

  it('refuses every write to a released revision in words, never a 500; the database guard stays', async () => {
    const row = await revisionRow(jacket, 2)
    const base = `/product/styles/${jacket}/revisions/${rev2}`
    const line = (await admin<{ id: string }>('SELECT id FROM "BomLine" WHERE "revisionId" = $1 ORDER BY seq LIMIT 1', [rev2]))[0]!.id
    const step = (await admin<{ id: string }>('SELECT id FROM "RoutingOperation" WHERE "revisionId" = $1 ORDER BY seq LIMIT 1', [rev2]))[0]!.id
    const piece = (await admin<{ id: string }>('SELECT id FROM "PatternPiece" WHERE "revisionId" = $1 ORDER BY seq LIMIT 1', [rev2]))[0]!.id
    const writes: [Method, string, unknown][] = [
      ['PATCH', base, { version: row.version, changeNote: 'Late change' }],
      ['PATCH', `${base}/bom/lines/${line}`, { version: row.version, wastagePct: '3' }],
      ['PATCH', `${base}/routing/steps/${step}`, { version: row.version, standardMinutes: '9.000' }],
      ['PUT', `${base}/routing/steps/${step}/variants`, { version: row.version, sizes: [], colourwayIds: [] }],
      ['PATCH', `${base}/pieces/${piece}`, { version: row.version, quantity: 3 }],
    ]
    for (const [method, url, payload] of writes) {
      const error = await no('developer', method, url, payload, 409)
      expect(error.message, url).toMatch(/revision 2|Revision 2/)
    }
    // The database's own guard (W1's …_product_guards) still refuses, for every login.
    const caller = callerFor(database, systemContext(T, `lock-${run}`))
    const direct = () => caller.withClient((client) => client.bomLine.update({ where: { id: line }, data: { note: 'sneaked in' }, select: { id: true } }))
    const raw = await direct().catch((error: unknown) => error)
    expect(mapError(raw)).toMatchObject({ status: 409, code: 'conflict', message: 'This revision is released and locked: its BOM cannot change. Start a new revision (a copy of it, as a draft) to change it.', unexpected: false })
    await expect(revisionLockGuarded(direct, 2)).rejects.toBeInstanceOf(RevisionLockedError)
    expect((await admin<{ note: string | null }>('SELECT note FROM "BomLine" WHERE id = $1', [line]))[0]!.note).not.toBe('sneaked in')
    // A later write path asks first: refused on the released revision, passed on a new draft.
    const draft3 = await copy(jacket, 2, 'Next season.')
    await expect(caller.withClient((client) => assertRevisionOpen(client as unknown as CommandTx, jacket, rev2, 'MeasurementSpec'))).rejects.toMatchObject({
      message: 'Revision 2 is released and locked: its measurement spec cannot change. Start a new revision (a copy of it, as a draft) to change it.',
      issues: [{ path: 'refusal/REVISION_LOCKED' }],
    })
    await expect(caller.withClient((client) => assertRevisionOpen(client as unknown as CommandTx, jacket, draft3, 'MeasurementSpec'))).resolves.toMatchObject({ id: draft3, revision: 3 })
  })
})

describe('a newer spec for a work order (PRD-195) and the drift at its release (PRD-194)', () => {
  let wo1 = ''
  let rev2 = ''

  it('shows no banner while the work order is on the spec in force', async () => {
    wo1 = await workOrderOf('SEED-WO-0001')
    const { spec } = await ok('planner', 'GET', `/production/work-orders/${wo1}/spec/versions`)
    expect(spec).toMatchObject({ workOrder: { number: 'SEED-WO-0001', styleCode: 'SEED-JKT-02' }, revision: { revision: 1, status: 'RELEASED' }, released: { revision: 1 }, differs: [], orders: [] })
    expect(spec.newer).toMatchObject({ state: 'CURRENT', banner: false, newPages: false, newer: null, decision: null })
    expect((await ok('floor', 'GET', `/production/work-orders/${wo1}/spec/newer`)).spec.newer.state).toBe('CURRENT')
  })

  it('shows the banner once a newer revision is released, and keeps the old pages until the office decides', async () => {
    rev2 = await copy(jacket2, 1, 'Reinforced elbows.')
    await admin(`UPDATE "BomLine" SET "wastagePct" = "wastagePct" + 2 WHERE "revisionId" = $1 AND seq = (SELECT min(seq) FROM "BomLine" WHERE "revisionId" = $1)`, [rev2])
    await release(jacket2, 2)
    const { spec } = await ok('planner', 'GET', `/production/work-orders/${wo1}/spec/versions`)
    expect(spec.revision).toMatchObject({ revision: 1, status: 'OBSOLETE' })
    expect(spec.released).toMatchObject({ id: rev2, revision: 2 })
    expect(spec.newer).toMatchObject({ state: 'NEWER_RELEASED', banner: true, newPages: false, newer: { id: rev2, revision: 2 }, decision: null })
    expect(spec.newer.message).toBe('A newer spec exists: revision 2. This work order is made to revision 1. Keep to revision 1 until the office decides.')
    expect(spec.differs.map((entry: Json) => entry.section)).toEqual(['bom'])
    expect(spec.words).toBe('BOM: 1 changed')
    // The tablet at the work order's site reads the same banner; another site's tablet does not find the work order.
    const floor = (await ok('floor', 'GET', `/production/work-orders/${wo1}/spec/newer`)).spec
    expect(floor).toMatchObject({ workOrder: { id: wo1, number: 'SEED-WO-0001' }, revision: { revision: 1, status: 'OBSOLETE' }, newer: { state: 'NEWER_RELEASED', banner: true, newPages: false } })
    await no('floorB1', 'GET', `/production/work-orders/${wo1}/spec/newer`, undefined, 404)
    await no('floor', 'GET', `/production/work-orders/${wo1}/spec/versions`, undefined, 403)
  })

  it("follows the change order's decision: finish on the old spec, or rework to the new pages", async () => {
    // SEED-ECO-0001 (a draft) names WO-0001 "finish on revision 1": decided once the order is approved.
    await fixture(`UPDATE "ChangeOrder" SET status = 'APPROVED', "submittedAt" = now(), "decidedAt" = now() WHERE "tenantId" = '${T}' AND number = 'SEED-ECO-0001'`)
    const finish = (await ok('floor', 'GET', `/production/work-orders/${wo1}/spec/newer`)).spec.newer
    expect(finish).toMatchObject({ banner: true, newPages: false, decision: { disposition: 'FINISH_OLD', changeOrder: 'SEED-ECO-0001' } })
    expect(finish.message).toContain('Decided in SEED-ECO-0001: finish this work order on revision 1.')
    await fixture(`UPDATE "ChangeOrderItem" SET disposition = 'REWORK' WHERE "tenantId" = '${T}' AND "workOrderId" = '${wo1}'`)
    const rework = (await ok('planner', 'GET', `/production/work-orders/${wo1}/spec/versions`)).spec.newer
    expect(rework).toMatchObject({ newPages: true, decision: { disposition: 'REWORK' } })
  })

  it("warns at release when an order line was quoted or ordered on another revision than the work order's, with the cost impact", async () => {
    // One of SEED-SO-0002's lines now fixes revision 2, while WO-0001 is made to revision 1.
    await fixture(`UPDATE "SalesOrderLine" SET "styleRevisionId" = '${rev2}' WHERE "tenantId" = '${T}' AND seq = 10 AND "orderId" = (SELECT id FROM "SalesOrder" WHERE "tenantId" = '${T}' AND number = 'SEED-SO-0002')`)
    const planner = (await ok('planner', 'GET', `/production/work-orders/${wo1}/spec/versions`)).spec
    expect(planner.orders).toHaveLength(1)
    expect(planner.orders[0]).toMatchObject({ kind: 'ORDER', number: 'SEED-SO-0002', seq: 10, state: 'DIFFERENT', revision: { revision: 2 }, against: { revision: 1 } })
    expect(planner.orders[0].words).toBe("Order SEED-SO-0002 line 10 is on revision 2; revision 1 is this work order's spec: BOM: 1 changed.")
    // No cost grain: no cost.
    expect('cost' in planner.orders[0]).toBe(false)
    const developer = (await ok('developer', 'GET', `/production/work-orders/${wo1}/spec/versions`)).spec
    expect(developer.orders[0]).toHaveProperty('cost')
  })
})
