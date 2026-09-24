import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * A-36 (Step 3.5a) — the product list's "Differs on the channel" filter (`channelDrift=true`), on PGlite.
 * It narrows BOTH list paths (the live table and the read cache) to the products with a drifted listing and their
 * parents; the old `driftOnly` filter still means "has overrides" and is untouched.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
// The list's stats cache writes through Redis: an in-memory stand-in, so a cached count cannot leak between the two calls.
vi.mock('../../lib/queue.js', () => {
  const store = new Map<string, string>()
  const connection = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: string) => { store.set(k, v); return 'OK' },
    del: async (...keys: string[]) => { keys.forEach(k => store.delete(k)); return keys.length } }
  return { outboundSyncQueue: null, redis: { connection }, searchIndexQueue: null, readCacheQueue: null, addJobSafely: vi.fn() }
})

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { listProducts, resolveProductsScope } from './list-products.service.js'
import { recordChannelReadback } from '../channel-drift.service.js'
import { productReadCacheService } from '../product-read-cache.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids = { parent: '', child: '', clean: '' }

beforeAll(() => scoped(async () => {
  ids.parent = (await prisma.product.create({ data: { sku: 'cd-parent', name: 'Parent', basePrice: 10, isParent: true } })).id
  ids.child = (await prisma.product.create({ data: { sku: 'cd-child', name: 'Child', basePrice: 10, parentId: ids.parent } })).id
  ids.clean = (await prisma.product.create({ data: { sku: 'cd-clean', name: 'Clean', basePrice: 10 } })).id
  const drifted = await prisma.channelListing.create({ data: { productId: ids.child, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU' } })
  const matching = await prisma.channelListing.create({ data: { productId: ids.clean, channel: 'AMAZON', marketplace: 'IT', channelMarket: 'AMAZON_IT', region: 'EU' } })
  await recordChannelReadback({ channelListingId: drifted.id, channel: 'AMAZON', marketplace: 'IT', source: 'report', compared: ['quantity'], differing: [{ field: 'quantity', ours: 4, theirs: 0 }] })
  await recordChannelReadback({ channelListingId: matching.id, channel: 'AMAZON', marketplace: 'IT', source: 'report', compared: ['quantity'], differing: [] })
}), 60_000)
afterAll(async () => { await state.db?.close() })

it('🔴 both list paths are narrowed to the drifted listing\'s product and its parent', async () => {
  const scope = await scoped(() => resolveProductsScope({ channelDrift: 'true' } as never))
  const inList = (clauses: any[] | undefined) => (clauses ?? []).find((c: any) => c?.id?.in)?.id.in?.slice().sort()
  expect(inList(scope.where.AND)).toEqual([ids.parent, ids.child].sort())
  if (scope.useCache) expect(inList(scope.cacheWhere.AND)).toEqual([ids.parent, ids.child].sort())
})

it('🔴 the READ-CACHE path too: with the cache filled by its real writer, the list takes it and is still narrowed', async () => {
  await scoped(() => productReadCacheService.refreshMany([ids.parent, ids.child, ids.clean]))
  const scope = await scoped(() => resolveProductsScope({ channelDrift: 'true' } as never))
  // Positive control: this arm is about the cache path, so it must be the path taken.
  expect(scope.useCache).toBe(true)
  expect((scope.cacheWhere.AND ?? []).find((c: any) => c?.id?.in)?.id.in.slice().sort()).toEqual([ids.parent, ids.child].sort())
  const run = (q: Record<string, string>) => scoped(() => listProducts(q as never)).then((r: any) => r.body.products.map((p: any) => p.sku).sort())
  expect(await run({ channelDrift: 'true' })).toEqual(['cd-parent'])
})

it('🔴 end to end: the list shows the parent of the drifted child, not the clean product; without the filter it shows both', async () => {
  const run = (q: Record<string, string>) => scoped(() => listProducts(q as never)).then((r: any) => r.body.products.map((p: any) => p.sku).sort())
  expect(await run({ channelDrift: 'true' })).toEqual(['cd-parent'])
  expect(await run({})).toEqual(['cd-clean', 'cd-parent'])
})

/**
 * S2b — a shared eBay ItemID's owner listing is usually an EBAY_LISTING_SHELL, which the list hides by default. The eBay
 * read-back names the variant in the field (`quantity:<SKU>`), so the filter must reach THAT product and its parent — on
 * both list paths. A clean shell names nothing; a non-shell listing keeps its own path; a deleted product, or the same
 * SKU in another business, is never matched. Declared after the arms above, so their exact lists are unchanged.
 */
describe('a drifted eBay SHELL owner listing reaches the real product', () => {
  const sh = { parent: '', child: '', shell: '', cleanShell: '', other: '', nonShell: '', nsOther: '', gone: '', foreign: '' }
  const run = (q: Record<string, string>) => scoped(() => listProducts(q as never)).then((r: any) => r.body.products.map((p: any) => p.sku).sort())
  const listing = (productId: string, itemId: string) => prisma.channelListing.create({ data: { productId, channel: 'EBAY', marketplace: 'IT',
    channelMarket: 'EBAY_IT', region: 'IT', externalListingId: itemId, listingStatus: 'ACTIVE' } })
  const product = async (sku: string, data: Record<string, unknown> = {}) => (await prisma.product.create({ data: { sku, name: sku, basePrice: 10, ...data } as never })).id

  beforeAll(async () => {
    await scoped(async () => {
      sh.parent = await product('sh-parent', { isParent: true })
      sh.child = await product('SH-CHILD', { parentId: sh.parent })
      sh.shell = await product('sh-shell', { productType: 'EBAY_LISTING_SHELL' })
      sh.cleanShell = await product('sh-shell-clean', { productType: 'EBAY_LISTING_SHELL' })
      sh.other = await product('SH-OTHER')
      sh.nonShell = await product('ns-owner')
      sh.nsOther = await product('NS-OTHER')
      sh.gone = await product('SH-GONE', { deletedAt: new Date() })
      const shellL = await listing(sh.shell, '9001')
      const cleanL = await listing(sh.cleanShell, '9002')
      const nonShellL = await listing(sh.nonShell, '9003')
      await recordChannelReadback({ channelListingId: shellL.id, channel: 'EBAY', marketplace: 'IT', source: 'ebay-trading-getitem',
        compared: ['quantity:SH-CHILD', 'quantity:SH-GONE', 'quantity:SH-FOREIGN'],
        differing: [{ field: 'quantity:SH-CHILD', ours: 5, theirs: 7 }, { field: 'quantity:SH-GONE', ours: 1, theirs: 0 }, { field: 'quantity:SH-FOREIGN', ours: 2, theirs: 3 }] })
      await recordChannelReadback({ channelListingId: cleanL.id, channel: 'EBAY', marketplace: 'IT', source: 'ebay-trading-getitem', compared: ['quantity:SH-OTHER'], differing: [] })
      await recordChannelReadback({ channelListingId: nonShellL.id, channel: 'EBAY', marketplace: 'IT', source: 'ebay-trading-getitem',
        compared: ['quantity:NS-OTHER'], differing: [{ field: 'quantity:NS-OTHER', ours: 4, theirs: 1 }] })
    })
    // The same SKU as the shell names, in ANOTHER business: never matched. The row policy needs that business to exist.
    await prisma.workspace.create({ data: { id: 's2b-other-business', name: 'Other business', createdByUserId: 's2b', creationKey: 's2b-other' } })
    sh.foreign = await withWorkspace({ workspaceId: 's2b-other-business', actorUserId: null, membershipId: null, roleKeys: [] },
      () => product('SH-FOREIGN'))
  }, 60_000)

  it('🔴 LIVE path: the shell entry\'s product AND its parent are matched; clean shell, non-shell colon field, deleted and foreign products are not', async () => {
    const foreign = await withWorkspace({ workspaceId: 's2b-other-business', actorUserId: null, membershipId: null, roleKeys: [] },
      () => prisma.product.findFirst({ where: { sku: 'SH-FOREIGN' }, select: { workspaceId: true } }))
    // Positive control: the foreign product really sits in another business.
    expect(foreign?.workspaceId).toBe('s2b-other-business')
    const scope = await scoped(() => resolveProductsScope({ channelDrift: 'true' } as never))
    const inList: string[] = (scope.where.AND ?? []).find((c: any) => c?.id?.in)?.id.in ?? []
    expect(inList).toEqual(expect.arrayContaining([sh.child, sh.parent, sh.shell, sh.nonShell]))
    for (const never of [sh.cleanShell, sh.other, sh.nsOther, sh.gone, sh.foreign]) expect(inList).not.toContain(never)
    expect(await run({ channelDrift: 'true' })).toEqual(['cd-parent', 'ns-owner', 'sh-parent'])
  })

  it('🔴 CACHE path: with the cache filled by its real writer, the list takes it and shows the real product\'s parent', async () => {
    await scoped(() => productReadCacheService.refreshMany([sh.parent, sh.child, sh.shell, sh.cleanShell, sh.other, sh.nonShell, sh.nsOther, sh.gone]))
    const scope = await scoped(() => resolveProductsScope({ channelDrift: 'true' } as never))
    expect(scope.useCache).toBe(true)
    const inList: string[] = (scope.cacheWhere.AND ?? []).find((c: any) => c?.id?.in)?.id.in ?? []
    expect(inList).toEqual(expect.arrayContaining([sh.child, sh.parent]))
    expect(await run({ channelDrift: 'true' })).toEqual(['cd-parent', 'ns-owner', 'sh-parent'])
  })
})
