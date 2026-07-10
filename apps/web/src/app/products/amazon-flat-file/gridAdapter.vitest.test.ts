import { describe, it, expect } from 'vitest'
import {
  toGridColumn, buildGridColumnGroups, validateAmazonRows,
  isFbaRow, isFbaManagedCell, amazonGroupKey, fbaBucketFor,
  CATEGORY_GRID_COL,
  type AmazonColumn, type AmazonColumnGroup,
} from './gridAdapter'
import { normalizeCellValue } from '../../../components/flat-file/normalizeCellValue'
import type { BaseRow } from '../../../components/flat-file/FlatFileGrid.types'

const col = (over: Partial<AmazonColumn>): AmazonColumn => ({
  id: 'x', fieldRef: 'x', labelEn: 'X', labelLocal: 'X',
  required: false, kind: 'text', width: 100, ...over,
})

const row = (over: Partial<BaseRow>): BaseRow => ({ _rowId: 'r1', ...over })

// ── Synthetic Follow/Buffer column defs (UFX P3 mapping req #4) ────────────
// The central normalizeCellValue with these defs must enforce exactly what
// normalizeSyntheticCell did at the old page's 6 bulk-write points:
// reject → keep previous (null), case-insensitive canonicalization, min-0 clamp.

describe('synthetic Follow/Buffer defs through the central normalizer', () => {
  const follow = toGridColumn(col({
    id: 'follow', kind: 'enum', options: ['Follow', 'Pinned'], selectionOnly: true,
  }))
  const buffer = toGridColumn(col({ id: 'buffer', kind: 'number' }))

  it('follow: strict enum — canonicalizes case, rejects junk, clears empty', () => {
    expect(follow.enumMode).toBe('strict')
    expect(normalizeCellValue(follow, 'pinned')).toBe('Pinned')
    expect(normalizeCellValue(follow, 'FOLLOW')).toBe('Follow')
    expect(normalizeCellValue(follow, 'junk')).toBeNull() // reject → caller keeps prev
    expect(normalizeCellValue(follow, '')).toBe('')
  })

  it('buffer: number with min 0 — clamps below-min, rejects non-numeric', () => {
    expect(buffer.min).toBe(0)
    expect(normalizeCellValue(buffer, '-3')).toBe('0')
    expect(normalizeCellValue(buffer, '2')).toBe('2')
    expect(normalizeCellValue(buffer, 'abc')).toBeNull()
    expect(normalizeCellValue(buffer, '')).toBe('')
  })
})

describe('toGridColumn', () => {
  it('maps selectionOnly to strict enumMode and keeps open enums open', () => {
    expect(toGridColumn(col({ kind: 'enum', options: ['a'], selectionOnly: true })).enumMode).toBe('strict')
    expect(toGridColumn(col({ kind: 'enum', options: ['a'] })).enumMode).toBe('open')
    expect(toGridColumn(col({ kind: 'text' })).enumMode).toBeUndefined()
  })

  it('carries applicability + required-per-type first-class', () => {
    const g = toGridColumn(col({
      applicableProductTypes: ['SHIRT'], requiredForProductTypes: ['SHIRT'],
      applicableParentage: ['VARIATION_CHILD'],
    }))
    expect(g.applicableProductTypes).toEqual(['SHIRT'])
    expect(g.requiredForProductTypes).toEqual(['SHIRT'])
    expect(g.applicableParentage).toEqual(['VARIATION_CHILD'])
  })

  it('UFX P4d — carries optionsByProductType (per-row-type enum lists)', () => {
    const g = toGridColumn(col({
      kind: 'enum', options: ['a', 'b'],
      optionsByProductType: { JACKET: ['a'], PANTS: ['b'] },
    }))
    expect(g.optionsByProductType).toEqual({ JACKET: ['a'], PANTS: ['b'] })
  })

  it('folds the localized label into the description', () => {
    const g = toGridColumn(col({ labelEn: 'Title', labelLocal: 'Titolo', description: 'The name' }))
    expect(g.description).toBe('Titolo — The name')
  })
})

describe('buildGridColumnGroups', () => {
  const groups: AmazonColumnGroup[] = [{
    id: 'basic', labelEn: 'Basic', labelLocal: 'Base', color: 'blue',
    columns: [
      col({ id: 'item_sku' }),
      col({ id: 'record_action' }),
      col({ id: 'shirt_only', applicableProductTypes: ['SHIRT'] }),
    ],
  }]

  it('splices the read-only Category column right after record_action', () => {
    const out = buildGridColumnGroups(groups)
    expect(out[0].columns.map((c) => c.id)).toEqual(['item_sku', 'record_action', '__category', 'shirt_only'])
    expect(out[0].columns[2]).toBe(CATEGORY_GRID_COL)
    expect(CATEGORY_GRID_COL.readOnly).toBe(true)
  })

  it('filterType narrows to that type + shared/infra columns', () => {
    const out = buildGridColumnGroups(groups, { filterType: 'pants' })
    expect(out[0].columns.map((c) => c.id)).toEqual(['item_sku', 'record_action', '__category'])
  })
})

