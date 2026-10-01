import { describe, it, expect } from 'vitest'
import type { SheetTone } from '@nexus/shared/sheet-groups'
import { insertInNaturalOrder, sheetHeaderClasses, withGroupHeaderClass, withoutPreGroupingOrder, withSheetGroups, SHEET_MEDIA_COLUMN, type SheetHeaderClassParams } from './sheetGroups'
import { sheetLayoutPayload, columnsViewPayload } from '@/design-system/grid/views/viewPayload'

const col = (key: string, groupKey: string, group: string, groupTone?: SheetTone, managedBy?: string) => ({ key, group, groupKey, ...(groupTone ? { groupTone } : {}), ...(managedBy ? { managedBy } : {}) })

/** An eBay sheet as the server now sends it (flat-file groups), plus the columns the web adds. */
const ebay = [
  col('progress:scope', 'progress', 'Progress', undefined, 'progress'),
  col('__productRole', 'sheet:identifiers', 'Identifiers', 'slate'),
  col('__parentSku', 'sheet:identifiers', 'Identifiers', 'slate'),
  col('name', 'sheet:listing', 'Listing', 'blue'),
  col('description', 'sheet:content', 'Content', 'purple'),
  col(SHEET_MEDIA_COLUMN, 'media', 'Media'),
  col('price', 'sheet:pricing', 'Pricing', 'emerald'),
  col('imageUrls', 'sheet:images', 'Images', 'teal'),
  col('videoId', 'sheet:images', 'Images', 'teal'),
  col('brand', 'sheet:item-specifics', 'Item Specifics', 'teal'),
]

describe('withSheetGroups', () => {
  it('puts Progress in the first group and Product media at the front of Images, in their colours', () => {
    const out = withSheetGroups(ebay)
    expect(out.map((c) => c.key)).toEqual(['progress:scope', '__productRole', '__parentSku', 'name', 'description', 'price', SHEET_MEDIA_COLUMN, 'imageUrls', 'videoId', 'brand'])
    expect(out[0]).toMatchObject({ group: 'Identifiers', groupKey: 'sheet:identifiers', groupTone: 'slate' })
    expect(out.find((c) => c.key === SHEET_MEDIA_COLUMN)).toMatchObject({ group: 'Images', groupKey: 'sheet:images', groupTone: 'teal' })
  })

  it('is idempotent', () => {
    const once = withSheetGroups(ebay)
    expect(withSheetGroups(once)).toEqual(once)
  })

  it('leaves a sheet the flat file never grouped (Shared, Shopify) in place, colouring each group by what it holds', () => {
    const shared = [col('progress:scope', 'progress', 'Progress', undefined, 'progress'), col('description', 'master:content', 'Content'), col(SHEET_MEDIA_COLUMN, 'media', 'Media')]
    const out = withSheetGroups(shared)
    expect(out.map((c) => [c.key, c.groupKey, c.groupTone])).toEqual([['progress:scope', 'progress', 'slate'], ['description', 'master:content', 'purple'], [SHEET_MEDIA_COLUMN, 'media', 'teal']])
  })
})

describe('withoutPreGroupingOrder', () => {
  const old = sheetLayoutPayload({ columns: ['price', 'name'], columnOrder: ['price', 'name'], lockedColumns: ['price'], groupOrder: ['progress', 'variation-theme', 'EBAY:offer', 'EBAY:content'], groupOverrides: { name: 'EBAY:offer' } })

  it('keeps an old layout\'s columns and pins but drops its order and group moves, on a flat-file sheet', () => {
    const out = withoutPreGroupingOrder(old, true)
    expect(out).toMatchObject({ columns: ['price', 'name'], lockedColumns: ['price'], columnOrder: [], groupOrder: [], groupOverrides: {} })
  })

  it('keeps a layout saved since the regrouping, a layout on any other sheet, and a plain view as they are', () => {
    const since = sheetLayoutPayload({ columns: ['name'], columnOrder: ['name'], lockedColumns: [], groupOrder: ['sheet:identifiers', 'sheet:listing'], groupOverrides: {} })
    expect(withoutPreGroupingOrder(since, true)).toBe(since)
    expect(withoutPreGroupingOrder(old, false)).toBe(old)
    const plain = columnsViewPayload(['name'])
    expect(withoutPreGroupingOrder(plain, true)).toBe(plain)
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
