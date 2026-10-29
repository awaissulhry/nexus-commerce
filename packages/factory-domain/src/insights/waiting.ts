import { heldGrains } from '../auth/grains/grains'
import { can, holds, type Actor, type Permission, type ScopedRecord } from '../core/permissions'
import type { EventType } from '../events/catalogue'
import { PURCHASING_VIEW } from '../purchasing/permissions'
import { QUOTES_VIEW } from '../sales/quotes/permissions'
import { amountWords, visibleAmounts, type AttentionRecord, type AttentionScope, type CandidateAmounts, type ItemAmounts, type Viewer } from './attention'

/**
 * Waiting on others (B-W1-52; design home.today `waiting-on`): the other half of a person's work, what THEY asked for or
 * sent and still wait on: their quote approval requests not decided, the purchase orders they sent not confirmed, the
 * quotes they sent not answered. Each row says what, whom they wait for and since when. A row is the person's only by
 * the record (they asked or sent it) AND only while they can still see the record (its view permission over its
 * company, site and party); amounts follow their grains as on Today. Nudge (a reminder in the record's thread) is W2a.
 */

export const WAITING_KINDS = ['APPROVAL_REQUEST', 'PO_CONFIRMATION', 'QUOTE_ANSWER'] as const
export type WaitingKind = (typeof WAITING_KINDS)[number]

export interface WaitingRule {
  readonly kind: WaitingKind
  readonly label: string
  readonly view: Permission
  readonly live: readonly EventType[]
}

export const WAITING_RULES: Readonly<Record<WaitingKind, WaitingRule>> = Object.freeze({
  APPROVAL_REQUEST: { kind: 'APPROVAL_REQUEST', label: 'My approval requests not decided', view: QUOTES_VIEW, live: ['quote.approval_requested', 'quote.approval_decided', 'quote.reopened', 'quote.cancelled'] },
  PO_CONFIRMATION: {
    kind: 'PO_CONFIRMATION',
    label: 'Purchase orders I sent, not confirmed',
    view: PURCHASING_VIEW,
    live: ['purchase_order.sent', 'purchase_order.confirmed', 'purchase_order.declined', 'purchase_order.changes_proposed', 'purchase_order.cancelled'],
  },
  QUOTE_ANSWER: { kind: 'QUOTE_ANSWER', label: 'Quotes I sent, not answered', view: QUOTES_VIEW, live: ['quote.sent', 'quote.accepted', 'quote.declined', 'quote.revised', 'quote.cancelled'] },
})

export interface WaitingCandidate {
  readonly kind: WaitingKind
  readonly record: AttentionRecord
  readonly scope: AttentionScope
  /** Who asked or sent it. */
  readonly requestedBy: string | null
  readonly sentence: string
  /** Whom the person waits for, in words (an approver, the supplier, the customer). */
  readonly waitingFor: string
  readonly since: Date
  /** A date the answer matters by (the quote's validity), if any. */
  readonly due: string | null
  readonly amounts?: CandidateAmounts | null
}

export interface WaitingItem {
  readonly key: string
  readonly kind: WaitingKind
  readonly record: AttentionRecord
  readonly companyId: string | null
  readonly siteId: string | null
  readonly partyId: string | null
  readonly sentence: string
  readonly waitingFor: string
  readonly since: Date
  readonly ageDays: number
  readonly due: string | null
  readonly amounts: ItemAmounts | null
}

/** The person's row: they asked or sent it, and they still see the record. */
export function waitsFor(viewer: Viewer, candidate: WaitingCandidate): boolean {
  if (candidate.requestedBy === null || candidate.requestedBy !== viewer.personId) return false
  const record: ScopedRecord = candidate.scope
  return can(viewer.actor, WAITING_RULES[candidate.kind].view, record)
}

/** The kinds whose records the actor can see somewhere. */
export function waitingKindsFor(actor: Actor): WaitingKind[] {
  return WAITING_KINDS.filter((kind) => holds(actor, WAITING_RULES[kind].view))
}

const DAY_MS = 86_400_000

/** The person's rows, oldest first (the longest wait on top), then by key. */
export function waitingFor(viewer: Viewer, candidates: readonly WaitingCandidate[]): WaitingItem[] {
  const grains = heldGrains(viewer.actor)
  return candidates
    .filter((candidate) => waitsFor(viewer, candidate))
    .map((candidate) => {
      const amounts = visibleAmounts(candidate.amounts, grains)
      const field = candidate.amounts?.inSentence
      const quoted = field && amounts ? amountWords(field, amounts) : null
      return {
        key: `${candidate.kind}:${candidate.record.id}`,
        kind: candidate.kind,
        record: candidate.record,
        companyId: candidate.scope.companyId,
        siteId: candidate.scope.siteId,
        partyId: candidate.scope.partyId,
        sentence: quoted ? `${candidate.sentence.replace(/[.:]$/, '')} (${quoted}).` : candidate.sentence,
        waitingFor: candidate.waitingFor,
        since: candidate.since,
        ageDays: Math.max(0, Math.floor((viewer.now.getTime() - candidate.since.getTime()) / DAY_MS)),
        due: candidate.due,
        amounts,
      }
    })
    .sort((a, b) => a.since.getTime() - b.since.getTime() || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}