describe('FBA lock predicates (invariant — never weaken)', () => {
  const fba = row({ fulfillment_availability__fulfillment_channel_code: 'AMAZON_EU' })
  const fbm = row({ fulfillment_availability__fulfillment_channel_code: 'DEFAULT' })

  it('locks quantity + follow + buffer on FBA rows only', () => {
    expect(isFbaRow(fba)).toBe(true)
    expect(isFbaRow(fbm)).toBe(false)
    for (const id of ['fulfillment_availability__quantity', 'follow', 'buffer']) {
      expect(isFbaManagedCell(id, fba)).toBe(true)
      expect(isFbaManagedCell(id, fbm)).toBe(false)
    }
    expect(isFbaManagedCell('item_name', fba)).toBe(false)
  })
})

describe('validateAmazonRows', () => {
  const gridCols = buildGridColumnGroups([{
    id: 'g', labelEn: 'G', labelLocal: 'G', color: 'blue',
    columns: [
      col({ id: 'item_sku', required: true }),
      col({ id: 'item_name', maxUtf8ByteLength: 6 }),
      col({ id: 'shirt_req', required: true, requiredForProductTypes: ['SHIRT'], applicableProductTypes: ['SHIRT'] }),
      col({ id: 'cond', kind: 'enum', options: ['new'] }),
    ],
  }])[0].columns

  it('required + byte-limit + enum-warn + skip delete rows + skip ghosts', () => {
    const issues = validateAmazonRows([
      row({ _rowId: 'a', item_sku: '', product_type: 'SHIRT' }),
      row({ _rowId: 'b', item_sku: 'B', item_name: 'ÀÀÀÀ', cond: 'used' }), // 8 bytes
      row({ _rowId: 'c', item_sku: '', record_action: 'delete' }),
      row({ _rowId: 'd', item_sku: '', _ghost: true }),
    ], gridCols)
    const key = (i: { sku: string; field: string }) => `${i.sku}:${i.field}`
    expect(issues.filter((i) => i.level === 'error').map(key)).toEqual(
      expect.arrayContaining([':item_sku', ':shirt_req', 'B:item_name']),
    )
    expect(issues.find((i) => key(i) === 'B:cond')?.level).toBe('warn')
    // per-type required: row b is not SHIRT (no product_type) → no shirt_req error
    expect(issues.some((i) => key(i) === 'B:shirt_req')).toBe(false)
    // delete + ghost rows produce nothing beyond their absence
    expect(issues.every((i) => i.sku !== 'c' && i.sku !== 'd')).toBe(true)
  })

  // ── UFX P4d — per-row-type validation on a union sheet ────────────────────

  describe('per-row-type checks (union sheet)', () => {
    const unionCols = buildGridColumnGroups([{
      id: 'g', labelEn: 'G', labelLocal: 'G', color: 'blue',
      columns: [
        col({ id: 'item_sku', required: true }),
        // product_type as the union manifest tags it: required for every member type.
        col({ id: 'product_type', required: true, requiredForProductTypes: ['JACKET', 'PANTS'] }),
        col({
          id: 'variation_theme', kind: 'enum', selectionOnly: true,
          options: ['', 'SIZE_COLOR', 'WAIST_LENGTH'],
          applicableProductTypes: ['JACKET', 'PANTS'],
          optionsByProductType: { JACKET: ['SIZE_COLOR'], PANTS: ['WAIST_LENGTH'] },
        }),
        col({
          id: 'style', kind: 'enum', options: ['bomber', 'cargo'],
          applicableProductTypes: ['JACKET', 'PANTS'],
          optionsByProductType: { JACKET: ['bomber'], PANTS: ['cargo'] },
        }),
        col({ id: 'jacket_only', maxLength: 3, applicableProductTypes: ['JACKET'] }),
      ],
    }])[0].columns
    const key = (i: { sku: string; field: string }) => `${i.sku}:${i.field}`

    it('strict enums error per the ROW type; open enums warn; per-type message names the type', () => {
      const issues = validateAmazonRows([
        row({ _rowId: 'a', item_sku: 'A', product_type: 'JACKET', variation_theme: 'SIZE_COLOR', style: 'bomber' }),
        row({ _rowId: 'b', item_sku: 'B', product_type: 'PANTS', variation_theme: 'SIZE_COLOR', style: 'bomber' }),
      ], unionCols)
      // JACKET row: both values valid for its type → clean (modulo the
      // BN.4.3 missing-browse-node advisory, which is orthogonal).
      expect(issues.filter((i) => i.sku === 'A' && i.field !== 'recommended_browse_nodes')).toEqual([])
      // PANTS row: SIZE_COLOR is in the union superset but NOT valid for PANTS.
      const theme = issues.find((i) => key(i) === 'B:variation_theme')
      expect(theme?.level).toBe('error') // selectionOnly → strict → error
      expect(theme?.msg).toContain('PANTS')
      const style = issues.find((i) => key(i) === 'B:style')
      expect(style?.level).toBe('warn')  // open enum → warn
    })

    it('skips content checks on values in columns not applicable to the row type (feed prunes them)', () => {
      const issues = validateAmazonRows([
        row({ _rowId: 'p', item_sku: 'P', product_type: 'PANTS', jacket_only: 'waaay-over-limit' }),
      ], unionCols)
      expect(issues.some((i) => key(i) === 'P:jacket_only')).toBe(false)
      // …but the same value on a JACKET row still errors.
      const issues2 = validateAmazonRows([
        row({ _rowId: 'j', item_sku: 'J', product_type: 'JACKET', jacket_only: 'waaay-over-limit' }),
      ], unionCols)
      expect(issues2.some((i) => key(i) === 'J:jacket_only' && i.level === 'error')).toBe(true)
    })

    it('a real row with NO product_type gets an explicit category prompt (union required lists resolve to nothing)', () => {
      const issues = validateAmazonRows([
        row({ _rowId: 'x', item_sku: 'X', product_type: '' }),
      ], unionCols)
      const pt = issues.find((i) => key(i) === 'X:product_type')
      expect(pt?.level).toBe('error')
      expect(pt?.msg).toMatch(/pick a category/i)
      // ghosts stay silent
      expect(validateAmazonRows([row({ _rowId: 'g', _ghost: true, product_type: '' })], unionCols)).toEqual([])
    })
  })

  it('feed _errorFields + ALA _issueFields + orphan children map to cell issues', () => {
    const issues = validateAmazonRows([
      row({ _rowId: 'a', item_sku: 'A', _status: 'error', _errorFields: ['item_name'], _feedMessage: 'bad name' }),
      row({ _rowId: 'b', item_sku: 'B', _issueFields: ['brand'], _issueSeverity: 'ERROR' }),
      row({ _rowId: 'c', item_sku: 'C', parentage_level: 'child', parent_sku: 'NOPE' }),
    ], gridCols)
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ sku: 'A', field: 'item_name', level: 'error', msg: 'bad name' }),
      expect.objectContaining({ sku: 'B', field: 'brand', level: 'error' }),
      expect.objectContaining({ sku: 'C', field: 'parent_sku', level: 'error' }),
    ]))
  })
})

