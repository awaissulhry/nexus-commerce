import { describe, expect, it } from 'vitest'
import { filterRows } from './filterRows'
import type { FilterState, GridColumn, GridFilter } from './WorkspaceGrid'

type Row = { id: string; acos: number; state: string }

const ROWS: Row[] = [
  { id: 'a', acos: 10, state: 'ENABLED' },
  { id: 'b', acos: 50, state: 'PAUSED' },
  { id: 'c', acos: NaN, state: 'ENABLED' }, // never measured
]
const ids = (rs: Row[]) => rs.map((r) => r.id).join(',')

const RANGE: GridFilter = { key: 'acos', label: 'ACoS', kind: 'range', value: (r) => (r as Row).acos }
const SELECT: GridFilter = {
  key: 'state', label: 'State', kind: 'select',
  options: [{ value: 'ENABLED', label: 'Enabled' }, { value: 'PAUSED', label: 'Paused' }],
  value: (r) => (r as Row).state,
}
const MULTI: GridFilter = { ...SELECT, kind: 'multiselect' } as GridFilter

const run = (filters: GridFilter[], fstate: FilterState, columns: GridColumn<Row>[] = []) =>
  filterRows(ROWS, filters, fstate, columns)

describe('filterRows — an empty filter is not a filter', () => {
  it('returns every row when no filters are declared', () => {
    expect(ids(filterRows(ROWS, undefined, {}, []))).toBe('a,b,c')
    expect(ids(filterRows(ROWS, [], {}, []))).toBe('a,b,c')
  })

  it('ignores a range with neither bound, rather than excluding everything', () => {
    expect(ids(run([RANGE], { acos: { min: '', max: '' } }))).toBe('a,b,c')
  })

  it('ignores an empty multiselect and an unset select', () => {
    expect(ids(run([MULTI], { state: [] }))).toBe('a,b,c')
    expect(ids(run([SELECT], { state: '' }))).toBe('a,b,c')
  })
})

describe('filterRows — NaN is "not measured" and must never match a SET range', () => {
  // The regression these three guard against: NaN compares false in BOTH directions, so a
  // range check written the obvious way lets an unmeasured row through instead of excluding it.
  it('drops the unmeasured row from a min-only range', () => {
    expect(ids(run([RANGE], { acos: { min: '5', max: '' } }))).toBe('a,b')
  })

  it('drops it from a max-only range too — the direction must not matter', () => {
    expect(ids(run([RANGE], { acos: { min: '', max: '100' } }))).toBe('a,b')
  })

  it('drops it even from a range that spans every measured value', () => {
    expect(ids(run([RANGE], { acos: { min: '0', max: '999' } }))).toBe('a,b')
  })
})

describe('filterRows — range bounds', () => {
  it('applies min and max inclusively', () => {
    expect(ids(run([RANGE], { acos: { min: '10', max: '10' } }))).toBe('a')
    expect(ids(run([RANGE], { acos: { min: '11', max: '' } }))).toBe('b')
    expect(ids(run([RANGE], { acos: { min: '', max: '49' } }))).toBe('a')
  })
})

describe('filterRows — a filter with no accessor is inert, not fatal', () => {
  it('skips a range whose filter has no value fn and no matching column', () => {
    const noAcc: GridFilter = { key: 'acos', label: 'ACoS', kind: 'range' }
    expect(ids(run([noAcc], { acos: { min: '5', max: '9' } }))).toBe('a,b,c')
  })

  it('falls back to the matching column filterValue when the filter has none', () => {
    const noAcc: GridFilter = { key: 'acos', label: 'ACoS', kind: 'range' }
    const col = { key: 'acos', label: 'ACoS', filterValue: (r: Row) => r.acos } as GridColumn<Row>
    expect(ids(run([noAcc], { acos: { min: '', max: '20' } }, [col]))).toBe('a')
  })
})

describe('filterRows — select and multiselect', () => {
  it('keeps only exact matches for select', () => {
    expect(ids(run([SELECT], { state: 'ENABLED' }))).toBe('a,c')
    expect(ids(run([SELECT], { state: 'PAUSED' }))).toBe('b')
  })

  it('keeps any listed value for multiselect', () => {
    expect(ids(run([MULTI], { state: ['PAUSED'] }))).toBe('b')
    expect(ids(run([MULTI], { state: ['ENABLED', 'PAUSED'] }))).toBe('a,b,c')
  })
})

describe('filterRows — filters compose with AND', () => {
  it('requires every active filter to pass', () => {
    expect(ids(run([RANGE, SELECT], { acos: { min: '0', max: '20' }, state: 'ENABLED' }))).toBe('a')
    expect(ids(run([RANGE, SELECT], { acos: { min: '0', max: '20' }, state: 'PAUSED' }))).toBe('')
  })

  it('does not mutate or reorder the input', () => {
    const out = run([SELECT], { state: 'ENABLED' })
    expect(ids(ROWS)).toBe('a,b,c')
    expect(out).not.toBe(ROWS)
  })
})
