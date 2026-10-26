/**
 * RX.2 — AI-drafted review replies.
 *
 * Drafts a concise, on-brand, localized public reply to a review. Uses
 * the same fetch-based Anthropic pattern as sentiment extraction, pulls
 * brand voice from the Brand Brain, and localizes per the review's
 * marketplace. Degrades to a localized template when ANTHROPIC_API_KEY
 * is absent or the call fails — so a draft is *always* produced.
 *
 * Policy guardrails baked into the system prompt: no incentives, no
 * asking the customer to change/remove the review, no external links —
 * the same rules Amazon/eBay enforce on seller replies.
 *
 * Reviews Inbox (2026-10-26): the draft is written in the buyer's language (the review's own language when known) and
 * comes with an English line for the team (`englishText`, null when the reply is English), from the same call; it
 * stays within the channel's reply limit (`reviewReplyRules`).
 *
 * Reviews Settings (2026-10-26, PR D): the business's voice — tone (warm, neutral, formal), the languages it replies
 * in, its sign-off and words to avoid — and its saved replies for the channel shape every draft
 * (review-settings.service.ts). The built-in fallback gains the sign-off when the channel's limit allows.
 */

import { reviewReplyRules } from '@nexus/shared/review-reply-rules'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { renderBrandVoiceBlock } from '../ai/brand-voice.service.js'
import { resolveLocaleForMarketplace } from './sentiment-check-email.service.js'
import { reviewKindOf } from './review-visibility.js'
import {
  DEFAULT_VOICE, promptTemplatesFor, readVoiceAndAlerts, replyLocale, voicePromptLines, withSignOff, type PromptTemplate, type VoiceSettings,
} from './review-settings.service.js'

const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const MODEL = process.env.NEXUS_REVIEW_REPLY_MODEL ?? 'claude-haiku-4-5-20251001'

type Locale = 'it' | 'de' | 'fr' | 'es' | 'en'
const LANG_NAME: Record<Locale, string> = {
  it: 'Italian',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  en: 'English',
}

type Tone = 'apologetic' | 'appreciative' | 'neutral'

export interface DraftReplyInput {
  reviewId: string
  locale?: Locale
  tone?: 'auto' | Tone
  instructions?: string
}

export interface DraftReplyResult {
  text: string
  /** What the reply says, in English, for the team; null when the reply is English. */
  englishText: string | null
  locale: Locale
  tone: Tone
  model: string
  usedAi: boolean
}

// Localized graceful-fallback templates (no AI key / AI failure).
const FALLBACK: Record<Locale, Record<Tone, (product: string) => string>> = {
  it: {
    apologetic: (p) =>
      `Ci dispiace molto per l'inconveniente con ${p}. Il tuo feedback è importante per noi: contatta il nostro servizio clienti e troveremo subito una soluzione.`,
    appreciative: (p) =>
      `Grazie di cuore per la tua recensione! Siamo felici che ${p} ti abbia soddisfatto. A presto da Xavia.`,
    neutral: (p) =>
      `Grazie per il tuo feedback su ${p}. Restiamo a disposizione per qualsiasi domanda.`,
  },
  de: {
    apologetic: (p) =>
      `Es tut uns sehr leid, dass es mit ${p} ein Problem gab. Bitte kontaktiere unseren Kundenservice – wir finden gemeinsam eine Lösung.`,
    appreciative: (p) =>
      `Vielen Dank für deine Bewertung! Es freut uns, dass dich ${p} überzeugt hat.`,
    neutral: (p) => `Danke für dein Feedback zu ${p}. Bei Fragen sind wir gerne für dich da.`,
  },
  fr: {
    apologetic: (p) =>
      `Nous sommes désolés pour ce désagrément avec ${p}. Contactez notre service client, nous trouverons une solution rapidement.`,
    appreciative: (p) =>
      `Merci beaucoup pour votre avis ! Nous sommes ravis que ${p} vous ait plu.`,
    neutral: (p) => `Merci pour votre retour sur ${p}. Nous restons à votre disposition.`,
  },
  es: {
    apologetic: (p) =>
      `Lamentamos mucho el inconveniente con ${p}. Por favor, contacta con nuestro servicio de atención al cliente y lo resolveremos enseguida.`,
    appreciative: (p) =>
      `¡Muchas gracias por tu reseña! Nos alegra que ${p} te haya gustado.`,
    neutral: (p) => `Gracias por tu opinión sobre ${p}. Quedamos a tu disposición.`,
  },
  en: {
    apologetic: (p) =>
      `We're sorry for the trouble with ${p}. Your feedback matters to us — please reach out to our customer service and we'll make it right.`,
    appreciative: (p) =>
      `Thank you so much for your review! We're delighted ${p} met your expectations.`,
    neutral: (p) => `Thanks for your feedback on ${p}. We're here if you need anything.`,
  },
}

