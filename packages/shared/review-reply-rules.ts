/**
 * Reviews — how a reply works on each channel. ONE source for the API (`POST /api/reviews/:id/reply/send` refuses what
 * these rules refuse) and the web (the review pop-up passes them to the DS ReplyComposer). Pure: no I/O.
 *
 * Channel facts (checked 2026-10-26):
 * - eBay: Nexus posts the reply (Trading API RespondToFeedback; REST respondToFeedback for feedback read by eBay's REST
 *   Feedback API). One reply per feedback, up to 500 characters (RespondToFeedback `ResponseText`, "Max length: 500":
 *   https://developer.ebay.com/devzone/xml/docs/reference/ebay/RespondToFeedback.html; REST `responseText`, "Maximum
 *   length: 500": https://developer.ebay.com/api-docs/commerce/feedback/resources/respond_to_feedback/methods/respondToFeedback),
 *   can't be edited or removed. An imported eBay row has no eBay feedback id Nexus can answer, so it is copied and
 *   posted by hand.
 * - eBay, feedback FOR a buyer (the seller's side, `buyerFeedbackHeld`): positive only, up to 500 characters, within 90
 *   days of the completed sale (REST leaveFeedback `commentText` "Maximum length: 500",
 *   https://developer.ebay.com/api-docs/commerce/feedback/resources/feedback/methods/leaveFeedback; the 90 days:
 *   https://www.ebay.com/help/selling/leaving-feedback-buyers/leaving-feedback-buyers?id=4078). Nexus sends it only
 *   after a person approves it.
 * - eBay revision requests (`revisionWords`): 5 per calendar year plus 5 for every 1,000 feedback received that year,
 *   only for feedback under 30 days old, once per feedback, the buyer has 10 days
 *   (https://www.ebay.com/help/selling/leaving-feedback-buyers/viewing-responding-feedback-buyers?id=4102). eBay has no
 *   API to ask for one: it is asked in eBay Seller Hub.
 * - Amazon: no reply API. Copy the reply, open Seller Central (Feedback Manager for seller feedback), mark it as
 *   responded. No feedback-removal action from Nexus.
 * - Etsy: no reply API. One public reply within 100 days of the buyer's LAST EDIT, never edited
 *   (https://help.etsy.com/hc/en-us/articles/115015808588). Nexus reads the edit time from Etsy's `update_timestamp`
 *   (`lastEditedAt`); a review without one (a file import) counts from the posted time.
 * - Shopify: Shopify keeps no reviews itself; they live in the store's review app. Judge.me lets an app post a public
 *   reply (`POST /api/v1/replies`, https://judge.me/api/docs): a review read through Nexus's Judge.me connection is
 *   answered from Nexus. Okendo replies by API on its Enterprise plan only, Yotpo and Loox have no reply API: copy the
 *   reply, post it in the app, mark it as responded. Without an app (a file import), the same.
 *
 * Due: an open review (no status yet, New or In progress) is overdue once it is older than REPLY_DUE_HOURS.
 */

/** A review waits at most this long for a reply before it counts as overdue. */
export const REPLY_DUE_HOURS = 48
/** eBay RespondToFeedback `ResponseText` limit, in characters. */
export const EBAY_REPLY_LIMIT = 500
/** Etsy: one reply within this many days of the buyer's last edit. */
export const ETSY_REPLY_WINDOW_DAYS = 100
/** Triage statuses that still need a person; a null status counts as New. */
export const OPEN_REVIEW_STATUSES = ['NEW', 'IN_PROGRESS'] as const

const DAY_MS = 24 * 60 * 60 * 1000

export type ReplyMode = 'send' | 'copy'
export type ReplyHeldCode = 'already_replied' | 'window_closed' | 'buyer_unknown'

/** The store review apps a Shopify review can come from. */
export type ReviewApp = 'JUDGEME' | 'OKENDO' | 'YOTPO' | 'LOOX'
export const REVIEW_APPS: readonly ReviewApp[] = ['JUDGEME', 'OKENDO', 'YOTPO', 'LOOX']
export const REVIEW_APP_NAME: Record<ReviewApp, string> = { JUDGEME: 'Judge.me', OKENDO: 'Okendo', YOTPO: 'Yotpo', LOOX: 'Loox' }

/** The review app a Shopify review came from, by how Nexus read it ('JUDGEME_API' → Judge.me); null for a file or anything else. */
export function reviewAppOf(ingestSource: string | null | undefined): ReviewApp | null {
  return String(ingestSource ?? '').toUpperCase() === 'JUDGEME_API' ? 'JUDGEME' : null
}

