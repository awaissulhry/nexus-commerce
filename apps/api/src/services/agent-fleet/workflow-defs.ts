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

import { FLEET_GRAPH, type FleetGraph } from './fleet-graph.js'

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
