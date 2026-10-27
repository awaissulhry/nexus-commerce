/**
 * Reviews › eBay — the parts eBay's REST Feedback API makes real (PR G), in words: eBay's AI topics, the revision
 * requests and "Leave feedback for buyers". The rules are eBay's, from ONE source with the API
 * (`@nexus/shared/review-reply-rules`): feedback for a buyer is positive only, up to 500 characters, within 90 days of
 * the completed sale, never while a return or case is open; each send waits for a person's approval (one request, or ONE
 * change plan for several). Revision requests: 5 a calendar year plus 5 per 1,000 feedback received, only for feedback
 * under 30 days old, once per feedback, the buyer has 10 days — and eBay has no API to ask, so Nexus opens Seller Hub.
 * Pure (no React), tested in ebayToolsModel.vitest.test.ts.
 */
import { EBAY_BUYER_FEEDBACK_LIMIT, buyerFeedbackTextHeld } from '@nexus/shared/review-reply-rules'
import type { Tone } from '@/design-system/primitives'
import { marketWord } from './reviewsScope'

// ── The API's answers ────────────────────────────────────────────────

export interface EbayTopicCount { topic: string; label: string; count: number; positive: number; negative: number; neutral: number }
export interface EbayTopics { topics: EbayTopicCount[]; read: number; words: string | null }

export interface EbayRevisionRow {
  id: string
  buyer: string | null
  market: string | null
  type: 'negative' | 'neutral' | 'positive' | null
  postedAt: string
  state: string | null
  words: string
  tone: string
  stateSince: string | null
  daysLeft: number | null
  canAsk: boolean
}

export interface EbayRevisions {
  rows: EbayRevisionRow[]
  counts: { waiting: number; revised: number; declined: number; canAsk: number }
  allowance: { year: number; received: number; allowed: number; seen: number; words: string }
  rule: string
  tip: string
  noApi: string
  read: boolean
  words: string | null
}

export interface BuyerFeedbackRow {
  id: string
  orderLineItemId: string
  title: string | null
  price: string | null
  currency: string | null
  buyer: string | null
  order: { id: string; label: string } | null
  market: string | null
  soldAt: string | null
  daysLeft: number | null
  state: 'AWAITING' | 'LEFT' | 'GONE'
  held: string | null
  approval: { id: string; words: string } | null
  left: { at: string | null; by: string | null; text: string | null } | null
  lastWords: string | null
  firstSeenAt: string
}

export interface BuyerFeedbackPage {
  rows: BuyerFeedbackRow[]
  counts: { awaiting: number; ready: number; waitingApproval: number; held: number; left: number }
  readAt: string | null
  readWords: string | null
  rule: string
  limit: number
}

/** The eBay page's "Buyers to rate" tile (`EbayTiles.buyersToRate`): the counts of the same queue. */
export interface BuyersToRate {
  awaiting: number
  ready: number
  waitingApproval: number
  /** When eBay's list was last read (ISO); null when it never was. */
  readAt: string | null
  /** False when Nexus does not read eBay in this setup: the list does not update. */
  reading: boolean
}

export interface BuyerFeedbackSendAnswer {
  changed: number
  held: Array<{ id: string; words: string }>
  sent: { approvalId: string; kind: 'request' | 'plan'; lines: number; expiresAt: string | null } | null
}

export const MANAGE_BUYER_FEEDBACK = "You need 'Manage reviews' to leave feedback for buyers."
export const BUYER_FEEDBACK_LIMIT = EBAY_BUYER_FEEDBACK_LIMIT
/** A kind default the person edits before sending. */
export const DEFAULT_BUYER_FEEDBACK = 'Great buyer, quick payment and smooth communication. Thank you!'

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

/** "24 Oct" (local time; `timeZone` for tests). */
export function shortDate(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone })
}

/** "eBay Italy"; "eBay (whole account)" when eBay names no site and no Nexus order does. */
export function ebayWhere(market: string | null): string {
  return market ? `eBay ${marketWord(market)}` : 'eBay (whole account)'
}

// ── eBay's AI topics ─────────────────────────────────────────────────

export interface TopicTag { key: string; text: string; tone: Tone; title: string }

/** The topics as tags, most mentioned first: "Shipping · 96", toned by what buyers mostly said. */
export function topicTags(topics: EbayTopics | null, limit = 8): TopicTag[] {
  return (topics?.topics ?? []).slice(0, limit).map((t) => ({
    key: t.topic,
    text: `${t.label} · ${t.count.toLocaleString('en')}`,
    tone: t.negative > t.positive ? 'danger' : t.positive > 0 && t.negative === 0 ? 'success' : 'neutral',
    title: `${plural(t.count, 'feedback mentions', 'feedback mention')} it: ${t.positive} positive, ${t.negative} negative, ${t.neutral} neutral`,
  }))
}

// ── Revision requests ────────────────────────────────────────────────

export interface RevisionView {
  key: string
  who: string
  what: string
  pill: { words: string; tone: Tone }
  note: string
  canAsk: boolean
}

const toneOf = (tone: string): Tone => (tone === 'success' || tone === 'info' || tone === 'warning' || tone === 'danger' ? tone : 'neutral')

