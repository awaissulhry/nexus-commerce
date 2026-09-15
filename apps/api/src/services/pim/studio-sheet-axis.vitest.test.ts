/**
 * P11 — the `axis` marker on a sheet column.
 *
 * ⚠ This test uses a CONSTRUCTED family, and that is legitimate HERE for a
 * reason worth stating, because a self-authored fixture is exactly what hid a
 * defect for an hour earlier today (#700: a listing fixture shaped like my
 * assumption, when the value lives in a COLUMN). The difference is what the
 * fixture is being asked to prove:
 *
 *   - A fixture CANNOT establish where a writer stores data, or what a client
 *     puts on the wire. Those are facts about other code, and only the schema,
 *     a real row, or a capture can settle them.
 *   - A fixture CAN establish a DERIVATION: given these axes and these columns,
 *     which columns are marked. That is a claim about this function alone, and
 *     the inputs are the test's to choose.
 *
 * The axis KEYS below (`Color`/`Size` stored, `Colore`/`Taglia` declared) are
 * not invented — they are the real shape measured on GALE-JACKET, where the
 * label/key split is what made a substring matcher find `color` by luck and
 * miss `size` entirely.
 *
 * Run: npx vitest run src/services/pim/studio-sheet-axis.vitest.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const channelFetch = vi.hoisted(() => {
  const fetch = vi.fn(() => { throw new Error('Unexpected outbound channel call') })
  vi.stubGlobal('fetch', fetch)
  return fetch
})

const productFindFirst = vi.fn()
const productFindMany = vi.fn()
const channelListingFindMany = vi.fn()
const aliasFindMany = vi.fn()
const fieldLinkGroupFindMany = vi.fn()
const cellFormulaFindMany = vi.fn()
const getStudioColumns = vi.fn()
const marketplaceFindMany = vi.fn()

vi.mock('../../db.js', () => ({
  default: {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ $executeRaw: async () => 0 }),
    product: {
      findFirst: (...a: unknown[]) => productFindFirst(...a),
      findMany: (...a: unknown[]) => productFindMany(...a),
    },
    channelListing: { findMany: (...a: unknown[]) => channelListingFindMany(...a) },
    productListingAlias: { findMany: (...a: unknown[]) => aliasFindMany(...a) },
    fieldLinkGroup: { findMany: (...a: unknown[]) => fieldLinkGroupFindMany(...a) },
    cellFormula: { findMany: (...a: unknown[]) => cellFormulaFindMany(...a) },
    // LX.F R-LX-13 — LX-era reads this mock predates: the sheet resolves the
    // cross-channel reach from `Marketplace.languages` (`studio-sheet.service.ts:1058`).
    marketplace: { findUnique: async () => ({ schemaMapping: null }), findMany: (...a: unknown[]) => marketplaceFindMany(...a) },
  },
}))
vi.mock('./studio-columns.js', () => ({
  getStudioColumns: (...a: unknown[]) => getStudioColumns(...a),
}))
vi.mock('./product-category-context.js', () => ({ productCategoryContext: async () => ({ connectionId: 'account', categories: ['OUTERWEAR'], defaults: {} }) }))
vi.mock('./mapping/index.js', () => ({ resolveChannelValues: async () => ({ byProduct: {}, categoryByProduct: {}, missingProductIds: [], meta: {} }) }))

import { getStudioSheet, axisValuesFromCells } from './studio-sheet.service.js'
import { writerAcceptsField } from './master-field-gate.js'
import { PARENT_SKU_COLUMN, PRODUCT_ROLE_COLUMN } from '@nexus/shared/master-sheet'

const PARENT = 'p_parent'
const col = (key: string, scope: 'global' | 'per_variant') => ({
  key,
  writeField: key,
  label: key.toUpperCase(),
  group: 'Identity',
  kind: 'text',
  storage: 'column',
  scope,
  requiredBy: [],
  editable: true,
  defaultVisible: true,
})

beforeEach(() => {
  channelFetch.mockClear()
  for (const m of [productFindFirst, productFindMany, channelListingFindMany, aliasFindMany, fieldLinkGroupFindMany, cellFormulaFindMany, getStudioColumns, marketplaceFindMany]) m.mockReset()
  productFindFirst.mockResolvedValue({ id: PARENT, parentId: null })
  productFindMany.mockResolvedValue([
    { id: PARENT, sku: 'FAM', isParent: true, parentId: null, productType: 'OUTERWEAR',
      // The real split: DECLARED labels are localised, values are STORED under
      // different keys. This is what defeats a substring matcher.
      variationAxes: ['Colore', 'Taglia'], variantAttributes: {}, categoryAttributes: {} },
    { id: 'v1', sku: 'FAM-1', isParent: false, parentId: PARENT, productType: 'OUTERWEAR',
      variationAxes: [], variantAttributes: { Color: 'Nero', Size: '3XL' }, categoryAttributes: {} },
  ])
  marketplaceFindMany.mockResolvedValue([{ channel: 'AMAZON', code: 'IT', languages: ['it'], language: 'it' }])
  channelListingFindMany.mockResolvedValue([])
  aliasFindMany.mockResolvedValue([])
  fieldLinkGroupFindMany.mockResolvedValue([])
  cellFormulaFindMany.mockResolvedValue([])
  // LX.F R-LX-13 — `coordinates` is a REQUIRED field of the real column set
  // (`sheet-columns.service.ts:216`), and LX's `readinessCoord` reads it
  // (`studio-sheet.service.ts:1148`). A mock that omits it crashed the sheet.
  getStudioColumns.mockResolvedValue({
    columns: [col('sku', 'per_variant'), col('color', 'per_variant'), col('size', 'per_variant'), col('brand', 'global')],
    coordinates: [],
  })
})

describe('shared product relationships', () => {
  it.each([['AMAZON', true], ['EBAY', false], ['WOOCOMMERCE', false], ['SHOPIFY', false]] as const)(
    'reports whether %s honours the stored offer control', async (channel, honoured) => {
      marketplaceFindMany.mockResolvedValue([{ channel, code: 'IT', languages: ['it'], language: 'it' }])
      getStudioColumns.mockResolvedValue({ columns: [col('brand', 'global')], coordinates: [
        { channel, marketplace: 'IT', label: `${channel} · IT`, inMarket: true, languages: ['it'] },
      ] })
      channelListingFindMany.mockResolvedValue([{
        id: 'listed-parent', productId: PARENT, channel, marketplace: 'IT', channelConnectionId: 'account',
        aliasKey: '', aliasId: null, offerActive: true, listingStatus: 'ACTIVE', isPublished: true, version: 5,
        offerClosedAt: new Date('2026-09-13T12:00:00.000Z'), offerClosedBy: 'session-user', offerCloseReason: 'Fixture', syncPaused: channel === 'AMAZON',
      }])
      const sheet = await getStudioSheet({ productId: PARENT, scope: 'channel', channel, market: 'IT', locale: 'it' })
      expect(sheet.rows.find(row => row.isParent && row.aliasId === null)?.listing)
        .toMatchObject({ id: 'listed-parent', offerActive: true, offerActiveHonoured: honoured })
      expect(sheet.rows.find(row => row.isParent && row.aliasId === null)?.listing).toMatchObject({
        offerClosedAt: '2026-09-13T12:00:00.000Z', offerClosedBy: 'session-user', offerCloseReason: 'Fixture', syncPaused: channel === 'AMAZON',
      })
      expect(channelListingFindMany.mock.calls.some(([query]) => ['offerClosedAt', 'offerClosedBy', 'offerCloseReason', 'syncPaused'].every(field => query.select?.[field] === true))).toBe(true)
      expect(sheet.rows.find(row => !row.isParent && row.aliasId === null)?.listing).toBeNull()
      expect(sheet.rows.find(row => row.isParent && row.aliasId === null)?.listing?.channelFactDetail).toBeUndefined()
      expect(channelFetch).not.toHaveBeenCalled()
    },
  )

  it('projects the same parent and child relationship under every listing alias', async () => {
    aliasFindMany.mockResolvedValue([{ id: 'outlet', label: 'Outlet', position: 1, status: 'ACTIVE' }])
    getStudioColumns.mockResolvedValue({ columns: [col('brand', 'global')], coordinates: [{ channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT', inMarket: true, languages: ['it'] }] })
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'channel', channel: 'AMAZON', market: 'IT', locale: 'it' })
    expect(sheet.rows).toHaveLength(4)
    for (const aliasId of [null, 'outlet']) {
      const rows = sheet.rows.filter(row => row.aliasId === aliasId)
      expect(rows.map(row => [row.productRole, row.values[PRODUCT_ROLE_COLUMN].value, row.values[PARENT_SKU_COLUMN].value]))
        .toEqual([['parent', 'Parent', null], ['child', 'Child', 'FAM']])
    }
    expect(sheet.columns.find(col => col.key === PARENT_SKU_COLUMN)).toMatchObject({ editable: false, writable: false, affectsAllChannels: false, formulaWritable: false })
    expect(productFindMany).toHaveBeenCalledOnce()
  })

  it('serves parent names and roles without changing completeness, validation or query count', async () => {
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'master', market: 'IT', locale: 'it' } as never)
    const [parent, variant] = sheet.rows
    expect(parent).toMatchObject({ productRole: 'parent', parentSku: null, isParent: true })
    expect(variant).toMatchObject({ productRole: 'child', parentSku: 'FAM', isParent: false })
    expect(parent.values[PRODUCT_ROLE_COLUMN].value).toBe('Parent')
    expect(variant.values[PARENT_SKU_COLUMN].value).toBe('FAM')
    expect(parent.values[PARENT_SKU_COLUMN].value).toBeNull()
    for (const row of sheet.rows) {
      for (const key of [PRODUCT_ROLE_COLUMN, PARENT_SKU_COLUMN]) {
        expect(row.values[key]).toMatchObject({ editable: false, writable: false, inherited: false, pinned: false })
        expect(row.readiness.issues.some(issue => issue.key === key)).toBe(false)
      }
    }
    // Four fixture attributes; only brand applies on a parent. Relationship fields do not inflate them.
    expect(parent.completeness.overall.total).toBe(1)
    expect(variant.completeness.overall.total).toBe(4)
    expect(productFindFirst).toHaveBeenCalledOnce()
    expect(productFindMany).toHaveBeenCalledOnce()
  })

  it.each([[false, 'standalone', 'Standalone'], [true, 'parent', 'Parent']] as const)('distinguishes a childless root with isParent=%s', async (isParent, role, label) => {
    productFindMany.mockResolvedValue([{ id: PARENT, sku: 'SINGLE', isParent, parentId: null, productType: null, variationAxes: [], variantAttributes: {}, categoryAttributes: {} }])
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'master', market: 'IT', locale: 'it' } as never)
    expect(sheet.rows[0]).toMatchObject({ productRole: role, parentSku: null })
    expect(sheet.rows[0].values[PRODUCT_ROLE_COLUMN].value).toBe(label)
    expect(sheet.rows[0].values[PARENT_SKU_COLUMN].value).toBeNull()
  })
})

describe('#756 — formulaWritable', () => {
  // The assertions compare against the IMPORTED gate, never a copied literal.
  // #775 replaced the twelve-scalar list with the writer's own gate, so these
  // followed automatically — which is what importing rather than restating buys.
  it('a master-routed column is writable exactly when the writer\'s gate says so', async () => {
    getStudioColumns.mockResolvedValue({
      columns: [col('brand', 'global'), col('weave_type', 'global'), col('manufacturer', 'global'), col('waterproofRating', 'global'), col('basePrice', 'global'), col('costPrice', 'global')],
      coordinates: [],
    })
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'master', market: 'IT', locale: 'it' } as never)
    for (const c of sheet.columns) {
      expect({ key: c.key, writable: (c as { formulaWritable?: boolean }).formulaWritable })
        .toEqual({ key: c.key, writable: writerAcceptsField((c as { writeField: string }).writeField) })
    }
    // and the set is doing real work here — not vacuously all-true or all-false
    const flags = sheet.columns.map((c) => (c as { formulaWritable?: boolean }).formulaWritable)
    expect(flags).toContain(true)
    expect(flags).toContain(false)
  })

  it('offers formulas on writable text and price fields', async () => {
    getStudioColumns.mockResolvedValue({ columns: [col('brand', 'global'), col('basePrice', 'global')], coordinates: [] })
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'master', market: 'IT', locale: 'it' } as never)
    const by = Object.fromEntries(sheet.columns.map((c) => [c.key, (c as { formulaWritable?: boolean }).formulaWritable]))
    expect(writerAcceptsField('brand')).toBe(true)
    expect(by.brand).toBe(true)
    expect(by.basePrice).toBe(true)
  })

  it('every column carries the field, so a client never sees undefined', async () => {
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'master', market: 'IT', locale: 'it' } as never)
    expect(sheet.columns.every((c) => typeof (c as { formulaWritable?: boolean }).formulaWritable === 'boolean')).toBe(true)
  })

  it('SENSITIVITY: a key outside the gate is refused even though the column exists', async () => {
    // `sku` is a perfectly real, readable column — the point of the field is
    // that READABLE and FORMULA-WRITABLE are different questions, and the `=`
    // editor was opening on the difference.
    // #775 — `weave_type` is a real column the ordinary writer does NOT accept
    // (not in the master allow-list, not attr_*, not a mapped channel field),
    // so READABLE and FORMULA-WRITABLE remain different questions even after
    // the widening. `sku` is now writable, because an operator can type it.
    getStudioColumns.mockResolvedValue({ columns: [col('weave_type', 'global')], coordinates: [] })
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'master', market: 'IT', locale: 'it' } as never)
    expect((sheet.columns.find(col => col.key === 'weave_type') as { formulaWritable?: boolean }).formulaWritable).toBe(false)
    expect(writerAcceptsField('weave_type')).toBe(false)
    expect(writerAcceptsField('sku')).toBe(true)
  })
})

describe('P11 — axis marker', () => {
  it('allows variant-scoped facts on a standalone sellable product', async () => {
    productFindMany.mockResolvedValue([{ id: PARENT, sku: 'SINGLE', isParent: false, parentId: null, productType: null, variationAxes: [], variantAttributes: {}, categoryAttributes: {} }])
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'master', market: 'IT', locale: 'it' } as never)
    expect(sheet.rows[0].isParent).toBe(false)
    expect(sheet.rows[0].values.size.editable).toBe(true)
  })
  it('marks exactly the per_variant columns whose KEY is a family axis', async () => {
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'master', market: 'IT', locale: 'it' } as never)
    const byKey = Object.fromEntries(sheet.columns.map((c) => [c.key, (c as { axis?: boolean }).axis]))
    expect(byKey).toEqual({ [PRODUCT_ROLE_COLUMN]: false, [PARENT_SKU_COLUMN]: false, sku: false, color: true, size: true, brand: false })
  })

  it('SIZE is matched — the case a substring matcher misses', async () => {
    // 'taglia' (the declared label) shares no substring with 'size' (the stored
    // key), so the label-based rule this replaces returned false here while
    // returning true for `color` purely because 'colore'.includes('color').
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'master', market: 'IT', locale: 'it' } as never)
    const size = sheet.columns.find((c) => c.key === 'size') as { axis?: boolean }
    expect(size.axis).toBe(true)
  })

  it('a per_variant column that is NOT an axis stays false', async () => {
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'master', market: 'IT', locale: 'it' } as never)
    const sku = sheet.columns.find((c) => c.key === 'sku') as { axis?: boolean }
    expect(sku.axis).toBe(false)
  })

  it('SENSITIVITY: change what the family STORES and the marks follow', async () => {
    // Without this, every case above could pass on mocks alone — four
    // assertions about a value the function might be deriving from something
    // else entirely. Here the columns are identical and only the family's
    // stored axis keys change; if `color`/`size` stayed true, the derivation
    // would not be reading the family at all.
    productFindMany.mockResolvedValue([
      { id: PARENT, sku: 'FAM', isParent: true, parentId: null, productType: 'OUTERWEAR',
        variationAxes: ['Materiale'], variantAttributes: {}, categoryAttributes: {} },
      { id: 'v1', sku: 'FAM-1', isParent: false, parentId: PARENT, productType: 'OUTERWEAR',
        variationAxes: [], variantAttributes: { Material: 'Cordura' }, categoryAttributes: {} },
    ])
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'master', market: 'IT', locale: 'it' } as never)
    const byKey = Object.fromEntries(sheet.columns.map((c) => [c.key, (c as { axis?: boolean }).axis]))
    expect(byKey).toEqual({ [PRODUCT_ROLE_COLUMN]: false, [PARENT_SKU_COLUMN]: false, sku: false, color: false, size: false, brand: false })
  })

  it('a GLOBAL column is never an axis, even if its key matches one', async () => {
    // The scope half of the derivation, which no other case exercises: without
    // it, a global column named `color` would be marked.
    getStudioColumns.mockResolvedValue({ columns: [col('color', 'global')], coordinates: [] })
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'master', market: 'IT', locale: 'it' } as never)
    expect((sheet.columns.find(col => col.key === 'color') as { axis?: boolean }).axis).toBe(false)
  })
})


describe('axis identity follows effective cells', () => {
  it('stops treating a removed axis as family identity while retaining other values', () => {
    expect(axisValuesFromCells({ Color: 'Black', Size: 'M' }, ['size'], { color: { value: 'Black' }, size: { value: 'M' } })).toEqual({ Size: 'M' })
    expect(axisValuesFromCells({ Color: 'Black' }, [], { color: { value: 'Black' } })).toEqual({})
  })
  it('uses a saved dictionary edit instead of stale legacy variation labels', () => {
    expect(axisValuesFromCells({ Color: 'Old', Size: 'M' }, ['Colore', 'Taglia'], { color: { value: 'New' }, size: { value: 'L' } }))
      .toEqual({ Color: 'New', Size: 'L' })
  })
  it('honors explicit clearing and mapped destination values', () => {
    expect(axisValuesFromCells({ Color: 'Black', Size: 'M' }, ['color', 'size'], {
      color: { value: null }, size: { value: 'Medium', mapped: { status: 'mapped', value: 'M' } },
    })).toEqual({ Size: 'M' })
  })
  it('preserves unaddressable saved axes and supports numeric custom axes', () => {
    expect(axisValuesFromCells({ Legacy: 'Keep' }, ['Legacy', 'length'], { length: { value: 0 } })).toEqual({ Legacy: 'Keep', length: '0' })
  })
})
