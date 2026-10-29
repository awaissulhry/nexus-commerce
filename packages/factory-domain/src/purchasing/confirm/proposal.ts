import { Decimal } from 'decimal.js'
import type { BusinessDate } from '../../core/time'
import type { DocumentLanguage } from '../../documents/model'
import { QUANTITY_SCALE } from '../../product/units/units'
import { type AnsweredLine, type Delivery, type LineAnswerKind, type LineChange } from './answer'

/**
 * The supplier's proposed changes, as the order keeps them (B-W1-31; SCM-086; Owner question P2, answer A: the BUYER
 * decides), pure:
 *
 *   store      an answered line → the line's proposal columns: its (first) delivery's quantity and date, a second delivery
 *              for a split, the reason; as asked: the asked quantity and need date; cannot deliver: 0, no date
 *   read       the columns → the answered line again (kind, deliveries, total, completion date, changes)
 *   accept     the confirmation a proposal becomes: the whole quantity by its (last) delivery's date; 0 and no date for a
 *              line it cannot deliver
 *   decide     only an order with changes proposed waits for the buyer's decision
 *   mail       the supplier hears that the buyer accepted its changes (a refusal comes with the office's new link or its
 *              cancellation, in the office's own words)
 */

export interface ProposalColumns {
  readonly proposedQuantity: string
  readonly proposedDate: BusinessDate | null
  readonly proposedSplitQuantity: string | null
  readonly proposedSplitDate: BusinessDate | null
  readonly proposalReason: string | null
}

/** The proposal columns of one answered line. */
export function proposalColumnsOf(line: Pick<AnsweredLine, 'deliveries' | 'reason'>): ProposalColumns {
  const [first, second] = line.deliveries
  return {
    proposedQuantity: first?.quantity ?? new Decimal(0).toFixed(QUANTITY_SCALE),
    proposedDate: first?.date ?? null,
    proposedSplitQuantity: second?.quantity ?? null,
    proposedSplitDate: second?.date ?? null,
    proposalReason: line.reason,
  }
}

export interface StoredProposalLine {
  readonly id: string
  readonly seq: number
  /** As asked, four places, in `uom`. */
  readonly quantity: string
  readonly uom: string
  readonly needDate: BusinessDate
  readonly proposedQuantity: string | null
  readonly proposedDate: BusinessDate | null
  readonly proposedSplitQuantity: string | null
  readonly proposedSplitDate: BusinessDate | null
  readonly proposalReason: string | null
}

const q4 = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)

/** The answered line a stored proposal says, or null when the line holds no proposal. */
export function proposedLineOf(line: StoredProposalLine): AnsweredLine | null {
  if (line.proposedQuantity === null) return null
  const asked = { quantity: q4(new Decimal(line.quantity)), uom: line.uom, needDate: line.needDate }
  const first = new Decimal(line.proposedQuantity)
  const deliveries: Delivery[] = first.isZero() ? [] : [{ quantity: q4(first), date: line.proposedDate }]
  if (line.proposedSplitQuantity !== null) deliveries.push({ quantity: q4(new Decimal(line.proposedSplitQuantity)), date: line.proposedSplitDate })
  const total = deliveries.reduce((sum, part) => sum.plus(part.quantity), new Decimal(0))
  const date = deliveries.length === 0 ? null : (deliveries.map((part) => part.date).filter((value): value is BusinessDate => value !== null).sort().at(-1) ?? null)
  const kind: LineAnswerKind = deliveries.length === 0 ? 'CANNOT_DELIVER' : deliveries.length > 1 ? 'SPLIT' : total.eq(asked.quantity) && date === asked.needDate ? 'AS_ASKED' : 'OTHER'
  const changes: LineChange[] = []
  if (kind === 'CANNOT_DELIVER') changes.push('CANNOT_DELIVER')
  else {
    if (kind === 'SPLIT') changes.push('SPLIT')
    if (date !== null && date > asked.needDate) changes.push('LATER')
    if (date !== null && date < asked.needDate) changes.push('EARLIER')
    if (total.lt(asked.quantity)) changes.push('LESS')
    if (total.gt(asked.quantity)) changes.push('MORE')
  }
  return { lineId: line.id, seq: line.seq, kind, asked, deliveries, quantity: q4(total), date, reason: line.proposalReason, changes }
}

/** The confirmation an accepted proposal becomes: the whole quantity by the date the line is complete. */
export function acceptedConfirmationOf(line: Pick<AnsweredLine, 'quantity' | 'date'>): { readonly confirmedQuantity: string; readonly confirmedDate: BusinessDate | null } {
  return { confirmedQuantity: line.quantity, confirmedDate: line.date }
}

/** Why the buyer cannot decide on a proposal now, or null (only CHANGES_PROPOSED waits for the decision). */
export function decisionProblem(status: string): string | null {
  if (status === 'CHANGES_PROPOSED') return null
  if (status === 'SENT') return 'The supplier has not proposed changes to this order (or its proposal was refused already).'
  return 'The order has no proposal waiting for a decision.'
}

const ACCEPTED_MAIL = {
  it: {
    subject: (number: string) => `Ordine di acquisto ${number}: modifiche accettate`,
    hello: (name: string | null) => (name ? `Gentile ${name},` : 'Gentile fornitore,'),
    body: (number: string) => `abbiamo accettato le modifiche che ci ha proposto: l'ordine ${number} è confermato come da sua proposta. Grazie.`,
  },
  en: {
    subject: (number: string) => `Purchase order ${number}: changes accepted`,
    hello: (name: string | null) => (name ? `Dear ${name},` : 'Dear supplier,'),
    body: (number: string) => `we accepted the changes you proposed: purchase order ${number} is confirmed as you proposed it. Thank you.`,
  },
} as const

/** The supplier is told that the buyer accepted its changes (the office's own words after ours, when it wrote some). */
export function proposalAcceptedMail(input: { readonly language: DocumentLanguage; readonly number: string; readonly recipientName: string | null; readonly message?: string | null }): { readonly subject: string; readonly body: string } {
  const words = ACCEPTED_MAIL[input.language]
  const message = input.message?.trim() ? [input.message.trim()] : []
  return { subject: words.subject(input.number), body: [words.hello(input.recipientName), words.body(input.number), ...message].join('\n\n') }
}
