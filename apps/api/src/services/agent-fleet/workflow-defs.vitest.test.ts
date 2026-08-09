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
  assembleTestStatus,
  sampleFindings,
  TEST_SAMPLE_CAP,
  builtinByKey,
  chainOf,
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

describe('assembleTestStatus (WF.5)', () => {
  const row = (over: Partial<Parameters<typeof assembleTestStatus>[1][number]>) => ({
    agentKey: 'a',
    status: 'done',
    ok: true,
    findingCount: 0,
    costUSD: 0,
    ...over,
  })

  it('a step with no row yet is pending', () => {
    const [s] = assembleTestStatus(['a'], [])
    expect(s!.status).toBe('pending')
  })

  it('an in-flight row is running — never failed (the SB.W trap)', () => {
    const [s] = assembleTestStatus(['a'], [row({ status: 'running', ok: false })])
    expect(s!.status).toBe('running')
  })

  it('a halted row is stopped, not failed — a limit doing its job', () => {
    const [s] = assembleTestStatus(['a'], [row({ ok: false, haltedReason: 'budget_tokens: …' })])
    expect(s!.status).toBe('stopped')
  })

  it('done and failed follow ok; costUSD survives string serialization', () => {
    const out = assembleTestStatus(
      ['a', 'b'],
      [
        row({ agentKey: 'a', findingCount: 5, costUSD: '0.0140' }),
        row({ agentKey: 'b', ok: false, errorMessage: 'schema validation failed' }),
      ],
    )
    expect(out[0]!.status).toBe('done')
    expect(out[0]!.costUSD).toBeCloseTo(0.014)
    expect(out[1]!.status).toBe('failed')
  })

  it('rows keep the walk order of the step list, not arrival order', () => {
    const out = assembleTestStatus(['first', 'second'], [row({ agentKey: 'second' })])
    expect(out.map((s) => s.charterKey)).toEqual(['first', 'second'])
    expect(out[0]!.status).toBe('pending')
    expect(out[1]!.status).toBe('done')
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

/* ── NAF.WF-S1R / S1.c — the chain the list page draws ─────────────────── */

describe('chainOf — a picture, not a plan', () => {
  it('returns the built-in sweep in the same order the executor walks it', () => {
    const def = builtinByKey('fleet-sweep')!.definition()
    expect(chainOf(def)).toEqual(topoLevels(defToGraph(def)).flat())
  })

  it('orders a hand-built definition by dependency, not by declaration', () => {
    // Declared critic-first on purpose: the chain must still read
    // miner -> director -> critic, or the picture lies about who hands to whom.
    const chain = chainOf({
      v: 1,
      trigger: { type: 'manual' },
      steps: [
        { charterKey: 'critic', gate: 'inherit' },
        { charterKey: 'director', gate: 'inherit' },
        { charterKey: 'miner', gate: 'inherit' },
      ],
      edges: [
        { from: 'director', to: 'critic', artifact: 'plan' },
        { from: 'miner', to: 'director', artifact: 'finding' },
      ],
    })
    expect(chain).toEqual(['miner', 'director', 'critic'])
  })

  it('falls back to declaration order instead of throwing on an unwalkable definition', () => {
    // `topoLevels` throws here, and it SHOULD — execution must refuse a
    // definition it cannot walk. A picture must not take the page down with
    // it, so the steps that do exist are still named.
    const broken = {
      v: 1 as const,
      trigger: { type: 'manual' as const },
      steps: [{ charterKey: 'a', gate: 'inherit' as const }],
      edges: [{ from: 'a', to: 'ghost', artifact: 'finding' as const }],
    }
    expect(() => topoLevels(defToGraph(broken))).toThrow()
    expect(chainOf(broken)).toEqual(['a'])
  })

  it('an empty definition yields an empty chain, never a throw', () => {
    expect(chainOf({ v: 1, trigger: { type: 'manual' }, steps: [], edges: [] })).toEqual([])
  })
})

describe('would-be findings sample (WF-S6.d)', () => {
  const finding = (over = {}) => ({
    entityName: 'Aireon jacket', entityId: 'e1', kind: 'wasted_spend',
    severity: 'high', ...over,
  })
  const previewOutput = (n) => ({
    preview: true,
    data: { findings: Array.from({ length: n }, (_, i) => finding({ entityId: `e${i}` })), scanned: n },
  })

  it('reads the would-be findings a preview persisted — no new write path', () => {
    expect(sampleFindings(previewOutput(2))).toEqual([
      { label: 'Aireon jacket', kind: 'wasted_spend', severity: 'high' },
      { label: 'Aireon jacket', kind: 'wasted_spend', severity: 'high' },
    ])
  })

  it('caps the sample so a six-step council cannot turn a poll into a payload', () => {
    expect(sampleFindings(previewOutput(50))).toHaveLength(TEST_SAMPLE_CAP)
  })

  it('falls back to the entity id when a finding has no name', () => {
    const out = { preview: true, data: { findings: [finding({ entityName: undefined, entityId: 'kw-42' })] } }
    expect(sampleFindings(out)[0]!.label).toBe('kw-42')
  })

  it('never throws on shapes a model can produce — it reads JSON off a row', () => {
    for (const bad of [null, undefined, 0, 'x', {}, { data: null }, { data: {} },
                       { data: { findings: 'nope' } }, { data: { findings: [null, 1, 'x'] } }]) {
      expect(() => sampleFindings(bad)).not.toThrow()
    }
    expect(sampleFindings({ data: { findings: [null, 1] } })).toEqual([])
  })

  it('a non-analyst tier stores one artifact and yields no findings', () => {
    expect(sampleFindings({ preview: true, data: { plan: [], rationale: 'x' } })).toEqual([])
  })

  it('assembleTestStatus carries the sample, and pending steps carry none', () => {
    const rows = [{ agentKey: 'a', status: 'done', ok: true, findingCount: 9,
      costUSD: '0.5', output: previewOutput(9) }]
    const [done, pending] = assembleTestStatus(['a', 'b'], rows)
    expect(done!.findingCount).toBe(9)
    expect(done!.sample).toHaveLength(TEST_SAMPLE_CAP)
    expect(pending!.status).toBe('pending')
    expect(pending!.sample).toEqual([])
  })

  it('the COUNT stays exact even though the sample is capped', () => {
    const rows = [{ agentKey: 'a', status: 'done', ok: true, findingCount: 15,
      costUSD: '0.1', output: previewOutput(15) }]
    const [s] = assembleTestStatus(['a'], rows)
    expect(s!.findingCount).toBe(15)
    expect(s!.sample.length).toBeLessThan(s!.findingCount)
  })
})
