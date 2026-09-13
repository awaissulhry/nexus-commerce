/**
 * VT.4 — the `Variation mapping` catalogue filter, against FIXTURE `ReadinessIndex` rows.
 *
 * 🔴 Why fixture rows and not the live index: VT.1 emits the three variation readiness kinds with the SHEET
 * payload, not into `ReadinessIndex` — producing them there is VT.1b, after LX.F frees
 * `readiness-index.service.ts`. So these rows are shaped by the contract (`docs/vt1-contracts.md` §4 items
 * inside `ReadinessIndex.missing`, plus the `variationSource` field VT.1b must add) and every one of them is
 * a row the index WILL carry. The one thing a fixture cannot prove is that the producer writes this shape —
 * that arm is named in the ledger, not claimed here (`reference_a_fixture_pins_a_dimension`).
 *
 * The rows below are the MEASURED coordinates of `VX-TEST-3AX` and `GALE-JACKET` on the local Docker DB.
 */
import { describe, expect, it } from 'vitest'

import {
  VARIATION_MAPPING_LABELS,
  VARIATION_MAPPING_VALUES,
  bulkApplyRequest,
  countVariationMapping,
  familyFooterCounts,
  familyFooterSentence,
  matchesVariationMapping,
  parseVariationMappingFilter,
  planBulkApply,
  serialiseVariationMappingFilter,
  toRequestParameter,
  variationMappingOf,
  type ReadinessScopeEntry,
  type VariationIndexRow,
} from './variationMappingFilter'

const row = (over: Partial<VariationIndexRow> & { productId: string }): VariationIndexRow => ({
  coordinateKey: '["AMAZON","IT",null,null]',
  channel: 'AMAZON',
  market: 'IT',
  label: 'Amazon · IT',
  missing: [],
  ...over,
})

describe('VT.4 — the five values are §5’s, and nothing else', () => {
  it('offers exactly derived · rule · overridden · unset · collides', () => {
    expect(VARIATION_MAPPING_VALUES).toEqual(['derived', 'rule', 'overridden', 'unset', 'collides'])
    // Appendix C's words survive where §5 has a value for them.
    expect(VARIATION_MAPPING_LABELS.rule).toBe('Follows rule')
    expect(VARIATION_MAPPING_LABELS.overridden).toBe('Overridden')
    expect(VARIATION_MAPPING_LABELS.collides).toBe('Collisions')
    expect(VARIATION_MAPPING_LABELS.unset).toBe('Theme unset')
    // Every value has a label — a filter option with no word is an option nobody can choose on purpose.
    for (const value of VARIATION_MAPPING_VALUES) expect(VARIATION_MAPPING_LABELS[value]).toBeTruthy()
  })
})

describe('VT.4 — the URL round trip VT.3’s [List] link writes', () => {
  it('reads design §3.7’s spelling', () => {
    expect(parseVariationMappingFilter('variation-mapping:derived|rule|overridden')).toEqual({
      values: ['derived', 'rule', 'overridden'], unknown: [],
      /* R-VT-11 added `raw` — every token the URL carried, so the page hands the ARBITER the words it was
         given instead of dropping the ones it cannot draw a chip for. With nothing unknown it equals
         `values`, which is what makes the field safe to always send. */
      raw: ['derived', 'rule', 'overridden'],
    })
  })

  it('ignores other filter terms in the same parameter, and keeps their order out of ours', () => {
    expect(parseVariationMappingFilter('stock:low,variation-mapping:collides|unset,brand:Xavia').values)
      .toEqual(['unset', 'collides'])
  })

  it('DROPS an unknown value and REPORTS it — a filter the page cannot honour must not look applied', () => {
    const parsed = parseVariationMappingFilter('variation-mapping:derived|missing|theme-unset')
    expect(parsed.values).toEqual(['derived'])
    // `missing` and `theme-unset` are the VX §11.4 spellings §5 replaced. Named, not silently accepted.
    expect(parsed.unknown).toEqual(['missing', 'theme-unset'])
  })

  it('serialises in §5’s order so one state is one URL', () => {
    expect(serialiseVariationMappingFilter(['collides', 'derived'])).toBe('variation-mapping:derived|collides')
    expect(serialiseVariationMappingFilter(['derived', 'collides'])).toBe('variation-mapping:derived|collides')
    expect(serialiseVariationMappingFilter([])).toBeNull()
  })

  it('round-trips', () => {
    const url = serialiseVariationMappingFilter(['rule', 'unset'])!
    expect(parseVariationMappingFilter(url).values).toEqual(['rule', 'unset'])
  })

  it('answers nothing for nothing, without inventing a default', () => {
    expect(parseVariationMappingFilter(null).values).toEqual([])
    expect(parseVariationMappingFilter('').values).toEqual([])
    expect(parseVariationMappingFilter('stock:low').values).toEqual([])
  })
})

