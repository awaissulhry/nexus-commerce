/**
 * NAF.WF.4a — the PURE definition layer: contract types, the derived
 * built-ins, and the definition→graph bridge. No prisma, no env-gated
 * services — this file is importable by vitest without a database, which is
 * what lets the walk-parity tests exist (the WF.4 study's requirement).
 *
 * The built-ins are DERIVED from `FLEET_GRAPH` and the cron envs at read
 * time, so this layer cannot drift from the code that runs the fleet.
 *
 * The auditor is deliberately NOT a step of the sweep definition (WF.4
 * study, truth #3): it has no artifact edges, so a stored walk would run it
 * at level 0 — but the job runs it AFTER scorecards on purpose. Its
 * ordering is code; it is job furniture like grading, shown in the story as
 * presentation, never editable wiring.
 */

import { FLEET_GRAPH, topoLevels, type FleetGraph } from './fleet-graph.js'

/* ── definition contract v1 ────────────────────────────────────────────── */

export interface WorkflowStepV1 {
  charterKey: string
  /** ask = force the approval path · act = tool policy decides · inherit =
   *  today's behaviour. Tighten-only: enforcement (WF.4b) can never let a
   *  gate loosen below tool-policy floors. */
  gate: 'ask' | 'act' | 'inherit'
}
export interface WorkflowEdgeV1 {
  from: string
  to: string
  artifact: 'finding' | 'plan' | 'strategy'
}
export type WorkflowTriggerV1 = { type: 'schedule'; cron: string } | { type: 'manual' }
export interface WorkflowDefinitionV1 {
  v: 1
  trigger: WorkflowTriggerV1
  steps: WorkflowStepV1[]
  edges: WorkflowEdgeV1[]
}

/* ── the built-ins, derived from code truth ────────────────────────────── */

export interface BuiltinWorkflow {
  key: string
  name: string
  description: string
  definition: () => WorkflowDefinitionV1
}

const walkSteps = (): WorkflowStepV1[] =>
  FLEET_GRAPH.nodes
    .filter((n) => !n.standalone)
    .map((n) => ({ charterKey: n.key, gate: 'inherit' as const }))

const graphEdges = (): WorkflowEdgeV1[] =>
  FLEET_GRAPH.edges.map((e) => ({ from: e.from, to: e.to, artifact: e.artifact }))

export const BUILTIN_WORKFLOWS: readonly BuiltinWorkflow[] = Object.freeze([
  {
    key: 'fleet-sweep',
    name: 'Nightly sweep',
    description:
      'Every switched-on worker reads fresh evidence and reports findings; report cards recompute afterwards.',
    definition: (): WorkflowDefinitionV1 => ({
      v: 1,
      trigger: {
        type: 'schedule',
        cron: process.env.NEXUS_FLEET_SWEEP_SCHEDULE ?? '45 4 * * *',
      },
      steps: walkSteps(),
      edges: graphEdges(),
    }),
  },
  {
    key: 'fleet-council',
    name: 'Weekly council',
    description:
      'Workers report, the director compiles one ranked plan, and the critic rules on it.',
    definition: (): WorkflowDefinitionV1 => ({
      v: 1,
      trigger: {
        type: 'schedule',
        cron: process.env.NEXUS_FLEET_COUNCIL_SCHEDULE ?? '15 5 * * 1',
      },
      steps: walkSteps(),
      edges: graphEdges(),
    }),
  },
  {
    key: 'on-demand-check',
    name: 'On-demand check',
    description: 'One worker, run by hand, with the result readable as a story.',
    definition: (): WorkflowDefinitionV1 => ({
      v: 1,
      trigger: { type: 'manual' },
      // The worker is chosen at run time — an empty step list is this
      // routine's honest shape, and validation permits it for manual only.
      steps: [],
      edges: [],
    }),
  },
])

export function builtinByKey(key: string): BuiltinWorkflow | null {
  return BUILTIN_WORKFLOWS.find((b) => b.key === key) ?? null
}

/** WF.6a — a workflow key from an operator-typed name: lowercase kebab,
 *  48 chars, no leading/trailing dashes. Pure; collision checks are the
 *  route's job. */
