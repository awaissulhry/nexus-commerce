import type { AnswerOutcome } from './answer'

/**
 * What the supplier's answer says to people (B-W1-31; design links.po "Confirmed" end state, plan-buy-pay "Supplier's
 * answer"), pure:
 *
 *   doneMessage   the link page's end state right after the answer ("Confirmed — thank you. Bianca sees it now.");
 *   buyerNote     the internal note the worker writes on the order's thread for the buyer (English, the office's
 *                 language), from what the order keeps: who answered (the typed name, when given), their reference,
 *                 the summary or the lines in words, their note, and what to do next.
 */

export function doneMessage(outcome: AnswerOutcome, buyerName: string | null): string {
  const who = buyerName ?? 'The buyer'
  switch (outcome) {
    case 'CONFIRMED':
      return `Confirmed — thank you. ${who} sees it now. Need to change something later? Reply to our e-mail.`
    case 'PROPOSED':
      return `Thank you: your changes are with ${buyerName ?? 'the buyer'}, who accepts or refuses them. You will hear back by e-mail.`
    case 'DECLINED':
      return `Declined — ${who} sees it now and will get back to you.`
  }
}

export interface BuyerNoteFacts {
  readonly documentNumber: string
  readonly outcome: AnswerOutcome
  /** The name typed on the link (optional). */
  readonly byName: string | null
  readonly supplierRef: string | null
  readonly note: string | null
  /** "all 3 lines as asked" or the summary of a proposal. */
  readonly summary: string | null
  /** A proposal's lines in words (answer.ts lineAnswerText). */
  readonly lines?: readonly string[]
  /** A decline's words (the order's declineReason). */
  readonly declineReason?: string | null
}

export function buyerNote(facts: BuyerNoteFacts): string {
  const by = facts.byName ? ` by ${facts.byName}` : ''
  const ref = facts.supplierRef ? ` (their reference ${facts.supplierRef})` : ''
  const note = facts.note ? [`Their note: ${facts.note}`] : []
  switch (facts.outcome) {
    case 'CONFIRMED':
      return [`The supplier confirmed ${facts.documentNumber} through its link${by}${ref}: ${facts.summary ?? 'as asked'}.`, ...note].join('\n')
    case 'PROPOSED':
      return [
        `The supplier proposed changes to ${facts.documentNumber} through its link${by}${ref}: ${facts.summary ?? 'see the lines'}.`,
        ...(facts.lines ?? []),
        ...note,
        'Accept or refuse them on the order: until then nothing is confirmed and the plan keeps the dates asked.',
      ].join('\n')
    case 'DECLINED':
      return [`The supplier declined ${facts.documentNumber} through its link${by}.`, facts.declineReason ?? '', 'Change the order and send it again, or cancel it.'].filter((line) => line !== '').join('\n')
  }
}
