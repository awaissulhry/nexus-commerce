/**
 * STEP 2 — unit tests for the variation-family pre-flight validator.
 *
 * One test per FamilyIssue code, with fixtures modelling the REAL families:
 *   • GALE  — two SKUs sharing Colour+Size → DUP_VARIATION
 *   • AIREON — a "Nero"/"nero" axis → VALUE_CASE_COLLISION + a value mismatch
 *   • single-axis collapse → AXIS_COLLAPSED (Custom Bundle fallback)
 *   • bad-checksum EAN → GTIN_INVALID
 *
 * The validator is WARN-NEVER-BLOCK: it only ever RETURNS advisory issues, never
 * throws, never mutates. These tests assert the codes/severities, never a throw.
 */

import { describe, it, expect } from 'vitest'
import {
  validateVariationFamily,
  variantAxisValue,
  type FamilyIssue,
} from './ebay-variation-preflight.js'

// ── fixtures ────────────────────────────────────────────────────────────────

const row = (
  sku: string,
  aspects: Record<string, string>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => {
  const r: Record<string, unknown> = { sku, ...extra }
  for (const [k, v] of Object.entries(aspects)) r[`aspect_${k.replace(/\s+/g, '_')}`] = v
  return r
}

const spec = (name: string, values: string[]) => ({ name, values })

const resolvedFrom = (specs: Array<{ name: string; values: string[] }>) => ({
  validSpecs: specs.map((s) => ({
    name: s.name,
    rawName: s.name,
    values: new Set(s.values),
    coverage: 0,
  })),
})

const has = (issues: FamilyIssue[], code: string) => issues.some((i) => i.code === code)
const get = (issues: FamilyIssue[], code: string) => issues.find((i) => i.code === code)

// ── DUP_VARIATION (GALE) ─────────────────────────────────────────────────────

describe('validateVariationFamily — DUP_VARIATION', () => {
  it('flags two SKUs that resolve to the SAME Colour+Size tuple (GALE FBA+FBM overlap)', () => {
    const specs = [spec('Colore', ['Nero']), spec('Taglia', ['M'])]
    const rows = [
      row('GALE-M-FBA', { Colore: 'Nero', Taglia: 'M' }),
      row('GALE-M-FBM', { Colore: 'Nero', Taglia: 'M' }),
    ]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, {})
    expect(has(issues, 'DUP_VARIATION')).toBe(true)
    const dup = get(issues, 'DUP_VARIATION')!
    expect(dup.severity).toBe('block-soft')
    expect(dup.message).toContain('GALE-M-FBA')
    expect(dup.message).toContain('GALE-M-FBM')
  })

  it('does NOT flag distinct tuples', () => {
    const specs = [spec('Taglia', ['M', 'L'])]
    const rows = [row('A', { Taglia: 'M' }), row('B', { Taglia: 'L' })]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, {})
    expect(has(issues, 'DUP_VARIATION')).toBe(false)
  })

  it('treats a case/whitespace-variant tuple as the SAME variation', () => {
    const specs = [spec('Colore', ['Nero', 'nero'])]
    const rows = [row('A', { Colore: 'Nero' }), row('B', { Colore: 'nero' })]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, {})
    expect(has(issues, 'DUP_VARIATION')).toBe(true)
  })
})

// ── AXIS_COLLAPSED ───────────────────────────────────────────────────────────

describe('validateVariationFamily — AXIS_COLLAPSED', () => {
  it('flags an empty validSpecs (Custom Bundle fallback about to fire)', () => {
    const specs = [spec('Custom Bundle', ['SKU1', 'SKU2'])]
    const rows = [row('SKU1', {}), row('SKU2', {})]
    const issues = validateVariationFamily(rows, { validSpecs: [] }, specs, {})
    expect(has(issues, 'AXIS_COLLAPSED')).toBe(true)
    expect(get(issues, 'AXIS_COLLAPSED')!.severity).toBe('block-soft')
    // Custom Bundle is not a real axis → no per-axis noise.
    expect(has(issues, 'VALUE_ITEM_MISMATCH')).toBe(false)
    expect(has(issues, 'VALUE_CASE_COLLISION')).toBe(false)
  })
})

// ── VALUE_CASE_COLLISION + VALUE_ITEM_MISMATCH (AIREON) ──────────────────────

