import { fromMinorUnits, minorPlaces, toMinorUnits } from '../../core/money'
import { Dec } from '../../tax/decimal'

/**
 * Separation of duties and dual approval on payments (B-W2b-403; FIN-142; design finance.payables record tab Approval:
 * "You entered this invoice, so someone else approves it; dual approval above 10,000 (W2b)", pop-up "Payment proposal —
 * Approver ≠ the person who entered"), pure.
 *
 *   four eyes    the person who entered a supplier invoice (W2a's rule, B-W2a-F7) or made a payment proposal never approves
 *                it, the Owner included (the database holds the proposal's rule: B-W2b-370)
 *   dual         an invoice whose total, or a proposal whose sum, is above the amount needs a second person's yes as well:
 *                the first yes is a REQUESTED line of the platform's approval history on the record (by the first approver,
 *                "a second approval is needed"); the second yes, by anyone else allowed, is its APPROVED line, and the
 *                database refuses that line from the person of the last REQUESTED one. A change of the record between the
 *                two yeses (its version moved) lapses the first: the next yes is a first again.
 *
 * The amount is the design's 10,000 in the record's currency: a NAMED setting, not decided (no settings column keeps it
 * yet: the step's schema need), said in words on every answer.
 */

export interface DualApprovalSetting {
  /** Major units of the record's currency: a total ABOVE it needs two people. */
  readonly aboveMajor: string
  /** False until the Owner sets the amount (a settings column: schema need). */
  readonly decided: boolean
  readonly words: { readonly en: string; readonly it: string }
}

export const DUAL_APPROVAL: DualApprovalSetting = Object.freeze({
  aboveMajor: '10000',
  decided: false,
  words: Object.freeze({
    en: 'The design’s amount, not set by the Owner yet: invoices and payment proposals above 10,000 need a second person’s approval.',
    it: 'L’importo del progetto, non ancora deciso dal titolare: fatture e proposte di pagamento sopra 10.000 richiedono l’approvazione di una seconda persona.',
  }),
})

/** The amount in minor units of a currency. */
export const dualThresholdMinor = (currency: string, setting: DualApprovalSetting = DUAL_APPROVAL): number => toMinorUnits(new Dec(setting.aboveMajor), currency)

/** The total needs a second person's yes. */
export const needsSecondApproval = (totalMinor: number, currency: string, setting: DualApprovalSetting = DUAL_APPROVAL): boolean => totalMinor > dualThresholdMinor(currency, setting)

export const DUAL_STEPS = ['SINGLE', 'FIRST', 'SECOND'] as const
export type DualStep = (typeof DUAL_STEPS)[number]

/** The amount in words with its currency ("10,000.00 EUR"); `prices`: shown only with the record's grain. */
export function thresholdText(currency: string, setting: DualApprovalSetting = DUAL_APPROVAL): string {
  return `${fromMinorUnits(dualThresholdMinor(currency, setting), currency).toFixed(minorPlaces(currency))} ${currency}`
}

/** What waits, in words: a first yes given, a second person approves. `amount`: the threshold the reader may see, or null. */
export function secondApprovalWords(firstBy: string | null, amount: string | null): { readonly en: string; readonly it: string } {
  const above = amount ? { en: ` above ${amount}`, it: ` sopra ${amount}` } : { en: ' above the amount', it: " sopra l'importo" }
  const who = firstBy ? { en: `Approved once by ${firstBy}`, it: `Approvata una volta da ${firstBy}` } : { en: 'Approved once', it: 'Approvata una volta' }
  return { en: `${who.en}: a second person approves totals${above.en}.`, it: `${who.it}: i totali${above.it} li approva una seconda persona.` }
}

/** The first yes's line in the record's approval history (no money: the history has no grain). */
export const FIRST_APPROVAL_LINE = 'First approval of two: a second person approves totals above the amount.'
/** The second yes's line. */
export const SECOND_APPROVAL_LINE = 'Second approval: approved by two people.'
