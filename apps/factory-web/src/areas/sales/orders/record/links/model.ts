import type { OrderGate, OrderLinks, OrderRePromise } from './api'

/**
 * B-TH-256 (threads plan TH-6; O-SAL-ORD-REC.body-F07, .notice-F04, .notice-F06; picture 29) — what points at the order, on its
 * record: its complaints and returns in "Shipments & invoices" (each list by its own right; none: not drawn), planning's open
 * re-promise in the one notice (Accept / Decline with orders.manage, never by the planner who proposed it; "Tell the customer"
 * only with the tick and email.send), and the compliance gates' refusals that still block its work orders and shipments (the
 * gate's own sentence for every order reader; "Open in Compliance" only with the compliance view right). Pure: the container
 * (use-order-links.ts) reads and writes, the views draw this.
 */

/** A write in progress or done on one proposal. */
export interface LinksDecline {
  readonly proposalId: string
  readonly reason: string
  readonly problem: string | null
}

export type LinksModel =
  | { readonly state: 'loading' }
  | { readonly state: 'error'; readonly problem: string }
  | {
      readonly state: 'ready'
      readonly links: OrderLinks
      /** The proposal a write is running for. */
      readonly busy: string | null
      /** "Tell the customer" ticked, per proposal (off by default: the customer is told only with the tick). */
      readonly tell: Readonly<Record<string, boolean>>
      /** "Decline the new dates?" open, with the reason typed. */
      readonly decline: LinksDecline | null
      /** What the last write said (a catalogue key of `orders`), with its tone. */
      readonly said: { readonly key: string; readonly tone: 'success' | 'danger' } | null
    }

export interface LinksActions {
  readonly onRetry?: () => void
  readonly onTell?: (proposalId: string, tell: boolean) => void
  readonly onAccept?: (proposalId: string) => void
  readonly onDeclineStart?: (proposalId: string) => void
  readonly onDeclineReason?: (text: string) => void
  readonly onDeclineCancel?: () => void
  readonly onDecline?: () => void
  readonly onDismiss?: () => void
}

/** The words of a failed read or write, by the API error's kind. */
export function linksProblem(kind: string | null | undefined): string {
  if (kind === 'forbidden') return 'links.problem.forbidden'
  if (kind === 'not_found') return 'links.problem.notFound'
  if (kind === 'conflict') return 'links.problem.conflict'
  if (kind === 'invalid') return 'links.problem.invalid'
  return 'links.problem.unavailable'
}

/** Why Accept and Decline are held for this person (the API's `may` says it; null: they may). */
export function decideHeld(proposal: Pick<OrderRePromise, 'may'>, busy: boolean): string | null {
  if (busy) return 'links.held.busy'
  if (!proposal.may.accept && !proposal.may.decline) return 'links.held.noDecide'
  return null
}

/** The decline's reason is required (the planner reads it): the held words, or null. */
export const declineHeld = (decline: LinksDecline, busy: boolean): string | null => (busy ? 'links.held.busy' : decline.reason.trim() === '' ? 'links.decline.reasonNeeded' : null)

/** Complaints and returns are drawn only for a reader who holds at least one of the two rights (null both: no card at all). */
export const showsPointers = (links: Pick<OrderLinks, 'complaints' | 'returns'>): boolean => links.complaints !== null || links.returns !== null

/** The pill tone of a complaint's and a return's status (open work warm, done neutral). */
export const COMPLAINT_TONE: Readonly<Record<string, 'info' | 'warning' | 'danger' | 'success' | 'neutral'>> = { NEW: 'warning', TRIAGED: 'warning', INVESTIGATING: 'info', ANSWERED: 'success', CLOSED: 'neutral' }
export const RETURN_TONE: Readonly<Record<string, 'info' | 'warning' | 'danger' | 'success' | 'neutral'>> = { REQUESTED: 'warning', AUTHORISED: 'info', RECEIVED: 'info', INSPECTED: 'info', CLOSED: 'neutral', REJECTED: 'danger', CANCELLED: 'neutral' }

/** Each record opens on its own page (a real link: ⌘-click opens a new tab). */
export const complaintHref = (prefix: string, id: string): string => `${prefix}/quality/complaints/${encodeURIComponent(id)}`
export const returnHref = (prefix: string, id: string): string => `${prefix}/sales/returns/${encodeURIComponent(id)}`

/**
 * A refusal opens Compliance › Gate refusals at its gate, the blocked ones of 30 days, searched by its work order's or shipment's
 * number — only with the compliance view right (the API gives the event's id then); without it: the words only (null).
 */
export function gateHref(prefix: string, gate: Pick<OrderGate, 'eventId' | 'gate' | 'subject'>): string | null {
  if (!gate.eventId) return null
  const query = new URLSearchParams({ gate: gate.gate, feed: 'blocked', days: '30' })
  if (gate.subject.number) query.set('q', gate.subject.number)
  return `${prefix}/compliance/status?${query.toString()}`
}

/** The ready model of a fresh read (no write running, nothing ticked, nothing said). */
export const readyLinks = (links: OrderLinks): LinksModel => ({ state: 'ready', links, busy: null, tell: {}, decline: null, said: null })