/** One revision row in words. */
export function revisionView(row: EbayRevisionRow, timeZone?: string): RevisionView {
  const what = [ebayWhere(row.market), row.type ?? 'no type', `left ${shortDate(row.postedAt, timeZone)}`].join(' · ')
  let note: string
  if (row.canAsk) note = `${plural(row.daysLeft ?? 0, 'day', 'days')} left to ask (eBay: feedback under 30 days old, once per feedback).`
  else if (row.state === 'REVISION_OPEN') note = `The buyer has 10 days to answer${row.stateSince ? ` (Nexus saw the request on ${shortDate(row.stateSince, timeZone)})` : ''}. eBay changes nothing unless the buyer agrees.`
  else if (row.stateSince) note = `Nexus saw this on ${shortDate(row.stateSince, timeZone)}.`
  else note = ''
  return { key: row.id, who: row.buyer ?? 'Buyer not named', what, pill: { words: row.words, tone: toneOf(row.tone) }, note, canAsk: row.canAsk }
}

/** The card's line under its title: what eBay allows and what Nexus saw. */
export function revisionSummary(r: EbayRevisions): string {
  const parts = [
    r.counts.waiting ? `${r.counts.waiting} waiting for the buyer` : null,
    r.counts.canAsk ? `${r.counts.canAsk} can be asked` : null,
    r.counts.revised ? `${r.counts.revised} revised` : null,
    r.counts.declined ? `${r.counts.declined} said no or expired` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'No revision requests'
}

// ── Leave feedback for buyers ────────────────────────────────────────

export interface BuyerRowView {
  who: string
  where: string
  item: string
  order: string
  when: string
  status: { words: string; tone: Tone }
}

/** One sale waiting for the seller's feedback, in words. */
export function buyerRowView(row: BuyerFeedbackRow, timeZone?: string): BuyerRowView {
  const when = row.soldAt
    ? `Sold ${shortDate(row.soldAt, timeZone)}${row.daysLeft != null && row.state === 'AWAITING' ? ` · ${plural(row.daysLeft, 'day', 'days')} left` : ''}`
    : 'Sale date not in Nexus (eBay still lists it)'
  let status: BuyerRowView['status']
  if (row.state === 'LEFT') status = { words: `Left ${shortDate(row.left?.at, timeZone)}`.trim(), tone: 'success' }
  else if (row.approval) status = { words: 'Waits for approval', tone: 'info' }
  else if (row.held) status = { words: 'Held', tone: 'warning' }
  else status = { words: 'Ready', tone: 'neutral' }
  return {
    who: row.buyer ?? 'Buyer not in Nexus',
    where: ebayWhere(row.market),
    item: row.title ?? 'Item not named by eBay',
    order: row.order?.label ?? row.orderLineItemId,
    when,
    status,
  }
}

/** Which of the picked sales a send would ask for, and why the others are left out. */
export function buyerSendReach(rows: readonly BuyerFeedbackRow[]): { apply: BuyerFeedbackRow[]; skipped: Array<{ id: string; reason: string }> } {
  const apply: BuyerFeedbackRow[] = []
  const skipped: Array<{ id: string; reason: string }> = []
  for (const row of rows) {
    if (row.held) skipped.push({ id: row.id, reason: row.held })
    else apply.push(row)
  }
  return { apply, skipped }
}

/** Why "Send for approval" is held (no permission > nothing picked > none can go > the text), or null. */
export function buyerSendHeld(input: { canManage: boolean; rows: readonly BuyerFeedbackRow[]; text: string; busy?: boolean }): string | null {
  if (!input.canManage) return MANAGE_BUYER_FEEDBACK
  if (input.busy) return 'Sending for approval… this takes a few seconds.'
  if (input.rows.length === 0) return 'Pick at least one sale first.'
  const reach = buyerSendReach(input.rows)
  if (reach.apply.length === 0) return input.rows.length === 1 ? reach.skipped[0].reason : `None of the ${input.rows.length} picked sales can get feedback now: ${reach.skipped[0].reason}`
  return buyerFeedbackTextHeld(input.text)
}

/** Why the row's own "Leave positive" is held, or null. */
export function buyerRowHeld(row: BuyerFeedbackRow, canManage: boolean): string | null {
  if (!canManage) return MANAGE_BUYER_FEEDBACK
  return row.held
}

/** The dialog's main button: "Send for approval" (one) / "Send 3 for approval" (a change plan). */
export function buyerSendLabel(count: number): string {
  return count <= 1 ? 'Send for approval' : `Send ${count.toLocaleString('en')} for approval`
}

/** What the dialog says about the picked sales before sending. */
export function buyerSendNote(rows: readonly BuyerFeedbackRow[]): string {
  const reach = buyerSendReach(rows)
  if (reach.apply.length === 0) return ''
  const how = reach.apply.length === 1
    ? 'One approval request waits on the Approvals page; eBay gets nothing until a person approves it.'
    : `One change plan with ${plural(reach.apply.length, 'sale', 'sales')} waits on the Approvals page; eBay gets nothing until a person approves it.`
  const left = reach.skipped.length ? ` ${plural(reach.skipped.length, 'picked sale is', 'picked sales are')} left out: ${reach.skipped[0].reason}` : ''
  return `${how}${left}`
}

/** The toast after "Send for approval", in the server's numbers. */
export function buyerResultWords(answer: BuyerFeedbackSendAnswer): { words: string; tone: 'success' | 'warning' } {
  if (!answer.sent || answer.changed === 0) {
    return { words: answer.held[0]?.words ?? 'Nothing was sent for approval.', tone: 'warning' }
  }
  const what = answer.sent.kind === 'plan'
    ? `Sent for approval: one change plan with ${plural(answer.sent.lines, 'sale', 'sales')}.`
    : 'Sent for approval.'
  const held = answer.held.length ? ` ${plural(answer.held.length, 'sale was', 'sales were')} not sent: ${answer.held[0].words}` : ''
  return { words: `${what} A person approves it on the Approvals page.${held}`, tone: answer.held.length ? 'warning' : 'success' }
}
