/**
 * NAF.WF.1 — the built-in routines, as composition data the list and (later)
 * the detail page share. THREE, not six: `sweep`, `council` and `ask` are the
 * run modes that exist in code (`agent-executor.ts:45` declares six, but
 * tick/summit/incident have zero call sites — docs/2026-08-07-naf-wf-
 * workflows-page.md Part 2.1). A row here never pretends to be runnable when
 * the code behind it is a string in a type union.
 */

export interface StoryStep {
  id: string
  /** worker = a charter runs (judgment) · code = deterministic math · gate = a human. */
  kind: 'worker' | 'code' | 'gate'
  /** Charter key for worker steps — joined live for autonomy tint + degraded. */
  charterKey?: string
  label: string
  /** One line under the label: what this step does, in operator words. */
  sub: string
  /** Hand-authored column — deterministic layout, no layout library. */
  col: number
}
export interface StoryEdge {
  from: string
  to: string
  /** What crosses this edge — findings, plan, verdict… Shown on the edge. */
  label?: string
}
export interface RoutineStory {
  steps: StoryStep[]
  edges: StoryEdge[]
  /** The whole routine as ONE sentence — the beginner shape riding under the graph. */
  sentence: string
}

export interface BuiltinRoutine {
  key: string
  name: string
  /** One sentence: what happens when this routine runs. */
  purpose: string
  /** The honest boundary: what this routine can reach, at most. */
  touch: string
  /** AgentRun.mode rows that belong to this routine. */
  mode: 'sweep' | 'council' | 'ask'
  /** Joins GET /agent/fleet/schedule; absent = manual, no clock. */
  scheduleKey?: 'fleet-sweep' | 'fleet-council'
  story: RoutineStory
}

/** Charter keys the council cannot produce a plan without (FLEET_GRAPH). */
export const DIRECTOR_KEY = 'amazon-ads-director'
export const CRITIC_KEY = 'plan-critic'

export const BUILTIN_ROUTINES: BuiltinRoutine[] = [
  {
    key: 'fleet-sweep',
    name: 'Nightly sweep',
    purpose:
      'Every switched-on worker reads fresh evidence and reports findings; report cards recompute afterwards.',
    touch: 'Findings only — it never touches Amazon.',
    mode: 'sweep',
    scheduleKey: 'fleet-sweep',
    story: {
      sentence:
        'Every switched-on worker reads fresh evidence and reports findings; code grades them against the proven engines, recomputes each worker’s report card, and the auditor writes your morning brief.',
      steps: [
        { id: 'selftest', kind: 'worker', charterKey: 'fleet-selftest', label: 'Fleet self-test', sub: 'Checks the fleet itself is healthy', col: 0 },
        { id: 'miner', kind: 'worker', charterKey: 'amazon-negative-miner', label: 'Negative miner', sub: 'Hunts wasted ad spend', col: 0 },
        { id: 'harvester', kind: 'worker', charterKey: 'amazon-keyword-harvester', label: 'Keyword harvester', sub: 'Finds search terms that earn', col: 0 },
        { id: 'tuner', kind: 'worker', charterKey: 'amazon-bid-tuner', label: 'Bid tuner', sub: 'Questions bid levels', col: 0 },
        { id: 'grade', kind: 'code', label: 'Grading', sub: 'Findings checked against the deterministic engines', col: 1 },
        { id: 'cards', kind: 'code', label: 'Report cards', sub: 'Each worker’s grade recomputes', col: 2 },
        { id: 'auditor', kind: 'worker', charterKey: 'fleet-auditor', label: 'Auditor', sub: 'Writes your morning brief', col: 3 },
      ],
      edges: [
        { from: 'selftest', to: 'grade', label: 'findings' },
        { from: 'miner', to: 'grade', label: 'findings' },
        { from: 'harvester', to: 'grade', label: 'findings' },
        { from: 'tuner', to: 'grade', label: 'findings' },
        { from: 'grade', to: 'cards' },
        { from: 'cards', to: 'auditor', label: 'digest' },
      ],
    },
  },
  {
    key: 'fleet-council',
    name: 'Weekly council',
    purpose:
      'Workers report, the director compiles one ranked plan, and the critic rules on it.',
    touch: 'Anything that survives the critic queues for your approval — nothing acts on its own.',
    mode: 'council',
    scheduleKey: 'fleet-council',
    story: {
      sentence:
        'Workers report, the director compiles one ranked plan, the critic tries to tear it apart, code re-checks every item — its blocks are final — and whatever survives waits for your yes in Approvals.',
      steps: [
        { id: 'selftest', kind: 'worker', charterKey: 'fleet-selftest', label: 'Fleet self-test', sub: 'Runs too; its notes stay on the board', col: 0 },
        { id: 'miner', kind: 'worker', charterKey: 'amazon-negative-miner', label: 'Negative miner', sub: 'Hunts wasted ad spend', col: 0 },
        { id: 'harvester', kind: 'worker', charterKey: 'amazon-keyword-harvester', label: 'Keyword harvester', sub: 'Finds search terms that earn', col: 0 },
        { id: 'tuner', kind: 'worker', charterKey: 'amazon-bid-tuner', label: 'Bid tuner', sub: 'Questions bid levels', col: 0 },
        { id: 'director', kind: 'worker', charterKey: 'amazon-ads-director', label: 'Director', sub: 'Compiles one ranked plan', col: 1 },
        { id: 'critic', kind: 'worker', charterKey: 'plan-critic', label: 'Critic', sub: 'Tries to tear the plan apart', col: 2 },
        { id: 'prechecks', kind: 'code', label: 'Code pre-checks', sub: 'Deterministic re-check; its blocks are final', col: 3 },
        { id: 'gate', kind: 'gate', label: 'Your approval', sub: 'Survivors wait in the Approvals inbox', col: 4 },
      ],
      edges: [
        { from: 'miner', to: 'director', label: 'findings' },
        { from: 'harvester', to: 'director', label: 'findings' },
        { from: 'tuner', to: 'director', label: 'findings' },
        { from: 'director', to: 'critic', label: 'plan' },
        { from: 'critic', to: 'prechecks', label: 'verdict' },
        { from: 'prechecks', to: 'gate', label: 'survivors' },
      ],
    },
  },
  {
    key: 'on-demand-check',
    name: 'On-demand check',
    purpose: 'One worker, run by hand, with the result readable as a story.',
    touch: 'Findings and proposals only; proposals wait for your approval.',
    mode: 'ask',
    story: {
      sentence:
        'You pick one worker and run it by hand; it reads its evidence, reports what it finds, and anything it proposes still waits for your approval.',
      steps: [
        { id: 'you', kind: 'gate', label: 'You', sub: 'Pick a worker and start it', col: 0 },
        { id: 'worker', kind: 'worker', label: 'One worker', sub: 'Reads its evidence, reports what it finds', col: 1 },
        { id: 'board', kind: 'code', label: 'The shared board', sub: 'Findings land here; proposals queue for approval', col: 2 },
      ],
      edges: [
        { from: 'you', to: 'worker', label: 'start' },
        { from: 'worker', to: 'board', label: 'findings' },
      ],
    },
  },
]
