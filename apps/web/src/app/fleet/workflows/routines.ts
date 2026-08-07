/**
 * NAF.WF.1 — the built-in routines, as composition data the list and (later)
 * the detail page share. THREE, not six: `sweep`, `council` and `ask` are the
 * run modes that exist in code (`agent-executor.ts:45` declares six, but
 * tick/summit/incident have zero call sites — docs/2026-08-07-naf-wf-
 * workflows-page.md Part 2.1). A row here never pretends to be runnable when
 * the code behind it is a string in a type union.
 */

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
  /** Glossary key for the routine's name, when one exists. */
  termKey?: 'sweep' | 'council'
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
    termKey: 'sweep',
  },
  {
    key: 'fleet-council',
    name: 'Weekly council',
    purpose:
      'Workers report, the director compiles one ranked plan, and the critic rules on it.',
    touch: 'Anything that survives the critic queues for your approval — nothing acts on its own.',
    mode: 'council',
    scheduleKey: 'fleet-council',
    termKey: 'council',
  },
  {
    key: 'on-demand-check',
    name: 'On-demand check',
    purpose: 'One worker, run by hand, with the result readable as a story.',
    touch: 'Findings and proposals only; proposals wait for your approval.',
    mode: 'ask',
  },
]