describe('validateVariationFamily — VALUE_CASE_COLLISION / VALUE_ITEM_MISMATCH', () => {
  it('AIREON: a "Nero"/"nero" axis raises a case collision AND a value mismatch', () => {
    const specs = [spec('Colore', ['Nero', 'nero'])]
    const rows = [
      row('AIREON-1', { Colore: 'Nero' }),
      row('AIREON-2', { Colore: 'Blu' }), // Blu isn't in the axis list → mismatch
    ]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, {})
    expect(has(issues, 'VALUE_CASE_COLLISION')).toBe(true)
    expect(get(issues, 'VALUE_CASE_COLLISION')!.severity).toBe('warn')
    expect(has(issues, 'VALUE_ITEM_MISMATCH')).toBe(true)
    const mm = get(issues, 'VALUE_ITEM_MISMATCH')!
    expect(mm.severity).toBe('block-soft')
    expect(mm.message).toContain('AIREON-2')
    expect(mm.message).toContain('Blu')
  })

  it('no mismatch when every variant value is present in the axis list', () => {
    const specs = [spec('Colore', ['Nero', 'Blu'])]
    const rows = [row('A', { Colore: 'Nero' }), row('B', { Colore: 'Blu' })]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, {})
    expect(has(issues, 'VALUE_ITEM_MISMATCH')).toBe(false)
    expect(has(issues, 'VALUE_CASE_COLLISION')).toBe(false)
  })
})

// ── GTIN_INVALID + GTIN_EXEMPT_ASSUMED ───────────────────────────────────────

describe('validateVariationFamily — GTIN', () => {
  it('GTIN_INVALID: a bad-checksum EAN is flagged with the reason', () => {
    const specs = [spec('Taglia', ['M'])]
    // 4006381333931 is a valid EAN-13; flipping the check digit → invalid.
    const rows = [row('A', { Taglia: 'M' }, { ean: '4006381333930' })]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, {})
    expect(has(issues, 'GTIN_INVALID')).toBe(true)
    const g = get(issues, 'GTIN_INVALID')!
    expect(g.severity).toBe('block-soft')
    expect(g.message).toContain('check digit')
  })

  it('a valid EAN is NOT flagged', () => {
    const specs = [spec('Taglia', ['M'])]
    const rows = [row('A', { Taglia: 'M' }, { ean: '4006381333931' })]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, {})
    expect(has(issues, 'GTIN_INVALID')).toBe(false)
    expect(has(issues, 'GTIN_EXEMPT_ASSUMED')).toBe(false)
  })

  it('GTIN_EXEMPT_ASSUMED: variants with no EAN warn that "Does not apply" will be sent', () => {
    const specs = [spec('Taglia', ['M', 'L'])]
    const rows = [row('A', { Taglia: 'M' }), row('B', { Taglia: 'L' })]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, {})
    expect(has(issues, 'GTIN_EXEMPT_ASSUMED')).toBe(true)
    expect(get(issues, 'GTIN_EXEMPT_ASSUMED')!.severity).toBe('warn')
  })
})

// ── ASPECT_VALUE_LEN ─────────────────────────────────────────────────────────

describe('validateVariationFamily — ASPECT_VALUE_LEN', () => {
  it('flags a value over 65 chars', () => {
    const long = 'x'.repeat(70)
    const specs = [spec('Colore', [long])]
    const rows = [row('A', { Colore: long })]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, {})
    expect(has(issues, 'ASPECT_VALUE_LEN')).toBe(true)
  })

  it('flags an axis name over 40 chars', () => {
    const name = 'A'.repeat(41)
    const specs = [spec(name, ['M'])]
    const rows = [row('A', { [name]: 'M' })]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, {})
    expect(has(issues, 'ASPECT_VALUE_LEN')).toBe(true)
  })
})

// ── VARIATION_OVER_LIMIT ─────────────────────────────────────────────────────

describe('validateVariationFamily — VARIATION_OVER_LIMIT', () => {
  it('flags a family with more than 250 variants', () => {
    const values = Array.from({ length: 251 }, (_, i) => `V${i}`)
    const specs = [spec('Taglia', values)]
    const rows = values.map((v, i) => row(`SKU-${i}`, { Taglia: v }))
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, {})
    expect(has(issues, 'VARIATION_OVER_LIMIT')).toBe(true)
    expect(get(issues, 'VARIATION_OVER_LIMIT')!.severity).toBe('block-soft')
  })
})

// ── MIXED_CONDITION ──────────────────────────────────────────────────────────

describe('validateVariationFamily — MIXED_CONDITION', () => {
  it('flags variants that span more than one condition', () => {
    const specs = [spec('Taglia', ['M', 'L'])]
    const rows = [
      row('A', { Taglia: 'M' }, { condition: 'NEW' }),
      row('B', { Taglia: 'L' }, { condition: 'USED_GOOD' }),
    ]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, {})
    expect(has(issues, 'MIXED_CONDITION')).toBe(true)
    expect(get(issues, 'MIXED_CONDITION')!.severity).toBe('warn')
  })
})