describe('VT.4 — one coordinate’s value, from the index contract', () => {
  it('reads the three provenance tiers from `variationSource`', () => {
    expect(variationMappingOf(row({ productId: 'p1', variationSource: 'derived' }))).toBe('derived')
    expect(variationMappingOf(row({ productId: 'p1', variationSource: 'rule' }))).toBe('rule')
    expect(variationMappingOf(row({ productId: 'p1', variationSource: 'override' }))).toBe('overridden')
  })

  it('🔴 returns null — NOT `derived` — when the index carries no provenance at all', () => {
    // This is today's index. A default of `derived` here would have told an operator that every coordinate
    // in the catalogue follows the derivation, on no evidence whatsoever.
    expect(variationMappingOf(row({ productId: 'p1' }))).toBeNull()
  })

  it('lets a COLLISION outrank provenance, because the filter exists to find work', () => {
    const r = row({
      productId: 'p1',
      variationSource: 'override',
      missing: [{ kind: 'collision', message: '4 variants cannot be told apart on Amazon · IT after Fit Type is dropped.', subjects: ['VX-TEST-3AX-1', 'VX-TEST-3AX-2'], severity: 'error' }],
    })
    expect(variationMappingOf(r)).toBe('collides')
  })

  it('lets `theme-unset` outrank provenance, and maps a bare `none` onto it', () => {
    expect(variationMappingOf(row({ productId: 'p1', variationSource: 'derived', missing: [{ kind: 'theme-unset' }] }))).toBe('unset')
    expect(variationMappingOf(row({ productId: 'p1', variationSource: 'none' }))).toBe('unset')
  })

  it('does NOT give `attribute-unbound` a value of its own', () => {
    // It is a WARNING (contracts §4): the push goes out with the axis missing. A value for it would hide
    // the provenance of every coordinate carrying one.
    const r = row({ productId: 'p1', variationSource: 'derived', missing: [{ kind: 'attribute-unbound', subjects: ['size'], severity: 'warning' }] })
    expect(variationMappingOf(r)).toBe('derived')
  })
})

