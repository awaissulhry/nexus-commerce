import { describe, expect, it } from 'vitest'

import { essentialsColumns, flaggedColumnKeys, orderColumnKeys, rankOfColumn } from './views'
import type { SheetColumn } from './master/types'

const col = (key: string, over: Partial<SheetColumn> = {}): SheetColumn =>
  ({ key, label: key, group: 'Attributes', requiredBy: [], storage: 'categoryAttributes', ...over } as SheetColumn)

/** A realistic slice: identity, spine, two axes, the 7 required, and a wall of empties. */
const COLUMNS: SheetColumn[] = [
  col('name', { group: 'Identity', storage: 'column' }),
  col('status', { group: 'Identity', storage: 'column' }),
  col('productType', { group: 'Identity', storage: 'column' }),
  col('brand', { group: 'Identity', storage: 'column', requiredBy: ['Amazon · IT', 'eBay · IT'] }),
  col('basePrice', { group: 'Pricing', storage: 'column' }),
  col('totalStock', { group: 'Inventory', storage: 'column' }),
  /*
   * 🔴 Both halves of this fixture are load-bearing and both were wrong first time.
   * `scope: 'per_variant'` is what makes a column an AXIS at all — without it they dropped out
   * silently. And the LABELS must be the localised ones: the live contract ships `color`/`size` as
   * keys with `Colore`/`Taglia` as labels, matching the family's declared axes. An earlier version
   * used English labels, `size` then failed to match `Taglia`, and it read like a defect in
   * `isAxisColumn` — measured against the real contract, the matcher is fine and the fixture was
   * the fiction.
   */
  col('color', { scope: 'per_variant', label: 'Colore', axis: true }), col('size', { scope: 'per_variant', label: 'Taglia', axis: true }),
  col('product_description', { requiredBy: ['Amazon · IT'] }),
  col('bullet_point', { requiredBy: ['Amazon · IT'] }),
  col('item_name', { requiredBy: ['Amazon · IT'] }),
  col('country_of_origin', { requiredBy: ['Amazon · IT'] }),
  col('fabric_type', { requiredBy: ['Amazon · IT'] }),
  col('supplier_declared_dg_hz_regulation', { requiredBy: ['Amazon · IT'] }),
  col('dsa_responsible_party_address'),
  col('gpsr_safety_attestation'),
  ...Array.from({ length: 85 }, (_, i) => col(`empty_${i}`)),
]
const ctx = { variationAxes: ['Colore', 'Taglia'], locale: 'it' }

