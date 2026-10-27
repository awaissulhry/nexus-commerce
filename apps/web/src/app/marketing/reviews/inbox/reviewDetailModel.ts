/**
 * Reviews › Inbox — the review pop-up's rules and words (`GET /api/reviews/inbox/:id`): the header line, the tabs,
 * Prev / Next over the rows on screen, the reply box from the channel's reply rules (`@nexus/shared/review-reply-rules`,
 * which the API sends as `reply` and also enforces on send), the translation, the order, buyer and history tabs.
 *
 * The reply, per channel (build spec rulings 5 and 6): eBay feedback read from eBay is SENT by Nexus (500 characters, one
 * reply, never edited). Everywhere else Nexus posts nothing: the person copies the reply, opens the channel's own page
 * (Seller Central / Feedback Manager on Amazon — no removal action —, Etsy, the review app) and then marks it as
 * responded, which records it in Nexus and sets Responded. Pure, tested in reviewDetailModel.vitest.test.ts.
 */
import { reviewDueAt, type ReplyRules } from '@nexus/shared/review-reply-rules'
import type { Tone } from '@/design-system/primitives'
import { MOOD_WORD, STATUS_WORD, THEME_LABEL, channelMarketWords, themeWord } from '../_lib/reviewWords'
import { SETTABLE_STATUSES } from './inboxBulk'
import { inboxPageHref } from './inboxQuery'
import { count } from './inboxTiles'

/** `GET /api/reviews/inbox/:id` (review-detail.service.ts `InboxDetail`). */
export interface InboxDetail {
  review: {
    id: string
    channel: string
    market: string | null
    kind: 'product' | 'seller'
    rating: number | null
    title: string | null
    body: string
    buyer: string | null
    postedAt: string
    ingestedAt: string
    imported: boolean
    verifiedPurchase: boolean
    status: string
    assignee: string | null
    tags: string[]
    note: string | null
    triageUpdatedAt: string | null
    externalReviewId: string
    sku: string | null
    asin: string | null
  }
  english: string | null
  language: string | null
  languageWords: string | null
  product: { id: string; name: string; sku: string } | null
  variant: { id: string; name: string; sku: string; words: string | null } | null
  order: {
    id: string; label: string; channel: string; market: string | null; placedAt: string | null; deliveredAt: string | null
    total: string; currency: string | null; status: string
  } | null
  return: { id: string; status: string; reasonWords: string | null; requestedAt: string } | null
  listingHref: string | null
  buyerHistory: { id: string; postedAt: string; rating: number | null; snippet: string }[]
  sentiment: { label: string | null; categories: string[]; edited: boolean; editedAt: string | null }
  responses: {
    id: string; status: string; body: string; locale: string | null; isAiDrafted: boolean; createdAt: string
    sentAt: string | null; createdBy: string | null; failedWords: string | null
  }[]
  timeline: { at: string; words: string }[]
  reply: ReplyRules
}

export const MANAGE_REPLY = "You need 'Manage reviews' to reply to reviews."
export const MANAGE_TRIAGE = "You need 'Manage reviews' to change a review’s status, owner, tags or note."
export const MANAGE_MOOD = "You need 'Manage reviews' to change the mood and themes."
export const MANAGE_DRAFT = "You need 'Manage reviews' to draft replies."

// ── Header ───────────────────────────────────────────────────────────

/** "26 Oct 2026, 08:12" (local time; `timeZone` for tests). */
export function dateTimeWords(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone })
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone })
  return `${day}, ${time}`
}

/** "26 Oct 2026". */
export function dateWords(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone })
}

/** The pop-up's title: the product (and its size or colour), else what the review is. */
export function detailTitle(d: InboxDetail): string {
  if (d.product) return d.variant?.words ? `${d.product.name} — ${d.variant.words}` : d.product.name
  return d.review.kind === 'seller' ? 'Seller feedback' : 'Product review'
}

/** "A. Buyer · eBay Germany · seller feedback · 26 Oct 2026, 08:12". */
export function detailSubtitle(d: InboxDetail, timeZone?: string): string {
  return [
    d.review.buyer ?? 'A buyer',
    channelMarketWords(d.review.channel, d.review.market),
    `${d.review.kind === 'seller' ? 'seller feedback' : 'product review'}${d.review.imported ? ' · imported' : ''}`,
    dateTimeWords(d.review.postedAt, timeZone),
  ].filter(Boolean).join(' · ')
}

