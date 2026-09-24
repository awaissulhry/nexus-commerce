import { beforeAll, beforeEach, expect, it, vi } from 'vitest'

/**
 * PLAN A-54 (R-67) — which listings the eBay INVENTORY read-back may ask eBay about, on an in-process PostgreSQL
 * (PGlite) with the REAL `readBackEbayInventory` and the real query. eBay's Inventory API is stubbed; the SKUs the
 * pass asks for are the claim. Production on 2026-09-24: 302 active eBay listings = 14 parents + 288 shared members,
 * and every sweep logged 6 false errors — for PARENT SKUs, which have no quantity of their own.
 */
const state = vi.hoisted(() => ({ db: null as any, asked: [] as string[] }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('./marketplaces/ebay.service.js', () => ({
  EbayService: class {
    async getPublishedInventoryItem(sku: string) { state.asked.push(sku); return null }
  },
}))

import prisma from '../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import { readBackEbayInventory } from './ebay-inventory-readback.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let item = 5000

async function listing(sku: string, opts: { parent?: boolean; parentSku?: string; shared?: boolean } = {}) {
  return scoped(async () => {
    const parentId = opts.parentSku ? (await prisma.product.findFirstOrThrow({ where: { sku: opts.parentSku } })).id : null
    const product = await prisma.product.create({ data: { sku, name: sku, basePrice: 10, isParent: !!opts.parent, parentId } })
    const itemId = String(item++)
    await prisma.channelListing.create({ data: { productId: product.id, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'IT',
      externalListingId: itemId, listingStatus: 'ACTIVE' } })
    if (opts.shared) await prisma.sharedListingMembership.create({ data: { marketplace: 'IT', sku, itemId, parentSku: opts.parentSku ?? sku,
      productId: product.id, variationSpecifics: { Taglia: 'M' } } })
  })
}
const sweep = (maxSkus?: number) => scoped(() => readBackEbayInventory(maxSkus ? { maxSkus } : {}))

beforeAll(async () => {
  // Inserted first on purpose: under a cap applied BEFORE the shared skip, these fill the batch.
  await listing('RBS-PARENT', { parent: true })
  await listing('RBS-SHARED-1', { parentSku: 'RBS-PARENT', shared: true })
  await listing('RBS-SHARED-2', { parentSku: 'RBS-PARENT', shared: true })
  await listing('RBS-SHARED-3', { parentSku: 'RBS-PARENT', shared: true })
  await listing('RBS-SINGLE')                       // not a parent, not shared: the one row that CAN have an inventory item
}, 60_000)

beforeEach(() => { state.asked = [] })

it('a PARENT SKU is never read — a parent has no quantity of its own (the 6 false errors a sweep, 2026-09-24)', async () => {
  await sweep()
  expect(state.asked).not.toContain('RBS-PARENT')
})

it('a shared member is never read — the Trading pass reads it', async () => {
  await sweep()
  for (const sku of ['RBS-SHARED-1', 'RBS-SHARED-2', 'RBS-SHARED-3']) expect(state.asked).not.toContain(sku)
})

it('the cap counts only rows the pass may read: 1 of 1 eligible read under cap 1, not an arbitrary shared row', async () => {
  const report = await sweep(1)
  expect(state.asked).toEqual(['RBS-SINGLE'])
  expect(report).toMatchObject({ checked: 1, errors: 0, capped: false })
})
