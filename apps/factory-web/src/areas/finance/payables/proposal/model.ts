import { scoped, type Phrase } from '../../payments/riba/depth'
import { feeMinor } from '../../payments/riba/model'
import { PROPOSAL_LIMITS, PROPOSAL_REFUSALS, type LineInput, type Proposal, type ProposalCandidate, type ProposalHold } from './api'

/**
 * The payment proposal's rules without a screen (B-W2b-425): the week (its Monday), which approved invoices are picked and
 * the discount typed per line, a hold in words (`may.*`: a refusal code or no right), the four eyes and the second person's
 * yes, recording the transfers made. Every phrase is a key of this step's catalogue for a `finance`-scoped translator. Pure:
 * the tests hold it.
 */

export interface ProposalCan {
  view: boolean
  manage: boolean
  approve: boolean
  pay: boolean
  cost: boolean
}

export const proposalCanOf = (permissions: readonly string[]): ProposalCan => ({
  view: permissions.includes('payables.view'),
  manage: permissions.includes('payables.proposals.manage'),
  approve: permissions.includes('payables.proposals.approve'),
  pay: permissions.includes('payables.pay'),
  cost: permissions.includes('money.cost'),
})

const MS_DAY = 86_400_000
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00.000Z`)
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** The Monday of a day's ISO week. */
export function mondayOf(day: string): string {
  const at = dayMs(day)
  return dayOf(at - ((new Date(at).getUTCDay() + 6) % 7) * MS_DAY)
}

/** The weeks offered: this one (default) and the next. */
export const weeksFrom = (today: string): string[] => [mondayOf(today), dayOf(dayMs(mondayOf(today)) + 7 * MS_DAY)]

/** The ISO week number of a Monday ("week 46"). */
export function isoWeek(weekStart: string): number {
  const thursday = dayMs(mondayOf(weekStart)) + 3 * MS_DAY
  const yearStart = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1)
  return Math.floor((thursday - yearStart) / MS_DAY / 7) + 1
}

/** A candidate that may join a new proposal (in no other live proposal). Held ones (no verified account) may, and hold its approval. */
export const pickable = (row: ProposalCandidate): boolean => row.inProposal === null

/** Picked by default: every free candidate with a usable account. */
export const defaultPicks = (rows: readonly ProposalCandidate[]): string[] => rows.filter((row) => pickable(row) && !row.held).map((row) => row.invoiceId)

/** The discounts typed (major units, by invoice id) as minor units; a discount that does not parse names its invoice. */
export function linesOf(rows: readonly ProposalCandidate[], picked: ReadonlySet<string>, discounts: Readonly<Record<string, string>>): { lines: LineInput[]; problem: Phrase | null } {
  const lines: LineInput[] = []
  for (const row of rows) {
    if (!pickable(row) || !picked.has(row.invoiceId)) continue
    const typed = (discounts[row.invoiceId] ?? '').trim()
    if (typed === '') {
      lines.push({ invoiceId: row.invoiceId })
      continue
    }
    const minor = feeMinor(typed)
    if (minor === null) return { lines: [], problem: { key: scoped('proposal.held.discount'), params: { number: row.number } } }
    if (row.payable !== undefined && minor >= row.payable) return { lines: [], problem: { key: scoped('refusal.proposal.TOO_MUCH') } }
    lines.push(minor > 0 ? { invoiceId: row.invoiceId, discountAmount: minor } : { invoiceId: row.invoiceId })
  }
  if (lines.length > PROPOSAL_LIMITS.lines) return { lines: [], problem: { key: scoped('proposal.held.tooMany'), params: { max: PROPOSAL_LIMITS.lines } } }
  return { lines, problem: lines.length === 0 ? { key: scoped('proposal.held.nonePicked') } : null }
}

/** What the picked lines pay (minor units, less the discounts typed), null without the cost grain. */
export function pickedPayable(rows: readonly ProposalCandidate[], picked: ReadonlySet<string>, discounts: Readonly<Record<string, string>>): number | null {
  let total = 0
  for (const row of rows) {
    if (!pickable(row) || !picked.has(row.invoiceId)) continue
    if (row.payable === undefined) return null
    total += row.payable - (feeMinor(discounts[row.invoiceId] ?? '') ?? 0)
  }
  return total
}

/** A `may.*` hold in words (null: allowed). */
export const holdPhrase = (hold: ProposalHold | null): Phrase | null => (hold === null ? null : hold === 'NO_PERMISSION' ? { key: scoped('proposal.held.right') } : { key: scoped(`refusal.proposal.${hold}`) })

/** The four eyes in words: the maker never approves; someone else does. */
export const fourEyesPhrase = (proposal: Proposal): Phrase => (proposal.may.approve === 'OWN_PROPOSAL' ? { key: scoped('refusal.proposal.OWN_PROPOSAL') } : { key: scoped('proposal.fourEyes') })

/** Where the dual approval stands: not needed, needed (no yes yet), a first yes standing (who), lapsed. */
export function dualPhrase(proposal: Proposal, amount: string | null): Phrase {
  const dual = proposal.approval.dual
  if (!dual.needed) return amount ? { key: scoped('proposal.dual.notNeeded'), params: { amount } } : { key: scoped('proposal.dual.notNeededPlain') }
  if (dual.first?.standing) return { key: scoped('proposal.dual.first'), params: { name: dual.first.by?.name ?? '—' } }
  return amount ? { key: scoped('proposal.dual.needed'), params: { amount } } : { key: scoped('proposal.dual.neededPlain') }
}

/** Why "Record paid" waits: a day not in the future, the bank's reference. */
export function paidHeld(input: { paidOn: string; reference: string; today: string }): Phrase | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) return { key: scoped('proposal.paid.day') }
  if (input.paidOn > input.today) return { key: scoped('proposal.paid.future') }
  if (input.reference.trim() === '') return { key: scoped('proposal.paid.reference') }
  if (input.reference.length > PROPOSAL_LIMITS.paymentRef) return { key: scoped('proposal.paid.referenceLong'), params: { max: PROPOSAL_LIMITS.paymentRef } }
  return null
}

export const PROPOSAL_TONE: Record<Proposal['status'], 'neutral' | 'info' | 'success'> = { DRAFT: 'neutral', APPROVED: 'info', PAID: 'success', CANCELLED: 'neutral' }
export const DUE_TONE: Record<ProposalCandidate['due'], 'danger' | 'warning' | 'neutral'> = { OVERDUE: 'danger', THIS_WEEK: 'warning', LATER: 'neutral', NO_DUE_DATE: 'neutral' }

export const proposalRefusals: readonly string[] = PROPOSAL_REFUSALS

/** A live event that changes a proposal or what may join one. */
export const proposalTouched = (change: { type: string }): boolean => change.type === 'payment_proposal.changed' || change.type.startsWith('supplier_invoice.')