describe('amazonGroupKey + fbaBucketFor', () => {
  it('families group by parent SKU', () => {
    const parent = row({ _rowId: 'p', parentage_level: 'parent', item_sku: 'PAR' })
    const child = row({ _rowId: 'c', parentage_level: 'child', parent_sku: 'PAR', item_sku: 'PAR-S' })
    const solo = row({ _rowId: 's', item_sku: 'SOLO' })
    expect(amazonGroupKey(parent)).toBe('PAR')
    expect(amazonGroupKey(child)).toBe('PAR')
    expect(amazonGroupKey(solo)).toBe('s')
  })

  it('a parent follows its FBA children; _FBM suffix wins; else channel code', () => {
    const rows: BaseRow[] = [
      row({ _rowId: 'p', parentage_level: 'parent', item_sku: 'PAR' }),
      row({ _rowId: 'c1', parentage_level: 'child', parent_sku: 'PAR', item_sku: 'PAR-S', fulfillment_availability__fulfillment_channel_code: 'AMAZON_EU' }),
      row({ _rowId: 'c2', parentage_level: 'child', parent_sku: 'PAR', item_sku: 'PAR-M_FBM', fulfillment_availability__fulfillment_channel_code: 'AMAZON_EU' }),
      row({ _rowId: 's', item_sku: 'SOLO' }),
    ]
    expect(fbaBucketFor(rows[0], rows)).toBe('FBA')  // parent follows FBA child c1
    expect(fbaBucketFor(rows[1], rows)).toBe('FBA')
    expect(fbaBucketFor(rows[2], rows)).toBe('FBM')  // explicit _FBM mirror SKU
    expect(fbaBucketFor(rows[3], rows)).toBe('FBM')
  })
})
