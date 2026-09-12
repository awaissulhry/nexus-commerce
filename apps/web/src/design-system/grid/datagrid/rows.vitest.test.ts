import { describe, expect, it } from 'vitest'

import { flattenRows, isSubRow, isTotalRow, selectableKeys, subRowId } from './rows'

interface R { id: string; kids?: R[]; detail?: string | null }
const rowKey = (r: R) => r.id
const A: R = { id: 'a', kids: [{ id: 'a1' }, { id: 'a2' }], detail: 'A' }
const B: R = { id: 'b', kids: [{ id: 'b1' }], detail: null }
const C: R = { id: 'c' }
const getSubRows = (r: R) => r.kids
const renderExpanded = (r: R) => r.detail ?? null

describe('flattenRows — the legacy tbody order (DataGrid.tsx:598-660)', () => {
  it('nothing expanded: the rows, verbatim, every one top-level', () => {
    const f = flattenRows({ rows: [A, B, C], rowKey, getSubRows, renderExpanded })
    expect(f.data).toEqual([A, B, C])
    expect(f.topCount).toBe(3)
    expect([...f.meta.values()].map((m) => [m.id, m.path, m.kind])).toEqual([['a', ['a'], 'row'], ['b', ['b'], 'row'], ['c', ['c'], 'row']])
  })
  it('an open row: the row, then its kids as real rows, then ONE sub row when renderExpanded returns something', () => {
    const f = flattenRows({ rows: [A, B, C], rowKey, expanded: new Set(['a', 'b']), getSubRows, renderExpanded })
    expect(f.data.map((d) => (isSubRow(d) ? `sub:${d.parentKey}` : (d as R).id))).toEqual(['a', 'a1', 'a2', 'sub:a', 'b', 'b1', 'c'])
    const sub = f.data[3]
    expect(isSubRow(sub) && sub.node).toBe('A')
    expect(f.meta.get(f.data[1])).toEqual({ id: 'a1', path: ['a', 'a1'], kind: 'kid', parentKey: 'a' })
    expect(f.meta.get(sub)).toEqual({ id: subRowId('a'), path: ['a', subRowId('a')], kind: 'sub', parentKey: 'a' })
    expect(f.topCount).toBe(3)
  })
  it('a null detail renders no sub row; a row without kids expands to nothing extra', () => {
    const f = flattenRows({ rows: [B, C], rowKey, expanded: new Set(['b', 'c']), getSubRows, renderExpanded })
    expect(f.data.map((d) => (isSubRow(d) ? 'sub' : (d as R).id))).toEqual(['b', 'b1', 'c'])
  })
  it('renderExpanded and getSubRows are consulted only for OPEN rows, in the legacy\'s order (sub first, then kids)', () => {
    const calls: string[] = []
    flattenRows({
      rows: [A, B], rowKey, expanded: new Set(['b']),
      getSubRows: (r) => { calls.push(`kids:${r.id}`); return r.kids },
      renderExpanded: (r) => { calls.push(`sub:${r.id}`); return r.detail ?? null },
    })
    expect(calls).toEqual(['sub:b', 'kids:b'])
  })
  it('the sentinels are distinguishable from any consumer row', () => {
    expect(isSubRow({ __sub: true })).toBe(true)
    expect(isSubRow({ id: 'x' })).toBe(false)
    expect(isTotalRow({ __total: true, v: 1 })).toBe(true)
    expect(isTotalRow(null)).toBe(false)
  })
})

describe('selectableKeys — the legacy allKeys (DataGrid.tsx:481-493), what select-all covers', () => {
  it('every row unless gated; kids never, unless subRowSelectable and the parent is open', () => {
    expect(selectableKeys({ rows: [A, B, C], rowKey })).toEqual(['a', 'b', 'c'])
    expect(selectableKeys({ rows: [A, B, C], rowKey, rowSelectable: (r) => r.id !== 'b' })).toEqual(['a', 'c'])
    expect(selectableKeys({ rows: [A, B, C], rowKey, getSubRows, expanded: new Set(['a']) })).toEqual(['a', 'b', 'c'])
    expect(selectableKeys({ rows: [A, B, C], rowKey, getSubRows, expanded: new Set(['a']), subRowSelectable: true })).toEqual(['a', 'b', 'c', 'a1', 'a2'])
  })
  it('the gate applies to kids exactly as to parents', () => {
    expect(selectableKeys({ rows: [A], rowKey, getSubRows, expanded: new Set(['a']), subRowSelectable: true, rowSelectable: (r) => r.id !== 'a2' })).toEqual(['a', 'a1'])
  })
  it('a closed parent contributes no kids even with subRowSelectable', () => {
    expect(selectableKeys({ rows: [A], rowKey, getSubRows, expanded: new Set(), subRowSelectable: true })).toEqual(['a'])
    expect(selectableKeys({ rows: [A], rowKey, getSubRows, subRowSelectable: true })).toEqual(['a'])
  })
})
