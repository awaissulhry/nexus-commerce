import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedInstructions } from '../../../../../../packages/factory-db/seed/instructions'
import { seed as seedPlant } from '../../../../../../packages/factory-db/seed/plant'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../../platform/outbox/system'
import { applyCheckpoint } from './checkpoints'

/**
 * A routing in depth (B-W2b-225; PRD-118, PRD-119, PRD-124, PRD-128) through the app's real routes on a throwaway PostgreSQL
 * 17 database from the migrations (the runtime login: row-level security and the …_routings_instructions_w2b_guards
 * triggers are real), on the seeds up to the routings and instructions seed: SEED-JKT-01 revision 1 (DRAFT; its cutting
 * step copies SMV v1, its sewing step has INL-FIRST as checkpoint, extra minutes for 54 and 50 and its own setting; the
 * library's sewing operation a default setting) and production's SEED-JKT-02 revision 1 (RELEASED 2026-11-10) with
 * SEED-WO-0001 (IN_PROGRESS, two bundles reported at sewing) and SEED-WO-0002 (a DRAFT of BLK 52). The clock is fixed on
 * 2026-11-20 (Rome) so the effective days do not depend on the day the test runs. Every person, number and value is made
 * up. Run with `node scripts/factory/run-pg-tests.mjs modules/product/routing-depth`.
 */

vi.setConfig({ testTimeout: 60_000 })

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'w2b225-depth'
const idOf = (key: string): string => seedUuid(NS, key)
const firstId = (key: string): string => `00000000${idOf(key).slice(8)}`
const lastId = (key: string): string => `ffffffff${idOf(key).slice(8)}`
const T = idOf('tenant')
const companyA = idOf('company:A')
const siteA1 = idOf('site:A1')
const SEW = idOf('product:operation:SEW')
const jacket = idOf('product:style:JKT-01')
const draft1 = idOf('product:revision:JKT-01:1')
const step1 = (code: string) => idOf(`product:routing:JKT-01:1:${code}`)
const jacket2 = idOf('production:style:JKT-02')
const released2 = lastId('production:revision:JKT-02:1')
const releasedStep2 = (code: string) => lastId(`production:routing:JKT-02:1:${code}`)
const WO1 = idOf('production:work-order:WO-0001')
const WO2 = firstId('production:work-order:WO-0002')
const INL_FIRST = idOf('inspection-plans:plan:INL-FIRST')
const FIN_JACKET = firstId('inspection-plans:plan:FIN-JACKET')
const INC_LEATHER = idOf('inspection-plans:plan:INC-LEATHER')
const smvV1 = idOf('instructions:smv:CUT:1')
let postBed = ''
let lockstitch = ''

const PERMISSIONS: Permission[] = [
  'product.routing.view',
  'product.routing.manage',
  'product.operations.manage',
  'product.styles.view',
  'product.styles.manage',
  'product.bom.view',
  'product.bom.manage',
  'product.bom.release',
  'workorders.view',
  'workorders.manage',
  'audit.read',
] as Permission[]
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  engineer: office([grant(PERMISSIONS)]),
  developer: office([grant(['product.routing.view', 'product.routing.manage'] as Permission[])]),
  viewer: office([grant(['product.routing.view'] as Permission[])]),
  otherTenant: { audience: 'office', tenantId: newId(), actorId: newId(), grants: [grant(PERMISSIONS)] },
  floor: { audience: 'floor', tenantId: T, actorId: newId(), siteId: siteA1, deviceId: newId(), grants: [{ permissions: ['production.scan', 'product.routing.view', 'floor.work'] as Permission[], companies: 'all', sites: [siteA1], parties: 'all' }] },
  floorB1: { audience: 'floor', tenantId: T, actorId: newId(), siteId: idOf('site:B1'), deviceId: newId(), grants: [{ permissions: ['production.scan', 'floor.work'] as Permission[], companies: 'all', sites: [idOf('site:B1')], parties: 'all' }] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(sql, values)).rows as Row[]