const CLOSED_RETURNS = new Set(['RESTOCKED', 'REFUNDED', 'REJECTED', 'SCRAPPED'])

/** The order has a return that is not finished. */
export function returnOpen(d: Pick<InboxDetail, 'return'>): boolean {
  return !!d.return && !CLOSED_RETURNS.has(d.return.status)
}

export const MOOD_TONE: Record<string, Tone> = { POSITIVE: 'success', NEUTRAL: 'neutral', NEGATIVE: 'danger' }

export const STATUS_OPTIONS = SETTABLE_STATUSES.map((value) => ({ value, label: STATUS_WORD[value] }))
export const MOOD_OPTIONS = (['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as const).map((value) => ({ value, label: MOOD_WORD[value] }))

/** The themes a person can add (every theme Nexus knows that is not on the review yet). */
export function themeChoices(current: readonly string[]): { value: string; label: string }[] {
  return Object.keys(THEME_LABEL).filter((k) => !current.includes(k)).map((value) => ({ value, label: themeWord(value) }))
}

export type DetailTab = 'review' | 'order' | 'buyer' | 'history'

export function detailTabs(d: InboxDetail | null): { id: DetailTab; label: string; count?: number | null }[] {
  return [
    { id: 'review', label: 'Review' },
    { id: 'order', label: 'Order' },
    { id: 'buyer', label: 'Buyer' },
    { id: 'history', label: 'History', count: d ? d.timeline.length : null },
  ]
}

// ── Prev / Next ──────────────────────────────────────────────────────

/** The ids of the rows on screen, in their order (the DetailModal's nav walks them; held at either end). */
export function navIds(rows: readonly { id: string }[]): string[] {
  return rows.map((r) => r.id)
}

/**
 * Where the rows on screen sit in the whole filtered list, for the pop-up's counter ("53 of 56", not "3 of 50"): the
 * grid shows page `page` of `pageSize` rows; the cards (below 760 px) show every row loaded from the first. `total` is
 * the list's own count (the API's `total`); unknown → the rows on screen are the list.
 */
export function navPlace(args: { narrow: boolean; page: number; pageSize: number; total: number | null | undefined }): { offset: number; total: number | null } {
  const offset = args.narrow ? 0 : Math.max(0, args.page - 1) * Math.max(0, args.pageSize)
  return { offset, total: args.total ?? null }
}

/** The review after `current` in the rows on screen, or null at the end ("Next review (J)"). */
export function nextId(ids: readonly string[], current: string): string | null {
  const i = ids.indexOf(current)
  return i >= 0 && i < ids.length - 1 ? ids[i + 1] : null
}

/** Why "Next review" is held, or null. With `place`, the list's last review says so instead of naming a next page. */
export function nextHeld(ids: readonly string[], current: string, place?: { offset: number; total: number | null }): string | null {
  const index = ids.indexOf(current)
  if (index < 0) return 'This review is not in the list on screen.'
  if (nextId(ids, current)) return null
  if (place?.total != null && place.offset + index + 1 >= place.total) return 'This is the last review in the list.'
  return 'This is the last review on this page. Go to the next page of the Inbox for more.'
}

// ── The reply ────────────────────────────────────────────────────────

export interface ComposerView {
  limit: number | null
  ruleLine: string
  window: string | null
  /** The main button: "Send reply to eBay" (Nexus posts) or "Mark as responded" (recorded in Nexus). */
  primary: { label: string; held: string | null; mode: 'send' | 'mark' }
  /** Copy mode: a "Copy reply" button. */
  copy: boolean
  /** Where the reply is posted by hand. */
  open: { label: string; href: string } | null
  sent: { at: string; text: string; note: string } | null
  refused: string | null
  draftHeld: string | null
}

const CHANNEL_NAME: Record<string, string> = { EBAY: 'eBay', AMAZON: 'Amazon', ETSY: 'Etsy', SHOPIFY: 'your store' }

/** Where a reply goes: the channel, or — a Shopify review read from Judge.me — Judge.me, which posts it (PR I). */
export function replyPlace(channel: string, mode: 'send' | 'copy' | 'mark'): string {
  const c = channel.toUpperCase()
  if (c === 'SHOPIFY' && mode === 'send') return 'Judge.me'
  return CHANNEL_NAME[c] ?? 'the channel'
}

/** The reply box's title: "Reply on eBay", "Reply on Judge.me" when Nexus posts it; "Reply" when a person does. */
export function replyTitle(rules: { channel: string; mode: 'send' | 'copy' }): string {
  return rules.mode === 'send' ? `Reply on ${replyPlace(rules.channel, 'send')}` : 'Reply'
}

/** The reply box for this review: what the channel allows, what is held and why, what was sent. */
export function composerView(d: InboxDetail, ctx: { canManage: boolean }, timeZone?: string): ComposerView {
  const rules = d.reply
  const sent = [...d.responses].reverse().find((r) => r.status === 'SENT') ?? null
  const failed = [...d.responses].reverse().find((r) => r.status === 'FAILED') ?? null
  const refused = failed && (!sent || failed.createdAt > sent.createdAt) ? failed.failedWords : null
  const where = replyPlace(rules.channel, rules.mode)
  const held = !ctx.canManage ? MANAGE_REPLY : rules.held
  return {
    limit: rules.limit,
    ruleLine: rules.ruleLine,
    window: rules.window && !rules.window.closed ? rules.window.words : null,
    primary: rules.mode === 'send'
      ? { label: rules.sendLabel ?? `Send reply to ${where}`, held, mode: 'send' }
      : { label: 'Mark as responded', held, mode: 'mark' },
    copy: rules.mode === 'copy',
    open: rules.mode === 'copy' ? rules.open : null,
    sent: sent
      ? {
          at: `${rules.mode === 'send' ? 'Sent' : 'Marked'} ${dateTimeWords(sent.sentAt ?? sent.createdAt, timeZone)}`,
          text: sent.body,
          note: rules.mode !== 'send' ? '· marked as responded in Nexus'
            : where === 'Judge.me' ? '· public under the review on the store · change it in Judge.me' : `· public on ${where} · cannot be undone or edited`,
        }
      : null,
    refused,
    draftHeld: !ctx.canManage ? MANAGE_DRAFT : sent ? 'A reply was already sent.' : rules.held,
  }
}

/** The text the box starts with: the latest saved draft (an AI draft waits for a person), else empty. */
export function initialReplyText(d: InboxDetail): string {
  if (d.responses.some((r) => r.status === 'SENT')) return ''
  return [...d.responses].reverse().find((r) => r.status === 'DRAFT')?.body ?? ''
}

/** The saved draft the send turns into the sent reply (so it is not left behind as a second row). */
export function draftResponseId(d: InboxDetail): string | null {
  return [...d.responses].reverse().find((r) => r.status === 'DRAFT')?.id ?? null
}

/** The toast after a send or a mark. */
export function replyDoneWords(mode: 'send' | 'mark', channel: string): string {
  const where = replyPlace(channel, mode)
  return mode === 'send' ? `Reply sent to ${where}. The review is Responded.` : 'Marked as responded. The review is Responded.'
}

// ── The review's text ────────────────────────────────────────────────

export interface TextView {
  /** "What A. Buyer wrote · German". */
  heading: string
  title: string | null
  body: string
  /** The English, with "Translated from German". */
  english: { from: string; text: string } | null
  /** A Translate button: the review is not in English and has no translation yet. */
  canTranslate: boolean
}

export function textView(d: InboxDetail): TextView {
  const who = d.review.buyer ?? 'the buyer'
  const lang = d.languageWords
  const english = d.english && d.language !== 'en' ? { from: lang ? `Translated from ${lang}` : 'Translated to English', text: d.english } : null
  return {
    heading: `What ${who} wrote${lang ? ` · ${lang}` : ''}`,
    title: d.review.title,
    body: d.review.body,
    english,
    canTranslate: !english && d.language !== 'en',
  }
}

/** The theme AI sets when a review fits none of the named ones. */
const OTHER_THEME = 'OTHER'

/**
 * A link to the Inbox for the other reviews with this review's first named theme ("Other “Fit & sizing” reviews"). A
 * review whose only theme is Other links to "Other reviews with no theme" (never `Other “Other” reviews`).
 */
export function sameThemeLink(d: InboxDetail): { label: string; href: string } | null {
  const themes = d.sentiment.categories
  const theme = themes.find((t) => t !== OTHER_THEME) ?? themes[0]
  if (!theme) return null
  const label = theme === OTHER_THEME ? 'Other reviews with no theme' : `Other “${themeWord(theme)}” reviews`
  return { label, href: inboxPageHref({ themes: [theme], period: 'all' }) }
}

/** "Reply target: 28 Oct" while the review is open; "Replied" once a reply went out. */
export function replyTargetWords(d: InboxDetail, now: number, timeZone?: string): string {
  if (d.responses.some((r) => r.status === 'SENT')) return 'Replied'
  if (!['NEW', 'IN_PROGRESS'].includes(d.review.status)) return 'No reply needed'
  const due = reviewDueAt(d.review.postedAt)
  const day = due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone })
  return due.getTime() < now ? `Overdue since ${day}` : `Reply target: ${day}`
}

