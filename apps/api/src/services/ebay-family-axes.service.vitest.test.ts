/**
 * EFX Layer A — unit tests for the shared family-axes helper's pure logic.
 *
 * Covers the DB-independent pieces:
 *   • collectObservedAxisKeys / unionAxisCandidates — the theme-input candidate
 *     union (schema-eligible ∪ observed family keys, synonym-deduped).
 *   • The variant-row → resolveVariationAxes pipeline over an AIREON-shaped
 *     fixture built with the SAME buildFlatRow the push (and this helper via
 *     buildEbayFamilyRows) uses. The fixture mirrors the REAL per-row aspect
 *     data the push sees: Tipo di prodotto CLEAN + present; a clean English
 *     colour key (Color) AND its polluted Italian synonym (Colore); a Size key
 *     AND a larger Taglia synonym; ghost Team Name (fingerprint-dup of Tipo di
 *     prodotto) + single-value Athlete/Body Type Amazon leftovers. We assert the
 *     MECHANISM (declared axes resolved, synonym fold, ghost suppression) — the
 *     helper returns whatever resolveVariationAxes produces, verbatim.
 *
 * The DB-orchestration wrapper resolveFamilyAxes() is exercised end-to-end by
 * the route smokes; here we lock down the pure transforms.
 */

import { describe, it, expect } from 'vitest'
import { buildFlatRow, resolveVariationAxes } from './ebay-variation-push.service.js'
import { parseThemeAxes } from './ebay-theme-axes.js'
import {
  collectObservedAxisKeys,
  unionAxisCandidates,
} from './ebay-family-axes.service.js'

// ── fixtures ────────────────────────────────────────────────────────────────

/** Build one AIREON-shaped child row exactly as buildFlatRow would from DB.
 *  itemSpecifics carry the varying aspects (Tipo di prodotto + BOTH the English
 *  and polluted-Italian colour/size synonyms); categoryAttributes.variations
 *  carry the ghosts (Team Name + single-value Athlete/Body Type leftovers). */
function airoenChild(opts: {
  sku: string
  itemSpecifics: Record<string, string>
  variations: Record<string, string>
}): Record<string, unknown> {
  return buildFlatRow({
    id: opts.sku,
    sku: opts.sku,
    name: opts.sku,
    ean: null,
    parentId: 'AIREON-PARENT',
    isParent: false,
    variationTheme: 'Tipo di prodotto,Color,Size',
    categoryAttributes: { variations: opts.variations },
    variantAttributes: null,
    brand: 'AIREON',
    images: [],
    channelListings: [
      {
        id: `${opts.sku}-L`,
        region: 'IT',
        externalListingId: null,
        title: opts.sku,
        description: '',
        price: null,
        quantity: 1,
        platformAttributes: { itemSpecifics: opts.itemSpecifics, categoryId: '57988' },
        listingStatus: 'ACTIVE',
        offerActive: true,
        syncStatus: 'synced',
        updatedAt: new Date('2026-07-10T00:00:00Z'),
      },
    ],
  } as Parameters<typeof buildFlatRow>[0])
}

const DECLARED = parseThemeAxes('Tipo di prodotto,Color,Size')

/** Sorted value list for a resolved spec by display name. */
const vals = (specs: Array<{ name: string; values: Set<string> }>, name: string) =>
  [...(specs.find((s) => s.name === name)?.values ?? [])].sort()

// ── collectObservedAxisKeys ─────────────────────────────────────────────────

describe('collectObservedAxisKeys', () => {
  it('unions categoryAttributes.variations + variantAttributes + itemSpecifics keys, first-seen casing', () => {
    const keys = collectObservedAxisKeys([
      {
        categoryAttributes: { variations: { 'Team Name': 'Giacca', Colore: 'Crema e Vino' } },
        variantAttributes: { Taglia: 'M' },
        ebayItemSpecifics: { 'Tipo di prodotto': 'Giacca', Marca: 'AIREON' },
      },
    ])
    expect(keys).toEqual(['Team Name', 'Colore', 'Taglia', 'Tipo di prodotto', 'Marca'])
  })

  it('dedupes exact repeats across children (case-insensitive), keeps first casing', () => {
    const keys = collectObservedAxisKeys([
      { categoryAttributes: { variations: { Colore: 'a' } } },
      { ebayItemSpecifics: { colore: 'b', Taglia: 'M' } },
    ])
    expect(keys).toEqual(['Colore', 'Taglia'])
  })

  it('ignores non-object / array sources gracefully', () => {
    expect(
      collectObservedAxisKeys([
        { categoryAttributes: null, variantAttributes: [], ebayItemSpecifics: null },
      ]),
    ).toEqual([])
  })
})

// ── unionAxisCandidates ─────────────────────────────────────────────────────

