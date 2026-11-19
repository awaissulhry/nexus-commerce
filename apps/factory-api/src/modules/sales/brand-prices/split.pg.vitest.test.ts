import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'

/**
 * The customer's prices follow a split and a removed line (customer page lane B-CP-024; review G5) on the local stack with the
 * app's real routes (every seed: Brand Alpha = SEED-C1; the runtime login, so the …_customer_page_guards trigger and the
 * Restrict foreign key on the line are real):
 *
 *   - a split: a unit price moves with a whole line to the new order (the same row, audited on both orders) or is copied to the
 *     part of a line that moved (the source line keeps its own); a line total of a line that moved or changed, and the order's
 *     own total, are removed — that line (and that order) read "No customer price yet" again; the match after it is right on
 *     every order, the new orders keep the customer, no foreign-key error reaches a person
 *   - Remove line (an amendment that leaves a line out): its customer's price goes with it in the same command (audited); the
 *     rest of the order still reads right
 *   - Close remaining lines keeps the line, its pieces and our net: its customer's price stays, and so does the check
 *
 * Every name, number and price is made up. Run with `node scripts/factory/run-pg-tests.mjs sales/brand-prices/split`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'cp024-brand-price-split'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const OWNER = newId()
const SESSIONS: Record<string, SessionContext> = {}

let h: Harness
let app: FastifyInstance
let alpha: string
let blk: { styleId: string; colourwayId: string; sizes: string[] }
let red: { styleId: string; colourwayId: string; sizes: string[] }
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': 'owner', ...(method !== 'GET' ? { 'idempotency-key': `cp024-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
const check = (orderId: string) => ok('GET', `/sales/orders/${orderId}/price-check`)
const versionOf = async (orderId: string) => (await one<{ version: number }>(`SELECT version FROM "SalesOrder" WHERE id = $1`, [orderId])).version
const rowsOf = (orderId: string) => admin<Json>(`SELECT id, "salesOrderId", "salesOrderLineId", "partyId", "unitPrice"::text AS "unitPrice", "netAmount", source::text AS source, "enteredById", "sourceFileId", version FROM "OrderBrandPrice" WHERE "salesOrderId" = $1 ORDER BY "salesOrderLineId" NULLS FIRST`, [orderId])
const actionsOf = async (orderId: string) => (await admin<{ action: string }>(`SELECT action FROM "AuditLog" WHERE "recordType" = 'OrderBrandPrice' AND "recordId" = $1 ORDER BY at, id`, [orderId])).map((row) => row.action).sort()

/** Brand Alpha's manual order typed by the Owner: 6 jackets in BLK at 100.00 (two sizes × 3) and 2 in RED at 110.00. */
async function order(ref: string): Promise<{ id: string; blk: string; red: string }> {
  const body = {
    companyId: companyA,
    partyId: alpha,
    customerRef: ref,
    lines: [
      { styleId: blk.styleId, colourwayId: blk.colourwayId, unitPrice: '100', sizes: blk.sizes.slice(0, 2).map((size) => ({ size, quantity: 3 })) },
      { styleId: red.styleId, colourwayId: red.colourwayId, unitPrice: '110', sizes: red.sizes.slice(0, 1).map((size) => ({ size, quantity: 2 })) },
    ],
  }
  const made = (await ok('POST', '/sales/orders/manual', body, 201)).order
  const lines = await admin<{ id: string; seq: number }>(`SELECT id, seq FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq`, [made.id])
  return { id: made.id, blk: lines[0]!.id, red: lines[1]!.id }
}

