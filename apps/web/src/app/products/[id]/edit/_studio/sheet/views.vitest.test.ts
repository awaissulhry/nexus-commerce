import { describe, expect, it } from 'vitest'

import { ALL_VIEW_ID } from '@/design-system/grid/views/presets'

import { ALWAYS_COLUMNS, alwaysColumnsFor, essentialsColumns, IDENTITY_COLUMN, orderColumnKeys, REQUIRED_VIEW_ID, rowIsMissingRequired, sheetViews, type ViewContext } from './views'
import type { SheetColumn } from './master/types'

const col = (over: Partial<SheetColumn> & Pick<SheetColumn, 'key'>): SheetColumn => ({
  writeField: over.key,
  label: over.key,
  group: 'Attributes',
  kind: 'text',
  storage: 'categoryAttributes',
  scope: 'global',
  requiredBy: [],
  editable: true,
  defaultVisible: false,
  ...over,
})

/** A slice of the REAL prod column set (market=IT, OUTERWEAR — measured 2026-09-01). */
const COLUMNS: SheetColumn[] = [
  col({ key: 'name', group: 'Identity', storage: 'column' }),
  col({ key: 'status', group: 'Identity', storage: 'column', kind: 'select' }),
  col({ key: 'description', group: 'Identity', storage: 'localizedContent', kind: 'longtext' }),
  col({ key: 'brand', group: 'Identity', storage: 'column', requiredBy: ['Amazon · IT'] }),
  col({ key: 'item_name', kind: 'longtext', requiredBy: ['Amazon · IT'] }),
  col({ key: 'bullet_point', kind: 'longtext', requiredBy: ['Amazon · IT'] }),
  col({ key: 'material' }),
  col({ key: 'fabric_type', kind: 'longtext', requiredBy: ['Amazon · IT'] }),
  col({ key: 'fit_type' }),
  /* `axis` is what the SERVER derived (exact match against the family's axis KEYS). The labels stay
     localised so the fixture keeps modelling the case the old substring matcher got wrong. */
  col({ key: 'color', scope: 'per_variant', label: 'Colore', axis: true }),
  col({ key: 'size', scope: 'per_variant', label: 'Taglia', axis: true }),
  col({ key: 'country_of_origin', kind: 'select', requiredBy: ['Amazon · IT'] }),
  col({ key: 'merchant_shipping_group' }),
  col({ key: 'totalStock', group: 'Inventory', storage: 'column', kind: 'number' }),
  col({ key: 'weightValue', group: 'Physical', storage: 'column', kind: 'number' }),
  col({ key: 'basePrice', group: 'Pricing', storage: 'column', kind: 'number' }),
  col({ key: 'costPrice', group: 'Pricing', storage: 'column', kind: 'number' }),
  col({ key: 'ean', group: 'Identifiers', storage: 'column', scope: 'per_variant' }),
  col({ key: 'amazonAsin', group: 'Identifiers', storage: 'column' }),
  col({ key: 'model_number' }),
  col({ key: 'league_name' }),
  col({ key: 'theme' }),
  // The real set has Amazon (6) and eBay (5) groups that no view rule claims — they are what the
  // residual view exists for. Without them in the fixture the orphan test passes vacuously.
  col({ key: 'amazon_title', group: 'Amazon', storage: 'column' }),
  col({ key: 'amazon_browseNode', group: 'Amazon', storage: 'column' }),
  col({ key: 'ebay_duration', group: 'eBay', storage: 'column', kind: 'select' }),
  // A GLOBAL attribute whose label contains an axis word. The axis test must not claim it, or the
  // NARROW view gains a column that does not vary per row.
  col({ key: 'main_color', label: 'Colore principale', scope: 'global' }),
]

const ctx: ViewContext = { variationAxes: ['Colore', 'Taglia'], locale: 'it' }

