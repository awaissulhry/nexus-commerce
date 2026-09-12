import { describe, expect, it } from 'vitest'
import { marketplaceReferenceLabels, mergeReferenceLabels, nameReferenceColumns, parseReferenceOrScalarValue, referenceColumnDef, referenceSearchText, referenceTooltip } from './referenceLabels'

describe('information grid reference names', () => {
  it('keeps cached names when another lookup returns no name', () => {
    expect(mergeReferenceLabels({ categoryId: { '123': 'Jackets' } }, { categoryId: { '123': '', '456': 'Boots' } }))
      .toEqual({ categoryId: { '123': 'Jackets', '456': 'Boots' } })
  })
  it('displays and filters names while preserving stored IDs and allowed values', () => {
    const options = ['123', '456']
    const original = { key: 'categoryId', kind: 'text', options }
    const [column] = nameReferenceColumns([original], { categoryId: { '123': 'Jackets', '456': 'Boots' } })
    const row = { value: '123' }
    const def = referenceColumnDef(column, (r: typeof row) => r.value)
    expect(def.valueFormatter!({ value: row.value })).toBe('Jackets')
    expect(def.filterValueGetter!({ data: row })).toBe('Jackets')
    expect(def.comparator!('123', '456')).toBeGreaterThan(0)
    expect(def.comparator!(null, '123', undefined, undefined, false)).toBeGreaterThan(0)
    // AG negates the descending result; blanks must still land last.
    expect(-def.comparator!(null, '123', undefined, undefined, true)).toBeGreaterThan(0)
    expect(def.valueParser!({ newValue: 'Jackets' })).toBe('123')
    expect(def.valueParser!({ newValue: '123' })).toBe('123')
    expect(row.value).toBe('123')
    expect(column.options).toBe(options)
    expect(original).not.toHaveProperty('optionLabels')
    expect(referenceTooltip('123', column.optionLabels)).toBe('Jackets\nID: 123')
  })

  it('does not substitute another name for an unknown ID or blank value', () => {
    const [column] = nameReferenceColumns([{ key: 'returnPolicyId', kind: 'text' }], { returnPolicyId: { '123': '30-day returns' } })
    const def = referenceColumnDef(column, () => null)
    expect(def.valueFormatter!({ value: '999' })).toBe('999')
    expect(def.valueFormatter!({ value: null })).toBe('')
    expect(def.valueFormatter!({ value: '' })).toBe('')
    expect(referenceTooltip('999', column.optionLabels)).toBeUndefined()
  })

  it('keeps ambiguous names from selecting an arbitrary ID when pasted', () => {
    const [column] = nameReferenceColumns([{ key: 'descriptionThemeId', kind: 'text' }], { descriptionThemeId: { a: 'Classic', b: 'Classic' } })
    expect(referenceColumnDef(column, () => null).valueParser!({ newValue: 'Classic' })).toBe('Classic')
  })

  it('sends even unique reference names to the server so stale display metadata cannot select an ID', () => {
    const [column] = nameReferenceColumns([{ key: 'descriptionThemeId', kind: 'text' }], { descriptionThemeId: { 'stale-id': 'Modern' } })
    expect(referenceColumnDef(column, () => null).valueParser!({ newValue: 'Modern' })).toBe('Modern')
    expect(referenceColumnDef(column, () => null).valueParser!({ newValue: 'stale-id' })).toBe('stale-id')
  })

  it('also bypasses cached labels in closed selects and before labels have loaded', () => {
    const column = { key: 'merchant_shipping_group', kind: 'select', options: ['stale-id'], optionLabels: { 'stale-id': 'Standard' } }
    expect(referenceColumnDef(column, () => null).valueParser!({ newValue: 'Standard' })).toBe('Standard')
    expect(parseReferenceOrScalarValue(column, 'Standard')).toBe('Standard')
    expect(referenceColumnDef({ key: 'paymentPolicyId', kind: 'text' }, () => null).valueParser!({ newValue: 'Policy name' })).toBe('Policy name')
    expect(parseReferenceOrScalarValue(column, '')).toBeNull()
    expect(parseReferenceOrScalarValue({ key: 'quantity', kind: 'number' }, '3')).toBe(3)
  })

  it('finds both scalar and list references by name, while retaining ID search', () => {
    const labels = { '123': 'Jackets', '456': 'Boots' }
    expect(referenceSearchText('123', labels)).toContain('jackets')
    expect(referenceSearchText('123', labels)).toContain('123')
    expect(referenceSearchText(['123', '456'], labels)).toContain('jackets boots')
    expect(referenceSearchText(null, labels)).toBe('')
  })

  it('names fulfillment codes, themes and machine enum labels without changing content', () => {
    const columns = nameReferenceColumns([
      { key: 'fulfillmentChannel', kind: 'text' },
      { key: 'descriptionThemeId', kind: 'text' },
      { key: 'variation_theme', kind: 'select', options: ['COLOR_NAME/SIZE_NAME'] },
      { key: 'description', kind: 'text' },
    ], { descriptionThemeId: { theme: 'Xavia Racing' } })
    expect(columns[0].optionLabels?.DEFAULT).toBe('Fulfilled by merchant (FBM)')
    expect(columns[1].optionLabels).toEqual({ none: 'No theme', theme: 'Xavia Racing' })
    expect(columns[2].optionLabels?.['COLOR_NAME/SIZE_NAME']).toBe('Color name / Size name')
    expect(columns[3].optionLabels).toBeUndefined()
  })

  it('leaves list, measure and boolean formatting to their existing renderers', () => {
    for (const column of [{ kind: 'select', shape: 'list' }, { kind: 'number', shape: 'measure' }, { kind: 'boolean' }]) {
      expect(referenceColumnDef({ key: 'field', optionLabels: { a: 'A' }, ...column }, () => null)).toEqual({})
    }
  })

  it('keeps standard fulfillment labels and variation-axis codes in English', () => {
    const columns = nameReferenceColumns([
      { key: 'fulfillment_channel_code', kind: 'select', options: ['DEFAULT', 'AFN'], optionLabels: { DEFAULT: 'Gestito dal venditore' } },
      { key: 'variation_theme', kind: 'select', options: ['COLOR_NAME/SIZE_NAME'], optionLabels: { 'COLOR_NAME/SIZE_NAME': 'COLORE_NOME/FORMATO_NOME' } },
    ], { fulfillment_channel_code: { DEFAULT: 'Local override' } })
    expect(columns[0].optionLabels?.DEFAULT).toBe('Fulfilled by merchant (FBM)')
    expect(columns[1].optionLabels?.['COLOR_NAME/SIZE_NAME']).toBe('Color name / Size name')
    expect(columns[1].options).toEqual(['COLOR_NAME/SIZE_NAME'])
  })

  it('resolves database IDs, provider IDs, and country aliases within the selected channel', () => {
    const markets = [
      { id: 'amazon-it', channel: 'AMAZON', code: 'IT', marketplaceId: 'APJ6JRA9NG5V4', name: 'Amazon Italy' },
      { id: 'ebay-uk', channel: 'EBAY', code: 'UK', marketplaceId: 'EBAY_GB', name: 'eBay UK' },
    ]
    expect(marketplaceReferenceLabels(markets, 'AMAZON')).toEqual({ 'amazon-it': 'Amazon Italy', APJ6JRA9NG5V4: 'Amazon Italy', IT: 'Italy' })
    expect(marketplaceReferenceLabels(markets, 'EBAY')).toEqual({ 'ebay-uk': 'eBay UK', EBAY_GB: 'eBay UK', UK: 'United Kingdom', GB: 'United Kingdom' })
    expect(marketplaceReferenceLabels(markets, 'MASTER')).toHaveProperty('amazon-it', 'Amazon Italy')
    expect(marketplaceReferenceLabels([...markets, { ...markets[0], name: 'Conflicting name' }], 'AMAZON')).toEqual({ IT: 'Italy' })
    expect(marketplaceReferenceLabels(null, 'AMAZON')).toEqual({})
  })
})
