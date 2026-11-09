import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
import { SHEET_TYPES } from '@nexus/factory-domain/imports/job'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedSizesDepth, type SizesDepthSeed } from '../../../../../../packages/factory-db/seed/sizes-depth'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor, type CommandCaller } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { useImporters } from '../../../platform/imports/registry'
import { applyPlan, planImport } from '../../../platform/imports/worker'
import { systemContext } from '../../../platform/outbox/system'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { sizeSpecFor } from '../../quality/final/size-spec'
import { pointsOf } from '../../sales/measure-link/store'
import { gradeRulesImportAdapter } from '../grading/importer'
import { pointsOfMeasureImportAdapter } from './importer'

/**
 * Points of measure, the measurement spec and grading (B-W2b-224; PRD-049, PRD-051, PRD-052, PRD-062, PRD-063, PRD-069;
 * follow-ups SZ1:01, SZ1:02) on the local stack, through the app's real routes: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security and B-W2b-210's guards are real), the core and sizes seeds (SEED-JKT-01
 * with its DRAFT revision 1 and DRAFT spec graded by SEED-GR-JKT; SEED-TRS-01 on the size-and-fit scale SEED-EU-TRS with
 * an APPROVED spec on its RELEASED revision; the library of body and garment points), sessions from the test
 * authenticator, the files on the local store behind the FAKE R2 account, and the import engine. Every code, number and
 * name is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/product/measures`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let seed: SizesDepthSeed

const NS = 'w2b224-measures'
const idOf = (key: string): string => seedUuid(NS, key)
const tenant = idOf('tenant')
const companyA = idOf('company:A')
const otherTenant = newId()

const IMPORTS: Permission[] = ['imports.view', 'imports.run', 'imports.apply', 'files.upload', 'files.read']
const MAKER: Permission[] = ['product.styles.view', 'product.styles.manage', 'product.bom.view', 'product.bom.manage', 'product.bom.release', 'audit.read', ...IMPORTS]

interface Person {
  readonly tenantId: string
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
}
const PEOPLE: Record<string, Person> = {
  maker: { tenantId: tenant, permissions: MAKER, companies: 'all' },
  // Keeps the spec but releases nothing: approves no spec.
  specOnly: { tenantId: tenant, permissions: ['product.styles.view', 'product.bom.view', 'product.bom.manage'], companies: 'all' },
  viewer: { tenantId: tenant, permissions: ['product.styles.view', 'product.bom.view'], companies: 'all' },
  // Company A only: a tenant-wide point of the library is not theirs to change.
  companyA: { tenantId: tenant, permissions: ['product.styles.view', 'product.styles.manage'], companies: [companyA] },
  otherTenant: { tenantId: otherTenant, permissions: MAKER, companies: 'all' },
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: person.tenantId, actorId: IDS[key]!, grants: [grant] }]
  }),
)

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
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const office = (): CommandCaller => callerFor(database, SESSIONS.maker as never)
const system = (): CommandCaller => callerFor(database, systemContext(tenant, newId()))
const eventsOf = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [tenant, type])).map((row) => row.payload)
const specUrl = (styleId: string, revisionId: string) => `/product/styles/${styleId}/revisions/${revisionId}/measurement-spec`
const getSpec = async (styleId: string, revisionId: string, session = 'maker'): Promise<Json> => (await ok(session, 'GET', specUrl(styleId, revisionId))).spec
const cellOf = (spec: Json, code: string, size: string): Json | null => spec.points.find((point: Json) => point.code === code)?.cells.find((cell: Json) => cell.size === size)?.value ?? null
const grid = (spec: Json): Record<string, Record<string, string | null>> =>
  Object.fromEntries(spec.points.map((point: Json) => [point.code, Object.fromEntries(point.cells.map((cell: Json) => [cell.size, cell.value ? `${cell.value.nominal}${cell.value.source === 'TYPED' ? '*' : ''}` : null]))]))

const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
const csv = (lines: string[]): Buffer => Buffer.from(lines.join('\r\n'), 'utf8')
async function importSheet(importerKey: string, body: Buffer): Promise<{ job: Json; rows: Json[] }> {
  const started = await call('maker', 'POST', '/imports', { importerKey, file: { originalName: 'misure.csv', contentType: SHEET_TYPES.csv, sizeBytes: body.length, sha256: sha256(body) }, companyId: null })
  expect(started.statusCode, started.body).toBe(201)
  const { job, upload } = started.json() as { job: Json; upload: { url: string; headers: Record<string, string> } }
  expect((await app.inject({ method: 'PUT', url: upload.url, headers: upload.headers, payload: body })).statusCode).toBe(200)
  expect((await call('maker', 'POST', `/files/${job.fileId}/complete`)).statusCode).toBe(200)
  await planImport(system(), job.id, { lastAttempt: true })
  return { job: (await ok('maker', 'GET', `/imports/${job.id}`)).job, rows: (await ok('maker', 'GET', `/imports/${job.id}/rows`)).rows }
}
async function applySheet(job: Json): Promise<Json> {
  await ok('maker', 'POST', `/imports/${job.id}/apply`, { version: job.version })
  await applyPlan(system(), job.id, { lastAttempt: true })
  return (await ok('maker', 'GET', `/imports/${job.id}`)).job
}

beforeAll(async () => {
  db = await migratedDatabase('w2b224_measures')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-measures-test-'))
  await seedCore({ db: database, namespace: NS })
  seed = await seedSizesDepth({ db: database, namespace: NS })
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [otherTenant, 'measures-other'])
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE provider = 'R2'`)
  // The import engine checks the roles the person holds: the maker as a user with a custom role over every company.
  const roleId = newId()
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, 'maker@example.com', 'Maker', 'ACTIVE')`, [IDS.maker, tenant])
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains) VALUES ($1, $2, 'custom.maker', 'Maker', $3, '{}')`, [roleId, tenant, MAKER])
  await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "siteIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}', '{}', now() - interval '1 day')`, [newId(), tenant, IDS.maker, roleId])
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  useImporters([pointsOfMeasureImportAdapter, gradeRulesImportAdapter])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 180_000)

afterAll(async () => {
  useImporters(undefined)
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('the point of measure library (PRD-062, PRD-069)', () => {
  it('lists body and garment points with their body point, filtered, and only the tenant’s', async () => {
    const all = await ok('viewer', 'GET', '/product/points-of-measure?limit=200')
    expect(all.count).toBe(10)
    expect(all.points.find((point: Json) => point.code === 'CHEST_W')).toMatchObject({ kind: 'GARMENT', bodyZone: 'UPPER', uom: 'CM', defaultTolerance: '1', bodyPoint: { id: seed.pointIds.chest, code: 'chest' } })
    expect(all.points.find((point: Json) => point.code === 'BACK_LEN')).toMatchObject({ hasPicture: true })
    const legs = await ok('viewer', 'GET', '/product/points-of-measure?kind=GARMENT&zone=LEGS')
    expect(legs.points.map((point: Json) => point.code)).toEqual(['INSEAM_G', 'WAIST_W'])
    expect((await ok('otherTenant', 'GET', '/product/points-of-measure')).count).toBe(0)
    await refused('otherTenant', 'GET', `/product/points-of-measure/${seed.pointIds.chestW}`, undefined, 404)
    const view = (await ok('viewer', 'GET', `/product/points-of-measure/${seed.pointIds.chestW}`)).point
    expect(view.use).toMatchObject({ specValues: 3, specs: 1, gradeSteps: 1, gradeRules: 1, templatePoints: 0, garmentPoints: [] })
    expect((await ok('viewer', 'GET', `/product/points-of-measure/${seed.pointIds.chest}`)).point.use.garmentPoints.map((point: Json) => point.code)).toEqual(['CHEST_W'])
  })

  it('adds a garment point answering to a body point; refuses a code taken in another letter case, a body point on a body point, a weight', async () => {
    const created = await ok('maker', 'POST', '/product/points-of-measure', { code: 'HIP_W', name: 'Hip width', nameI18n: { it: 'Mezzo fianco' }, kind: 'GARMENT', bodyZone: 'LEGS', defaultTolerance: '1.50', bodyPointId: seed.pointIds.waist, howTo: 'Flat, at the widest point.' }, 201)
    expect(created.point).toMatchObject({ code: 'HIP_W', defaultTolerance: '1.5', bodyPoint: { code: 'waist' }, status: 'ACTIVE', version: 1 })
    expect((await eventsOf('point_of_measure.changed')).at(-1)).toEqual({ pointOfMeasureId: created.point.id, code: 'HIP_W', change: 'CREATED' })
    expect((await refused('maker', 'POST', '/product/points-of-measure', { code: 'chest_w', name: 'Again', kind: 'GARMENT', bodyZone: 'UPPER' }, 409)).message).toBe('The point of measure code chest_w is taken (whatever the letter case).')
    const onBody = await refused('maker', 'POST', '/product/points-of-measure', { code: 'BICEP', name: 'Bicep', kind: 'BODY', bodyZone: 'ARMS', bodyPointId: seed.pointIds.chest }, 400)
    expect(paths(onBody)).toEqual(['body/bodyPointId'])
    const toGarment = await refused('maker', 'POST', '/product/points-of-measure', { code: 'BICEP_W', name: 'Bicep', kind: 'GARMENT', bodyZone: 'ARMS', bodyPointId: seed.pointIds.chestW }, 400)
    expect(toGarment.issues[0].message).toBe('CHEST_W is a garment point: name a body point (what the rider\'s body measures).')
    // A tenant-wide point is kept by a role over every company.
    await refused('companyA', 'POST', '/product/points-of-measure', { code: 'NECK_W', name: 'Neck', kind: 'GARMENT', bodyZone: 'UPPER' }, 403)
    await refused('viewer', 'POST', '/product/points-of-measure', { code: 'NECK_W', name: 'Neck', kind: 'GARMENT', bodyZone: 'UPPER' }, 403)
  })

  it('changes a cell at its version; keeps the kind and unit of a point in use; archives and restores the selection', async () => {
    const before = (await ok('maker', 'GET', `/product/points-of-measure/${seed.pointIds.sleeveLen}`)).point
    const changed = (await ok('maker', 'PATCH', `/product/points-of-measure/${seed.pointIds.sleeveLen}`, { version: before.version, defaultTolerance: '0.75', nameI18n: { it: 'Lunghezza manica' } })).point
    expect(changed).toMatchObject({ defaultTolerance: '0.75', nameI18n: { it: 'Lunghezza manica' }, version: before.version + 1 })
    expect((await refused('maker', 'PATCH', `/product/points-of-measure/${seed.pointIds.sleeveLen}`, { version: before.version, name: 'Stale' }, 409)).message).toMatch(/version/)
    const unit = await refused('maker', 'PATCH', `/product/points-of-measure/${seed.pointIds.sleeveLen}`, { version: changed.version, uom: 'MM' }, 409)
    expect(unit.message).toBe('Point of measure SLEEVE_LEN is in use (3 measurement spec value(s), 1 grade rule step(s)): its unit stay as they are. Make a new point instead.')
    const cleared = (await ok('maker', 'PATCH', `/product/points-of-measure/${seed.pointIds.sleeveLen}`, { version: changed.version, nameI18n: null })).point
    expect(cleared.nameI18n).toBeNull()
    const hip = (await ok('maker', 'GET', '/product/points-of-measure?q=HIP_W')).points[0]
    const outseam = (await ok('maker', 'GET', `/product/points-of-measure/${seed.pointIds.outseam}`)).point
    const archived = await ok('maker', 'POST', '/product/points-of-measure/status', { points: [{ id: hip.id, version: hip.version }, { id: outseam.id, version: outseam.version }], status: 'ARCHIVED' })
    expect(archived.points.map((point: Json) => [point.code, point.status])).toEqual([
      ['HIP_W', 'ARCHIVED'],
      ['outseam', 'ARCHIVED'],
    ])
    expect((await refused('maker', 'PATCH', `/product/points-of-measure/${hip.id}`, { version: hip.version + 1, name: 'Hip' }, 409)).message).toMatch(/archived: restore it/)
    await ok('maker', 'POST', '/product/points-of-measure/status', { points: [{ id: outseam.id, version: outseam.version + 1 }], status: 'ACTIVE' })
  })

  it('keeps a how-to picture: announced, put, completed (AVAILABLE), looked at, cleared', async () => {
    const point = (await ok('maker', 'GET', `/product/points-of-measure/${seed.pointIds.chestW}`)).point
    expect(point.picture).toBeNull()
    const body = Buffer.from('\x89PNG\r\n\x1a\n made-up picture of a chest width')
    const announced = await ok('maker', 'POST', `/product/points-of-measure/${point.id}/picture`, { originalName: 'chest.png', contentType: 'image/png', sizeBytes: body.length, sha256: sha256(body), version: point.version }, 201)
    expect((await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })).statusCode).toBe(200)
    const done = await ok('maker', 'POST', `/product/points-of-measure/${point.id}/picture/${announced.file.id}/complete`)
    // No scanner on the local store: the file is AVAILABLE at once and becomes the point's picture.
    expect(done.picture).toEqual({ fileId: announced.file.id, status: 'AVAILABLE', current: true })
    expect(done.point).toMatchObject({ hasPicture: true, picture: { fileId: announced.file.id } })
    expect((await eventsOf('point_of_measure.changed')).at(-1)).toEqual({ pointOfMeasureId: point.id, code: 'CHEST_W', change: 'PICTURE' })
    expect((await ok('viewer', 'GET', `/product/points-of-measure/${point.id}/picture`)).download.url).toEqual(expect.any(String))
    const cleared = await ok('maker', 'DELETE', `/product/points-of-measure/${point.id}/picture?version=${done.point.version}`)
    expect(cleared.point.hasPicture).toBe(false)
    // Only through the module: the generic files route refuses a point's picture.
    const generic = await call('maker', 'POST', '/files', { recordType: 'PointOfMeasure', recordId: point.id, kind: 'PHOTO', originalName: 'x.png', contentType: 'image/png', sizeBytes: body.length, sha256: sha256(body) })
    expect(generic.statusCode, generic.body).toBe(409)
  })
})

describe('size scales of two dimensions (PRD-049)', () => {
  it('refuses a size without its fit on a size-and-fit scale in words (never a 500), and adds one with it', async () => {
    const scale = (await ok('maker', 'GET', `/product/size-scales/${seed.fitScaleId}`)).scale
    expect(scale.dimensions).toBe(2)
    expect(scale.sizes.map((size: Json) => [size.code, size.fitCode])).toEqual([
      ['50R', 'R'],
      ['50L', 'L'],
      ['52R', 'R'],
      ['52L', 'L'],
    ])
    const noFit = await refused('maker', 'POST', `/product/size-scales/${seed.fitScaleId}/sizes`, { version: scale.version, sizes: [{ code: '54R' }] }, 400)
    expect(noFit.issues).toEqual([{ path: 'body/sizes/0/fitCode', message: expect.stringContaining('Size scale SEED-EU-TRS has two dimensions (size and fit): name the fit of size 54R') }])
    const added = (await ok('maker', 'POST', `/product/size-scales/${seed.fitScaleId}/sizes`, { version: scale.version, sizes: [{ code: '54R', fitCode: 'r' }] }, 201)).scale
    expect(added.sizes.at(-1)).toMatchObject({ code: '54R', fitCode: 'R' })
  })

  it('makes a scale of size and fit; a fit on a scale of one is refused', async () => {
    const made = (await ok('maker', 'POST', '/product/size-scales', { code: 'TEST-FIT', name: 'Test fits', dimensions: 2, sizes: [{ code: '48S', fitCode: 'S' }, { code: '48R', fitCode: 'R' }] }, 201)).scale
    expect(made).toMatchObject({ dimensions: 2, codes: ['48S', '48R'] })
    const one = await refused('maker', 'POST', '/product/size-scales', { code: 'TEST-ONE', name: 'One', sizes: [{ code: '48', fitCode: 'R' }] }, 400)
    expect(paths(one)).toEqual(['body/sizes/0/fitCode'])
  })
})

describe('grade rules (PRD-051) and the scale’s rules', () => {
  let ruleId = ''

  it('makes a rule of the size-and-fit scale: the size along each fit, the fit from 52R to 52L', async () => {
    const created = (
      await ok(
        'maker',
        'POST',
        '/product/grade-rules',
        {
          code: 'test-gr-trs',
          name: 'Test trousers',
          sizeScaleId: seed.fitScaleId,
          baseSize: '52R',
          format: 'RELATIVE',
          steps: [
            { pointOfMeasureId: seed.pointIds.waistW, fromSize: null, toSize: null, increment: '2' },
            { pointOfMeasureId: seed.pointIds.inseamG, fromSize: null, toSize: null, increment: '0' },
            { pointOfMeasureId: seed.pointIds.inseamG, fromSize: '52R', toSize: '52L', increment: '4' },
          ],
        },
        201,
      )
    ).rule
    ruleId = created.id
    expect(created).toMatchObject({ code: 'TEST-GR-TRS', baseSize: '52R', format: 'RELATIVE', points: 2, steps: 3, scale: { code: 'SEED-EU-TRS', dimensions: 2 } })
    expect(created.byPoint.find((point: Json) => point.code === 'INSEAM_G')).toMatchObject({ standard: '0', steps: [{ fromSize: '52R', toSize: '52L', increment: '4' }] })
    expect(created.sizes.map((size: Json) => size.fitCode)).toEqual(['R', 'L', 'R', 'L', 'R'])
    expect((await ok('viewer', 'GET', `/product/size-scales/${seed.fitScaleId}/grade-rules`)).rules.map((rule: Json) => rule.code)).toEqual(['SEED-GR-TRS', 'TEST-GR-TRS'])
  })

  it('refuses every wrong step at once in words, and an absolute rule counting from elsewhere', async () => {
    const rule = (await ok('maker', 'GET', `/product/grade-rules/${ruleId}`)).rule
    const wrong = await refused(
      'maker',
      'PUT',
      `/product/grade-rules/${ruleId}/steps`,
      {
        version: rule.version,
        steps: [
          { pointOfMeasureId: seed.pointIds.chest, fromSize: null, toSize: null, increment: '1' },
          { pointOfMeasureId: seed.pointIds.waistW, fromSize: '52R', toSize: '60R', increment: '1' },
          { pointOfMeasureId: seed.pointIds.waistW, fromSize: '50R', toSize: '52R', increment: '1' },
          { pointOfMeasureId: seed.pointIds.waistW, fromSize: '52R', toSize: '50R', increment: '-1' },
        ],
      },
      400,
    )
    expect(paths(wrong)).toEqual(['body/steps/0/pointOfMeasureId', 'body/steps/1/toSize', 'body/steps/3/pointOfMeasureId'])
    const absolute = await refused('maker', 'PATCH', `/product/grade-rules/${seed.gradeRuleIds.jacket}`, { version: 1, format: 'ABSOLUTE' }, 400)
    expect(absolute.issues[0].message).toMatch(/counts every increment from its base size 52/)
    const saved = (await ok('maker', 'PUT', `/product/grade-rules/${ruleId}/steps`, { version: rule.version, steps: [{ pointOfMeasureId: seed.pointIds.waistW, fromSize: null, toSize: null, increment: '2' }, { pointOfMeasureId: seed.pointIds.inseamG, fromSize: '52R', toSize: '52L', increment: '4.5' }] })).rule
    expect(saved).toMatchObject({ steps: 2, version: rule.version + 1 })
    expect((await eventsOf('grade_rule.changed')).filter((event) => event.gradeRuleId === ruleId).map((event) => event.change)).toEqual(['CREATED', 'STEPS'])
  })
})

describe('the measurement spec of a draft revision (PRD-063, PRD-052)', () => {
  const style = () => seed.jacket.styleId
  const revision = () => seed.jacket.revisionId

  it("shows the seed's graded spec: points × the range, the typed override marked, the base size", async () => {
    const spec = await getSpec(style(), revision(), 'viewer')
    expect(spec.spec).toMatchObject({ status: 'DRAFT', baseSize: '52', gradeRule: { code: 'SEED-GR-JKT' } })
    expect(spec.sizes.map((size: Json) => size.code)).toEqual(['50', '52', '54'])
    expect(spec.points.map((point: Json) => point.code)).toEqual(['CHEST_W', 'BACK_LEN', 'SLEEVE_LEN'])
    expect(cellOf(spec, 'SLEEVE_LEN', '54')).toMatchObject({ source: 'TYPED' })
    expect(spec.missing).toEqual([])
    expect(spec.archived).toHaveLength(1)
    expect(spec.editable).toBe(true)
  })

  it('previews the rule: keeps the typed override unless asked; applies it; graded again it changes nothing', async () => {
    const before = await getSpec(style(), revision())
    const kept = (await ok('maker', 'POST', `${specUrl(style(), revision())}/grade/preview`, { ruleId: seed.gradeRuleIds.jacket })).preview
    expect(kept.cells.find((cell: Json) => cell.code === 'SLEEVE_LEN' && cell.size === '54')).toMatchObject({ action: 'KEEP_OVERRIDE' })
    const overwrite = (await ok('maker', 'POST', `${specUrl(style(), revision())}/grade/preview`, { ruleId: seed.gradeRuleIds.jacket, keepOverrides: false })).preview
    const sleeve = overwrite.cells.find((cell: Json) => cell.code === 'SLEEVE_LEN' && cell.size === '54')
    expect(sleeve.action).toBe('OVERWRITE')
    const applied = await ok('maker', 'POST', `${specUrl(style(), revision())}/grade`, { version: before.spec.version, ruleId: seed.gradeRuleIds.jacket, keepOverrides: false })
    expect(cellOf(applied.spec, 'SLEEVE_LEN', '54')).toMatchObject({ source: 'GRADED', nominal: sleeve.after.nominal })
    expect(applied.spec.spec.version).toBe(before.spec.version + 1)
    const again = (await ok('maker', 'POST', `${specUrl(style(), revision())}/grade/preview`, { ruleId: seed.gradeRuleIds.jacket })).preview
    expect(again.counts).toMatchObject({ ADD: 0, CHANGE: 0, OVERWRITE: 0 })
    // Another scale's rule never grades this spec.
    expect((await refused('maker', 'POST', `${specUrl(style(), revision())}/grade/preview`, { ruleId: seed.gradeRuleIds.trousers }, 409)).message).toMatch(/another size scale/)
  })

  it('types cells (an override marked), adds a point with its base value, refuses a body point and a size outside the range in words', async () => {
    let spec = await getSpec(style(), revision())
    spec = (await ok('maker', 'PUT', `${specUrl(style(), revision())}/cells`, { version: spec.spec.version, cells: [{ pointOfMeasureId: seed.pointIds.chestW, size: '54', nominal: '61', tolerancePlus: '1.5' }] })).spec
    expect(cellOf(spec, 'CHEST_W', '54')).toMatchObject({ nominal: '61', toleranceMinus: '1', tolerancePlus: '1.5', source: 'TYPED', words: '61 −1/+1.5 cm' })
    const wrong = await refused('maker', 'PUT', `${specUrl(style(), revision())}/cells`, { version: spec.spec.version, cells: [{ pointOfMeasureId: seed.pointIds.chest, size: '52', nominal: '100' }, { pointOfMeasureId: seed.pointIds.chestW, size: '56', nominal: '62' }] }, 400)
    expect(paths(wrong)).toEqual(['body/cells/0/pointOfMeasureId', 'body/cells/1/size'])
    spec = (await ok('maker', 'POST', `${specUrl(style(), revision())}/points`, { version: spec.spec.version, points: [{ pointOfMeasureId: seed.pointIds.waistW, nominal: '44' }] })).spec
    expect(spec.points.map((point: Json) => point.code)).toEqual(['CHEST_W', 'BACK_LEN', 'SLEEVE_LEN', 'WAIST_W'])
    expect(cellOf(spec, 'WAIST_W', '52')).toMatchObject({ nominal: '44', toleranceMinus: '0.5', tolerancePlus: '0.5', source: 'TYPED' })
    expect(spec.missing).toEqual([{ pointOfMeasureId: seed.pointIds.waistW, code: 'WAIST_W', sizes: ['50', '54'] }])
    // A stale version is a 409.
    expect((await refused('maker', 'PUT', `${specUrl(style(), revision())}/cells`, { version: spec.spec.version - 1, cells: [{ pointOfMeasureId: seed.pointIds.chestW, size: '54', nominal: '60' }] }, 409)).message).toMatch(/version/)
    spec = (await ok('maker', 'PUT', `${specUrl(style(), revision())}/points/order`, { version: spec.spec.version, pointOfMeasureIds: [seed.pointIds.waistW, seed.pointIds.chestW, seed.pointIds.backLen, seed.pointIds.sleeveLen] })).spec
    expect(spec.points.map((point: Json) => [point.code, point.seq])).toEqual([
      ['WAIST_W', 1],
      ['CHEST_W', 2],
      ['BACK_LEN', 3],
      ['SLEEVE_LEN', 4],
    ])
  })

  it('approves only a complete spec, by a person who releases; then freezes it until reopened; archived, another is started from it', async () => {
    let spec = await getSpec(style(), revision())
    const gap = await refused('maker', 'POST', `${specUrl(style(), revision())}/approve`, { version: spec.spec.version }, 400)
    expect(gap.message).toBe('The measurement spec is not complete: WAIST_W has no value for 50, 54.')
    spec = (await ok('maker', 'POST', `${specUrl(style(), revision())}/points/remove`, { version: spec.spec.version, pointOfMeasureIds: [seed.pointIds.waistW] })).spec
    await refused('specOnly', 'POST', `${specUrl(style(), revision())}/approve`, { version: spec.spec.version }, 403)
    spec = (await ok('maker', 'POST', `${specUrl(style(), revision())}/approve`, { version: spec.spec.version })).spec
    expect(spec.spec).toMatchObject({ status: 'APPROVED', approvedById: IDS.maker })
    expect(spec).toMatchObject({ editable: false, refusal: 'The measurement spec is approved: reopen it to change it.' })
    expect((await refused('maker', 'PUT', `${specUrl(style(), revision())}/cells`, { version: spec.spec.version, cells: [{ pointOfMeasureId: seed.pointIds.chestW, size: '54', nominal: '60' }] }, 409)).message).toBe('The measurement spec is approved: reopen it to change it.')
    spec = (await ok('maker', 'POST', `${specUrl(style(), revision())}/reopen`, { version: spec.spec.version, reason: 'Made-up: the sleeve is checked again.' })).spec
    expect(spec.spec).toMatchObject({ status: 'DRAFT', approvedAt: null, approvedById: null })
    const live = spec.spec.id
    spec = (await ok('maker', 'POST', `${specUrl(style(), revision())}/archive`, { version: spec.spec.version })).spec
    expect(spec.spec).toBeNull()
    expect(spec.archived.map((entry: Json) => entry.id)).toContain(live)
    spec = (await ok('maker', 'POST', specUrl(style(), revision()), { baseSize: '52', copyFromSpecId: live }, 201)).spec
    expect(spec.spec).toMatchObject({ status: 'DRAFT', baseSize: '52', gradeRule: null })
    expect(Object.keys(grid(spec))).toEqual(['CHEST_W', 'BACK_LEN', 'SLEEVE_LEN'])
    expect((await refused('maker', 'POST', specUrl(style(), revision()), {}, 409)).message).toMatch(/has a measurement spec already \(draft\): archive it/)
    const changes = (await eventsOf('style.measurement_spec_changed')).map((event) => event.change)
    expect(changes).toEqual(expect.arrayContaining(['GRADED', 'CELLS', 'POINTS', 'APPROVED', 'REOPENED', 'ARCHIVED', 'STARTED']))
  })

  it("a released revision's spec is frozen: refused in words, never by the database", async () => {
    const released = await getSpec(seed.trousers.styleId, seed.trousers.revisionId)
    expect(released).toMatchObject({ editable: false, refusal: expect.stringContaining('Revision 1 is released and frozen') })
    const frozen = await refused('maker', 'PUT', `${specUrl(seed.trousers.styleId, seed.trousers.revisionId)}/cells`, { version: released.spec.version, cells: [{ pointOfMeasureId: seed.pointIds.waistW, size: '52R', nominal: '40' }] }, 409)
    expect(frozen.message).toMatch(/Revision 1 is released and frozen/)
  })
})

describe('the revision copy, the final size check and the measurement link (SZ1:01, SZ1:02)', () => {
  it('copies the spec as a DRAFT (its approval left behind) and the protector placement into the next revision', async () => {
    const copied = await ok('maker', 'POST', `/product/styles/${seed.trousers.styleId}/revisions/${seed.trousers.revisionId}/copy`, { changeNote: 'Made-up: rev 2.' }, 201)
    const revisionId = copied.bom.revision.id
    const spec = await getSpec(seed.trousers.styleId, revisionId)
    expect(spec.spec).toMatchObject({ status: 'DRAFT', approvedAt: null, baseSize: '52R', gradeRule: { code: 'SEED-GR-TRS' } })
    expect(grid(spec)).toEqual((await getSpec(seed.trousers.styleId, seed.trousers.revisionId).then(grid)))
    const placements = await admin<{ pocket: string }>(`SELECT pocket::text FROM "ProtectorPlacement" WHERE "revisionId" = $1`, [revisionId])
    expect(placements).toEqual([{ pocket: 'KNEE' }])
  })

  it("reads the approved spec of a work order's revision as one band per point and size (the final inspection's size check)", async () => {
    const facts = await office().withClient((client) => sizeSpecFor(client, { styleRevisionId: seed.trousers.revisionId }))
    expect(facts.spec?.revision).toBe(1)
    expect(facts.words).toBe('The approved measurement spec of revision 1: 2 point(s) of measure.')
    expect(facts.spec?.points.map((point) => point.size).sort()).toEqual(['50L', '50L', '50R', '50R', '52L', '52L', '52R', '52R'])
    expect(facts.spec?.points.every((point) => /^\d+\.\d{3}$/.test(point.nominal) && /^\d+\.\d{3}$/.test(point.tolerance))).toBe(true)
    const none = await office().withClient((client) => sizeSpecFor(client, { styleRevisionId: seed.jacket.revisionId }))
    expect(none).toMatchObject({ spec: null, words: 'Revision 1 has no approved measurement spec: the size chart is typed.' })
  })

  it("groups the measurement link's points by their library point's body zone, by the code only without one", async () => {
    const before = await office().withClient((client) => pointsOf(client, 'JACKET'))
    expect(before.points.map((point) => [point.code, point.zone])).toEqual([
      ['chest', 'UPPER'],
      ['waist', 'UPPER'],
      ['sleeve', 'ARMS'],
    ])
    const waist = (await ok('maker', 'GET', `/product/points-of-measure/${seed.pointIds.waist}`)).point
    await ok('maker', 'PATCH', `/product/points-of-measure/${seed.pointIds.waist}`, { version: waist.version, bodyZone: 'LEGS' })
    const after = await office().withClient((client) => pointsOf(client, 'JACKET'))
    expect(after.points.find((point) => point.code === 'waist')?.zone).toBe('LEGS')
  })
})

describe('the import of points and grade rules from a sheet', () => {
  it('dry-runs and applies the points: a new one with its body point, a changed tolerance, a unit kept in use refused', async () => {
    const { job, rows } = await importSheet('product.pointsOfMeasure', csv(['Codice;Nome;Tipo;Zona;Tolleranza;Punto corpo;Unità', 'COLLAR_W;Collo;capo;busto;0,5;chest;', 'chest_w;;;;2;;', 'BACK_LEN;;;;;;mm']))
    expect(rows.map((row: Json) => [row.rowNumber, row.action])).toEqual([
      [2, 'CREATE'],
      [3, 'UPDATE'],
      [4, 'ERROR'],
    ])
    expect(rows[2]!.errors[0].message).toMatch(/BACK_LEN is in use/)
    const applied = await applySheet(job)
    expect(applied.status).toBe('APPLIED')
    const collar = (await ok('maker', 'GET', '/product/points-of-measure?q=COLLAR_W')).points[0]
    expect(collar).toMatchObject({ kind: 'GARMENT', bodyZone: 'UPPER', defaultTolerance: '0.5', bodyPoint: { code: 'chest' } })
    expect((await ok('maker', 'GET', `/product/points-of-measure/${seed.pointIds.chestW}`)).point.defaultTolerance).toBe('2')
  })

  it('dry-runs and applies grade steps: a new rule made from its row, a changed increment, a step outside the scale refused', async () => {
    const { job, rows } = await importSheet(
      'product.gradeRules',
      csv(['Regola;Punto;Passo;Incremento;Nome regola;Scala;Taglia base', 'test-gr-new;CHEST_W;*;2;Test new;SEED-EU-JKT;52', 'SEED-GR-JKT;BACK_LEN;52-54;1,5;;;', 'SEED-GR-JKT;CHEST_W;52-60;1;;;']),
    )
    expect(rows.map((row: Json) => [row.rowNumber, row.action])).toEqual([
      [2, 'CREATE'],
      [3, 'UPDATE'],
      [4, 'ERROR'],
    ])
    expect(rows[2]!.errors[0].message).toMatch(/Not a size of the rule's scale: 60/)
    await applySheet(job)
    const created = (await ok('maker', 'GET', '/product/grade-rules?q=TEST-GR-NEW')).rules[0]
    expect(created).toMatchObject({ code: 'TEST-GR-NEW', baseSize: '52', points: 1, steps: 1, scale: { code: 'SEED-EU-JKT' } })
    const jacket = (await ok('maker', 'GET', `/product/grade-rules/${seed.gradeRuleIds.jacket}`)).rule
    expect(jacket.byPoint.find((point: Json) => point.code === 'BACK_LEN').steps.find((step: Json) => step.fromSize === '52')).toMatchObject({ toSize: '54', increment: '1.5' })
  })
})