it('keeps classification and content together when later offer fields are required', () => {
  const columns = [
    col({ key: 'categoryId', group: 'Classification' }),
    col({ key: 'name', group: 'Content', requiredBy: ['eBay · IT'] }),
    col({ key: 'subtitle', group: 'Content' }),
    col({ key: 'conditionId', group: 'Offer', requiredBy: ['eBay · IT'] }),
  ]
  expect(orderColumnKeys(columns, ctx)).toEqual(['categoryId', 'name', 'subtitle', 'conditionId'])
  expect(sheetViews(columns, ctx).presets[0].columns).toEqual(orderColumnKeys(columns, ctx))
})

describe('sheetViews — ALL ATTRIBUTES is first, and it IS the sheet (Owner, 2026-09-04)', () => {
  it('🔴 the first preset is every column, in the §9.2 order — the ground state the sheet lands on', () => {
    const { presets } = sheetViews(COLUMNS, ctx)
    expect(presets[0].id).toBe(ALL_VIEW_ID)
    expect(presets[0].columns).toEqual(orderColumnKeys(COLUMNS, ctx))
    expect([...presets[0].columns].sort()).toEqual(COLUMNS.map((c) => c.key).sort())
  })

  it('stays first when the server supplies the task views — the ground state is the sheet’s, not a server view’s', () => {
    const r = sheetViews(COLUMNS, ctx, [{ id: 'pricing', label: 'Pricing', columnKeys: ['basePrice'] }])
    expect(r.presets[0].id).toBe(ALL_VIEW_ID)
  })

  it('keeps Required second and offers focused Information presets', () => {
    const ids = sheetViews(COLUMNS, ctx).presets.map((v) => v.id)
    expect(ids).not.toContain('narrow')
    expect(ids).toContain('essentials')
    expect(ids[1]).toBe(REQUIRED_VIEW_ID)
  })
})

describe('sheetViews — complete and focused Information views', () => {
  it('retains evaluated conditional fields in Required after their errors are resolved', () => {
    const columns = [col({ key: 'conditional', group: 'Details', requiredBy: [] })]
    expect(sheetViews(columns, { ...ctx, requiredKeys: ['conditional'], flaggedKeys: [] }).presets.find(view => view.id === REQUIRED_VIEW_ID)?.columns).toEqual(['conditional'])
  })
  it('offers All attributes, Required, Essentials and Localized content from column rules', () => {
    const r = sheetViews(COLUMNS, ctx)
    expect(r.source).toBe('rules')
    expect(r.presets.map((v) => v.id)).toEqual([ALL_VIEW_ID, REQUIRED_VIEW_ID, 'essentials', 'localized-content'])
  })

  it('Required is every column some channel requires on this product type, filled or not, in the §9.2 order', () => {
    const required = sheetViews(COLUMNS, ctx).presets.find((v) => v.id === REQUIRED_VIEW_ID)!
    expect(required.label).toBe('Required')
    const expected = orderColumnKeys(COLUMNS, ctx).filter((k) => COLUMNS.find((c) => c.key === k)!.requiredBy.length > 0)
    expect(required.columns).toEqual(expected)
    expect(required.columns).toEqual(expect.arrayContaining(['brand', 'item_name', 'bullet_point', 'fabric_type', 'country_of_origin']))
    // Filled or not: `brand` is required and (in this fixture) not flagged missing — it is still in the set.
    expect(required.columns).toContain('brand')
  })

  it('🔴 a band column (sku, completeness) is never offered by Required — it is always on screen', () => {
    const cols = [...COLUMNS, col({ key: 'sku', group: 'Identity', storage: 'column', requiredBy: ['Amazon · IT'] })]
    const required = sheetViews(cols, ctx).presets.find((v) => v.id === REQUIRED_VIEW_ID)!
    expect(required.columns).not.toContain('sku')
  })

  it('omits an empty Required set while retaining useful content views', () => {
    const none = COLUMNS.map((c) => ({ ...c, requiredBy: [] }))
    expect(sheetViews(none, ctx).presets.map((v) => v.id)).toEqual([ALL_VIEW_ID, 'essentials', 'localized-content'])
  })

  it('avoids provider group duplication while retaining the Essentials rule', () => {
    const ids = sheetViews(COLUMNS, ctx).presets.map((v) => v.id)
    expect(ids.some((id) => id.startsWith('group:'))).toBe(false)
    expect(ids).not.toContain('localisation')
    // `essentialsColumns` is a tested rule kept for the day the Owner asks for it back.
    expect(essentialsColumns(COLUMNS, ctx)).toEqual(expect.arrayContaining(['color', 'size']))
  })

  /**
   * "Missing required" is a view CHIP, not a preset — it filters rows AND columns, which a column
   * preset cannot express, and the layout draws it as its own control beside the views trigger.
   * Offering both would be two controls for one idea.
   */
  it('does NOT offer missing-required as a preset — the chip owns it', () => {
    expect(sheetViews(COLUMNS, ctx).presets.map((v) => v.id)).not.toContain('missing-required')
  })

  /**
   * Every column is in All attributes — and the sheet lands full anyway, so an operator can never
   * mistake "this product has no such field" for "your view is hiding it".
   */
  it('every column is reachable from SOME view — nothing is orphaned', () => {
    const { presets } = sheetViews(COLUMNS, ctx)
    const reachable = new Set([...presets.flatMap((v) => v.columns), ...ALWAYS_COLUMNS])
    const orphans = COLUMNS.map((c) => c.key).filter((k) => !reachable.has(k))
    expect(orphans).toEqual([])
  })
})