function fallbackReply(locale: Locale, tone: Tone, product: string | null): string {
  const p = product ?? (locale === 'it' ? 'il nostro prodotto' : 'our product')
  return FALLBACK[locale][tone](p)
}

function fallbackDraft(locale: Locale, tone: Tone, product: string | null, voice: { signOff: string | null; limit: number | null } = { signOff: null, limit: null }): DraftReplyResult {
  return {
    text: withSignOff(fallbackReply(locale, tone, product), voice.signOff, voice.limit),
    englishText: locale === 'en' ? null : withSignOff(fallbackReply('en', tone, product), voice.signOff, null),
    locale,
    tone,
    model: 'fallback',
    usedAi: false,
  }
}

/** The model's answer: JSON {reply, english} when asked for both, else plain text (the reply alone). */
export function parseDraftAnswer(raw: string, locale: Locale): { text: string; englishText: string | null } {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  if (locale !== 'en' && cleaned.startsWith('{')) {
    try {
      const parsed = JSON.parse(cleaned) as { reply?: unknown; english?: unknown }
      const text = typeof parsed.reply === 'string' ? parsed.reply.trim() : ''
      const english = typeof parsed.english === 'string' && parsed.english.trim() ? parsed.english.trim() : null
      if (text) return { text, englishText: english }
    } catch {
      /* not JSON: the whole answer is the reply */
    }
  }
  return { text: cleaned, englishText: null }
}