export function slugifyWorkflowName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

/** The workflow each orchestrated mode executes. */
export const MODE_WORKFLOW_KEY: Record<'sweep' | 'council', string> = {
  sweep: 'fleet-sweep',
  council: 'fleet-council',
}

/** A stored definition as the orchestrator's graph shape. The tier is
 *  irrelevant to `topoLevels` (which reads only keys and edges) and is
 *  filled with a placeholder. */
export function defToGraph(def: WorkflowDefinitionV1): FleetGraph {
  return {
    nodes: def.steps.map((s) => ({ key: s.charterKey, tier: 'analyst' })),
    edges: def.edges.map((e) => ({ from: e.from, to: e.to, artifact: e.artifact })),
  }
}

/** NAF.WF-S1R / S1.c — the definition's steps in execution order, flattened
 *  from `topoLevels` so the list page can draw "who hands to whom" without
 *  fetching each workflow's definition separately.
 *
 *  Pure, and deliberately forgiving: this feeds a PICTURE, never a decision.
 *  A definition that cannot be walked (a cycle, an edge naming a step that
 *  is not there) still has real steps worth showing, so the declaration order
 *  is the fallback rather than an empty chain or a thrown request. Execution
 *  keeps using `topoLevels` directly and keeps throwing — the two must not be
 *  confused, which is why this returns names and not a plan. */
export function chainOf(def: WorkflowDefinitionV1): string[] {
  try {
    return topoLevels(defToGraph(def)).flat()
  } catch {
    return def.steps.map((s) => s.charterKey)
  }
}

/** The definition's per-step gates, as a lookup. */
export function stepGatesOf(
  def: WorkflowDefinitionV1,
): Record<string, WorkflowStepV1['gate']> {
  const out: Record<string, WorkflowStepV1['gate']> = {}
  for (const s of def.steps) out[s.charterKey] = s.gate
  return out
}

/* ── WF.5 — test-run status assembly (pure, so it is provable) ─────────── */

export interface TestRunRowLike {
  agentKey: string
  status: string
  ok: boolean
  findingCount: number
  /** number | string over JSON; Prisma's Decimal also lands here — anything
   *  Number() can read. */
  costUSD: string | number | { toString(): string }
  errorMessage?: string | null
  haltedReason?: string | null
}
export interface TestStepStatus {
  charterKey: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'stopped'
  findingCount: number
  costUSD: number
  errorMessage: string | null
  haltedReason: string | null
}

/** One row per planned step, in walk order, whatever the DB has so far.
 *  `stopped` is a limit doing its job (haltedReason), never a failure. */
export function assembleTestStatus(
  steps: string[],
  rows: TestRunRowLike[],
): TestStepStatus[] {
  return steps.map((charterKey) => {
    const row = rows.find((r) => r.agentKey === charterKey)
    if (!row) {
      return { charterKey, status: 'pending' as const, findingCount: 0, costUSD: 0, errorMessage: null, haltedReason: null }
    }
    const base = {
      charterKey,
      findingCount: row.findingCount,
      costUSD: Number(row.costUSD || 0),
      errorMessage: row.errorMessage ?? null,
      haltedReason: row.haltedReason ?? null,
    }
    if (row.status === 'running') return { ...base, status: 'running' as const }
    if (row.haltedReason) return { ...base, status: 'stopped' as const }
    return { ...base, status: row.ok ? ('done' as const) : ('failed' as const) }
  })
}

/** WF.4b (study decision D-WF4.1): a plan item is gated by its ORIGIN step —
 *  the analyst whose finding it enacts — falling back to the director's
 *  gate, then `inherit`. Pure, so the fallback chain is provable without a
 *  database. */
export function resolveItemGate(
  gates: Record<string, WorkflowStepV1['gate']>,
  originCharterKey: string | null,
  directorKey: string,
): WorkflowStepV1['gate'] {
  if (originCharterKey && gates[originCharterKey]) return gates[originCharterKey]
  return gates[directorKey] ?? 'inherit'
}