// ── Order, buyer, history ────────────────────────────────────────────

export interface Fact { label: string; value: string; hint?: string }

function money(total: string, currency: string | null): string {
  const n = Number(total)
  if (!Number.isFinite(n)) return total
  try {
    return currency ? n.toLocaleString('en-GB', { style: 'currency', currency }) : n.toLocaleString('en-GB', { minimumFractionDigits: 2 })
  } catch {
    return `${n.toFixed(2)} ${currency ?? ''}`.trim()
  }
}

const RETURN_WORDS: Record<string, string> = {
  REQUESTED: 'Requested', AUTHORIZED: 'Authorised', IN_TRANSIT: 'On its way back', RECEIVED: 'Received', INSPECTING: 'Being checked',
  RESTOCKED: 'Restocked', REFUNDED: 'Refunded', REJECTED: 'Rejected', SCRAPPED: 'Scrapped',
}

export function returnWords(r: NonNullable<InboxDetail['return']>, timeZone?: string): { value: string; hint?: string } {
  const status = RETURN_WORDS[r.status] ?? r.status
  return { value: `${status} ${dateWords(r.requestedAt, timeZone)}`.trim(), hint: r.reasonWords ? `reason: ${r.reasonWords}` : undefined }
}

/** The Order tab's facts; none when the review names no order Nexus knows. */
export function orderFacts(d: InboxDetail, timeZone?: string): Fact[] {
  const o = d.order
  if (!o) return []
  const facts: Fact[] = [
    { label: 'Order', value: o.label },
    { label: 'Where', value: channelMarketWords(o.channel, o.market) },
    { label: 'Placed', value: dateWords(o.placedAt, timeZone) || '—' },
    { label: 'Delivered', value: o.deliveredAt ? dateWords(o.deliveredAt, timeZone) : 'Not yet' },
    { label: 'Paid', value: money(o.total, o.currency) },
  ]
  if (d.return) {
    const r = returnWords(d.return, timeZone)
    facts.push({ label: 'Return', value: r.value, hint: r.hint })
  }
  return facts
}

