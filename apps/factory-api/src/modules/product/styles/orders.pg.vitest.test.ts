import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedSales } from '../../../../../../packages/factory-db/seed/sales'
import { seed as seedTwoBrands, type TwoBrandsSeed } from '../../../../../../packages/factory-db/seed/two-brands'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * owb-pd1 1.1 on the local stack with the app's real routes: GET /product/styles/:styleId/orders — where a product is used, its
 * open order lines. The sales seed's SEED-SO-0001 (P1, CONFIRMED: the jacket BLK 2/4/2 and RED 1/2/1 in 50/52/54) and the
 * two-brands seed's SEED-SO-B001 (Seed Brand Two, its own jacket SEED-JKT-B2, BLK 2/3/1). Walls: a person limited to Seed Brand
 * Two never finds P1's jacket (404); a person with only orders.view.own (the designer, base settle 9) sees only the orders they
 * are on; nobody reads a price here. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs product/styles/orders`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let brands: TwoBrandsSeed

const NS = 'owb-pd1-orders'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const jacket = seedId('product:style:JKT-01')
const orderA = seedId('sales:SO1')
const member = seedId('user:member')

type Json = Record<string, any>
const grant = (permissions: readonly Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions: [...permissions], companies: 'all', sites: 'all', parties })
const SESSIONS: Record<string, () => SessionContext> = {
  sales: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['product.styles.view', 'orders.view'])] }),
  brandB: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['product.styles.view', 'orders.view'], [brands.second.partyId])] }),
  // The designer's rights (base settle 9): orders.view.own, never orders.view. A real office user, so "on the order" can name them.
  designer: () => ({ audience: 'office', tenantId: tenant, actorId: member, grants: [grant(['product.styles.view', 'orders.view.own', 'product.drafts.edit'])] }),
  plain: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['product.styles.view'])] }),
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
async function ok(session: string, url: string): Promise<Json> {
  const response = await call(session, url)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const ordersOf = (session: string, styleId: string): Promise<Json> => ok(session, `/product/styles/${styleId}/orders`)

beforeAll(async () => {
  db = await migratedDatabase('owb_pd1_orders')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedAuth({ db: database, namespace: NS })
  await seedSales({ db: database, namespace: NS })
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

describe('where a product is used: its open order lines (owb-pd1 1.1)', () => {
  it('lists the open lines of the product with order, customer, pieces, sizes in words and the life word', async () => {
    const answer = await ordersOf('sales', jacket)
    const mine = answer.lines.filter((line: Json) => line.orderId === orderA)
    expect(mine).toHaveLength(2)
    for (const line of mine) {
      expect(line).toMatchObject({ orderNumber: 'SEED-SO-0001', customer: { id: seedId('party:P1') }, measurement: null, life: 'CONFIRMED' })
      expect(typeof line.customer.name).toBe('string')
    }
    expect(mine.map((line: Json) => line.sizes).sort()).toEqual(['50 × 1 · 52 × 2 · 54 × 1', '50 × 2 · 52 × 4 · 54 × 2'])
    expect(mine.map((line: Json) => line.quantity).sort()).toEqual([4, 8])
    expect(answer.totals.openOrders).toBeGreaterThanOrEqual(1)
    expect(answer.totals.openPieces).toBeGreaterThanOrEqual(12)
  })

  it('names no price, cost or amount anywhere in the answer', async () => {
    const text = JSON.stringify(await ordersOf('sales', jacket))
    for (const word of ['unitPrice', 'netAmount', 'vatAmount', 'unitCost', 'costAmount', 'price', 'margin']) expect(text, word).not.toContain(word)
  })

  it('keeps the brand wall: a person limited to Seed Brand Two never finds P1’s product (404) and reads only its own', async () => {
    const refused = await call('brandB', `/product/styles/${jacket}/orders`)
    expect(refused.statusCode).toBe(404)
    const own = await ordersOf('brandB', brands.styleId)
    expect(own.lines.length).toBeGreaterThan(0)
    expect(new Set(own.lines.map((line: Json) => line.customer?.id))).toEqual(new Set([brands.second.partyId]))
    expect(JSON.stringify(own)).not.toContain(seedId('party:P1'))
  })

  it('shows a person with only orders.view.own the orders they are on, and no other', async () => {
    const before = await ordersOf('designer', jacket)
    expect(before).toEqual({ lines: [], totals: { openOrders: 0, openPieces: 0 } })
    await admin(`INSERT INTO "RecordFollower" (id, "tenantId", "recordType", "recordId", "userId", reason, "createdAt", "updatedAt") VALUES ($1, $2, 'SalesOrder', $3, $4, 'ADDED', now(), now())`, [newId(), tenant, orderA, member])
    const after = await ordersOf('designer', jacket)
    expect(new Set(after.lines.map((line: Json) => line.orderId))).toEqual(new Set([orderA]))
    expect(after.totals).toEqual({ openOrders: 1, openPieces: 12 })
    // Seed Brand Two's order: not one they are on.
    expect((await ordersOf('designer', brands.styleId)).lines).toEqual([])
  })

  it('refuses in words a person who may see no order (403)', async () => {
    const refused = await call('plain', `/product/styles/${jacket}/orders`)
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error.message).toContain('orders')
  })
})