describe('sheetViews — the server wins when it speaks', () => {
  it('uses PES.5’s views verbatim, after All attributes, and says they came from the server', () => {
    const r = sheetViews(COLUMNS, ctx, [{ id: 'pricing', label: 'Pricing', columnKeys: ['basePrice'] }])
    expect(r.source).toBe('server')
    expect(r.presets.slice(1)).toEqual([{ id: 'pricing', label: 'Pricing', columns: ['basePrice'] }])
  })

  it('an EMPTY server list is not an answer — the rules still run', () => {
    const r = sheetViews(COLUMNS, ctx, [])
    expect(r.source).toBe('rules')
    expect(r.presets.length).toBeGreaterThan(1)
  })
})

describe('rowIsMissingRequired', () => {
  it('reads the server’s own missing[] so the filter and the readiness pill cannot disagree', () => {
    expect(rowIsMissingRequired({ completeness: { required: { missing: [{ key: 'brand', label: 'Brand' }] } } })).toBe(true)
    expect(rowIsMissingRequired({ completeness: { required: { missing: [] } } })).toBe(false)
  })

  it('a row with no completeness block is not claimed to be missing anything', () => {
    expect(rowIsMissingRequired({})).toBe(false)
    expect(rowIsMissingRequired({ completeness: {} })).toBe(false)
  })
})

describe('alwaysColumnsFor — the guarantee resolved against columns that exist (#770)', () => {
  it('🔴 drops the band contents when the grid has no such columns', () => {
    // `sku` became the identity band's key line and `completeness` its readiness pill, so neither is
    // built. Asking for them made the prefs bridge refuse two columns on EVERY master load.
    expect(alwaysColumnsFor([IDENTITY_COLUMN, 'brand', 'name'])).toEqual(['product'])
  })

  it('🔴 keeps them the moment they exist again — the point of deriving rather than trimming', () => {
    // A constant trimmed to ['product'] would silently stop guaranteeing them if they came back.
    expect(alwaysColumnsFor(['product', 'sku', 'completeness', 'brand'])).toEqual(['product', 'sku', 'completeness'])
    expect(alwaysColumnsFor(['product', 'completeness'])).toEqual(['product', 'completeness'])
  })

  it('an empty addressable set yields nothing rather than inventing an id', () => {
    expect(alwaysColumnsFor([])).toEqual([])
  })

  it('preserves the intent order, not the caller order', () => {
    expect(alwaysColumnsFor(['completeness', 'sku', 'product'])).toEqual([...ALWAYS_COLUMNS])
  })
})
