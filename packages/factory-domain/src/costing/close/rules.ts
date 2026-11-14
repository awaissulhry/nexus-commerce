import { decimalOf } from '../../product/units/units'

/**
 * The close of a work order (B-W2b-411; MES-012, MES-013, FIN-034; design production.workorders pop "Close work order"
 * (wo-close): planned against actual quantity, material, minutes and scrap; a reason when outside the tolerance; Undo for
 * a few seconds), pure. factory-db's WorkOrderClose keeps it (B-W2b-376; its …_cost_actuals_w2b_guards hold the same
 * rules for every login); apps/factory-api's modules/production/work-orders/close.ts and modules/costing/close write it.
 *
 *   close    a COMPLETED work order: its planned and actual figures, judged against the company's close tolerance in force
 *            (ActualCostSettings: the company's row, the tenant's, else 5 %); a reason code exactly when a figure is beyond
 *            it, words when the person adds them (OTHER needs them). While the company's figures for the accountant are on
 *            (GATE-ACCOUNTANT), the same command settles the cost: the variance split, its variance entries and the closing
 *            entry (the work order's ledger then adds up to 0 and takes no entry but a reversal). While they are off the
 *            close is a status, and nothing settles (Rule 1: work orders close every day).
 *   undo     the person who closed it, within UNDO_SECONDS of the close, without a reason (the toast's Undo; the screen
 *            shows it for a few seconds): the close is taken back, its entries reversed, the work order COMPLETED again.
 *   reopen   later or by someone else: workorders.reopen and a reason (3 to 1,000 characters); the same taking back.
 * A re-close is a new close. A work order closed before B-W2b-411 (no close record) is not reopened.
 */

/** The close reasons (the database checks their shape only: capitals, digits and underscores). */
export const CLOSE_REASONS = [
  'SHORT_PRODUCED',
  'OVER_PRODUCED',
  'LEATHER_YIELD',
  'MATERIAL_PRICE',
  'SCRAP_ABOVE_ALLOWANCE',
  'REWORK',
  'METHOD_CHANGED',
  'STANDARD_OUT_OF_DATE',
  'NO_STANDARD',
  'OTHER',
] as const
export type CloseReason = (typeof CLOSE_REASONS)[number]

/** The reasons in words (the API's; the screens keep their own it/en words by code). */
export const CLOSE_REASON_WORDS: Readonly<Record<CloseReason, string>> = Object.freeze({
  SHORT_PRODUCED: 'Fewer garments made than planned.',
  OVER_PRODUCED: 'More garments made than planned.',
  LEATHER_YIELD: 'The hides gave a different yield than planned (panels recut, defects cut around).',
  MATERIAL_PRICE: 'The material cost more or less than its standard price.',
  SCRAP_ABOVE_ALLOWANCE: 'More garments scrapped than allowed.',
  REWORK: 'Rework took extra material or time.',
  METHOD_CHANGED: 'The garment was made another way (operations added or left out).',
  STANDARD_OUT_OF_DATE: 'The standard is out of date: the work was right, the plan was not.',
  NO_STANDARD: 'There is no standard to compare with yet.',
  OTHER: 'Another reason, in words.',
})

/** The reasons that need words in the note. */
export const NOTE_NEEDED: ReadonlySet<CloseReason> = new Set<CloseReason>(['OTHER'])

/** The database's outer limit of an Undo: the person who closed it, within this many seconds of the close. */
export const UNDO_SECONDS = 60

/** Why a close, an undo or a reopen is refused, as the issue path `refusal/<code>`. */
export const CLOSE_REFUSALS = [
  'NOT_COMPLETED',
  'REASON_NEEDED',
  'REASON_NOT_NEEDED',
  'NOTE_NEEDED',
  'COSTS_WAITING',
  'LOCKED',
  'NOT_CLOSED',
  'NO_CLOSE_RECORD',
  'UNDO_TOO_LATE',
  'NOT_THE_CLOSER',
  'DATABASE',
] as const
export type CloseRefusal = (typeof CLOSE_REFUSALS)[number]

