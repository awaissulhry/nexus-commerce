import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P1 — the full-control verbs are ONE hook both sheets use (`useSheetControl`), wired the same way: the cell menu, the
 * column header verbs (via `decorate`), the Delete / menu keys, and the dialogs. A sheet that loses one of these loses a
 * verb silently, so the wiring itself is asserted (the rules are tested in `sheetReset.vitest.test.ts`).
 */
const read = (...p: string[]) => readFileSync(join(__dirname, ...p), 'utf8')
describe.each([['channel', read('channel', 'useChannelSheetAdapter.tsx')], ['master', read('master', 'useMasterSheetAdapter.tsx')]])('%s sheet', (_scope, src) => {
  it('builds the control and gives its columns the header verbs', () => {
    expect(src).toContain('useSheetControl<')
    expect(src).toMatch(/control\.decorate\(buildSheetColumns\(/)
  })
  it('puts the reset first in the cell menu and answers the keys before undo and the grid', () => {
    expect(src).toMatch(/control\.cellMenuItems|cellMenuRef\.current = control\.cellMenuItems/)
    expect(src).toContain('if (control.onKeyDown(event as never)) return;')
    expect(src).toContain('{control.element}')
  })
  it('draws the control’s dialogs with the preferences, never in the footer — the footer unmounts while the sheet reloads', () => {
    // `ProductSheetSurface`: the footer renders only when not loading; an open Cell details window there vanished on a
    // reload and came back. Both scopes now place it in `beforePreferences`.
    const at = src.indexOf('{control.element}')
    const before = src.indexOf('beforePreferences: <>')
    const after = src.indexOf('afterPreferences:')
    expect(before).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(before)
    if (after > before) expect(at).toBeLessThan(after)
    expect(/footerBefore: (null|<>[\s\S]*?<\/>), footer/.exec(src)?.[1] ?? '').not.toContain('control.element')
  })
})

/**
 * 2026-10-04 (shared Cell details) — ONE window, menu item and ⋯ item, owned by the control; a scope passes `details`
 * and places `control.cellDetails.overflowItem` in its ⋯ list. The channel scope keeps its words (`channelCellDetails`,
 * golden-tested) and draws no window of its own any more.
 */
describe('Cell details belongs to the control', () => {
  it('the control draws the window inside its element and adds the item after the resets', () => {
    const control = read('useSheetControl.tsx')
    expect(control).toContain('<CellDetailsDialog content={detailsShown?.content ?? null}')
    expect(control).toContain('return [...resets(), ...explain]')
  })
  it('the channel scope describes its cells, places the ⋯ item where its own was, and says the hint as a hint', () => {
    const channel = read('channel', 'useChannelSheetAdapter.tsx')
    expect(channel).toMatch(/details: \{\s*explains: colId => !!data\?\.columns\.some\(column => column\.key === colId\),\s*describe:/)
    expect(channel).toContain('channelCellDetails(row, column, {')
    expect(channel).toContain('items.unshift(control.cellDetails.overflowItem);')
    expect(channel).toContain("say: (message, tone = 'danger') => toast(message, tone),")
    // No window, menu item or ⋯ item of its own.
    expect(channel).not.toContain('Cell details…')
    expect(channel).not.toContain('cs-cell-details')
    expect(channel).not.toContain('openCellDetails')
  })
  it('the Shared scope describes its cells, places the ⋯ item before Formula history, and says the hint as a hint', () => {
    const shared = read('master', 'useMasterSheetAdapter.tsx')
    expect(shared).toContain('sharedCellDetailsSource(colId => columnByKeyRef.current.get(colId), () => detailsLive.current)')
    expect(shared).toMatch(/useSheetControl<StudioRow>\(\{[\s\S]*?\n\s*details,\n[\s\S]*?\}\);/)
    expect(shared).toContain("say: (message, tone = 'danger') => toast(message, tone),")
    expect(shared).toContain("control.cellDetails.overflowItem, { id: 'formula-history',")
    // The right-click menu reads the control's cell items on EVERY column (Cell details shows where no reset does).
    expect(shared).toMatch(/const stableContextMenu = useCallback[\s\S]*?const own = cellMenuRef\.current\(p\);/)
    expect(shared).toContain('cellMenuRef.current = control.cellMenuItems;')
    // The window's one action is the cell menu's own reset writer.
    expect(shared).toContain('reset: targets => { void control.reset(targets); },')
    expect(shared).not.toContain('Cell details…')
  })
})

/**
 * Wave 2 E14 — paste with a header row is ONE module both scopes wire the same way: its clipboard processor on the grid
 * and its `suppressPaste` in the grid's default column, so a column the header does not name is skipped, never
 * rewritten. The DS processor that writes the current value back is no longer used by either sheet.
 */
describe.each([['channel', read('channel', 'useChannelSheetAdapter.tsx')], ['master', read('master', 'useMasterSheetAdapter.tsx')]])('%s sheet — paste with a header row', (_scope, src) => {
  it('uses the shared header paste, its processor and its default column', () => {
    expect(src).toContain("import { useHeaderPaste } from '../headerPaste';")
    expect(src).toMatch(/const headerPaste = useHeaderPaste<\w+>\(/)
    // Add rows — the grid's paste is the header-aware one, behind the empty rows' own (a paste on an empty row's SKU).
    expect(src).toContain('newRowsPaste(newRows.store, headerPaste.processDataFromClipboard)')
    expect(src).toContain('processDataFromClipboard: pasteIntoNewRows,')
    expect(src).toMatch(/defaultColDef: headerPaste\.defaultColDef,|\.\.\.headerPaste\.defaultColDef/)
    expect(src).not.toContain('sheetPasteProcessor')
  })
})
