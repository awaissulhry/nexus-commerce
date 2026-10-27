/**
 * Reviews Inbox — the review pop-up: one review with everything around it (GET /api/reviews/inbox/:id), the person's
 * mood and themes (PATCH /api/reviews/:id/sentiment) and a translation on demand (POST /api/reviews/:id/translate).
 * Every Review read goes through `visibleReviewWhere`. The buyer's e-mail and address are never read here: contact
 * goes through the order's channel.
 */
import { channelLabel } from '@nexus/shared/channel-label'
import { REVIEW_APP_NAME, REVIEW_APP_REPLIES, channelSiteDomain, reviewAppOf, revisionWords, reviewReplyRules, type ReplyRules, type ReviewApp } from '@nexus/shared/review-reply-rules'
import prisma from '../../db.js'
import { isImportedSource, TRIAGE_STATUS_WORDS, variantWords } from './review-inbox-query.js'
import { repliedOnChannel, shopDomainOf } from './review-reply-send.service.js'
import { noReplyReason, reviewKindOf, visibleReviewWhere, type NoReplyReason, type ReviewKind } from './review-visibility.js'
import { guessLanguage } from './review-language.js'
import { REVIEW_CATEGORIES, SENTIMENT_LABELS, translateReviewText } from './sentiment-extraction.service.js'
import { EBAY_TOPIC_WORDS } from './adapters/ebay-topics.js'
import { feedbackRemovalCheck, fulfilmentOf, REMOVAL_RULES, type RemovalCheck } from './review-feedback-removal.js'

export const THEME_WORDS: Record<string, string> = {
  FIT_SIZING: 'Fit & sizing', DURABILITY: 'Durability', SHIPPING: 'Shipping', VALUE: 'Value', DESIGN: 'Design',
  QUALITY: 'Quality', SAFETY: 'Safety', COMFORT: 'Comfort', OTHER: 'Other',
}
const MOOD_WORDS: Record<string, string> = { POSITIVE: 'Positive', NEUTRAL: 'Neutral', NEGATIVE: 'Negative' }
/** The score a person's mood stands for (the classifier's scale, -1..1). */
const MOOD_SCORE: Record<string, number> = { POSITIVE: 0.7, NEUTRAL: 0, NEGATIVE: -0.7 }

function displayName(type: 'language' | 'region', code: string | null | undefined): string | null {
  if (!code) return null
  try {
    return new Intl.DisplayNames('en', { type }).of(type === 'region' && code.toUpperCase() === 'UK' ? 'GB' : code) ?? null
  } catch {
    return null
  }
}

/** "German" for 'de'; null when unknown. */
export function languageWords(code: string | null | undefined): string | null {
  return displayName('language', code)
}

/** "eBay Germany", "Shopify" (no market, or GLOBAL). */
export function placeWords(channel: string, market: string | null | undefined): string {
  const name = channelLabel(channel)
  const code = String(market ?? '').trim().toUpperCase()
  const region = code && code !== 'GLOBAL' ? displayName('region', code) : null
  return region ? `${name} ${region}` : name
}

/** A review app's reply code in words (JUDGEME_401, OKENDO_NO_ANSWER …), or null when it is not one. */
function appReplyWords(code: string | null | undefined): string | null {
  const m = /^(JUDGEME|OKENDO)_(.+)$/.exec(code ?? '')
  if (!m) return null
  const name = REVIEW_APP_NAME[m[1] as ReviewApp]
  const key = m[1] === 'JUDGEME' ? 'API token' : 'API key'
  switch (m[2]) {
    case 'NOT_CONNECTED': return `${name} is not connected to Nexus. Nothing was sent.`
    case '401': case '403': return `${name} refused the ${key}. Paste a new one in Reviews settings. Nothing was sent.`
    case '400': case '404': case '422': return `${name} refused the reply. Nothing was sent.`
    case 'NO_ANSWER': return `${name} did not answer. Check in ${name} whether the reply is there before sending again.`
    default: return null
  }
}

