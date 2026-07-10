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
