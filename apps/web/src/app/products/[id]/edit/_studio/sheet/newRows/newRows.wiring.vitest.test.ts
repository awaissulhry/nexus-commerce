/**
 * Add rows — both scope adapters wire the empty rows the same way (a source read: the hooks cannot run node-only; the
 * rules are tested in `newRows.vitest.test.ts` and `useNewRows.create.vitest.test.ts`). A sheet that loses one of these
 * lines loses a guarantee silently: an empty row in a selection, a Status pill on it, a paste spilling into real rows.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8')
const channel = read('channel', 'useChannelSheetAdapter.tsx')
const master = read('master', 'useMasterSheetAdapter.tsx')

describe.each([['channel', channel], ['master', master]])('%s sheet', (_scope, src) => {
  it('keeps the empty rows in the page and offers them in the footer\'s start slot', () => {
    expect(src).toMatch(/const newRows = useNewRows\(\{ kinds: (SHARED|CHANNEL)_ROW_KINDS, registerScopeChangeGuard/)
    expect(src).toContain('footerStart: <NewRowsControl {...newRows.control}/>')
  })
  it('gives the grid to the rows, so "Add rows" focuses the first new SKU cell', () => {
    expect(src).toMatch(/useNewRows\(\{ kinds: (SHARED|CHANNEL)_ROW_KINDS, registerScopeChangeGuard[^\n]*say: toast, getGridApi,/)
  })
  it('gives an empty row only "Remove this row" in its cell menu (right-click, Shift+F10, the menu key)', () => {
    expect(src).toMatch(/const menuWithNewRows = useMemo\(\(\) => newRowsContextMenu\(newRows\.store, (stableContextMenu|contextMenu)\)/)
    expect(src).toContain('getContextMenuItems: menuWithNewRows,')
  })
  it('hands an empty row\'s typed SKU from the ONE first-column editor (S11) to the row\'s store', () => {
    expect(src).toMatch(/onCreate: \(row, sku\) => \{ newRows\.store\.type\(row\.(id|rowId), sku\); \}/)
  })
  it('adds the empty rows after the rows on screen, locks and blanks their other cells, marks the row and draws its own cell', () => {
    expect(src).toMatch(/const gridRows = useMemo\(\(\) => withNewRows</)
    expect(src).toMatch(/rowData: (loading \? \[\] : )?gridRows,/)
    expect(src).toContain('lockedOnNewRows([')
    expect(src).toContain('[UNSAVED_ROW_CLASS]: (p: { data?: ')
    expect(src).toContain('<NewRowCell row={fresh}')
    expect(src).toContain("unsavedOf(p.data) ? 'nds-ag-cell nds-cell-full-strength' : 'nds-ag-cell'")
  })
  it('answers an empty row\'s keys and paste first, says why a locked cell is locked, and drops the rows on Reload', () => {
    expect(src).toContain('if (newRowsGridKey(newRows.store, event as never)) return;')
    expect(src).toContain('processDataFromClipboard: pasteIntoNewRows,')
    expect(src).toContain('const fresh = newRowRefusal(key, row);')
    expect(src).toContain('newRows.store.clear();')
    expect(src).toMatch(/useEffect\(\(\) => newRows\.store\.landed\(new Set\(/)
  })
})

describe('the channel sheet', () => {
  it('has one way in for a new listing: the ⋯ "+ Add listing alias" item is gone', () => {
    expect(channel).not.toContain("id: 'add-alias'")
    expect(channel).not.toContain('onAddAlias')
    expect(channel).not.toContain('addListingAlias')
  })
  it('shows every listing once a batch created one while a single listing was shown', () => {
    expect(channel).toContain("if (kinds.has('alias')) { invalidatePublishActions(productId); if (selectedAlias !== null) setListing(undefined) }")
  })
})
