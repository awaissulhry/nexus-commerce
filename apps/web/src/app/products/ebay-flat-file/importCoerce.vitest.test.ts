/**
 * EI.1 — typed import coercion tests.
 * Run: npx vitest run apps/web/src/app/products/ebay-flat-file/importCoerce.vitest.test.ts
 */
import { describe, it, expect } from 'vitest'
import { coerceEbayImportRows, parseImportNumber, type CoerceColumnMeta } from './importCoerce.pure'

const COLS: CoerceColumnMeta[] = [
  { id: 'sku', kind: 'text' },
  { id: 'title', kind: 'text', maxLength: 80 },
  { id: 'shared_sku_listing', kind: 'boolean' },
  { id: 'it_price', kind: 'number' },
  { id: 'it_buffer', kind: 'number', min: 0 },
  { id: 'condition', kind: 'enum', enumMode: 'strict', options: ['NEW_WITH_TAGS', 'NEW_OTHER'], optionLabels: { NEW_WITH_TAGS: 'New with tags', NEW_OTHER: 'New other' } },
  { id: 'fulfillment_policy_id', kind: 'enum', enumMode: 'strict', options: ['pol-123', 'pol-456'], optionLabels: { 'pol-123': 'Spedizione Standard', 'pol-456': 'Express EU' } },
  { id: 'variation_theme', kind: 'enum', enumMode: 'open', multiValue: true, options: ['Taglia', 'Colore'] },
  { id: 'it_item_id', kind: 'readonly' },
]

describe('parseImportNumber', () => {
  it('handles EU commas, currency symbols, thousands', () => {
    expect(parseImportNumber('105')).toBe(105)
    expect(parseImportNumber('49,90')).toBe(49.9)
    expect(parseImportNumber('49.90')).toBe(49.9)
    expect(parseImportNumber('1.234,56')).toBe(1234.56)
    expect(parseImportNumber('1,299.00')).toBe(1299)
    expect(parseImportNumber('€ 105,00')).toBe(105)
    expect(parseImportNumber('105 EUR')).toBe(105)
    expect(parseImportNumber('abc')).toBeNull()
  })
})

describe('coerceEbayImportRows', () => {
  it('coerces booleans in every spelling; blank stays blank', () => {
    const { rows, issues } = coerceEbayImportRows(
      [
        { shared_sku_listing: 'TRUE' },
        { shared_sku_listing: 'Sì' },
        { shared_sku_listing: 'FALSE' },
        { shared_sku_listing: '' },
        { shared_sku_listing: 'boh' },
      ],
      COLS,
    )
    expect(rows[0].shared_sku_listing).toBe(true)
    expect(rows[1].shared_sku_listing).toBe(true)
    expect(rows[2].shared_sku_listing).toBe(false)
    expect(rows[3].shared_sku_listing).toBe('')
    expect(rows[4].shared_sku_listing).toBe('boh') // raw kept on error
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ rowIndex: 4, columnId: 'shared_sku_listing', level: 'error' })
  })

  it('numbers: EU price parses; garbage errors keep raw; min clamps with warn', () => {
    const { rows, issues } = coerceEbayImportRows(
      [{ it_price: '105,50', it_buffer: '-3' }, { it_price: 'n/a' }],
      COLS,
    )
    expect(rows[0].it_price).toBe(105.5)
    expect(rows[0].it_buffer).toBe(0)
    expect(rows[1].it_price).toBe('n/a')
    expect(issues.map((i) => [i.columnId, i.level])).toEqual([
      ['it_buffer', 'warn'],
      ['it_price', 'error'],
    ])
  })

  it('strict enums canonicalize by option AND label — policy NAMES map to ids', () => {
    const { rows, issues } = coerceEbayImportRows(
      [
        { condition: 'new with tags', fulfillment_policy_id: 'Spedizione Standard' },
        { condition: 'NEW_OTHER', fulfillment_policy_id: 'pol-456' },
        { condition: 'Usato', fulfillment_policy_id: 'Unknown Policy' },
      ],
      COLS,
    )
    expect(rows[0].condition).toBe('NEW_WITH_TAGS')
    expect(rows[0].fulfillment_policy_id).toBe('pol-123')
    expect(rows[1].condition).toBe('NEW_OTHER')
    expect(rows[1].fulfillment_policy_id).toBe('pol-456')
    expect(rows[2].condition).toBe('Usato') // raw kept
    expect(issues.filter((i) => i.level === 'error')).toHaveLength(2)
  })

  it('open multiValue enums canonicalize known parts, keep free text', () => {
    const { rows, issues } = coerceEbayImportRows(
      [{ variation_theme: 'taglia, colore, Materiale' }],
      COLS,
    )
    expect(rows[0].variation_theme).toBe('Taglia,Colore,Materiale')
    expect(issues).toHaveLength(0)
  })

  it('maxLength warns without truncating; junk dropped; readonly untouched', () => {
    const long = 'X'.repeat(95)
    const { rows, issues } = coerceEbayImportRows(
      [{ title: long, sku: '[object Object]', it_item_id: '257584954808' }],
      COLS,
    )
    expect(rows[0].title).toBe(long)
    expect(rows[0].sku).toBe('')
    expect(rows[0].it_item_id).toBe('257584954808')
    expect(issues.map((i) => [i.columnId, i.level])).toEqual([
      ['title', 'warn'],
      ['sku', 'warn'],
    ])
  })

  it('unknown columns and non-string values pass through untouched', () => {
    const { rows, issues } = coerceEbayImportRows(
      [{ _rowId: 'r1', mystery: 'keep', it_price: 42 }],
      COLS,
    )
    expect(rows[0]).toEqual({ _rowId: 'r1', mystery: 'keep', it_price: 42 })
    expect(issues).toHaveLength(0)
  })
})
