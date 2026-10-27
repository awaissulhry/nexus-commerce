/**
 * Reviews Inbox — the review pop-up: one review with everything around it (GET /api/reviews/inbox/:id), the person's
 * mood and themes (PATCH /api/reviews/:id/sentiment) and a translation on demand (POST /api/reviews/:id/translate).
 * Every Review read goes through `visibleReviewWhere`. The buyer's e-mail and address are never read here: contact
 * goes through the order's channel.
 */
import { channelLabel } from '@nexus/shared/channel-label'
import { channelSiteDomain, reviewReplyRules, type ReplyRules } from '@nexus/shared/review-reply-rules'
import prisma from '../../db.js'
import { isImportedSource, TRIAGE_STATUS_WORDS, variantWords } from './review-inbox-query.js'
import { repliedOnChannel } from './review-reply-send.service.js'
import { reviewKindOf, visibleReviewWhere, type ReviewKind } from './review-visibility.js'
import { REVIEW_CATEGORIES, SENTIMENT_LABELS, translateReviewText } from './sentiment-extraction.service.js'
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

/** Why a reply did not go out, in words (never a setting's name). */
export function failedReplyWords(code: string | null | undefined): string {
  switch (code) {
    case 'OPT_IN_OFF': return 'Nexus does not post to eBay yet. Nothing was sent.'
    case 'NO_CONNECTION': return 'eBay is not connected. Nothing was sent.'
    case 'TOKEN': return 'The eBay sign-in needs renewing. Nothing was sent.'
    case 'TOO_LONG': return 'The reply was too long for eBay. Nothing was sent.'
    case 'FAILURE': return 'eBay refused the reply. Nothing was sent.'
    default: return 'The reply did not go out. Nothing was sent.'
  }
}

/** The listing the review is about, on the channel's site. */
export function listingHref(channel: string, market: string | null, asin: string | null, rawPayload: unknown): string | null {
  const c = channel.toUpperCase()
  if (c === 'EBAY') {
    const itemId = rawPayload && typeof rawPayload === 'object' ? String((rawPayload as { ItemID?: unknown }).ItemID ?? '').trim() : ''
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
  /**
   * Amazon seller feedback only (PR H): whether asking Amazon to remove it may work, in words, and the rules it checks.
   * Nexus never asks Amazon (no API): the person opens Feedback Manager. Null for every other review.
   */
  removal: (RemovalCheck & { rules: readonly string[] }) | null
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
  timeline.sort((a, b) => a.at.getTime() - b.at.getTime())

  return {
    review: {
      id: r.id, channel: r.channel, market: r.marketplace, kind, rating: r.rating, title: r.title, body: r.body,
      buyer: r.authorName, postedAt: r.postedAt.toISOString(), ingestedAt: r.ingestedAt.toISOString(), imported,
      verifiedPurchase: r.verifiedPurchase, status: r.triageStatus ?? 'NEW', assignee: r.assignee, tags: r.triageTags,
      note: r.triageNote, triageUpdatedAt: r.triageUpdatedAt?.toISOString() ?? null, externalReviewId: r.externalReviewId,
      sku: r.sku, asin: r.asin,
    },
    english: r.bodyEnglish,
    language: r.language,
    languageWords: languageWords(r.language),
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
      buyerId: r.authorName,
    }, now),
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
