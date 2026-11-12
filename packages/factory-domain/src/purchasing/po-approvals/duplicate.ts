import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { MAX_LINES } from '../orders'

/**
 * Duplicate a purchase order or reorder some of its lines (B-W2b-305; SCM-057 "Copying a past PO is a convenience"; design
 * purchasing.orders row verb "Duplicate (W2b)"): a NEW draft to the same supplier for the same site, with the lines chosen
 * (all its lines that were not cancelled, by default). A copy is a new order, never a revision: nothing of the old one
 * changes, and it is sent (and, when a rule says so, approved) as any draft.
 *
 *   need dates    the day given; else the old line's day when it is still ahead of the earliest day the supplier can
 *                 deliver (today plus its lead time, around its closed days); else that earliest day
 *   the header    contact (when still active), currency, incoterms, payment terms and the note for the supplier are
 *                 copied; the date asked for only when it is still ahead; the internal note never (it was about that order)
 *   prices        today's price of the supplier's approved source when it has one (the price it quotes now); else the old
 *                 line's price (the buyer sees it on the draft before sending)
 */

export const MAX_COPY_LINES = MAX_LINES

/** The lines a copy takes, or why it cannot: named lines must be the order's and not cancelled; at least one. */
export function copyLinesOf(lines: readonly { readonly id: string; readonly seq: number; readonly cancelled: boolean }[], chosen: readonly string[] | null): { ids: string[]; problems: Issue[] } {
  if (chosen === null) {
    const ids = lines.filter((line) => !line.cancelled).map((line) => line.id)
    return ids.length === 0 ? { ids, problems: [{ path: 'body/lineIds', message: 'Every line of this order was cancelled: there is nothing to copy.' }] } : { ids, problems: [] }
  }
  const problems: Issue[] = []
  const byId = new Map(lines.map((line) => [line.id, line]))
  if (new Set(chosen).size !== chosen.length) problems.push({ path: 'body/lineIds', message: 'A line is named twice.' })
  chosen.forEach((id, index) => {
    const line = byId.get(id)
    if (!line) problems.push({ path: `body/lineIds/${index}`, message: 'Not a line of this order.' })
    else if (line.cancelled) problems.push({ path: `body/lineIds/${index}`, message: `Line ${line.seq} was cancelled: it is not copied.` })
  })
  if (chosen.length === 0) problems.push({ path: 'body/lineIds', message: 'Choose at least one line.' })
  // In the order's own order (by line number), whatever order they were named in.
  const ids = lines.filter((line) => chosen.includes(line.id)).map((line) => line.id)
  return { ids, problems }
}

/** The need date of a copied line (see the module comment). */
export function copiedNeedDate(original: BusinessDate, earliest: BusinessDate, given: BusinessDate | null): BusinessDate {
  if (given !== null) return given
  return original >= earliest ? original : earliest
}

/** The date asked for of the copy: the old one only when it is still today or later. */
export const copiedRequestedDate = (original: BusinessDate | null, today: BusinessDate): BusinessDate | null => (original !== null && original >= today ? original : null)

/** A need date the body gives: today or later. */
export const givenNeedDateProblem = (given: BusinessDate | null, today: BusinessDate): string | null => (given !== null && given < today ? 'The need date of a new order is today or later.' : null)
