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
  // W3-6 — the note names the fields (the server's label, else the key in words) and no longer says "switch view":
  // no view of this scope has a column for them.
  it('names the fields with no column here, never their keys', () => {
    const off: DiagnosticRow = { ...row, completeness: { required: { missing: [] } }, readiness: { issues: [
      { key: 'child_parent_sku_relationship__parent_sku', severity: 'error', label: 'Parent SKU' },
      { key: 'child_parent_sku_relationship__child_relationship_type', severity: 'error', label: 'Relationship type' },
      { key: 'name', severity: 'error' },
    ] } }
    const [, invalid] = buildSheetChips([off], columns, undefined, { scope: 'channel' })
    expect(invalid).toMatchObject({ count: { n: 1, unit: 'cells' }, note: '2 more on fields with no column here: Parent SKU, Relationship type.' })
    // No label from the server (or the key itself as the label): the key in words, through the naming table.
    const bare: DiagnosticRow = { ...off, readiness: { issues: [{ key: 'uvp_list_price', severity: 'error', label: 'uvp_list_price' }, { key: 'fabric_type', severity: 'error' }] } }
    expect(buildSheetChips([bare], columns, undefined, { scope: 'channel' })[1].note).toBe('2 more on fields with no column here: Fabric type, List price (UVP).')
  })
})
