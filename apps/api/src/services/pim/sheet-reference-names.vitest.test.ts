import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ themes: vi.fn(), categories: vi.fn(), taxonomy: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { ebayDescriptionTheme: { findMany: mocks.themes } } }))
vi.mock('../categories/reference-labels.service.js', () => ({ cachedCategoryLabelsMany: mocks.categories }))
vi.mock('../taxonomy/repository.js', () => ({ taxonomyNames: mocks.taxonomy }))
import { withSelectedReferenceNames } from './sheet-reference-names.js'
const sheet = () => ({ scope: { kind: 'channel', channel: 'EBAY', marketplace: 'IT', connectionId: 'account-a' }, schema: { marketplace: 'IT', locale: 'it' },
  columns: ['categoryId','descriptionThemeId','paymentPolicyId'].map(key => ({ key })),
  rows: [{ values: { categoryId: { value: '123' }, descriptionThemeId: { value: 'theme-a' }, paymentPolicyId: { value: 'policy-a' } } },
    { values: { categoryId: { value: '123' }, descriptionThemeId: { value: 'theme-a' } } }], meta: { tookMs: 5, schemaMissing: [] },
})
beforeEach(() => {
  mocks.themes.mockReset().mockResolvedValue([{ id: 'theme-a', name: 'Archived example', active: false }])
  mocks.categories.mockReset().mockResolvedValue({ categoryId: { '123': 'Example > Jackets' } })
  mocks.taxonomy.mockReset().mockResolvedValue({ 'gid://shopify/TaxonomyCategory/aa-1-10-2': 'Apparel & Accessories > Clothing > Outerwear > Coats & Jackets' })
})
describe('selected sheet display names', () => {
  it('reads selected IDs once, keeps inactive assigned theme names, and never changes cell values or allowed choices', async () => {
    const input = sheet(), before = structuredClone(input)
    const output = await withSelectedReferenceNames(input)
    expect(input).toEqual(before)
    expect(output.rows).toBe(input.rows)
    expect(output.columns).toBe(input.columns)
    expect(mocks.themes).toHaveBeenCalledExactlyOnceWith({ where: { id: { in: ['theme-a'] } }, select: { id: true, name: true } })
    expect(mocks.categories).toHaveBeenCalledExactlyOnceWith('EBAY', 'IT', ['123'])
    expect(output.meta.referenceNames).toEqual({ channel: 'EBAY', market: 'IT', lookups: [
      { field: 'descriptionThemeId', ids: ['theme-a'], labels: { 'theme-a': 'Archived example' } },
      { field: 'categoryId', ids: ['123'], labels: { '123': 'Example > Jackets' } },
    ] })
  })
  it('marks a completed empty lookup but never guesses a name for a missing ID', async () => {
    mocks.themes.mockResolvedValue([]); mocks.categories.mockResolvedValue({})
    const output = await withSelectedReferenceNames(sheet())
    expect(output.meta.referenceNames?.lookups).toEqual([
      { field: 'descriptionThemeId', ids: ['theme-a'], labels: {} }, { field: 'categoryId', ids: ['123'], labels: {} },
    ])
  })
  it.each(['themes','categories'] as const)('keeps the other lookup while %s fails and leaves failed coverage absent for client fallback', async failed => {
    mocks[failed].mockRejectedValue(new Error('Optional name source unavailable'))
    const input = sheet()
    const output = await withSelectedReferenceNames(input)
    expect(output.rows).toBe(input.rows)
    expect(output.meta.referenceNames?.lookups.map(lookup => lookup.field)).toEqual(failed === 'themes' ? ['categoryId'] : ['descriptionThemeId'])
  })
  it('does no query for empty or fixed No theme values', async () => {
    const input = sheet()
    input.rows = [{ values: { categoryId: { value: '' }, descriptionThemeId: { value: 'none' }, paymentPolicyId: { value: 'policy-a' } } }]
    const output = await withSelectedReferenceNames(input)
    expect(output).toBe(input)
    expect(mocks.themes).not.toHaveBeenCalled()
    expect(mocks.categories).not.toHaveBeenCalled()
  })
  it('W3-4: a Shopify product category is named from the synced taxonomy (no Shopify call); a value that is not a category id is not read', async () => {
    const jacket = 'gid://shopify/TaxonomyCategory/aa-1-10-2'
    const input = { scope: { channel: 'SHOPIFY' }, schema: { marketplace: 'GLOBAL' }, columns: [{ key: 'category' }],
      rows: [{ values: { category: { value: jacket } } }, { values: { category: { value: jacket } } }, { values: { category: { value: 'not a category' } } }], meta: {} }
    const output = await withSelectedReferenceNames(input)
    expect(mocks.taxonomy).toHaveBeenCalledExactlyOnceWith('SHOPIFY', 'GLOBAL', [jacket])
    expect(output.rows).toBe(input.rows)
    expect(output.meta.referenceNames).toEqual({ channel: 'SHOPIFY', market: 'GLOBAL', lookups: [
      { field: 'category', ids: [jacket], labels: { [jacket]: 'Apparel & Accessories > Clothing > Outerwear > Coats & Jackets' } },
    ] })
    // Another channel's `category` is not a Shopify taxonomy id.
    mocks.taxonomy.mockClear()
    expect(await withSelectedReferenceNames({ ...input, scope: { channel: 'EBAY' } })).toMatchObject({ meta: {} })
    expect(mocks.taxonomy).not.toHaveBeenCalled()
  })
})
