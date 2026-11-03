/**
 * An unplanned operation (B-W2b-47, B-W2b-82; MES-086 "add an unplanned operation to a work order with a reason"). Pure
 * rules; apps/factory-api modules/production/extraops applies them.
 *
 * What it is: a real step. The add writes a WorkOrderOperation row with no routing step (routingSeq null, operationId the
 * library's, unplannedReason the tile's code) on a RELEASED or IN_PROGRESS work order; MES-005's freeze stays for the
 * routing's copies, and the row is frozen like them, so a wrong add cannot be taken back: it simply stays unused and
 * changes no figure. The audit row (EXTRA_OPERATION_ACTION) keeps who, where and the words of "Other".
 *
 *   place     after every operation of the work order (unplannedSeq), once per library operation.
 *   order     `scanRequired` false: an operation "without it may be reported too, but no count waits for it" (production/
 *             scans/rules). So it is never required, never final, never sewn, no coupon, and it holds up nothing: every
 *             "next", "previous", "all done" and quantity guard reads the required operations only.
 *   scans     any live bundle of the work order, up to its own garments, one report per bundle, good garments only; a
 *             person picks it on the operation screen (a scan opens the routing's next step as before).
 *   pay       its piece rate, read by the library operation like any other (people/earnings); no rate in force: no piece
 *             pay, the month's NO_RATE check says so, and the time is booked as off-standard (extraPayOf tells the lead).
 *   cost      labour = good × its standard minutes × the cost per minute, like any scan; nothing of it in the estimate
 *             at release, so the variance shows it.
 *   plan      planning, dispatch and the spec's standard minutes stay the routing's: an unplanned operation has no target
 *             quantity, so its load is not known.
 *   figures   earned minutes count on line and person efficiency; the standard review stays per routing step.
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

/** How far after the work order's last operation an unplanned one sits. */
export const UNPLANNED_SEQ_STEP = 10

/** Its place in the work order: after every operation it has (`seq` is unique per work order). */
export function unplannedSeq(seqs: readonly number[]): number {
  return Math.max(0, ...seqs) + UNPLANNED_SEQ_STEP
}

/** Why the operation cannot be added (words only: an invalid state for the API), or null. */
export function extraOperationProblem(facts: {
  readonly workOrder: { readonly number: string; readonly open: boolean }
  /** The library operation: active, of the work order's company or tenant-wide. */
  readonly operation: { readonly code: string; readonly active: boolean } | null
  /** It is on the work order's routing already. */
  readonly planned: boolean
  /** It was added to this work order already. */
  readonly added: boolean
  /** The site has an active work centre of its kind (null: not asked yet). */
  readonly centre: { readonly kind: string; readonly found: boolean } | null
  readonly reasonCode: ExtraReasonCode
  readonly note: string | null
}): string | null {
  if (!facts.workOrder.open) return `Work order ${facts.workOrder.number} is not released or in progress: it takes no unplanned operation.`
  if (!facts.operation?.active) return 'This is not an active operation of the library.'
  if (facts.planned) return `${facts.operation.code} is on this work order's routing already.`
  if (facts.added) return `${facts.operation.code} was added to this work order already: scan the bundles at it.`
  if (facts.centre && !facts.centre.found) return `This site has no active ${facts.centre.kind.toLowerCase()} work centre for ${facts.operation.code}.`
  const tile = EXTRA_REASONS.find((reason) => reason.code === facts.reasonCode)
  return tile?.needsNote && !facts.note ? 'With "Other" say why in a few words.' : null
}

/** What a report at it pays, as the person adding it is told (a word, never a figure). */
export const EXTRA_PAYS = ['PIECE_RATE', 'OFF_STANDARD', 'NO_PIECE_PAY'] as const
export type ExtraPay = (typeof EXTRA_PAYS)[number]

/** Piece pay is off at the site today: nothing to tell. On, with a rate in force: its rate. On, without one: its time is off-standard. */
export function extraPayOf(facts: { readonly piecePayOn: boolean; readonly rated: boolean }): ExtraPay {
  if (!facts.piecePayOn) return 'NO_PIECE_PAY'
  return facts.rated ? 'PIECE_RATE' : 'OFF_STANDARD'
}
