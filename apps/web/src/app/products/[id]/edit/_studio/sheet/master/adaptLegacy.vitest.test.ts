import { describe, expect, it } from 'vitest'

import { adaptLegacySheet, layerFromSource, pinnedFromLegacy, type LegacySheetPage } from './adaptLegacy'
import type { SheetColumn } from './types'

const column: SheetColumn = {
  key: 'material', writeField: 'attr_material', label: 'Material', group: 'Attributes',
  kind: 'text', storage: 'categoryAttributes', scope: 'global', requiredBy: [],
  editable: true, defaultVisible: true,
}

const page = (over: Partial<LegacySheetPage> = {}): LegacySheetPage => ({
  market: 'IT',
  locale: 'it',
  coordinates: [{ channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT', inMarket: true }],
  columns: [column],
  rows: [],
  total: 1,
  droppedKeys: [],
  schemaMissing: [],
  schemaAge: [],
  availableMarkets: ['IT'],
  ...over,
})

const row = (over: Partial<LegacySheetPage['rows'][number]> = {}) => ({
  id: 'p1', sku: 'GALE-JACKET', name: 'GALE', parentId: null, isParent: true,
  status: 'ACTIVE', productType: 'OUTERWEAR', version: 2, basePrice: 199, childCount: 20,
  values: {}, listings: {}, readiness: {},
  completeness: { overall: { filled: 1, total: 2, pct: 50 }, required: { filled: 0, total: 1, missing: [] }, byGroup: [] },
  ...over,
})

describe('layerFromSource', () => {
  /** Three of the resolver's sources ARE the master, storing the field a different way. */
  it('collapses every master flavour onto `master`', () => {
    for (const s of ['master', 'masterLocale', 'masterColumn']) expect(layerFromSource(s)).toBe('master')
  })

  it('maps the variant and channel families', () => {
    for (const s of ['variant', 'variantLocale']) expect(layerFromSource(s)).toBe('variant')
    for (const s of ['channelOverride', 'channelExplicit']) expect(layerFromSource(s)).toBe('channel')
  })

  /**
   * An unknown source must not become `master`: that would draw the cell as the master's own value
   * on no evidence at all. `default` renders unmarked and claims nothing.
   */
  it('does not guess `master` for a source it does not recognise', () => {
    for (const s of ['somethingNew', '', undefined]) expect(layerFromSource(s)).toBe('default')
  })
})

describe('pinnedFromLegacy', () => {
  it('a child holding its own value for a global attribute is pinned — the ✎ glyph', () => {
    expect(pinnedFromLegacy({ source: 'variant', inherited: false }, { isParent: false })).toBe(true)
  })

  it('an inherited cell is never pinned, whatever its source says', () => {
    expect(pinnedFromLegacy({ source: 'variant', inherited: true }, { isParent: false })).toBe(false)
  })

  it('a parent is never pinned against itself', () => {
    expect(pinnedFromLegacy({ source: 'variant', inherited: false }, { isParent: true })).toBe(false)
    expect(pinnedFromLegacy({ source: 'master', inherited: false }, { isParent: false })).toBe(false)
  })
})

describe('adaptLegacySheet', () => {
  it('marks the result `legacy` so the sheet can SAY which read it is showing', () => {
    expect(adaptLegacySheet(page(), 'p1').meta.source).toBe('legacy')
  })

  it('carries version through — without it optimistic concurrency would be unarmed', () => {
    const out = adaptLegacySheet(page({ rows: [row()] }), 'p1')
    expect(out.rows[0].version).toBe(2)
  })

  it('derives layer and pinned per cell, and hands over the column’s writeField', () => {
    const out = adaptLegacySheet(
      page({
        rows: [
          row(),
          row({ id: 'c1', sku: 'GALE-NERO-L', parentId: 'p1', isParent: false, childCount: 0, values: {
            material: { value: 'Cordura', source: 'variant', inheritedFrom: null, inherited: false },
          } }),
        ],
      }),
      'p1',
    )
    const cell = out.rows[1].values.material
    expect(cell).toMatchObject({ layer: 'variant', pinned: true, writeField: 'attr_material', writeTarget: 'master' })
  })

  it('an inherited cell keeps its parent reference and is not pinned', () => {
    const out = adaptLegacySheet(
      page({ rows: [row({ id: 'c1', parentId: 'p1', isParent: false, values: {
        material: { value: 'Cordura', source: 'master', inheritedFrom: 'p1', inherited: true },
      } })] }),
      'p1',
    )
    expect(out.rows[0].values.material).toMatchObject({ inherited: true, pinned: false, inheritedFrom: 'p1' })
  })

  /**
   * The legacy read has no per-cell follow flag. Inventing `true` would draw a "Follows master"
   * control reporting a flag nobody read — the honest answer is null, and the sheet hides the
   * control rather than guessing.
   */
  it('never invents a follows flag it did not read', () => {
    const out = adaptLegacySheet(page({ rows: [row({ values: {
      material: { value: 'x', source: 'master', inheritedFrom: null, inherited: false },
    } })] }), 'p1')
    expect(out.rows[0].values.material.follows).toBeNull()
  })

  it('resolves the family from the requested id, then the parent row, then the first row', () => {
    const rows = [row({ id: 'c1', parentId: 'p1', isParent: false }), row({ id: 'p1' })]
    expect(adaptLegacySheet(page({ rows }), 'p1').family.sku).toBe('GALE-JACKET')
    expect(adaptLegacySheet(page({ rows }), 'nope').family.id).toBe('p1')
  })

  /**
   * 🔴 CORRECTED by LX.FIN (R-LX-22), with the reason beside it rather than deleted.
   *
   * It used to assert `readinessByCoordinate` carried `['AMAZON:IT','EBAY:IT']`. That field, and the
   * ROW-vocabulary per-coordinate column set it fed, are gone: the columns are now fed from
   * `ReadinessIndex` in the SCOPE vocabulary through the readiness contract, which this fallback path
   * reads too. The property that still matters is the one this test was really about — **no single
   * verdict is invented from two different ones** — so that half is kept and strengthened.
   */
  it('invents no single row verdict from a per-coordinate answer, and carries no dead field', () => {
    const out = adaptLegacySheet(
      page({ rows: [row({ readiness: { 'AMAZON:IT': { state: 'errors', issues: [] }, 'EBAY:IT': { state: 'live', issues: [] } } })] }),
      'p1',
    )
    expect(out.rows[0].readiness).toBeUndefined()
    expect('readinessByCoordinate' in out.rows[0]).toBe(false)
    // POSITIVE CONTROL in the same run: the adapter did produce the row and its other fields.
    expect(out.rows[0].id).toBe('p1')
    expect(out.rows[0].completeness).toBeDefined()
  })

  it('reports variationAxes as empty rather than guessing — the catalogue read does not return them', () => {
    expect(adaptLegacySheet(page({ rows: [row()] }), 'p1').family.variationAxes).toEqual([])
  })

  it('survives a family with no rows at all', () => {
    const out = adaptLegacySheet(page({ rows: [] }), 'p1')
    expect(out.rows).toEqual([])
    expect(out.family.id).toBe('p1')
  })
})
