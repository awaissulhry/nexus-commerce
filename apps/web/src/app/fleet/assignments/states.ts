/**
 * NAF.SB.AS — the eight states, defined ONCE.
 *
 * The chip label, the strip tile label, the filter predicate, the tooltip and
 * the glossary all read this record. That is not tidiness: the single most
 * likely defect on this page is a tile that says one word and a row chip that
 * says another, so a first-time operator clicks "Ready to read" and lands on
 * rows labelled something else. Making them the same object makes that
 * impossible rather than merely discouraged.
 *
 * `tip` is the tooltip text and it is load-bearing, not decoration — with
 * eight states, the reason string is what distinguishes them. If a tip is
 * ever weaker than its label, the page becomes eight words nobody can tell
 * apart.
 */

export type AssignmentState =
  | 'not_started'
  | 'running'
  | 'finished'
  | 'stopped'
  | 'failed'
  | 'abandoned'
  | 'closed'
  | 'cancelled'

export interface StateDef {
  key: AssignmentState
  /** The one word. Identical everywhere it appears. */
  label: string
  /** The tooltip — what it means and what to do about it. */
  tip: string
  tone: 'neutral' | 'busy' | 'good' | 'warn' | 'bad'
  /** Open states are the default view; the rest are shown on request. */
  open: boolean
  /** Does this state get a tile on the strip? */
  tile: boolean
}

export const ASSIGNMENT_STATES: Record<AssignmentState, StateDef> = {
  not_started: {
    key: 'not_started',
    label: 'Not started',
    tip: 'You made this and nothing has run yet. Nothing will start it but you — every worker in this fleet is switched off.',
    tone: 'neutral',
    open: true,
    tile: true,
  },
  running: {
    key: 'running',
    label: 'Running',
    tip: 'A run is open right now. There is no way to stop a run once it has begun — it ends on its own, on a budget, or is closed after two hours if it stops reporting.',
    tone: 'busy',
    open: true,
    tile: true,
  },
  finished: {
    key: 'finished',
    label: 'Finished',
    tip: 'It ran and came back. What it found — or that it found nothing — is on the row.',
    tone: 'good',
    open: true,
    tile: true,
  },
  stopped: {
    key: 'stopped',
    label: 'Stopped',
    tip: 'A guard stopped it on purpose — a budget, the fleet halt, the kill switch, or evidence too old to trust. The row names which one, and that is the thing to fix.',
    tone: 'warn',
    open: true,
    tile: true,
  },
  failed: {
    key: 'failed',
    label: 'Failed',
    tip: 'It broke. The row says whose fault it was — the provider being unreachable is not the worker being wrong.',
    tone: 'bad',
    open: true,
    tile: true,
  },
  abandoned: {
    key: 'abandoned',
    label: 'Abandoned',
    tip: 'It stopped reporting and was closed after two hours. Nobody stopped it on purpose, and we cannot say what it spent — that cost is missing from the total, not counted as zero.',
    tone: 'bad',
    open: true,
    tile: true,
  },
  closed: {
    key: 'closed',
    label: 'Closed',
    tip: 'You are done with it. Its runs and findings are kept. Reopen puts it back.',
    tone: 'neutral',
    open: false,
    tile: false,
  },
  cancelled: {
    key: 'cancelled',
    label: 'Cancelled',
    tip: 'You called it off before it ran. Kept apart from Closed on purpose: closing something that ran and cancelling something that never did are different facts.',
    tone: 'neutral',
    open: false,
    tile: false,
  },
}

/** Strip order — the order an operator scans, not alphabetical. */
export const TILE_ORDER: AssignmentState[] = [
  'not_started',
  'running',
  'finished',
  'stopped',
  'failed',
  'abandoned',
]

export function stateDef(s: string): StateDef {
  return ASSIGNMENT_STATES[s as AssignmentState] ?? ASSIGNMENT_STATES.not_started
}

export function isOpenState(s: string): boolean {
  return stateDef(s).open
}

