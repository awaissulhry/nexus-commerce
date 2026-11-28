import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPricing } from '../../../../../../packages/factory-db/seed/pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * owb-pd1 1.2 on the local stack with the app's real routes: what the Products list and record add — type and family, open
 * orders, the agreed price range (price grain), the margin on the kept standard cost or the rough standard of its kind (margin
 * grain, costing.view), and "How it is made" on the record (departments, never minutes). The pricing seed's SEED-PL-P1 (a
 * CUSTOMER list in EUR, version 1 ACTIVE: SEED-JKT-01 420.00, its RED colourway 430.00), the sales seed's SEED-SO-0001 (the
 * jacket, CONFIRMED) and the production seed's SEED-JKT-02 (the same kind: a jacket without a type profile). Every figure is
 * made up. Run with `node scripts/factory/run-pg-tests.mjs product/styles/row-extras-owb`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'owb-pd1-row-extras'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const owner = seedId('actor')
const companyA = seedId('company:A')
const jacket = seedId('product:style:JKT-01')
const AT = new Date('2026-11-01T08:00:00.000Z')

const VIEW: Permission[] = ['product.styles.view', 'orders.view', 'pricelists.view', 'costing.view']
const grant = (permissions: readonly Permission[]): Grant => ({ permissions: [...permissions], companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, () => SessionContext> = {
  everything: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant([...VIEW, 'money.price', 'money.cost', 'money.margin'] as Permission[])] }),
  // The cost grain alone (a buyer): neither the agreed prices nor the margin, which would give the price away.
  costOnly: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant([...VIEW, 'money.cost'] as Permission[])] }),
  priceOnly: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant([...VIEW, 'money.price'] as Permission[])] }),
  plain: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['product.styles.view'])] }),
}

type Json = Record<string, any>
async function ok(session: string, url: string): Promise<Json> {
  const response = await app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}
const rowOf = async (session: string, styleId = jacket): Promise<Json> => (await ok(session, `/product/styles?status=ALL&companyId=${companyA}&limit=200`)).styles.find((row: Json) => row.id === styleId)

/** A FINISHED item for the SKU (made once) and a FROZEN standard cost of company A for it from 2026-10-01, as finance keeps one. */
async function keep(variantId: string, code: string, unitCost: string): Promise<void> {
  await database.withScope({ audience: 'office', tenantId: tenant, actorId: owner }, (client) =>
    client.$transaction(async (tx) => {
      const found = await tx.item.findFirst({ where: { variantId }, select: { id: true } })
      const itemId = found?.id ?? newId()
      if (!found) {
        await tx.item.create({
          data: { id: itemId, code, name: `${code} (finished)`, kind: 'FINISHED', sourcing: 'MAKE', tracking: 'NONE', baseUom: 'PCS', purchaseUom: 'PCS', consumptionUom: 'PCS', variantId, createdAt: AT, updatedAt: AT, createdById: owner },
          select: { id: true },
        })
      }
      const id = newId()
      await tx.standardCost.createMany({ data: [{ id, companyId: companyA, itemId, validFrom: new Date('2026-10-01T00:00:00.000Z'), source: 'MANUAL', materialCost: unitCost, unitCost, createdAt: AT, updatedAt: AT, createdById: owner }] })
      await tx.standardCost.updateMany({ where: { id }, data: { status: 'FROZEN', frozenAt: AT, frozenById: owner, version: 2 } })
    }),
  )
}

beforeAll(async () => {
  db = await migratedDatabase('owb_pd1_row_extras')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedPricing({ db: database, namespace: NS })
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

describe('what the Products list adds (owb-pd1 1.2)', () => {
  it('says the type and family and counts the open orders the person may see', async () => {
    const row = await rowOf('everything')
    expect(row).toMatchObject({ typeName: null, family: 'FOR_CUSTOMER' })
    expect(row.openOrders).toBeGreaterThanOrEqual(1)
    // Without an orders right: no order is counted.
    expect((await rowOf('plain')).openOrders).toBe(0)
  })

  it('gives the agreed price range only with the price grain', async () => {
    const row = await rowOf('everything')
    expect(row.agreedRange).toMatchObject({ count: 2, currency: 'EUR' })
    expect([Number(row.agreedRange.low), Number(row.agreedRange.high)]).toEqual([420, 430])
    expect((await rowOf('priceOnly')).agreedRange).toMatchObject({ count: 2 })
    expect('agreedRange' in (await rowOf('costOnly'))).toBe(false)
    expect('agreedRange' in (await rowOf('plain'))).toBe(false)
  })

  it('gives no margin without the margin grain (the cost grain alone is not enough), and none before a cost is kept', async () => {
    for (const session of ['costOnly', 'priceOnly', 'plain']) {
      const row = await rowOf(session)
      expect('marginPct' in row, session).toBe(false)
      expect('marginFrom' in row, session).toBe(false)
    }
    expect(await rowOf('everything')).toMatchObject({ marginPct: null, marginFrom: null })
  })

  it('takes the rough standard of its kind while none is kept, then its own kept standard cost (lowest agreed price)', async () => {
    // Another jacket (no type profile: the same kind) keeps 280.00: the jacket's margin is "of its kind".
    await keep(seedId('production:variant:JKT-02:BLK:52'), 'SEED-JKT-02-BLK-52-OWB', '280.000000')
    expect(await rowOf('everything')).toMatchObject({ marginPct: '33.3333', marginFrom: 'KIND' })
    // Its own SKU keeps 300.00: KEPT wins; margin = (420 - 300) / 420.
    await keep(seedId('product:variant:JKT-01:BLK:52'), 'SEED-JKT-01-BLK-52-OWB', '300.000000')
    expect(await rowOf('everything')).toMatchObject({ marginPct: '28.5714', marginFrom: 'KEPT' })
    // Still never for the cost grain alone.
    expect('marginPct' in (await rowOf('costOnly'))).toBe(false)
  })
})

describe('"How it is made" on the record (owb-pd1 1.2)', () => {
  it('lists the departments of the current revision, for a person who only reads products, with no minutes', async () => {
    const { style } = await ok('plain', `/product/styles/${jacket}`)
    // The product seed's route: cut, sew, final inspection, pack → 2 Cutting, 4 Stitching, 5 Quality, 6 Packing.
    expect(style.routeSummary.map((step: Json) => step.number)).toEqual([2, 4, 5, 6])
    for (const step of style.routeSummary) expect(Object.keys(step).sort()).toEqual(['departmentId', 'icon', 'number', 'shortName', 'tone'])
    expect(JSON.stringify(style.routeSummary)).not.toMatch(/minute/i)
  })
})
