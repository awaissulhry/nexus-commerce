/**
 * S2 — the channel-SKU backfill core (channel-sku-backfill.ts) on real PostgreSQL (PGlite, production schema and
 * policies): a dry run writes nothing, `apply` writes exactly the rows it counted, a second run writes nothing,
 * conflicts stay empty and are listed, a value already set is never overwritten, and another business is untouched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../utils/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { backfillChannelSkus } from './channel-sku-backfill.js'

const OTHER_BUSINESS = 'skurows-backfill-other'
const as = (workspaceId: string) => <T>(work: () => Promise<T>) => withWorkspace({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const scoped = as(LEGACY_WORKSPACE_ID)
const other = as(OTHER_BUSINESS)
const lid: Record<string, string> = {}
const LIVE = { listingStatus: 'ACTIVE', isPublished: true, externalListingId: 'EXT' }
const DRAFT = { listingStatus: 'DRAFT', isPublished: false, externalListingId: null }

async function seed(name: string, sku: string, opts: { channel?: string; account: string; facts?: Record<string, unknown>; offers?: Array<{ sku: string; isActive?: boolean; method?: 'FBA' | 'FBM' }>
  product?: Record<string, unknown>; alias?: { sku: string | null } }) {
  const channel = opts.channel ?? 'AMAZON'
  const productId = (await prisma.product.create({ data: { sku, name: sku, basePrice: 10, ...opts.product } as never })).id
  const alias = opts.alias ? await prisma.productListingAlias.create({ data: { productId, channel, marketplace: 'IT', channelConnectionId: opts.account, label: 'Second', position: 1, sku: opts.alias.sku } }) : null
  const row = await prisma.channelListing.create({ data: {
    productId, channel, marketplace: 'IT', region: 'IT', channelMarket: `${channel}_IT`, channelConnectionId: opts.account,
    aliasKey: alias?.id ?? '', ...(alias ? { aliasId: alias.id } : {}), ...LIVE, ...opts.facts,
  } as never })
  for (const o of opts.offers ?? []) await prisma.offer.create({ data: { channelListingId: row.id, sku: o.sku, fulfillmentMethod: o.method ?? 'FBM', isActive: o.isActive ?? true } })
  lid[name] = row.id
}
const connection = (channelType: string, label: string) => prisma.channelConnection.create({ data: { channelType, accountLabel: label, externalAccountId: label, isActive: true, isPrimary: false } as never }).then(c => c.id)
const columns = (names: string[], run = scoped) => run(() => prisma.channelListing.findMany({ where: { id: { in: names.map(n => lid[n]) } }, select: { id: true, channelSku: true, liveChannelSku: true, version: true } }))
  .then(rows => Object.fromEntries(names.map(n => { const r = rows.find(x => x.id === lid[n]); return [n, r ? { channelSku: r.channelSku, liveChannelSku: r.liveChannelSku, version: r.version } : null] })))

const ALL = ['liveOffer', 'draftAttr', 'same', 'none', 'conflict', 'twoOffers', 'aliasNone', 'preset', 'deleted', 'shopify', 'ebayAlias']

beforeAll(async () => {
  await scoped(async () => {
    const amazon = await connection('AMAZON', 'backfill-amazon')
    const shopify = await connection('SHOPIFY', 'backfill-shopify')
    const ebay = await connection('EBAY', 'backfill-ebay')
    await seed('liveOffer', 'B-1', { account: amazon, offers: [{ sku: 'B-1-OFF' }, { sku: 'B-1-OLD', isActive: false, method: 'FBA' }] })
    await seed('draftAttr', 'B-2', { account: amazon, facts: { ...DRAFT, platformAttributes: { sellerSku: 'B-2-PA' } } })
    await seed('same', 'B-3', { account: amazon, offers: [{ sku: 'B-3' }] })
    await seed('none', 'B-4', { account: amazon })
    await seed('conflict', 'B-5', { account: amazon, offers: [{ sku: 'B-5-X' }], facts: { flatFileSnapshot: { item_sku: 'B-5-Y' } } })
    await seed('twoOffers', 'B-6', { account: amazon, offers: [{ sku: 'B-6-FBM' }, { sku: 'B-6-FBA', method: 'FBA' }] })
    await seed('aliasNone', 'B-7', { account: amazon, alias: { sku: null } })
    await seed('preset', 'B-8', { account: amazon, offers: [{ sku: 'B-8-OFF' }], facts: { channelSku: 'USER-SET' } })
    await seed('deleted', 'B-9', { account: amazon, offers: [{ sku: 'B-9-OFF' }], product: { deletedAt: new Date() } })
    await seed('shopify', 'B-10', { channel: 'SHOPIFY', account: shopify, facts: { platformAttributes: { sku: 'B-10-SH' } } })
    await seed('ebayAlias', 'B-11', { channel: 'EBAY', account: ebay, alias: { sku: 'B-11-ALIAS' }, product: { isParent: true } })
  })
  await prisma.workspace.create({ data: { id: OTHER_BUSINESS, name: 'Other business', createdByUserId: 'skurows', creationKey: 'skurows-backfill-other' } as never })
  await other(async () => {
    await seed('foreign', 'F-1', { account: await connection('AMAZON', 'backfill-other-amazon'), offers: [{ sku: 'F-1-OFF' }] })
  })
}, 120_000)
afterAll(async () => { await state.db?.close() })

const counts = (overrides: Record<string, number>) => ({ listings: 0, followsProduct: 0, channelSkuSet: 0, liveChannelSkuSet: 0, alreadySet: 0, conflicts: 0, needsOwnSku: 0, changedMeanwhile: 0, ...overrides })
const FIRST_RUN = {
  AMAZON: counts({ listings: 8, followsProduct: 2, channelSkuSet: 2, liveChannelSkuSet: 2, conflicts: 2, needsOwnSku: 1 }),
  SHOPIFY: counts({ listings: 1, channelSkuSet: 1, liveChannelSkuSet: 1 }),
  EBAY: counts({ listings: 1, channelSkuSet: 1, liveChannelSkuSet: 1 }),
}

describe('backfillChannelSkus', () => {
  it('a dry run counts and lists, and writes nothing (any page size)', async () => {
    const before = await columns(ALL)
    const report = await scoped(() => backfillChannelSkus(prisma as never))
    expect(report).toMatchObject({ workspaceId: LEGACY_WORKSPACE_ID, apply: false, byChannel: FIRST_RUN })
    expect(report.problems.map(p => [p.listingId, p.code, p.candidates])).toEqual(expect.arrayContaining([
      [lid.conflict, 'CONFLICTING_SKUS', ['B-5-X', 'B-5-Y']],
      [lid.twoOffers, 'MULTIPLE_ACTIVE_OFFERS', ['B-6-FBM', 'B-6-FBA']],
      [lid.aliasNone, 'ALIAS_NEEDS_OWN_SKU', []],
    ]))
    expect(report.problems).toHaveLength(3)
    expect((await scoped(() => backfillChannelSkus(prisma as never, { batchSize: 2 }))).byChannel).toEqual(FIRST_RUN)
    expect(await columns(ALL)).toEqual(before)
  })

  it('apply writes the own SKUs: the column the channel holds only for a non-draft; conflicts, followers and a set value stay', async () => {
    const before = await columns(ALL)
    const report = await scoped(() => backfillChannelSkus(prisma as never, { apply: true, batchSize: 3 }))
    expect(report.byChannel).toEqual(FIRST_RUN)
    const after = await columns(ALL)
    const v = (name: string) => before[name]!.version
    expect(after).toEqual({
      liveOffer: { channelSku: 'B-1-OFF', liveChannelSku: 'B-1-OFF', version: v('liveOffer') },
      draftAttr: { channelSku: 'B-2-PA', liveChannelSku: null, version: v('draftAttr') },
      same: { channelSku: null, liveChannelSku: null, version: v('same') },
      none: { channelSku: null, liveChannelSku: null, version: v('none') },
      conflict: { channelSku: null, liveChannelSku: null, version: v('conflict') },
      twoOffers: { channelSku: null, liveChannelSku: null, version: v('twoOffers') },
      aliasNone: { channelSku: null, liveChannelSku: null, version: v('aliasNone') },
      preset: { channelSku: 'USER-SET', liveChannelSku: 'B-8-OFF', version: v('preset') },
      deleted: { channelSku: null, liveChannelSku: null, version: v('deleted') },
      shopify: { channelSku: 'B-10-SH', liveChannelSku: 'B-10-SH', version: v('shopify') },
      ebayAlias: { channelSku: 'B-11-ALIAS', liveChannelSku: 'B-11-ALIAS', version: v('ebayAlias') },
    })
    // 🔴 Another business is untouched by this business's run.
    expect(await columns(['foreign'], other)).toEqual({ foreign: { channelSku: null, liveChannelSku: null, version: expect.any(Number) } })
  })

  it('a second run writes nothing', async () => {
    const before = await columns(ALL)
    const report = await scoped(() => backfillChannelSkus(prisma as never, { apply: true }))
    expect(report.byChannel).toEqual({
      AMAZON: counts({ listings: 8, followsProduct: 2, alreadySet: 3, conflicts: 2, needsOwnSku: 1 }),
      SHOPIFY: counts({ listings: 1, alreadySet: 1 }),
      EBAY: counts({ listings: 1, alreadySet: 1 }),
    })
    expect(await columns(ALL)).toEqual(before)
  })

  it('the other business is backfilled by its own run', async () => {
    const report = await other(() => backfillChannelSkus(prisma as never, { apply: true }))
    expect(report).toMatchObject({ workspaceId: OTHER_BUSINESS, byChannel: { AMAZON: counts({ listings: 1, channelSkuSet: 1, liveChannelSkuSet: 1 }) } })
    expect(await columns(['foreign'], other)).toMatchObject({ foreign: { channelSku: 'F-1-OFF', liveChannelSku: 'F-1-OFF' } })
  })
})
