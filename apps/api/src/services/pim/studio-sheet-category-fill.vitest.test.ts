/**
 * The sheet's mapped-category fill lands ONLY in the coordinate channel's own category column
 * (`CHANNEL_CATEGORY_FIELD`: Amazon `productType`, eBay `categoryId`, Shopify `category`, Etsy `taxonomy_id`).
 *
 * Before, the fill matched `categoryId`, `productType` or `taxonomy_id` on ANY channel, so a Shopify sheet showed the
 * mapped category in Shopify's free-text "Product type" and left its real `category` column empty (found by the
 * variation-theme lane, 2026-09-26).
 *
 * Run: npx vitest run src/services/pim/studio-sheet-category-fill.vitest.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const category = vi.hoisted(() => ({ id: 'CAT-1' }))
const productFindMany = vi.fn()
const channelListingFindMany = vi.fn()
const getStudioColumns = vi.fn()

vi.mock('../../db.js', () => ({
  default: {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ $executeRaw: async () => 0 }),
    product: { findFirst: async () => ({ id: 'p_solo', parentId: null }), findMany: (...a: unknown[]) => productFindMany(...a) },
    channelListing: { findMany: (...a: unknown[]) => channelListingFindMany(...a) },
    // S11 — the first column's flat-file SKU read (`studio-sheet-sku.ts`, one statement): no snapshot here.
    $queryRaw: async () => [],
    // No family here is on the photo plan (images P3c reads it for the Product media cell).
    productMediaPlan: { findMany: async () => [] },
    productListingAlias: { findMany: async () => [] },
    fieldLinkGroup: { findMany: async () => [] },
    cellFormula: { findMany: async () => [] },
    categorySchema: { findFirst: async () => null, findMany: async () => [] },
    channelSchema: { findMany: async () => [] },
    marketplace: { findUnique: async () => ({ schemaMapping: null }), findMany: async () => [
      { channel: 'AMAZON', code: 'IT', languages: ['it'], language: 'it' }, { channel: 'EBAY', code: 'IT', languages: ['it'], language: 'it' },
      { channel: 'SHOPIFY', code: 'GLOBAL', languages: ['it'], language: 'it' }, { channel: 'ETSY', code: 'GLOBAL', languages: ['it'], language: 'it' },
    ] },
  },
}))
// The stock cells are one Matrix read (proven on PostgreSQL in studio-stock / studio-sheet-stock-columns); this mocked database has no Matrix.
vi.mock('./studio-stock.js', async (importOriginal) => ({ ...await importOriginal<typeof import('./studio-stock.js')>(), attachStudioStock: async () => ({ ms: 0 }) }))
vi.mock('./studio-columns.js', () => ({ getStudioColumns: (...a: unknown[]) => getStudioColumns(...a) }))
vi.mock('./product-category-context.js', () => ({ productCategoryContext: async () => ({ connectionId: 'account', categories: ['CAT-1'],
  defaults: { p_solo: { channelCategoryId: category.id, source: 'mapping' } } }) }))
vi.mock('./mapping/index.js', () => ({ resolveChannelValues: async () => ({ byProduct: {}, categoryByProduct: {}, missingProductIds: [], meta: {} }) }))

import { getStudioSheet } from './studio-sheet.service.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

// The sheet reads inside a business (profiles ON); the same call runs unchanged with profiles OFF.
const read = (channel: string, market: string) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] },
  () => getStudioSheet({ productId: 'p_solo', scope: 'channel', channel, market, locale: 'it' }))

const CATEGORY_KEYS = ['productType', 'categoryId', 'category', 'taxonomy_id']
const column = (key: string) => ({ key, writeField: key, label: key, group: 'Classification', kind: 'text', storage: 'listing',
  scope: 'global', requiredBy: [], editable: true, defaultVisible: true })

beforeEach(() => {
  category.id = 'CAT-1'
  for (const m of [productFindMany, channelListingFindMany, getStudioColumns]) m.mockReset()
  productFindMany.mockResolvedValue([{ id: 'p_solo', sku: 'SOLO', isParent: false, parentId: null, productType: null,
    name: 'Giacca', description: null, variationAxes: [], variantAttributes: {}, categoryAttributes: {}, translations: [] }])
})

describe('the mapped category fill', () => {
  it.each([
    ['AMAZON', 'productType', 'IT', 'Amazon · IT'],
    ['EBAY', 'categoryId', 'IT', 'eBay · IT'],
    ['SHOPIFY', 'category', 'GLOBAL', 'Shopify · GLOBAL'],
    ['ETSY', 'taxonomy_id', 'GLOBAL', 'Etsy · GLOBAL'],
  ])('%s fills only %s', async (channel, own, market, label) => {
    channelListingFindMany.mockResolvedValue([{ id: 'l1', productId: 'p_solo', channel, marketplace: market, channelConnectionId: 'account',
      platformAttributes: {}, translations: [], aliasKey: null }])
    getStudioColumns.mockResolvedValue({ coordinates: [{ channel, marketplace: market, label, inMarket: true, languages: ['it'] }],
      columns: CATEGORY_KEYS.map(column) })
    const { values } = (await read(channel, market)).rows[0]
    // POSITIVE CONTROL: the channel's own category column carries the mapped category. A Shopify cell shows the
    // mapping engine's value (`resolveBatch`, mocked empty here), so on Shopify only the fill's layer is visible.
    expect(values[own]).toMatchObject({ value: channel === 'SHOPIFY' ? null : 'CAT-1', source: 'master', inherited: true })
    for (const other of CATEGORY_KEYS.filter(key => key !== own)) {
      expect({ key: other, value: values[other]?.value, source: values[other]?.source }).toEqual({ key: other, value: null, source: null })
    }
  })

  // A missing category schema is reported on the channel's own category column, the same map as the fill.
  it.each([
    ['AMAZON', 'productType', 'IT', 'Amazon · IT'],
    ['EBAY', 'categoryId', 'IT', 'eBay · IT'],
    ['SHOPIFY', 'category', 'GLOBAL', 'Shopify · GLOBAL'],
    ['ETSY', 'taxonomy_id', 'GLOBAL', 'Etsy · GLOBAL'],
  ])('%s reports a missing category schema on %s', async (channel, own, market, label) => {
    channelListingFindMany.mockResolvedValue([{ id: 'l1', productId: 'p_solo', channel, marketplace: market, channelConnectionId: 'account',
      platformAttributes: {}, translations: [], aliasKey: null }])
    getStudioColumns.mockResolvedValue({ coordinates: [{ channel, marketplace: market, label, inMarket: true, languages: ['it'] }],
      columns: CATEGORY_KEYS.map(column), schemaMissing: [`${channel}:*`] })
    const { issues } = (await read(channel, market)).rows[0].readiness
    expect(issues.filter(issue => issue.label === 'Channel requirements').map(issue => issue.key)).toEqual([own])
  })

  // Etsy's category column is a number (an integer in Etsy's schema): an all-digit mapped id is filled as a number.
  it('fills Etsy’s number category column with a number', async () => {
    category.id = '177104'
    channelListingFindMany.mockResolvedValue([{ id: 'l1', productId: 'p_solo', channel: 'ETSY', marketplace: 'GLOBAL', channelConnectionId: 'account',
      platformAttributes: {}, translations: [], aliasKey: null }])
    getStudioColumns.mockResolvedValue({ coordinates: [{ channel: 'ETSY', marketplace: 'GLOBAL', label: 'Etsy · GLOBAL', inMarket: true, languages: ['it'] }],
      columns: [{ ...column('taxonomy_id'), kind: 'number' }] })
    expect((await read('ETSY', 'GLOBAL')).rows[0].values.taxonomy_id).toMatchObject({ value: 177104, source: 'master' })
  })
})