/** What the rules need to know about one review. */
export interface ReplyRulesReview {
  /** 'seller' = seller feedback (eBay today), 'product' = a product review. */
  kind?: 'product' | 'seller' | null
  marketplace?: string | null
  postedAt?: string | Date | null
  /** Came from a file import: the channel's own id is unknown, so nothing can be posted through its API. */
  imported?: boolean
  /** A reply already went out (sent by Nexus, marked as responded, or seen on the channel). */
  replied?: boolean
  /**
   * The buyer's user ID on the channel (eBay's CommentingUser). eBay's RespondToFeedback needs it as TargetUserID; when a
   * caller passes it and it is empty, an eBay reply is held. Callers that do not know it leave it out.
   */
  buyerId?: string | null
  /** Etsy: when the buyer last edited the review (Etsy's `update_timestamp`); the 100 days count from it. Null → postedAt. */
  lastEditedAt?: string | Date | null
  /** Shopify: the review app the review was read from through Nexus (`reviewAppOf`); null for a file import. */
  app?: ReviewApp | null
  /** Shopify: whether Nexus still holds a working connection to that app. Left out = not known (the API checks again). */
  appConnected?: boolean
}

export interface ReplyWindow {
  days: number
  /** ISO time the window closes. */
  endsAt: string
  /** Day of the window, from 1 ("Day 12 of 100"). */
  day: number
  daysLeft: number
  closed: boolean
  /** "Day 12 of 100 · 88 days left to reply on Etsy" or "The reply window on Etsy closed on 3 Feb 2027." */
  words: string
}

export interface ReplyRules {
  channel: string
  /** 'send' = Nexus posts the reply through the channel's API; 'copy' = a person posts it, then marks it as responded. */
  mode: ReplyMode
  /** Characters, or null when the channel states none. */
  limit: number | null
  /** The channel's rule in words, for the composer's rule line. */
  ruleLine: string
  oneReply: boolean
  canEdit: boolean
  /** The main button when Nexus sends ("Send reply to eBay"); null in copy mode. */
  sendLabel: string | null
  /** Where the reply is posted by hand (copy mode), or null. */
  open: { label: string; href: string } | null
  /** Copy mode: "Mark as responded" records the reply in Nexus. */
  markAsResponded: boolean
  window: ReplyWindow | null
  /** Why no reply can go out now, in words, or null. */
  held: string | null
  heldCode: ReplyHeldCode | null
}

const AMAZON_DOMAIN: Record<string, string> = {
  IT: 'it', DE: 'de', FR: 'fr', ES: 'es', UK: 'co.uk', GB: 'co.uk', NL: 'nl', BE: 'com.be', SE: 'se', PL: 'pl',
  IE: 'ie', TR: 'com.tr', US: 'com', CA: 'ca', MX: 'com.mx', JP: 'co.jp', AU: 'com.au',
}
const EBAY_DOMAIN: Record<string, string> = {
  IT: 'it', DE: 'de', FR: 'fr', ES: 'es', UK: 'co.uk', GB: 'co.uk', NL: 'nl', BE: 'be', IE: 'ie', PL: 'pl', AT: 'at',
  CH: 'ch', US: 'com', CA: 'ca', AU: 'com.au',
}

/** The channel's public site for a market: "www.amazon.de", "www.ebay.it"; null for a channel without market sites. */
export function channelSiteDomain(channel: string, marketplace?: string | null): string | null {
  const market = String(marketplace ?? '').trim().toUpperCase()
  const c = String(channel ?? '').toUpperCase()
  if (c === 'AMAZON') return `www.amazon.${AMAZON_DOMAIN[market] ?? 'com'}`
  if (c === 'EBAY') return `www.ebay.${EBAY_DOMAIN[market] ?? 'com'}`
  return null
}

function sellerCentral(marketplace?: string | null): string {
  const market = String(marketplace ?? '').trim().toUpperCase()
  return `https://sellercentral.amazon.${AMAZON_DOMAIN[market] ?? 'com'}`
}

/** Characters as a person sees them (the web Textarea counter's rule): graphemes, else code points. */
export function replyLength(text: string | null | undefined): number {
  if (!text) return 0
  const Segmenter = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: 'grapheme' }) => { segment(s: string): Iterable<unknown> } }).Segmenter
  if (!Segmenter) return Array.from(text).length
  return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)).length
}

