/**
 * VT.3 — the Variations group's copy and derivations, asserted.
 *
 * `apps/web`'s vitest is NODE-ONLY (`reference_test_scoping_and_hidden_assertions`), so nothing here
 * renders React. What it CAN pin is the thing a screenshot cannot: that every sentence is the
 * design's own wording, that no count is invented, and that the two controls which change more than
 * themselves (the theme listbox, the axis order grip) change exactly what the design says.
 *
 * Every fixture is the one the page ships (`variations-fixtures.ts`), so a fixture that drifts from
 * the canvas fails here rather than on screen.
 */

import { describe, expect, it } from 'vitest'

import {
  CANVAS_AMAZON_DE_OUTERWEAR, MEASURED_AMAZON_DE_OUTERWEAR, RULE_AMAZON_IT_AUTO_ACCESSORY,
  SHOPIFY_DROPPED_AND_COLLIDING, AMAZON_DE_OUTERWEAR_THEMES, VARIATION_FIXTURES,
} from './variations-fixtures'
import { VARIATION_MAPPING_VALUES, isVariationMappingValue } from '../../../products/next/variationMappingFilter'
import {
  RESOLVER_COPY, RESOLVER_ORDER, SPLIT_COPY, VARIATIONS_COPY, applyAxisOrder, applyTheme,
  axisOrderIsThemeDriven, blastRadiusSentence, buildVariationWrite, derivationSentence, droppedText,
  headerCounts, includedAxes, isDirty, resolverAvailability, ruleLineText, themeHintText,
  themeOptionLabel, valueMapText, variationMappingListHref, writeRuleLabel,
  VARIATION_MAPPING_LIST_VALUES,
} from './variations'

describe('Variations group copy — verbatim from the design’s Appendix A / VX Appendix C', () => {
  it('prints the no-rule sentence exactly, with the wire’s follow count', () => {
    expect(ruleLineText(CANVAS_AMAZON_DE_OUTERWEAR)).toBe('No rule — 38 families follow the derived theme')
    expect(ruleLineText(MEASURED_AMAZON_DE_OUTERWEAR)).toBe('No rule — 7 families follow the derived theme')
  })

  it('prints the rule’s own label through the Appendix A frame and never invents one', () => {
    expect(ruleLineText(RULE_AMAZON_IT_AUTO_ACCESSORY)).toBe('Follows rule Accessories default')
    expect(ruleLineText({ ...RULE_AMAZON_IT_AUTO_ACCESSORY, ruleLabel: null })).toBe('Follows rule')
  })

  it('names the category in the write-a-rule action', () => {
    expect(writeRuleLabel(CANVAS_AMAZON_DE_OUTERWEAR)).toBe('Write a rule for OUTERWEAR')
  })

  it('keeps the row labels and the group title on VX’s spellings', () => {
    expect([
      VARIATIONS_COPY.title, VARIATIONS_COPY.rowTheme, VARIATIONS_COPY.rowAxes,
      VARIATIONS_COPY.rowCollisions, VARIATIONS_COPY.rowSplit, VARIATIONS_COPY.rowValueMaps,
      VARIATIONS_COPY.rowAxisNames, VARIATIONS_COPY.rowPreviewSku,
    ]).toEqual([
      'Variations', 'Theme', 'Axes on channel', 'Collisions', 'Listing split', 'Value maps',
      'Axis names', 'Preview SKU',
    ])
  })

  it('keeps the collision and split resolver labels on VX’s spellings, in VX’s order', () => {
    expect(RESOLVER_ORDER.map((k) => RESOLVER_COPY[k].label))
      .toEqual(['Split per dropped axis', 'Fold into', 'Exclude the duplicates'])
    expect(RESOLVER_COPY.fold.suffix?.(' / ')).toBe('with “ / ”')
    expect([SPLIT_COPY.one, SPLIT_COPY['per-axis']]).toEqual(['One listing', 'One per'])
  })

  it('states the blast radius in the prompt’s own sentence', () => {
    expect(blastRadiusSentence({ follow: 38, wouldCollide: 0 }))
      .toBe('38 products follow this rule · 0 would gain a collision')
    expect(blastRadiusSentence({ follow: 12, wouldCollide: 3 }))
      .toBe('12 products follow this rule · 3 would gain a collision')
  })
})

