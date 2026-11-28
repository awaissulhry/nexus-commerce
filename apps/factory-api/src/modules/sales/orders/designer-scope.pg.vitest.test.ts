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
import { seed as seedPortalSales } from '../../../../../../packages/factory-db/seed/portal-sales'
import { seed as seedProduct } from '../../../../../../packages/factory-db/seed/product'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { PRODUCTION_NEEDS_ALLOW } from './production-read'

/**
 * owb-of1a (order workflow, plan.md § 5 D R20 "the designer sees only his orders"; the base swapped orders.view → orders.view.own
 * in the `designer` template and dropped sales.inquiries.view): the reads the Factory designer uses, through the app's real routes
 * on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security is real), on the factory-db
 * seeds up to the customer portal (SEED-SO-0001/-0002/-0003 are customer P1's; SEED-SO-0002 was made from SEED-RQ-0002; SEED-RQ-0001
 * is a SENT request of no order). The designer FOLLOWS SEED-SO-0001 and SEED-RQ-0002 (planted, the database's rules off) and is
 * on nothing else. Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/orders/designer-scope`.
 *
 *   DS-1  not on the order → 404 on the order, its production, its files, its log, its Changes (nothing says it exists)
 *   DS-2  on it (a follow of the order, or of the request it came from) → 200; the request's log too
 *   DS-3  the Production read needs workorders.view beside orders.view.own ("Allow production"): 403 in words without it
 *   DS-4  the orders list lists only his orders (filtered in SQL: the page and the board count only them)
 *   DS-5  Incoming: orders.view.own alone → 403; a command that writes stays orders.manage → 403
 *   DS-6  Sales (orders.view) unchanged: every order of its scope; someone with neither right is refused 403 as before
 *   DS-7  the customer's Factory designer slot opens every order of that customer to its designer
 */

vi.setConfig({ testTimeout: 120_000 })

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'owb-designer-scope'
const id = (key: string): string => seedUuid(NS, key)
const tenant = id('tenant')

const PEOPLE = { designer: newId(), slot: newId(), sales: newId(), nobody: newId() }
// The office role "Factory designer" as the base left it (factory-domain auth/roles/templates.ts `designer`), and its extra right.
const DESIGNER: Permission[] = ['home.view', 'files.read', 'files.upload', 'threads.read', 'threads.post', 'parties.view', 'orders.view.own', 'sales.samples.view', 'product.styles.view', 'product.bom.view', 'views.save', 'production.calls.answer', 'tasks.manage'] as Permission[]
const grant = (permissions: readonly Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const session = (actorId: string, ...grants: Grant[]) => (): SessionContext => ({ audience: 'office', tenantId: tenant, actorId, grants })
const SESSIONS: Record<string, () => SessionContext> = {
  designer: session(PEOPLE.designer, grant(DESIGNER)),
  // "Allow production" (the base's extra role extra_allow_production) as its own role assignment beside the designer's.
  designerProduction: session(PEOPLE.designer, grant(DESIGNER), grant(['workorders.view' as Permission])),
  slot: session(PEOPLE.slot, grant(DESIGNER)),
  sales: session(PEOPLE.sales, grant(['orders.view', 'orders.manage', 'files.read', 'threads.read', 'sales.inquiries.view'] as Permission[])),
  nobody: session(PEOPLE.nobody, grant(['home.view', 'files.read'] as Permission[])),
}

type Json = Record<string, any>
const run = randomBytes(4).toString('hex')
let serial = 0
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const get = (who: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': who } })
const post = (who: string, url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object, headers: { 'x-test-session': who, 'idempotency-key': `owb-ds-${run}-${++serial}` } })

/** Rows written with the database's rules off (replica): what the reads read. */
async function planted(rows: readonly { readonly sql: string; readonly values: unknown[] }[]): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    for (const row of rows) await db.admin.query(row.sql, row.values)
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}

const seeded = { so1: '', so2: '', so3: '', rq1: '', rq2: '', party: '' }

