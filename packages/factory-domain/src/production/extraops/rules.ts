/**
 * An unplanned operation (B-W2b-47; MES-086 "add an unplanned operation to a work order with a reason"). Pure rules; apps/
 * factory-api modules/production/extraops applies them.
 *
 * What it is today: a dated record on the work order, kept in the audit log (recordType WorkOrder, EXTRA_OPERATION_ACTION):
 * which library operation, why, who, on the tablet or in the office. It is NOT yet a step the floor can scan: a work
 * order's operations are frozen after DRAFT by the database (…_production_guards: MES-005) and each must be a copy of a step
 * of the frozen routing, so a real step needs a schema change (the step's notes, "Schema needs"). Until then the time on it
 * is booked as off-standard or indirect time on the tablet.
 */

export const EXTRA_OPERATION_ACTION = 'production.extraOperationAdded'

export const EXTRA_REASON_CODES = ['QUALITY_FIX', 'MATERIAL_ISSUE', 'CUSTOMER_CHANGE', 'MISSING_FROM_ROUTING', 'OTHER'] as const
export type ExtraReasonCode = (typeof EXTRA_REASON_CODES)[number]

export interface ExtraReason {
  readonly code: ExtraReasonCode
  readonly label: { readonly it: string; readonly en: string }
  readonly needsNote: boolean
}

/** The reason tiles, fixed for now: the reason lists have no list for them. */
export const EXTRA_REASONS: readonly ExtraReason[] = Object.freeze([
  { code: 'QUALITY_FIX', label: { it: 'Per correggere un difetto', en: 'To fix a defect' }, needsNote: false },
  { code: 'MATERIAL_ISSUE', label: { it: 'Per un problema di materiale', en: 'A material problem' }, needsNote: false },
  { code: 'CUSTOMER_CHANGE', label: { it: 'Richiesta del cliente', en: 'The customer asked' }, needsNote: false },
  { code: 'MISSING_FROM_ROUTING', label: { it: 'Manca nel ciclo', en: 'Missing from the routing' }, needsNote: false },
  { code: 'OTHER', label: { it: 'Altro (scrivi perché)', en: 'Other (say why)' }, needsNote: true },
])

/** The record's reason: the tile's English words, and the note when there is one. */
export function extraReasonText(code: ExtraReasonCode, note: string | null): string {
  const tile = EXTRA_REASONS.find((reason) => reason.code === code)!
  return note ? `${tile.label.en}: ${note}` : tile.label.en
}

/** Why the operation cannot be added (words only: an invalid state for the API), or null. */
export function extraOperationProblem(facts: {
  readonly workOrder: { readonly number: string; readonly open: boolean }
  /** The library operation: active, of the work order's company or tenant-wide. */
  readonly operation: { readonly code: string; readonly active: boolean } | null
  /** It is on the work order's routing already. */
  readonly planned: boolean
  readonly reasonCode: ExtraReasonCode
  readonly note: string | null
}): string | null {
  if (!facts.workOrder.open) return `Work order ${facts.workOrder.number} is not released or in progress: it takes no unplanned operation.`
  if (!facts.operation?.active) return 'This is not an active operation of the library.'
  if (facts.planned) return `${facts.operation.code} is on this work order's routing already.`
  const tile = EXTRA_REASONS.find((reason) => reason.code === facts.reasonCode)
  return tile?.needsNote && !facts.note ? 'With "Other" say why in a few words.' : null
}