/** The Buyer tab's facts. No e-mail and no address: contact goes through the order's channel. */
export function buyerFacts(d: InboxDetail): Fact[] {
  const others = d.buyerHistory.length
  const channel = channelMarketWords(d.review.channel, null)
  return [
    { label: 'Buyer', value: d.review.buyer ?? 'Not named' },
    { label: 'Language', value: d.languageWords ?? 'Not known' },
    { label: 'Feedback and reviews', value: count(others + 1), hint: others === 0 ? 'only this one' : `this one and ${count(others)} more` },
    { label: 'Contact', value: d.review.channel === 'SHOPIFY' ? 'From the order' : `Through ${channel} messages only` },
  ]
}

export interface StepView { key: string; label: string; tone: Tone; at: string | null }

function stepTone(words: string): Tone {
  if (/did not go out|refused|Nothing was sent/i.test(words) && !/AI draft/i.test(words)) return 'danger'
  if (/^Return/i.test(words)) return 'warning'
  if (/^Reply posted|^Marked as responded/i.test(words)) return 'success'
  if (/^AI/i.test(words)) return 'info'
  return 'neutral'
}

/** Everything that happened, oldest first; "Replied — not yet" closes it while the review waits for a reply. */
export function historySteps(d: InboxDetail): StepView[] {
  const steps: StepView[] = d.timeline.map((t, i) => ({ key: `${i}:${t.at}`, label: t.words, tone: stepTone(t.words), at: t.at }))
  const waiting = !d.responses.some((r) => r.status === 'SENT') && ['NEW', 'IN_PROGRESS'].includes(d.review.status)
  if (waiting) steps.push({ key: 'reply', label: 'Replied', tone: 'neutral', at: null })
  return steps
}

/** The Review tab's "What happened": the last few steps (the History tab has them all). */
export function recentSteps(d: InboxDetail, n = 4): StepView[] {
  const all = historySteps(d)
  return all.slice(Math.max(0, all.length - n))
}
