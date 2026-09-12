import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 🔴 Wiring guards for the cell's ONE tooltip (#662).
 *
 * `composeCellTooltip` being correct proves nothing about whether anything CALLS it, and the defect
 * was never in the composing — it was two homes and an early return. These hold the shape.
 *
 * Text assertions, and they know it: the behaviour is read off the screen with a hover, which is
 * the acceptance the hub set after I reported an absence that a DOM walk had manufactured.
 */
const web = join(__dirname, '..', '..', '..')
const read = (rel: string) => {
  const src = readFileSync(join(web, rel), 'utf8')
  // A guard that cannot find its subject says NOT MEASURED, never "clean".
  if (!src.trim()) throw new Error(`${rel} is empty — the guard has nothing to check`)
  return src
}

const SHEETS = [
  'app/products/[id]/edit/_studio/sheet/master/columns.tsx',
  'app/products/_sheet/MasterSheet.tsx',
  'app/design/grid-lab/GdsSheetScenario.tsx',
]

describe('the cell has ONE tooltip', () => {
  it('🔴 LongTextCell claims no `title` — a renderer that sets one gives the cell a rival tooltip', () => {
    const src = read('design-system/grid/renderers/cells.tsx')
    const start = src.indexOf('export const LongTextCell')
    expect(start, 'LongTextCell is gone — the guard cannot check it').toBeGreaterThan(-1)
    const body = src.slice(start, start + 1400)
    expect(body).toContain('nds-cell-longtext')
    expect(body).not.toMatch(/title=\{/)
  })

  it.each(SHEETS)('%s composes rather than returning the reason alone', (rel) => {
    const src = read(rel)
    expect(src).toContain('composeCellTooltip(')
    // The early return, in every spelling the three sheets used before #662.
    expect(src).not.toMatch(/if \(e(ntry)?\?\.reason\) return e(ntry)?\.reason/)
  })

  it('every sheet that renders LongTextCell also contributes its line', () => {
    // Otherwise removing the renderer's `title` silently deletes the length figures from that
    // sheet — the producer/consumer split, in the direction that fails quietly.
    for (const rel of SHEETS) {
      const src = read(rel)
      if (!src.includes('LongTextCell')) continue
      expect(src, `${rel} renders LongTextCell but contributes no tooltip line`).toContain('longTextTooltipLine(')
    }
  })

  it('🔴 the reason is also TEXT in the studio cell, for anything that cannot hover', () => {
    const src = read('app/products/[id]/edit/_studio/sheet/master/columns.tsx')
    expect(src).toContain('<CellSaveReason reason={tracker.get(')
  })

  it('🔴 the tooltip preserves the paragraph break the composer writes', () => {
    /*
     * Found on the screen, not in the source. `composeCellTooltip` joins with a blank line, AG's
     * tooltip element collapses whitespace by default, and the two facts arrived as ONE run of
     * text: "…edit to give this row its own value 9 of 700 characters (Amazon · IT)". The composer
     * was correct and the separation was invisible — deleting this rule makes it invisible again
     * with every unit test still green.
     */
    const css = read('design-system/grid/theme/grid.css')
    const rule = css.match(/\.ag-tooltip\.ag-cell-tooltip\s*\{[^}]*\}/)
    expect(rule, 'no cell-tooltip rule in grid.css — the paragraph break has nothing preserving it').toBeTruthy()
    expect(rule![0]).toMatch(/white-space:\s*pre-line/)
  })

  it('CellSaveReason uses the DS clip utility, not display:none', () => {
    // `display:none` and `visibility:hidden` remove the node from the accessibility tree, which
    // would leave this component doing nothing while looking like it worked.
    const src = read('design-system/grid/renderers/cells.tsx')
    const start = src.indexOf('export function CellSaveReason')
    expect(start, 'CellSaveReason is gone').toBeGreaterThan(-1)
    const body = src.slice(start, start + 300)
    expect(body).toContain('nds-vh')
    expect(body).not.toMatch(/display:\s*'?none/)
  })
})