describe('VT.4 — counts and narrowing on the measured fixture coordinates', () => {
  /** VX-TEST-3AX on its two coordinates, and GALE-JACKET on four — as measured 2026-09-13. */
  const rows: VariationIndexRow[] = [
    row({ productId: 'vx', label: 'Amazon · IT', variationSource: 'none', missing: [{ kind: 'theme-unset' }] }),
    row({ productId: 'vx', channel: 'SHOPIFY', market: 'GLOBAL', label: 'Shopify · GLOBAL', variationSource: 'derived', missing: [{ kind: 'collision' }] }),
    row({ productId: 'gale', label: 'Amazon · IT', variationSource: 'derived' }),
    row({ productId: 'gale', market: 'DE', label: 'Amazon · DE', variationSource: 'derived' }),
    row({ productId: 'gale', channel: 'EBAY', market: 'IT', label: 'eBay · IT', variationSource: 'override' }),
    // The honest gap: a coordinate the index has not classified.
    row({ productId: 'gale', channel: 'EBAY', market: 'DE', label: 'eBay · DE' }),
  ]

  it('counts each value, names the unclassified, and gives products their own unit', () => {
    const counts = countVariationMapping(rows)
    expect(counts.byValue).toEqual({ derived: 2, rule: 0, overridden: 1, unset: 1, collides: 1 })
    // 🔴 `unknown` is a number, not a remainder: 5 classified + 1 unclassified = 6 rows, 2 products.
    expect(counts.unknown).toBe(1)
    expect(counts.rows).toBe(6)
    expect(counts.products).toBe(2)
    expect(Object.values(counts.byValue).reduce((a, b) => a + b, 0) + counts.unknown).toBe(counts.rows)
  })

  it('narrows to the selected values and never matches an unclassified row', () => {
    expect(rows.filter((r) => matchesVariationMapping(r, ['collides'])).map((r) => r.label)).toEqual(['Shopify · GLOBAL'])
    expect(rows.filter((r) => matchesVariationMapping(r, ['derived', 'overridden'])).map((r) => r.label))
      .toEqual(['Amazon · IT', 'Amazon · DE', 'eBay · IT'])
    // An empty selection is "no filter", not "match nothing".
    expect(rows.filter((r) => matchesVariationMapping(r, [])).length).toBe(6)
    // The unclassified eBay · DE row matches NO value — it cannot be found under a word it has not earned.
    for (const value of VARIATION_MAPPING_VALUES) {
      expect(rows.filter((r) => matchesVariationMapping(r, [value])).some((r) => r.label === 'eBay · DE')).toBe(false)
    }
  })
})

describe('VT.4 — the `Apply mapping rule…` bulk verb', () => {
  const candidate = (over: Partial<Parameters<typeof planBulkApply>[0][number]> & { productId: string; sku: string }) => ({
    coordinates: [],
    ...over,
  })
  const coord = (over: Partial<{ channel: string; market: string; accountId: string | null; aliasKey: string; label: string; expectedVersion: number; source: 'derived' | 'rule' | 'override' | 'none'; unresolvedCollisions: number }> = {}) => ({
    channel: 'AMAZON', market: 'IT', accountId: 'acc1', aliasKey: '', label: 'Amazon · IT',
    expectedVersion: 3, source: 'override' as const, unresolvedCollisions: 0, ...over,
  })

  it('clears only OVERRIDES, and counts families and overrides as different units', () => {
    const plan = planBulkApply([
      candidate({ productId: 'a', sku: 'A', coordinates: [coord(), coord({ market: 'DE', label: 'Amazon · DE', expectedVersion: 13 })] }),
      candidate({ productId: 'b', sku: 'B', coordinates: [coord({ source: 'derived' })] }),
    ])
    // 1 family, 2 overrides — the two numbers a summary must not conflate.
    expect(plan.counts).toEqual({ families: 1, overridesRemoved: 2, newCollisions: 0, skippedFamilies: 0 })
    expect(plan.apply.map((e) => e.coordinate.label)).toEqual(['Amazon · IT', 'Amazon · DE'])
    expect(plan.summary).toBe('1 family · 2 overrides removed · 0 new collisions')
  })

  it('🔴 LISTS a family with an unresolved collision instead of touching it (VX §11.4)', () => {
    const plan = planBulkApply([
      candidate({ productId: 'a', sku: 'A', coordinates: [coord({ unresolvedCollisions: 4, label: 'Shopify · GLOBAL' })] }),
      candidate({ productId: 'b', sku: 'B', coordinates: [coord()] }),
    ])
    expect(plan.apply.map((e) => e.sku)).toEqual(['B'])
    expect(plan.skipped).toEqual([{
      productId: 'a', sku: 'A', coordinate: 'Shopify · GLOBAL',
      reason: '4 variants cannot be told apart on Shopify · GLOBAL. Resolve the collision before applying the rule.',
    }])
    expect(plan.counts.skippedFamilies).toBe(1)
    expect(plan.summary).toContain('1 listed instead — it collides')
  })

  it('sends ONE request per coordinate, CAS on that coordinate’s own version, through the existing PATCH', () => {
    const plan = planBulkApply([candidate({
      productId: 'p1', sku: 'A',
      coordinates: [coord({ channel: 'EBAY', market: 'IT', label: 'eBay · IT', expectedVersion: 18, aliasKey: '2' })],
    })])
    expect(bulkApplyRequest(plan.apply[0])).toEqual({
      method: 'PATCH',
      path: '/api/products/p1/studio/projection',
      query: { channel: 'EBAY', market: 'IT', accountId: 'acc1', aliasKey: '2' },
      body: { expectedVersion: 18, reset: true },
    })
  })

  it('plans nothing from nothing', () => {
    const plan = planBulkApply([])
    expect(plan.apply).toEqual([])
    expect(plan.counts).toEqual({ families: 0, overridesRemoved: 0, newCollisions: 0, skippedFamilies: 0 })
  })
})

