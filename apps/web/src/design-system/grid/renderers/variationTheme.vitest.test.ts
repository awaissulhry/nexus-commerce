/**
 * VT.2 — the `Variation theme` cell.
 *
 * The fixtures are VT.1's own (`docs/fixtures/vt1/fixtures.ts`), imported rather than copied: every
 * number and every string in them is a 2026-09-13 reading on the LOCAL Docker database and the LIVE
 * eBay taxonomy. A hand-written fixture here would prove this file's idea of the contract
 * (`reference_fixture_must_be_writer_produced` — ask which writer created the fixture).
 *
 * The component is rendered in Node through `react-dom/server`, which is how this workspace tests a
 * `.tsx` from a `.ts` suite (`environment: 'node'`, no jsdom — see `ProjectionCell.vitest.test.ts`).
 * That is enough for every claim below: they are about the MARKUP and the CLASSES the cell emits.
 * Colour is deliberately NOT asserted — the tints come from `.nds-cell-is-inherited` /
 * `.nds-cell-is-pinned` in `grid.css` through the builders' own class rules, so a test reading a hex
 * here would be testing its own fixture.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ICellRendererParams } from 'ag-grid-community'

import {
  GALE_MASTER,
  GALE_AMAZON_DE_DERIVED,
  GALE_EBAY_IT_OVERRIDDEN,
  GALE_EBAY_DE_UNAVAILABLE,
  GALE_SHOPIFY_DROPPED,
  AMAZON_THEME_UNSET,
  GALE_CHILD,
  VT1_FIXTURES,
} from '../../../../../../docs/fixtures/vt1/fixtures'
import {
  VariationThemeValue,
  VARIATION_THEME_CHILD_REASON,
  isMasterProjection,
  variationThemeProvenance,
  variationThemeProvenanceMember,
  variationThemeState,
  variationThemeText,
  variationThemeTooltip,
  variationThemeUnsetTone,
  type VariationThemeCell,
} from './variationTheme'

const html = (value: VariationThemeCell | null) =>
  renderToStaticMarkup(
    createElement(VariationThemeValue, { value, childReason: VARIATION_THEME_CHILD_REASON } as unknown as ICellRendererParams),
  )

describe('the scope discriminator', () => {
  it('reads master from ONE wire fact and reads every channel coordinate as a channel', () => {
    expect(isMasterProjection(GALE_MASTER)).toBe(true)
    /* The positive control for the other arm: if this list were empty the claim above would pass for
       the wrong reason. Five coordinates, four channels, two markets. */
    const channels = [GALE_AMAZON_DE_DERIVED, GALE_EBAY_IT_OVERRIDDEN, GALE_EBAY_DE_UNAVAILABLE, GALE_SHOPIFY_DROPPED, AMAZON_THEME_UNSET]
    expect(channels).toHaveLength(5)
    for (const c of channels) expect(isMasterProjection(c)).toBe(false)
  })

  it('holds across EVERY fixture VT.1 shipped, so a new coordinate cannot slip through untested', () => {
    const named = Object.entries(VT1_FIXTURES).filter(([, c]) => c !== null) as Array<[string, VariationThemeCell]>
    expect(named.map(([k]) => k)).toEqual([
      'master', 'Amazon · DE', 'Amazon · IT (unset)', 'eBay · IT', 'eBay · DE (unavailable)', 'Shopify (dropped + collides)',
    ])
    for (const [key, cell] of named) expect(isMasterProjection(cell)).toBe(key === 'master')
  })
})

describe('§1.4 copy / export / filter text', () => {
  it('joins the DELIVERED names with the coordinate own separator — never the English labels', () => {
    expect(variationThemeText(GALE_MASTER)).toBe('Color · Size')
    expect(variationThemeText(GALE_AMAZON_DE_DERIVED)).toBe('Farbe / Größe')
    expect(variationThemeText(GALE_EBAY_IT_OVERRIDDEN)).toBe('Colore · Taglia')
  })

  it('drops an EXCLUDED axis from the text — a dropped axis is not delivered', () => {
    /* Shopify's three-axis family: `style` is `included: false`, so it must not appear even though it
       is in `axes`. This is the whole reason the filter is on `included` and not on `axes.length`. */
    expect(GALE_SHOPIFY_DROPPED.axes).toHaveLength(3)
    expect(variationThemeText(GALE_SHOPIFY_DROPPED)).toBe('Color · Size')
  })

  it('gives a child row the em dash', () => {
    expect(variationThemeText(GALE_CHILD)).toBe('—')
  })
})

