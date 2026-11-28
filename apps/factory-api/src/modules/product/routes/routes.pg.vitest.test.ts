import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedProduct } from '../../../../../../packages/factory-db/seed/product'
import { seed as seedTwoBrands, type TwoBrandsSeed } from '../../../../../../packages/factory-db/seed/two-brands'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * owb-pd2 2.3 on the local stack with the app's real routes: the model and customer routes of a style revision, the ready-made
 * routes, the routes of other products ("Start from a copy"), and a frozen revision's routes carried into its next draft. A product
 * of our own range made here (routes for any customer, for P1 and for Seed Brand Two), the product seed's departments and the
 * two-brands seed's SEED-JKT-B2 (revision 1 RELEASED). Walls: a person limited to Seed Brand Two never lists P1's route. Every name
 * is made up. Run with `node scripts/factory/run-pg-tests.mjs product/routes`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let brands: TwoBrandsSeed

const NS = 'owb-pd2-routes'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const p1 = seedId('party:P1')
const scale = seedId('product:size-scale:EU-JKT')
const department = (number: number): string => seedId(`product:department:${number}`)
const STEPS = [2, 4, 5, 6].map((number) => ({ departmentId: department(number) }))

const KEEPER: Permission[] = ['product.styles.view', 'product.styles.manage', 'product.bom.view', 'product.bom.manage', 'product.routing.view', 'product.routing.manage']
const grant = (permissions: readonly Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions: [...permissions], companies: 'all', sites: 'all', parties })
const SESSIONS: Record<string, () => SessionContext> = {
  manager: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(KEEPER)] }),
  brandB: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['product.styles.view', 'product.routing.view'], [brands.second.partyId])] }),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const codesOf = (body: Json): string[] => (body.error?.issues ?? []).filter((issue: Json) => String(issue.path).startsWith('refusal/')).map((issue: Json) => String(issue.path).slice('refusal/'.length))

let style: Json
let revision: Json
const routesUrl = (): string => `/product/styles/${style.id}/revisions/${revision.id}/routes`

