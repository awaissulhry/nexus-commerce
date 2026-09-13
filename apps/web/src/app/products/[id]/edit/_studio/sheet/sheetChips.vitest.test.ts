import { describe, expect, it } from 'vitest'
import { buildSheetChips, type DiagnosticRow } from './sheetChips'
const columns = [{ key: 'name' }, { key: 'brand' }, { key: 'price' }]
const row: DiagnosticRow = {
  id: 'product', parentId: null, values: {},
  completeness: { required: { missing: [{ key: 'name' }, { key: 'name' }] } },
  readiness: { issues: [
    { key: 'name', severity: 'error' }, { key: 'brand', severity: 'warn' },
    { key: 'brand', severity: 'warn' }, { key: 'price', severity: 'error' },
  ] },
}
describe('shared chip producer preserves each scope contract', () => {
  it.each(['master', 'channel'] as const)('counts distinct reachable cells in %s', scope => {
    const chips = buildSheetChips([row], columns, undefined, { scope })
    expect(chips.map(chip => [chip.id, chip.count, chip.cells.byRow])).toEqual([
      ['missing-required', { n: 1, unit: 'cells' }, { product: ['name'] }],
      ['validation-errors', { n: 1, unit: 'cells' }, { product: ['price'] }],
      ['warnings', { n: 1, unit: 'cells' }, { product: ['brand'] }],
    ])
  })
  it('preserves Shared product wording and zero visibility metadata', () => {
    const chips = buildSheetChips([{ ...row, readiness: null }], columns, undefined, { scope: 'master' })
    expect(chips[0].hideWhenZero).toBeUndefined()
    expect(chips[1]).toMatchObject({ count: { n: 0, unit: 'cells' }, hideWhenZero: true })
    expect(chips[2]).toMatchObject({ count: { n: 0, unit: 'cells' }, note: 'A value the channel would accept but flag — the same rule the channel scopes count' })
  })
  it('preserves uncounted channel readiness and the existing channel URL chip ID', () => {
    const chips = buildSheetChips([{ ...row, readiness: null }], columns, null, { scope: 'channel', warningsId: 'channel-warnings', mapping: true })
    expect(chips[0]).toMatchObject({ count: { n: 1, unit: 'cells' }, hideWhenZero: true })
    expect(chips[1].count).toBeNull()
    expect(chips[2]).toMatchObject({ id: 'channel-warnings', count: null })
    expect(chips[3]).toMatchObject({ id: 'mapping-errors', count: null })
  })
  it('keeps chips from separate listing aliases on distinct row keys', () => {
    const chips = buildSheetChips([{ ...row, rowId: 'one:product' }, { ...row, rowId: 'two:product' }], columns)
    expect(chips[0]).toMatchObject({ count: { n: 2, unit: 'cells' }, cells: { byRow: { 'one:product': ['name'], 'two:product': ['name'] } } })
  })
})
