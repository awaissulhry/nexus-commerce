import { describe, expect, it } from 'vitest'
import { HIDE_TRACE, LARGE_TRACE, LOT_TRACE, OPENING_TRACE } from '../demo/trace/fixtures'
import { traceDefaultOpen, type TraceTreeNode } from '@nexus/ui/patterns/trace-tree/index'
import { countNodes, findOutcome, GROUP_LIMIT, nodeRecord, onlyAffected, TRACE_OPEN_DEPTH, traceAddressOf, traceHref, traceTree, type TreeItem } from './model'

/**
 * The trace tree (B-W2a-64, lt-trace-tree; TraceTree composed): the API's graph as one tree under the start (each node
 * once, under the first node that reaches it, sides kept apart), large levels counted first, the affected-customers
 * filter, the WAI-ARIA tree keys, where a node opens, and the Trace dialog's outcome and address.
 */

const section = (root: TreeItem | null, side: 'BACKWARD' | 'FORWARD') => root?.children.find((item) => item.type === 'section' && item.side === side)
const codes = (items: readonly TreeItem[]): string[] => items.flatMap((item) => (item.type === 'node' ? [item.node.code ?? '?', ...codes(item.children)] : codes(item.children)))

describe('the trace tree', () => {
  it('puts the start on top, came from and went to under it, each node once', () => {
    const root = traceTree(LOT_TRACE)!
    expect(root.type === 'node' && root.node.code).toBe('LOT-D-000101')
    expect(codes(section(root, 'BACKWARD')!.children)).toEqual(['GR-D-0012', 'CONCERIA-DEMO'])
    const forward = codes(section(root, 'FORWARD')!.children)
    expect(new Set(forward).size).toBe(forward.length)
    expect(forward).toContain('BN-D-0101')
    // The bundle cut from the hide hangs under the hide (the first that reaches it), not under its cell.
    const hides = section(root, 'FORWARD')!.children
    const hide = hides.find((item) => item.type === 'node' && item.node.code === 'HD-DEMO-0003')!
    expect(codes(hide.children)).toContain('BN-D-0101')
    const went = section(root, 'FORWARD')!
    expect(went.type === 'section' ? went.count : -1).toBe(countNodes(went.children))
  })

  it('walks a hide backward to its lot and tannery', () => {
    const root = traceTree(HIDE_TRACE)!
    expect(codes(section(root, 'BACKWARD')!.children)).toEqual(['LOT-D-000101', 'GR-D-0012', 'CONCERIA-DEMO'])
  })

  it('counts a large level first: more than the limit of one kind sit in a closed group', () => {
    const root = traceTree(LARGE_TRACE)!
    const groups: TreeItem[] = []
    const walk = (items: readonly TreeItem[]) => items.forEach((item) => (item.type === 'group' ? groups.push(item) : walk(item.children)))
    walk(root.children)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ kind: 'SERIAL', exact: 30, possible: 0 })
    expect(groups[0]!.children.length).toBeGreaterThan(GROUP_LIMIT)
    // The DS tree opens the start and its two sides; a group (a level counted first) stays closed.
    const shape = (item: TreeItem): TraceTreeNode => ({ id: item.id, children: item.children.map(shape) })
    const open = traceDefaultOpen([shape(root)], TRACE_OPEN_DEPTH)
    expect(open.has(root.id)).toBe(true)
    expect(root.children.every((side) => side.children.length === 0 || open.has(side.id))).toBe(true)
    expect(open.has(groups[0]!.id)).toBe(false)
  })

  it('keeps only the branches that reach a customer who received the goods', () => {
    const root = onlyAffected(traceTree(LOT_TRACE)!)
    const forward = codes(section(root, 'FORWARD')!.children)
    expect(forward).toContain('MOTO-ESEMPIO')
    expect(forward).not.toContain('WO-D-0032')
    expect(codes(section(root, 'BACKWARD')!.children)).toEqual(['GR-D-0012', 'CONCERIA-DEMO'])
  })

  it('a lot with nothing behind or ahead of it has empty sides', () => {
    const root = traceTree(OPENING_TRACE)!
    expect(root.children.every((item) => item.children.length === 0)).toBe(true)
  })
})

describe('where a node opens', () => {
  it('opens each kind on its record; a hidden party nowhere', () => {
    const byCode = (code: string | null) => LOT_TRACE.nodes.find((node) => node.code === code)!
    expect(nodeRecord(byCode('HD-DEMO-0003'))).toMatchObject({ type: 'Hide' })
    expect(nodeRecord(byCode('BN-D-0101'))).toMatchObject({ type: 'WorkOrder', tab: 'bundles' })
    expect(nodeRecord(byCode('BLK 50'))).toMatchObject({ type: 'WorkOrder' })
    expect(nodeRecord(byCode('GR-D-0012'))).toMatchObject({ type: 'GoodsReceipt' })
    expect(nodeRecord(byCode('MOTO-ESEMPIO'))).toMatchObject({ type: 'Party' })
    expect(nodeRecord(byCode(null))).toBeNull()
  })
})

describe('the Trace dialog and the trace page', () => {
  it('opens one match, lets the person pick among several, says none (and why for a label it does not take)', () => {
    const one = { kind: 'HIDE' as const, id: 'h', code: 'H', matchedBy: 'HIDE_TAG', label: '' }
    expect(findOutcome({ code: 'H', matches: [one], problem: null }).open).toEqual(one)
    expect(findOutcome({ code: 'H', matches: [one, { ...one, id: 'g' }], problem: null }).state).toBe('several')
    expect(findOutcome({ code: 'X', matches: [], problem: null }).state).toBe('none')
    expect(findOutcome({ code: 'X', matches: [], problem: 'a location label' }).state).toBe('unreadable')
  })

  it('a lot opens on its record’s Trace tab, anything else on the trace page; the page reads its address', () => {
    const id = '0190f0e2-8282-7000-8000-000000000003'
    expect(traceHref('/w/DEMO', { kind: 'LOT', id })).toBe(`/w/DEMO/warehouse/lots/${id}?tab=trace`)
    expect(traceHref('/w/DEMO', { kind: 'HIDE', id })).toBe(`/w/DEMO/warehouse/lots/trace?kind=HIDE&id=${id}`)
    expect(traceAddressOf(new URLSearchParams(`kind=HIDE&id=${id}&direction=FORWARD`))).toEqual({ kind: 'HIDE', id, direction: 'FORWARD' })
    expect(traceAddressOf(new URLSearchParams(`kind=PALLET&id=${id}`))).toBeNull()
    expect(traceAddressOf(new URLSearchParams('kind=HIDE&id=nope'))).toBeNull()
  })
})
