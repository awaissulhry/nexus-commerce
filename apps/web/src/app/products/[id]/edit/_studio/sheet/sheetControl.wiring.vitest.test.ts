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
})
