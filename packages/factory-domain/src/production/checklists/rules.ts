import type { ScanRefusal } from '../scans/rules'

/**
 * Steps in an operation (B-W2b-47; MES-102; design floor.operation "Steps in this operation": tick-off steps, each with who
 * and when; Finish is held until every required step is ticked). Pure rules; apps/factory-api modules/production/checklists
 * applies them. A tick is one append-only OperationChecklistResult row (the database's …_floor_work_w2b_guards).
 *
 * Where the steps come from: the steps themselves are the operation's instructions, whose own record comes with W2b-4
 * (production.instructions). Until then they are lines of the routing step's `instructions` (what the revision froze), in
 * one written form the office types in the routing:
 *
 *   [ ] TRIM_THREADS Trim the threads        a required step
 *   [o] POCKET_ZIP Close the pocket zip      a step that may stay open
 *
 * Any other line is plain instructions. An operation with no such line has no checklist and nothing changes for it.
 * W2b-4 replaces only `stepsOfInstructions` (one call in the API's checklists/store.ts).
 *
 * A wrong tick is never removed (append-only): the latest tick of a step stands, so a step ticked DONE by mistake is ticked
 * NOT_APPLICABLE and both stay on the record. The same outcome again writes nothing. After the bundle's report at the
 * operation the steps are closed. Both outcomes satisfy a required step.
 */

export const CHECKLIST_OUTCOMES = ['DONE', 'NOT_APPLICABLE'] as const
export type ChecklistOutcome = (typeof CHECKLIST_OUTCOMES)[number]

export const STEP_CODE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/
const STEP_LINE = /^\s*\[( |o)\]\s+([A-Z0-9][A-Z0-9_-]{0,39})\s+(\S.{0,199}?)\s*$/

export interface ChecklistStep {
  readonly code: string
  readonly words: string
  readonly required: boolean
}

/** The steps written in a routing step's instructions, in their order; a code named twice counts once, the first. */
export function stepsOfInstructions(instructions: string | null): ChecklistStep[] {
  const steps = new Map<string, ChecklistStep>()
  for (const line of (instructions ?? '').split(/\r?\n/)) {
    const found = STEP_LINE.exec(line)
    if (found && !steps.has(found[2]!)) steps.set(found[2]!, { code: found[2]!, words: found[3]!, required: found[1] === ' ' })
  }
  return [...steps.values()]
}

/** A tick as read: the row's facts, oldest first. */
export interface StepTick {
  readonly stepCode: string
  readonly outcome: ChecklistOutcome
  readonly workerId: string | null
  readonly stationId: string | null
  readonly serverTime: Date
}

/** The tick that stands for each step: the latest one. */
export function standingTicks<Tick extends Pick<StepTick, 'stepCode'>>(ticks: readonly Tick[]): Map<string, Tick> {
  return new Map(ticks.map((tick) => [tick.stepCode, tick]))
}

/** The required steps no tick stands for. */
export function openSteps(steps: readonly ChecklistStep[], ticks: readonly Pick<StepTick, 'stepCode'>[]): ChecklistStep[] {
  const standing = standingTicks(ticks)
  return steps.filter((step) => step.required && !standing.has(step.code))
}

const refused = (code: ScanRefusal['code'], message: string, fix: string, final: boolean): ScanRefusal => ({ code, message, fix, final })

/** Finish is held while a required step is open; not final: it passes once they are ticked. */
export function checklistHold(open: readonly ChecklistStep[], place: { readonly bundleCode: string }): ScanRefusal | null {
  if (open.length === 0) return null
  const named = open.slice(0, 3).map((step) => step.words).join(', ')
  const more = open.length > 3 ? ` and ${open.length - 3} more` : ''
  return refused('CHECKLIST_OPEN', `Bundle ${place.bundleCode}: ${open.length === 1 ? 'one step is' : `${open.length} steps are`} not ticked yet (${named}${more}).`, 'Tick the steps, then Finish.', false)
}

export const stepUnknownRefusal = (code: string): ScanRefusal => refused('CHECKLIST_STEP_UNKNOWN', `${code} is not a step of this operation.`, 'Open the steps of the operation again.', true)

export const stepsClosedRefusal = (bundleCode: string): ScanRefusal => refused('CHECKLIST_REPORTED', `Bundle ${bundleCode} is reported at this operation: its steps are closed.`, 'Discard this tick. If something is wrong, ask a correction.', true)
