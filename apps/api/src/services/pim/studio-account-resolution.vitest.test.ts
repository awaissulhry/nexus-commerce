import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ context: vi.fn(), listings: vi.fn(), aliases: vi.fn(), resolve: vi.fn(), formulas: vi.fn(), primary: vi.fn() }))
const product = { id: 'p', sku: 'P', parentId: null, isParent: false, productType: 'OUTERWEAR', categoryAttributes: { material: 'Shared material' }, variantAttributes: {}, localizedContent: {}, variationAxes: [] }
vi.mock('../../db.js', () => ({ default: {
  product: { findFirst: async () => ({ id: 'p', parentId: null }), findMany: async () => [product] },
  channelListing: { findMany: mocks.listings }, productListingAlias: { findMany: mocks.aliases },
  fieldLinkGroup: { findMany: async () => [] }, cellFormula: { findMany: mocks.formulas },
} }))
vi.mock('../connection-resolver.service.js', () => ({ isPrimaryChannelConnection: mocks.primary }))
vi.mock('./studio-columns.js', () => ({ getStudioColumns: async () => ({ locale: 'it',
  coordinates: [{ channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT', inMarket: true }],
  columns: [{ key: 'material', label: 'Material', group: 'content', kind: 'text', scope: 'global', storage: 'categoryAttributes', requiredBy: [], editable: true, defaultVisible: true, writeField: 'attr_material',
    channels: { 'Amazon · IT': { key: 'material', attribute: 'material', path: [] } } }],
}) }))
vi.mock('./product-category-context.js', () => ({ productCategoryContext: mocks.context }))
vi.mock('./mapping/index.js', () => ({ resolveChannelValues: mocks.resolve }))
import { getStudioSheet } from './studio-sheet.service.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.formulas.mockResolvedValue([])
  mocks.primary.mockImplementation(async (_channel, account) => account === 'a')
  mocks.context.mockImplementation(async (_ids, _channel, _market, accountId) => ({ categories: ['OUTERWEAR'], defaults: {}, connectionId: accountId ?? null }))
  mocks.resolve.mockResolvedValue({ byProduct: {}, categoryByProduct: {}, missingProductIds: [] })
  mocks.aliases.mockImplementation(async ({ where }) => ['a', 'b', null].map((account, index) => ({ id: `alias-${account}`, channelConnectionId: account, label: String(account), position: index + 1, status: 'ACTIVE' }))
    .filter(alias => !Object.hasOwn(where, 'channelConnectionId') || alias.channelConnectionId === where.channelConnectionId))
  mocks.listings.mockImplementation(async ({ where }) => ['a', 'b', null].map(account => ({ id: `listing-${account}`, productId: 'p', aliasId: null, channelConnectionId: account, overrideData: { material: `Material ${account}` }, platformAttributes: {} }))
    .filter(listing => !Object.hasOwn(where, 'channelConnectionId') || listing.channelConnectionId === where.channelConnectionId))
})

describe('channel sheet account isolation', () => {
  it('keeps the effective value and its supplying rule together for each account and listing', async () => {
    mocks.resolve.mockImplementation(async ({ channelConnectionId, aliasKey }) => {
      const id = `${channelConnectionId}:${aliasKey || 'primary'}`
      return { byProduct: { p: { material: {
        value: `Derived ${id}`, status: 'mapped', provenance: 'catalogRule',
        supplyingRule: { id, name: `Rule ${id}`, version: 3, href: `/channels/mapping?rule=${encodeURIComponent(id)}` },
        appliedTransforms: [], warnings: [], errors: [], required: false,
      } } }, categoryByProduct: {}, missingProductIds: [] }
    })
    for (const accountId of ['a', 'b']) {
      const sheet = await getStudioSheet({ productId: 'p', scope: 'channel', channel: 'AMAZON', market: 'IT', accountId })
      for (const row of sheet.rows) {
        const id = `${accountId}:${row.aliasId || 'primary'}`
        expect(row.values.material.value).toBe(`Derived ${id}`)
        expect(row.values.material.mapped?.supplyingRule).toEqual({
          id, name: `Rule ${id}`, version: 3, href: `/channels/mapping?rule=${encodeURIComponent(id)}`,
        })
        expect(row.values.material.writeTarget).toBe('channelListing')
      }
    }
  })
  it.each(['a', 'b'])('reads only the selected account’s rows, aliases and mapping inputs: %s', async accountId => {
    const sheet = await getStudioSheet({ productId: 'p', scope: 'channel', channel: 'AMAZON', market: 'IT', accountId })
    expect(mocks.context).toHaveBeenCalledWith(['p'], 'AMAZON', 'IT', accountId)
    expect(sheet.scope.connectionId).toBe(accountId)
    expect(sheet.aliases.map(alias => alias.id)).toEqual([null, `alias-${accountId}`])
    expect(sheet.rows[0].values.material.value).toBe(`Material ${accountId}`)
    expect(mocks.resolve.mock.calls.every(([input]) => input.channelConnectionId === accountId)).toBe(true)
  })
  it('preserves the null destination across stored values and mapping enrichment', async () => {
    const sheet = await getStudioSheet({ productId: 'p', scope: 'channel', channel: 'AMAZON', market: 'IT' })
    expect(sheet.scope.connectionId).toBeNull()
    expect(sheet.aliases.map(alias => alias.id)).toEqual([null, 'alias-null'])
    expect(sheet.rows[0].values.material.value).toBe('Material null')
    expect(mocks.resolve.mock.calls.every(([input]) => input.channelConnectionId === null)).toBe(true)
  })
  it('attaches primary-account formula metadata only to that account’s primary listing', async () => {
    mocks.formulas.mockImplementation(async ({ where }) => where.channelConnectionId === 'a'
      ? [{ productId: 'p', aliasKey: '', fieldKey: 'material', expr: '$brand', locale: 'it', lastError: 'Missing input', dependsOn: ['brand'] }]
      : [])
    const primary = await getStudioSheet({ productId: 'p', scope: 'channel', channel: 'AMAZON', market: 'IT', accountId: 'a' })
    const alternate = await getStudioSheet({ productId: 'p', scope: 'channel', channel: 'AMAZON', market: 'IT', accountId: 'b' })
    expect(primary.rows[0].values.material.formula).toBe('$brand')
    expect(primary.rows.filter(row => row.aliasId).every(row => !row.values.material.formula)).toBe(true)
    expect(alternate.rows.every(row => !row.values.material.formula && !row.values.material.formulaError)).toBe(true)
  })
})
