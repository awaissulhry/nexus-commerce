import { describe, it, expect } from 'vitest'
import { buildGraph, COL_WIDTH, NODE_H, V_GAP, GRID_COL_W, GRID_COLS } from './buildGraph'
import type { OpsObject } from './types'

describe('buildGraph layout', () => {
  it('aligns a single parent→child chain on one row', () => {
    const objects: OpsObject[] = [
      { id: 'm1', kind: 'market', name: 'DE' },
      { id: 'p1', kind: 'portfolio', name: 'Moto', parentId: 'm1' },
      { id: 'c1', kind: 'campaign', name: 'AIREON', parentId: 'p1' },
    ]
    const { nodes } = buildGraph(objects)
    const at = (id: string) => nodes.find((n) => n.id === id)!.position
    expect(at('m1')).toEqual({ x: 0, y: 0 })
    expect(at('p1')).toEqual({ x: COL_WIDTH, y: 0 })
    expect(at('c1')).toEqual({ x: 2 * COL_WIDTH, y: 0 })
  })

  it('stacks siblings vertically and centers the parent between them', () => {
    const objects: OpsObject[] = [
      { id: 'm1', kind: 'market', name: 'DE' },
      { id: 'p1', kind: 'portfolio', name: 'A', parentId: 'm1' },
      { id: 'p2', kind: 'portfolio', name: 'B', parentId: 'm1' },
    ]
    const { nodes } = buildGraph(objects)
    const at = (id: string) => nodes.find((n) => n.id === id)!.position
    expect(at('p1')).toEqual({ x: COL_WIDTH, y: 0 })
    expect(at('p2')).toEqual({ x: COL_WIDTH, y: NODE_H + V_GAP })
    // parent centered over the two-child block of extent (2*NODE_H + V_GAP)
    expect(at('m1').y).toBe((2 * NODE_H + V_GAP - NODE_H) / 2)
  })

  it('grid-wraps a high-fan-out set of leaf children', () => {
    const objects: OpsObject[] = [
      { id: 'p', kind: 'portfolio', name: 'P' },
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `c${i}`,
        kind: 'campaign' as const,
        name: `c${i}`,
        parentId: 'p',
      })),
    ]
    const { nodes } = buildGraph(objects)
    const at = (id: string) => nodes.find((n) => n.id === id)!.position
    // children laid out in a GRID_COLS-wide grid to the right of the parent
    expect(at('c0')).toEqual({ x: COL_WIDTH, y: 0 })
    expect(at('c1')).toEqual({ x: COL_WIDTH + GRID_COL_W, y: 0 })
    expect(at(`c${GRID_COLS}`)).toEqual({ x: COL_WIDTH, y: NODE_H + V_GAP })
  })

  it('links parent to child with smoothstep edges and drops orphans', () => {
    const objects: OpsObject[] = [
      { id: 'm1', kind: 'market', name: 'DE' },
      { id: 'p1', kind: 'portfolio', name: 'Moto', parentId: 'm1' },
      { id: 'x', kind: 'campaign', name: 'orphan', parentId: 'ghost' },
    ]
    const { edges } = buildGraph(objects)
    expect(edges).toEqual([{ id: 'm1->p1', source: 'm1', target: 'p1', type: 'smoothstep' }])
  })
})