/**
 * The run outcome, as one short phrase.
 *
 * Deliberately NOT a percentage and never a spinner: a delta an operator can
 * read at a glance beats a progress bar that cannot be honest, because the
 * executor reports nothing between "started" and "done".
 */
export function outcomeLine(a: {
  state: string
  runCount: number
  findingCount: number
  lastRun?: { haltedReason?: string | null; errorMessage?: string | null } | null
}): string {
  if (a.state === 'not_started') return a.runCount > 0 ? 'reopened — not run since' : 'never run'
  if (a.state === 'running') return 'working now…'
  if (a.state === 'abandoned') return 'stopped reporting'
  if (a.state === 'stopped') return shortReason(a.lastRun?.haltedReason) ?? 'stopped at a limit'
  if (a.state === 'failed') return 'broke — see why'
  if (a.findingCount === 0) return 'nothing to do'
  return `${a.findingCount} finding${a.findingCount === 1 ? '' : 's'}`
}

/** Guard reasons are machine strings; this is the operator-facing half. */
export function shortReason(halted?: string | null): string | null {
  if (!halted) return null
  const h = halted.toLowerCase()
  if (h.startsWith('orphaned:')) return 'stopped reporting'
  if (h.includes('kill_switch')) return 'the AI kill switch is on'
  if (h.includes('fleet_halted')) return 'the fleet is halted'
  if (h.includes('fleet_state_unreadable')) return 'fleet state unreadable'
  if (h.startsWith('target_gone')) return 'its campaign is gone'
  if (h.startsWith('target_outside_worker_scope')) return 'target outside this worker'
  if (h.startsWith('target_unsupported')) return 'this worker cannot be narrowed'
  if (h.startsWith('target_unresolvable')) return 'target could not be resolved'
  if (h.includes('charter_day') || h.includes('charter budget')) return "this worker's day budget"
  if (h.includes('fleet_day') || h.includes('fleet budget')) return "the fleet's day budget"
  if (h.includes('budget_tokens')) return 'it hit its token ceiling'
  if (h.includes('stale')) return 'the evidence was too old'
  return halted.split(':')[0].replace(/_/g, ' ')
}

/** The full sentence, with the fix, for the detail page. */
export function reasonSentence(halted?: string | null): string | null {
  if (!halted) return null
  const h = halted.toLowerCase()
  if (h.startsWith('orphaned:'))
    return 'It stopped reporting and was closed after two hours. We cannot say what it spent, so its cost is left out of the total rather than counted as zero.'
  if (h.includes('kill_switch'))
    return 'The AI kill switch is on, so nothing in the fleet may call a model. Turn it off in Controls to run this.'
  if (h.includes('fleet_halted'))
    return 'The fleet is halted. Nothing runs — including by hand — until the halt is lifted in Controls.'
  if (h.startsWith('target_gone'))
    return 'The campaign this assignment names no longer exists. It stopped rather than quietly widening to your whole account — which is what the old behaviour would have done.'
  if (h.startsWith('target_outside_worker_scope'))
    return 'This worker is limited to a narrower scope than the target you named, and an assignment may only narrow a worker, never widen it.'
  if (h.startsWith('target_unsupported'))
    return 'This worker reads evidence that cannot be narrowed to a campaign, so the target could not be honoured. It refused rather than reading your whole account while claiming to be scoped.'
  if (h.includes('charter_day'))
    return "This worker has spent its budget for today. Raise it on the worker's page, or run this tomorrow."
  if (h.includes('fleet_day'))
    return 'The whole fleet has spent its ceiling for today. Raise it in Controls, or run this tomorrow.'
  if (h.includes('budget_tokens'))
    return 'It hit its token ceiling mid-run and was stopped — the limit working, not a fault. Raise the ceiling, or accept a shorter answer.'
  if (h.includes('stale'))
    return 'The evidence it reads is older than this worker tolerates, so it stopped BEFORE calling the model — this one cost nothing. Fix the ingest and run it again.'
  return halted
}