function asDate(v: string | Date | null | undefined): Date | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** "3 Feb 2027". */
function dayWords(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/** The Etsy-style reply window from the posted time, or null when the posted time is unknown. */
export function replyWindow(postedAt: string | Date | null | undefined, days: number, channelName: string, now: Date = new Date()): ReplyWindow | null {
  const from = asDate(postedAt)
  if (!from) return null
  const ends = new Date(from.getTime() + days * DAY_MS)
  const elapsedDays = Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY_MS))
  const closed = now.getTime() > ends.getTime()
  const day = Math.min(days, elapsedDays + 1)
  const daysLeft = closed ? 0 : Math.max(0, days - elapsedDays)
  const words = closed
    ? `The reply window on ${channelName} closed on ${dayWords(ends)}.`
    : `Day ${day} of ${days} · ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} left to reply on ${channelName}`
  return { days, endsAt: ends.toISOString(), day, daysLeft, closed, words }
}

/** How a reply to this review works on its channel. */
export function reviewReplyRules(channel: string, review: ReplyRulesReview = {}, now: Date = new Date()): ReplyRules {
  const c = String(channel ?? '').toUpperCase()
  const base = { channel: c, canEdit: false, sendLabel: null, open: null, markAsResponded: true, window: null, held: null, heldCode: null } as const
  let rules: ReplyRules

  if (c === 'EBAY' && !review.imported) {
    rules = {
      ...base, mode: 'send', limit: EBAY_REPLY_LIMIT, oneReply: true, markAsResponded: false, sendLabel: 'Send reply to eBay',
      ruleLine: `One reply per feedback, up to ${EBAY_REPLY_LIMIT} characters, can’t be edited or removed.`,
    }
  } else if (c === 'EBAY') {
    rules = {
      ...base, mode: 'copy', limit: EBAY_REPLY_LIMIT, oneReply: true,
      open: { label: 'Open eBay Seller Hub', href: `https://${channelSiteDomain('EBAY', review.marketplace)}/sh/ovw` },
      ruleLine: `This feedback came from a file, so Nexus cannot post to it: copy the reply and post it on eBay. One reply per feedback, up to ${EBAY_REPLY_LIMIT} characters, can’t be edited or removed.`,
    }
  } else if (c === 'AMAZON' && review.kind === 'seller') {
    rules = {
      ...base, mode: 'copy', limit: null, oneReply: true,
      open: { label: 'Open Feedback Manager', href: `${sellerCentral(review.marketplace)}/feedback-manager/index.html` },
      ruleLine: 'Reply in Seller Central (Feedback Manager): Amazon has no reply API, so copy the reply and open Feedback Manager. Public, one reply, can’t be edited; if you delete it you can’t reply again.',
    }
  } else if (c === 'AMAZON') {
    rules = {
      ...base, mode: 'copy', limit: null, oneReply: false,
      open: { label: 'Open in Seller Central', href: `${sellerCentral(review.marketplace)}/home` },
      ruleLine: 'Amazon has no reply API: copy the reply, answer in Seller Central where Amazon allows it, then mark it as responded.',
    }
  } else if (c === 'ETSY') {
    const window = replyWindow(review.lastEditedAt ?? review.postedAt, ETSY_REPLY_WINDOW_DAYS, 'Etsy', now)
    rules = {
      ...base, mode: 'copy', limit: null, oneReply: true, window,
      open: { label: 'Open reviews on Etsy', href: 'https://www.etsy.com/your/shops/me/reviews' },
      ruleLine: `Reply on Etsy.com: Etsy has no reply API, so copy the reply and open the review on Etsy. One public reply, within ${ETSY_REPLY_WINDOW_DAYS} days of the buyer’s last edit. It can’t be edited (only deleted, no second reply). After you reply the buyer can no longer change the review.`,
    }
  } else if (c === 'SHOPIFY' && review.app === 'JUDGEME' && !review.imported && review.appConnected === false) {
    rules = {
      ...base, mode: 'copy', limit: null, oneReply: false, canEdit: true,
      ruleLine: 'Judge.me is not connected to Nexus now: copy the reply, post it in Judge.me, then mark it as responded. Connect Judge.me in Reviews settings to reply from here.',
    }
  } else if (c === 'SHOPIFY' && review.app === 'JUDGEME' && !review.imported) {
    rules = {
      ...base, mode: 'send', limit: null, oneReply: true, markAsResponded: false, sendLabel: 'Send reply to Judge.me',
      ruleLine: 'Nexus posts the reply under the review in Judge.me: public on the store’s review widget, and Judge.me also e-mails it to the reviewer. One reply from Nexus; to change it later, use Judge.me.',
    }
  } else if (c === 'SHOPIFY' && review.app === 'OKENDO') {
    rules = {
      ...base, mode: 'copy', limit: null, oneReply: false, canEdit: true,
      ruleLine: 'Okendo lets apps post replies on its Enterprise plan only, and Nexus does not connect to Okendo yet: copy the reply, post it in Okendo, then mark it as responded.',
    }
  } else if (c === 'SHOPIFY' && (review.app === 'YOTPO' || review.app === 'LOOX')) {
    const name = REVIEW_APP_NAME[review.app]
    rules = {
      ...base, mode: 'copy', limit: null, oneReply: false, canEdit: true,
      ruleLine: `${name} gives apps no way to reply (read only): copy the reply, post it in ${name}, then mark it as responded.`,
    }
  } else if (c === 'SHOPIFY') {
    rules = {
      ...base, mode: 'copy', limit: null, oneReply: false, canEdit: true,
      ruleLine: review.imported
        ? 'This review came from a file, so Nexus cannot post to it: copy the reply, post it in your review app, then mark it as responded.'
        : 'Reply in your review app: Nexus is not connected to it, so copy the reply, post it there, then mark it as responded.',
    }
  } else {
    rules = {
      ...base, mode: 'copy', limit: null, oneReply: false,
      ruleLine: 'Nexus cannot post replies on this channel: copy the reply, post it there, then mark it as responded.',
    }
  }

  if (c === 'SHOPIFY' && rules.mode === 'send') {
    if (review.replied) return { ...rules, held: 'This review already has a reply sent from Nexus. To change it, use Judge.me.', heldCode: 'already_replied' }
    return rules
  }
  if (review.replied && rules.oneReply) {
    const name = c === 'EBAY' ? 'eBay' : c === 'AMAZON' ? 'Amazon' : c === 'ETSY' ? 'Etsy' : 'This channel'
    const noun = c === 'EBAY' || review.kind === 'seller' ? 'feedback' : 'review'
    return { ...rules, held: `This ${noun} already has a reply. ${name} allows one reply per ${noun}.`, heldCode: 'already_replied' }
  }
  if (rules.window?.closed) return { ...rules, held: rules.window.words, heldCode: 'window_closed' }
  if (c === 'EBAY' && rules.mode === 'send' && 'buyerId' in review && !(review.buyerId ?? '').trim()) {
    return { ...rules, held: 'eBay needs the buyer’s eBay user ID to post this reply, and this feedback has none. Reply in eBay Seller Hub instead.', heldCode: 'buyer_unknown' }
  }
  return rules
}

