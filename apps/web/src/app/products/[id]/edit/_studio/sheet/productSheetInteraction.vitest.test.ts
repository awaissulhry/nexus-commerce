import { expect, it } from 'vitest'
import { sheetEventColumn } from './useProductSheetInteraction'

it('ignores bare restored column IDs in channel focus events, preserving the drawer anchor', () => {
  expect(sheetEventColumn('__productRole')).toBeUndefined()
  expect(sheetEventColumn('__productRole', true)).toBe('__productRole')
})
it('recognises actual column focus on both scopes and safely ignores cleared focus', () => {
  const column = { getColId: () => 'name' }
  expect(sheetEventColumn(column)).toBe('name')
  expect(sheetEventColumn(column, true)).toBe('name')
  expect(sheetEventColumn(null)).toBeUndefined()
  expect(sheetEventColumn(undefined)).toBeUndefined()
})
