/**
 * MCP full control I11 — merge-duplicate-products against a stock write and an order at the same moment, on a REAL
 * PostgreSQL (the throwaway PostgreSQL 17 of scripts/run-real-postgres-tests.mjs, production schema and policies, the
 * restricted runtime login). PGlite has one connection, so it cannot show this.
 *
 * The merge locks the duplicate's row FOR UPDATE, then checks again what it holds. A stock writer takes the same row
 * first (lockProductStock, FOR NO KEY UPDATE) and an order line referencing it takes FOR KEY SHARE; either way, one
 * that got there first is waited for and then seen, and the merge refuses. Two merges of one duplicate: one wins.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, key) => Reflect.get(database.client, key) }) }))

import { lockProductStock } from '../stock-lock.js'
import { normalizeEbayOrder, writeEbayOrderInTx } from '../ebay-order-writer.js'
import { resolveRows } from '../stock-import.service.js'
import { IdentityMergeRefusal, runMerge } from './identity-merge.service.js'

const RUN = randomBytes(5).toString('hex')
const W = `idm_${RUN}`
const ids: Record<string, string> = {}
const inside = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: W, actorUserId: null, membershipId: null, roleKeys: [] }, work)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

/** Until a statement of this database waits for a row lock (the merge, blocked behind the other writer). */
async function untilSomeoneWaitsForALock() {
  for (let i = 0; i < 200; i++) {
    const { rows } = await database.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)
    if (rows[0].n > 0) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('nothing waited for a lock')
}

const deletedAt = async (id: string) => (await database.pool.query(`SELECT "deletedAt" FROM "Product" WHERE id = $1`, [id])).rows[0].deletedAt as Date | null