/** Why the API refuses to send (or record) this reply text under these rules, or null when it may go. */
export function replyRefusal(rules: ReplyRules, text: string | null | undefined): { code: ReplyHeldCode | 'empty_body' | 'too_long'; words: string } | null {
  if (rules.held && rules.heldCode) return { code: rules.heldCode, words: rules.held }
  const trimmed = (text ?? '').trim()
  if (!trimmed) return { code: 'empty_body', words: 'Write a reply first.' }
  const over = rules.limit != null ? replyLength(trimmed) - rules.limit : 0
  if (over > 0) {
    return { code: 'too_long', words: `Cut ${over} ${over === 1 ? 'character' : 'characters'} to send it (the limit is ${rules.limit}).` }
  }
  return null
}

/** A review still needs a person: no status yet, New or In progress. */
export function isReviewOpen(status: string | null | undefined): boolean {
  return status == null || (OPEN_REVIEW_STATUSES as readonly string[]).includes(status)
}

/** When a reply is due: REPLY_DUE_HOURS after the review was posted. */
export function reviewDueAt(postedAt: string | Date): Date {
  const posted = asDate(postedAt) ?? new Date(NaN)
  return new Date(posted.getTime() + REPLY_DUE_HOURS * 60 * 60 * 1000)
}

/** Open and older than REPLY_DUE_HOURS. */
export function isReviewOverdue(review: { status?: string | null; postedAt: string | Date }, now: Date = new Date()): boolean {
  if (!isReviewOpen(review.status)) return false
  const due = reviewDueAt(review.postedAt).getTime()
  return Number.isFinite(due) && due < now.getTime()
}

// ── eBay: feedback the seller leaves for a buyer ─────────────────────────────────────────────────────────────────────

/** eBay leaveFeedback `commentText` limit, in characters (REST and Trading LeaveFeedback alike). */
export const EBAY_BUYER_FEEDBACK_LIMIT = 500
/** eBay: a seller may leave feedback for a buyer for up to this many days from when the sale was completed. */
export const EBAY_BUYER_FEEDBACK_DAYS = 90
/** The rule line shown wherever feedback for buyers is written. */
export const EBAY_BUYER_FEEDBACK_RULE = `Positive only, up to ${EBAY_BUYER_FEEDBACK_LIMIT} characters, within ${EBAY_BUYER_FEEDBACK_DAYS} days of the completed sale. It can’t be changed after it is sent; you can add one follow-up on eBay later.`

