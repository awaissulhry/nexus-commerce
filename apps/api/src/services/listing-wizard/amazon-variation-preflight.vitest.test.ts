import { beforeEach, expect, it, vi } from 'vitest'
import { AmazonPublishAdapter, amazonParentVariationAttributes } from './amazon-publish.adapter.js'
import { loadAmazonThemeFacts } from '../pim/variation-theme-facts.js'
import { amazonSpApiClient } from '../../clients/amazon-sp-api.client.js'
vi.mock('../../lib/amazon-sp-client.js', () => ({ getAmazonSellerId: async () => 'fixture-seller' }))
vi.mock('../../clients/amazon-sp-api.client.js', () => ({ amazonSpApiClient: { putListingsItem: vi.fn(() => { throw new Error('Provider boundary must not be reached') }), getListingsItem: vi.fn() } }))
vi.mock('../pim/variation-theme-facts.js', () => ({ loadAmazonThemeFacts: vi.fn() }))
const schema = { facts: { properties: { color: {}, size: {} }, themes: ['COLOR/SIZE'], deprecated: [] }, fetchedAt: null }
const child = (sku: string, color = 'Red') => ({ masterSku: sku, channelSku: sku, channelProductId: null, variationAttributes: { Color: color, Size: 'S' }, price: null, quantity: null })
const payload = () => ({ productType: 'OUTERWEAR', marketplaceId: 'IT', parentSku: 'fixture-parent', attributes: {}, variationTheme: 'COLOR/SIZE', children: [child('a'), child('b', 'Blue')] })
beforeEach(() => { vi.clearAllMocks(); vi.mocked(loadAmazonThemeFacts).mockResolvedValue(schema) })
it('refuses an unknown theme, unavailable schema, invalid binding or duplicate children before any provider write', async () => {
  const cases = [
    { ...payload(), variationTheme: 'NOT_A_THEME' },
    { ...payload(), variationMapping: { Color: 'invented_attribute', Size: 'size' } },
    { ...payload(), children: [child('a'), child('b')] },
  ]
  for (const input of cases) expect(await new AmazonPublishAdapter().publish(input)).toMatchObject({ ok: false, failedStep: 'validation' })
  vi.mocked(loadAmazonThemeFacts).mockResolvedValue(null)
  expect(await new AmazonPublishAdapter().publish(payload())).toMatchObject({ ok: false, failedStep: 'validation' })
  expect(amazonSpApiClient.putListingsItem).not.toHaveBeenCalled()
})
it('includes the matching parent variation envelope', () => {
  expect(amazonParentVariationAttributes('IT', 'COLOR/SIZE')).toEqual({ parentage_level: [{ marketplace_id: 'IT', value: 'parent' }], variation_theme: [{ marketplace_id: 'IT', name: 'COLOR/SIZE' }] })
})
