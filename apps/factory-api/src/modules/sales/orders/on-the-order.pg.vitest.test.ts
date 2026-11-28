import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryClient, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPortalSales } from '../../../../../../packages/factory-db/seed/portal-sales'
import { seed as seedProduct } from '../../../../../../packages/factory-db/seed/product'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor, command } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { isOnOrder, maySeeOrder, ordersUserIsOn } from './on-the-order'
import { putPeopleOnOrder } from './people-writer'

/**
 * owb-of1a (order workflow, plan.md § 5 D R20): the ONE "on the order" rule and the people writer, on a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security is real), on the factory-db seeds up to the customer portal
 * (SEED-SO-0001, -0002, -0003 are customer P1's; SEED-RQ-0002 is the ACCEPTED request SEED-SO-0002 was made from; SEED-RQ-0001 is
 * a SENT request of no order). Follow rows and the designer slot are planted with the database's rules off (the rule is what is
 * tested). Every name is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/orders/on-the-order`.
 *
 *   OTO-1  a follow row on the order → on it (muted too)
 *   OTO-2  a follow row on its request → on the order made from it; a follow row on the order → on that request
 *   OTO-3  the customer's Factory designer slot (designer or backup) → on every order and request of that customer
 *   OTO-4  another person → not on it; maySeeOrder: orders.view sees, orders.view.own only while on it
 *   OTO-5  ordersUserIsOn lists both kinds, both ways
 *   OTO-6  putPeopleOnOrder: office people put on once (ADDED, by whom), kept not doubled, a portal or unknown id skipped
 */

vi.setConfig({ testTimeout: 120_000 })

let db: MigratedDatabase
let database: FactoryDatabase

const NS = 'owb-on-the-order'
const id = (key: string): string => seedUuid(NS, key)
const tenant = id('tenant')

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!

/** Rows written with the database's rules off (replica): what the rule reads. */
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

const PEOPLE = { follower: newId(), requestFollower: newId(), designer: newId(), backup: newId(), stranger: newId(), boss: newId(), newcomer: newId() }
const user = (userId: string, key: string, audience = 'OFFICE', partyId: string | null = null) => ({
  sql: `INSERT INTO "User" (id, "tenantId", email, "displayName", status, audience, "partyId") VALUES ($1, $2, $3, $4, 'ACTIVE', $5::"UserAudience", $6)`,
  values: [userId, tenant, `oto.${key}@example.com`, `Made-up ${key}`, audience, partyId],
})
const follow = (recordType: string, recordId: string, userId: string, muted = false) => ({
  sql: `INSERT INTO "RecordFollower" (id, "tenantId", "recordType", "recordId", "userId", reason, muted) VALUES ($1, $2, $3, $4, $5, 'CHOSE'::"FollowReason", $6)`,
  values: [newId(), tenant, recordType, recordId, userId, muted],
})

