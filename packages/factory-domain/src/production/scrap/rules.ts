import { quantityText } from '../../inventory/ledger/moves'
import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import type { WorkOrderStatus } from '../work-orders/machine'

/**
 * Scrap and its replacement (B-W2a-13; MES-129, MES-130; design production.scrap "Scrap & rework", "Replace scrapped
 * quantity"), pure. The API (apps/factory-api modules/production/scrap) reads the facts inside its command; the
 * …_production_w2a_guards ReplacementRequest trigger stays the last word.
 *
 * Replacement (MES-130): scrapped garments of one cell are replaced so the order is still met:
 *   RECUT    cut again from the cell's material (whole garments, or the sets of one part): OPEN is the cutting room's
 *            recut list; DONE with the cut log entry that cut it (an entry of the work order, not a reversal, with
 *            pieces of the cell, and of the part when one is named).
 *   REDUCE   lower what the order is owed instead: a second person approves or refuses it (never the one who asked; a
 *            refusal says why). Lowering the order line itself is the order's short-close (wave 2's SalesOrderLine,
 *            B-W2a-30): the approved request waits there, DONE once the line is lowered.
 *   Both name what scrapped the garments: a scan with scrap, a rework DONE with scrap, a record of another W2a wave (a
 *   nonconformance), or none (typed by hand with the reason); at most what that source scrapped, less what other open
 *   or done requests of it replace already. The work order is RELEASED, IN_PROGRESS, ON_HOLD or COMPLETED.
 *
 * Scrap by lot (MES-129): the leather of a scrapped garment is the area its pieces took from the hides of its bundle's
 * cut log entries. Each entry gives its share of the garment by the garments it cut for the cell (`scrapByLot`), at the
 * BOM's need per garment in that leather. That leather left stock when it was issued to the work order (the cut issues
 * a hide whole; its remnant comes back): the scrap moves no stock again, it says which lot and hide lost how much area,
 * and its value at the cost the issue was valued at (the cost grain). Material scrapped while it is still in stock (a
 * damaged remnant, a lot at the cutting rack) leaves stock as a SCRAP move by lot for the work order (stock.ts).
 */

export const REPLACEMENT_KINDS = ['RECUT', 'REDUCE'] as const
export type ReplacementKind = (typeof REPLACEMENT_KINDS)[number]
export const REPLACEMENT_STATUSES = ['OPEN', 'APPROVED', 'REFUSED', 'DONE', 'CANCELLED'] as const
export type ReplacementStatus = (typeof REPLACEMENT_STATUSES)[number]

/** The statuses a work order's scrap is replaced in. */
export const REPLACE_STATUSES: readonly WorkOrderStatus[] = Object.freeze(['RELEASED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED'])

export const REPLACEMENT_REFUSALS = [
  'WORK_ORDER_NOT_OPEN',
  'MORE_THAN_CELL',
  'NOT_A_PART',
  'PART_ON_REDUCE',
  'NO_SCRAP',
  'MORE_THAN_SCRAPPED',
  'WRONG_STATE',
  'SELF_DECISION',
  'NOT_A_RECUT',
  'NOT_A_REDUCE',
  'CUT_NOT_OF_CELL',
] as const
export type ReplacementRefusalCode = (typeof REPLACEMENT_REFUSALS)[number]

