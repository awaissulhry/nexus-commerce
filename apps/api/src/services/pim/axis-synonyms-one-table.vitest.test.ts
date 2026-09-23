/**
 * Step 2.6c-3 (A-27, R-23) — ONE synonym table for a variation axis, on the product side and the eBay side.
 *
 * Before: `canonicalVariantAxis` (product side) kept its own short list, and the eBay side kept
 * `AXIS_SYNONYM_GROUPS`. They disagreed — `talla` / `groesse` were a size to the product side only; `size name`,
 * `color name`, `misura`, `kleur`, `maat`, … to the eBay side only — so one child's axis could be two axes.
 *
 * The eBay push stores `__dimN__` keys by GROUP POSITION, so the table is append-only. Measured on production
 * (2026-09-23, `tools/axis-stores.mjs`): stored keys `__dim0__` / `__dim1__` only; axis names in use Colore,
 * Taglia, Color, Size (+ `Style Name` in the bags) — the two spellings appended to the size group re-key nothing.
 */
import { describe, expect, it } from 'vitest'
import { AXIS_SYNONYM_GROUPS as SHARED, canonicalVariantAxis } from './variant-attribute-keys.js'
import { AXIS_SYNONYM_GROUPS as EBAY, axisSynonymKey } from '../ebay-theme-axes.js'

/** The eBay table as it stood before Step 2.6c-3. Stored `__dimN__` keys depend on these positions. */
const EBAY_BEFORE = [
  ['colore', 'color', 'colour', 'color name', 'color_name', 'couleur', 'farbe', 'kleur', 'colour name', 'colori'],
  ['taglia', 'size', 'size name', 'size_name', 'misura', 'größe', 'grosse', 'taille', 'maat', 'maten', 'koko'],
  ['stile', 'style', 'style name', 'style_name'],
  ['materiale', 'material', 'material name', 'material_name'],
  ['genere', 'gender', 'department', 'target audience', 'target_audience'],
]
/** Every spelling the product side recognised before Step 2.6c-3 — it must still recognise each. */
const PRODUCT_BEFORE: Record<string, string> = {
  Colore: 'color', Colour: 'color', Farbe: 'color', Couleur: 'color', Color: 'color',
  Taglia: 'size', Taille: 'size', Talla: 'size', Größe: 'size', Groesse: 'size', Size: 'size',
  'Style Name': 'style', Style: 'style',
}
const NAMES = ['color', 'size', 'style']

describe('one synonym table', () => {
  it('the eBay side uses the shared object itself, not a copy', () => {
    expect(EBAY).toBe(SHARED)
  })
  it('append-only: every group keeps its position, and its old entries stay its prefix', () => {
    expect(SHARED.length).toBeGreaterThanOrEqual(EBAY_BEFORE.length)
    EBAY_BEFORE.forEach((group, i) => expect(SHARED[i]!.slice(0, group.length)).toEqual(group))
  })
  it('stored order keys do not move: every spelling the eBay table knew keeps its __dimN__', () => {
    EBAY_BEFORE.forEach((group, i) => { for (const spelling of group) expect(axisSynonymKey(spelling)).toBe(`__dim${i}__`) })
  })
  it('the two sides agree on every spelling of the three product axes, in any case', () => {
    NAMES.forEach((name, i) => {
      // Case variants that lowercase back to the spelling (`größe` → `GRÖSSE` → `grösse` does not: ß has no capital).
      for (const spelling of SHARED[i]!) for (const variant of [spelling, spelling.toUpperCase(), spelling[0]!.toUpperCase() + spelling.slice(1)].filter((v) => v.toLowerCase() === spelling)) {
        expect([variant, canonicalVariantAxis(variant)]).toEqual([variant, name])
        expect([variant, axisSynonymKey(variant)]).toEqual([variant, `__dim${i}__`])
      }
    })
  })
  it('the product side still recognises every spelling it did before', () => {
    for (const [spelling, name] of Object.entries(PRODUCT_BEFORE)) expect([spelling, canonicalVariantAxis(spelling)]).toEqual([spelling, name])
  })
  it('control: the eBay-only aspect groups (material, gender) do not become product axes', () => {
    expect(canonicalVariantAxis('Materiale')).toBe('materiale')
    expect(canonicalVariantAxis('Genere')).toBe('genere')
    expect(canonicalVariantAxis('Fit Type')).toBe('fittype')
  })
})
