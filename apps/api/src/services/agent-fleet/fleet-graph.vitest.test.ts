/**
 * NAF.A — the statically-declared DAG and its topological leveling.
 */
import { describe, expect, it } from 'vitest'
import { FLEET_GRAPH, topoLevels, type FleetGraph } from './fleet-graph.js'

describe('FLEET_GRAPH', () => {
  it('is edge-free with every node an analyst — one flat level until Phase C', () => {
    expect(FLEET_GRAPH.nodes.map((n) => n.key)).toContain('fleet-selftest')
    expect(FLEET_GRAPH.nodes.every((n) => n.tier === 'analyst')).toBe(true)
    expect(FLEET_GRAPH.edges).toEqual([])
    expect(topoLevels(FLEET_GRAPH)).toHaveLength(1)
  })
})

describe('topoLevels', () => {
  const node = (key: string) => ({ key, tier: 'analyst' as const })

  it('levels a chain sequentially', () => {
    const g: FleetGraph = {
      nodes: [node('a'), node('b'), node('c')],
      edges: [
        { from: 'a', to: 'b', artifact: 'finding' },
        { from: 'b', to: 'c', artifact: 'plan' },
      ],
    }
    expect(topoLevels(g)).toEqual([['a'], ['b'], ['c']])
  })

  it('levels a diamond with the middle pair parallel', () => {
    const g: FleetGraph = {
      nodes: [node('a'), node('b'), node('c'), node('d')],
      edges: [
        { from: 'a', to: 'b', artifact: 'finding' },
        { from: 'a', to: 'c', artifact: 'finding' },
        { from: 'b', to: 'd', artifact: 'finding' },
        { from: 'c', to: 'd', artifact: 'finding' },
      ],
    }
    expect(topoLevels(g)).toEqual([['a'], ['b', 'c'], ['d']])
  })

  it('throws on a cycle', () => {
    const g: FleetGraph = {
      nodes: [node('a'), node('b')],
      edges: [
        { from: 'a', to: 'b', artifact: 'finding' },
        { from: 'b', to: 'a', artifact: 'finding' },
      ],
    }
    expect(() => topoLevels(g)).toThrow(/cycle/i)
  })

  it('throws on an edge naming an unknown node', () => {
    const g: FleetGraph = {
      nodes: [node('a')],
      edges: [{ from: 'a', to: 'ghost', artifact: 'finding' }],
    }
    expect(() => topoLevels(g)).toThrow(/unknown/i)
  })
})