/** Why a reply did not go out, in words (never a setting's name). */
export function failedReplyWords(code: string | null | undefined): string {
  switch (code) {
    case 'OPT_IN_OFF': return 'Nexus does not post to eBay yet. Nothing was sent.'
    case 'NO_CONNECTION': return 'eBay is not connected. Nothing was sent.'
    case 'TOKEN': return 'The eBay sign-in needs renewing. Nothing was sent.'
    case 'TOO_LONG': return 'The reply was too long for eBay. Nothing was sent.'
    case 'FAILURE': return 'eBay refused the reply. Nothing was sent.'
    default: return appReplyWords(code) ?? 'The reply did not go out. Nothing was sent.'
  }
}

/** The listing the review is about, on the channel's site. */
export function listingHref(channel: string, market: string | null, asin: string | null, rawPayload: unknown): string | null {
  const c = channel.toUpperCase()
  if (c === 'EBAY') {
    // Trading GetFeedback names the item `ItemID`; eBay's REST getFeedback `orderLineItemSummary.listingId`.
    const raw = rawPayload && typeof rawPayload === 'object' ? (rawPayload as { ItemID?: unknown; orderLineItemSummary?: { listingId?: unknown } | null }) : null
    const itemId = String(raw?.ItemID ?? raw?.orderLineItemSummary?.listingId ?? '').trim()
    return /^\d{6,}$/.test(itemId) ? `https://${channelSiteDomain('EBAY', market)}/itm/${itemId}` : null
  }
  if (c === 'AMAZON' && asin && /^[A-Z0-9]{10}$/.test(asin)) return `https://${channelSiteDomain('AMAZON', market)}/dp/${asin}`
  return null
}

export interface InboxDetail {
  review: {
    id: string; channel: string; market: string | null; kind: ReviewKind; rating: number | null; title: string | null; body: string
    buyer: string | null; postedAt: string; ingestedAt: string; imported: boolean; verifiedPurchase: boolean
    status: string; assignee: string | null; tags: string[]; note: string | null; triageUpdatedAt: string | null
    externalReviewId: string; sku: string | null; asin: string | null
  }
  english: string | null
  language: string | null
  /** "Italian"; "Italian (from the text)" when the AI never read it and the words say so; null when not known. */
  languageWords: string | null
  /**
   * Why this review needs no reply (review-visibility.ts `noReplyReason`: imported, nobody can answer, Etsy's window
   * closed, positive, eBay's automatic feedback, closed by a person); null while it needs one. The badges count the same.
   */
  noReply: NoReplyReason | null
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
  /** PR G — the buyer's photos (or videos), in order; [] when none. eBay's, Etsy's one photo and the review apps' (PR I). */
  media: { url: string; type: string; width: number | null; height: number | null; position: number }[]
  /** PR I — the review app that holds a video Nexus does not show (the apps give no file Nexus can play for sure); null when none. */
  videoIn: string | null
  /** Shopify: the review app the review was read from ("Okendo"), which keeps its photos; null otherwise. */
  app: string | null
  /** PR G — eBay's AI topics with the buyer's words eBay found for each; null when eBay's topics were not read. */
  aiTopics: { topic: string; label: string; sentiment: string | null; texts: string[] }[] | null
  /** PR G — eBay's revision state of this feedback, in words; null when there is nothing to say. */
  revision: { state: string | null; words: string; tone: string; since: string | null; eligible: boolean } | null
  /**
   * Amazon seller feedback only (PR H): whether asking Amazon to remove it may work, in words, and the rules it checks.
   * Nexus never asks Amazon (no API): the person opens Feedback Manager. Null for every other review.
   */
  removal: (RemovalCheck & { rules: readonly string[] }) | null
}