export interface ReplacementRefusal {
  readonly code: ReplacementRefusalCode
  readonly message: string
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

export interface AskFacts {
  readonly workOrder: { readonly number: string; readonly status: WorkOrderStatus }
  readonly cell: { readonly label: string; readonly quantity: number; readonly parts: readonly string[] }
  readonly kind: ReplacementKind
  readonly quantity: number
  readonly part: string | null
  /** What scrapped them (a scan with scrap, a rework DONE with scrap): how many it scrapped, and how many open or done requests of it replace already. */
  readonly source: { readonly what: string; readonly scrapped: number; readonly replaced: number } | null
}

/** Why the replacement may not be asked, or null. */
export function askRefusal(facts: AskFacts): ReplacementRefusal | null {
  if (!REPLACE_STATUSES.includes(facts.workOrder.status)) {
    return { code: 'WORK_ORDER_NOT_OPEN', message: `Work order ${facts.workOrder.number} is ${facts.workOrder.status}; its scrap is replaced while it is RELEASED, IN_PROGRESS, ON_HOLD or COMPLETED.` }
  }
  if (facts.quantity < 1 || facts.quantity > facts.cell.quantity) {
    return { code: 'MORE_THAN_CELL', message: `${facts.cell.label} makes ${plural(facts.cell.quantity, 'garment')}; ${facts.quantity} asked.` }
  }
  if (facts.kind === 'REDUCE' && facts.part !== null) return { code: 'PART_ON_REDUCE', message: 'An order is lowered by whole garments: name no part.' }
  if (facts.part !== null && !facts.cell.parts.includes(facts.part)) {
    return { code: 'NOT_A_PART', message: `${facts.part} is not a part of ${facts.cell.label} cut from hides${facts.cell.parts.length > 0 ? ` (${facts.cell.parts.join(', ')})` : ''}.` }
  }
  if (facts.source) {
    if (facts.source.scrapped < 1) return { code: 'NO_SCRAP', message: `${facts.source.what} scrapped nothing.` }
    const left = facts.source.scrapped - facts.source.replaced
    if (facts.quantity > left) {
      return {
        code: 'MORE_THAN_SCRAPPED',
        message: left <= 0 ? `Every garment ${facts.source.what} scrapped (${facts.source.scrapped}) is replaced already.` : `${facts.source.what} scrapped ${plural(facts.source.scrapped, 'garment')}; ${left} not yet replaced, ${facts.quantity} asked.`,
      }
    }
  }
  return null
}

/** The garments a source's requests replace already: those not REFUSED or CANCELLED. */
export function replacedFrom(requests: readonly { readonly status: ReplacementStatus; readonly quantity: number }[]): number {
  return requests.filter((request) => request.status !== 'REFUSED' && request.status !== 'CANCELLED').reduce((sum, request) => sum + request.quantity, 0)
}

/** Why a REDUCE may not be approved or refused by this person, or null. */
export function decisionRefusal(facts: { readonly kind: ReplacementKind; readonly status: ReplacementStatus; readonly createdById: string | null; readonly deciderId: string }): ReplacementRefusal | null {
  if (facts.kind !== 'REDUCE') return { code: 'NOT_A_REDUCE', message: 'A recut needs no approval: it is done by the cut that cuts it.' }
  if (facts.status !== 'OPEN') return { code: 'WRONG_STATE', message: `This request is ${facts.status}; it was decided already.` }
  if (facts.createdById !== null && facts.createdById === facts.deciderId) return { code: 'SELF_DECISION', message: 'You asked for it: another person approves or refuses it (four eyes).' }
  return null
}

/** Why the request may not be cancelled, or null: only OPEN, or an APPROVED reduction not carried out yet. */
export function cancelRefusal(status: ReplacementStatus): ReplacementRefusal | null {
  return status === 'OPEN' || status === 'APPROVED' ? null : { code: 'WRONG_STATE', message: `This request is ${status}; it stays as it is.` }
}

/** Why the recut may not be marked done by this cut log entry, or null. */
export function recutDoneRefusal(facts: {
  readonly kind: ReplacementKind
  readonly status: ReplacementStatus
  readonly part: string | null
  readonly cellLabel: string
  /** The entry: of this work order, live (no reversal, not reversed), its pieces per cell and part. */
  readonly entry: { readonly live: boolean; readonly pieces: readonly { readonly cellId: string; readonly part: string; readonly pieces: number }[] } | null
  readonly cellId: string
}): ReplacementRefusal | null {
  if (facts.kind !== 'RECUT') return { code: 'NOT_A_RECUT', message: 'An order reduction is not cut: it is approved, then the order line is lowered.' }
  if (facts.status !== 'OPEN') return { code: 'WRONG_STATE', message: `This recut is ${facts.status}.` }
  const cut = facts.entry?.live ? facts.entry.pieces.filter((piece) => piece.cellId === facts.cellId && (facts.part === null || piece.part === facts.part)) : []
  if (cut.length === 0) {
    return { code: 'CUT_NOT_OF_CELL', message: `That cut log entry cut no pieces of ${facts.cellId ? facts.cellLabel : 'this cell'}${facts.part ? ` (${facts.part})` : ''}, or it is a reversal or reversed.` }
  }
  return null
}

// ---- scrap by lot -------------------------------------------------------------------------------------------------------------------

/** A cut log entry of the bundle, as the scrap reads it: the hide and lot, and the garments it cut for the cell. */
export interface ScrapEntry {
  readonly cutLogId: string
  readonly lotId: string
  readonly hideId: string
  /** Garments of the cell (whole sets, or pieces of the bundle's part) this entry cut. */
  readonly garments: number
}

export interface ScrapShare {
  readonly lotId: string
  readonly hideId: string
  /** The area in the leather's base unit, four places. */
  readonly area: string
}

/**
 * The leather `scrapped` garments held, per lot and hide: each entry's share of the garments by the garments it cut for
 * the cell, at `perGarment` (the BOM's need for one garment of the cell in that leather, base unit). Shares of one hide
 * add up; the total is scrapped × perGarment (rounded to four places, half up).
 */
export function scrapByLot(scrapped: number, entries: readonly ScrapEntry[], perGarment: DecimalInput | null): ScrapShare[] {
  const total = entries.reduce((sum, entry) => sum + entry.garments, 0)
  if (scrapped <= 0 || total <= 0 || perGarment === null) return []
  const need = new Dec(perGarment).times(scrapped)
  const byHide = new Map<string, { lotId: string; hideId: string; area: Decimal }>()
  for (const entry of entries) {
    if (entry.garments <= 0) continue
    const share = need.times(entry.garments).div(total)
    const key = entry.hideId
    const row = byHide.get(key) ?? { lotId: entry.lotId, hideId: entry.hideId, area: ZERO }
    byHide.set(key, { ...row, area: row.area.plus(share) })
  }
  return [...byHide.values()].map((row) => ({ lotId: row.lotId, hideId: row.hideId, area: quantityText(row.area.toDecimalPlaces(4, Dec.ROUND_HALF_UP).toString()) }))
}
