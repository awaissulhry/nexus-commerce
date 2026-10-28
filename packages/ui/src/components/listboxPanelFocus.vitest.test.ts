/**
 * P2 (2026-09-30) — a short list takes the keyboard BEFORE it is painted.
 *
 * Measured in the product sheet's browser suite (`tests/sheet-select-keys.spec.ts`, 2 to 3 failures in 8 runs on a
 * busy page): Enter opened a list, the list was visible, the next key (↓) was pressed — and it reached the grid cell,
 * because the list focused itself in a passive effect that ran after the paint. Tab then committed nothing. The search
 * field's `autoFocus` was never affected (React focuses it in the commit); the container's focus now runs in the same
 * phase, a layout effect. apps/web tests have no DOM, so the rule is read from the component.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('ListboxPanel focus', () => {
  it('a list without a search field focuses itself before paint', () => {
    const src = readFileSync(join(__dirname, 'ListboxPanel.tsx'), 'utf8')
    const at = src.indexOf('if (autoFocus && !ownsSearch) hostRef.current?.focus()')
    expect(at).toBeGreaterThan(0)
    const hook = src.slice(0, at).match(/use(Layout)?Effect\(\(\) => \{\s*$/)
    expect(hook?.[0]).toMatch(/^useLayoutEffect/)
  })
})
