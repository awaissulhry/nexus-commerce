import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { LINE_ROUTE_REFUSALS } from '@nexus/factory-domain/product/routing/line-route-contracts'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedProduct } from '../../../../../../packages/factory-db/seed/product'
import { seed as seedTwoBrands, type TwoBrandsSeed } from '../../../../../../packages/factory-db/seed/two-brands'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { lineRouteFacts } from './facts'

/**
 * owb-pd2 2.4 on the local stack with the app's real routes: the route of each order line. The two-brands seed's SEED-SO-B001 (Seed
 * Brand Two, line 10: SEED-JKT-B2 revision 1 RELEASED, its routing cut, sew, inspect, pack) with a model route of that revision
 * planted past the freeze guard. Sales picks the model; only the production manager makes an exception (sales: 403 in words); every
 * change is refused once the basket cards are printed (409 FROZEN); a person limited to P1 never finds the order. Every name is made
 * up. Run with `node scripts/factory/run-pg-tests.mjs product/line-routes`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let brands: TwoBrandsSeed

const NS = 'owb-pd2-line-routes'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const department = (number: number): string => seedId(`product:department:${number}`)
const modelId = newId()

const grant = (permissions: readonly Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions: [...permissions], companies: 'all', sites: 'all', parties })
const SESSIONS: Record<string, () => SessionContext> = {
  // Real office users (the auth seed's member and owner): the line route row names who picked and who made the exception.
  sales: () => ({ audience: 'office', tenantId: tenant, actorId: seedId('user:member'), grants: [grant(['orders.view', 'orders.manage'])] }),
  manager: () => ({ audience: 'office', tenantId: tenant, actorId: seedId('actor'), grants: [grant(['orders.view', 'product.routing.view', 'product.routing.manage'])] }),
  onlyP1: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['orders.view', 'orders.manage'], [seedId('party:P1')])] }),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const refusalOf = (body: Json): string | null => {
  const issue = (body.error?.issues ?? []).find((entry: Json) => String(entry.path).startsWith('refusal/'))
  return issue ? String(issue.path).slice('refusal/'.length) : null
}
const orderUrl = (): string => `/sales/orders/${brands.second.salesOrderId}`
const lineUrl = (): string => `${orderUrl()}/lines/${brands.salesOrderLineId}`
const lineOf = async (session = 'sales'): Promise<Json> => (await ok(session, 'GET', `${orderUrl()}/line-routes`)).lines.find((line: Json) => line.lineId === brands.salesOrderLineId)

beforeAll(async () => {
  db = await migratedDatabase('owb_pd2_line_routes')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedProduct({ db: database, namespace: NS })
  brands = await seedTwoBrands({ db: database, namespace: NS })
  const revisionId = (await admin<{ id: string }>(`SELECT id FROM "StyleRevision" WHERE "styleId" = $1 AND status = 'RELEASED'`, [brands.styleId]))[0]!.id
  const operationOf = async (number: number): Promise<string> => (await admin<{ id: string }>(`SELECT id FROM "Operation" WHERE "departmentId" = $1 AND "departmentDefault"`, [department(number)]))[0]!.id
  const [cut, patch, sew, pack] = [await operationOf(2), await operationOf(3), await operationOf(4), await operationOf(6)]
  // A model route of the released revision: test data written past the freeze guard.
  await admin(`DO $$ BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO "StyleRoute" (id, "tenantId", "styleId", "revisionId", "companyId", name, kind, "partyId", seq, version, "createdAt", "updatedAt")
      VALUES ('${modelId}', '${tenant}', '${brands.styleId}', '${revisionId}', NULL, 'Patched model', 'MODEL', NULL, 1, 1, now(), now());
    INSERT INTO "StyleRouteStep" (id, "tenantId", "revisionId", "routeId", seq, "departmentId", "operationId", minutes, "createdAt", "updatedAt")
      VALUES ('${newId()}', '${tenant}', '${revisionId}', '${modelId}', 10, '${department(2)}', '${cut}', NULL, now(), now()),
             ('${newId()}', '${tenant}', '${revisionId}', '${modelId}', 20, '${department(3)}', '${patch}', 6, now(), now()),
             ('${newId()}', '${tenant}', '${revisionId}', '${modelId}', 30, '${department(4)}', '${sew}', NULL, now(), now()),
             ('${newId()}', '${tenant}', '${revisionId}', '${modelId}', 40, '${department(6)}', '${pack}', NULL, now(), now());
  END $$`)
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

describe('the route of each order line (owb-pd2 2.4)', () => {
  it('reads the product route, the model sales may pick, and who may do what', async () => {
    const answer = await ok('sales', 'GET', `${orderUrl()}/line-routes`)
    expect(answer).toMatchObject({ frozen: false, may: { pick: true, exception: false } })
    const line = answer.lines.find((entry: Json) => entry.lineId === brands.salesOrderLineId)
    expect(line).toMatchObject({ source: 'REVISION', routeName: null, pickedRouteId: null, exception: null, version: null, choices: [{ routeId: modelId, name: 'Patched model' }] })
    expect(line.steps.map((step: Json) => step.number)).toEqual([2, 4, 5, 6])
    // The ONE read S2, S3 and S5 use answers the same.
    const facts = await database.withScope({ audience: 'office', tenantId: tenant, actorId: seedId('actor') }, (client) => lineRouteFacts(client, brands.second.salesOrderId))
    expect(facts.find((entry) => entry.lineId === brands.salesOrderLineId)?.route.source).toBe('REVISION')
  })

  it('keeps the brand wall: a person limited to another customer never finds the order (404)', async () => {
    expect((await call('onlyP1', 'GET', `${orderUrl()}/line-routes`)).statusCode).toBe(404)
  })

  it('lets sales pick the model; the line then follows it', async () => {
    await ok('sales', 'PUT', `${lineUrl()}/route`, { routeId: modelId })
    const line = await lineOf()
    expect(line).toMatchObject({ source: 'MODEL', routeName: 'Patched model', pickedRouteId: modelId, version: 1 })
    expect(line.steps.map((step: Json) => [step.number, step.minutes])).toEqual([
      [2, null],
      [3, '6'],
      [4, null],
      [6, null],
    ])
    // Not a model of this product: refused.
    const wrong = await call('sales', 'PUT', `${lineUrl()}/route`, { version: 1, routeId: newId() })
    expect(wrong.statusCode).toBe(400)
    expect(refusalOf(wrong.json())).toBe('NOT_A_MODEL')
  })

  it('refuses sales an exception, in words (403); the production manager makes one and takes it back', async () => {
    const sales = await call('sales', 'PUT', `${lineUrl()}/route-exception`, { version: 1, steps: [{ departmentId: department(2) }, { departmentId: department(6) }], reason: 'The customer sends the patches sewn.' })
    expect(sales.statusCode).toBe(403)
    expect(refusalOf(sales.json())).toBe('ONLY_PRODUCTION_MANAGER')
    expect(sales.json().error.message).toBe(LINE_ROUTE_REFUSALS.ONLY_PRODUCTION_MANAGER.en)
    const made = await ok('manager', 'PUT', `${lineUrl()}/route-exception`, { version: 1, steps: [{ departmentId: department(2) }, { departmentId: department(4) }, { departmentId: department(6) }], reason: 'The customer sends the patches sewn.' })
    const line = made.lines.find((entry: Json) => entry.lineId === brands.salesOrderLineId)
    expect(line).toMatchObject({ source: 'EXCEPTION', routeName: null, exception: { reason: 'The customer sends the patches sewn.' }, version: 2 })
    expect(line.steps.map((step: Json) => step.number)).toEqual([2, 4, 6])
    const back = await ok('manager', 'DELETE', `${lineUrl()}/route-exception?version=2`)
    expect(back.lines.find((entry: Json) => entry.lineId === brands.salesOrderLineId)).toMatchObject({ source: 'MODEL', exception: null, version: 3 })
    // The audit rows are the order's, internal.
    const actions = await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1 AND action LIKE 'order.line.route%'`, [brands.second.salesOrderId])
    expect(new Set(actions.map((row) => row.action))).toEqual(new Set(['order.line.route_picked', 'order.line.route_exception']))
  })

  it('refuses every change once the basket cards are printed (409 FROZEN, in words)', async () => {
    await admin(`DO $$ BEGIN
      SET LOCAL session_replication_role = replica;
      INSERT INTO "OrderPrint" (id, "tenantId", "companyId", "partyId", "salesOrderId", kind, pages, cards, "createdAt")
        VALUES ('${newId()}', '${tenant}', '${seedId('company:A')}', '${brands.second.partyId}', '${brands.second.salesOrderId}', 'FIRST', '[]'::jsonb, '[]'::jsonb, now());
    END $$`)
    const answer = await ok('sales', 'GET', `${orderUrl()}/line-routes`)
    expect(answer).toMatchObject({ frozen: true, may: { pick: false, exception: false } })
    const frozen = await call('sales', 'PUT', `${lineUrl()}/route`, { version: 3, routeId: null })
    expect(frozen.statusCode).toBe(409)
    expect(refusalOf(frozen.json())).toBe('FROZEN')
    expect(frozen.json().error.message).toBe('Fixed at the print of the basket cards.')
    expect((await call('manager', 'PUT', `${lineUrl()}/route-exception`, { version: 3, steps: [{ departmentId: department(2) }, { departmentId: department(6) }], reason: 'Late.' })).statusCode).toBe(409)
  })
})