export async function draftReviewReply(input: DraftReplyInput): Promise<DraftReplyResult> {
  const review = await prisma.review.findUnique({
    where: { id: input.reviewId },
    include: {
      sentiment: true,
      product: { select: { name: true, productType: true, brand: true } },
    },
  })
  if (!review) throw new Error('review not found')

  // The business's voice and saved replies (Reviews Settings); a failed read drafts with the defaults.
  let voice: VoiceSettings = DEFAULT_VOICE
  let templates: PromptTemplate[] = []
  try {
    ;[voice, templates] = await Promise.all([readVoiceAndAlerts().then((s) => s.voice), promptTemplatesFor(review.channel)])
  } catch (err) {
    logger.warn('[review-reply] reading the reply voice failed, drafting with the defaults', { error: err instanceof Error ? err.message : String(err) })
  }

  // The buyer's language: the review's own language when Nexus knows it and drafts in it, else the market's. The
  // business may reply in other languages only (Reviews Settings › "Reply in"); a person's explicit pick wins.
  const reviewLocale = review.language && review.language in LANG_NAME ? (review.language as Locale) : null
  const buyerLocale: Locale = reviewLocale ?? (resolveLocaleForMarketplace(review.marketplace) as Locale)
  const locale: Locale = input.locale ?? replyLocale(voice.languages, buyerLocale)
  const limit = reviewReplyRules(review.channel, {
    kind: reviewKindOf(review.channel, review.ingestSource),
    imported: (review.ingestSource ?? '').toUpperCase().startsWith('IMPORT'),
  }).limit
  const langName = LANG_NAME[locale] ?? 'English'
  const label = review.sentiment?.label ?? null
  const tone: Tone =
    input.tone && input.tone !== 'auto'
      ? input.tone
      : label === 'NEGATIVE'
        ? 'apologetic'
        : label === 'POSITIVE'
          ? 'appreciative'
          : 'neutral'
  const productName = review.product?.name ?? review.sku ?? null

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return fallbackDraft(locale, tone, productName, { signOff: voice.signOff, limit })

  let brandVoice = ''
  try {
    brandVoice = await renderBrandVoiceBlock(prisma, {
      brand: review.product?.brand ?? 'Xavia',
      marketplace: review.marketplace ?? undefined,
      language: locale,
    })
  } catch {
    brandVoice = ''
  }

  const toneRule =
    tone === 'apologetic'
      ? 'Acknowledge the issue sincerely, apologize, and invite them to contact support to make it right. Never be defensive.'
      : tone === 'appreciative'
        ? 'Thank them warmly and reinforce one specific thing they liked.'
        : 'Respond politely and helpfully.'

  const system =
    `You are a customer-experience specialist writing a PUBLIC reply to a product review for an online seller. ` +
    `Write a concise, warm, professional reply in ${langName}.\n` +
    `Rules:\n` +
    `- 2–4 sentences. Plain text only — no markdown, no greeting placeholder, no signature line.\n` +
    `- ${toneRule}\n` +
    `- Never offer incentives or discounts, and never ask them to change or remove their review (against marketplace policy).\n` +
    `- Do not include external links or email addresses.` +
    (limit != null ? `\n- At most ${limit} characters in total (the channel refuses longer replies).` : '') +
    `\n${voicePromptLines(voice, templates, locale).map((line) => (line.startsWith('- ') ? `  ${line}` : `- ${line}`)).join('\n')}` +
    (locale !== 'en'
      ? `\nAnswer with STRICT JSON only: {"reply": the reply in ${langName}, "english": the same reply in English, for the seller's team}.`
      : '') +
    (brandVoice ? `\n${brandVoice}` : '')

  const userText =
    `Review (rating ${review.rating ?? 'n/a'}/5)${review.title ? `, title: "${review.title}"` : ''}:\n` +
    `"${review.body}"\n` +
    `Product: ${productName ?? 'unknown'} (${review.product?.productType ?? 'product'})` +
    (input.instructions ? `\nExtra instruction from operator: ${input.instructions}` : '') +
    (locale !== 'en'
      ? `\n\nWrite the reply now in ${langName}, as the JSON described.`
      : `\n\nWrite the reply now in ${langName}, plain text only.`)

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 800,
        temperature: 0.5,
        system,
        messages: [{ role: 'user', content: userText }],
      }),
    })
    if (!res.ok) {
      const t = await res.text()
      throw new Error(`anthropic HTTP ${res.status}: ${t.slice(0, 200)}`)
    }
    const json = (await res.json()) as { content?: { type: string; text?: string }[] }
    const text = (json.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim()
    const answer = parseDraftAnswer(text, locale)
    if (!answer.text) throw new Error('empty completion')
    return { text: answer.text, englishText: answer.englishText, locale, tone, model: MODEL, usedAi: true }
  } catch (err) {
    logger.warn('[review-reply] AI draft failed, using fallback', {
      error: err instanceof Error ? err.message : String(err),
    })
    return fallbackDraft(locale, tone, productName, { signOff: voice.signOff, limit })
  }
}

/**
 * POST /reviews/:id/reply/draft and the Inbox bulk "Draft with AI": draft a reply and keep it as a DRAFT
 * ReviewResponse that waits for a person (nothing is posted). 'not_found' when the review is not in this business.
 */
export async function createReplyDraft(
  reviewId: string,
  input: { locale?: Locale; tone?: string; instructions?: string; actor?: string | null } = {},
): Promise<
  | { error: 'not_found' }
  | { response: Awaited<ReturnType<typeof prisma.reviewResponse.create>>; usedAi: boolean; tone: Tone; englishText: string | null }
> {
  const review = await prisma.review.findUnique({ where: { id: reviewId }, select: { id: true, channel: true } })
  if (!review) return { error: 'not_found' }
  const draft = await draftReviewReply({
    reviewId,
    locale: input.locale,
    tone: (input.tone as 'auto' | Tone) ?? 'auto',
    instructions: input.instructions,
  })
  const response = await prisma.reviewResponse.create({
    data: {
      reviewId,
      channel: review.channel,
      locale: draft.locale,
      body: draft.text,
      status: 'DRAFT',
      isAiDrafted: draft.usedAi,
      model: draft.model,
      ...(input.actor ? { createdBy: input.actor } : {}),
    },
  })
  return { response, usedAi: draft.usedAi, tone: draft.tone, englishText: draft.englishText }
}