beforeAll(async () => {
  db = await migratedDatabase('owb_designer_scope')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  await seedCore({ db: database, namespace: NS })
  await seedProduct({ db: database, namespace: NS })
  await seedPortalSales({ db: database, namespace: NS })
  const order = async (number: string) => one<{ id: string; partyId: string }>(`SELECT id, "partyId" FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2`, [tenant, number])
  const so1 = await order('SEED-SO-0001')
  seeded.so1 = so1.id
  seeded.party = so1.partyId
  seeded.so2 = (await order('SEED-SO-0002')).id
  seeded.so3 = (await order('SEED-SO-0003')).id
  seeded.rq1 = (await one<{ id: string }>(`SELECT id FROM "PortalOrderRequest" WHERE "tenantId" = $1 AND number = 'SEED-RQ-0001'`, [tenant])).id
  seeded.rq2 = (await one<{ id: string }>(`SELECT id FROM "PortalOrderRequest" WHERE "tenantId" = $1 AND number = 'SEED-RQ-0002'`, [tenant])).id
  await planted([
    ...Object.entries(PEOPLE).map(([key, userId]) => ({
      sql: `INSERT INTO "User" (id, "tenantId", email, "displayName", status, audience) VALUES ($1, $2, $3, $4, 'ACTIVE', 'OFFICE')`,
      values: [userId, tenant, `ds.${key}@example.com`, `Made-up ${key}`],
    })),
    { sql: `INSERT INTO "RecordFollower" (id, "tenantId", "recordType", "recordId", "userId", reason) VALUES ($1, $2, 'SalesOrder', $3, $4, 'CHOSE')`, values: [newId(), tenant, seeded.so1, PEOPLE.designer] },
    { sql: `INSERT INTO "RecordFollower" (id, "tenantId", "recordType", "recordId", "userId", reason, muted) VALUES ($1, $2, 'PortalOrderRequest', $3, $4, 'MENTIONED', true)`, values: [newId(), tenant, seeded.rq2, PEOPLE.designer] },
    {
      sql: `INSERT INTO "PortalSettings" (id, "tenantId", "partyId", "portalOn", "factoryDesignerId", "factoryDesignerSetAt", "createdAt", "updatedAt")
            VALUES ($1, $2, $1, false, $3, now(), now(), now())
            ON CONFLICT (id) DO UPDATE SET "factoryDesignerId" = $3, "factoryDesignerSetAt" = now()`,
      values: [seeded.party, tenant, PEOPLE.slot],
    },
  ])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

const READS = (orderId: string) => [`/sales/orders/${orderId}`, `/sales/orders/${orderId}/files`, `/sales/orders/${orderId}/log`, `/sales/orders/${orderId}/changes`, `/sales/orders/${orderId}/links`, `/sales/orders/${orderId}/milestones`]

describe('DS-1: an order the designer is not on is not found', () => {
  it('404 on the order, its production, files, log, Changes, links and dates — and its words never name it', async () => {
    for (const url of [...READS(seeded.so3), `/sales/orders/${seeded.so3}/production`]) {
      for (const who of ['designer', 'designerProduction']) {
        const refused = await get(who, url)
        expect(refused.statusCode, `${who} ${url}: ${refused.body.slice(0, 200)}`).toBe(404)
        expect(refused.body, url).not.toContain('SEED-SO-0003')
      }
    }
    // A Sent request of no order it follows: its log is not found either.
    expect((await get('designer', `/sales/order-requests/${seeded.rq1}/log`)).statusCode).toBe(404)
  })
})

describe('DS-2: an order the designer is on is read', () => {
  it('a follow of the order, or of the request it came from (muted too), opens its reads; the request\'s log too', async () => {
    for (const orderId of [seeded.so1, seeded.so2]) {
      for (const url of READS(orderId)) {
        const read = await get('designer', url)
        expect(read.statusCode, `${url}: ${read.body.slice(0, 300)}`).toBe(200)
      }
    }
    expect((await get('designer', `/sales/orders/${seeded.so1}`)).json().order).toMatchObject({ id: seeded.so1, number: 'SEED-SO-0001' })
    expect((await get('designer', `/sales/order-requests/${seeded.rq2}/log`)).statusCode).toBe(200)
  })
})

describe('DS-3: the Production read needs "Allow production"', () => {
  it('403 in words with orders.view.own alone; 200 with workorders.view beside it', async () => {
    const refused = await get('designer', `/sales/orders/${seeded.so1}/production`)
    expect(refused.statusCode, refused.body).toBe(403)
    expect(refused.json().error.message).toBe(PRODUCTION_NEEDS_ALLOW.en)
    const read = await get('designerProduction', `/sales/orders/${seeded.so1}/production`)
    expect(read.statusCode, read.body.slice(0, 300)).toBe(200)
  })
})

describe('DS-4: the orders list lists only his orders', () => {
  it('the page and the board count only the orders he is on', async () => {
    const list = await get('designer', '/sales/orders?limit=100')
    expect(list.statusCode, list.body.slice(0, 300)).toBe(200)
    const ids = (list.json().orders as Json[]).map((row) => row.id)
    expect(ids.sort()).toEqual([seeded.so1, seeded.so2].sort())
    // A narrower page: still his only, and the cursor walks to the second (never an order he is not on).
    const first = (await get('designer', '/sales/orders?limit=1')).json()
    expect(first.orders).toHaveLength(1)
    const second = (await get('designer', `/sales/orders?limit=1&cursor=${first.nextCursor}`)).json()
    expect([...first.orders, ...second.orders].map((row: Json) => row.id).sort()).toEqual([seeded.so1, seeded.so2].sort())
    const board = (await get('designer', '/sales/orders/board')).json()
    expect((board.byStatus as Json[]).reduce((sum, row) => sum + row.count, 0)).toBe(2)
  })
})

describe('DS-5: no Incoming, no writes', () => {
  it('Incoming answers 403 to orders.view.own alone; a command that writes stays orders.manage (403)', async () => {
    expect((await get('designer', '/sales/incoming')).statusCode).toBe(403)
    expect((await get('designer', '/sales/incoming/waiting-count')).statusCode).toBe(403)
    const order = await one<{ version: number }>('SELECT version FROM "SalesOrder" WHERE id = $1', [seeded.so1])
    expect((await post('designer', `/sales/orders/${seeded.so1}/cancel`, { version: order.version, reason: 'Made-up reason', confirmNumber: 'SEED-SO-0001' })).statusCode).toBe(403)
  })
})

describe('DS-6: Sales unchanged; without either right refused as before', () => {
  it('orders.view reads every order of its scope and lists them all; a person with neither right gets 403', async () => {
    for (const url of READS(seeded.so3)) expect((await get('sales', url)).statusCode, url).toBe(200)
    const ids = ((await get('sales', '/sales/orders?limit=100')).json().orders as Json[]).map((row) => row.id)
    expect(ids).toEqual(expect.arrayContaining([seeded.so1, seeded.so2, seeded.so3]))
    expect((await get('sales', '/sales/incoming')).statusCode).toBe(200)
    for (const url of ['/sales/orders', '/sales/orders/board', `/sales/orders/${seeded.so1}`, `/sales/orders/${seeded.so1}/log`, `/sales/orders/${seeded.so1}/changes`]) {
      expect((await get('nobody', url)).statusCode, url).toBe(403)
    }
  })
})

describe('DS-7: the Factory designer slot', () => {
  it('the customer\'s Factory designer reads every order of that customer, and lists them', async () => {
    for (const orderId of [seeded.so1, seeded.so2, seeded.so3]) expect((await get('slot', `/sales/orders/${orderId}`)).statusCode).toBe(200)
    const ids = ((await get('slot', '/sales/orders?limit=100')).json().orders as Json[]).map((row) => row.id)
    expect(ids).toEqual(expect.arrayContaining([seeded.so1, seeded.so2, seeded.so3]))
  })
})