/** eBay's AI topics as the pop-up shows them (pure; null = not read, unknown JSON skipped). */
export function detailTopics(raw: unknown): InboxDetail['aiTopics'] {
  if (!Array.isArray(raw)) return null
  const out: NonNullable<InboxDetail['aiTopics']> = []
  for (const t of raw) {
    const item = (t ?? {}) as { topic?: unknown; sentiment?: unknown; texts?: unknown }
    const topic = typeof item.topic === 'string' ? item.topic.trim().toLowerCase() : ''
    if (!topic || out.some((o) => o.topic === topic)) continue
    out.push({
      topic,
      label: EBAY_TOPIC_WORDS[topic] ?? topic.charAt(0).toUpperCase() + topic.slice(1),
      sentiment: typeof item.sentiment === 'string' ? item.sentiment.toUpperCase() : null,
      texts: Array.isArray(item.texts) ? item.texts.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 3) : [],
    })
  }
  return out
}

/** GET /api/reviews/inbox/:id; null when the review is not in this business's Inbox. */
export async function getInboxReview(id: string, now: Date = new Date()): Promise<InboxDetail | null> {
  const r = await prisma.review.findFirst({
    where: visibleReviewWhere({ id }),
    include: {
      sentiment: { select: { label: true, categories: true, extractedAt: true, model: true, editedAt: true } },
      product: {
        select: {
          id: true, name: true, sku: true, parentId: true, variantAttributes: true,
          parent: { select: { id: true, name: true, sku: true } },
        },
      },
      responses: { orderBy: { createdAt: 'asc' } },
      media: { orderBy: { position: 'asc' }, select: { url: true, type: true, width: true, height: true, position: true } },
    },
  })
  if (!r) return null

  const buyerWhere = r.authorId ? { authorId: r.authorId } : r.authorName ? { authorName: r.authorName } : null
  const [order, history] = await Promise.all([
    r.orderId
      ? prisma.order.findUnique({
          where: { id: r.orderId },
          select: {
            id: true, channelOrderId: true, channel: true, marketplace: true, purchaseDate: true, createdAt: true,
            deliveredAt: true, totalPrice: true, currencyCode: true, status: true, fulfillmentMethod: true,
          },
        })
      : Promise.resolve(null),
    buyerWhere
      ? prisma.review.findMany({
          where: visibleReviewWhere({ channel: r.channel, id: { not: r.id }, ...buyerWhere }),
          orderBy: { postedAt: 'desc' },
          take: 10,
          select: { id: true, postedAt: true, rating: true, title: true, body: true },
        })
      : Promise.resolve([]),
  ])
  const ret = order
    ? await prisma.return.findFirst({
        where: { orderId: order.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, reason: true, createdAt: true },
      })
    : null

  const kind = reviewKindOf(r.channel, r.kind)
  // Shopify via Judge.me or Okendo: replies go out from here while the app is connected (reviewReplyRules decides).
  const app = r.channel === 'SHOPIFY' ? reviewAppOf(r.ingestSource) : null
  const appConnected = app && REVIEW_APP_REPLIES[app] ? await import('./review-app-connection.service.js').then((m) => m.reviewAppConnected(app)) : undefined
  const imported = isImportedSource(r.ingestSource)
  const sent = r.responses.some((x) => x.status === 'SENT')
  const place = placeWords(r.channel, r.marketplace)
  const variantChild = r.product?.parentId ? r.product : null
  const product = r.product ? (r.product.parent ?? { id: r.product.id, name: r.product.name, sku: r.product.sku }) : null
  const variant = variantChild
    ? {
        id: variantChild.id, name: variantChild.name, sku: variantChild.sku,
        words: variantWords(variantChild.variantAttributes),
      }
    : null

  const timeline: { at: Date; words: string }[] = []
  if (order) {
    timeline.push({ at: order.purchaseDate ?? order.createdAt, words: `Order placed on ${placeWords(order.channel, order.marketplace)}` })
    if (order.deliveredAt) timeline.push({ at: order.deliveredAt, words: 'Delivered' })
  }
  if (ret) timeline.push({ at: ret.createdAt, words: ret.reason ? `Return requested — ${ret.reason}` : 'Return requested' })
  timeline.push({ at: r.postedAt, words: kind === 'seller' ? `Feedback left on ${place}` : `Review posted on ${place}` })
  timeline.push({ at: r.ingestedAt, words: imported ? 'Imported from a file' : `Received from ${place}` })
  // Amazon seller feedback: the seller's public reply as Amazon's report shows it ("Your Response"), when there is one.
  const amazonReply = r.channel.toUpperCase() === 'AMAZON' && repliedOnChannel('AMAZON', r.rawPayload)
    ? String((r.rawPayload as Record<string, unknown>).yourResponse).replace(/\s+/g, ' ').trim()
    : null
  if (amazonReply) timeline.push({ at: r.ingestedAt, words: `Your reply on ${place}, as Amazon’s report shows it: “${amazonReply.length > 200 ? `${amazonReply.slice(0, 199)}…` : amazonReply}”` })
  if (r.sentiment && r.sentiment.model !== 'person') {
    const themes = r.sentiment.categories.map((c) => THEME_WORDS[c] ?? c).join(', ')
    timeline.push({ at: r.sentiment.extractedAt, words: `AI read it: mood ${MOOD_WORDS[r.sentiment.label] ?? r.sentiment.label}${themes ? ` · ${themes}` : ''}` })
  }
  if (r.sentiment?.editedAt) timeline.push({ at: r.sentiment.editedAt, words: 'Mood and themes set by a person' })
  for (const x of r.responses) {
    if (x.status === 'DRAFT') {
      const lang = languageWords(x.locale)
      timeline.push({ at: x.createdAt, words: x.isAiDrafted ? `AI draft made${lang ? `, in ${lang}` : ''}. Not sent: it waits for a person.` : 'Reply draft saved. Not sent.' })
    } else if (x.status === 'SENT') {
      const posted = x.providerResponseCode && x.providerResponseCode !== 'MANUAL'
      timeline.push({ at: x.sentAt ?? x.updatedAt, words: posted ? `Reply posted on ${place}` : 'Marked as responded' })
    } else if (x.status === 'FAILED') {
      timeline.push({ at: x.updatedAt, words: failedReplyWords(x.providerResponseCode) })
    }
  }
  if (r.triageUpdatedAt) {
    timeline.push({ at: r.triageUpdatedAt, words: r.triageStatus ? `Status: ${TRIAGE_STATUS_WORDS[r.triageStatus] ?? r.triageStatus}` : 'Triage changed' })
  }
  // PR G — eBay's revision state, from when Nexus first read it (eBay gives no date for it).
  const revisionSaid = r.channel === 'EBAY' && r.feedbackStateAt ? revisionWords(r.feedbackState, false) : null
  if (revisionSaid) timeline.push({ at: r.feedbackStateAt!, words: `Revision request: ${revisionSaid.words.toLowerCase()} (as Nexus read it from eBay)` })
  timeline.sort((a, b) => a.at.getTime() - b.at.getTime())
  // C04 — a row the AI never read has no language: guess it from the words, so English text is not offered a translation.
  const guessed = r.language ? null : guessLanguage(r.body)

  return {
    review: {
      id: r.id, channel: r.channel, market: r.marketplace, kind, rating: r.rating, title: r.title, body: r.body,
      buyer: r.authorName, postedAt: r.postedAt.toISOString(), ingestedAt: r.ingestedAt.toISOString(), imported,
      verifiedPurchase: r.verifiedPurchase, status: r.triageStatus ?? 'NEW', assignee: r.assignee, tags: r.triageTags,
      note: r.triageNote, triageUpdatedAt: r.triageUpdatedAt?.toISOString() ?? null, externalReviewId: r.externalReviewId,
      sku: r.sku, asin: r.asin,
    },
    english: r.bodyEnglish,
    language: r.language ?? guessed,
    languageWords: r.language ? languageWords(r.language) : guessed ? `${languageWords(guessed)} (from the text)` : null,
    noReply: noReplyReason({ ...r, mood: r.sentiment?.label ?? null }, now),
    product,
    variant,
    order: order
      ? {
          id: order.id, label: order.channelOrderId, channel: order.channel, market: order.marketplace,
          placedAt: (order.purchaseDate ?? order.createdAt).toISOString(), deliveredAt: order.deliveredAt?.toISOString() ?? null,
          total: order.totalPrice.toString(), currency: order.currencyCode, status: order.status,
        }
      : null,
    return: ret ? { id: ret.id, status: ret.status, reasonWords: ret.reason, requestedAt: ret.createdAt.toISOString() } : null,
    listingHref: listingHref(r.channel, r.marketplace, r.asin, r.rawPayload),
    buyerHistory: history.map((h) => {
      const text = (h.title ? `${h.title} — ${h.body}` : h.body).replace(/\s+/g, ' ').trim()
      return { id: h.id, postedAt: h.postedAt.toISOString(), rating: h.rating, snippet: text.length > 160 ? `${text.slice(0, 159)}…` : text }
    }),
    sentiment: {
      label: r.sentiment?.label ?? null,
      categories: r.sentiment?.categories ?? [],
      edited: !!r.sentiment?.editedAt,
      editedAt: r.sentiment?.editedAt?.toISOString() ?? null,
    },
    responses: r.responses.map((x) => ({
      id: x.id, status: x.status, body: x.body, locale: x.locale, isAiDrafted: x.isAiDrafted,
      createdAt: x.createdAt.toISOString(), sentAt: x.sentAt?.toISOString() ?? null, createdBy: x.createdBy,
      failedWords: x.status === 'FAILED' ? failedReplyWords(x.providerResponseCode) : null,
    })),
    timeline: timeline.map((t) => ({ at: t.at.toISOString(), words: t.words })),
    reply: reviewReplyRules(r.channel, {
      kind, marketplace: r.marketplace, postedAt: r.postedAt, imported, replied: sent || repliedOnChannel(r.channel, r.rawPayload),
      buyerId: r.authorName, lastEditedAt: r.channelEditedAt, app, appConnected, shopDomain: shopDomainOf(r.rawPayload),
    }, now),
    media: r.media.map((m) => ({ url: m.url, type: m.type, width: m.width, height: m.height, position: m.position })),
    videoIn: app && (r.rawPayload as { hasVideo?: unknown } | null)?.hasVideo === true ? REVIEW_APP_NAME[app] : null,
    app: app ? REVIEW_APP_NAME[app] : null,
    aiTopics: detailTopics(r.channelTopics),
    revision: (() => {
      const said = r.channel === 'EBAY' ? revisionWords(r.feedbackState, r.revisionEligible === true && (r.rating ?? 5) <= 3) : null
      return said ? { state: r.feedbackState, words: said.words, tone: said.tone, since: r.feedbackStateAt?.toISOString() ?? null, eligible: r.revisionEligible === true } : null
    })(),
    removal: r.channel.toUpperCase() === 'AMAZON' && kind === 'seller'
      ? {
          ...feedbackRemovalCheck({
            text: r.body, english: r.bodyEnglish, themes: r.sentiment?.categories ?? null, postedAt: r.postedAt,
            fulfilment: fulfilmentOf(order?.fulfillmentMethod), now,
          }),
          rules: REMOVAL_RULES,
        }
      : null,
  }
}

