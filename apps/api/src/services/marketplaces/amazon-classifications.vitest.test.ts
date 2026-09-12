import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../outbound-api-call-log.service.js', () => ({ instrumentSellingPartner: vi.fn() }))
import { AmazonService, extractClassifications } from './amazon.service.js'

const market = 'APJ6JRA9NG5V4'
const jacket = { classificationId: '2420941031', displayName: 'Giacche', parent: { classificationId: '100', displayName: 'Abbigliamento', parent: { classificationId: '1', displayName: 'Auto e Moto' } } }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('accepts the LWA credentials actually used by SP-API without unrelated AWS signing keys', async () => {
  for (const key of ['AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET', 'AMAZON_REFRESH_TOKEN']) vi.stubEnv(key, 'test-value')
  for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ROLE_ARN']) vi.stubEnv(key, '')
  const service = new AmazonService()
  expect(await service.isConfigured()).toBe(true)
  vi.stubEnv('AMAZON_REFRESH_TOKEN', '')
  expect(await service.isConfigured()).toBe(false)
})

describe('Amazon catalog classifications', () => {
  it('reads the market wrapper and returns assigned nodes with an ordered breadcrumb', () => {
    expect(extractClassifications([
      { marketplaceId: 'OTHER', classifications: [{ classificationId: '99', displayName: 'Foreign category' }] },
      { marketplaceId: market, classifications: [jacket] },
    ], market)).toEqual({ browseNodes: [2420941031], categoryPath: 'Auto e Moto › Abbigliamento › Giacche' })
  })
  it('does not concatenate separate branches or return ancestor IDs as selected categories', () => {
    expect(extractClassifications([{ marketplaceId: market, classifications: [jacket, jacket, { classificationId: '200', displayName: 'Sport', parent: { classificationId: '2', displayName: 'Outdoors' } }] }], market))
      .toEqual({ browseNodes: [2420941031, 200], categoryPath: 'Auto e Moto › Abbigliamento › Giacche' })
  })
  it('refuses unscoped, foreign, malformed and unsafe numeric IDs', () => {
    for (const value of [null, [jacket], [{ marketplaceId: 'OTHER', classifications: [jacket] }], [{ marketplaceId: market, classifications: [null, { classificationId: '12x' }, { classificationId: '9007199254740993' }] }]]) {
      expect(extractClassifications(value, market)).toEqual({ browseNodes: null, categoryPath: null })
    }
  })
  it('does not hang or invent a full breadcrumb when the parent chain cycles', () => {
    const cyclic: any = { classificationId: '10', displayName: 'Cycle' }; cyclic.parent = cyclic
    expect(extractClassifications([{ marketplaceId: market, classifications: [cyclic] }], market)).toEqual({ browseNodes: [10], categoryPath: null })
  })
  it('requests product types and reads only the requested ASIN and market', async () => {
    const service = new AmazonService()
    const callAPI = vi.fn().mockResolvedValue({ items: [
      { asin: 'WRONG', summaries: [{ marketplaceId: market, itemName: 'Wrong product' }] },
      { asin: 'B012345678', productTypes: [{ marketplaceId: 'OTHER', productType: 'SHOES' }, { marketplaceId: market, productType: 'COAT' }], summaries: [{ marketplaceId: 'OTHER', itemName: 'Wrong title' }, { marketplaceId: market, itemName: 'Jacket' }], classifications: [{ marketplaceId: market, classifications: [jacket] }] },
    ] })
    vi.spyOn(service as any, 'getClient').mockResolvedValue({ callAPI })
    expect(await service.detectProductTypeFromAsin('B012345678', market)).toMatchObject({ productType: 'COAT', title: 'Jacket', browseNodes: [2420941031], categoryPath: 'Auto e Moto › Abbigliamento › Giacche' })
    expect(callAPI).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ marketplaceIds: [market], identifiers: ['B012345678'], includedData: ['summaries', 'classifications', 'productTypes'] }) }))
    expect(await service.detectProductTypeFromAsin('MISSING', market)).toMatchObject({ productType: null, title: null, browseNodes: null, categoryPath: null })
  })
})
