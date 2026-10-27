/**
 * Reviews › Inbox — the review pop-up's rules and words (`GET /api/reviews/inbox/:id`): the header line, the tabs,
 * Prev / Next over the rows on screen, the reply box from the channel's reply rules (`@nexus/shared/review-reply-rules`,
 * which the API sends as `reply` and also enforces on send), the translation, the order, buyer and history tabs.
 *
 * The reply, per channel (build spec rulings 5 and 6): eBay feedback read from eBay is SENT by Nexus (500 characters, one
 * reply, never edited). Everywhere else Nexus posts nothing: the person copies the reply, opens the channel's own page
 * (Seller Central / Feedback Manager on Amazon — no removal action —, Etsy, the review app) and then marks it as
 * responded, which records it in Nexus and sets Responded. Amazon seller feedback also carries the removal check
 * (`removalView`): whether asking Amazon in Feedback Manager may work. Pure, tested in reviewDetailModel.vitest.test.ts.
 */
import { reviewDueAt, type ReplyRules } from '@nexus/shared/review-reply-rules'
import { photoAlt, type LightboxItem } from '@/design-system/patterns'
import type { Tone } from '@/design-system/primitives'
import { MOOD_WORD, STATUS_WORD, THEME_LABEL, channelMarketWords, marketCodeOf, themeWord } from '../_lib/reviewWords'
import { SETTABLE_STATUSES } from './inboxBulk'
import { inboxPageHref } from './inboxQuery'
import { count, plural } from './inboxTiles'
import type { RemovalCheck } from '../_channel/sellerFeedbackModel'

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
  /**
   * Why this review needs no reply (the API's one needs-a-reply rule, review-visibility.ts); null while it needs one.
   * Optional: an answer from before the API sent it reads by the older rule (`takesReply`).
   */
  noReply?: 'fixture' | 'closed' | 'imported' | 'no_reply' | 'window_closed' | 'positive' | 'automatic' | null
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
  /** PR G — the buyer's photos (or videos), in order: eBay's, Etsy's one photo and Judge.me's (PR I). */
  media?: { url: string; type: string; width: number | null; height: number | null; position: number }[]
  /** PR I — the review app that holds a video Nexus cannot show (Judge.me gives no video URL); null when none. */
  videoIn?: string | null
  /** PR G — eBay's AI topics with the buyer's words eBay found; null when eBay's topics were not read. */
  aiTopics?: { topic: string; label: string; sentiment: string | null; texts: string[] }[] | null
  /** PR G — eBay's revision state of this feedback, in words; null when there is nothing to say. */
  revision?: { state: string | null; words: string; tone: string; since: string | null; eligible: boolean } | null
  /**
   * Amazon seller feedback only (PR H): the removal check and the rules it reads. Nexus never asks Amazon to remove
   * feedback (no API for it): the reply box's "Open Feedback Manager" is where a person asks. Null (or absent) otherwise.
   */
  removal?: (RemovalCheck & { rules: string[] }) | null
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

/**
 * Whether this review can wait for a reply at all — the API's one needs-a-reply rule (review-visibility.ts): never a
 * review no one can answer (an Amazon product review, an Etsy review past its window), never an imported one.
 */
export function takesReply(d: Pick<InboxDetail, 'review' | 'reply' | 'noReply'>): boolean {
  if (d.noReply !== undefined) return d.noReply == null || d.noReply === 'closed'
  if (d.review.imported) return false
  return d.reply.heldCode !== 'no_reply' && d.reply.heldCode !== 'window_closed'
}

/** Why a review has no reply target, in words (the badges leave the same reviews out). */
const NO_TARGET_WORDS: Record<string, string> = {
  imported: 'Imported from a file: no reply target',
  no_reply: 'No reply target: nobody can answer it',
  window_closed: 'No reply target: Etsy’s reply window closed',
  positive: 'No reply needed: positive — reply only if you want to',
  automatic: 'No reply needed: eBay left this feedback by itself',
  fixture: 'No reply target',
}

