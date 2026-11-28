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
 * owb-pd2 2.2 on the local stack with the app's real routes: the route builder's ONE save of a product route,
 * `PUT …/revisions/:revisionId/routing/steps`, and the GET's departments and rules. The product seed's jacket SEED-JKT-01 (revision
 * 1 DRAFT: cut, sew, final inspection, pack → departments 2, 4, 5, 6) and the two-brands seed's SEED-JKT-B2 (revision 1 RELEASED).
 * A kept step keeps its row and its depth (a size time); a new step is its department's default operation; the rules refuse in
 * words. Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs product/routing/save`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let brands: TwoBrandsSeed

const NS = 'owb-pd2-route-save'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const jacket = seedId('product:style:JKT-01')
const draft = seedId('product:revision:JKT-01:1')
const department = (number: number): string => seedId(`product:department:${number}`)

const grant = (permissions: readonly Permission[]): Grant => ({ permissions: [...permissions], companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, () => SessionContext> = {
  manager: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['product.styles.view', 'product.routing.view', 'product.routing.manage'])] }),
  // The designer reads the route's names; it never opens the builder (S4 settle 5).
  designer: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['product.styles.view', 'product.bom.view', 'product.drafts.edit', 'product.routing.view'])] }),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'PUT', url: string, payload?: unknown): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const routingUrl = (styleId: string, revisionId: string): string => `/product/styles/${styleId}/revisions/${revisionId}/routing`
const routingOf = async (styleId = jacket, revisionId = draft): Promise<Json> => (await ok('manager', 'GET', routingUrl(styleId, revisionId))).routing
const codesOf = (body: Json): string[] => (body.error?.issues ?? []).filter((issue: Json) => String(issue.path).startsWith('refusal/')).map((issue: Json) => String(issue.path).slice('refusal/'.length))

beforeAll(async () => {
  db = await migratedDatabase('owb_pd2_route_save')
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
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the product route: departments and rules on the GET (owb-pd2 2.2)', () => {
  it('names each step’s department (the kind’s on an old step) and says the rules', async () => {
    const routing = await routingOf()
    expect(routing.steps.map((step: Json) => step.department?.number)).toEqual([2, 4, 5, 6])
    expect(routing.rules).toEqual({ errors: [], warnings: [] })
  })
})

describe('the ONE save of a product route (owb-pd2 2.2)', () => {
  it('keeps a kept step’s row and depth, makes a new step from the department’s default operation, moves and renumbers', async () => {
    const before = await routingOf()
    const [cut, sew, qc, pack] = before.steps as Json[]
    await admin(`INSERT INTO "RoutingOperationSizeTime" (id, "tenantId", "revisionId", "routingOperationId", size, "extraMinutes", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, '54', 4.5, now(), now())`, [newId(), tenant, draft, sew!.id])
    const saved = (
      await ok('manager', 'PUT', `${routingUrl(jacket, draft)}/steps`, {
        version: before.revision.version,
        steps: [
          { stepId: cut!.id, departmentId: department(1) },
          { departmentId: department(3), minutes: '5' },
          { stepId: sew!.id, departmentId: department(4), minutes: '90' },
          { stepId: qc!.id, departmentId: department(5) },
          { stepId: pack!.id, departmentId: department(6) },
        ],
      })
    ).routing
    expect(saved.revision.version).toBe(before.revision.version + 1)
    expect(saved.steps.map((step: Json) => [step.seq, step.department?.number])).toEqual([
      [10, 1],
      [20, 3],
      [30, 4],
      [40, 5],
      [50, 6],
    ])
    // The kept steps are the same rows; the sewing step keeps its size time and takes the typed minutes.
    expect(saved.steps[0].id).toBe(cut!.id)
    expect(saved.steps[2]).toMatchObject({ id: sew!.id, standardMinutes: '90', code: sew!.code })
    expect(await admin(`SELECT size FROM "RoutingOperationSizeTime" WHERE "routingOperationId" = $1`, [sew!.id])).toEqual([{ size: '54' }])
    // The new step: the default operation DEPT-3 of Patch & print, its department copied.
    expect(saved.steps[1]).toMatchObject({ code: 'DEPT-3', standardMinutes: '5' })
    expect((await admin<{ departmentId: string }>(`SELECT "departmentId" FROM "RoutingOperation" WHERE id = $1`, [saved.steps[1].id]))[0]!.departmentId).toBe(department(3))
    expect((await admin<{ departmentId: string }>(`SELECT "departmentId" FROM "RoutingOperation" WHERE id = $1`, [cut!.id]))[0]!.departmentId).toBe(department(1))
    expect(saved.rules).toEqual({ errors: [], warnings: [] })
  })

  it('removes a step the route no longer names, and notes a route with no quality check', async () => {
    const before = await routingOf()
    const kept = (before.steps as Json[]).filter((step) => step.department?.number !== 5)
    const saved = (await ok('manager', 'PUT', `${routingUrl(jacket, draft)}/steps`, { version: before.revision.version, steps: kept.map((step) => ({ stepId: step.id, departmentId: step.department.id })) })).routing
    expect(saved.steps.map((step: Json) => step.department?.number)).toEqual([1, 3, 4, 6])
    expect(saved.rules).toEqual({ errors: [], warnings: ['NO_QUALITY'] })
  })

  it('refuses a route that breaks a rule, in words, and changes nothing', async () => {
    const before = await routingOf()
    const steps = before.steps as Json[]
    const lastNotPacking = await call('manager', 'PUT', `${routingUrl(jacket, draft)}/steps`, { version: before.revision.version, steps: [...steps].reverse().map((step) => ({ stepId: step.id, departmentId: step.department.id })) })
    expect(lastNotPacking.statusCode).toBe(400)
    expect(codesOf(lastNotPacking.json())).toEqual(['LAST_NOT_PACKING'])
    const tooFew = await call('manager', 'PUT', `${routingUrl(jacket, draft)}/steps`, { version: before.revision.version, steps: [{ stepId: steps.at(-1)!.id, departmentId: department(6) }] })
    expect(codesOf(tooFew.json())).toEqual(['TOO_FEW'])
    expect(tooFew.json().error.issues[0].message).toBe('A route has 2 steps or more.')
    // A closed department may not come in new.
    await admin(`UPDATE "Department" SET status = 'CLOSED', version = version + 1 WHERE id = $1`, [department(8)])
    const closed = await call('manager', 'PUT', `${routingUrl(jacket, draft)}/steps`, {
      version: before.revision.version,
      steps: [{ departmentId: department(8) }, ...steps.map((step) => ({ stepId: step.id, departmentId: step.department.id }))],
    })
    expect(closed.statusCode).toBe(400)
    expect(codesOf(closed.json())).toEqual(['DEPARTMENT_CLOSED'])
    expect((await routingOf()).revision.version).toBe(before.revision.version)
  })

  it('is refused on a RELEASED revision (409), and to the designer (403)', async () => {
    const revisionId = (await ok('manager', 'GET', `/product/styles/${brands.styleId}/revisions`)).revisions.find((entry: Json) => entry.status === 'RELEASED').id
    const released = await routingOf(brands.styleId, revisionId)
    const steps = (released.steps as Json[]).map((step) => ({ stepId: step.id, departmentId: step.department.id }))
    const frozen = await call('manager', 'PUT', `${routingUrl(brands.styleId, revisionId)}/steps`, { version: released.revision.version, steps })
    expect(frozen.statusCode, frozen.body).toBe(409)
    const before = await routingOf()
    const designer = await call('designer', 'PUT', `${routingUrl(jacket, draft)}/steps`, { version: before.revision.version, steps: (before.steps as Json[]).map((step) => ({ stepId: step.id, departmentId: step.department.id })) })
    expect(designer.statusCode).toBe(403)
  })
})