describe('Essentials is a RULE, measured (ruling #173; a preset since 2026-09-04, the sheet itself lands FULL)', () => {
  it('picks ~14 columns out of 101 — the work, not a squeezed hundred', () => {
    const out = essentialsColumns(COLUMNS, { ...ctx, flaggedKeys: ['dsa_responsible_party_address', 'gpsr_safety_attestation'] })
    expect(out).toHaveLength(16) // 2 identity + 2 axes + 4 spine (brand dedupes) + 6 required + 2 flagged
    expect(out.length).toBeLessThan(COLUMNS.length / 5)
  })

  /**
   * 🔴 Rule 3, the one worth defending: this is an EDITOR. An empty required cell IS the work.
   * Measured, `product_description` and `bullet_point` are missing on 104 of 120 rows — the single
   * most common row state in the catalogue sample — so they must never need to be gone looking for.
   */
  it('includes required fields whether or not anything has filled them', () => {
    const out = essentialsColumns(COLUMNS, ctx)
    expect(out).toEqual(expect.arrayContaining(['product_description', 'bullet_point', 'item_name']))
  })

  /** Rule 4: a field that can get a listing SUPPRESSED on EU marketplaces is not opt-in. */
  it('pulls in whatever readiness flagged on a row in view', () => {
    expect(essentialsColumns(COLUMNS, { ...ctx, flaggedKeys: ['gpsr_safety_attestation'] })).toContain('gpsr_safety_attestation')
    // …and leaves it out when nothing is flagged — the rule reads the rows, it does not assume them.
    expect(essentialsColumns(COLUMNS, ctx)).not.toContain('gpsr_safety_attestation')
  })

  it('never shows a column twice, even when it satisfies several rules', () => {
    // `brand` is commerce spine AND required — measured required on 20/120 rows.
    const out = essentialsColumns(COLUMNS, ctx)
    expect(out.filter((k) => k === 'brand')).toHaveLength(1)
    expect(new Set(out).size).toBe(out.length)
  })

  /**
   * 🔴 INVERTED by hub ruling #690 (2026-09-02). This case asserted the opposite until today
   * — "the axes lead" — and it was measured wrong on screen rather than argued wrong on paper:
   * `isAxisColumn` reads the MARKET's `scope`, and the contract returns `color.scope: 'per_variant'`
   * on IT where it returns `'global'` on DE, so at 1440 the IT coordinate paid 160px in front of
   * the required block and read 6/7 on BOTH scopes (`product_description` clipped, 87px short).
   * The programme's every master baseline was DE, where the hoist never happened.
   */
  it('puts the axes IMMEDIATELY AFTER the required block — never in front of it (#690)', () => {
    const out = essentialsColumns(COLUMNS, ctx)
    const lastRequired = Math.max(...COLUMNS.filter((c) => c.requiredBy.length > 0).map((c) => out.indexOf(c.key)))
    expect(out.indexOf('color')).toBeGreaterThan(lastRequired)
    expect(out.indexOf('size')).toBeGreaterThan(lastRequired)
    // IMMEDIATELY after: nothing else may slip between the work and the axes.
    expect(out.indexOf('color')).toBe(lastRequired + 1)
    // §9.3b (#362) survives: `name` still follows the axes, not the other way round.
    expect(out.indexOf('color')).toBeLessThan(out.indexOf('name'))
    // Still IN the view — moved, not demoted (an operator reaches them without the Customise dialog).
    expect(out).toEqual(expect.arrayContaining(['color', 'size']))
  })

  /**
   * The axes enter on rule 1, which reads `scope`/label — never `defaultVisible`. Stated as a case
   * because the reorder moved them next to the rules that DO filter on other flags, and a future
   * reader could reasonably assume the move demoted them to opt-in.
   */
  it('an axis the contract does not mark defaultVisible still enters the view', () => {
    const hidden = COLUMNS.map((c) => (c.key === 'color' ? { ...c, defaultVisible: false } : c))
    expect(essentialsColumns(hidden, ctx)).toContain('color')
  })

  /**
   * 🔴 §9.2's inversion: the WORK comes before the done-ness. `basePrice`/`totalStock` are
   * populated on 100% of rows — the most reassuring and least actionable columns there are —
   * while `product_description` and `bullet_point` are missing on 104 of 120. Spine-first sorted
   * the sheet by comfort.
   */
  it('shows required-and-incomplete AHEAD of the commerce spine', () => {
    const out = essentialsColumns(COLUMNS, ctx)
    expect(out.indexOf('product_description')).toBeLessThan(out.indexOf('basePrice'))
    expect(out.indexOf('bullet_point')).toBeLessThan(out.indexOf('totalStock'))
    // …and §9.3b: `name` follows the required block rather than leading it. Measured at 1440,
    // `name` + `status` in front cost 330px and 4 of the 7 required columns.
    expect(out.indexOf('name')).toBeGreaterThan(out.indexOf('product_description'))
    // It is still in the default view, and still ahead of the spine — moved, not demoted.
    expect(out.indexOf('name')).toBeLessThan(out.indexOf('basePrice'))
  })

  /**
   * 16 of 120 measured rows have `required.total: 0` — a product type with no schema. The rule must
   * degrade to identity + spine rather than emptying out or falling back to everything.
   */
  it('degrades to the axes + identity + spine on a product type with no schema', () => {
    const bare = COLUMNS.filter((c) => c.requiredBy.length === 0)
    /* 🔴 `variationAxes: []` no longer suppresses the axes, and that is the contract fix, not a
       regression (#711/P11). An axis is now a property of the COLUMN — the server's `axis` flag,
       derived from the family's axis keys — not something re-derived here from a list of localised
       labels handed in with the context. The old expectation was asserting the behaviour of a
       ctx field this rule stopped consulting, so it read as "no axes" for a family that has two.
       With no required block to sit behind, they lead: they are the only thing telling the rows
       apart on a product type whose schema asks for nothing. */
    const out = essentialsColumns(bare, { variationAxes: [], locale: 'it' })
    expect(out).toEqual(['color', 'size', 'name', 'status', 'basePrice', 'totalStock', 'productType'])
  })

  it('asks for nothing the column set does not have', () => {
    const out = essentialsColumns([col('name', { group: 'Identity' })], ctx)
    expect(out).toEqual(['name'])
  })
})

describe('flaggedColumnKeys — rule 4 reads the ROWS in view', () => {
  const row = (...keys: string[]) => ({ readiness: { issues: keys.map((key) => ({ key })) } })

  it('collects every flagged key across the rows, once each', () => {
    expect(flaggedColumnKeys([row('gpsr_safety_attestation'), row('gpsr_safety_attestation', 'productType')]).sort())
      .toEqual(['gpsr_safety_attestation', 'productType'])
  })

  it('is empty when nothing is flagged — the rule then adds nothing', () => {
    expect(flaggedColumnKeys([row(), { readiness: null }])).toEqual([])
    expect(flaggedColumnKeys([])).toEqual([])
    expect(flaggedColumnKeys(undefined)).toEqual([])
  })

  /** A filtered sheet flags what is ON SCREEN. The caller decides which rows; this never assumes. */
  it('reflects only the rows it was given', () => {
    expect(flaggedColumnKeys([row('a')])).toEqual(['a'])
  })
})