describe('no count is computed on the page', () => {
  it('reads follow · override · collide straight off the wire, in the canvas’s order', () => {
    expect(headerCounts(CANVAS_AMAZON_DE_OUTERWEAR)).toEqual([
      { n: 38, word: 'follow' }, { n: 3, word: 'override' }, { n: 0, word: 'collide' },
    ])
    // Positive control that these are READ, not derived: the measured fixture differs on the same shape.
    expect(headerCounts(MEASURED_AMAZON_DE_OUTERWEAR)).toEqual([
      { n: 7, word: 'follow' }, { n: 0, word: 'override' }, { n: 0, word: 'collide' },
    ])
  })

  it('sizes the theme enum from the wire, not from a constant', () => {
    expect(themeHintText(CANVAS_AMAZON_DE_OUTERWEAR))
      .toBe('Amazon only · the product type’s enum, 50 values on DE')
    expect(themeHintText(RULE_AMAZON_IT_AUTO_ACCESSORY))
      .toBe('Amazon only · the product type’s enum, 3 values on IT')
    expect(themeHintText(SHOPIFY_DROPPED_AND_COLLIDING)).toBeNull()
  })

  it('distinguishes "none" from "0 mapped · 0 unreviewed" on a value-map line', () => {
    expect(valueMapText({ axisKey: 'color', label: 'colour', mapped: 12, unreviewed: 2 }))
      .toEqual({ label: 'colour', mapped: 12, unreviewed: 2 })
    expect(valueMapText({ axisKey: 'size', label: 'size', mapped: 0, unreviewed: 0 }))
      .toEqual({ label: 'size', mapped: null, unreviewed: 0 })
  })
})

describe('the derived tier (design §3.7’s one addition to VX)', () => {
  it('shows the derivation for the category’s most common axis set when no rule exists', () => {
    expect(derivationSentence(CANVAS_AMAZON_DE_OUTERWEAR)).toBe('colour × size → COLOR/SIZE')
    expect(derivationSentence(MEASURED_AMAZON_DE_OUTERWEAR)).toBe('colour × size → COLOR/SIZE')
  })

  it('adds the "n of m families" clause only when the category is NOT uniform', () => {
    const mixed = {
      ...CANVAS_AMAZON_DE_OUTERWEAR,
      derivation: { ...CANVAS_AMAZON_DE_OUTERWEAR.derivation!, families: 9, familiesTotal: 12 },
    }
    expect(derivationSentence(mixed)).toBe('colour × size → COLOR/SIZE on 9 of 12 families')
  })

  it('says nothing when a rule decides the theme — the derivation is not the reason then', () => {
    expect(derivationSentence(RULE_AMAZON_IT_AUTO_ACCESSORY)).toBeNull()
    expect(derivationSentence({ ...CANVAS_AMAZON_DE_OUTERWEAR, derivation: null })).toBeNull()
  })
})

describe('dropped axes are named, never silent (VX §6)', () => {
  it('reads "none dropped" only when nothing is dropped', () => {
    expect(droppedText(CANVAS_AMAZON_DE_OUTERWEAR)).toBe('none dropped')
    expect(droppedText(SHOPIFY_DROPPED_AND_COLLIDING)).toBe('style dropped')
  })

  it('prints a dropped key that the axis list does not carry, rather than dropping it twice', () => {
    expect(droppedText({ ...CANVAS_AMAZON_DE_OUTERWEAR, dropped: ['fittype'] })).toBe('fittype dropped')
  })

  it('only chips the axes this coordinate delivers', () => {
    expect(includedAxes(SHOPIFY_DROPPED_AND_COLLIDING).map((a) => a.axisKey)).toEqual(['color', 'size'])
  })
})

