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
  it('B17 — an editor’s Clear goes through the Delete question before any write', () => {
    expect(src).toMatch(/if \(control\.interceptClear\(\{ row: e\.data, colId[^\n]*\)\)\s*return;/)
    expect(src.indexOf('control.interceptClear(')).toBeLessThan(src.indexOf('undo.record({'))
  })
  it('puts the reset first in the cell menu and answers the keys before undo and the grid', () => {
    expect(src).toMatch(/control\.cellMenuItems|cellMenuRef\.current = control\.cellMenuItems/)
    expect(src).toContain('if (control.onKeyDown(event as never)) return;')
    expect(src).toContain('{control.element}')
  })
})

/** Audit A08 — a reset leaves as one undo step: through the undo's `operation`, recording each cell (`resetChanges`). */
describe('useSheetControl — a reset is an undo step', () => {
  const src = read('useSheetControl.tsx')
  it('writes its resets inside `operation`, recording them', () => {
    const at = src.indexOf('const reset = useCallback(')
    const body = src.slice(at, src.indexOf('}, [])', at))
    expect(body).toMatch(/operation\(record => \{/)
    expect(body).toMatch(/record\(change\)/)
    expect(body).not.toMatch(/writer\.beginOperation\(\)/)
  })
})

/** Audit A05 — both value setters remember the cell they replace, so the undo can tell an inherited value from an own one. */
describe('the value setters remember the cell they replace', () => {
  it.each([['master', read('master', 'columns.tsx')], ['channel', read('channel', 'savedCellPatch.ts')]])('%s', (_scope, src) => {
    expect(src).toMatch(/rememberPriorCell\(next, previous\)/)
  })
})
