import { decimalText } from '../units/units'
import { sameMinutes } from './operations'
import { MINUTES_ROUND, routingMinutes } from './minutes'
import { inOrder, type StepData, type StepFields } from './rules'

/**
 * The difference between two revisions' routings (feature PRD-110; plan A1 §2.5: a change is a new revision), pure: what
 * the office reads before it releases a new revision, or when it asks what changed since the one a work order was made
 * from. Steps have new ids in every revision, so a step of one is matched to a step of the other by its library
 * operation (the n-th step of an operation in one with the n-th in the other, in routing order). Minutes are compared as
 * numbers ("4.200" is "4.2").
 */

export type FieldValue = string | number | boolean | null

export interface FieldChange {
  readonly field: string
  readonly from: FieldValue
  readonly to: FieldValue
}

export interface ChangedStep {
  readonly from: StepData
  readonly to: StepData
  readonly fields: readonly FieldChange[]
}

export interface RoutingDiff {
  readonly added: readonly StepData[]
  readonly removed: readonly StepData[]
  readonly changed: readonly ChangedStep[]
  readonly unchanged: number
  /** Per garment, before and after. */
  readonly minutes: { readonly from: string; readonly to: string }
}

const PLAIN_FIELDS = ['seq', 'code', 'name', 'workCentreKind', 'scanRequired', 'instructions'] as const satisfies readonly (keyof StepFields)[]

function stepFields(from: StepData, to: StepData): FieldChange[] {
  const fields: FieldChange[] = []
  for (const field of PLAIN_FIELDS) if (from[field] !== to[field]) fields.push({ field, from: from[field], to: to[field] })
  if (!sameMinutes(from.standardMinutes, to.standardMinutes)) fields.push({ field: 'standardMinutes', from: decimalText(from.standardMinutes), to: decimalText(to.standardMinutes) })
  if (JSON.stringify(from.nameI18n ?? {}) !== JSON.stringify(to.nameI18n ?? {})) fields.push({ field: 'nameI18n', from: JSON.stringify(from.nameI18n ?? {}), to: JSON.stringify(to.nameI18n ?? {}) })
  return fields
}

export function diffRoutings(from: readonly StepData[], to: readonly StepData[]): RoutingDiff {
  const queues = new Map<string, StepData[]>()
  for (const step of inOrder(from)) queues.set(step.operationId, [...(queues.get(step.operationId) ?? []), step])
  const added: StepData[] = []
  const changed: ChangedStep[] = []
  let unchanged = 0
  for (const step of inOrder(to)) {
    const match = queues.get(step.operationId)?.shift()
    if (!match) {
      added.push(step)
      continue
    }
    const fields = stepFields(match, step)
    if (fields.length === 0) unchanged++
    else changed.push({ from: match, to: step, fields })
  }
  const removed = inOrder([...queues.values()].flat())
  return {
    added,
    removed,
    changed,
    unchanged,
    minutes: { from: routingMinutes(from, [], MINUTES_ROUND).perGarment, to: routingMinutes(to, [], MINUTES_ROUND).perGarment },
  }
}
