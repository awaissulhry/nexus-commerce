import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { officeWorld, type OfficeWorld } from './testing/office-world'
import { RESTRICT_ENDED_WORDS } from './restrict'

/**
 * owb-of1 step 4 (order workflow, plan.md § 5k "Restrict", R23; settle L6: orders.manage): POST /sales/orders/:orderId/restrict on the
 * office world (./testing/office-world.ts). Written, not run (Owner rule). Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/orders/restrict`.
 *
 *   RE-1  Sales restricts and opens again: the columns, one audit row each, the event, the order read's `restricted: { by, at }`
 *   RE-2  the designer (on the order, orders.view.own) gets 403; another customer's role 404; a stale version 409
 *   RE-3  a closed or withdrawn order is refused in words (409); asked as it already is: nothing written
 *   RE-4  the partner never reads the columns (the base's hiddenColumns of SalesOrder, unchanged)
 */

vi.setConfig({ testTimeout: 180_000 })

let w: OfficeWorld

beforeAll(async () => {
  w = await officeWorld('restrict')
  await w.planted([{ sql: `INSERT INTO "RecordFollower" (id, "tenantId", "recordType", "recordId", "userId", reason) VALUES ($1, $2, 'SalesOrder', $3, $4, 'CHOSE')`, values: [newId(), w.tenant, w.ids.so1, w.people.designer] }])
}, 900_000)

afterAll(async () => {
  await w?.close()
}, 60_000)

const versionOf = async (orderId: string) => (await w.admin<{ version: number }>('SELECT version FROM "SalesOrder" WHERE id = $1', [orderId]))[0]!.version

describe('RE-1 Sales restricts the order on the floor, and opens it again', () => {
  it('writes the columns with who and when, one audit row and one event each time; the order read says it', async () => {
    const restricted = await w.post('sales', `/sales/orders/${w.ids.so1}/restrict`, { version: await versionOf(w.ids.so1), restricted: true })
    expect(restricted.statusCode, restricted.body.slice(0, 300)).toBe(200)
    expect(restricted.json().order.restricted).toEqual({ by: 'Made-up sales', at: expect.any(String) })
    const row = (await w.admin<{ floorRestricted: boolean; floorRestrictedById: string; floorRestrictedAt: Date | null }>('SELECT "floorRestricted", "floorRestrictedById", "floorRestrictedAt" FROM "SalesOrder" WHERE id = $1', [w.ids.so1]))[0]!
    expect(row).toMatchObject({ floorRestricted: true, floorRestrictedById: w.people.sales })
    expect(row.floorRestrictedAt).not.toBeNull()
    expect((await w.get('sales', `/sales/orders/${w.ids.so1}`)).json().order.restricted).toMatchObject({ by: 'Made-up sales' })
    const opened = await w.post('sales', `/sales/orders/${w.ids.so1}/restrict`, { version: await versionOf(w.ids.so1), restricted: false })
    expect(opened.json().order.restricted).toBeNull()
    const audits = await w.admin<{ before: { floorRestricted: boolean }; after: { floorRestricted: boolean } }>(`SELECT before, after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'orders.restrict' AND "recordId" = $2 ORDER BY at`, [w.tenant, w.ids.so1])
    expect(audits.map((entry) => [entry.before.floorRestricted, entry.after.floorRestricted])).toEqual([[false, true], [true, false]])
    const events = await w.admin<{ payload: { restricted: boolean; partyId: string } }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'sales_order.floor_restricted' ORDER BY "occurredAt"`, [w.tenant])
    expect(events.map((event) => event.payload.restricted)).toEqual([true, false])
    for (const event of events) expect(event.payload.partyId).toBe(w.ids.p1)
  })
})

describe('RE-2 who may', () => {
  it('the designer on the order 403 (no orders.manage), another customer\'s role 404, a stale version 409', async () => {
    const version = await versionOf(w.ids.so1)
    expect((await w.post('designer', `/sales/orders/${w.ids.so1}/restrict`, { version, restricted: true })).statusCode).toBe(403)
    expect((await w.post('onlyP4', `/sales/orders/${w.ids.so1}/restrict`, { version, restricted: true })).statusCode).toBe(404)
    expect((await w.post('sales', `/sales/orders/${w.ids.so1}/restrict`, { version: version + 7, restricted: true })).statusCode).toBe(409)
  })
})

describe('RE-3 ended orders, and nothing to change', () => {
  it('a withdrawn order is refused in words; asked as it is, nothing is written', async () => {
    await w.planted([{ sql: `UPDATE "SalesOrder" SET status = 'CANCELLED', "cancelReason" = 'Made-up reason' WHERE id = $1`, values: [w.ids.so3] }])
    const refused = await w.post('sales', `/sales/orders/${w.ids.so3}/restrict`, { version: await versionOf(w.ids.so3), restricted: true })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.message).toBe(RESTRICT_ENDED_WORDS.en)
    const before = await versionOf(w.ids.so2)
    const same = await w.post('sales', `/sales/orders/${w.ids.so2}/restrict`, { version: before, restricted: false })
    expect(same.statusCode).toBe(200)
    expect(await versionOf(w.ids.so2)).toBe(before)
  })
})

describe('RE-4 the partner never reads the restriction', () => {
  it('SalesOrder hides floorRestricted, floorRestrictedAt and floorRestrictedById from the partner role', () => {
    const ownership = JSON.parse(readFileSync(new URL('../../../../../../packages/factory-db/ownership/sales.json', import.meta.url), 'utf8')) as { models: Record<string, { access: Record<string, { hiddenColumns?: string[] }> }> }
    const hidden = ownership.models.SalesOrder!.access.factory_partner_runtime!.hiddenColumns ?? []
    expect(hidden).toEqual(expect.arrayContaining(['floorRestricted', 'floorRestrictedAt', 'floorRestrictedById']))
  })
})