beforeAll(async () => {
  h = await startHarness('sales_brand_price_split_cp024')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  alpha = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C1'`, [T])).id
  const ownerRole = (await one<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'owner'`, [T])).id
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, 'Made-up owner', 'ACTIVE')`, [OWNER, T, `cp024-owner-${run}@example.com`])
  await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), T, OWNER, ownerRole])
  const template = templateOf('owner')!
  const grants: Grant[] = [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }]
  SESSIONS.owner = { audience: 'office', tenantId: T, actorId: OWNER, grants }
  const lines = await admin<{ styleId: string; colourwayId: string; code: string; sizes: string[] }>(
    `SELECT l."styleId", l."colourwayId", c.code, (SELECT array_agg(s.size ORDER BY s.size) FROM "SalesOrderLineSize" s WHERE s."lineId" = l.id) AS sizes
       FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o.id = l."orderId" JOIN "Colourway" c ON c.id = l."colourwayId" WHERE o."tenantId" = $1 AND o.number = 'SEED-SO-0001' ORDER BY l.seq`,
    [T],
  )
  blk = lines.find((line) => line.code === 'BLK')!
  red = lines.find((line) => line.code === 'RED')!
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('a split carries the customer’s unit prices and clears its totals (B-CP-024)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a whole line moves with its unit price: the same row, on the new order, audited on both', async () => {
    const from = await order('PO-CP024-WHOLE')
    await ok('PUT', `/sales/orders/${from.id}/brand-prices`, { rows: [{ lineId: from.blk, unitPrice: '100', source: 'CUSTOMER_PO' }, { lineId: from.red, unitPrice: '110', source: 'OFFICE' }] })
    const redRow = (await rowsOf(from.id)).find((row) => row.salesOrderLineId === from.red)!
    const split = await ok('POST', `/sales/orders/${from.id}/split`, { version: await versionOf(from.id), parts: [{ lines: [{ lineId: from.red }] }] }, 201)
    const made = split.orders[0].id as string
    const moved = await rowsOf(made)
    expect(moved).toHaveLength(1)
    expect(moved[0]).toMatchObject({ id: redRow.id, unitPrice: '110.000000', source: 'OFFICE', partyId: alpha, enteredById: OWNER, version: 2 })
    expect(await rowsOf(from.id)).toEqual([expect.objectContaining({ salesOrderLineId: from.blk, unitPrice: '100.000000' })])
    // The match on both orders: equal, the source's RED line is gone (nothing holds it), no 0-piece line is counted.
    expect((await check(made)).total).toMatchObject({ priceMatch: 'EQUAL', brandPrice: 22_000, ourPrice: 22_000 })
    const kept = await check(from.id)
    expect(kept.lines.map((line: Json) => line.lineId)).toEqual([from.blk])
    expect(kept.total).toMatchObject({ priceMatch: 'EQUAL', brandPrice: 60_000, ourPrice: 60_000 })
    expect(await actionsOf(from.id)).toEqual(['brandPrices.movedOut', 'brandPrices.set', 'brandPrices.set'])
    expect(await actionsOf(made)).toEqual(['brandPrices.movedIn'])
  })

  it('a part of a line keeps the unit price on both sides; a line total and the order’s total are given again', async () => {
    const from = await order('PO-CP024-PART')
    await ok('PUT', `/sales/orders/${from.id}/brand-prices`, { rows: [{ lineId: from.blk, unitPrice: '100', source: 'CUSTOMER_PO', note: 'PO 5512' }, { lineId: from.red, netAmount: 22_000, source: 'CUSTOMER_PO' }, { lineId: null, netAmount: 82_000, source: 'CUSTOMER_PO' }] })
    expect((await check(from.id)).total.priceMatch).toBe('EQUAL')
    // Part 1: the RED line whole; part 2: one BLK jacket of the second size.
    const split = await ok('POST', `/sales/orders/${from.id}/split`, { version: await versionOf(from.id), parts: [{ lines: [{ lineId: from.red }] }, { lines: [{ lineId: from.blk, sizes: [{ size: blk.sizes[1], quantity: 1 }] }] }] }, 201)
    const [redOrder, blkOrder] = split.orders.map((entry: Json) => entry.id as string)
    // The source keeps 5 BLK jackets at the customer's 100.00: equal (its total row went: the sum of its lines is the price now).
    const kept = await check(from.id)
    expect(kept.lines.map((line: Json) => [line.pieces, line.priceMatch, line.row?.unitPrice ?? null])).toEqual([[5, 'EQUAL', '100']])
    expect(kept.total).toMatchObject({ ourPrice: 50_000, brandPrice: 50_000, priceMatch: 'EQUAL', row: null })
    // The RED order: its line total was for the line as it was: no customer price yet (never equal).
    expect((await check(redOrder)).total).toMatchObject({ priceMatch: 'NO_BRAND_PRICE', brandPrice: null })
    expect(await rowsOf(redOrder)).toEqual([])
    // The BLK part: a copy of the unit price (same source, who typed it, the note; no PO file: that file is the source order's).
    const copied = await rowsOf(blkOrder)
    expect(copied).toEqual([expect.objectContaining({ unitPrice: '100.000000', source: 'CUSTOMER_PO', enteredById: OWNER, sourceFileId: null, partyId: alpha, version: 1 })])
    expect((await check(blkOrder)).total).toMatchObject({ ourPrice: 10_000, brandPrice: 10_000, priceMatch: 'EQUAL' })
    expect(await actionsOf(from.id)).toEqual(['brandPrices.clearedBySplit', 'brandPrices.clearedBySplit', 'brandPrices.set', 'brandPrices.set', 'brandPrices.set'])
    expect(await actionsOf(blkOrder)).toEqual(['brandPrices.carried'])
    // Each order whose prices changed is announced once by the split (the source, the BLK part).
    const events = await admin<{ subject: string }>(`SELECT subject FROM "OutboxEvent" WHERE type = 'sales_order.brand_price_changed' AND "tenantId" = $1 AND subject = ANY($2::text[])`, [T, [from.id, redOrder, blkOrder]])
    expect(events.filter((event) => event.subject === blkOrder)).toHaveLength(1)
    expect(events.filter((event) => event.subject === redOrder)).toHaveLength(0)
  })
})

