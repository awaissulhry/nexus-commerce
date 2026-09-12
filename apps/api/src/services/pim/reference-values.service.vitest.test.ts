import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ themes: vi.fn(), policies: vi.fn(), shipping: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { ebayDescriptionTheme: { findMany: mock.themes } } }))
vi.mock('../ebay-account.service.js', () => ({ ebayAccountService: { getSnapshot: mock.policies } }))
vi.mock('../categories/reference-labels.service.js', () => ({ sellerShippingTemplateLabels: mock.shipping }))
import { createReferenceResolver, type ReferenceInput } from './reference-values.service.js'
const input = (patch: Partial<ReferenceInput> = {}): ReferenceInput => ({ field: 'descriptionThemeId', value: 'Modern', channel: 'EBAY', marketplace: 'IT', accountId: 'account-a', ...patch })
beforeEach(() => { vi.clearAllMocks(); mock.themes.mockResolvedValue([{ id: 'theme-id', name: 'Modern', active: true }]) })

describe('authoritative reference choices', () => {
  it('resolves names and none/default semantics with one lightweight metadata read per batch', async () => {
    const resolve = createReferenceResolver()
    expect(await resolve(input())).toBe('theme-id')
    expect(await resolve(input({ value: 'No theme' }))).toBe('none')
    expect(await resolve(input({ value: 'Default theme' }))).toBeNull()
    expect(mock.themes).toHaveBeenCalledTimes(1)
    expect(mock.themes).toHaveBeenCalledWith({ select: { id: true, name: true, active: true } })
    mock.themes.mockResolvedValue([{ id: 'theme-id', name: 'Modern', active: false }])
    await expect(createReferenceResolver()(input())).rejects.toThrow('inactive')
  })
  it('does not call providers for clear, and refuses the wrong channel or non-text input', async () => {
    const resolve = createReferenceResolver()
    expect(await resolve(input({ value: null }))).toBeNull()
    await expect(resolve(input({ channel: 'AMAZON' }))).rejects.toThrow(/eBay listing scope/i)
    await expect(resolve(input({ value: 123 }))).rejects.toThrow('as text')
    expect(mock.themes).not.toHaveBeenCalled()
  })
  it('shares strict fresh policy reads per account/market and rejects foreign-market IDs', async () => {
    mock.policies.mockImplementation(async (account: string, market: string) => ({
      fulfillmentPolicies: [{ id: `${account}-${market}`, name: 'Standard delivery', marketplaceId: market }, { id: 'foreign', name: 'Foreign', marketplaceId: 'EBAY_US' }],
      paymentPolicies: [{ id: 'payment', name: 'Managed payments', marketplaceId: market }], returnPolicies: [], locations: [],
    }))
    const resolve = createReferenceResolver()
    expect(await resolve(input({ field: 'fulfillmentPolicyId', value: 'Standard delivery' }))).toBe('account-a-EBAY_IT')
    expect(await resolve(input({ field: 'paymentPolicyId', value: 'Managed payments' }))).toBe('payment')
    expect(mock.policies).toHaveBeenCalledTimes(1)
    expect(mock.policies).toHaveBeenCalledWith('account-a', 'EBAY_IT', { forceRefresh: true, requireComplete: true })
    await expect(resolve(input({ field: 'fulfillmentPolicyId', value: 'foreign' }))).rejects.toThrow('not an available choice')
    expect(await resolve(input({ field: 'fulfillmentPolicyId', value: 'Standard delivery', accountId: 'account-b' }))).toBe('account-b-EBAY_IT')
    expect(await resolve(input({ field: 'fulfillmentPolicyId', value: 'Standard delivery', marketplace: 'UK' }))).toBe('account-a-EBAY_GB')
    expect(mock.policies).toHaveBeenCalledTimes(3)
  })
  it('uses seller-scoped shipping choices instead of shared schema labels', async () => {
    mock.shipping.mockResolvedValue({ uuid: 'Standard shipping' })
    const resolve = createReferenceResolver(), request = input({ channel: 'AMAZON', field: 'merchant_shipping_group', value: 'Standard shipping', productType: 'COAT' })
    expect(await resolve(request)).toBe('uuid')
    expect(await resolve(request)).toBe('uuid')
    expect(await resolve({ ...request, field: 'shippingTemplate' })).toBe('uuid')
    expect(mock.shipping).toHaveBeenCalledTimes(1)
    expect(mock.shipping).toHaveBeenCalledWith({ marketplace: 'IT', productType: 'COAT', accountId: 'account-a', refresh: true })
    await resolve({ ...request, productType: 'SHIRT' })
    await resolve({ ...request, accountId: 'account-b' })
    expect(mock.shipping).toHaveBeenCalledTimes(3)
  })
  it('fails closed on provider outages and malformed responses without leaking details', async () => {
    mock.policies.mockRejectedValue(new Error('private provider response'))
    await expect(createReferenceResolver()(input({ field: 'paymentPolicyId' }))).rejects.toThrow('choices could not be verified')
    mock.shipping.mockResolvedValue({ id: '' })
    await expect(createReferenceResolver()(input({ channel: 'AMAZON', field: 'shippingTemplate', productType: 'COAT' }))).rejects.toThrow('choices could not be verified')
  })
})
