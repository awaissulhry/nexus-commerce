import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'

/**
 * The weekly payment proposal (B-W2b-403; FIN-140; design finance.payables pop-up "Payment proposal — week 46": "Invoices
 * by due date and discount; total; IBAN checks (usable); Approver ≠ the person who entered"; Rule 1: suppliers are paid
 * every week, the proposal is a spreadsheet today), pure. factory-db bank.prisma PaymentProposal + PaymentProposalLine
 * (B-W2b-370): one per company, week (its Monday) and currency, DRAFT → APPROVED → PAID, or CANCELLED.
 *
 *   candidates   the company's supplier invoices APPROVED and not paid, in the currency, due by the week's Sunday (overdue
 *                included) or not dated, in no other live proposal; earliest due first, then the bigger discount
 *   a line       what is paid (the invoice's total less its withholding less the discount taken) to the supplier's ACTIVE
 *                bank account in that currency (payableAccountOf: the verified one); none: the line is HELD ("No bank
 *                account — payments to this supplier are held") and the proposal is not approved while it holds one
 *   approve      by an active office person who did not make it (the database's rule too) and holds the approval right
 *                (with a fresh code); above the amount a second person's yes as well (./approvals.ts)
 *   paid         a person records that the transfers left the bank (the day and the bank's reference): every invoice of it
 *                PAID, then the proposal PAID. Nothing is paid by itself: the proposal is a list a person approves and
 *                the transfers are made in the bank's own site.
 */

export const PROPOSAL_STATUSES = ['DRAFT', 'APPROVED', 'PAID', 'CANCELLED'] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

export const DUE_BUCKETS = ['OVERDUE', 'THIS_WEEK', 'LATER', 'NO_DUE_DATE'] as const
export type DueBucket = (typeof DUE_BUCKETS)[number]

export const PROPOSAL_LIMITS = Object.freeze({ lines: 500, note: 2000, reason: 2000, paymentRef: 120 })

/** The codes a proposal is refused or held with; each has words (PROPOSAL_WORDS). */
export const PROPOSAL_REFUSALS = [
  'NOT_DRAFT',
  'NOT_APPROVED',
  'EMPTY',
  'HELD',
  'INVOICE_NOT_APPROVED',
  'INVOICE_PAID',
  'IN_ANOTHER_PROPOSAL',
  'CURRENCY',
  'NOT_A_SUPPLIER_INVOICE',
  'OTHER_COMPANY',
  'OWN_PROPOSAL',
  'SECOND_APPROVER',
  'TOO_MUCH',
  'NOT_PAID_YET',
] as const
export type ProposalRefusal = (typeof PROPOSAL_REFUSALS)[number]

export const PROPOSAL_WORDS: Readonly<Record<ProposalRefusal, { readonly en: string; readonly it: string }>> = Object.freeze({
  NOT_DRAFT: { en: 'Only a draft proposal changes: send it back to draft first.', it: 'Si modifica solo una proposta in bozza: rimandala prima in bozza.' },
  NOT_APPROVED: { en: 'The proposal is not approved: it is paid once approved.', it: 'La proposta non è approvata: si paga una volta approvata.' },
  EMPTY: { en: 'The proposal has no invoice to pay.', it: 'La proposta non ha fatture da pagare.' },
  HELD: { en: 'No bank account — payments to this supplier are held. Take the line out or have the account verified first.', it: 'Nessun conto bancario: i pagamenti a questo fornitore sono sospesi. Togli la riga o fai prima verificare il conto.' },
  INVOICE_NOT_APPROVED: { en: 'The invoice is not approved for payment yet.', it: 'La fattura non è ancora approvata per il pagamento.' },
  INVOICE_PAID: { en: 'The invoice is paid or voided already.', it: 'La fattura è già pagata o annullata.' },
  IN_ANOTHER_PROPOSAL: { en: 'The invoice is in another proposal that is not paid or cancelled.', it: "La fattura è in un'altra proposta non ancora pagata o annullata." },
  CURRENCY: { en: "The invoice is in another currency than the proposal's.", it: 'La fattura è in una valuta diversa da quella della proposta.' },
  NOT_A_SUPPLIER_INVOICE: { en: 'A credit note is not paid: only supplier invoices go in a proposal.', it: 'Una nota di credito non si paga: in una proposta vanno solo fatture fornitore.' },
  OTHER_COMPANY: { en: "The invoice is of another company than the proposal's.", it: "La fattura è di un'altra società rispetto alla proposta." },
  OWN_PROPOSAL: { en: 'You made this proposal, so someone else approves it.', it: "Hai preparato tu questa proposta: la approva un'altra persona." },
  SECOND_APPROVER: { en: 'You gave the first approval: a second person gives the other.', it: "Hai dato la prima approvazione: la seconda la dà un'altra persona." },
  TOO_MUCH: { en: "What is paid and the discount together are more than the invoice's total less its withholding.", it: "Pagato e sconto insieme superano il totale della fattura meno la ritenuta." },
  NOT_PAID_YET: { en: 'Record the payment once the transfers left the bank.', it: 'Registra il pagamento quando i bonifici sono partiti dalla banca.' },
})

export const refusalIssue = (code: ProposalRefusal, path = `refusal/${code}`): Issue => ({ path, message: PROPOSAL_WORDS[code].en })

