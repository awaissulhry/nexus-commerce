import { describe, it, expect } from 'vitest'
import type { SheetTone } from '@nexus/shared/sheet-groups'
import { insertInNaturalOrder, sheetHeaderClasses, withGroupHeaderClass, withNewColumnsShown, withSheetGroups, SHEET_MEDIA_COLUMN, type SheetHeaderClassParams } from './sheetGroups'
import { sheetLayoutPayload, columnsViewPayload } from '@/design-system/grid/views/viewPayload'

const col = (key: string, groupKey: string, group: string, groupTone?: SheetTone, managedBy?: string, sourceGroupKey?: string) =>
  ({ key, group, groupKey, ...(groupTone ? { groupTone } : {}), ...(managedBy ? { managedBy } : {}), ...(sourceGroupKey ? { sourceGroupKey } : {}) })

/** A Shared sheet as the server now sends it (sheet groups), plus the columns the web adds. */
const shared = [
  col('progress:scope', 'progress', 'Progress', undefined, 'progress'),
  col('variation_theme', 'sheet:offer-identity', 'Offer Identity', 'slate'),
  col('__productRole', 'sheet:offer-identity', 'Offer Identity', 'slate'),
  col('basePrice', 'sheet:offer', 'Offer', 'emerald'),
  col('description', 'sheet:product-details', 'Product Details', 'blue'),
  col(SHEET_MEDIA_COLUMN, 'media', 'Media'),
  col('name@it', 'language:name', 'Name', 'blue', undefined, 'sheet:product-details'),
  col('material', 'sheet:product-details', 'Product Details', 'blue'),
]

describe('withSheetGroups', () => {
  it('puts Progress at the front of Offer Identity and Product media in Images, in the groups\' order', () => {
    const out = withSheetGroups(shared)
    expect(out.map((c) => c.key)).toEqual(['progress:scope', 'variation_theme', '__productRole', 'basePrice', SHEET_MEDIA_COLUMN, 'description', 'name@it', 'material'])
    expect(out[0]).toMatchObject({ group: 'Offer Identity', groupKey: 'sheet:offer-identity', groupTone: 'slate' })
    expect(out.find((c) => c.key === SHEET_MEDIA_COLUMN)).toMatchObject({ group: 'Images', groupKey: 'sheet:images', groupTone: 'pink' })
  })

  it('keeps a language column with its field\'s group, and is idempotent', () => {
    const once = withSheetGroups(shared)
    expect(once.find((c) => c.key === 'name@it')?.groupKey).toBe('language:name')
    expect(withSheetGroups(once)).toEqual(once)
  })

  it('leaves a sheet the server did not group as it is', () => {
    const old = [col('progress:scope', 'progress', 'Progress', undefined, 'progress'), col('description', 'master:content', 'Content')]
    expect(withSheetGroups(old)).toEqual(old)
  })
})

describe('withNewColumnsShown (Owner, 2026-10-01: a column the layout has never seen shows in its group)', () => {
  const saved = sheetLayoutPayload({ columns: ['price', 'name'], columnOrder: ['price', 'name', 'hiddenOne'], lockedColumns: ['price'], groupOrder: ['progress', 'EBAY:offer'], groupOverrides: { name: 'EBAY:offer' } })
  const specs = [{ key: 'identity', locked: true }, { key: 'price' }, { key: 'name' }, { key: 'hiddenOne' }, { key: 'brandNew' }]

  it('shows a never-seen column and keeps everything saved — order, pins, hidden columns and group moves', () => {
    const out = withNewColumnsShown(saved, specs)
    expect(out.columns).toEqual(['price', 'name', 'brandNew'])
    expect(out).toMatchObject({ columnOrder: ['price', 'name', 'hiddenOne'], lockedColumns: ['price'], groupOrder: ['progress', 'EBAY:offer'], groupOverrides: { name: 'EBAY:offer' } })
  })

  it('keeps a column the operator hid hidden, and returns the same layout when nothing is new', () => {
    expect(withNewColumnsShown(saved, specs).columns).not.toContain('hiddenOne')
    expect(withNewColumnsShown(saved, specs.filter((c) => c.key !== 'brandNew'))).toBe(saved)
    const plain = columnsViewPayload(['name'])
    expect(withNewColumnsShown(plain, specs)).toBe(plain)
  })
})

describe('insertInNaturalOrder', () => {
  const natural = ['name', 'conditionId', 'categoryId', 'variation_theme', 'subtitle', 'description']
  it('seats the variation theme after the last key that comes before it', () => {
    expect(insertInNaturalOrder(['name', 'categoryId', 'subtitle', 'description'], ['variation_theme'], natural)).toEqual(['name', 'categoryId', 'variation_theme', 'subtitle', 'description'])
  })
  it('puts it first when nothing before it is shown, and never twice', () => {
    expect(insertInNaturalOrder(['description'], ['variation_theme'], natural)).toEqual(['variation_theme', 'description'])
    expect(insertInNaturalOrder(['variation_theme', 'name'], ['variation_theme'], natural)).toEqual(['name', 'variation_theme'])
  })
})

describe('the header classes', () => {
  const groups: Record<string, { group: string; tone?: string }> = {
    a: { group: 'sheet:listing', tone: 'blue' }, b: { group: 'sheet:listing', tone: 'blue' }, c: { group: 'sheet:content', tone: 'purple' },
  }
  const order = ['identity', 'a', 'b', 'c']
  const column = (id: string) => ({ getColId: () => id })
  const params = (id: string) => ({
    column: column(id),
    api: { getDisplayedColBefore: (c: { getColId: () => string }) => { const i = order.indexOf(c.getColId()); return i > 0 ? column(order[i - 1]) : null } },
  }) as unknown as SheetHeaderClassParams
  const groupOf = (id: string) => groups[id]

  it('tints a column name with its group, and marks where a group starts', () => {
    expect(sheetHeaderClasses(params('a'), groupOf)).toEqual(['nds-ag-head-tone', 'nds-ag-head-tone--blue', 'nds-ag-head-tone--start'])
    expect(sheetHeaderClasses(params('b'), groupOf)).toEqual(['nds-ag-head-tone', 'nds-ag-head-tone--blue'])
    expect(sheetHeaderClasses(params('c'), groupOf)).toEqual(['nds-ag-head-tone', 'nds-ag-head-tone--purple', 'nds-ag-head-tone--start'])
  })

  it('leaves a column outside every group (the identity column) as it is', () => {
    expect(sheetHeaderClasses(params('identity'), groupOf)).toEqual([])
  })

  it('keeps a column\'s own header class, also inside a language group', () => {
    const defs = withGroupHeaderClass([{ colId: 'a', headerClass: 'nds-ag-head-num' }, { groupId: 'language:name', children: [{ colId: 'b' }] }], () => ['mine'])
    const p = params('a')
    expect((defs[0] as { headerClass: (x: SheetHeaderClassParams) => string[] }).headerClass(p)).toEqual(['nds-ag-head-num', 'mine'])
    const child = (defs[1] as { children: Array<{ headerClass: (x: SheetHeaderClassParams) => string[] }> }).children[0]
    expect(child.headerClass(p)).toEqual(['mine'])
  })
})
