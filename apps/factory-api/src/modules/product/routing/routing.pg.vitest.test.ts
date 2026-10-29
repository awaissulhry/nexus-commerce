import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedProduct } from '../../../../../../packages/factory-db/seed/product'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * The routing of a style revision on the local stack (B-W1-14; features PRD-109, PRD-110, PRD-111), with the app's real
 * routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login, so row-level security and the
 * …_product_guards triggers are real), the product seed's jacket (cut 14, sew 96.5, inspect 8, pack 3.5 standard minutes)
 * and sessions from the test authenticator. Every code and name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs routing`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'routing-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const companyB = seedId('company:B')
const jacket = seedId('product:style:JKT-01')
const revision1 = seedId('product:revision:JKT-01:1')
const scale = seedId('product:size-scale:EU-JKT')
const leather = seedId('product:item:leather')
const CUT = seedId('product:operation:CUT')
const SEW = seedId('product:operation:SEW')
const QC = seedId('product:operation:QC')
const PACK = seedId('product:operation:PACK')
const seedStep = (code: string) => seedId(`product:routing:JKT-01:1:${code}`)
const otherTenant = newId()

const VIEW = 'product.routing.view'
const MANAGE = 'product.routing.manage'
const LIBRARY = 'product.operations.manage'
const STYLES: Permission[] = ['product.styles.view', 'product.styles.manage']
const BOM: Permission[] = ['product.bom.view', 'product.bom.manage', 'product.bom.release']

interface Person {
  readonly tenantId: string
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
}
const PEOPLE: Record<string, Person> = {
  engineer: { tenantId: tenant, permissions: [VIEW, MANAGE, LIBRARY, ...STYLES, ...BOM, 'audit.read'], companies: 'all' },
  developer: { tenantId: tenant, permissions: [VIEW, MANAGE], companies: 'all' },
  viewer: { tenantId: tenant, permissions: [VIEW], companies: 'all' },
  companyA: { tenantId: tenant, permissions: [VIEW, MANAGE, ...STYLES, ...BOM], companies: [companyA] },
  companyB: { tenantId: tenant, permissions: [VIEW, MANAGE], companies: [companyB] },
  stylesOnly: { tenantId: tenant, permissions: STYLES, companies: 'all' },
  otherTenant: { tenantId: otherTenant, permissions: [VIEW, MANAGE, LIBRARY], companies: 'all' },
}
const ACTORS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: person.tenantId, actorId: ACTORS[key]!, grants: [grant] }]
  }),
)
// A floor device holding even the routing's permissions: the routes are the office's only.
SESSIONS.floor = { audience: 'floor', tenantId: tenant, actorId: newId(), siteId: seedId('site:A1'), deviceId: newId(), grants: [{ permissions: [VIEW, MANAGE, 'floor.work'], companies: [companyA], sites: [seedId('site:A1')], parties: 'all' }] }

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const eventsOf = async (subject: string) => admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])
const historyOf = async (recordType: string, id: string): Promise<any[]> => (await ok('engineer', 'GET', `/audit/${recordType}/${id}`)).entries
const revisionUrl = (styleId: string, revisionId: string) => `/product/styles/${styleId}/revisions/${revisionId}`
const routingUrl = (styleId: string, revisionId: string) => `${revisionUrl(styleId, revisionId)}/routing`
const getRouting = async (styleId: string, revisionId: string, session = 'engineer'): Promise<Json> => (await ok(session, 'GET', routingUrl(styleId, revisionId))).routing
const stepOf = (routing: Json, code: string): Json => routing.steps.find((step: Json) => step.code === code)
const codes = (routing: Json): [number, string][] => routing.steps.map((step: Json) => [step.seq, step.code])

let jacket2: string
let draft2: string
let finishing: string
let revision2: string

beforeAll(async () => {
  db = await migratedDatabase('routing')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  await seedProduct({ db: database, namespace: NS })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [otherTenant, 'routing-other'])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 60_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe("the seed jacket's routing (PRD-110, PRD-111)", () => {
  it('shows cut, sew, inspect and pack in order with their minutes per garment, per size and per kind of work centre, and the final operation', async () => {
    const routing = await getRouting(jacket, revision1, 'viewer')
    expect(routing.revision).toMatchObject({ id: revision1, revision: 1, status: 'DRAFT', version: 1 })
    expect(routing.style).toMatchObject({ id: jacket, code: 'SEED-JKT-01', companyId: null, status: 'DRAFT' })
    expect(codes(routing)).toEqual([
      [10, 'SEED-CUT-LEA'],
      [20, 'SEED-SEW-ASM'],
      [30, 'SEED-FIN-QC'],
      [40, 'SEED-PACK'],
    ])
    expect(routing.steps[0]).toMatchObject({
      id: seedStep('SEED-CUT-LEA'),
      operation: { id: CUT, code: 'SEED-CUT-LEA', status: 'ACTIVE', machineType: 'cutting table', skill: 'cutter', standardMinutes: '14' },
      nameI18n: { it: 'Taglio pelle', en: 'Cut leather panels' },
      workCentreKind: 'CUTTING',
      standardMinutes: '14',
      differsFromLibrary: false,
      scanRequired: true,
      final: false,
    })
    expect(routing.minutes).toEqual({
      perGarment: '122',
      byKind: [
        { workCentreKind: 'CUTTING', minutes: '14', steps: 1 },
        { workCentreKind: 'SEWING', minutes: '96.5', steps: 1 },
        { workCentreKind: 'INSPECTION', minutes: '8', steps: 1 },
        { workCentreKind: 'PACKING', minutes: '3.5', steps: 1 },
      ],
      bySize: [
        { size: '50', minutes: '122' },
        { size: '52', minutes: '122' },
        { size: '54', minutes: '122' },
      ],
      steps: 4,
      scanPoints: 4,
    })
    expect(routing.steps.map((step: Json) => step.operation.id)).toEqual([CUT, SEW, QC, PACK])
    expect(routing).toMatchObject({ finalStepId: seedStep('SEED-PACK'), issues: [], warnings: [], editable: true })
    expect(routing.sizes.map((size: Json) => size.code)).toEqual(['50', '52', '54'])
  })
})

describe('a routing built through the API: cut, sew, finish, inspect (PRD-109, PRD-110)', () => {
  it('adds library operations at the end in the order sent, each change versioned and audited; the minutes add up per size', async () => {
    finishing = (
      await ok(
        'engineer',
        'POST',
        '/product/operations',
        { code: 'rt-fin-edge', name: 'Edge paint and finish', nameI18n: { it: 'Tinta bordi e rifinitura', en: 'Edge paint and finish' }, workCentreKind: 'FINISHING', machineType: 'edge painter', skill: 'finisher', standardMinutes: '6.2500' },
        201,
      )
    ).operation.id
    const style = (
      await ok(
        'companyA',
        'POST',
        '/product/styles',
        { companyId: companyA, code: 'RT-JKT-02', name: 'Routing jacket (made up)', productType: 'JACKET', sizeScaleId: scale, sizes: ['50', '52', '54'], baseSize: '52', colourways: [{ code: 'BLK', name: 'Black' }] },
        201,
      )
    ).style
    jacket2 = style.id
    draft2 = (await ok('companyA', 'POST', `/product/styles/${jacket2}/revisions`, { changeNote: 'First routing (made up).' }, 201)).revision.id
    const url = `${routingUrl(jacket2, draft2)}/steps`

    let routing = await getRouting(jacket2, draft2)
    expect(routing).toMatchObject({ steps: [], minutes: { perGarment: '0', steps: 0 }, finalStepId: null, issues: [{ code: 'NO_STEPS', stepId: null }], editable: true })
    // The release gate (NO_STEPS): no revision is released without a routing, whatever its BOM says.
    const refusal = await refused('companyA', 'POST', `${revisionUrl(jacket2, draft2)}/release`, { version: 1 }, 409)
    expect(refusal).toMatchObject({ code: 'invalid_state', message: expect.stringMatching(/^The BOM and the routing are not ready to release/) })
    expect(refusal.issues).toEqual(expect.arrayContaining([{ path: 'routing/NO_STEPS', message: 'The routing has no operation yet.' }]))

    routing = (await ok('companyA', 'POST', url, { version: 1, operations: [{ operationId: CUT }, { operationId: SEW, standardMinutes: '90.12345' }] }, 201)).routing
    expect(routing.revision.version).toBe(2)
    expect(codes(routing)).toEqual([
      [10, 'SEED-CUT-LEA'],
      [20, 'SEED-SEW-ASM'],
    ])
    // Typed minutes are rounded half up to 3 decimals, once; the library's stay as they are.
    expect(stepOf(routing, 'SEED-SEW-ASM')).toMatchObject({ standardMinutes: '90.123', differsFromLibrary: true, operation: { standardMinutes: '96.5' } })
    routing = (await ok('companyA', 'POST', url, { version: 2, operations: [{ operationId: finishing, scanRequired: false, instructions: 'Two coats on every edge.' }, { operationId: QC }] }, 201)).routing
    const sew = stepOf(routing, 'SEED-SEW-ASM').id
    routing = (await ok('companyA', 'PATCH', `${url}/${sew}`, { version: 3, standardMinutes: '96.5' })).routing

    expect(codes(routing)).toEqual([
      [10, 'SEED-CUT-LEA'],
      [20, 'SEED-SEW-ASM'],
      [30, 'RT-FIN-EDGE'],
      [40, 'SEED-FIN-QC'],
    ])
    expect(stepOf(routing, 'RT-FIN-EDGE')).toMatchObject({ workCentreKind: 'FINISHING', standardMinutes: '6.25', scanRequired: false, instructions: 'Two coats on every edge.', nameI18n: { it: 'Tinta bordi e rifinitura' } })
    expect(stepOf(routing, 'SEED-SEW-ASM')).toMatchObject({ standardMinutes: '96.5', differsFromLibrary: false })
    expect(routing.minutes).toEqual({
      perGarment: '124.75',
      byKind: [
        { workCentreKind: 'CUTTING', minutes: '14', steps: 1 },
        { workCentreKind: 'SEWING', minutes: '96.5', steps: 1 },
        { workCentreKind: 'FINISHING', minutes: '6.25', steps: 1 },
        { workCentreKind: 'INSPECTION', minutes: '8', steps: 1 },
      ],
      bySize: ['50', '52', '54'].map((size) => ({ size, minutes: '124.75' })),
      steps: 4,
      scanPoints: 3,
    })
    expect(routing).toMatchObject({ finalStepId: stepOf(routing, 'SEED-FIN-QC').id, issues: [], warnings: [], revision: { version: 4 } })
    expect(routing.steps.filter((step: Json) => step.final).map((step: Json) => step.code)).toEqual(['SEED-FIN-QC'])

    const history = await historyOf('RoutingOperation', sew)
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ action: 'product.routing.updateStep', before: { standardMinutes: '90.123' }, after: { standardMinutes: '96.5' } })
    expect(history[1]).toMatchObject({ action: 'product.routing.addSteps', after: { revisionId: draft2, operationId: SEW, code: 'SEED-SEW-ASM', standardMinutes: '90.123', scanRequired: true } })
    expect((await historyOf('StyleRevision', draft2)).map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['product.routing.addSteps', 'product.routing.updateStep', 'product.styles.createRevision']),
    )
    const events = (await eventsOf(jacket2)).filter((event) => event.type === 'style.routing_changed')
    expect(events).toHaveLength(3)
    expect(events[0]!.payload).toEqual({ styleId: jacket2, code: 'RT-JKT-02', revisionId: draft2, revision: 1, stepIds: routing.steps.slice(0, 2).map((step: Json) => step.id) })
  })

  it('refuses at once an archived operation, another company’s, minutes of 0, a bad order and a stale version', async () => {
    const url = `${routingUrl(jacket2, draft2)}/steps`
    const old = (await ok('engineer', 'POST', '/product/operations', { code: 'RT-OLD', name: 'Old hand stitch', workCentreKind: 'SEWING', standardMinutes: '3' }, 201)).operation
    await ok('engineer', 'POST', `/product/operations/${old.id}/archive`, { version: old.version })
    const foreign = (await ok('engineer', 'POST', '/product/operations', { companyId: companyB, code: 'RT-B-PRESS', name: 'Company B press', workCentreKind: 'FINISHING', standardMinutes: '2' }, 201)).operation
    const version = (await getRouting(jacket2, draft2)).revision.version

    const error = await refused('companyA', 'POST', url, { version, operations: [{ operationId: old.id }, { operationId: foreign.id }, { operationId: newId() }, { operationId: CUT, standardMinutes: '0.0004' }] }, 400)
    expect(error.issues).toEqual([
      { path: 'body/operations/0/operationId', message: 'Operation RT-OLD is archived: reactivate it, or choose another.' },
      { path: 'body/operations/1/operationId', message: "Operation RT-B-PRESS belongs to another company than the style's." },
      { path: 'body/operations/2/operationId', message: 'No such operation.' },
      { path: 'body/operations/3/standardMinutes', message: 'Standard minutes are above 0 (at 3 decimals).' },
    ])
    expect((await refused('companyA', 'POST', url, { version, operations: [{ operationId: CUT, standardMinutes: '1.1234567' }] }, 400)).code).toBe('validation_failed')
    const steps = (await getRouting(jacket2, draft2)).steps.map((step: Json) => step.id)
    expect((await refused('companyA', 'PUT', `${routingUrl(jacket2, draft2)}/order`, { version, stepIds: [steps[1], steps[0], steps[2]] }, 400)).issues).toEqual([{ path: 'body/stepIds', message: 'Name every step of the routing once: 1 missing.' }])
    expect(await refused('companyA', 'PATCH', `${url}/${steps[0]}`, { version: version - 1, standardMinutes: '15' }, 409)).toMatchObject({ code: 'conflict', issues: [{ path: 'version', message: `The current version is ${version}.` }] })
    expect((await refused('companyA', 'PATCH', `${url}/${newId()}`, { version, standardMinutes: '15' }, 404)).message).toBe('Routing step not found.')
    // Nothing of it was written.
    expect((await getRouting(jacket2, draft2)).revision.version).toBe(version)
  })

  it('reorders the steps (numbered again by tens) and removes one; places stay unique', async () => {
    let routing = await getRouting(jacket2, draft2)
    const [cut, sew, fin, qc] = routing.steps.map((step: Json) => step.id)
    routing = (await ok('companyA', 'PUT', `${routingUrl(jacket2, draft2)}/order`, { version: routing.revision.version, stepIds: [sew, cut, fin, qc] })).routing
    expect(codes(routing)).toEqual([
      [10, 'SEED-SEW-ASM'],
      [20, 'SEED-CUT-LEA'],
      [30, 'RT-FIN-EDGE'],
      [40, 'SEED-FIN-QC'],
    ])
    expect((await historyOf('RoutingOperation', cut))[0]).toMatchObject({ action: 'product.routing.reorder', before: { seq: 10 }, after: { seq: 20 } })
    routing = (await ok('companyA', 'PUT', `${routingUrl(jacket2, draft2)}/order`, { version: routing.revision.version, stepIds: [cut, sew, fin, qc] })).routing
    routing = (await ok('companyA', 'DELETE', `${routingUrl(jacket2, draft2)}/steps/${fin}?version=${routing.revision.version}`)).routing
    expect(codes(routing)).toEqual([
      [10, 'SEED-CUT-LEA'],
      [20, 'SEED-SEW-ASM'],
      [40, 'SEED-FIN-QC'],
    ])
    expect(routing.minutes.perGarment).toBe('118.5')
    expect((await historyOf('RoutingOperation', fin))[0]).toMatchObject({ action: 'product.routing.removeStep', after: { removed: true }, before: { code: 'RT-FIN-EDGE' } })
  })
})

describe('the release gate: a revision is released only with a routing a work order can be made from', () => {
  const release = async (expected: number): Promise<Json> => {
    const bom = (await ok('engineer', 'GET', `${revisionUrl(jacket, revision1)}/bom`)).bom
    expect(bom).toMatchObject({ issues: [], releasable: true })
    const response = await call('engineer', 'POST', `${revisionUrl(jacket, revision1)}/release`, { version: bom.revision.version })
    expect(response.statusCode, response.body).toBe(expected)
    return response.json()
  }
  const patchStep = async (stepId: string, change: Json): Promise<Json> =>
    (await ok('engineer', 'PATCH', `${routingUrl(jacket, revision1)}/steps/${stepId}`, { version: (await getRouting(jacket, revision1)).revision.version, ...change })).routing

  it('refuses a routing that scans no step (NO_SCAN_POINT): the floor could not report a garment', async () => {
    let routing = await getRouting(jacket, revision1)
    for (const step of routing.steps) routing = await patchStep(step.id, { scanRequired: false })
    expect(routing).toMatchObject({ finalStepId: null, issues: [{ code: 'NO_SCAN_POINT', stepId: null }], minutes: { scanPoints: 0 } })
    expect((await release(409)).error).toMatchObject({
      code: 'invalid_state',
      message: 'The routing is not ready to release: 1 problem(s) to fix first.',
      issues: [{ path: 'routing/NO_SCAN_POINT', message: 'No step is scanned: the floor could not report a garment. Mark at least the final operation as scanned.' }],
    })
    for (const step of routing.steps) routing = await patchStep(step.id, { scanRequired: true })
    expect(routing.issues).toEqual([])
  })

  it('refuses a step whose minutes are not above 0 (MINUTES_NOT_POSITIVE), as a row written outside the API may hold', async () => {
    const pack = seedStep('SEED-PACK')
    await admin('UPDATE "RoutingOperation" SET "standardMinutes" = 0 WHERE id = $1', [pack])
    expect((await getRouting(jacket, revision1)).issues).toEqual([{ code: 'MINUTES_NOT_POSITIVE', stepId: pack, message: 'Step 40 (SEED-PACK): its standard minutes are above 0.' }])
    expect((await release(409)).error).toMatchObject({
      code: 'invalid_state',
      message: 'The routing is not ready to release: 1 problem(s) to fix first.',
      issues: [{ path: `routing/steps/${pack}`, message: 'Step 40 (SEED-PACK): its standard minutes are above 0.' }],
    })
    expect((await patchStep(pack, { standardMinutes: '3.5' })).issues).toEqual([])
  })

  it('lets warnings pass: the last step unscanned, the batch or serial goes to the last scanned one', async () => {
    const routing = await patchStep(seedStep('SEED-PACK'), { scanRequired: false })
    expect(routing).toMatchObject({ issues: [], warnings: [{ code: 'LAST_STEP_NOT_SCANNED', stepId: seedStep('SEED-PACK') }], finalStepId: seedStep('SEED-FIN-QC') })
    expect((await release(200)).bom.revision).toMatchObject({ id: revision1, status: 'RELEASED' })
  })
})

describe('release, copy and compare (A1 §2.5)', () => {
  it('freezes the routing at release: the API answers 409 first, the database refuses any change for every login', async () => {
    const routing = await getRouting(jacket, revision1)
    expect(routing).toMatchObject({ revision: { status: 'RELEASED' }, editable: false, issues: [], warnings: [] })
    const version = routing.revision.version
    const url = routingUrl(jacket, revision1)
    const frozen = { code: 'invalid_state', message: 'Revision 1 is released: its routing is frozen. Copy it into a new draft to change it.' }
    const step = seedStep('SEED-SEW-ASM')
    expect(await refused('engineer', 'POST', `${url}/steps`, { version, operations: [{ operationId: CUT }] }, 409)).toMatchObject(frozen)
    expect(await refused('engineer', 'PATCH', `${url}/steps/${step}`, { version, standardMinutes: '90' }, 409)).toMatchObject(frozen)
    expect(await refused('engineer', 'DELETE', `${url}/steps/${step}?version=${version}`, undefined, 409)).toMatchObject(frozen)
    expect(await refused('engineer', 'PUT', `${url}/order`, { version, stepIds: routing.steps.map((entry: Json) => entry.id).reverse() }, 409)).toMatchObject(frozen)
    expect(await refused('engineer', 'POST', `${url}/copy`, { version, fromStyleId: jacket2 }, 409)).toMatchObject({ code: 'invalid_state' })

    const runtime = (sql: string) => database.withScope({ audience: 'office', tenantId: tenant, actorId: ACTORS.engineer! }, (client) => client.$executeRawUnsafe(sql, revision1))
    await expect(runtime('UPDATE "RoutingOperation" SET "standardMinutes" = 1 WHERE "revisionId" = $1::uuid')).rejects.toThrow(/never change, a change is a new revision/)
    await expect(runtime('DELETE FROM "RoutingOperation" WHERE "revisionId" = $1::uuid')).rejects.toThrow(/never change, a change is a new revision/)
    await expect(admin('UPDATE "RoutingOperation" SET seq = seq + 100 WHERE "revisionId" = $1', [revision1])).rejects.toThrow(/never change, a change is a new revision/)
    expect((await getRouting(jacket, revision1)).minutes.perGarment).toBe('122')
  })

  it("copies the steps of another style's released routing into a draft, after its steps or instead of them", async () => {
    let routing = await getRouting(jacket2, draft2)
    const url = `${routingUrl(jacket2, draft2)}/copy`
    routing = (await ok('companyA', 'POST', url, { version: routing.revision.version, fromStyleId: jacket })).routing
    expect(codes(routing)).toEqual([
      [10, 'SEED-CUT-LEA'],
      [20, 'SEED-SEW-ASM'],
      [40, 'SEED-FIN-QC'],
      [50, 'SEED-CUT-LEA'],
      [60, 'SEED-SEW-ASM'],
      [70, 'SEED-FIN-QC'],
      [80, 'SEED-PACK'],
    ])
    routing = (await ok('companyA', 'POST', url, { version: routing.revision.version, fromStyleId: jacket, fromRevisionId: revision1, replace: true })).routing
    expect(codes(routing)).toEqual([
      [10, 'SEED-CUT-LEA'],
      [20, 'SEED-SEW-ASM'],
      [30, 'SEED-FIN-QC'],
      [40, 'SEED-PACK'],
    ])
    expect(routing.steps.map((step: Json) => step.id)).not.toContain(seedStep('SEED-CUT-LEA'))
    expect(routing.minutes.perGarment).toBe('122')
    const copied = (await eventsOf(jacket2)).filter((event) => event.type === 'style.routing_changed').at(-1)!
    expect(copied.payload.stepIds).toEqual(routing.steps.map((step: Json) => step.id))
    expect((await historyOf('StyleRevision', draft2))[0]).toMatchObject({ action: 'product.routing.copySteps', after: { routing: { copiedFrom: { styleId: jacket, revisionId: revision1, revision: 1 }, replaced: 7, added: 4 } } })

    // Only a released routing is copied, and only by a person who may see it.
    const version = routing.revision.version
    expect((await refused('engineer', 'POST', url, { version, fromStyleId: jacket2, fromRevisionId: draft2 }, 409)).message).toBe('A routing is not copied into itself.')
    const other = (await ok('engineer', 'POST', '/product/styles', { companyId: companyB, code: 'RT-JKT-03', name: 'Unreleased (made up)', productType: 'JACKET', sizeScaleId: scale, sizes: ['52'], baseSize: '52' }, 201)).style.id
    const otherDraft = (await ok('engineer', 'POST', `/product/styles/${other}/revisions`, {}, 201)).revision.id
    expect((await refused('engineer', 'POST', url, { version, fromStyleId: other }, 404)).message).toBe('That style has no released routing.')
    expect((await refused('engineer', 'POST', url, { version, fromStyleId: other, fromRevisionId: otherDraft }, 409)).message).toBe('Revision 1 is draft: steps are copied only from a released routing.')
    // Company A's person cannot see company B's style, so cannot copy from it.
    expect((await refused('companyA', 'POST', url, { version, fromStyleId: other, fromRevisionId: otherDraft }, 404)).message).toBe('Style not found.')
    expect((await getRouting(jacket2, draft2)).revision.version).toBe(version)
  })

  it('compares two revisions of one style: added, removed and changed steps and the minutes per garment', async () => {
    const copy = (await ok('engineer', 'POST', `${revisionUrl(jacket, revision1)}/copy`, { changeNote: 'Faster sewing, finishing instead of packing (made up).' }, 201)).bom
    revision2 = copy.revision.id
    let routing = await getRouting(jacket, revision2)
    // The BOM routes' copy carries the routing with it.
    expect(codes(routing)).toEqual(codes(await getRouting(jacket, revision1)))
    const url = `${routingUrl(jacket, revision2)}/steps`
    routing = (await ok('engineer', 'PATCH', `${url}/${stepOf(routing, 'SEED-SEW-ASM').id}`, { version: routing.revision.version, standardMinutes: '90' })).routing
    routing = (await ok('engineer', 'DELETE', `${url}/${stepOf(routing, 'SEED-PACK').id}?version=${routing.revision.version}`)).routing
    routing = (await ok('engineer', 'POST', url, { version: routing.revision.version, operations: [{ operationId: finishing, scanRequired: false }] }, 201)).routing
    // The final operation (batch or serial, B-W1-44) is the last scanned step: inspection, not the unscanned finishing.
    expect(routing).toMatchObject({ finalStepId: stepOf(routing, 'SEED-FIN-QC').id, issues: [] })
    expect(routing.warnings).toEqual([{ code: 'LAST_STEP_NOT_SCANNED', stepId: stepOf(routing, 'RT-FIN-EDGE').id, message: expect.stringMatching(/SEED-FIN-QC/) }])

    const diff = (await ok('viewer', 'GET', `/product/styles/${jacket}/routing/compare?from=${revision1}&to=${revision2}`)).diff
    expect(diff).toMatchObject({
      from: { id: revision1, revision: 1, status: 'RELEASED' },
      to: { id: revision2, revision: 2, status: 'DRAFT' },
      added: [{ code: 'RT-FIN-EDGE', seq: 40, standardMinutes: '6.25' }],
      removed: [{ stepId: seedStep('SEED-PACK'), code: 'SEED-PACK', seq: 40 }],
      changed: [{ from: { stepId: seedStep('SEED-SEW-ASM') }, to: { stepId: stepOf(routing, 'SEED-SEW-ASM').id }, fields: [{ field: 'standardMinutes', from: '96.5', to: '90' }] }],
      unchanged: 2,
      minutes: { from: '122', to: '118.25' },
    })
    expect((await call('viewer', 'GET', `/product/styles/${jacket2}/routing/compare?from=${revision1}&to=${revision2}`)).statusCode).toBe(404)
  })
})

describe('steps are deleted only from a draft (the grant and the trigger)', () => {
  it('gives the office runtime role DELETE on routing steps (refused on a released one) and none on the library; the floor none', async () => {
    expect(
      await admin(
        `SELECT t AS "table", has_table_privilege('factory_runtime', format('public.%I', t), 'DELETE') AS office, has_table_privilege('factory_floor_runtime', format('public.%I', t), 'DELETE') AS floor
           FROM unnest($1::text[]) AS t ORDER BY t`,
        [['Operation', 'RoutingOperation']],
      ),
    ).toEqual([
      { table: 'Operation', office: false, floor: false },
      { table: 'RoutingOperation', office: true, floor: false },
    ])
    const office = (sql: string, id: string) => database.withScope({ audience: 'office', tenantId: tenant, actorId: ACTORS.engineer! }, (client) => client.$executeRawUnsafe(sql, id))
    const floor = (sql: string, id: string) => database.withScope({ audience: 'floor', tenantId: tenant, actorId: newId(), siteId: seedId('site:A1') }, (client) => client.$executeRawUnsafe(sql, id))
    const draft = await getRouting(jacket, revision2)
    await expect(floor('DELETE FROM "RoutingOperation" WHERE id = $1::uuid', stepOf(draft, 'SEED-CUT-LEA').id)).rejects.toThrow(/permission denied for table RoutingOperation/)
    await expect(office('DELETE FROM "RoutingOperation" WHERE id = $1::uuid', seedStep('SEED-CUT-LEA'))).rejects.toThrow(/rows never change, a change is a new revision/)
    await expect(office('DELETE FROM "Operation" WHERE id = $1::uuid', CUT)).rejects.toThrow(/permission denied for table Operation/)
    // The floor reads the routing it scans (its work order's), through the database, never these routes.
    const floorRows = await database.withScope({ audience: 'floor', tenantId: tenant, actorId: newId(), siteId: seedId('site:A1') }, (client) =>
      client.routingOperation.count({ where: { revisionId: revision1 } }),
    )
    expect(floorRows).toBe(4)
    expect(await office('DELETE FROM "RoutingOperation" WHERE id = $1::uuid', stepOf(draft, 'RT-FIN-EDGE').id)).toBe(1)
    expect(codes(await getRouting(jacket, revision2)).map(([, code]) => code)).toEqual(['SEED-CUT-LEA', 'SEED-SEW-ASM', 'SEED-FIN-QC'])
  })
})

describe('the tenant and company walls, and the floor', () => {
  it('shows a routing only inside the tenant and the companies a grant reaches; a style for every company is changed only by a grant over every company', async () => {
    expect((await call('otherTenant', 'GET', routingUrl(jacket, revision1))).statusCode).toBe(404)
    expect((await refused('otherTenant', 'POST', `${routingUrl(jacket2, draft2)}/steps`, { version: 1, operations: [{ operationId: CUT }] }, 404)).message).toBe('Style not found.')
    expect((await call('companyB', 'GET', routingUrl(jacket2, draft2))).statusCode).toBe(404)
    expect((await call('companyB', 'GET', routingUrl(jacket, revision1))).statusCode).toBe(200)
    const version = (await getRouting(jacket, revision2)).revision.version
    const write = await call('companyA', 'POST', `${routingUrl(jacket, revision2)}/steps`, { version, operations: [{ operationId: CUT }] })
    expect(write.statusCode, write.body).toBe(403)
    expect(write.json().error.message).toBe('The routing of a style for every company is changed only by a role over every company.')
    expect((await call('viewer', 'POST', `${routingUrl(jacket, revision2)}/steps`, { version, operations: [{ operationId: CUT }] })).statusCode).toBe(403)
    expect((await call('stylesOnly', 'GET', routingUrl(jacket, revision1))).statusCode).toBe(403)
    expect((await call('engineer', 'GET', routingUrl(jacket2, revision1))).statusCode).toBe(404)
    expect((await getRouting(jacket, revision2)).revision.version).toBe(version)
  })

  it('gives a floor device none of these routes, whatever it holds', async () => {
    for (const [method, url, payload] of [
      ['GET', routingUrl(jacket, revision1), undefined],
      ['GET', `/product/styles/${jacket}/routing/compare?from=${revision1}&to=${revision2}`, undefined],
      ['POST', `${routingUrl(jacket2, draft2)}/steps`, { version: 1, operations: [{ operationId: CUT }] }],
      ['GET', '/product/operations', undefined],
      ['GET', `/product/operations/${CUT}`, undefined],
    ] as const) {
      const response = await call('floor', method, url, payload)
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(403)
    }
  })
})

describe('concurrent edits of one revision', () => {
  /** Sends a write built from what it reads now, again after each 409, until it lands (at most 40 tries). */
  async function retrying(write: () => Promise<{ statusCode: number; body: string }>): Promise<number> {
    for (let attempt = 1; attempt <= 40; attempt++) {
      const response = await write()
      if (response.statusCode !== 409) {
        expect(response.statusCode, response.body).toBeLessThan(300)
        return attempt
      }
    }
    throw new Error('never landed')
  }

  it('serialise on the style row: one write of a version wins, the others get the current version; reorders, BOM and library edits never deadlock', async () => {
    const start = await getRouting(jacket2, draft2)
    const ids = start.steps.map((step: Json) => step.id) as string[]
    const orderUrl = `${routingUrl(jacket2, draft2)}/order`

    // Eight reorders of one version at once: one lands, seven are told the version moved.
    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, index) => call('companyA', 'PUT', orderUrl, { version: start.revision.version, stepIds: [...ids.slice(index % ids.length), ...ids.slice(0, index % ids.length)] })),
    )
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409, 409, 409, 409, 409, 409, 409])
    for (const answer of answers.filter((entry) => entry.statusCode === 409)) {
      expect(answer.json().error).toMatchObject({ code: 'conflict', issues: [{ path: 'version', message: `The current version is ${start.revision.version + 1}.` }] })
    }

    // Writers that read again after a 409 all land, one after another: reorders (each rotating the current order), new
    // steps, step edits, the revision's BOM and the library operations they copy.
    const current = () => getRouting(jacket2, draft2)
    const reorders = Array.from({ length: 4 }, () => () =>
      retrying(async () => {
        const routing = await current()
        const order = routing.steps.map((step: Json) => step.id)
        return call('companyA', 'PUT', orderUrl, { version: routing.revision.version, stepIds: [...order.slice(1), order[0]] })
      }),
    )
    const adds = Array.from({ length: 3 }, () => () => retrying(async () => call('companyA', 'POST', `${routingUrl(jacket2, draft2)}/steps`, { version: (await current()).revision.version, operations: [{ operationId: finishing }] })))
    const edits = Array.from({ length: 2 }, (_, index) => () =>
      retrying(async () => {
        const routing = await current()
        return call('companyA', 'PATCH', `${routingUrl(jacket2, draft2)}/steps/${stepOf(routing, 'SEED-CUT-LEA').id}`, { version: routing.revision.version, standardMinutes: String(15 + index) })
      }),
    )
    const bomLines = Array.from({ length: 2 }, (_, index) => () =>
      retrying(async () => {
        const bom = (await ok('companyA', 'GET', `${revisionUrl(jacket2, draft2)}/bom`)).bom
        return call('companyA', 'POST', `${revisionUrl(jacket2, draft2)}/bom/lines`, { version: bom.revision.version, itemId: leather, uom: 'FT2', qty: String(40 + index), placement: `Panel ${index} (made up)` })
      }),
    )
    const library = [SEW, finishing].map((operationId) => () =>
      retrying(async () => call('engineer', 'PATCH', `/product/operations/${operationId}`, { version: (await ok('engineer', 'GET', `/product/operations/${operationId}`)).operation.version, skill: 'senior machinist' })),
    )
    await Promise.all([...reorders, ...adds, ...edits, ...bomLines, ...library].map((run) => run()))

    const after = await current()
    expect(after.revision.version).toBe(start.revision.version + 1 + 4 + 3 + 2 + 2)
    expect(after.steps).toHaveLength(ids.length + 3)
    expect(new Set(after.steps.map((step: Json) => step.seq)).size).toBe(after.steps.length)
    expect(after.steps.map((step: Json) => step.seq)).toEqual([...after.steps.map((step: Json) => step.seq)].sort((a: number, b: number) => a - b))
    expect(await admin('SELECT count(*)::int AS n FROM "RoutingOperation" WHERE "revisionId" = $1 AND seq < 1', [draft2])).toEqual([{ n: 0 }])
    expect(stepOf(after, 'SEED-SEW-ASM').operation.skill).toBe('senior machinist')

    // The revision's BOM and routing are one versioned record.
    const bom = (await ok('companyA', 'GET', `${revisionUrl(jacket2, draft2)}/bom`)).bom
    expect(bom.revision.version).toBe(after.revision.version)
  })
})