describe('the theme decides inclusion and order on Amazon; the rule decides it elsewhere', () => {
  it('reorders and re-includes from the chosen enum value’s own drops list', () => {
    const next = applyTheme(CANVAS_AMAZON_DE_OUTERWEAR, 'COLOR')
    expect(next.theme?.code).toBe('COLOR')
    expect(next.dropped).toEqual(['size'])
    expect(next.axes.map((a) => [a.axisKey, a.included])).toEqual([['color', true], ['size', false]])
    // The reverse move restores it — the derivation is a function of the option, not a latch.
    const back = applyTheme(next, 'COLOR/SIZE')
    expect(back.dropped).toEqual([])
    expect(back.axes.every((a) => a.included)).toBe(true)
  })

  it('ignores a code the wire never offered', () => {
    expect(applyTheme(CANVAS_AMAZON_DE_OUTERWEAR, 'NOT_A_THEME')).toBe(CANVAS_AMAZON_DE_OUTERWEAR)
  })

  it('offers the reorder grip only where the channel, not the theme, owns the order', () => {
    expect(axisOrderIsThemeDriven(CANVAS_AMAZON_DE_OUTERWEAR)).toBe(true)
    expect(axisOrderIsThemeDriven(SHOPIFY_DROPPED_AND_COLLIDING)).toBe(false)
  })

  it('permutes the axis list by key and refuses a list that lost one', () => {
    const next = applyAxisOrder(SHOPIFY_DROPPED_AND_COLLIDING, ['size', 'color', 'style'])
    expect(next.axes.map((a) => a.axisKey)).toEqual(['size', 'color', 'style'])
    expect(applyAxisOrder(SHOPIFY_DROPPED_AND_COLLIDING, ['size', 'color']))
      .toBe(SHOPIFY_DROPPED_AND_COLLIDING)
  })
})

describe('resolver availability is the server’s answer', () => {
  it('relays the held reason rather than deciding locally', () => {
    expect(resolverAvailability(SHOPIFY_DROPPED_AND_COLLIDING, 'split'))
      .toEqual({ available: false, reason: 'Aliases are not creatable until PES.5-ii.' })
    expect(resolverAvailability(SHOPIFY_DROPPED_AND_COLLIDING, 'exclude'))
      .toEqual({ available: true, reason: null })
  })

  it('refuses a resolver the wire did not mention instead of assuming it runs', () => {
    const stripped = {
      ...CANVAS_AMAZON_DE_OUTERWEAR,
      collisions: { ...CANVAS_AMAZON_DE_OUTERWEAR.collisions, resolvers: [] },
    }
    expect(resolverAvailability(stripped, 'fold').available).toBe(false)
    expect(resolverAvailability(stripped, 'fold').reason).toMatch(/not offered/)
  })
})

describe('the write body and the dirty check', () => {
  it('sends the WHOLE axis list, ordered, with inclusion — a partial patch cannot express a removal', () => {
    const body = buildVariationWrite(SHOPIFY_DROPPED_AND_COLLIDING, true)
    expect(body.dryRun).toBe(true)
    expect(body.expectedToken).toBe('fixture-shopify')
    expect(body.rule?.axes).toEqual([
      { axisKey: 'color', target: 'Color', order: 0, included: true },
      { axisKey: 'size', target: 'Size', order: 1, included: true },
      { axisKey: 'style', target: null, order: 2, included: false },
    ])
    expect(body.rule?.theme).toBeNull()
    expect(body.rule?.collisions).toEqual({ resolver: 'fold', foldInto: 'size', foldSeparator: ' / ' })
  })

  it('carries the theme code on Amazon', () => {
    expect(buildVariationWrite(CANVAS_AMAZON_DE_OUTERWEAR, false).rule?.theme).toBe('COLOR/SIZE')
  })

  it('is clean against itself and dirty after a real change', () => {
    expect(isDirty(CANVAS_AMAZON_DE_OUTERWEAR, CANVAS_AMAZON_DE_OUTERWEAR)).toBe(false)
    expect(isDirty(CANVAS_AMAZON_DE_OUTERWEAR, applyTheme(CANVAS_AMAZON_DE_OUTERWEAR, 'SIZE/COLOR'))).toBe(true)
    // A change the write body does not carry must NOT look dirty.
    expect(isDirty(CANVAS_AMAZON_DE_OUTERWEAR, { ...CANVAS_AMAZON_DE_OUTERWEAR, counts: { ...CANVAS_AMAZON_DE_OUTERWEAR.counts, follow: 99 } })).toBe(false)
  })
})

