import { heldGrains } from '../auth/grains/grains'
import { THREADS_READ } from '../auth/permissions/catalogue'
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

export const WAITING_KINDS = [
  'APPROVAL_REQUEST',
  'PO_CONFIRMATION',
  'QUOTE_ANSWER',
  // B-W2b-388 (COL-035; design waiting-on "external messages with no reply in 3 working days · links sent and not opened"): a
  // mail I sent from a record's conversation that its party has not answered in 3 working days (the record's company
  // calendar), and a one-off link I made that nobody opened yet (live, not expired, a day old). Both are seen through the
  // record's conversation (threads.read over its company, site and party).
  'MESSAGE_REPLY',
  'LINK_UNOPENED',
] as const
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
  // B-W2b-388
  MESSAGE_REPLY: { kind: 'MESSAGE_REPLY', label: 'Mail I sent with no reply in 3 working days', view: THREADS_READ, live: ['thread.message_posted'] },
  LINK_UNOPENED: { kind: 'LINK_UNOPENED', label: 'Links I sent, not opened', view: THREADS_READ, live: ['link.used', 'link.renewed'] },
})

/** B-W2b-388: a mail waits for a reply this many working days before it counts as waiting (design: "no reply in 3 working days"). */
export const REPLY_WORKING_DAYS = 3
/** B-W2b-388: a mail older than this is no longer something one waits on (it is history), in days. */
export const REPLY_LOOKBACK_DAYS = 30
/** B-W2b-388: a link counts as not opened once it is this many hours old. */
export const LINK_UNOPENED_HOURS = 24

/** B-W2b-388: the sentence of a mail with no reply (English; the screen composes its own words from the kind and the record). */
export function messageReplyWords(facts: { readonly label: string; readonly party: string }): string {
  return `${facts.party} has not answered your mail on ${facts.label}.`
}

/** B-W2b-388: the sentence of a link nobody opened (English; the screen composes its own words). */
export function linkUnopenedWords(facts: { readonly label: string; readonly party: string }): string {
  return `${facts.party} has not opened the link you sent for ${facts.label}.`
}

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

// ---- Nudge (W2a, B-W2a-20; design home.today waiting-on "Nudge (sends a reminder in the record's thread, once a day at
// most)") ------------------------------------------------------------------------------------------------------------------

/**
 * The waits a person may nudge from Today: an approval they asked for (the people who may decide it are told, and a
 * reminder note goes on the record's thread). A purchase order or a quote waits on the SUPPLIER or the CUSTOMER: a
 * reminder to them is a mail to a real party, which W2a sends only through its module behind the Owner's switch
 * (B-W2a-52 PO confirmation reminders), never from here.
 */
export const NUDGE_KINDS: readonly WaitingKind[] = Object.freeze(['APPROVAL_REQUEST'])

/** The refusals of a nudge, in words (the API answers 409 `nudge/<CODE>`). */
export const NUDGE_REFUSALS = {
  OUTSIDE: 'This waits on a customer or supplier: remind them from the record (its mail), not from Today.',
  TODAY_ALREADY: 'You reminded them today already. Nudge again tomorrow.',
  NOBODY: 'Nobody may decide this now: ask an administrator who should.',
} as const
export type NudgeRefusal = keyof typeof NUDGE_REFUSALS

/** Why this wait cannot be nudged now (null: it can): its kind, and once a business day per person and record. */
export function nudgeRefusal(kind: WaitingKind, nudgedToday: boolean, deciders: number): NudgeRefusal | null {
  if (!NUDGE_KINDS.includes(kind)) return 'OUTSIDE'
  if (nudgedToday) return 'TODAY_ALREADY'
  if (deciders === 0) return 'NOBODY'
  return null
}

/** The reminder note the nudge writes on the record's thread (internal, by the system; no amount, no person's figure). */
export function nudgeNote(input: { readonly label: string; readonly ageDays: number; readonly byName: string }): string {
  const since = input.ageDays === 0 ? 'since today' : input.ageDays === 1 ? 'for 1 day' : `for ${input.ageDays} days`
  return `Reminder from ${input.byName}: ${input.label} still waits for an approval (${since}).`
}