describe('§3.4 states', () => {
  it('classifies the child row, the two unset sentences and a delivered projection', () => {
    expect(variationThemeState(GALE_CHILD)).toBe('child')
    expect(variationThemeState(AMAZON_THEME_UNSET)).toBe('unset')
    expect(variationThemeState(GALE_MASTER)).toBe('delivered')
    expect(variationThemeState(GALE_EBAY_IT_OVERRIDDEN)).toBe('delivered')
  })

  it('warns on a channel with no theme, and on master ONLY once the family has children', () => {
    /* A channel `none` is always a warning: readiness raises `theme-unset` as an ERROR there. */
    expect(variationThemeUnsetTone(AMAZON_THEME_UNSET)).toBe('warning')
    /* Both master arms, derived from the real fixture by changing the ONE fact the rule reads.
       GALE has 20 child ids on local, so the childless arm has to be constructed — and saying so is
       the point: no master fixture with an empty family exists, and the arm that is never run is the
       one that would have failed (`reference_a_fixture_pins_a_dimension`). */
    const emptyFamily: VariationThemeCell = { ...GALE_MASTER, axes: [], source: { ...GALE_MASTER.source, kind: 'none', label: 'Set axes…' }, write: { ...GALE_MASTER.write!, childIds: [] } }
    const withChildren: VariationThemeCell = { ...emptyFamily, write: { ...GALE_MASTER.write! } }
    expect(GALE_MASTER.write!.childIds).toHaveLength(20)
    expect(variationThemeUnsetTone(emptyFamily)).toBe('muted')
    expect(variationThemeUnsetTone(withChildren)).toBe('warning')
  })
})

describe('provenance — the DS vocabulary, no new member', () => {
  it('draws NO mark on master even though `source.kind` is `derived` (§1.2)', () => {
    expect(GALE_MASTER.source.kind).toBe('derived')
    expect(variationThemeProvenanceMember(GALE_MASTER)).toBe('own')
    expect(html(GALE_MASTER)).not.toContain('nds-cell-prov')
  })

  it('maps derived and rule to `inherited`, and override to `pinned`', () => {
    expect(variationThemeProvenanceMember(GALE_AMAZON_DE_DERIVED)).toBe('inherited')
    expect(variationThemeProvenanceMember(GALE_EBAY_IT_OVERRIDDEN)).toBe('pinned')
    /* No `rule` fixture exists — VT.1 measured that the `variations` key is absent from every
       `MarketplaceSchemaMapping` row in the catalogue — so the arm is forced. Canvas artboard 5:
       "Same mark; tooltip 'Follows rule Apparel default'". */
    const followsRule: VariationThemeCell = {
      ...GALE_AMAZON_DE_DERIVED,
      source: { kind: 'rule', ruleLabel: 'Apparel default', category: 'OUTERWEAR', label: 'Follows rule Apparel default' },
    }
    expect(variationThemeProvenanceMember(followsRule)).toBe('inherited')
  })

  it('states the facts in the DS classifier own words, never a member', () => {
    expect(variationThemeProvenance(GALE_EBAY_IT_OVERRIDDEN)).toEqual({ layer: 'channel', inherited: false, pinned: true })
    expect(variationThemeProvenance(GALE_AMAZON_DE_DERIVED)).toEqual({ layer: 'master', inherited: true })
  })
})

