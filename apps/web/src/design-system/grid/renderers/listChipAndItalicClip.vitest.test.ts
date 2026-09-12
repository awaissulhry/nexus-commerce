import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 🔴 Two rendering defects the Owner saw on 2026-09-05, held here so they cannot come back:
 *   1. every list value read "N." — the list chip wore `.nds-cell-chip`, the identity BADGE's class,
 *      whose rule fixes width and height at 20px;
 *   2. "⚠ required" lost the tail of its last letter — italic glyphs paint past their advance width
 *      and the cell's text wrapper clips at the padding box.
 * Text assertions, and they know it: the behaviour was read off the screen (chip 20px against a
 * 104px text; the text's right edge equal to its clip edge) and these hold the shape of the fix.
 */
const web = join(__dirname, '..', '..', '..')
const read = (rel: string) => {
  const src = readFileSync(join(web, rel), 'utf8')
  // A guard that cannot find its subject says NOT MEASURED, never "clean".
  if (!src.trim()) throw new Error(`${rel} is empty — the guard has nothing to check`)
  return src
}

describe('the list value chip never wears the identity badge class', () => {
  it('shapeCells hands TokenChip its own class', () => {
    const src = read('design-system/grid/renderers/shapeCells.tsx')
    expect(src).toMatch(/className="nds-cell-listchip"/)
    expect(src).not.toMatch(/className="nds-cell-chip"/)
  })

  it('grid.css pins no fixed WIDTH on the list token, and never routes the badge rule into a list', () => {
    const css = read('design-system/grid/theme/grid.css').replace(/\/\*[\s\S]*?\*\//g, '')
    const listRule = css.match(/\.nds-cell-list \.nds-token \{[^}]*\}/)?.[0] ?? ''
    expect(listRule, 'no `.nds-cell-list .nds-token` rule — the guard has nothing to check').toBeTruthy()
    // `max-width` is the chip's ceiling and stays; a bare `width:` is the badge's mistake.
    expect(listRule).not.toMatch(/(?<![-\w])width:\s*\d/)
    expect(css).not.toMatch(/\.nds-cell-list[^{]*\.nds-cell-chip/)
  })
})

describe('italic text inside a clipped cell carries an end padding, so the last glyph can paint', () => {
  it('.nds-cell-required and the ai-draft cell text both do', () => {
    const css = read('design-system/grid/theme/grid.css')
    const req = css.match(/\.nds-cell-required \{[^}]*\}/)?.[0] ?? ''
    expect(req, 'no `.nds-cell-required` rule').toBeTruthy()
    expect(req).toMatch(/font-style:\s*italic/)
    expect(req).toMatch(/padding-inline-end:\s*[1-9]/)
    expect(css).toMatch(/\.nds-cell-is-ai-draft \.nds-cell-value-text \{[^}]*padding-inline-end:\s*[1-9]/)
  })

  it('every italic rule in grid.css is one of the padded ones (a NEW italic needs its padding, or an exemption here)', () => {
    const css = read('design-system/grid/theme/grid.css')
    const selectors = [...css.matchAll(/([^{}]+)\{[^}]*font-style:\s*italic[^}]*\}/g)].map((m) => m[1].trim().split('\n').pop()!.trim())
    expect(selectors.length, 'no italic rule found at all — the guard has nothing to check').toBeGreaterThan(0)
    const known = [
      '.nds-cell-required',
      '.nds-ag-wrap .ag-cell.nds-cell-is-ai-draft',
      // a LEADING glyph: an italic overhang paints to the right, into the text, never past the clip
      '.nds-formula-glyph',
    ]
    for (const s of selectors) expect(known, `italic rule "${s}" — pad its clipped text, then list it here`).toContain(s)
  })
})
