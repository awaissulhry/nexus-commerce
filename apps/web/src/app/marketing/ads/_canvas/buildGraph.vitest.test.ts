import { describe, it, expect } from 'vitest'
import { buildGraph, COL_WIDTH, ROW_HEIGHT } from './buildGraph'
import type { OpsObject } from './types'

describe('buildGraph', () => {
  it('places objects in columns by hierarchy level and links parent to child', () => {
    const objects: OpsObject[] = [
      { id: 'm1', kind: 'market', name: 'DE' },
      { id: 'p1', kind: 'portfolio', name: 'Moto', parentId: 'm1' },
      { id: 'c1', kind: 'campaign', name: 'AIREON', parentId: 'p1' },
    ]
    const { nodes, edges } = buildGraph(objects)
    expect(nodes).toHaveLength(3)
    expect(nodes.find((n) => n.id === 'm1')!.position).toEqual({ x: 0, y: 0 })
    expect(nodes.find((n) => n.id === 'p1')!.position).toEqual({ x: COL_WIDTH, y: 0 })
    expect(nodes.find((n) => n.id === 'c1')!.position).toEqual({ x: 2 * COL_WIDTH, y: 0 })
    expect(edges).toEqual([
      { id: 'm1->p1', source: 'm1', target: 'p1', type: 'smoothstep' },
      { id: 'p1->c1', source: 'p1', target: 'c1', type: 'smoothstep' },
    ])
  })

  it('stacks siblings on the same level by ROW_HEIGHT', () => {
    const objects: OpsObject[] = [
      { id: 'm1', kind: 'market', name: 'DE' },
      { id: 'm2', kind: 'market', name: 'IT' },
    ]
    const { nodes } = buildGraph(objects)
    expect(nodes.find((n) => n.id === 'm1')!.position).toEqual({ x: 0, y: 0 })
    expect(nodes.find((n) => n.id === 'm2')!.position).toEqual({ x: 0, y: ROW_HEIGHT })
  })

  it('drops edges whose parent is missing', () => {
    const { edges } = buildGraph([{ id: 'c1', kind: 'campaign', name: 'x', parentId: 'ghost' }])
    expect(edges).toEqual([])
  })
})