describe('the tooltip — server-stated lines only', () => {
  it('leads with the enum CODE, then the source sentence (§3.4 own example)', () => {
    const t = variationThemeTooltip(GALE_AMAZON_DE_DERIVED)
    expect(t.split('\n\n')[0]).toBe('COLOR/SIZE')
    expect(t).toContain('Derived from the family axes')
    /* The code is load-bearing precisely because two enum spellings share ONE printed label here. */
    const both = GALE_AMAZON_DE_DERIVED.candidates!.items.filter((i) => i.label === 'Farbe / Größe')
    expect(both.map((i) => i.code)).toEqual(['COLOR/SIZE', 'COLOR_NAME/SIZE_NAME'])
  })

  it('carries the lock reason and the collision summary VERBATIM', () => {
    expect(variationThemeTooltip(GALE_EBAY_IT_OVERRIDDEN)).toContain(GALE_EBAY_IT_OVERRIDDEN.locked!.reason)
    expect(variationThemeTooltip(GALE_SHOPIFY_DROPPED)).toContain(GALE_SHOPIFY_DROPPED.collisions!.summary)
  })

  it('carries every unbound reason, and the child reason for a child row', () => {
    expect(variationThemeTooltip(GALE_EBAY_DE_UNAVAILABLE)).toContain('has no category yet')
    expect(variationThemeTooltip(GALE_CHILD)).toBe(VARIATION_THEME_CHILD_REASON)
  })
})

describe('the markup', () => {
  it('draws the child row as a dash that says why', () => {
    const out = html(GALE_CHILD)
    expect(out).toContain('nds-cell-empty')
    expect(out).toContain(VARIATION_THEME_CHILD_REASON)
    expect(out).toContain('—')
  })

  it('draws the link mark and the delivered names on a derived coordinate', () => {
    const out = html(GALE_AMAZON_DE_DERIVED)
    expect(out).toContain('nds-cell-prov-inherited')
    expect(out).toContain('Farbe')
    expect(out).toContain('Größe')
    expect(out).toContain('nds-cell-value-text')
  })

  it('draws the pencil mark on an overridden coordinate', () => {
    expect(html(GALE_EBAY_IT_OVERRIDDEN)).toContain('nds-cell-prov-pinned')
  })

  it('draws `1 dropped` in warning tone, and ONLY when something is dropped', () => {
    const dropped = html(GALE_SHOPIFY_DROPPED)
    expect(dropped).toContain('1 dropped')
    expect(dropped).toContain('nds-tag warning')
    /* The negative, with its positive control one line above: Amazon·DE drops nothing and must
       trail nothing at all (§3.4: "otherwise nothing trails the text"). */
    expect(GALE_AMAZON_DE_DERIVED.dropped).toEqual([])
    expect(html(GALE_AMAZON_DE_DERIVED)).not.toContain('dropped')
  })

  it('draws the lock on a live coordinate and not on a draft one', () => {
    expect(html(GALE_EBAY_IT_OVERRIDDEN)).toContain('nds-axes-lock')
    expect(GALE_SHOPIFY_DROPPED.locked).toBeNull()
    expect(html(GALE_SHOPIFY_DROPPED)).not.toContain('nds-axes-lock')
  })

  it('draws `Choose a theme` in warning tone with the triangle, from the SERVER own label', () => {
    const out = html(AMAZON_THEME_UNSET)
    expect(AMAZON_THEME_UNSET.source.label).toBe('Choose a theme')
    expect(out).toContain('Choose a theme')
    expect(out).toContain('nds-axes-unset-required')
    expect(out).toContain('nds-axes-warn')
  })

  it('marks an UNBOUND axis in warning tone instead of showing it as delivered', () => {
    const out = html(GALE_EBAY_DE_UNAVAILABLE)
    expect(out).toContain('nds-axes-name-unbound')
    expect(out).toContain('has no category yet')
    /* And the honest arm: a bound axis carries no warning class. */
    expect(html(GALE_EBAY_IT_OVERRIDDEN)).not.toContain('nds-axes-name-unbound')
  })

  it('never prints `[object Object]` — the defect a scalar formatter would produce on every row', () => {
    for (const cell of Object.values(VT1_FIXTURES)) expect(html(cell)).not.toContain('[object')
  })
})
