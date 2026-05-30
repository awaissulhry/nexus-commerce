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
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { renderBrandVoiceBlock } from '../ai/brand-voice.service.js'
import { resolveLocaleForMarketplace } from './sentiment-check-email.service.js'

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

export async function draftReviewReply(input: DraftReplyInput): Promise<DraftReplyResult> {
  const review = await prisma.review.findUnique({
    where: { id: input.reviewId },
    include: {
      sentiment: true,
      product: { select: { name: true, productType: true, brand: true } },
    },
  })
  if (!review) throw new Error('review not found')

  const locale: Locale = input.locale ?? (resolveLocaleForMarketplace(review.marketplace) as Locale)
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
  if (!apiKey) {
    return { text: fallbackReply(locale, tone, productName), locale, tone, model: 'fallback', usedAi: false }
  }

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
    (brandVoice ? `\n${brandVoice}` : '')

  const userText =
    `Review (rating ${review.rating ?? 'n/a'}/5)${review.title ? `, title: "${review.title}"` : ''}:\n` +
    `"${review.body}"\n` +
    `Product: ${productName ?? 'unknown'} (${review.product?.productType ?? 'product'})` +
    (input.instructions ? `\nExtra instruction from operator: ${input.instructions}` : '') +
    `\n\nWrite the reply now in ${langName}, plain text only.`

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
        max_tokens: 400,
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
    if (!text) throw new Error('empty completion')
    return { text, locale, tone, model: MODEL, usedAi: true }
  } catch (err) {
    logger.warn('[review-reply] AI draft failed, using fallback', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { text: fallbackReply(locale, tone, productName), locale, tone, model: 'fallback', usedAi: false }
  }
}
