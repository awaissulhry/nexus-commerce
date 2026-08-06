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
  /** Drawn on the map but NOT run by the orchestrator's level-walk —
   *  the auditor reports on the sweep, so it runs after it, not in it. */
  standalone?: true
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

/** Phase C: analysts feed the director, the director feeds the critic.
 *  Three topo levels; `fleet-selftest` stays edge-free in level 1. */
export const FLEET_GRAPH: FleetGraph = {
  nodes: [
    { key: 'fleet-selftest', tier: 'analyst' },
    { key: 'amazon-negative-miner', tier: 'analyst' },
    { key: 'amazon-keyword-harvester', tier: 'analyst' },
    { key: 'amazon-bid-tuner', tier: 'analyst' },
    { key: 'amazon-ads-director', tier: 'director' },
    { key: 'plan-critic', tier: 'critic' },
    { key: 'fleet-auditor', tier: 'auditor', standalone: true },
  ],
  edges: [
    { from: 'amazon-negative-miner', to: 'amazon-ads-director', artifact: 'finding' },
    { from: 'amazon-keyword-harvester', to: 'amazon-ads-director', artifact: 'finding' },
    { from: 'amazon-bid-tuner', to: 'amazon-ads-director', artifact: 'finding' },
    { from: 'amazon-ads-director', to: 'plan-critic', artifact: 'plan' },
  ],
}

/**
 * Kahn's algorithm by levels: every node whose dependencies are all in
 * earlier levels runs in the same level (bounded-parallel). Throws on an
 * edge naming an unknown node and on cycles — a malformed graph is a
 * build error, never a silent partial run.
 */
export function topoLevels(g: FleetGraph): string[][] {
  // Standalone nodes are map-only: the sweep job invokes them explicitly
  // (the auditor runs AFTER scorecards), so the level-walk skips them.
  const keys = new Set(g.nodes.filter((n) => !n.standalone).map((n) => n.key))
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