describe.skipIf(!concurrentDatabaseUrl())('I11 — a merge against a concurrent stock write or order (real PostgreSQL)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    database = await concurrentDatabase()
    const owner = await database.client.userProfile.create({ data: { email: `idm-${RUN}@example.test`, status: 'active' } })
    await database.client.workspace.create({ data: { id: W, name: 'Merge race business', createdByUserId: owner.id, creationKey: randomUUID() } })
    await inside(async () => {
      for (const sku of ['KEEP', 'DUP-STOCK', 'DUP-ORDER', 'DUP-TWICE', 'DUP-CLEAN', 'DUP-AFTER']) {
        ids[sku] = (await database.client.product.create({ data: { sku: `${sku}-${RUN}`, name: sku, basePrice: '10.00' } })).id
      }
      ids.location = (await database.client.stockLocation.create({ data: { type: 'WAREHOUSE', code: `M-${RUN}`, name: 'Main' } })).id
      ids.ebay = (await database.client.channelConnection.create({
        data: { channelType: 'EBAY', managedBy: 'oauth', isActive: true, externalAccountId: `test-seller-${RUN}`, connectionMetadata: { environment: 'production' } },
      })).id
    })
  }, 240_000)

  afterAll(async () => {
    await database?.close()
    vi.unstubAllEnvs()
  }, 120_000)

  it('control: a duplicate holding nothing is merged on the real server', async () => {
    const out = await inside(() => runMerge(ids['DUP-CLEAN'], ids.KEEP))
    expect(out).toMatchObject({ mode: 'merge', duplicate: { id: ids['DUP-CLEAN'] } })
    expect(await deletedAt(ids['DUP-CLEAN'])).toBeInstanceOf(Date)
  })

  it('a stock writer holding the product first: the merge waits for it, then sees the stock and refuses', async () => {
    const locked = deferred()
    const release = deferred()
    const writer = inside(() => database.client.$transaction(async (tx) => {
      await lockProductStock(tx, [ids['DUP-STOCK']])
      await tx.stockLevel.create({ data: { locationId: ids.location, productId: ids['DUP-STOCK'], quantity: 4, reserved: 0, available: 4 } })
      locked.resolve()
      await release.promise
    }, { timeout: 60_000 }))
    await locked.promise
    const merge = inside(() => runMerge(ids['DUP-STOCK'], ids.KEEP)).then(() => null, (error) => error)
    await untilSomeoneWaitsForALock()
    release.resolve()
    await writer
    const error = await merge
    expect(error).toBeInstanceOf(IdentityMergeRefusal)
    expect(String(error.message)).toMatch(/it has stock/)
    expect(await deletedAt(ids['DUP-STOCK'])).toBeNull()
  })

  it('an order line written first: the merge waits for its transaction, then sees it and refuses', async () => {
    const written = deferred()
    const release = deferred()
    const order = inside(() => database.client.$transaction(async (tx) => {
      await tx.order.create({
        data: {
          channel: 'EBAY', channelOrderId: `IDM-${RUN}`, marketplace: 'IT', currencyCode: 'EUR', totalPrice: '10.00', customerName: 'Test Buyer',
          customerEmail: 'buyer@example.test', shippingAddress: {}, purchaseDate: new Date(),
          items: { create: [{ sku: `DUP-ORDER-${RUN}`, productId: ids['DUP-ORDER'], quantity: 1, price: '10.00' }] },
        },
      })
      written.resolve()
      await release.promise
    }, { timeout: 60_000 }))
    await written.promise
    const merge = inside(() => runMerge(ids['DUP-ORDER'], ids.KEEP)).then(() => null, (error) => error)
    await untilSomeoneWaitsForALock()
    release.resolve()
    await order
    const error = await merge
    expect(error).toBeInstanceOf(IdentityMergeRefusal)
    expect(String(error.message)).toMatch(/1 order line name it/)
    expect(await deletedAt(ids['DUP-ORDER'])).toBeNull()
  })

  it('0(a) after a merge: an eBay order naming the duplicate\'s SKU is never written onto it; a stock file naming it lands on the product kept', async () => {
    const sku = `DUP-AFTER-${RUN}`
    await inside(() => runMerge(ids['DUP-AFTER'], ids.KEEP))
    const order = {
      orderId: `IDM-AFTER-${RUN}`, creationDate: '2026-10-01T10:00:00.000Z', orderPaymentStatus: 'PAID', orderFulfillmentStatus: 'NOT_STARTED',
      buyer: { username: 'Test.Buyer' }, pricingSummary: { total: { value: '10.00', currency: 'EUR' } },
      lineItems: [{ lineItemId: `IDM-AFTER-${RUN}-L1`, sku, title: 'Merged jacket', quantity: 1, lineItemCost: { value: '10.00', currency: 'EUR' } }],
    }
    await inside(() => database.client.$transaction((tx) => writeEbayOrderInTx(tx, { order: normalizeEbayOrder(order), connectionId: ids.ebay, actor: 'test' }), { isolationLevel: 'ReadCommitted', timeout: 60_000 }))
    const { rows } = await database.pool.query(`SELECT i."productId" FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId" WHERE o."channelOrderId" = $1`, [order.orderId])
    expect(rows).toHaveLength(1)
    expect(rows[0].productId).not.toBe(ids['DUP-AFTER'])
    expect([null, ids.KEEP]).toContain(rows[0].productId)
    const [resolved] = await inside(() => resolveRows([{ raw: sku, quantity: 2 }] as never))
    expect(resolved.productId).toBe(ids.KEEP)
  })

  it('two merges of one duplicate at the same moment: exactly one merges, the other finds it gone', async () => {
    const outcomes = await Promise.allSettled([
      inside(() => runMerge(ids['DUP-TWICE'], ids.KEEP)),
      inside(() => runMerge(ids['DUP-TWICE'], ids.KEEP)),
    ])
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
    const refused = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult
    expect(refused.reason).toBeInstanceOf(IdentityMergeRefusal)
    expect(refused.reason.message).toBe('Product not found')
    const aliases = await database.pool.query(`SELECT count(*)::int AS n FROM "SkuAlias" WHERE "productId" = $1 AND alias = $2`, [ids.KEEP, `dup-twice-${RUN}`])
    expect(aliases.rows[0].n).toBe(1)
  })
})
