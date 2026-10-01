import { describe, expect, it, vi } from 'vitest'
import { informationRegistry } from '@nexus/shared/shopify-information'
import { shopifyGridTransfer } from './shopifyGridTransfer'
import { encodeInformationTransfer } from './informationTransfer'

function fixture(type = 'single_line_text_field', source: string | null = 'four') {
  const definition = { id: 'definition', namespace: 'custom', key: 'label', name: 'Label', ownerType: 'PRODUCT', type,
    required: true, validations: [{ name: 'max', value: '3' }], description: null, access: { admin: null, storefront: null } }
  const field = informationRegistry({ revision: 'synthetic', definitions: [definition], types: [], metaobjectDefinitions: [], locales: [] }).find(f => f.definition)!
  const column = { getColId: () => field.id }, sourceNode = { rowIndex: 0 }, targetNode = { rowIndex: 1 }
  const api = { getAllDisplayedColumns: () => [column], getDisplayedRowAtIndex: () => sourceNode,
    getCellValue: ({ rowNode }: { rowNode: unknown }) => rowNode === sourceNode ? source : 'old' }
  const announce = vi.fn()
  const base = { processCellForClipboard: vi.fn(), processCellFromClipboard: vi.fn(), cellSelection: { handle: { setFillValue: vi.fn() } } }
  const transfer = shopifyGridTransfer(base as never, [{ key: field.id, shopifyField: field }] as never, 'store-a', announce)
  return { field, announce, transfer,
    paste: (value: string) => transfer.processCellFromClipboard({ api, column, node: targetNode, value } as never),
    fill: () => transfer.cellSelection.handle.setFillValue({ api, column, rowNode: targetNode, initialValues: [source], currentIndex: 0, direction: 'down', currentCellValue: 'old' } as never) }
}

describe('Shopify paste and fill use the draft storage rule', () => {
  it('pastes long text unchanged and leaves the publish warning to the cell', () => {
    const s = fixture()
    expect(s.paste('four')).toBe('four')
    expect(s.announce).not.toHaveBeenCalled()
  })
  it('fills long text and a required clear without keeping the old value', () => {
    for (const value of ['four', null]) {
      const s = fixture('single_line_text_field', value)
      expect(s.fill()).toBe(value)
      expect(s.announce).not.toHaveBeenCalled()
    }
  })
  it('does not turn malformed numbers into a draft or replace the destination', () => {
    const s = fixture('number_integer', 'not a number')
    expect(s.paste('not a number')).toBe('old')
    expect(s.fill()).toBe('old')
    expect(s.announce).toHaveBeenCalledWith(expect.stringContaining('whole number'))
  })
  it('keeps the typed account boundary even for a type-valid clear', () => {
    const s = fixture()
    expect(s.paste(encodeInformationTransfer(s.field, null, 'store-b'))).toBe('old')
    expect(s.announce).toHaveBeenCalledWith(expect.stringContaining('another store'))
  })
})
