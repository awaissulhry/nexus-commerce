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
// The design system's root (packages/ui/src). The app half of these guards (the sheets that compose the tooltip and
// mount the save shapes) reads app files, so it lives with those sheets:
// apps/web/src/app/products/[id]/edit/_studio/sheet/cellTooltipWiring.vitest.test.ts
const ds = join(__dirname, '..', '..')
const read = (rel: string) => {
  const src = readFileSync(join(ds, rel), 'utf8')
  // A guard that cannot find its subject says NOT MEASURED, never "clean".
  if (!src.trim()) throw new Error(`${rel} is empty — the guard has nothing to check`)
  return src
}

describe('the cell has ONE tooltip', () => {
  it('🔴 LongTextCell claims no `title` — a renderer that sets one gives the cell a rival tooltip', () => {
    const src = read('grid/renderers/cells.tsx')
    const start = src.indexOf('export const LongTextCell')
    expect(start, 'LongTextCell is gone — the guard cannot check it').toBeGreaterThan(-1)
    const body = src.slice(start, start + 1400)
    expect(body).toContain('nds-cell-longtext')
    expect(body).not.toMatch(/title=\{/)
  })

  it('🔴 the tooltip preserves the paragraph break the composer writes', () => {
    /*
     * Found on the screen, not in the source. `composeCellTooltip` joins with a blank line, AG's
     * tooltip element collapses whitespace by default, and the two facts arrived as ONE run of
     * text: "…edit to give this row its own value 9 of 700 characters (Amazon · IT)". The composer
     * was correct and the separation was invisible — deleting this rule makes it invisible again
     * with every unit test still green.
     */
    const css = read('grid/theme/grid.css')
    const rule = css.match(/\.ag-tooltip\.ag-cell-tooltip\s*\{[^}]*\}/)
    expect(rule, 'no cell-tooltip rule in grid.css — the paragraph break has nothing preserving it').toBeTruthy()
    expect(rule![0]).toMatch(/white-space:\s*pre-line/)
  })

  it('CellSaveReason uses the DS clip utility, not display:none', () => {
    // `display:none` and `visibility:hidden` remove the node from the accessibility tree, which
    // would leave this component doing nothing while looking like it worked.
    const src = read('grid/renderers/cells.tsx')
    const start = src.indexOf('export function CellSaveReason')
    expect(start, 'CellSaveReason is gone').toBeGreaterThan(-1)
    const body = src.slice(start, start + 300)
    expect(body).toContain('nds-vh')
    expect(body).not.toMatch(/display:\s*'?none/)
  })
})