describe('unionAxisCandidates', () => {
  it('synonym-dedupes schema ∪ observed, schema label (first-seen) wins over an observed synonym', () => {
    const out = unionAxisCandidates(
      ['Colore', 'Taglia'], // schema (variation-eligible)
      ['Color', 'Size', 'Tipo di prodotto', 'Team Name'], // observed on family
    )
    // Color/Colore + Size/Taglia fold; schema casing kept; customs appended.
    expect(out).toEqual(['Colore', 'Taglia', 'Tipo di prodotto', 'Team Name'])
  })

  it('keeps every distinct synonym dimension (widest set for the combobox)', () => {
    expect(unionAxisCandidates([], ['Colore', 'Scollatura', 'Materiale'])).toEqual([
      'Colore',
      'Scollatura',
      'Materiale',
    ])
  })

  it('drops blanks', () => {
    expect(unionAxisCandidates(['  '], ['Colore', ''])).toEqual(['Colore'])
  })
})

// ── AIREON — real per-row shape (mirrors the push's resolveVariationAxes input)
// Tipo di prodotto clean+present; Color(clean) + Colore(polluted) synonyms;
// Size(clean) + Taglia(larger) synonyms; ghost Team Name; Athlete/Body Type
// single-value leftovers. Declared theme = [Tipo di prodotto, Color, Size].

describe('resolveVariationAxes over AIREON (real shape) — declared, synonym-folded, ghost suppressed', () => {
  const rows = [
    airoenChild({
      sku: 'A-CV-G-M',
      itemSpecifics: {
        'Tipo di prodotto': 'Giacca',
        Color: 'Crema e Vino',
        Colore: 'Crema e Vino - Giacca',
        Size: 'M',
        Taglia: 'M',
      },
      variations: { 'Team Name': 'Giacca', Athlete: 'Uomo', 'Body Type': 'Uomo' },
    }),
    airoenChild({
      sku: 'A-NN-G-L',
      itemSpecifics: {
        'Tipo di prodotto': 'Giacca',
        Color: 'Nero Neo',
        Colore: 'Nero Neo - Giacca',
        Size: 'L',
        Taglia: 'XXL',
      },
      variations: { 'Team Name': 'Giacca', Athlete: 'Uomo', 'Body Type': 'Uomo' },
    }),
    airoenChild({
      sku: 'A-CV-P-M',
      itemSpecifics: {
        'Tipo di prodotto': 'Pantaloni',
        Color: 'Crema e Vino',
        Colore: 'Crema e Vino - Pantaloni',
        Size: 'M',
        Taglia: 'M',
      },
      variations: { 'Team Name': 'Pantaloni', Athlete: 'Uomo', 'Body Type': 'Uomo' },
    }),
    airoenChild({
      sku: 'A-NN-P-L',
      itemSpecifics: {
        'Tipo di prodotto': 'Pantaloni',
        Color: 'Nero Neo',
        Colore: 'Nero Neo - Pantaloni',
        Size: 'L',
        Taglia: '4XL',
      },
      variations: { 'Team Name': 'Pantaloni', Athlete: 'Uomo', 'Body Type': 'Uomo' },
    }),
  ]

  const resolved = resolveVariationAxes(rows, DECLARED, {})

  it('returns exactly the 3 declared axes, in declared order (English synonym is first-seen name)', () => {
    expect(resolved.validSpecs.map((s) => s.name)).toEqual(['Tipo di prodotto', 'Color', 'Size'])
  })

  it('Tipo di prodotto carries its clean 2 values', () => {
    expect(vals(resolved.validSpecs, 'Tipo di prodotto')).toEqual(['Giacca', 'Pantaloni'])
  })

  it('suppresses the ghost "Team Name" (fingerprint == Tipo di prodotto)', () => {
    expect(resolved.suppressed).toContain('Team Name')
    // suppressed ghost never appears as an axis
    expect(resolved.validSpecs.map((s) => s.name)).not.toContain('Team Name')
  })

  it('folds the polluted Italian colour synonym into the Color axis (clean + polluted merged)', () => {
    const colorVals = vals(resolved.validSpecs, 'Color')
    expect(colorVals).toContain('Crema e Vino') // clean English
    expect(colorVals).toContain('Crema e Vino - Giacca') // polluted Italian synonym, folded in
  })

  it('folds the larger Italian size synonym into the Size axis', () => {
    const sizeVals = vals(resolved.validSpecs, 'Size')
    expect(sizeVals).toContain('M') // clean
    expect(sizeVals).toContain('4XL') // from the Taglia synonym
  })

  it('excludes single-value Amazon leftovers (Athlete / Body Type) entirely — no axis, no warning', () => {
    const names = resolved.validSpecs.map((s) => s.name)
    expect(names).not.toContain('Athlete')
    expect(names).not.toContain('Body Type')
    expect(resolved.warnings.join(' ')).not.toMatch(/Athlete|Body Type/)
  })

  it('no fabricated "missing axis" warning — every declared axis resolved', () => {
    expect(resolved.warnings).toEqual([])
  })
})