describe('VT.4b — ONE translation from the URL form to the wire form', () => {
  it('turns the URL term into `?variationMapping=` with the same words', () => {
    const parsed = parseVariationMappingFilter('variation-mapping:derived|collides')
    expect(toRequestParameter(parsed.values)).toBe('derived|collides')
  })

  it('normalises to §5’s order, so one selection is one request (and one cache key)', () => {
    expect(toRequestParameter(['collides', 'derived'])).toBe('derived|collides')
    expect(toRequestParameter(['derived', 'collides'])).toBe('derived|collides')
  })

  it('is null for an inactive filter — the request must then carry no parameter at all', () => {
    // `''` would be an ACTIVE filter matching nothing on the server side; `null` is "do not send it".
    expect(toRequestParameter([])).toBeNull()
  })

  it('produces exactly what the server predicate parses', () => {
    // `restrictVariationMapping` splits on /[|,]/ and lower-cases; these are the five words verbatim.
    expect(toRequestParameter([...VARIATION_MAPPING_VALUES])).toBe('derived|rule|overridden|unset|collides')
  })
})

describe('VT.4b — the family footer’s counts, from the readiness index', () => {
  /** VX-TEST-3AX's real matrix distribution, measured 2026-09-13: 26 derived · 7 none(+theme-unset) · 1 NULL. */
  const scope = (over: Partial<ReadinessScopeEntry> & { label: string }): ReadinessScopeEntry =>
    ({ coordinateKey: over.label, missing: [], ...over })
  const MATRIX: ReadinessScopeEntry[] = [
    ...Array.from({ length: 26 }, (_, i) => scope({ label: `d${i}`, variationSource: 'derived' })),
    ...Array.from({ length: 7 }, (_, i) => scope({ label: `n${i}`, variationSource: 'none', missing: [{ kind: 'theme-unset' }] })),
    scope({ label: 'WooCommerce · GLOBAL', variationSource: null }),
  ]

  it('counts COORDINATES and names the not-computed ones, adding up to the whole matrix', () => {
    const counts = familyFooterCounts(MATRIX)
    expect(counts.byValue).toEqual({ derived: 26, rule: 0, overridden: 0, unset: 7, collides: 0 })
    expect(counts.notComputed).toBe(1)
    expect(counts.rows).toBe(34)
    expect(Object.values(counts.byValue).reduce((a, b) => a + b, 0) + counts.notComputed).toBe(counts.rows)
    expect(counts.labelsByValue.derived).toHaveLength(26)
  })

  it('says `Not computed` and NEVER `0 collides` for a family nothing has classified', () => {
    const none = familyFooterCounts([scope({ label: 'x' }), scope({ label: 'y', state: 'notComputed' })])
    expect(none.notComputed).toBe(2)
    expect(familyFooterSentence(none)).toBe('Not computed')
    // 🔴 the whole point: no zero for a value nobody measured.
    for (const value of VARIATION_MAPPING_VALUES) {
      expect(familyFooterSentence(none)).not.toContain(VARIATION_MAPPING_LABELS[value].toLowerCase())
    }
    expect(familyFooterSentence(none)).not.toContain('0')
  })

  it('counts R-LX-9’s `notComputed` STATE and a null provenance the same way, and only once', () => {
    // A coordinate with no index rows at all, and a row that exists but carries no provenance, are two
    // different facts with one instruction; neither may be double-counted.
    const mixed = familyFooterCounts([
      scope({ label: 'no rows', state: 'notComputed' }),
      scope({ label: 'rows, no provenance', variationSource: null }),
      scope({ label: 'stamped', variationSource: 'overridden' }),
    ])
    expect(mixed).toMatchObject({ notComputed: 2, rows: 3 })
    expect(mixed.byValue.overridden).toBe(1)
  })

  it('lets a collision outrank provenance in the footer too, and prints the label', () => {
    const counts = familyFooterCounts([
      scope({ label: 'Amazon · IT', variationSource: 'overridden', missing: [{ kind: 'collision' }] }),
      scope({ label: 'eBay · IT', variationSource: 'derived' }),
    ])
    expect(counts.byValue).toMatchObject({ collides: 1, derived: 1, overridden: 0 })
    expect(counts.labelsByValue.collides).toEqual(['Amazon · IT'])
    expect(familyFooterSentence(counts)).toBe('1 derived · 1 collisions')
  })

  it('reads VT.1b’s spelling (`overridden`) and the older `override` alike, inventing neither', () => {
    expect(variationMappingOf({ productId: 'p', coordinateKey: 'k', channel: null, market: null, missing: [], variationSource: 'overridden' })).toBe('overridden')
    expect(variationMappingOf({ productId: 'p', coordinateKey: 'k', channel: null, market: null, missing: [], variationSource: 'override' })).toBe('overridden')
  })
})