const run = randomBytes(4).toString('hex')
let serial = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `d-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const outbox = (type: string) => admin<{ subject: string; payload: Json }>('SELECT subject, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [T, type])
const revisionUrl = (styleId: string, revisionId: string) => `/product/styles/${styleId}/revisions/${revisionId}`
const depthUrl = (styleId: string, revisionId: string) => `${revisionUrl(styleId, revisionId)}/routing/depth`
const stepUrl = (styleId: string, revisionId: string, stepId: string, part: string) => `${revisionUrl(styleId, revisionId)}/routing/steps/${stepId}/${part}`
const revisionVersion = async (revisionId: string) => (await admin<{ version: number }>('SELECT version FROM "StyleRevision" WHERE id = $1', [revisionId]))[0]!.version
const revisionOf = async (styleId: string, revision: number) => (await admin<{ id: string }>('SELECT id FROM "StyleRevision" WHERE "styleId" = $1 AND revision = $2', [styleId, revision]))[0]!.id
const stepOf = (routing: Json, code: string): Json => routing.steps.find((step: Json) => step.code === code)
/** A fixture the seeds lack, written by the owner with the triggers off (only in this throwaway database). */
const fixture = (statements: string) => db.admin.query(`BEGIN; SET LOCAL session_replication_role = replica; ${statements}; COMMIT;`)

beforeAll(async () => {
  db = await migratedDatabase('routing_depth')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedInstructions({ db: database, namespace: NS })
  const plant = await seedPlant({ db: database, namespace: NS })
  postBed = plant.classIds['POST_BED']!
  lockstitch = plant.classIds['LOCKSTITCH']!
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  // The day every command runs on (Rome): after the seeded release of SEED-JKT-02 revision 1 (2026-11-10).
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-20T09:00:00.000Z'), shouldAdvanceTime: true })
}, 600_000)

afterAll(async () => {
  vi.useRealTimers()
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('a draft routing in depth (PRD-118, PRD-119, PRD-128)', () => {
  it("reads every step's cells, checkpoint and settings; office only, of the tenant", async () => {
    const { routing } = await ok('viewer', 'GET', depthUrl(jacket, draft1))
    expect(routing).toMatchObject({ style: { id: jacket }, revision: { id: draft1, status: 'DRAFT', effectiveFrom: null }, options: { available: false }, editable: false })
    const sew = stepOf(routing, 'SEED-SEW-ASM')
    expect(sew).toMatchObject({
      stepId: step1('SEED-SEW-ASM'),
      variants: { sizes: [], colourways: [], words: null },
      checkpoint: { plan: { id: INL_FIRST, code: 'INL-FIRST', stage: 'IN_LINE' }, kind: 'FIRST_PIECE', approvedVersion: { number: 1, frequency: 'FIRST_PIECE' }, warning: null },
      librarySettings: 1,
    })
    expect(sew.settings).toEqual([expect.objectContaining({ seq: 1, stitchType: '301', stitchesPerCm: '3', notes: 'Longer stitch on the 1.2 mm leather.', machineClass: null })])
    expect(sew.settings[0].line.en).toBe('301 · 134 LR, Nm 110 · Tkt 40, polyester · 3 per cm · upper 4, lower medium · roller foot')
    expect((await ok('developer', 'GET', depthUrl(jacket, draft1))).routing.editable).toBe(true)
    await no('otherTenant', 'GET', depthUrl(jacket, draft1), undefined, 404)
    await no('floor', 'GET', depthUrl(jacket, draft1), undefined, 403)
  })

  it('limits a step to some sizes and colourways (in the style order); refuses other cells and options, in words', async () => {
    const colourways = (await ok('viewer', 'GET', depthUrl(jacket, draft1))).routing.colourways as Json[]
    const blk = colourways.find((row) => row.code.endsWith('BLK'))!
    const version = await revisionVersion(draft1)
    const { routing } = await ok('developer', 'PUT', stepUrl(jacket, draft1, step1('SEED-PACK'), 'variants'), { version, sizes: ['54', '52'], colourwayIds: [blk.id] })
    expect(stepOf(routing, 'SEED-PACK').variants).toMatchObject({ sizes: [{ code: '52' }, { code: '54' }], colourways: [{ id: blk.id }], words: { en: `Only for sizes 52, 54 · colourway ${blk.code}` } })
    const [event] = (await outbox('style.routing_changed')).slice(-1)
    expect(event!.payload).toMatchObject({ styleId: jacket, revisionId: draft1, stepIds: [step1('SEED-PACK')] })

    const next = await revisionVersion(draft1)
    const size = await no('developer', 'PUT', stepUrl(jacket, draft1, step1('SEED-PACK'), 'variants'), { version: next, sizes: ['60'] }, 400)
    expect(size.issues).toEqual([expect.objectContaining({ path: 'body/sizes/0', message: expect.stringContaining('Size 60 is not in the style') })])
    const other = await no('developer', 'PUT', stepUrl(jacket, draft1, step1('SEED-PACK'), 'variants'), { version: next, colourwayIds: [newId()] }, 400)
    expect(other.issues[0]).toMatchObject({ path: 'body/colourwayIds/0', message: 'Not a colourway of this style.' })
    const option = await no('developer', 'PUT', stepUrl(jacket, draft1, step1('SEED-PACK'), 'variants'), { version: next, optionValueIds: [newId()] }, 400)
    expect(option.issues[0]).toMatchObject({ path: 'body/optionValueIds', message: expect.stringContaining('options') })
    // A stale version, and a reader who may not change routings.
    expect((await no('developer', 'PUT', stepUrl(jacket, draft1, step1('SEED-PACK'), 'variants'), { version, sizes: [] }, 409)).code).toBe('conflict')
    await no('viewer', 'PUT', stepUrl(jacket, draft1, step1('SEED-PACK'), 'variants'), { version: next, sizes: [] }, 403)
    // Back to every cell (the later tests copy the pack step for every cell).
    await ok('developer', 'PUT', stepUrl(jacket, draft1, step1('SEED-PACK'), 'variants'), { version: next, sizes: [], colourwayIds: [] })
  })

  it('names a checkpoint: a cutting, in-line or end-of-line plan; a final or incoming plan is refused in words', async () => {
    let version = await revisionVersion(draft1)
    const final = await no('developer', 'PUT', stepUrl(jacket, draft1, step1('SEED-FIN-QC'), 'checkpoint'), { version, inspectionPlanId: FIN_JACKET }, 400)
    expect(final.issues[0]).toMatchObject({ path: 'body/inspectionPlanId', message: expect.stringContaining('final inspection') })
    const incoming = await no('developer', 'PUT', stepUrl(jacket, draft1, step1('SEED-FIN-QC'), 'checkpoint'), { version, inspectionPlanId: INC_LEATHER }, 400)
    expect(incoming.issues[0].message).toContain('incoming plan')
    await no('developer', 'PUT', stepUrl(jacket, draft1, step1('SEED-FIN-QC'), 'checkpoint'), { version, inspectionPlanId: newId() }, 400)
    const { routing } = await ok('developer', 'PUT', stepUrl(jacket, draft1, step1('SEED-CUT-LEA'), 'checkpoint'), { version, inspectionPlanId: INL_FIRST })
    expect(stepOf(routing, 'SEED-CUT-LEA').checkpoint).toMatchObject({ plan: { code: 'INL-FIRST' }, kind: 'FIRST_PIECE', does: { en: expect.stringContaining("First piece INL-FIRST v1 at the bundle's first report") } })
    version = await revisionVersion(draft1)
    expect(stepOf((await ok('developer', 'PUT', stepUrl(jacket, draft1, step1('SEED-CUT-LEA'), 'checkpoint'), { version, inspectionPlanId: null })).routing, 'SEED-CUT-LEA').checkpoint).toBeNull()
  })

  it("keeps a library operation's default settings and copies them into a step; the step's own list replaces", async () => {
    const before = (await ok('viewer', 'GET', `/product/operations/${SEW}/settings`)).operation
    expect(before).toMatchObject({ operation: { id: SEW, code: 'SEED-SEW-ASM' }, settings: [expect.objectContaining({ stitchesPerCm: '3.5' })], may: { manage: false } })
    const settings = [
      { machineClassId: postBed, stitchType: '301', needle: '134 LR, Nm 110', thread: 'Tkt 40', stitchesPerCm: '3.5', foot: 'roller foot' },
      { machineClassId: lockstitch, stitchType: '301', notes: 'Topstitch the yoke.' },
    ]
    const after = (await ok('engineer', 'PUT', `/product/operations/${SEW}/settings`, { version: before.operation.version, settings })).operation
    expect(after.settings.map((row: Json) => [row.seq, row.machineClass?.code, row.line.en])).toEqual([
      [1, 'POST_BED', 'Post-bed · 301 · 134 LR, Nm 110 · Tkt 40 · 3.5 per cm · roller foot'],
      [2, 'LOCKSTITCH', 'Lockstitch · 301'],
    ])
    expect(after.operation.version).toBe(before.operation.version + 1)
    expect((await outbox('operation.updated')).at(-1)!.payload).toEqual({ operationId: SEW, code: 'SEED-SEW-ASM', fields: ['machineSettings'] })
    // Refused in words: a setting that says nothing, a stale version, a person without the library's permission.
    const empty = await no('engineer', 'PUT', `/product/operations/${SEW}/settings`, { version: after.operation.version, settings: [{ stitchesPerCm: '0' }, {}] }, 400)
    expect(empty.issues.map((issue: Json) => issue.path)).toEqual(['body/settings/0/stitchesPerCm', 'body/settings/1'])
    await no('engineer', 'PUT', `/product/operations/${SEW}/settings`, { version: before.operation.version, settings: [] }, 409)
    await no('developer', 'PUT', `/product/operations/${SEW}/settings`, { version: after.operation.version, settings: [] }, 403)

    // The step's list: a copy of the library's now, then its own.
    let version = await revisionVersion(draft1)
    const copied = stepOf((await ok('developer', 'PUT', stepUrl(jacket, draft1, step1('SEED-SEW-ASM'), 'settings'), { version, fromLibrary: true })).routing, 'SEED-SEW-ASM')
    expect(copied.settings.map((row: Json) => row.machineClass?.code)).toEqual(['POST_BED', 'LOCKSTITCH'])
    version = await revisionVersion(draft1)
    const own = stepOf((await ok('developer', 'PUT', stepUrl(jacket, draft1, step1('SEED-SEW-ASM'), 'settings'), { version, settings: [{ machineClassId: postBed, stitchesPerCm: '3' }] })).routing, 'SEED-SEW-ASM')
    expect(own.settings).toEqual([expect.objectContaining({ seq: 1, stitchesPerCm: '3', machineClass: expect.objectContaining({ code: 'POST_BED' }) })])
    await no('developer', 'PUT', stepUrl(jacket, draft1, step1('SEED-SEW-ASM'), 'settings'), { version: await revisionVersion(draft1), settings: [], fromLibrary: true }, 400)
    // B-W2b-278 (FU4:03): the newest row by its time, then its id (UUIDv7, in the order written): the test clock gives two
    // commands of one instant the same `at`, and `at` alone let either row come first (as B-W2b-F20 for renewals).
    const history = await admin<{ after: Json }>('SELECT "after" FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2 ORDER BY at DESC, id DESC LIMIT 1', ['RoutingOperation', step1('SEED-SEW-ASM')])
    expect(history[0]!.after.machineSettings.settings).toHaveLength(1)
  })

  it('refuses every change to a released routing, in words (409)', async () => {
    const version = await revisionVersion(released2)
    const refusal = await no('developer', 'PUT', stepUrl(jacket2, released2, releasedStep2('SEED-SEW-ASM'), 'variants'), { version, sizes: ['54'] }, 409)
    expect(refusal.message).toMatch(/released/i)
    await no('developer', 'PUT', stepUrl(jacket2, released2, releasedStep2('SEED-SEW-ASM'), 'checkpoint'), { version, inspectionPlanId: INL_FIRST }, 409)
  })
})

describe('the copies carry the depth, the release closes the days (PRD-124)', () => {
  let draft2 = ''

  it('releases revision 1 today; its copy into revision 2 keeps the minutes, cells, checkpoint, size times and settings', async () => {
    // Before the copy: the cutting step names SMV v1, which a newer version has since replaced.
    await admin(`UPDATE "OperationTimeVersion" SET status = 'SUPERSEDED' WHERE id = $1`, [smvV1])
    let version = await revisionVersion(draft1)
    await ok('developer', 'PUT', stepUrl(jacket, draft1, step1('SEED-FIN-QC'), 'variants'), { version, sizes: ['54'] })
    await ok('engineer', 'POST', `${revisionUrl(jacket, draft1)}/release`, { version: await revisionVersion(draft1) })
    expect((await ok('viewer', 'GET', depthUrl(jacket, draft1))).routing.revision).toMatchObject({ status: 'RELEASED', effectiveFrom: '2026-11-20', effectiveTo: null, fromSource: 'RELEASE' })

    await ok('engineer', 'POST', `${revisionUrl(jacket, draft1)}/copy`, { changeNote: 'Second revision.' }, 201)
    draft2 = await revisionOf(jacket, 2)
    const { routing } = await ok('viewer', 'GET', depthUrl(jacket, draft2))
    expect(stepOf(routing, 'SEED-FIN-QC').variants.sizes).toEqual([{ code: '54', label: expect.any(String) }])
    expect(stepOf(routing, 'SEED-SEW-ASM').checkpoint).toMatchObject({ plan: { code: 'INL-FIRST' } })
    expect(stepOf(routing, 'SEED-SEW-ASM').settings).toEqual([expect.objectContaining({ stitchesPerCm: '3' })])
    const rows = await admin<Json>(
      `SELECT r.code, r."timeVersionId" AS tv, r."basicMinutes"::text AS basic, r."setupMinutes"::text AS setup, r."waitMinutes"::text AS wait,
              (SELECT array_agg(t.size || ':' || t."extraMinutes"::text ORDER BY t.size) FROM "RoutingOperationSizeTime" t WHERE t."routingOperationId" = r.id) AS extras
         FROM "RoutingOperation" r WHERE r."revisionId" = $1 ORDER BY r.seq`,
      [draft2],
    )
    expect(rows.find((row) => row.code === 'SEED-CUT-LEA')).toMatchObject({ tv: null, basic: '12.500', setup: '20.000' })
    expect(rows.find((row) => row.code === 'SEED-SEW-ASM')).toMatchObject({ wait: '15.000', extras: ['50:-1.500', '54:4.000'] })
    // B-W2b-278 (FU4:03): the copy's own row (the copy also writes one for the measures it carried, in the same command, at the
    // same instant): the row that names the copy, first by time, then id.
    const audit = await admin<{ after: Json }>(`SELECT "after" FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2 AND "after" ? 'copiedFrom' ORDER BY at, id LIMIT 1`, ['StyleRevision', draft2])
    expect(audit[0]!.after.routingDepth).toMatchObject({ versionsDropped: 1, sizeTimes: 2, settings: 1, checkpoints: 1 })
    version = await revisionVersion(draft2)
    expect(version).toBeGreaterThan(0)
  })

  it('refuses a release planned for another day; the next release the same day leaves the old one no end of its own', async () => {
    await admin(`UPDATE "StyleRevision" SET "effectiveFrom" = '2026-12-01' WHERE id = $1`, [draft2])
    const refusal = await no('engineer', 'POST', `${revisionUrl(jacket, draft2)}/release`, { version: await revisionVersion(draft2) }, 409)
    expect(refusal.message).toContain('Revision 2 is planned to take effect on 2026-12-01')
    await admin(`UPDATE "StyleRevision" SET "effectiveFrom" = NULL WHERE id = $1`, [draft2])
    await ok('engineer', 'POST', `${revisionUrl(jacket, draft2)}/release`, { version: await revisionVersion(draft2) })
    const [first] = await admin<Json>('SELECT status::text AS status, "effectiveTo" FROM "StyleRevision" WHERE id = $1', [draft1])
    expect(first).toEqual({ status: 'OBSOLETE', effectiveTo: null })
    const { effectivity } = await ok('viewer', 'GET', `/product/styles/${jacket}/routing/effectivity?on=2026-11-20`)
    expect(effectivity.inEffect).toMatchObject({ revision: 2 })
    expect(effectivity.revisions.map((row: Json) => [row.revision, row.status, row.effectiveFrom, row.effectiveTo])).toEqual([
      [1, 'OBSOLETE', '2026-11-20', '2026-11-20'],
      [2, 'RELEASED', '2026-11-20', null],
    ])
  })

  it("ends SEED-JKT-02 revision 1 on revision 2's day; its work orders keep revision 1's frozen routing", async () => {
    await ok('engineer', 'POST', `${revisionUrl(jacket2, released2)}/copy`, {}, 201)
    const next = await revisionOf(jacket2, 2)
    // Revision 2: the final inspection only for size 54, a roving checkpoint at sewing.
    await ok('developer', 'PUT', stepUrl(jacket2, next, (await admin<{ id: string }>('SELECT id FROM "RoutingOperation" WHERE "revisionId" = $1 AND code = $2', [next, 'SEED-FIN-QC']))[0]!.id, 'variants'), { version: await revisionVersion(next), sizes: ['54'] })
    await ok('engineer', 'POST', `${revisionUrl(jacket2, next)}/release`, { version: await revisionVersion(next) })
    const [old] = await admin<Json>(`SELECT status::text AS status, to_char("effectiveFrom", 'YYYY-MM-DD') AS "from", to_char("effectiveTo", 'YYYY-MM-DD') AS "to" FROM "StyleRevision" WHERE id = $1`, [released2])
    expect(old).toEqual({ status: 'OBSOLETE', from: '2026-11-10', to: '2026-11-20' })

    const { effectivity } = await ok('engineer', 'GET', `/product/styles/${jacket2}/routing/effectivity?on=2026-11-15`)
    expect(effectivity.inEffect).toMatchObject({ revision: 1 })
    expect(effectivity.revisions[0]).toMatchObject({ revision: 1, effectiveFrom: '2026-11-10', effectiveTo: '2026-11-20', inEffect: true, workOrders: { open: 2, drafts: 1, numbers: expect.arrayContaining([expect.stringContaining('WO-0001')]) } })
    expect(effectivity.words.en).toBe("Revision 2 applies to new work orders since 2026-11-20. 1 work order made before keeps revision 1's routing.")
    // Without workorders.view: the counts, no numbers.
    expect((await ok('viewer', 'GET', `/product/styles/${jacket2}/routing/effectivity`)).effectivity.revisions[0].workOrders.numbers).toBeNull()

    // SEED-WO-0001 keeps its frozen copy of revision 1.
    const frozen = (await ok('engineer', 'GET', `/production/work-orders/${WO1}/routing`)).routing
    expect(frozen).toMatchObject({ frozen: true, revision: { revision: 1, status: 'OBSOLETE', effectiveTo: '2026-11-20', current: { revision: 2, since: '2026-11-20' } }, leftOut: [] })
    expect(frozen.operations.map((op: Json) => op.code)).toEqual(['SEED-CUT-LEA', 'SEED-SEW-ASM', 'SEED-FIN-QC', 'SEED-PACK'])
    expect(frozen.revision.words.en).toContain("1 work order made before keeps revision 1's routing")

    // SEED-WO-0002 (a DRAFT of BLK 52) moves to revision 2: its copy leaves out the step only for size 54.
    const wo2 = (await admin<{ version: number }>('SELECT version FROM "WorkOrder" WHERE id = $1', [WO2]))[0]!
    // Fixture: the seeded order line fixes revision 1; this line leaves the revision to the work order.
    await fixture(`UPDATE "SalesOrderLine" SET "styleRevisionId" = NULL WHERE id IN (SELECT "salesOrderLineId" FROM "WorkOrderSize" WHERE "workOrderId" = '${WO2}')`)
    await ok('engineer', 'PATCH', `/production/work-orders/${WO2}`, { version: wo2.version, styleRevisionId: next })
    const planned = (await ok('engineer', 'GET', `/production/work-orders/${WO2}/routing`)).routing
    expect(planned).toMatchObject({ frozen: false, revision: { revision: 2, current: null } })
    expect(planned.operations.map((op: Json) => [op.code, op.id])).toEqual([
      ['SEED-CUT-LEA', null],
      ['SEED-SEW-ASM', null],
      ['SEED-PACK', null],
    ])
    expect(planned.leftOut).toEqual([expect.objectContaining({ code: 'SEED-FIN-QC', words: { it: expect.any(String), en: expect.stringMatching(/^Only for size 54: no cell of the work order\.$/) } })])
    const record = (await ok('engineer', 'GET', `/production/work-orders/${WO2}`)).workOrder
    expect(record.spec.operations.map((op: Json) => op.code)).toEqual(['SEED-CUT-LEA', 'SEED-SEW-ASM', 'SEED-PACK'])
    await no('viewer', 'GET', `/production/work-orders/${WO2}/routing`, undefined, 403)
  })
})

describe('the checkpoint opens its check at a bundle\'s first report, and the tablet shows the settings (PRD-119, PRD-118)', () => {
  const sewOperation = async () => (await admin<{ id: string }>('SELECT id FROM "WorkOrderOperation" WHERE "workOrderId" = $1 AND code = $2', [WO1, 'SEED-SEW-ASM']))[0]!.id
  const reportOfBundle2 = async () =>
    (await admin<{ id: string; bundleId: string }>(`SELECT s.id, s."bundleId" FROM "OperationScan" s WHERE s."workOrderId" = $1 AND s.kind = 'REPORT' AND s."workOrderOperationId" = $2 AND s."bundleId" = $3 ORDER BY s."serverTime", s.id LIMIT 1`, [WO1, await sewOperation(), idOf('production:bundle:WO-0001:2')]))[0]!
  const envelope = (scanId: string): EventEnvelope => ({
    eventId: newId(),
    type: 'production.scan_recorded',
    version: 1,
    context: 'production',
    tenantId: T,
    companyId: companyA,
    siteId: siteA1,
    subject: WO1,
    correlationId: `checkpoint-${run}`,
    causationId: null,
    source: 'test',
    occurredAt: new Date().toISOString(),
    payload: { kind: 'REPORT', scanId },
  })
  const caller = () => callerFor(database, systemContext(T, `checkpoint-${run}-${++serial}`))

  it("opens a roving check of the bundle, never a second one; nothing for a bundle of another size", async () => {
    // Fixtures: SEED-JKT-02 revision 1's sewing step (released, frozen: only the owner with the triggers off) names INL-FIRST,
    // whose approved version is made a roving one, every bundle.
    await fixture(
      `UPDATE "RoutingOperation" SET "inspectionPlanId" = '${INL_FIRST}' WHERE id = '${releasedStep2('SEED-SEW-ASM')}';
       UPDATE "InspectionPlanVersion" SET frequency = 'EVERY_NTH_BUNDLE', "frequencyValue" = 1 WHERE "planId" = '${INL_FIRST}' AND status = 'APPROVED'`,
    )
    const scan = await reportOfBundle2()
    const operationId = await sewOperation()
    await admin(`UPDATE "InProcessCheck" SET status = 'CANCELLED' WHERE "workOrderId" = $1 AND kind = 'ROVING' AND status = 'OPEN' AND "workOrderOperationId" = $2`, [WO1, operationId]).catch(() => undefined)
    const opened = await applyCheckpoint(caller(), envelope(scan.id))
    expect(opened).toMatchObject({ opened: { kind: 'ROVING' } })
    const recordId = (opened as { opened: { id: string } }).opened.id
    const [check] = await admin<Json>('SELECT kind::text AS kind, status::text AS status, "bundleId", "workOrderOperationId" FROM "InProcessCheck" WHERE id = $1', [recordId])
    expect(check).toEqual({ kind: 'ROVING', status: 'OPEN', bundleId: scan.bundleId, workOrderOperationId: operationId })
    expect((await outbox('routing_checkpoint.check_opened')).at(-1)!.payload).toMatchObject({ routingStepId: releasedStep2('SEED-SEW-ASM'), recordId, kind: 'ROVING', planId: INL_FIRST, workOrderId: WO1, bundleId: scan.bundleId })
    // A second event for the same bundle: one is open already (said on the step's trail).
    expect(await applyCheckpoint(caller(), envelope(scan.id))).toEqual({ skipped: 'ALREADY_OPEN' })
    const [trail] = await admin<{ action: string; after: Json }>('SELECT action, "after" FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2 ORDER BY at DESC, id DESC LIMIT 1', ['RoutingOperation', releasedStep2('SEED-SEW-ASM')])
    expect(trail).toMatchObject({ action: 'product.checkpointSkipped', after: { reason: 'ALREADY_OPEN' } })
    // The step only for size 54: bundle 2 (a sleeve set of BLK 50 or 52) is not its cell.
    await fixture(`UPDATE "RoutingOperation" SET "appliesToSizes" = ARRAY['54'] WHERE id = '${releasedStep2('SEED-SEW-ASM')}'`)
    expect(await applyCheckpoint(caller(), envelope(scan.id))).toBeNull()
    await fixture(`UPDATE "RoutingOperation" SET "appliesToSizes" = '{}' WHERE id = '${releasedStep2('SEED-SEW-ASM')}'`)
  })

  it('shows the tablet the settings, instructions and checkpoint of its operation, at its own site only', async () => {
    const operationId = await sewOperation()
    await fixture(
      `INSERT INTO "OperationMachineSetting" (id, "tenantId", "revisionId", "routingOperationId", seq, "machineClassId", "stitchType", "stitchesPerCm")
       VALUES ('${newId()}', '${T}', '${released2}', '${releasedStep2('SEED-SEW-ASM')}', 1, '${postBed}', '301', 3.5)`,
    )
    const { settings } = await ok('floor', 'GET', `/production/work-orders/${WO1}/operations/${operationId}/settings`)
    expect(settings).toMatchObject({
      operation: { id: operationId, code: 'SEED-SEW-ASM' },
      workOrder: { id: WO1 },
      settings: [expect.objectContaining({ seq: 1, stitchesPerCm: '3.5', line: { it: 'Colonna · 301 · 3.5 punti/cm', en: 'Post-bed · 301 · 3.5 per cm' } })],
      checkpoint: { code: 'INL-FIRST', kind: 'ROVING' },
      variants: null,
    })
    await no('floorB1', 'GET', `/production/work-orders/${WO1}/operations/${operationId}/settings`, undefined, 404)
    await no('floor', 'GET', `/production/work-orders/${WO1}/operations/${newId()}/settings`, undefined, 404)
    const office = (await ok('engineer', 'GET', `/production/work-orders/${WO1}/routing`)).routing
    expect(office.operations.find((op: Json) => op.code === 'SEED-SEW-ASM')).toMatchObject({ checkpoint: { kind: 'ROVING' }, settings: [expect.objectContaining({ stitchesPerCm: '3.5' })], forCells: expect.any(Array) })
  })
})