/*
 * §9.2 — the ORDER, not the visible set.
 *
 * These exist because the rule shipped written, tested and off screen: `essentialsColumns` was
 * wired to visibility only, so the grid rendered `sku, completeness, name, status, basePrice,
 * totalStock, …` — the commerce spine, populated on 100% of rows, in front of the required-and-
 * empty fields the sheet exists to fill. A test on the rule alone could not have caught that, and
 * these still can't: `orderColumnKeys` is the rule, and `columnDefs` is the wiring. The wiring is
 * what UX.1 measures on screen.
 */
describe('§9.2 — the order the grid renders in', () => {
  it('preserves server attribute order regardless of requirements and axes', () => {
    expect(orderColumnKeys(COLUMNS, ctx)).toEqual(COLUMNS.map(c => c.key))
  })

  it('is a PERMUTATION — it reorders the sheet, it does not edit it', () => {
    const out = orderColumnKeys(COLUMNS, ctx)
    expect(out).toHaveLength(COLUMNS.length)
    expect([...out].sort()).toEqual(COLUMNS.map((c) => c.key).sort())
  })

  it('keeps the contract order among columns of the SAME group', () => {
    // Every `empty_*` shares one group, so this fixture cannot show the grouping — that is what the
    // next test is for. Kept because within a group the contract's order must still survive.
    const out = orderColumnKeys(COLUMNS, ctx)
    const empties = out.filter((k) => k.startsWith('empty_'))
    expect(empties).toEqual(COLUMNS.map((c) => c.key).filter((k) => k.startsWith('empty_')))
  })

  it('preserves interleaved server order without inventing another group order', () => {
    /*
     * The rule names ~20 columns and says nothing about the other ~75, which used to trail in raw
     * schema order — the contract's cache order, meaningful to nobody. Interleaved below exactly as
     * a cache would produce them; grouped, they must come out in runs.
     */
    const interleaved: SheetColumn[] = [
      col('name', { group: 'Identity', storage: 'column' }),
      col('ship_a', { group: 'Logistics' }),
      col('media_a', { group: 'Media' }),
      col('ship_b', { group: 'Logistics' }),
      col('media_b', { group: 'Media' }),
      col('ship_c', { group: 'Logistics' }),
    ]
    const out = orderColumnKeys(interleaved, { variationAxes: [], locale: 'it' })
    expect(out).toEqual(['name', 'ship_a', 'media_a', 'ship_b', 'media_b', 'ship_c'])
  })

  it('keeps non-alphabetical server order', () => {
    // The server has already decided what comes first; re-sorting here would be a second opinion.
    const cols: SheetColumn[] = [
      col('z_first', { group: 'Zulu' }),
      col('a_second', { group: 'Alpha' }),
      col('z_third', { group: 'Zulu' }),
    ]
    expect(orderColumnKeys(cols, { variationAxes: [], locale: 'it' }))
      .toEqual(['z_first', 'a_second', 'z_third'])
  })

  it('🔴 the NAMED order is untouched — §9.1\'s required block cannot move', () => {
    // Ranked columns all carry distinct ranks, so the group tie-break can never reach them. This is
    // the guarantee that let me report §9.1 unchanged without re-deriving it.
    const out = orderColumnKeys(COLUMNS, ctx)
    const required = ['product_description', 'bullet_point', 'item_name', 'country_of_origin', 'fabric_type']
    const positions = required.map((k) => out.indexOf(k))
    expect(positions.every((p, i) => i === 0 || p > positions[i - 1])).toBe(true)
    // ...and every one of them still precedes the whole unnamed tail.
    const firstUnnamed = out.findIndex((k) => k.startsWith('empty_'))
    for (const k of required) expect(out.indexOf(k)).toBeLessThan(firstUnnamed)
  })

  it('ranks a column GROUP as its best child, so a group is not exiled to the end', () => {
    const rank = new Map(orderColumnKeys(COLUMNS, ctx).map((k, i) => [k, i]))
    const group = { children: [{ colId: 'empty_3' }, { colId: 'product_description' }] }
    expect(rankOfColumn(group, rank)).toBe(rank.get('product_description'))
    // and a plain column reads through either accessor AG might have populated
    expect(rankOfColumn({ colId: 'basePrice' }, rank)).toBe(rank.get('basePrice'))
    expect(rankOfColumn({ field: 'basePrice' }, rank)).toBe(rank.get('basePrice'))
    // an unnamed column sorts last rather than first — MAX, not undefined-becomes-0
    expect(rankOfColumn({ colId: 'not_a_column' }, rank)).toBe(Number.MAX_SAFE_INTEGER)
    expect(rankOfColumn({ children: [] }, rank)).toBe(Number.MAX_SAFE_INTEGER)
  })
})
