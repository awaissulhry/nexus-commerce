/**
 * MilestoneTracker's rules (B-W2b-155), pure: which step is the current one, what each step says, and where the promise
 * date stands. The API steps (a customer order: DONE | PARTLY | TODO | SKIPPED with `current`; a return: DONE | CURRENT |
 * TODO | SKIPPED) both map onto these lower-case states.
 */

export type MilestoneState = 'done' | 'partly' | 'current' | 'todo' | 'skipped'
/** What a step shows: `current` wins over its state. */
export type MilestoneShownState = 'done' | 'partly' | 'current' | 'todo' | 'skipped'

export interface MilestoneStep {
  id: string
  /** The step in the customer's words ("In production"). */
  label: string
  state: MilestoneState
  /** The step the record is at now (the API's `current`); `state: 'current'` says the same. */
  current?: boolean
  /** When it happened, written ("3 Nov"). */
  date?: string | null
  /** When it is expected, written ("12 Nov"): said as an estimate ("Usually by 12 Nov"). */
  expected?: string | null
  /** A line more ("2 of 3 cartons"). */
  note?: string | null
}

export interface PromiseMove {
  /** When it moved, written. */
  on: string
  /** The date before, written; null for the first date set. */
  from?: string | null
  /** The new date, written. */
  to: string
  /** Why, in the customer's words. */
  reason?: string | null
}

export interface MilestonePromise {
  /** The promise date now, written. */
  date: string
  /** Every move, oldest first. */
  history?: readonly PromiseMove[]
}

/** The index of the current step: the first marked current; else the step after the last done or partly one; else none. */
export function milestoneCurrentIndex(steps: readonly MilestoneStep[]): number {
  const marked = steps.findIndex((s) => s.current || s.state === 'current')
  if (marked >= 0) return marked
  let last = -1
  steps.forEach((s, i) => {
    if (s.state === 'done' || s.state === 'partly') last = i
  })
  if (last < 0) return steps.length ? 0 : -1
  // The step after the last one reached that is still to come; none when everything after it was skipped or done.
  for (let i = last + 1; i < steps.length; i++) if (steps[i].state === 'todo') return i
  return steps[last].state === 'partly' ? last : -1
}

export interface MilestoneView {
  step: MilestoneStep
  shown: MilestoneShownState
  isCurrent: boolean
  /** The words under the label (the state with its date, or the estimate). */
  detail: string
}

export interface MilestoneWords {
  states: Record<MilestoneShownState, string>
  doneOn: (date: string) => string
  partlyOn: (date: string) => string
  usually: (date: string) => string
}

/** Each step as it is drawn. */
export function milestoneViews(steps: readonly MilestoneStep[], words: MilestoneWords): MilestoneView[] {
  const current = milestoneCurrentIndex(steps)
  return steps.map((step, i) => {
    const isCurrent = i === current
    const base: MilestoneShownState = step.state === 'current' ? 'current' : step.state
    const shown: MilestoneShownState = isCurrent && (base === 'todo' || base === 'current') ? 'current' : base
    let detail: string
    if (shown === 'done') detail = step.date ? words.doneOn(step.date) : words.states.done
    else if (shown === 'partly') detail = step.date ? words.partlyOn(step.date) : words.states.partly
    else if (shown === 'skipped') detail = words.states.skipped
    else if (step.expected) detail = shown === 'current' ? `${words.states.current} · ${words.usually(step.expected)}` : words.usually(step.expected)
    else detail = words.states[shown]
    return { step, shown, isCurrent, detail }
  })
}

/** How many times the promise moved (the first date set is not a move). */
export function promiseMoves(promise: MilestonePromise | null | undefined): number {
  return (promise?.history ?? []).filter((m) => m.from !== null && m.from !== undefined && m.from !== m.to).length
}
