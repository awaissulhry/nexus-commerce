/**
 * NAF.WF.4a — walk parity: an UNREVISED built-in must walk byte-identically
 * to today's `topoLevels(FLEET_GRAPH)`. This is the test that lets stored
 * execution ship dark-safe — if it holds, WF.4a changes nothing until an
 * operator publishes a revision.
 */
import { describe, expect, it } from 'vitest'
import { FLEET_GRAPH, topoLevels } from './fleet-graph.js'
import {
  BUILTIN_WORKFLOWS,
  MODE_WORKFLOW_KEY,
  builtinByKey,
  defToGraph,
  resolveItemGate,
  stepGatesOf,
} from './workflow-defs.js'

const codeWalk = () => topoLevels(FLEET_GRAPH)
const nonStandaloneKeys = () =>
  FLEET_GRAPH.nodes.filter((n) => !n.standalone).map((n) => n.key)

describe('derived built-in definitions (WF.4a)', () => {
  it('sweep mirrors the non-standalone walk — and the auditor is NOT a step', () => {
    const def = builtinByKey('fleet-sweep')!.definition()
    expect(def.steps.map((s) => s.charterKey).sort()).toEqual(nonStandaloneKeys().sort())
    expect(def.steps.some((s) => s.charterKey === 'fleet-auditor')).toBe(false)
    expect(def.edges).toEqual(FLEET_GRAPH.edges)
  })

  it('council mirrors the non-standalone walk', () => {
    const def = builtinByKey('fleet-council')!.definition()
    expect(def.steps.map((s) => s.charterKey).sort()).toEqual(nonStandaloneKeys().sort())
    expect(def.edges).toEqual(FLEET_GRAPH.edges)
  })

  it('every derived step is born gate=inherit — derivation adds no policy', () => {
    for (const b of BUILTIN_WORKFLOWS) {
      for (const s of b.definition().steps) expect(s.gate).toBe('inherit')
    }
  })

  it('walk parity: topoLevels(defToGraph(def)) equals the code walk, both modes', () => {
    for (const mode of ['sweep', 'council'] as const) {
      const def = builtinByKey(MODE_WORKFLOW_KEY[mode])!.definition()
      expect(topoLevels(defToGraph(def))).toEqual(codeWalk())
    }
  })

  it('the manual routine has no steps and no schedule', () => {
    const def = builtinByKey('on-demand-check')!.definition()
    expect(def.steps).toEqual([])
    expect(def.trigger.type).toBe('manual')
  })
})

describe('resolveItemGate (WF.4b, decision D-WF4.1)', () => {
  const gates = { miner: 'ask', director: 'act' } as Record<
    string,
    'ask' | 'act' | 'inherit'
  >

  it('the origin step’s gate wins', () => {
    expect(resolveItemGate(gates, 'miner', 'director')).toBe('ask')
  })

  it('an unknown origin falls back to the director', () => {
    expect(resolveItemGate(gates, 'stranger', 'director')).toBe('act')
    expect(resolveItemGate(gates, null, 'director')).toBe('act')
  })

  it('neither present ⇒ inherit — 4b adds no policy on its own', () => {
    expect(resolveItemGate({}, 'anyone', 'director')).toBe('inherit')
  })

  it('parity: every derived built-in origin resolves to inherit', () => {
    const g = stepGatesOf(builtinByKey('fleet-council')!.definition())
    for (const key of Object.keys(g)) {
      expect(resolveItemGate(g, key, 'amazon-ads-director')).toBe('inherit')
    }
  })
})

describe('defToGraph', () => {
  it('a cyclic drafted definition throws in topoLevels — the same law as code', () => {
    const cyclic = defToGraph({
      v: 1,
      trigger: { type: 'manual' },
      steps: [
        { charterKey: 'a', gate: 'inherit' },
        { charterKey: 'b', gate: 'inherit' },
      ],
      edges: [
        { from: 'a', to: 'b', artifact: 'finding' },
        { from: 'b', to: 'a', artifact: 'finding' },
      ],
    })
    expect(() => topoLevels(cyclic)).toThrow()
  })

  it('an edge naming an absent step throws — no silent partial walks', () => {
    const dangling = defToGraph({
      v: 1,
      trigger: { type: 'manual' },
      steps: [{ charterKey: 'a', gate: 'inherit' }],
      edges: [{ from: 'a', to: 'ghost', artifact: 'finding' }],
    })
    expect(() => topoLevels(dangling)).toThrow()
  })
})