beforeAll(async () => {
  db = await migratedDatabase('owb_pd2_routes')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedProduct({ db: database, namespace: NS })
  brands = await seedTwoBrands({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null),
    },
  )
  // A product of our own range (no customer) and its first revision, a draft.
  style = (await ok('manager', 'POST', '/product/styles', { code: 'OWB-RT-01', name: 'Route test jacket', productType: 'JACKET', sizeScaleId: scale, sizes: ['50', '52'], ppeCategory: 'NOT_PPE' }, 201)).style
  revision = (await ok('manager', 'POST', `/product/styles/${style.id}/revisions`, { changeNote: 'First.' }, 201)).revision
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('model and customer routes (owb-pd2 2.3)', () => {
  let model: Json

  it('makes a model route and customer routes, each step its department’s default operation, with their rules', async () => {
    model = (await ok('manager', 'POST', routesUrl(), { name: 'Racing model', kind: 'MODEL', partyId: null, steps: [...STEPS.slice(0, 2), { departmentId: department(5), minutes: '7.5' }, STEPS[3]] }, 201)).route
    expect(model).toMatchObject({ name: 'Racing model', kind: 'MODEL', party: null, rules: { errors: [], warnings: [] }, version: 1 })
    expect(model.steps.map((step: Json) => [step.number, step.minutes])).toEqual([
      [2, null],
      [4, null],
      [5, '7.5'],
      [6, null],
    ])
    await ok('manager', 'POST', routesUrl(), { name: 'For Seed Customer One', kind: 'CUSTOMER', partyId: p1, steps: STEPS }, 201)
    await ok('manager', 'POST', routesUrl(), { name: 'For Seed Brand Two', kind: 'CUSTOMER', partyId: brands.second.partyId, steps: [STEPS[0], STEPS[3]] }, 201)
    const listed = (await ok('manager', 'GET', routesUrl())).routes
    expect(listed.map((route: Json) => route.name)).toEqual(['Racing model', 'For Seed Customer One', 'For Seed Brand Two'])
    // The GET routing answer holds them too.
    expect((await ok('manager', 'GET', `/product/styles/${style.id}/revisions/${revision.id}/routing`)).routing.routes).toHaveLength(3)
  })

  it('refuses a customer route without its customer and a route that breaks a rule, in words', async () => {
    expect((await call('manager', 'POST', routesUrl(), { name: 'No customer', kind: 'CUSTOMER', partyId: null, steps: STEPS })).statusCode).toBe(400)
    const lastNotPacking = await call('manager', 'POST', routesUrl(), { name: 'Wrong end', kind: 'MODEL', partyId: null, steps: [...STEPS].reverse() })
    expect(lastNotPacking.statusCode).toBe(400)
    expect(codesOf(lastNotPacking.json())).toEqual(['LAST_NOT_PACKING'])
  })

  it('changes a route whole under its version (a stale one is refused) and takes one out', async () => {
    const changed = (await ok('manager', 'PUT', `${routesUrl()}/${model.id}`, { version: model.version, name: 'Racing model, light', kind: 'MODEL', partyId: null, steps: [STEPS[0], STEPS[3]] })).route
    expect(changed).toMatchObject({ name: 'Racing model, light', version: model.version + 1 })
    expect(changed.steps.map((step: Json) => step.number)).toEqual([2, 6])
    expect((await call('manager', 'PUT', `${routesUrl()}/${model.id}`, { version: model.version, name: 'x', kind: 'MODEL', partyId: null, steps: STEPS })).statusCode).toBe(409)
    model = changed
  })

  it('never lists another customer’s route in "Start from a copy" for a person limited to one customer', async () => {
    const products = (await ok('brandB', 'GET', '/product/route-sources?q=OWB-RT')).products
    const mine = products.find((entry: Json) => entry.styleId === style.id)
    expect(mine).toBeDefined()
    expect(mine.routes.map((route: Json) => route.name).sort()).toEqual(['For Seed Brand Two', 'Racing model, light'])
    expect(JSON.stringify(products)).not.toContain('For Seed Customer One')
    // The manager sees all three.
    const all = (await ok('manager', 'GET', '/product/route-sources?q=OWB-RT')).products.find((entry: Json) => entry.styleId === style.id)
    expect(all.routes).toHaveLength(3)
  })
})

describe('ready-made routes (owb-pd2 2.3)', () => {
  it('saves, refuses a second open one of the same name, closes (kept) and opens again', async () => {
    const made = (await ok('manager', 'POST', '/product/route-templates', { name: 'Leather garment', steps: STEPS }, 201)).template
    expect(made).toMatchObject({ name: 'Leather garment', status: 'OPEN', version: 1 })
    const twice = await call('manager', 'POST', '/product/route-templates', { name: 'leather garment', steps: STEPS })
    expect(twice.statusCode).toBe(409)
    expect(codesOf(twice.json())).toEqual(['NAME_TAKEN'])
    const closed = (await ok('manager', 'POST', `/product/route-templates/${made.id}/close`, { version: made.version })).template
    expect(closed.status).toBe('CLOSED')
    expect((await ok('manager', 'GET', '/product/route-templates')).templates.map((entry: Json) => entry.id)).not.toContain(made.id)
    expect((await ok('manager', 'GET', '/product/route-templates?status=ALL')).templates.map((entry: Json) => entry.id)).toContain(made.id)
    expect((await ok('manager', 'POST', `/product/route-templates/${made.id}/open`, { version: closed.version })).template.status).toBe('OPEN')
  })
})

describe("a frozen revision's routes go into its next draft (owb-pd2 2.3)", () => {
  it('copies each route and its steps into the new draft', async () => {
    const released = (await ok('manager', 'GET', `/product/styles/${brands.styleId}/revisions`)).revisions.find((entry: Json) => entry.status === 'RELEASED')
    const routeId = newId()
    const operation = (await admin<{ id: string }>(`SELECT id FROM "Operation" WHERE "departmentId" = $1 AND "departmentDefault"`, [department(6)]))[0]!.id
    const cutting = (await admin<{ id: string }>(`SELECT id FROM "Operation" WHERE "departmentId" = $1 AND "departmentDefault"`, [department(2)]))[0]!.id
    // Test data written past the freeze guard (a released revision's routes are frozen for every login).
    await admin(`DO $$ BEGIN
      SET LOCAL session_replication_role = replica;
      INSERT INTO "StyleRoute" (id, "tenantId", "styleId", "revisionId", "companyId", name, kind, "partyId", seq, version, "createdAt", "updatedAt")
        VALUES ('${routeId}', '${tenant}', '${brands.styleId}', '${released.id}', NULL, 'Brand Two model', 'MODEL', NULL, 1, 1, now(), now());
      INSERT INTO "StyleRouteStep" (id, "tenantId", "revisionId", "routeId", seq, "departmentId", "operationId", minutes, "createdAt", "updatedAt")
        VALUES ('${newId()}', '${tenant}', '${released.id}', '${routeId}', 10, '${department(2)}', '${cutting}', 3.5, now(), now()),
               ('${newId()}', '${tenant}', '${released.id}', '${routeId}', 20, '${department(6)}', '${operation}', NULL, now(), now());
    END $$`)
    const { bom } = await ok('manager', 'POST', `/product/styles/${brands.styleId}/revisions/${released.id}/copy`, { changeNote: 'Next season.' })
    const copied = (await ok('manager', 'GET', `/product/styles/${brands.styleId}/revisions/${bom.revision.id}/routes`)).routes
    expect(copied).toHaveLength(1)
    expect(copied[0]).toMatchObject({ name: 'Brand Two model', kind: 'MODEL', party: null })
    expect(copied[0].id).not.toBe(routeId)
    expect(copied[0].steps.map((step: Json) => [step.number, step.minutes])).toEqual([
      [2, '3.5'],
      [6, null],
    ])
  })
})
