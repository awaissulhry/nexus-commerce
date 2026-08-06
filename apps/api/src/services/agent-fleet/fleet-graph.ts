/**
 * NAF.A — the fleet DAG (docs/AGENT_FLEET.md §3.3): a statically declared
 * structure the orchestrator walks and the Phase D Control Room draws.
 * One source of truth for "how it functions" — deliberately NOT a
 * framework (the rationale against LangGraph/Temporal is in the brief and
 * is not relitigated here).
 */
import type { CharterTier } from './charter-types.js'

export interface FleetNode {
  key: string
  tier: CharterTier
}

export interface FleetEdge {
  from: string
  to: string
  artifact: 'finding' | 'plan' | 'strategy'
}

export interface FleetGraph {
  nodes: FleetNode[]
  edges: FleetEdge[]
}

/** Phase A: one analyst, no edges. Phases B+ grow this literal. */
export const FLEET_GRAPH: FleetGraph = {
  nodes: [{ key: 'fleet-selftest', tier: 'analyst' }],
  edges: [],
}

/**
 * Kahn's algorithm by levels: every node whose dependencies are all in
 * earlier levels runs in the same level (bounded-parallel). Throws on an
 * edge naming an unknown node and on cycles — a malformed graph is a
 * build error, never a silent partial run.
 */
export function topoLevels(g: FleetGraph): string[][] {
  const keys = new Set(g.nodes.map((n) => n.key))
  for (const e of g.edges) {
    if (!keys.has(e.from)) throw new Error(`fleet graph: unknown edge endpoint '${e.from}'`)
    if (!keys.has(e.to)) throw new Error(`fleet graph: unknown edge endpoint '${e.to}'`)
  }
  const indegree = new Map<string, number>()
  const out = new Map<string, string[]>()
  for (const k of keys) indegree.set(k, 0)
  for (const e of g.edges) {
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1)
    out.set(e.from, [...(out.get(e.from) ?? []), e.to])
  }

  const levels: string[][] = []
  let current = [...keys].filter((k) => indegree.get(k) === 0)
  let placed = 0
  while (current.length > 0) {
    levels.push([...current].sort())
    placed += current.length
    const next: string[] = []
    for (const k of current) {
      for (const dep of out.get(k) ?? []) {
        const d = indegree.get(dep)! - 1
        indegree.set(dep, d)
        if (d === 0) next.push(dep)
      }
    }
    current = next
  }
  if (placed !== keys.size) {
    const stuck = [...keys].filter((k) => indegree.get(k)! > 0)
    throw new Error(`fleet graph: cycle involving ${stuck.sort().join(', ')}`)
  }
  return levels
}
