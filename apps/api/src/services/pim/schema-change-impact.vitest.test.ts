/**
 * P4 (docs/attributes/PLAN.md §4.2) — a channel-rule change reaches the products it touches.
 *
 *   1. `diffChannelSpecs` — what changed, from the adapter output, for any channel (pure).
 *   2. `productsInChannelCategory` — exactly the products whose effective category is the changed one (listing pin
 *      first, then the mapped category), and no others.
 *   3. End to end through `CategorySchemaService`: a new eBay definition version logs its changes, records the affected
 *      products, and marks ONLY those families' readiness (for that channel × market) pending.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ db: null as any, aspects: [] as unknown[] }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
vi.mock('../ebay-category.service.js', () => ({
  EbayCategoryService: class {
    async getCategoryAspectsRich() { return state.aspects }
    async getItemConditionPolicies() { return [] }
  },
}))
import prisma from '../../db.js'
import { ebaySpecFromCache, type EbayCachedAspect } from './channel-specs/ebay.js'
import { diffChannelSpecs, READINESS_CHANGES } from './channel-specs/spec-diff.js'
import { productsInChannelCategory } from './schema-change-impact.service.js'
import { reconcileFamilyReadiness } from './readiness-index.service.js'
import { CategorySchemaService } from '../categories/schema-sync.service.js'

afterAll(async () => { await state.db?.close() })

const aspect = (name: string, extra: Partial<EbayCachedAspect> = {}): EbayCachedAspect =>
  ({ id: `aspect_${name}`, label: name, localizedName: name, englishName: name, kind: extra.options ? 'enum' : 'text', ...extra })
const spec = (aspects: EbayCachedAspect[]) => ebaySpecFromCache({ marketplace: 'IT', categoryId: '177104', aspects })

describe('diffChannelSpecs', () => {
  it('names each change: requirement flips, removed strict options, a field arriving required, a field removed', () => {
    const before = spec([aspect('Brand', { required: true }), aspect('Color', { options: ['Black', 'Red'], enumMode: 'strict' }), aspect('Style')])
    const after = spec([aspect('Brand'), aspect('Color', { options: ['Black'], enumMode: 'strict' }), aspect('Material', { required: true })])
    const changes = diffChannelSpecs(before, after)
    expect(changes).toEqual(expect.arrayContaining([
      { changeType: 'REQUIRED_CHANGED', fieldId: 'brand', oldValue: { required: true }, newValue: { required: false } },
      { changeType: 'ENUM_REMOVED', fieldId: 'color', oldValue: { values: ['Red'] } },
      { changeType: 'FIELD_ADDED', fieldId: 'material', newValue: { requirement: 'required' } },
      { changeType: 'REQUIRED_CHANGED', fieldId: 'material', oldValue: { required: false }, newValue: { required: true } },
      { changeType: 'FIELD_REMOVED', fieldId: 'style', oldValue: { requirement: 'optional' } },
    ]))
    expect(changes).toHaveLength(5)
  })

  it('reports nothing for the same rules, and an open list losing a suggestion is not a readiness change', () => {
    const rules = [aspect('Brand', { required: true }), aspect('Features', { options: ['Waterproof', 'Reflective'], enumMode: 'open' })]
    expect(diffChannelSpecs(spec(rules), spec(rules))).toEqual([])
    const fewer = [aspect('Brand', { required: true }), aspect('Features', { options: ['Waterproof'], enumMode: 'open' })]
    expect(diffChannelSpecs(spec(rules), spec(fewer)).filter(c => READINESS_CHANGES.has(c.changeType))).toEqual([])
  })
})

describe('a rule change reaches exactly the products it touches', () => {
  beforeAll(async () => {
    await prisma.channelConnection.create({ data: { id: 'sci-ebay', channelType: 'EBAY', isActive: true } as any })
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'IT', currency: 'EUR', region: 'EU', language: 'it', languages: ['it'] } })
    const family = async (root: string, categoryId: string | null) => {
      await prisma.product.create({ data: { id: root, sku: root.toUpperCase(), name: root, basePrice: 1, isParent: true } })
      await prisma.product.create({ data: { id: `${root}-kid`, sku: `${root.toUpperCase()}-KID`, name: `${root} kid`, basePrice: 1, parentId: root } })
      if (categoryId) for (const productId of [root, `${root}-kid`]) {
        await prisma.channelListing.create({ data: { productId, channel: 'EBAY', channelMarket: 'EBAY_IT' as any, marketplace: 'IT', region: 'EU',
          channelConnectionId: 'sci-ebay', price: 1, platformAttributes: { categoryId } as never } })
      }
      await reconcileFamilyReadiness(root)
    }
    await family('sci-jacket', '177104')   // in the changed category
    await family('sci-glove', '177109')    // same channel and market, another category
    await family('sci-unlisted', null)     // no listing, no mapping: no eBay category at all
  }, 120_000)

  it('finds the products pinned to the category, and not the others', async () => {
    const impact = await productsInChannelCategory({ channel: 'EBAY', marketplace: 'IT', category: '177104' })
    expect(impact.productIds.sort()).toEqual(['sci-jacket', 'sci-jacket-kid'])
    expect(impact.rootIds).toEqual(['sci-jacket'])
  })

  it('a new eBay rule version logs its changes, records the affected products and marks only that family pending', async () => {
    const service = new CategorySchemaService(prisma as never, { isConfigured: async () => false } as never)
    state.aspects = [{ name: 'Marca', englishName: 'Brand', values: [], mode: 'FREE_TEXT', required: false, usage: 'OPTIONAL', cardinality: 'SINGLE', variantEligible: false, dataType: 'STRING' }]
    await service.refreshSchema({ channel: 'EBAY', marketplace: 'IT', productType: '177104' })
    expect(await prisma.readinessIndex.count({ where: { pendingSince: { not: null } } })).toBe(0)   // first version: nothing to compare

    state.aspects = [{ name: 'Marca', englishName: 'Brand', values: [], mode: 'FREE_TEXT', required: true, usage: 'REQUIRED', cardinality: 'SINGLE', variantEligible: false, dataType: 'STRING' }]
    await service.refreshSchema({ channel: 'EBAY', marketplace: 'IT', productType: '177104' })

    const changes = await prisma.schemaChange.findMany({ where: { channel: 'EBAY', productType: '177104' } })
    expect(changes.map(c => [c.changeType, c.fieldId])).toEqual([['REQUIRED_CHANGED', 'brand']])
    expect(changes[0].affectedProducts.sort()).toEqual(['sci-jacket', 'sci-jacket-kid'])

    const pending = await prisma.readinessIndex.findMany({ where: { pendingSince: { not: null } }, select: { productId: true, channel: true, market: true } })
    expect(pending.length).toBeGreaterThan(0)
    expect(new Set(pending.map(p => p.productId))).toEqual(new Set(['sci-jacket', 'sci-jacket-kid']))
    expect(pending.every(p => p.channel === 'EBAY' && p.market === 'IT')).toBe(true)
  })
})