/** "Reply target: 28 Oct" while the review is open; "Replied" once a reply went out. */
export function replyTargetWords(d: InboxDetail, now: number, timeZone?: string): string {
  if (d.responses.some((r) => r.status === 'SENT')) return 'Replied'
  if (!['NEW', 'IN_PROGRESS'].includes(d.review.status)) return 'No reply needed'
  // Never "Overdue" where the badges and the Overdue tile do not count it (one rule, audit B3; positive and eBay's
  // automatic feedback are left out too, Owner 2026-10-27).
  if (d.noReply && d.noReply !== 'closed') return NO_TARGET_WORDS[d.noReply] ?? 'No reply target'
  if (d.review.imported) return NO_TARGET_WORDS.imported
  if (!takesReply(d)) return NO_TARGET_WORDS.no_reply
  const due = reviewDueAt(d.review.postedAt)
  // The year when it is not this year's (live audit D04: "Overdue since 16 Feb" was a year and a half ago).
  const sameYear = new Date(now).getFullYear() === due.getFullYear()
  const day = due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), timeZone })
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
    // No delivery date in Nexus is not "not delivered" (live audit B12: eBay orders carry none, next to "Order delivered on time").
    { label: 'Delivered', value: o.deliveredAt ? dateWords(o.deliveredAt, timeZone) : 'Not recorded', hint: o.deliveredAt ? undefined : 'Nexus has no delivery date for this order' },
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
  const waiting = !d.responses.some((r) => r.status === 'SENT') && ['NEW', 'IN_PROGRESS'].includes(d.review.status) && takesReply(d)
  if (waiting) steps.push({ key: 'reply', label: 'Replied', tone: 'neutral', at: null })
  return steps
}

/** The Review tab's "What happened": the last few steps (the History tab has them all). */
export function recentSteps(d: InboxDetail, n = 4): StepView[] {
  const all = historySteps(d)
  return all.slice(Math.max(0, all.length - n))
}

// ── Photos, eBay's topics, revision (PR G) ───────────────────────────

/**
 * Channels whose buyers' photos Nexus reads: eBay (the REST feedback read, PR G), Etsy's one photo and the store's review
 * app, Judge.me (PR I). Every other channel says where its buyers' photos really are (`photosElsewhere`).
 */
export const PHOTO_CHANNELS: readonly string[] = ['EBAY', 'ETSY', 'SHOPIFY']

/** Where the photos live (Nexus shows them from there), per channel. */
const PHOTOS_HOME: Record<string, string> = { EBAY: 'eBay', ETSY: 'Etsy', SHOPIFY: 'Judge.me' }

/** "No photos" in words, per channel. */
const NO_PHOTOS: Record<string, string> = {
  EBAY: 'No photos with this feedback. eBay buyers can add up to 5.',
  ETSY: 'No photo with this review. Etsy buyers can add one.',
  SHOPIFY: 'No photos with this review.',
}