/* ── R-VT-11 · an unknown word NARROWS, at both layers (VT.F item A12) ────────────────────────────
 *
 * The ruling, on VT.4b's ASSUMED: "an unknown filter word narrows to 0 rows WITH the banner naming it, at
 * the URL layer too — a filter that widens is a lie."
 *
 * Before this, `?filter=variation-mapping:teleport` gave `values: []`, so the page sent no parameter and the
 * grid answered all 31 rows under a banner. `GET ?variationMapping=teleport` answered 0. `raw` is what makes
 * the two agree: the page hands the arbiter the words it was given.
 */
describe('R-VT-11 · the URL layer hands the raw words to the one arbiter', () => {
  it('an unknown word survives into `raw`, so the request carries it and the server narrows', () => {
    const parsed = parseVariationMappingFilter('variation-mapping:teleport')
    expect(parsed.values).toEqual([])
    expect(parsed.unknown).toEqual(['teleport'])
    expect(parsed.raw).toEqual(['teleport'])
    /* 🔴 The arm that matters: `raw` is NON-EMPTY where `values` is empty. A request built from `values`
       sends nothing and the grid widens to every row. */
    expect(parsed.raw.length).toBeGreaterThan(0)
  })

  it('known and unknown words ride together, known ones first in §5 order', () => {
    const parsed = parseVariationMappingFilter('variation-mapping:teleport|collides|derived')
    expect(parsed.values).toEqual(['derived', 'collides'])
    expect(parsed.unknown).toEqual(['teleport'])
    expect(parsed.raw).toEqual(['derived', 'collides', 'teleport'])
  })

  it('no filter term at all is still NOT a filter — `raw` empty, so nothing narrows', () => {
    for (const raw of [undefined, null, '', 'tag:red', 'variation-mapping:']) {
      expect(parseVariationMappingFilter(raw as string).raw).toEqual([])
    }
  })

  it('`raw` keeps a stable identity for the same selection written in any order', () => {
    expect(parseVariationMappingFilter('variation-mapping:collides|derived').raw)
      .toEqual(parseVariationMappingFilter('variation-mapping:derived|collides').raw)
  })

  it('and the words `raw` carries are exactly what the request parameter must spell', () => {
    /* The server splits on `[|,]`, so the page joining `raw` with `|` round-trips. This is the assertion that
       the two spellings (URL `variation-mapping:`, wire `variationMapping=`) still differ only in their key. */
    const parsed = parseVariationMappingFilter('variation-mapping:derived|teleport')
    expect(parsed.raw.join('|')).toBe('derived|teleport')
  })
})