describe('Remove line and Close remaining lines (B-CP-024)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('Remove line: the customer’s price goes with the line in the same command; no foreign-key error; the rest reads right', async () => {
    const from = await order('PO-CP024-REMOVE')
    await ok('PUT', `/sales/orders/${from.id}/brand-prices`, { rows: [{ lineId: from.blk, unitPrice: '100', source: 'OFFICE' }, { lineId: from.red, unitPrice: '110', source: 'OFFICE' }] })
    await ok('POST', `/sales/orders/${from.id}/amendments`, { version: await versionOf(from.id), reason: 'Made-up: the customer no longer wants the red ones.', lines: [{ id: from.blk }] }, 201)
    expect(await admin(`SELECT id FROM "SalesOrderLine" WHERE id = $1`, [from.red])).toEqual([])
    expect((await rowsOf(from.id)).map((row) => row.salesOrderLineId)).toEqual([from.blk])
    expect((await check(from.id)).total).toMatchObject({ ourPrice: 60_000, brandPrice: 60_000, priceMatch: 'EQUAL' })
    expect(await actionsOf(from.id)).toEqual(['brandPrices.removedWithLine', 'brandPrices.set', 'brandPrices.set'])
    const removed = await one<Json>(`SELECT before, reason FROM "AuditLog" WHERE "recordType" = 'OrderBrandPrice' AND "recordId" = $1 AND action = 'brandPrices.removedWithLine'`, [from.id])
    expect(removed.before).toMatchObject({ lineId: from.red, unitPrice: { $money: 'price', value: '110' } })
    // The order's own audit names no customer's price.
    expect(JSON.stringify(await admin(`SELECT after FROM "AuditLog" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1`, [from.id]))).not.toContain('brandPrice')
  })

  it('Close remaining lines keeps the line, its pieces and our net: the customer’s price and the check stay', async () => {
    const from = await order('PO-CP024-CLOSE')
    await ok('PUT', `/sales/orders/${from.id}/brand-prices`, { rows: [{ lineId: from.blk, unitPrice: '100', source: 'OFFICE' }, { lineId: from.red, netAmount: 22_000, source: 'OFFICE' }] })
    const before = await check(from.id)
    await ok('POST', `/sales/orders/${from.id}/close-lines`, { version: await versionOf(from.id), reason: 'Made-up: the red ones will not be made.', lineIds: [from.red] })
    expect(await one(`SELECT "closedShortQuantity" FROM "SalesOrderLine" WHERE id = $1`, [from.red])).toEqual({ closedShortQuantity: 2 })
    expect((await rowsOf(from.id)).length).toBe(2)
    expect((await check(from.id)).total).toEqual(before.total)
  })
})
