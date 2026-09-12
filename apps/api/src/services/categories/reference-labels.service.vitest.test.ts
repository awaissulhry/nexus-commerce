import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spec: vi.fn(), connection: vi.fn(), primary: vi.fn(), callAPI: vi.fn(), client: vi.fn(), mappings: vi.fn(), browseNames: vi.fn() }))
vi.mock('./browse-node-labels.service.js', () => ({ cachedBrowseNodeLabels: mocks.browseNames }))
vi.mock('../../db.js', () => ({ default: { categoryChannelMapping: { findMany: mocks.mappings } } }))
vi.mock('../pim/channel-specs/index.js', () => ({ loadAmazonSpec: mocks.spec }))
vi.mock('../connection-resolver.service.js', () => ({ resolveChannelConnectionId: mocks.connection, isPrimaryChannelConnection: mocks.primary }))
vi.mock('../../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: () => 'seller', getAmazonSpClient: mocks.client }))
vi.mock('./schema-document.js', () => ({ downloadAmazonSchema: async (schema: any) => (await fetch(schema.link.resource)).json(), schemaFingerprint: () => 'test-schema' }))
import { amazonReferenceLabels, cachedCategoryLabels, sellerShippingTemplateLabels } from './reference-labels.service.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.spec.mockResolvedValue({ fields: [{ key: 'recommended_browse_nodes', optionLabels: { '123': 'Clothing > Jackets' } }] })
  mocks.connection.mockResolvedValue('primary')
  mocks.primary.mockResolvedValue(true)
  mocks.client.mockResolvedValue({ callAPI: mocks.callAPI })
})

describe('Amazon reference names', () => {
  it('fills unresolved browse-node names from the same-market cache and keeps existing schema names', async () => {
    mocks.browseNames.mockResolvedValue({ '2420941031': 'Auto e Moto > Giacche' })
    const result = await amazonReferenceLabels({ marketplace: 'IT', productType: 'OUTERWEAR', shipping: false, browseNodeIds: ['123', '2420941031', 'missing'] })
    expect(mocks.browseNames).toHaveBeenCalledWith('IT', ['2420941031', 'missing'])
    expect(result.labels.recommended_browse_nodes).toEqual({ '123': 'Clothing > Jackets', '2420941031': 'Auto e Moto > Giacche' })
    expect(result.labels.browseNodeId).toEqual(result.labels.recommended_browse_nodes)
    expect(result.unavailable).toEqual(['browseNodes'])
    expect(mocks.client).not.toHaveBeenCalled()
  })
  it('uses the selected market’s saved category path and rejects conflicting labels', async () => {
    mocks.mappings.mockResolvedValue([
      { marketplace: '*', channelCategoryPath: 'Generic jackets' },
      { marketplace: 'IT', channelCategoryPath: 'Abbigliamento > Giacche' },
    ])
    expect(await cachedCategoryLabels('EBAY', 'IT', '123')).toEqual({ categoryId: { '123': 'Abbigliamento > Giacche' } })
    expect(mocks.mappings).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ channel: 'EBAY', marketplace: { in: ['IT'] }, channelCategoryId: '123' }) }))
    mocks.mappings.mockResolvedValue([
      { marketplace: 'IT', channelCategoryPath: 'Jackets' },
      { marketplace: 'IT', channelCategoryPath: 'Shoes' },
    ])
    expect(await cachedCategoryLabels('EBAY', 'IT', '123')).toEqual({})
    mocks.mappings.mockResolvedValue([{ marketplace: '*', channelCategoryPath: 'Unknown market’s category' }])
    expect(await cachedCategoryLabels('EBAY', 'IT', '123')).toEqual({})
  })
  it('returns cached schema names without contacting a seller or changing option codes', async () => {
    const result = await amazonReferenceLabels({ marketplace: 'IT', productType: 'OUTERWEAR', shipping: false })
    expect(result.labels.recommended_browse_nodes).toEqual({ '123': 'Clothing > Jackets' })
    expect(mocks.client).not.toHaveBeenCalled()
    expect(mocks.connection).not.toHaveBeenCalled()
  })

  it('does not use primary seller credentials to name another account’s templates', async () => {
    mocks.connection.mockResolvedValue('alternate')
    mocks.primary.mockResolvedValue(false)
    const result = await amazonReferenceLabels({ marketplace: 'IT', productType: 'OUTERWEAR', accountId: 'alternate', shipping: true })
    expect(mocks.connection).toHaveBeenCalledWith('AMAZON', 'alternate')
    expect(mocks.client).toHaveBeenCalledWith('alternate')
    expect(result.unavailable).toEqual(['shippingTemplate'])
  })

  it('reads seller enum names while keeping its schema separate from the shared cache', async () => {
    mocks.callAPI.mockResolvedValue({ schema: { link: { resource: 'https://schema.test/definition' } } })
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ properties: {
      merchant_shipping_group: { type: 'array', items: { type: 'object', properties: {
        value: { type: 'string', enum: ['template-id'], enumNames: ['Standard delivery'] },
      } } },
    } }) })
    vi.stubGlobal('fetch', fetcher)
    try {
      const result = await amazonReferenceLabels({ marketplace: 'DE', productType: 'OUTERWEAR', shipping: true })
      expect(result.labels.shippingTemplate).toEqual({ 'template-id': 'Standard delivery' })
      expect(mocks.callAPI).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ sellerId: 'seller', marketplaceIds: ['A1PA6795UKMFR9'] }) }))
      expect(result.labels.recommended_browse_nodes).toEqual({ '123': 'Clothing > Jackets' })
    } finally { vi.unstubAllGlobals() }
  })

  it('preserves cached labels when a seller lookup fails', async () => {
    mocks.callAPI.mockRejectedValue(new Error('Offline'))
    const result = await amazonReferenceLabels({ marketplace: 'FR', productType: 'OUTERWEAR', shipping: true })
    expect(result.labels.recommended_browse_nodes).toEqual({ '123': 'Clothing > Jackets' })
    expect(result.unavailable).toEqual(['shippingTemplate'])
  })

  it('refreshes seller choices for writes and excludes deprecated templates', async () => {
    mocks.callAPI.mockResolvedValue({ schema: { link: { resource: 'https://schema.test/definition' } } })
    let active = 'first'
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => ({ ok: true, json: async () => ({ properties: {
      merchant_shipping_group: { type: 'array', items: { type: 'object', properties: {
        value: { type: 'string', enum: [active, 'retired'], enumNames: ['Standard delivery', 'Old delivery'], $lifecycle: { enumDeprecated: ['retired'] } },
      } } },
    } }) })))
    try {
      const scope = { marketplace: 'IT', productType: 'SHOES', accountId: 'primary' }
      expect(await sellerShippingTemplateLabels({ ...scope, refresh: true })).toEqual({ first: 'Standard delivery' })
      active = 'replacement'
      expect(await sellerShippingTemplateLabels(scope)).toEqual({ first: 'Standard delivery' })
      expect(await sellerShippingTemplateLabels({ ...scope, refresh: true })).toEqual({ replacement: 'Standard delivery' })
      expect(mocks.callAPI).toHaveBeenCalledTimes(2)
    } finally { vi.unstubAllGlobals() }
  })
})