/** The buyer's photos as the DS Lightbox takes them: in order, each named "Photo 2 of 3 from <buyer>". */
export function reviewPhotos(detail: Pick<InboxDetail, 'media' | 'review'>): LightboxItem[] {
  const media = [...(detail.media ?? [])].sort((a, b) => a.position - b.position).filter((m) => /^https?:\/\//i.test(m.url))
  return media.map((m, i) => ({ url: m.url, alt: photoAlt(i, media.length, detail.review.buyer), type: m.type === 'video' ? 'VIDEO' : 'IMAGE' }))
}

export type PhotosView =
  | { kind: 'photos'; count: string; items: LightboxItem[]; hint: string }
  /** Nexus reads this channel's photos and this review has none (or came from a file). */
  | { kind: 'none'; words: string }
  /** The channel gives sellers no buyers' photos: where they really are, and the page that shows them when Nexus knows it. */
  | { kind: 'elsewhere'; words: string; link: { label: string; href: string } | null }

/**
 * A channel that gives sellers no buyers' photos, in true words (no tiles: there is nothing for Nexus to show).
 * Amazon has no review API for sellers at all, so no photo ever reaches Nexus: a product review's photos show with the
 * review on Amazon's product page (linked when Nexus knows the ASIN and the market); Amazon seller feedback has no photos.
 */
export function photosElsewhere(detail: Pick<InboxDetail, 'review' | 'listingHref'>): Extract<PhotosView, { kind: 'elsewhere' }> {
  const r = detail.review
  const channel = r.channel.toUpperCase()
  if (channel === 'AMAZON') {
    if (r.kind === 'seller') return { kind: 'elsewhere', words: 'Amazon seller feedback has no photos: buyers leave stars and words only.', link: null }
    const market = marketCodeOf(r.market)
    const asin = !!r.asin && /^[A-Z0-9]{10}$/.test(r.asin)
    const words = 'Amazon gives sellers no review photos. Buyers’ photos show on the product page on Amazon.'
    if (asin && market && detail.listingHref) {
      return { kind: 'elsewhere', words, link: { label: `Open the product page on ${channelMarketWords('AMAZON', market)}`, href: detail.listingHref } }
    }
    if (asin && market) return { kind: 'elsewhere', words, link: null }
    return { kind: 'elsewhere', words: `${words} Nexus does not know ${asin ? 'the market' : 'the product’s ASIN'} of this review, so it cannot link the page.`, link: null }
  }
  const name = channelMarketWords(r.channel, null)
  return { kind: 'elsewhere', words: `Nexus reads no photos from ${name}: any the buyer added stay on ${name}.`, link: null }
}

/** What the pop-up's "Photos from the buyer" card shows. */
export function photosView(detail: Pick<InboxDetail, 'media' | 'review' | 'videoIn' | 'listingHref'>): PhotosView {
  const items = reviewPhotos(detail)
  const channel = detail.review.channel.toUpperCase()
  // A video Nexus cannot show (Judge.me gives no video URL): said, never hidden.
  const video = (also: boolean) =>
    detail.videoIn ? ` The buyer ${also ? 'also ' : ''}added a video: watch it in ${detail.videoIn} (it does not share videos with Nexus).` : ''
  if (items.length > 0) {
    const home = PHOTOS_HOME[channel]
    const where = home ? ` ${home} keeps the photos; Nexus shows them from ${home}.` : ''
    return { kind: 'photos', count: plural(items.length, 'photo', 'photos'), items, hint: `Press a photo to see it large.${where}${video(true)}` }
  }
  if (PHOTO_CHANNELS.includes(channel)) {
    const what = detail.review.kind === 'seller' ? 'feedback' : 'review'
    return { kind: 'none', words: detail.review.imported ? `This ${what} came from a file: its photos are not in Nexus.` : `${NO_PHOTOS[channel]}${video(false)}` }
  }
  return photosElsewhere(detail)
}

/** The Lightbox's head: who and where, and the item where it lives on the channel ("Open on eBay"). */
export function lightboxHead(detail: Pick<InboxDetail, 'review' | 'listingHref'>, timeZone?: string): { meta: string; external: { label: string; href: string } | null } {
  const r = detail.review
  const meta = [r.buyer ?? 'Buyer not named', channelMarketWords(r.channel, r.market), dateWords(r.postedAt, timeZone)].filter(Boolean).join(' · ')
  const external = detail.listingHref && r.channel.toUpperCase() === 'EBAY' ? { label: 'Open on eBay', href: detail.listingHref } : null
  return { meta, external }
}

/** eBay's topics as chips: the label and a tone from eBay's mood for it. */
export function topicChips(detail: Pick<InboxDetail, 'aiTopics'>): { key: string; label: string; tone: Tone; texts: string[] }[] {
  return (detail.aiTopics ?? []).map((t) => ({
    key: t.topic,
    label: t.label,
    tone: t.sentiment === 'POSITIVE' ? 'success' : t.sentiment === 'NEGATIVE' ? 'danger' : 'neutral',
    texts: t.texts,
  }))
}

/** eBay's revision words for the pop-up, with since when Nexus saw the state. Null when there is nothing to say. */
export function revisionLine(detail: Pick<InboxDetail, 'revision'>, timeZone?: string): { words: string; tone: Tone; since: string | null } | null {
  const r = detail.revision
  if (!r) return null
  const tone: Tone = r.tone === 'success' ? 'success' : r.tone === 'info' ? 'info' : r.tone === 'warning' ? 'warning' : 'neutral'
  return { words: r.words, tone, since: r.since ? `seen ${dateWords(r.since, timeZone)}` : null }
}

// ── Amazon seller feedback: the removal check ────────────────────────

export interface RemovalView {
  label: string
  tone: RemovalCheck['tone']
  why: string
  words: string
  rules: string[]
}

/** The pop-up's removal check for Amazon seller feedback; null for every other review. */
export function removalView(d: Pick<InboxDetail, 'removal' | 'review'>): RemovalView | null {
  const r = d.removal
  if (!r || d.review.channel.toUpperCase() !== 'AMAZON' || d.review.kind !== 'seller') return null
  return { label: r.label, tone: r.tone, why: r.why, words: r.words, rules: r.rules }
}
