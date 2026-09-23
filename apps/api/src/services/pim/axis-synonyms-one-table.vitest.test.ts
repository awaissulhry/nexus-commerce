/**
 * Step 2.6c-3 (A-27, R-23) — the product side reads the SAME synonym table as the eBay side.
 *
 * Before: `canonicalVariantAxis` (product side) kept its own short list, and the eBay side kept
 * `AXIS_SYNONYM_GROUPS`. They disagreed — `size name`, `color name`, `misura`, `kleur`, `maat`, … were an axis to
 * the eBay side only — so one child's axis could be two axes.
 *
 * The table stays in `ebay-theme-axes.ts`, unchanged: the eBay flat-file client mirrors it byte-for-byte (a no-touch
 * area, guarded by its web parity test), and the eBay push stores `__dimN__` keys by group position. Two spellings
 * the product side knew stay product-only (`talla`, `groesse`) until that no-touch copy can change. Production
 * (2026-09-23, `tools/axis-stores.mjs`): stored keys `__dim0__` / `__dim1__`; names in use Colore, Taglia, Color, Size.
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

describe('one synonym table, product side and eBay side', () => {
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
  it('the only disagreement left is named: talla and groesse are sizes to the product side only', () => {
    for (const spelling of ['talla', 'groesse']) {
      expect(canonicalVariantAxis(spelling)).toBe('size')
      expect(axisSynonymKey(spelling)).toBe(spelling)
    }
  })
  it('control: the eBay-only aspect groups (material, gender) do not become product axes', () => {
    expect(canonicalVariantAxis('Materiale')).toBe('materiale')
    expect(canonicalVariantAxis('Genere')).toBe('genere')
    expect(canonicalVariantAxis('Fit Type')).toBe('fittype')
  })
})