// ── Mood and themes, set by a person ─────────────────────────────────────────────────────────────────────────────

export type SentimentEdit = { label?: unknown; categories?: unknown }

/** Validates the person's mood/themes: upper-case known values, themes de-duplicated. */
export function validateSentimentEdit(body: SentimentEdit):
  | { ok: true; label?: string; categories?: string[] }
  | { ok: false; error: string; words: string } {
  const out: { label?: string; categories?: string[] } = {}
  if (body.label !== undefined) {
    const label = typeof body.label === 'string' ? body.label.toUpperCase() : ''
    if (!(SENTIMENT_LABELS as readonly string[]).includes(label)) return { ok: false, error: 'invalid_label', words: 'Pick Positive, Neutral or Negative.' }
    out.label = label
  }
  if (body.categories !== undefined) {
    if (!Array.isArray(body.categories)) return { ok: false, error: 'invalid_category', words: 'Themes must be a list.' }
    const categories = [...new Set(body.categories.map((c) => (typeof c === 'string' ? c.toUpperCase() : '')))]
    const unknown = categories.find((c) => !(REVIEW_CATEGORIES as readonly string[]).includes(c))
    if (unknown !== undefined) return { ok: false, error: 'invalid_category', words: `“${unknown}” is not a theme Nexus knows.` }
    out.categories = categories
  }
  if (out.label === undefined && out.categories === undefined) return { ok: false, error: 'nothing_to_change', words: 'Change the mood or the themes.' }
  return { ok: true, ...out }
}