const MS_DAY = 86_400_000
const dayMs = (day: BusinessDate): number => Date.parse(`${day}T00:00:00.000Z`)
const dayOf = (ms: number): BusinessDate => new Date(ms).toISOString().slice(0, 10)

/** The ISO week of a business day: its Monday and its Sunday. */
export function weekOf(day: BusinessDate): { readonly weekStart: BusinessDate; readonly weekEnd: BusinessDate } {
  const at = dayMs(day)
  const back = (new Date(at).getUTCDay() + 6) % 7
  return { weekStart: dayOf(at - back * MS_DAY), weekEnd: dayOf(at + (6 - back) * MS_DAY) }
}

export const isMonday = (day: BusinessDate): boolean => new Date(dayMs(day)).getUTCDay() === 1

/** The ISO week number of a Monday (the pop-up's "week 46"). */
export function isoWeekNumber(weekStart: BusinessDate): number {
  // The week's Thursday names its year; the week number counts that year's Thursdays.
  const thursday = dayMs(weekOf(weekStart).weekStart) + 3 * MS_DAY
  const yearStart = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1)
  return Math.floor((thursday - yearStart) / MS_DAY / 7) + 1
}

export function dueBucket(due: BusinessDate | null, week: { readonly weekStart: BusinessDate; readonly weekEnd: BusinessDate }): DueBucket {
  if (due === null) return 'NO_DUE_DATE'
  if (due < week.weekStart) return 'OVERDUE'
  if (due <= week.weekEnd) return 'THIS_WEEK'
  return 'LATER'
}

export interface CandidateFacts {
  readonly id: string
  readonly number: string
  readonly dueDate: BusinessDate | null
  /** Minor units: the early-payment discount a person typed for the line (none read from the invoice: see the notes). */
  readonly discountAmount?: number | undefined
}

/** Earliest due first (undated last), then the bigger discount, then the number. */
export function byDueAndDiscount<T extends CandidateFacts>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.dueDate !== b.dueDate) return a.dueDate === null ? 1 : b.dueDate === null ? -1 : a.dueDate < b.dueDate ? -1 : 1
    const discount = (b.discountAmount ?? 0) - (a.discountAmount ?? 0)
    return discount !== 0 ? discount : a.number.localeCompare(b.number)
  })
}

/** What an invoice leaves to pay: its total less its withholding (the supplier's tax the company pays the state). */
export const payableOf = (invoice: { readonly grossTotal: number; readonly withholdingAmount: number | null }): number => invoice.grossTotal - (invoice.withholdingAmount ?? 0)

/** A line's amounts: the discount taken (0 or more) and what is paid; null when they do not fit the invoice. */
export function lineAmounts(invoice: { readonly grossTotal: number; readonly withholdingAmount: number | null }, discountAmount = 0): { readonly amount: number; readonly discountAmount: number } | null {
  const payable = payableOf(invoice)
  if (!Number.isSafeInteger(discountAmount) || discountAmount < 0 || discountAmount >= payable) return null
  return { amount: payable - discountAmount, discountAmount }
}

export interface ProposalInvoiceFacts {
  readonly companyId: string
  readonly kind: string
  readonly status: string
  readonly currency: string
  /** The live proposals (DRAFT, APPROVED) it is in, other than this one. */
  readonly inOtherProposal: boolean
}

/** Why an invoice may not be a line of the proposal (none: it may). */
export function lineProblems(invoice: ProposalInvoiceFacts, proposal: { readonly companyId: string; readonly currency: string }, options: { readonly forApproval: boolean }): ProposalRefusal[] {
  const problems: ProposalRefusal[] = []
  if (invoice.companyId !== proposal.companyId) problems.push('OTHER_COMPANY')
  if (invoice.kind !== 'INVOICE') problems.push('NOT_A_SUPPLIER_INVOICE')
  if (invoice.status === 'PAID' || invoice.status === 'VOIDED') problems.push('INVOICE_PAID')
  else if (options.forApproval && invoice.status !== 'APPROVED') problems.push('INVOICE_NOT_APPROVED')
  if (invoice.currency !== proposal.currency) problems.push('CURRENCY')
  if (invoice.inOtherProposal) problems.push('IN_ANOTHER_PROPOSAL')
  return problems
}

export interface ApprovalFacts {
  readonly status: ProposalStatus
  readonly createdById: string
  readonly lines: readonly { readonly held: boolean; readonly problems: readonly ProposalRefusal[] }[]
}

/** Why the person may not approve the proposal now (none: they may), the database's rules said first in words. */
export function approvalProblems(facts: ApprovalFacts, actorId: string): ProposalRefusal[] {
  const problems: ProposalRefusal[] = []
  if (facts.status !== 'DRAFT') problems.push('NOT_DRAFT')
  if (facts.createdById === actorId) problems.push('OWN_PROPOSAL')
  if (facts.lines.length === 0) problems.push('EMPTY')
  if (facts.lines.some((line) => line.held)) problems.push('HELD')
  for (const code of new Set(facts.lines.flatMap((line) => line.problems))) problems.push(code)
  return problems
}

/** The week's title ("Payment proposal — week 46"). */
export const proposalTitle = (weekStart: BusinessDate): { readonly en: string; readonly it: string } => ({ en: `Payment proposal — week ${isoWeekNumber(weekStart)}`, it: `Proposta di pagamento — settimana ${isoWeekNumber(weekStart)}` })