describe('[List] opens the catalogue on the three variation-mapping tiers (design §3.7)', () => {
  it('emits design §3.7’s own filter string, with the coordinate', () => {
    expect(variationMappingListHref(CANVAS_AMAZON_DE_OUTERWEAR))
      .toBe('/products?filter=variation-mapping%3Aderived%7Crule%7Coverridden&channel=AMAZON&market=DE')
    expect(variationMappingListHref(RULE_AMAZON_IT_AUTO_ACCESSORY))
      .toBe('/products?filter=variation-mapping%3Aderived%7Crule%7Coverridden&channel=AMAZON&market=IT')
  })

  it('every value it emits is one the catalogue’s parser actually accepts', () => {
    // The set claim, derived from the OTHER module rather than restated here: a rename there fails
    // this test instead of quietly turning the button into a no-op filter.
    for (const value of VARIATION_MAPPING_LIST_VALUES) expect(isVariationMappingValue(value)).toBe(true)
    expect(VARIATION_MAPPING_VALUES).toContain('derived')
  })
})

describe('the theme candidate list is the cached schema’s, derived not typed', () => {
  it('carries the 50 OUTERWEAR·DE enum values measured on the local database', () => {
    expect(AMAZON_DE_OUTERWEAR_THEMES).toHaveLength(50)
    expect(AMAZON_DE_OUTERWEAR_THEMES.filter((o) => o.deprecated)).toHaveLength(28)
    expect(AMAZON_DE_OUTERWEAR_THEMES.filter((o) => o.coversAll)).toHaveLength(13)
  })

  it('labels COLOR/SIZE with the BOUND attributes’ titles, not the machine-cased enumNames', () => {
    const bare = AMAZON_DE_OUTERWEAR_THEMES.find((o) => o.code === 'COLOR/SIZE')
    expect(bare).toEqual({ code: 'COLOR/SIZE', label: 'Farbe / Größe', coversAll: true, drops: [], deprecated: false })
  })

  it('marks both _NAME spellings deprecated — the tie-break is derived, not preferred (D-VT8)', () => {
    const named = AMAZON_DE_OUTERWEAR_THEMES.find((o) => o.code === 'COLOR_NAME/SIZE_NAME')
    expect(named?.deprecated).toBe(true)
    expect(AMAZON_DE_OUTERWEAR_THEMES.find((o) => o.code === 'SIZE/COLOR')?.deprecated).toBe(false)
  })

  it('shows a deprecated or dropping option for what it is in the listbox row', () => {
    expect(themeOptionLabel({ code: 'COLOR/SIZE', label: 'Farbe / Größe', coversAll: true, drops: [], deprecated: false }))
      .toBe('COLOR/SIZE · Farbe / Größe')
    expect(themeOptionLabel({ code: 'COLOR_NAME/SIZE_NAME', label: 'Farbe / Größe', coversAll: true, drops: [], deprecated: true }))
      .toBe('COLOR_NAME/SIZE_NAME · Farbe / Größe — deprecated')
    expect(themeOptionLabel({ code: 'SIZE', label: 'Größe', coversAll: false, drops: ['color'], deprecated: false }))
      .toBe('SIZE · Größe — drops color')
  })

  it('keeps a segment that binds to no property as its raw segment (T15’s unbound case)', () => {
    expect(AMAZON_DE_OUTERWEAR_THEMES.find((o) => o.code === 'ITEM_PACKAGE_QUANTITY/MATERIAL_TYPE')?.label)
      .toBe('Packungseinheit / MATERIAL_TYPE')
  })
})

describe('every fixture state is complete enough to render', () => {
  it.each(Object.entries(VARIATION_FIXTURES))('%s', (_key, view) => {
    expect(view.axisNamesSentence.length).toBeGreaterThan(0)
    expect(view.axes.length).toBeGreaterThan(0)
    expect(view.counts.follow).toBeGreaterThanOrEqual(0)
    expect(ruleLineText(view).length).toBeGreaterThan(0)
    expect(droppedText(view).length).toBeGreaterThan(0)
    expect(view.valueMaps.length).toBe(view.axes.length)
    // The source vocabulary is the resolver's, minus the cell-only `override`.
    expect(['rule', 'derived', 'none']).toContain(view.source)
  })
})