const seeded = { so1: '', so2: '', so3: '', rq1: '', rq2: '', company: '', party: '' }
const grant = (permissions: readonly Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const contextOf = (actorId: string, permissions: readonly Permission[]): OfficeContext => ({ audience: 'office', tenantId: tenant, actorId, grants: [grant(permissions)], requestId: newId() })
const read = <T>(work: (client: FactoryClient) => Promise<T>): Promise<T> =>
  callerFor(database, contextOf(PEOPLE.boss, ['orders.view' as Permission])).withClient(work)

beforeAll(async () => {
  db = await migratedDatabase('owb_on_the_order')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  await seedCore({ db: database, namespace: NS })
  await seedProduct({ db: database, namespace: NS })
  await seedPortalSales({ db: database, namespace: NS })
  const order = async (number: string) => one<{ id: string; companyId: string; partyId: string }>(`SELECT id, "companyId", "partyId" FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2`, [tenant, number])
  const so1 = await order('SEED-SO-0001')
  seeded.so1 = so1.id
  seeded.company = so1.companyId
  seeded.party = so1.partyId
  seeded.so2 = (await order('SEED-SO-0002')).id
  seeded.so3 = (await order('SEED-SO-0003')).id
  seeded.rq1 = (await one<{ id: string }>(`SELECT id FROM "PortalOrderRequest" WHERE "tenantId" = $1 AND number = 'SEED-RQ-0001'`, [tenant])).id
  const rq2 = await one<{ id: string; salesOrderId: string }>(`SELECT id, "salesOrderId" FROM "PortalOrderRequest" WHERE "tenantId" = $1 AND number = 'SEED-RQ-0002'`, [tenant])
  seeded.rq2 = rq2.id
  expect(rq2.salesOrderId).toBe(seeded.so2)
  await planted([
    ...Object.entries(PEOPLE).map(([key, userId]) => user(userId, key)),
    follow('SalesOrder', seeded.so1, PEOPLE.follower, true), // muted: still on it
    follow('PortalOrderRequest', seeded.rq2, PEOPLE.requestFollower),
    // P1's Factory designer and its backup (the slot is office only; set here with the rules off).
    {
      sql: `INSERT INTO "PortalSettings" (id, "tenantId", "partyId", "portalOn", "factoryDesignerId", "factoryDesignerSetAt", "factoryDesignerBackupId", "createdAt", "updatedAt")
            VALUES ($1, $2, $1, false, $3, now(), $4, now(), now())
            ON CONFLICT (id) DO UPDATE SET "factoryDesignerId" = $3, "factoryDesignerSetAt" = now(), "factoryDesignerBackupId" = $4`,
      values: [seeded.party, tenant, PEOPLE.designer, PEOPLE.backup],
    },
  ])
}, 900_000)

afterAll(async () => {
  await database?.close()
  await db?.close()
}, 60_000)

describe('OTO-1/2: a follow row puts the person on the order and on its request, both ways', () => {
  it('a follow on the order (muted) → on the order; not on another order of the same customer', async () => {
    expect(await read((client) => isOnOrder(client, { tenantId: tenant, userId: PEOPLE.follower, salesOrderId: seeded.so1 }))).toBe(true)
    expect(await read((client) => isOnOrder(client, { tenantId: tenant, userId: PEOPLE.follower, salesOrderId: seeded.so3 }))).toBe(false)
  })

  it('a follow on the request → on the order made from it; asked by the request too', async () => {
    expect(await read((client) => isOnOrder(client, { tenantId: tenant, userId: PEOPLE.requestFollower, salesOrderId: seeded.so2 }))).toBe(true)
    expect(await read((client) => isOnOrder(client, { tenantId: tenant, userId: PEOPLE.requestFollower, requestId: seeded.rq2 }))).toBe(true)
    // A request of no order the person does not follow.
    expect(await read((client) => isOnOrder(client, { tenantId: tenant, userId: PEOPLE.requestFollower, requestId: seeded.rq1 }))).toBe(false)
  })

  it('a follow on the order → on the request it came from', async () => {
    await planted([follow('SalesOrder', seeded.so2, PEOPLE.stranger)])
    try {
      expect(await read((client) => isOnOrder(client, { tenantId: tenant, userId: PEOPLE.stranger, requestId: seeded.rq2 }))).toBe(true)
    } finally {
      await admin(`DELETE FROM "RecordFollower" WHERE "tenantId" = $1 AND "userId" = $2`, [tenant, PEOPLE.stranger])
    }
  })
})

describe('OTO-3: the Factory designer slot', () => {
  it('the customer\'s Factory designer and its backup are on every order and request of that customer', async () => {
    for (const userId of [PEOPLE.designer, PEOPLE.backup]) {
      for (const salesOrderId of [seeded.so1, seeded.so2, seeded.so3]) expect(await read((client) => isOnOrder(client, { tenantId: tenant, userId, salesOrderId }))).toBe(true)
      expect(await read((client) => isOnOrder(client, { tenantId: tenant, userId, requestId: seeded.rq1 }))).toBe(true)
    }
  })
})

describe('OTO-4: another person, and maySeeOrder', () => {
  it('a person with no follow row and no slot is on nothing; an unknown or missing id is never on', async () => {
    for (const salesOrderId of [seeded.so1, seeded.so2, seeded.so3]) expect(await read((client) => isOnOrder(client, { tenantId: tenant, userId: PEOPLE.stranger, salesOrderId }))).toBe(false)
    expect(await read((client) => isOnOrder(client, { tenantId: tenant, userId: PEOPLE.follower, salesOrderId: newId() }))).toBe(false)
    expect(await read((client) => isOnOrder(client, { tenantId: tenant, userId: PEOPLE.follower }))).toBe(false)
    expect(await read((client) => isOnOrder(client, { tenantId: tenant, userId: PEOPLE.follower, salesOrderId: 'not-an-id' }))).toBe(false)
  })

  it('orders.view sees every order of its scope; orders.view.own only the ones the person is on; neither sees nothing', async () => {
    const scope = { companyId: seeded.company, partyId: seeded.party }
    const sees = (actorId: string, permissions: readonly Permission[], salesOrderId: string) => read((client) => maySeeOrder(client, contextOf(actorId, permissions), { scope, salesOrderId }))
    expect(await sees(PEOPLE.stranger, ['orders.view' as Permission], seeded.so3)).toBe(true)
    expect(await sees(PEOPLE.follower, ['orders.view.own' as Permission], seeded.so1)).toBe(true)
    expect(await sees(PEOPLE.follower, ['orders.view.own' as Permission], seeded.so3)).toBe(false)
    expect(await sees(PEOPLE.stranger, ['orders.view.own' as Permission], seeded.so1)).toBe(false)
    // On the order, but without orders.view.own: the follow alone opens nothing.
    expect(await sees(PEOPLE.follower, ['home.view' as Permission], seeded.so1)).toBe(false)
  })
})

describe('OTO-5: ordersUserIsOn', () => {
  it('lists orders and requests, both ways, and every order and request of a customer the person designs for', async () => {
    const requestSide = await read((client) => ordersUserIsOn(client, { tenantId: tenant, userId: PEOPLE.requestFollower }))
    expect(requestSide.requestIds).toEqual([seeded.rq2])
    expect(requestSide.salesOrderIds).toEqual([seeded.so2])
    const orderSide = await read((client) => ordersUserIsOn(client, { tenantId: tenant, userId: PEOPLE.follower }))
    expect(orderSide.salesOrderIds).toEqual([seeded.so1])
    const designer = await read((client) => ordersUserIsOn(client, { tenantId: tenant, userId: PEOPLE.designer }))
    expect(designer.salesOrderIds).toEqual(expect.arrayContaining([seeded.so1, seeded.so2, seeded.so3]))
    expect(designer.requestIds).toEqual(expect.arrayContaining([seeded.rq1, seeded.rq2]))
    expect(await read((client) => ordersUserIsOn(client, { tenantId: tenant, userId: PEOPLE.stranger }))).toEqual({ salesOrderIds: [], requestIds: [] })
  })
})

describe('OTO-6: putPeopleOnOrder', () => {
  it('puts office people on once (ADDED, by whom), keeps who is on, skips a portal person and an unknown id', async () => {
    const portal = newId()
    await planted([user(portal, 'portal-person', 'PARTNER', seeded.party)])
    const caller = callerFor(database, contextOf(PEOPLE.boss, ['orders.view' as Permission, 'orders.manage' as Permission]))
    const put = (userIds: readonly string[]) =>
      command(caller, { name: 'orders.people.putTest' as Permission, input: { salesOrderId: seeded.so3, userIds } }, async (tools) => {
        const added = await putPeopleOnOrder(tools, { salesOrderId: seeded.so3, userIds, byUserId: PEOPLE.boss })
        tools.audit({ recordType: 'SalesOrder', recordId: seeded.so3, companyId: seeded.company, after: { added } })
        return added
      })
    expect((await put([PEOPLE.newcomer, PEOPLE.newcomer, portal, newId()])).result).toBe(1)
    expect((await put([PEOPLE.newcomer, PEOPLE.follower])).result).toBe(1)
    const rows = await admin<{ userId: string; reason: string; createdById: string }>(`SELECT "userId", reason::text AS reason, "createdById" FROM "RecordFollower" WHERE "tenantId" = $1 AND "recordType" = 'SalesOrder' AND "recordId" = $2 ORDER BY "createdAt"`, [tenant, seeded.so3])
    expect(rows.filter((row) => row.userId === PEOPLE.newcomer)).toEqual([{ userId: PEOPLE.newcomer, reason: 'ADDED', createdById: PEOPLE.boss }])
    expect(rows.map((row) => row.userId)).not.toContain(portal)
    expect(await read((client) => isOnOrder(client, { tenantId: tenant, userId: PEOPLE.newcomer, salesOrderId: seeded.so3 }))).toBe(true)
    // The person putting themselves on follows by their own choice (the database's ADDED names someone else).
    const self = await command(caller, { name: 'orders.people.putTest' as Permission, input: { self: true } }, async (tools) => {
      const added = await putPeopleOnOrder(tools, { salesOrderId: seeded.so3, userIds: [PEOPLE.boss], byUserId: PEOPLE.boss })
      tools.audit({ recordType: 'SalesOrder', recordId: seeded.so3, companyId: seeded.company, after: { added } })
      return added
    })
    expect(self.result).toBe(1)
    expect((await one<{ reason: string }>(`SELECT reason::text AS reason FROM "RecordFollower" WHERE "recordId" = $1 AND "userId" = $2`, [seeded.so3, PEOPLE.boss])).reason).toBe('CHOSE')
  })
})
