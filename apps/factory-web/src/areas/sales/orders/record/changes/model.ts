import type { BrandRequest } from '../../../../home/approvals/requests/api'
import type { OfficeRequest } from '../../../../../record-panels/approvals/api'
import type { Amendment, Order } from '../../api'
import { moneyChange } from '../../daily-model'
import type { Change, Confirmation } from '../../depth/api'
import { putBackOffered } from '../../depth/model'

/**
 * F-SA-236 (sales page plan N2, N3, P5; 10-order-page §2.4) — Changes as ONE newest-first story, without a screen: what waits on us
 * (the customer's open requests, oldest first), what waits on the customer (the changed order's new yes, our counter-offers, the
 * approvals we asked), and the history — requests asked and answered, amendments (the one `…/changes` read: priced or not, Put back),
 * confirmations made and sent — filtered by its chips. Only this order's records; money only by grain (the reads drop it).
 */

/** The requests that wait on us (open) or on the customer (our counter-offer), oldest first. */
export function waitingOnUsOf(requests: readonly BrandRequest[]): BrandRequest[] {
  return requests.filter((request) => request.status === 'OPEN' || request.status === 'COUNTERED').sort((a, b) => a.askedAt.localeCompare(b.askedAt))
}

export interface CustomerWait {
  readonly id: string
  readonly kind: 'reaccept' | 'counter' | 'approval'
  /** An approval's question as we asked it (our words). */
  readonly question: string | null
  readonly since: string | null
  readonly dueAt: string | null
  /** An approval's state code (record-approvals status.*); null for the others. */
  readonly status: string | null
}

/** What we asked the customer and they have not answered: the new yes of a changed order, a counter-offer, an approval still open. */
export function waitingOnCustomerOf(requests: readonly BrandRequest[], approvals: readonly OfficeRequest[], order: Pick<Order, 'id' | 'reapprovalNeededAt'>): CustomerWait[] {
  const out: CustomerWait[] = []
  if (order.reapprovalNeededAt) out.push({ id: `reaccept-${order.id}`, kind: 'reaccept', question: null, since: order.reapprovalNeededAt, dueAt: null, status: null })
  for (const request of requests) if (request.status === 'COUNTERED' && request.counter) out.push({ id: `counter-${request.id}`, kind: 'counter', question: null, since: request.counter.at, dueAt: null, status: null })
  for (const approval of approvals) if (approval.status === 'OPEN' && approval.kind !== 'COUNTER_OFFER') out.push({ id: approval.id, kind: 'approval', question: approval.question, since: approval.createdAt, dueAt: approval.dueAt, status: approval.status })
  return out
}

// ---- the history ----------------------------------------------------------------------------------------------------------------

export const HISTORY_CHIPS = ['all', 'requests', 'amendments', 'confirmations'] as const
export type HistoryChip = (typeof HISTORY_CHIPS)[number]

export type HistoryEntry =
  | { readonly kind: 'requestAsked'; readonly id: string; readonly at: string; readonly request: BrandRequest }
  | { readonly kind: 'requestAnswered'; readonly id: string; readonly at: string; readonly request: BrandRequest }
  | {
      readonly kind: 'amendment'
      readonly id: string
      readonly at: string
      readonly revision: number
      readonly by: string | null
      readonly reason: string
      readonly counts: { readonly changed: number; readonly added: number; readonly removed: number; readonly before: number; readonly after: number }
      /** The net's change (price grain; null without it). */
      readonly money: { readonly delta: number } | null
      readonly priced: boolean
      /** The customer must accept again / accepted / refused (codes of the read). */
      readonly customer: string | null
      /** Put back is offered (the depth's rule: turned down, refused or expired, and the API may); the button holds the right. */
      readonly putBack: boolean
      /** The change as the changes read gave it (a priced change: its fee, extra deposit, the yes it waits for, the customer's answer). */
      readonly change: Change | null
    }
  | { readonly kind: 'confirmationMade'; readonly id: string; readonly at: string; readonly version: number; readonly by: string | null }
  | { readonly kind: 'confirmationSent'; readonly id: string; readonly at: string; readonly version: number }

const chipOf = (entry: HistoryEntry): Exclude<HistoryChip, 'all'> => (entry.kind === 'requestAsked' || entry.kind === 'requestAnswered' ? 'requests' : entry.kind === 'amendment' ? 'amendments' : 'confirmations')

/** The lines an amendment moved, and the pieces before → after. */
function countsOf(diff: Amendment['diff']) {
  const counts = { changed: 0, added: 0, removed: 0, before: 0, after: 0 }
  for (const line of diff.lines) {
    if (line.change === 'CHANGED') counts.changed++
    else if (line.change === 'ADDED') counts.added++
    else counts.removed++
    counts.before += line.piecesBefore
    counts.after += line.piecesAfter
  }
  return counts
}

interface HistoryInput {
  readonly requests: readonly BrandRequest[]
  /** The order's changes (the ONE read of `…/changes`: amendments with their priced part); null: not read here. */
  readonly changes: readonly Change[] | null
  /** The amendments read (only where the changes read is not there: a design case, an older page). */
  readonly amendments: readonly Amendment[] | null
  readonly confirmation: Confirmation | null
}

/** Every event of the order's changes, newest first. */
export function historyOf(input: HistoryInput): HistoryEntry[] {
  const out: HistoryEntry[] = []
  for (const request of input.requests) {
    out.push({ kind: 'requestAsked', id: `asked-${request.id}`, at: request.askedAt, request })
    const answeredAt = request.answeredAt ?? request.withdrawnAt
    if (answeredAt && request.status !== 'OPEN') out.push({ kind: 'requestAnswered', id: `answered-${request.id}`, at: answeredAt, request })
  }
  if (input.changes) {
    for (const change of input.changes) {
      const delta = change.changeAmount
      out.push({
        kind: 'amendment',
        id: change.id,
        at: change.createdAt,
        revision: change.revision,
        by: change.createdBy,
        reason: change.reason,
        counts: countsOf(change.diff),
        money: delta === undefined ? null : { delta },
        priced: change.priced,
        customer: change.customer.decision,
        putBack: putBackOffered(change),
        change,
      })
    }
  } else if (input.amendments) {
    for (const amendment of input.amendments) {
      const change = moneyChange(amendment.diff)
      out.push({ kind: 'amendment', id: amendment.id, at: amendment.createdAt, revision: amendment.revision, by: amendment.createdBy, reason: amendment.reason, counts: countsOf(amendment.diff), money: change ? { delta: change.delta } : null, priced: false, customer: amendment.reacceptance, putBack: false, change: null })
    }
  }
  for (const version of input.confirmation?.versions ?? []) out.push({ kind: 'confirmationMade', id: `made-${version.id}`, at: version.createdAt, version: version.version, by: version.createdBy })
  if (input.confirmation?.sentAt && input.confirmation.sentVersion !== null) out.push({ kind: 'confirmationSent', id: `sent-${input.confirmation.sentVersion}`, at: input.confirmation.sentAt, version: input.confirmation.sentVersion })
  return out.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
}

/** The entries a chip shows (All: every entry). */
export const historyFor = (entries: readonly HistoryEntry[], chip: HistoryChip): HistoryEntry[] => (chip === 'all' ? [...entries] : entries.filter((entry) => chipOf(entry) === chip))