/** A close's planned and actual figures: garments, material cost (minor units), standard minutes (text), scrap. */
export interface CloseFigures {
  readonly plannedQuantity: number
  readonly actualQuantity: number
  readonly plannedScrapQuantity: number
  readonly scrapQuantity: number
  readonly plannedMaterialCost: number
  readonly actualMaterialCost: number
  readonly plannedMinutes: string
  readonly actualMinutes: string
}

export interface Beyond {
  readonly quantity: boolean
  readonly material: boolean
  readonly minutes: boolean
  readonly scrap: boolean
  readonly any: boolean
}

/** An actual figure beyond its planned one by more than `pct` percent; nothing planned: anything actual (the DB's rule). */
export function isBeyond(planned: string | number, actual: string | number, pct: string): boolean {
  const plan = decimalOf(String(planned))
  const done = decimalOf(String(actual))
  if (plan.isZero()) return done.gt(0)
  return done.minus(plan).abs().times(100).gt(plan.times(decimalOf(pct)))
}

/** Which figures are beyond the tolerance, exactly as the database judges them (factory_work_order_close_check). */
export function beyondOf(figures: CloseFigures, tolerancePct: string): Beyond {
  const tolerance = decimalOf(tolerancePct)
  const over = figures.scrapQuantity - figures.plannedScrapQuantity
  const scrap = decimalOf(String(over)).times(100).gt(decimalOf(String(figures.plannedQuantity)).times(tolerance)) || (figures.plannedQuantity === 0 && over > 0)
  const quantity = isBeyond(figures.plannedQuantity, figures.actualQuantity, tolerancePct)
  const material = isBeyond(figures.plannedMaterialCost, figures.actualMaterialCost, tolerancePct)
  const minutes = isBeyond(figures.plannedMinutes, figures.actualMinutes, tolerancePct)
  return { quantity, material, minutes, scrap, any: quantity || material || minutes || scrap }
}

/** The figures beyond the tolerance in words (no amount: the words reach callers without the cost grain). */
export function beyondWords(beyond: Beyond, tolerancePct: string): string {
  const names = [beyond.quantity ? 'garments made' : null, beyond.material ? 'material' : null, beyond.minutes ? 'minutes' : null, beyond.scrap ? 'scrap' : null].filter((name): name is string => name !== null)
  if (names.length === 0) return `Within the ${tolerancePct} % tolerance: no reason is needed.`
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`
  return `Beyond the ${tolerancePct} % tolerance (${list}): give a reason.`
}

/** The person's choice against the figures: null when it fits, else the refusal. */
export function reasonRefusal(beyond: Beyond, reasonCode: string | null | undefined, reasonNote: string | null | undefined, tolerancePct: string): { readonly code: CloseRefusal; readonly message: string } | null {
  if (beyond.any && !reasonCode) return { code: 'REASON_NEEDED', message: beyondWords(beyond, tolerancePct) }
  if (!beyond.any && reasonCode) return { code: 'REASON_NOT_NEEDED', message: `Within the ${tolerancePct} % tolerance: the close takes no reason (words go in the note).` }
  if (reasonCode && NOTE_NEEDED.has(reasonCode as CloseReason) && !(reasonNote ?? '').trim()) return { code: 'NOTE_NEEDED', message: 'Say the reason in words.' }
  return null
}

/** Whether a live close may still be undone by this person now (the closer, within UNDO_SECONDS). */
export function mayUndo(close: { readonly closedAt: Date; readonly closedById: string }, actorId: string, now: Date): boolean {
  return close.closedById === actorId && now.getTime() - close.closedAt.getTime() <= UNDO_SECONDS * 1000
}

/** Until when the closer may undo it. */
export const undoUntil = (closedAt: Date): Date => new Date(closedAt.getTime() + UNDO_SECONDS * 1000)

/** The words of the accountant's switch for the close while it is off. */
export const CLOSE_WAITS =
  "Waits for the accountant: the close is a status today. Its variance split and closing entry are written only while the company's figures for the accountant are on (GATE-ACCOUNTANT); a work order closed while they are off is settled by reopening it and closing it again once they are on."