/** PATCH /api/reviews/:id/sentiment — stores the person's choice; a later AI re-read keeps it (persistSentiment). */
export async function editReviewSentiment(
  id: string,
  body: SentimentEdit,
  actor: string,
): Promise<{ error: string; words: string } | { sentiment: { label: string; categories: string[]; edited: true; editedAt: string } }> {
  const valid = validateSentimentEdit(body)
  if ('error' in valid) return { error: valid.error, words: valid.words }
  const review = await prisma.review.findFirst({
    where: visibleReviewWhere({ id }),
    select: { id: true, sentiment: { select: { label: true } } },
  })
  if (!review) return { error: 'not_found', words: 'This review is not in this business’s Inbox.' }
  const editedAt = new Date()
  const label = valid.label ?? review.sentiment?.label ?? 'NEUTRAL'
  const scoreChange = valid.label && valid.label !== review.sentiment?.label ? { score: MOOD_SCORE[valid.label] } : {}
  const row = await prisma.reviewSentiment.upsert({
    where: { reviewId: id },
    create: {
      reviewId: id, label, score: MOOD_SCORE[label] ?? 0, categories: valid.categories ?? [], topPhrases: [],
      model: 'person', editedBy: actor, editedAt,
    },
    update: {
      ...(valid.label ? { label: valid.label } : {}),
      ...scoreChange,
      ...(valid.categories ? { categories: valid.categories } : {}),
      editedBy: actor,
      editedAt,
    },
    select: { label: true, categories: true },
  })
  return { sentiment: { label: row.label, categories: row.categories, edited: true, editedAt: editedAt.toISOString() } }
}

// ── Translation on demand ────────────────────────────────────────────────────────────────────────────────────────

/** POST /api/reviews/:id/translate — the stored translation, else one AI call whose answer is kept on the review. */
export async function translateReview(
  id: string,
): Promise<{ error: 'not_found' | 'unavailable' } | { language: string | null; english: string | null; cached: boolean }> {
  const r = await prisma.review.findFirst({
    where: visibleReviewWhere({ id }),
    select: { id: true, title: true, body: true, language: true, bodyEnglish: true },
  })
  if (!r) return { error: 'not_found' }
  if (r.language && (r.language === 'en' || r.bodyEnglish)) {
    return { language: r.language, english: r.language === 'en' ? null : r.bodyEnglish, cached: true }
  }
  const out = await translateReviewText({ reviewId: r.id, title: r.title, body: r.body })
  if (!out || !out.language) return { error: 'unavailable' }
  await prisma.review.update({ where: { id: r.id }, data: { language: out.language, bodyEnglish: out.english } })
  return { language: out.language, english: out.english, cached: false }
}
