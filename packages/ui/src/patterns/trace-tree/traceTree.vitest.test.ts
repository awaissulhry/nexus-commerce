import { createElement as h, type ReactNode } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TraceTree, type TraceNode } from './TraceTree'
import { traceCheck, traceDefaultOpen, traceFind, traceLevels, traceMove, traceReach, traceRows, traceToggle } from './traceTreeModel'

/** B-W2b-09 — TraceTree: a genealogy tree walked by keyboard, ticked by branch, counted honestly. */
const TREE: TraceNode[] = [
  {
    id: 'lot', kind: 'Lot', label: 'L-0042', href: '/warehouse/lots/1',
    children: [
      { id: 'h1', kind: 'Hide', label: 'H-1', children: [{ id: 'b1', kind: 'Bundle', label: 'B-1' }, { id: 'b2', kind: 'Bundle', label: 'B-2', possible: true }] },
      { id: 'h2', kind: 'Hide', label: 'H-2', held: 'Already shipped', children: [{ id: 'b3', kind: 'Bundle', label: 'B-3' }] },
    ],
  },
]
const Link = ({ href, children, ...rest }: { href: string; children?: ReactNode }) => h('a', { href, ...rest }, children)

describe('traceTreeModel', () => {
  it('opens to the default depth and lists the visible rows', () => {
    const open = traceDefaultOpen(TREE, 2)
    expect([...open]).toEqual(['lot'])
    expect(traceRows(TREE, open).map((row) => [row.node.id, row.depth, row.posInSet, row.setSize])).toEqual([['lot', 1, 1, 1], ['h1', 2, 1, 2], ['h2', 2, 2, 2]])
    expect(traceRows(TREE, new Set(['lot', 'h1'])).map((row) => row.node.id)).toEqual(['lot', 'h1', 'b1', 'b2', 'h2'])
  })
  it('walks like a WAI-ARIA tree', () => {
    const rows = traceRows(TREE, new Set(['lot']))
    expect(traceMove(rows, 'lot', 'ArrowDown')).toEqual({ focus: 'h1', toggle: null })
    expect(traceMove(rows, 'h1', 'ArrowRight')).toEqual({ focus: 'h1', toggle: 'h1' })
    expect(traceMove(rows, 'h1', 'ArrowLeft')).toEqual({ focus: 'lot', toggle: null })
    expect(traceMove(rows, 'lot', 'ArrowLeft')).toEqual({ focus: 'lot', toggle: 'lot' })
    expect(traceMove(rows, 'lot', 'End')).toEqual({ focus: 'h2', toggle: null })
    expect(traceMove(rows, 'h2', 'Home')).toEqual({ focus: 'lot', toggle: null })
    expect(traceMove([], 'x', 'ArrowDown')).toEqual({ focus: 'x', toggle: null })
  })
  it('ticks a branch with everything under it, skipping held branches, and shows mixed', () => {
    expect(traceReach(TREE[0]!)).toEqual(['lot', 'h1', 'b1', 'b2'])
    const all = traceToggle(TREE[0]!, [])
    expect(new Set(all)).toEqual(new Set(['lot', 'h1', 'b1', 'b2']))
    expect(traceCheck(TREE[0]!, new Set(all))).toBe('checked')
    expect(traceToggle(TREE[0]!, all)).toEqual([])
    const h1 = traceFind(TREE, 'h1')!
    expect(traceCheck(h1, new Set(['b1']))).toBe('mixed')
    expect(traceCheck(TREE[0]!, new Set(['b1']))).toBe('mixed')
    const h2 = traceFind(TREE, 'h2')!
    expect(traceToggle(h2, ['b1'])).toEqual(['b1'])
  })
  it('counts the levels, exact and "may hold it" apart', () => {
    expect(traceLevels(TREE)).toEqual([
      { id: 'Lot', count: 1, possible: 0 },
      { id: 'Hide', count: 2, possible: 0 },
      { id: 'Bundle', count: 2, possible: 1 },
    ])
  })
})

describe('TraceTree', () => {
  it('draws a tree with one Tab stop, the record link and the levels', () => {
    const html = render(h(TraceTree, { roots: TREE, label: 'Trace of lot L-0042', levels: [{ id: 'garments', label: '12 garments', possible: 3 }], linkAs: Link }))
    expect(html).toContain('role="tree" aria-label="Trace of lot L-0042"')
    // One Tab stop among the rows (the keys' information icon under the tree is its own stop).
    expect(html.match(/role="treeitem"[^>]*tabindex="0"/g)).toHaveLength(1)
    expect(html.match(/role="treeitem"[^>]*tabindex="-1"/g)).toHaveLength(2)
    expect(html).toContain('href="/warehouse/lots/1"')
    expect(html).toContain('3 may hold it')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('Already shipped')
    expect(html).toContain('aria-label="Keys:')
  })
  it('says the reach and marks mixed branches when it takes a selection', () => {
    const html = render(h(TraceTree, { roots: TREE, label: 'Reach', selection: { selected: ['b1'], onChange: () => {} }, linkAs: Link }))
    expect(html).toContain('aria-checked="mixed"')
    expect(html).toContain('1 selected')
    expect(html).toContain('aria-description="Already shipped"')
  })
  it('shows the empty words without roots', () => {
    expect(render(h(TraceTree, { roots: [], label: 'Trace', labels: { empty: 'Niente da mostrare' } }))).toContain('Niente da mostrare')
  })
})