// ── BRAND_DEFAULTED ──────────────────────────────────────────────────────────

describe('validateVariationFamily — BRAND_DEFAULTED', () => {
  it('warns when opts.brandDefaulted is true', () => {
    const specs = [spec('Taglia', ['M'])]
    const rows = [row('A', { Taglia: 'M' })]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, { brandDefaulted: true })
    expect(has(issues, 'BRAND_DEFAULTED')).toBe(true)
  })
  it('is silent when brandDefaulted is false/absent', () => {
    const specs = [spec('Taglia', ['M'])]
    const rows = [row('A', { Taglia: 'M' })]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, {})
    expect(has(issues, 'BRAND_DEFAULTED')).toBe(false)
  })
})

// ── ALL_ZERO ─────────────────────────────────────────────────────────────────

describe('validateVariationFamily — ALL_ZERO', () => {
  it('warns when every safe qty is ≤ 0', () => {
    const specs = [spec('Taglia', ['M', 'L'])]
    const rows = [row('A', { Taglia: 'M' }), row('B', { Taglia: 'L' })]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, { safeQtys: [0, 0] })
    expect(has(issues, 'ALL_ZERO')).toBe(true)
  })
  it('is silent when at least one qty is > 0', () => {
    const specs = [spec('Taglia', ['M', 'L'])]
    const rows = [row('A', { Taglia: 'M' }), row('B', { Taglia: 'L' })]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, { safeQtys: [0, 3] })
    expect(has(issues, 'ALL_ZERO')).toBe(false)
  })
})

// ── AXIS_STRUCTURE_CHANGE ────────────────────────────────────────────────────

describe('validateVariationFamily — AXIS_STRUCTURE_CHANGE', () => {
  it('warns when the current axes differ from the previously-published axes', () => {
    const specs = [spec('Colore', ['Nero'])]
    const rows = [row('A', { Colore: 'Nero' })]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, {
      priorPublishedAxisNames: ['Colore', 'Taglia'],
    })
    expect(has(issues, 'AXIS_STRUCTURE_CHANGE')).toBe(true)
    expect(get(issues, 'AXIS_STRUCTURE_CHANGE')!.message).toContain('end the listing')
  })
  it('warns when a stored 3-axis structure collapses to 2 axes', () => {
    const specs = [spec('Colore', ['Nero']), spec('Taglia', ['M'])]
    const rows = [row('A', { Colore: 'Nero', Taglia: 'M' })]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, {
      priorPublishedAxisNames: ['Tipo di prodotto', 'Colore', 'Taglia'],
    })
    expect(has(issues, 'AXIS_STRUCTURE_CHANGE')).toBe(true)
    expect(get(issues, 'AXIS_STRUCTURE_CHANGE')!.message).toContain('end the listing')
  })
  it('is silent when axes are unchanged', () => {
    const specs = [spec('Colore', ['Nero']), spec('Taglia', ['M'])]
    const rows = [row('A', { Colore: 'Nero', Taglia: 'M' })]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, {
      priorPublishedAxisNames: ['Taglia', 'Colore'], // order-insensitive
    })
    expect(has(issues, 'AXIS_STRUCTURE_CHANGE')).toBe(false)
  })
  it('is SKIPPED when prior axes are not supplied (never fabricated)', () => {
    const specs = [spec('Colore', ['Nero'])]
    const rows = [row('A', { Colore: 'Nero' })]
    const issues = validateVariationFamily(rows, resolvedFrom(specs), specs, {})
    expect(has(issues, 'AXIS_STRUCTURE_CHANGE')).toBe(false)
  })
})

// ── warn-never-block invariant + helper ──────────────────────────────────────

describe('validateVariationFamily — invariants', () => {
  it('never throws, even on empty / malformed input', () => {
    expect(() => validateVariationFamily([], { validSpecs: [] }, [], {})).not.toThrow()
    expect(() => validateVariationFamily([{}], { validSpecs: [] }, [], {})).not.toThrow()
  })

  it('does not mutate the input rows', () => {
    const specs = [spec('Colore', ['Nero'])]
    const rows = [row('A', { Colore: 'Nero' })]
    const snapshot = JSON.parse(JSON.stringify(rows))
    validateVariationFamily(rows, resolvedFrom(specs), specs, {})
    expect(rows).toEqual(snapshot)
  })

  it('variantAxisValue resolves synonyms (Color ≡ Colore)', () => {
    const r = row('A', { Color: 'Nero' })
    expect(variantAxisValue(r, 'Colore')).toBe('Nero')
  })
})
