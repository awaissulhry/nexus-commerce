/**
 * Unit tests for VariationValueOrderModal pure logic.
 * Tests live in variationValueOrder.pure.ts (extracted so vitest can import
 * without loading the JSX component and its path-alias deps).
 *
 * Run: npx vitest run apps/web/src/app/products/ebay-flat-file/VariationValueOrderModal.vitest.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  axisSynonymKey,
  deriveAxes,
  sortClothing,
  shouldInitModal,
  type AxisDetectRow,
} from './variationValueOrder.pure'

// ── helpers ───────────────────────────────────────────────────────────────

let _rid = 0
function vRow(aspects: Record<string, string>, extra: Partial<AxisDetectRow> = {}): AxisDetectRow {
  const id = `r${++_rid}`
  return {
    _isParent: false,
    ...Object.fromEntries(
      Object.entries(aspects).map(([k, v]) => [`aspect_${k}`, v]),
    ),
    ...extra,
    _rowId: id,
  }
}

// ── axisSynonymKey ────────────────────────────────────────────────────────

describe('axisSynonymKey', () => {
  it('maps known color aliases to __dim0__', () => {
    expect(axisSynonymKey('Colore')).toBe('__dim0__')
    expect(axisSynonymKey('color')).toBe('__dim0__')
    expect(axisSynonymKey('Color Name')).toBe('__dim0__')
    expect(axisSynonymKey('COLOR')).toBe('__dim0__')
  })

  it('maps known size aliases to __dim1__', () => {
    expect(axisSynonymKey('Taglia')).toBe('__dim1__')
    expect(axisSynonymKey('size')).toBe('__dim1__')
    expect(axisSynonymKey('Size Name')).toBe('__dim1__')
  })

  it('maps material aliases to __dim3__', () => {
    expect(axisSynonymKey('Material')).toBe('__dim3__')
    expect(axisSynonymKey('Materiale')).toBe('__dim3__')
  })

  it('returns lowercase name for unmapped custom axes (stable key)', () => {
    expect(axisSynonymKey('Pattern')).toBe('pattern')
    expect(axisSynonymKey('FIT')).toBe('fit')
    expect(axisSynonymKey('Custom Axis')).toBe('custom axis')
    expect(axisSynonymKey('Weight Class')).toBe('weight class')
  })
})

// ── deriveAxes ────────────────────────────────────────────────────────────

describe('deriveAxes', () => {
  it('(a) detects a 3rd custom axis (Pattern) alongside known color+size', () => {
    const rows: AxisDetectRow[] = [
      vRow({ Colore: 'Rosso',  Taglia: 'S', Pattern: 'Stripes' }),
      vRow({ Colore: 'Rosso',  Taglia: 'M', Pattern: 'Solid' }),
      vRow({ Colore: 'Blu',    Taglia: 'S', Pattern: 'Stripes' }),
      vRow({ Colore: 'Blu',    Taglia: 'M', Pattern: 'Solid' }),
    ]
    const axes = deriveAxes(rows)
    const keys = axes.map((a) => a.key)

    expect(keys).toContain('__dim0__')  // color — known synonym
    expect(keys).toContain('__dim1__')  // size  — known synonym
    expect(keys).toContain('pattern')   // custom — stable lowercase key
    expect(axes).toHaveLength(3)
  })

  it('(b) custom axis uses row-data name as displayName and lowercase as stable key', () => {
    const rows: AxisDetectRow[] = [
      vRow({ Pattern: 'Stripes' }),
      vRow({ Pattern: 'Solid' }),
    ]
    const axis = deriveAxes(rows).find((a) => a.key === 'pattern')

    expect(axis).toBeDefined()
    expect(axis!.displayName).toBe('Pattern')     // human label from data
    expect(axis!.key).toBe('pattern')              // lowercase stable key
    expect(axis!.values).toContain('Stripes')
    expect(axis!.values).toContain('Solid')
  })

  it('(c) N>2 custom axes all detected independently', () => {
    const rows: AxisDetectRow[] = [
      vRow({ Colore: 'Rosso', FIT: 'Regular', Pattern: 'Stripes' }),
      vRow({ Colore: 'Blu',   FIT: 'Slim',    Pattern: 'Solid' }),
    ]
    const axes = deriveAxes(rows)
    const axisOrder = Object.fromEntries(axes.map((a) => [a.key, a.values]))

    // All three axes present — this is what gets sent as axisValueOrder in the PATCH
    expect(axisOrder).toHaveProperty('__dim0__')   // color
    expect(axisOrder).toHaveProperty('fit')         // custom
    expect(axisOrder).toHaveProperty('pattern')     // custom

    expect(axisOrder['fit']).toContain('Regular')
    expect(axisOrder['fit']).toContain('Slim')
    expect(axisOrder['pattern']).toContain('Stripes')
    expect(axisOrder['pattern']).toContain('Solid')
  })

  it('(d) synonym aliases are collapsed into a single axis entry', () => {
    const rows: AxisDetectRow[] = [
      // Row uses Italian name; second row uses English alias
      { _isParent: false, aspect_Colore: 'Rosso', aspect_Taglia: 'S' },
      { _isParent: false, aspect_Color:  'Blu',   aspect_Taglia: 'M' },
    ]
    const axes = deriveAxes(rows)
    const colorEntries = axes.filter((a) => a.key === '__dim0__')

    expect(colorEntries).toHaveLength(1)           // collapsed to one
    expect(colorEntries[0].values).toContain('Rosso')
    expect(colorEntries[0].values).toContain('Blu')
  })

  it('(e) filters out axes with only one distinct value (nothing to order)', () => {
    const rows: AxisDetectRow[] = [
      vRow({ Pattern: 'Stripes', Colore: 'Rosso' }),
      vRow({ Pattern: 'Stripes', Colore: 'Blu' }),
    ]
    const axes = deriveAxes(rows)

    const patternAxis = axes.find((a) => a.key === 'pattern')
    const colorAxis   = axes.find((a) => a.key === '__dim0__')

    expect(patternAxis).toBeUndefined()  // 1 distinct value → silently excluded (correct)
    expect(colorAxis).toBeDefined()      // 2 distinct values → included
  })

  it('(f) P2.B2 parentage=child rows are treated as variants even without _isParent', () => {
    const rows: AxisDetectRow[] = [
      { _isParent: true,  parentage: 'parent', aspect_Colore: undefined },
      // Explicit _isParent=false variant
      { _isParent: false, parentage: 'child',  aspect_Pattern: 'Stripes' },
      // P2.B2 child row where _isParent was never set (common after re-parent operations)
      { parentage: 'child', aspect_Pattern: 'Solid' },
    ]
    const axes = deriveAxes(rows)
    const patternAxis = axes.find((a) => a.key === 'pattern')

    expect(patternAxis).toBeDefined()
    expect(patternAxis!.values).toContain('Stripes')
    expect(patternAxis!.values).toContain('Solid')
  })

  it('(g) returns empty array when no variant rows exist', () => {
    const rows: AxisDetectRow[] = [
      { _isParent: true, aspect_Colore: 'Rosso' },
    ]
    expect(deriveAxes(rows)).toEqual([])
  })

  it('(h) ignores parent row aspect values — only variant rows contribute', () => {
    const rows: AxisDetectRow[] = [
      { _isParent: true,  aspect_Colore: 'Exclusive' },
      vRow({ Colore: 'Rosso' }),
      vRow({ Colore: 'Blu' }),
    ]
    const colorAxis = deriveAxes(rows).find((a) => a.key === '__dim0__')

    expect(colorAxis).toBeDefined()
    expect(colorAxis!.values).not.toContain('Exclusive')   // parent value excluded
    expect(colorAxis!.values).toContain('Rosso')
    expect(colorAxis!.values).toContain('Blu')
  })
})

// ── sortClothing ──────────────────────────────────────────────────────────

describe('sortClothing', () => {
  it('orders alpha sizes small → large', () => {
    expect(sortClothing(['XL', 'S', 'M', 'L', 'XS'])).toEqual(['XS', 'S', 'M', 'L', 'XL'])
  })

  it('falls back to localeCompare for unknown values', () => {
    const result = sortClothing(['Gamma', 'Alpha', 'Beta'])
    expect(result).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('preserves original array (returns new array)', () => {
    const original = ['L', 'S', 'M']
    const sorted = sortClothing(original)
    expect(sorted).not.toBe(original)
    expect(original).toEqual(['L', 'S', 'M'])
  })
})

// ── shouldInitModal (EFX D1 race fix) ─────────────────────────────────────
// The modal must (re)initialize ONLY on the closed→open transition. Parent
// re-renders while open (autosave/toasts/SSE) hand the effect a new `axes`
// identity — that must NOT reset the operator's un-saved reordering.

describe('shouldInitModal', () => {
  it('initializes on the closed→open transition', () => {
    expect(shouldInitModal(true, false)).toBe(true)
  })

  it('does NOT re-initialize on a mid-open re-render (new rows/axes identity)', () => {
    // open cycle started: shouldInitModal(true, false) → true, ref set to true.
    // Parent re-renders while open → effect re-runs with wasOpen=true → no init.
    expect(shouldInitModal(true, true)).toBe(false)
  })

  it('never initializes while closed', () => {
    expect(shouldInitModal(false, false)).toBe(false)
    expect(shouldInitModal(false, true)).toBe(false)
  })

  it('full cycle: open → mid-open re-renders → close → reopen re-initializes', () => {
    let wasOpen = false
    // closed→open: init fires once
    expect(shouldInitModal(true, wasOpen)).toBe(true)
    wasOpen = true
    // N mid-open re-renders: never re-init
    for (let i = 0; i < 5; i++) expect(shouldInitModal(true, wasOpen)).toBe(false)
    // close resets the ref (the component does this on !open)
    wasOpen = false
    expect(shouldInitModal(false, wasOpen)).toBe(false)
    // reopen: fresh init
    expect(shouldInitModal(true, wasOpen)).toBe(true)
  })
})
