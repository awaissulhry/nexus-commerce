/**
 * SignOffPanel's rules (B-W2b-78, design part SignOffPanel): ordered sign-off steps with the separation-of-duties checks
 * said in words — an inspection result and its release, a hold's release, an NCR, a CAPA's staged approvals, a plan or a
 * document version, a label proof.
 *
 * - **Order**: a step can be signed only when every step before it is signed or not needed ("Waits for step 1: Result
 *   signed"). The current step is the first one still waiting or held. A rejected step ends the sign-off.
 * - **Separation of duties** (per step, for the person looking): the maker check from scans, four-eyes, the author who
 *   cannot approve, or the app's own rule — each `met`, `broken` or `unknown`, said in a sentence (the app's words, else
 *   the part's). A broken rule holds the step's action with that sentence; an unknown one holds it too (never a free
 *   pass).
 * - **Held reasons, never silent**: the action's `heldReason` is the first that applies — an earlier step, the step's
 *   own reason (no right, offline, a result not in), a broken rule, an unknown rule.
 * - Who signed, how (PIN / code / typed name), when and the fingerprint are the app's evidence; the panel shows them.
 */

export type SignStepState = 'signed' | 'waiting' | 'held' | 'rejected' | 'notNeeded'
export type SignMethod = 'pin' | 'code' | 'typed'
export type DutyKind = 'maker' | 'fourEyes' | 'authorNotApprover' | 'other'
export type DutyState = 'met' | 'broken' | 'unknown'

export interface DutyRuleInput {
  kind: DutyKind
  state: DutyState
  /** The app's sentence ("Made by (from scans): 9 people on Line 2 — Marta Demo is not among them"). */
  text?: string
}

export interface SignStepInput {
  label: string
  state: SignStepState
  heldReason?: string | null
  rules?: readonly DutyRuleInput[]
}

export interface SignOffWords {
  /** The default sentence of each rule in each state. */
  rules: Record<DutyKind, Record<DutyState, string>>
  /** "Waits for step 1: Result signed". */
  afterStep: (step: number, label: string) => string
}

/** A rule's sentence: the app's words, else the part's for its kind and state. */
export function dutyText(rule: DutyRuleInput, words: Pick<SignOffWords, 'rules'>): string {
  return rule.text?.trim() ? rule.text : words.rules[rule.kind][rule.state]
}

const done = (state: SignStepState) => state === 'signed' || state === 'notNeeded'
const open = (state: SignStepState) => state === 'waiting' || state === 'held'

/** The index of the step to sign next, or -1 (every step done, or the sign-off was rejected). */
export function signOffCurrent(steps: readonly Pick<SignStepInput, 'state'>[]): number {
  if (steps.some((s) => s.state === 'rejected')) return -1
  return steps.findIndex((s) => open(s.state))
}

/** Why step `index` cannot be signed now, or null. Only waiting and held steps have an action. */
export function signOffStepHeld(steps: readonly SignStepInput[], index: number, words: SignOffWords): string | null {
  const step = steps[index]
  if (!step || !open(step.state)) return null
  const before = steps.slice(0, index).findIndex((s) => !done(s.state))
  if (before >= 0) return words.afterStep(before + 1, steps[before]!.label)
  if (step.heldReason?.trim()) return step.heldReason
  const broken = step.rules?.find((r) => r.state === 'broken')
  if (broken) return dutyText(broken, words)
  const unknown = step.rules?.find((r) => r.state === 'unknown')
  if (unknown) return dutyText(unknown, words)
  return null
}

export interface SignOffSummary {
  /** Steps signed. */
  signed: number
  /** Steps that count (not `notNeeded`). */
  total: number
  rejected: boolean
  /** Every step signed or not needed, none rejected. */
  complete: boolean
}

export function signOffSummary(steps: readonly Pick<SignStepInput, 'state'>[]): SignOffSummary {
  const counted = steps.filter((s) => s.state !== 'notNeeded')
  const rejected = steps.some((s) => s.state === 'rejected')
  return { signed: counted.filter((s) => s.state === 'signed').length, total: counted.length, rejected, complete: !rejected && steps.every((s) => done(s.state)) }
}