/** What the rules need to know about one eBay order line waiting for the seller's feedback. */
export interface BuyerFeedbackLine {
  /** AWAITING (eBay lists it) | LEFT (left from Nexus) | GONE (eBay no longer lists it). */
  state: string
  /** An approval for it waits for a person. */
  waiting?: boolean
  /** When the sale was made (the Nexus order's purchase date); null when Nexus does not have the order. */
  soldAt?: string | Date | null
  /** The Nexus order has a return or case that is still open. */
  openReturn?: boolean
}

/** Days left to leave feedback for this sale (0 once the window closed); null when the sale date is unknown. */
export function buyerFeedbackDaysLeft(soldAt: string | Date | null | undefined, now: Date = new Date()): number | null {
  const from = asDate(soldAt)
  if (!from) return null
  const elapsed = Math.floor((now.getTime() - from.getTime()) / DAY_MS)
  return Math.max(0, EBAY_BUYER_FEEDBACK_DAYS - elapsed)
}

/** Why feedback cannot be sent for this order line now, in words, or null when it may be asked for. */
export function buyerFeedbackLineHeld(line: BuyerFeedbackLine, now: Date = new Date()): string | null {
  if (line.state === 'LEFT') return 'Feedback was already left for this buyer from Nexus. eBay allows one feedback per sale.'
  if (line.state === 'GONE') return 'eBay no longer lists this sale as waiting for feedback: it was left on eBay, or the time ran out.'
  if (line.waiting) return 'Already sent for approval: it waits on the Approvals page.'
  const from = asDate(line.soldAt)
  if (from && now.getTime() - from.getTime() > EBAY_BUYER_FEEDBACK_DAYS * DAY_MS) {
    return `Sold on ${dayWords(from)}: eBay allows feedback for a buyer only within ${EBAY_BUYER_FEEDBACK_DAYS} days of the sale.`
  }
  if (line.openReturn) return 'This order has an open return or case: leave feedback once it is closed.'
  return null
}

/** Why this feedback text cannot be sent, in words, or null when it may go. eBay takes positive feedback only. */
export function buyerFeedbackTextHeld(text: string | null | undefined): string | null {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return 'Write the feedback first.'
  const over = replyLength(trimmed) - EBAY_BUYER_FEEDBACK_LIMIT
  if (over > 0) return `Cut ${over} ${over === 1 ? 'character' : 'characters'} (eBay allows ${EBAY_BUYER_FEEDBACK_LIMIT}).`
  return null
}

// ── eBay: revision requests ──────────────────────────────────────────────────────────────────────────────────────

/** eBay's revision-request rules, in words. */
export const EBAY_REVISION_RULE = '5 per calendar year, plus 5 for every 1,000 feedback received that year. Only for feedback under 30 days old, once per feedback. The buyer has 10 days to answer.'
/** "Resolve the problem first" is eBay's advice, not a rule. */
export const EBAY_REVISION_TIP = 'Tip: resolve the problem first, then ask.'
/** Why Nexus cannot ask itself. */
export const EBAY_REVISION_NO_API = 'eBay has no API to ask for a revision: Nexus opens eBay Seller Hub, where you ask.'

export type RevisionTone = 'info' | 'success' | 'neutral' | 'warning'

/**
 * eBay's state of a feedback (REST getFeedback `feedbackState`) and its `eligibleForRevision`, in words. Null when there
 * is nothing to say about a revision (a feedback that stands, not eligible, or one never read by eBay's REST API).
 */
export function revisionWords(state: string | null | undefined, eligible: boolean | null | undefined): { words: string; tone: RevisionTone } | null {
  switch ((state ?? '').toUpperCase()) {
    case 'REVISION_OPEN': return { words: 'Waiting for the buyer', tone: 'info' }
    case 'REVISED': return { words: 'Revised by the buyer', tone: 'success' }
    case 'REVISION_DECLINED_OR_EXPIRED': return { words: 'Buyer said no, or 10 days passed', tone: 'neutral' }
    case 'WITHDRAWN': return { words: 'Withdrawn', tone: 'neutral' }
    case 'HIDDEN': return { words: 'Hidden by eBay', tone: 'neutral' }
    default: return eligible ? { words: 'Can be asked in Seller Hub', tone: 'warning' } : null
  }
}
