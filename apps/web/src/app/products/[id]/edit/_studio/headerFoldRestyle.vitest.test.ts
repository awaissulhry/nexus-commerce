import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The header fold must restyle the header, not the grid (2026-10-01). Scrolling a 40-row family down from the top,
 * the only slow frames (p95 20.2 ms against 16.7) were the ones where the header folds 48 → 32 or opens again.
 * Measured in the browser, each fold restyled the whole grid twice: once for the `collapsed` class on the studio
 * frame (~3,450 elements, ~7 ms) and once for the sheet's re-stamped `--nds-grid-sheet-top`, which every grid element
 * inherited (~3,350 elements, 7.4 ms). With the class on the bands and the property not inherited, the same scroll
 * measured p95 10.2–10.6 ms, as fast as with no fold at all. These are the three places that hold it.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('the header fold restyles the header, not the grid', () => {
  it('the fold class goes on the bands, which hold the header and not the tab body', () => {
    const frame = read('./StudioFrame.tsx')
    expect(frame).toMatch(/useHeaderCollapse\(frameRef, bandsRef, styles\.collapsed\)/)
    const bands = frame.indexOf('<div ref={bandsRef} className={styles.bands}>')
    expect(bands).toBeGreaterThan(-1)
    expect(frame.indexOf('<StudioTabHost', bands)).toBeGreaterThan(frame.indexOf('</div>', bands))
    const hook = read('./useHeaderCollapse.ts')
    expect(hook).toMatch(/bandsRef\.current\?\.classList\.toggle\(collapsedClass, next\)/)
    expect(hook).not.toMatch(/frameRef\.current\?\.classList/)
  })

  it('every collapsed rule is scoped to the bands', () => {
    const css = read('./studio.module.css')
    const selectors = [...css.matchAll(/^\s*([^{}/]*\.collapsed[^{}]*)\{/gm)].map((m) => m[1].trim())
    expect(selectors.length).toBe(4)
    for (const selector of selectors) for (const part of selector.split(',')) expect(part.trim()).toMatch(/^\.bands\.collapsed /)
  })

  it('the sheet top is a non-inherited property, in the web and Factory copies alike', () => {
    for (const path of ['../../../../../design-system/grid/theme/grid.css', '../../../../../../../factory/src/design-system/grid/theme/grid.css']) {
      expect(read(path)).toMatch(/@property --nds-grid-sheet-top \{ syntax: '<length>'; inherits: false; initial-value: 0px; \}/)
    }
  })
})
