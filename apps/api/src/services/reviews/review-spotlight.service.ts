/**
 * RX.4 — AI Review Spotlight (Voice-of-Customer brief).
 *
 * Synthesizes a window of reviews into an actionable brief: sentiment
 * mix, the top complaint + praise themes (with sample quotes), emerging
 * issues, and concrete recommendations (fix the sizing chart, clarify a
 * bullet, etc.). Persisted to ReviewSpotlight so the page reads a cached
 * brief instead of burning AI tokens on every load.
 *
 * Degrades to a heuristic brief (built from sentiment categories + top
 * phrases) when ANTHROPIC_API_KEY is absent or the call fails — so a
 * useful brief is always produced.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const MODEL = process.env.NEXUS_REVIEW_SPOTLIGHT_MODEL ?? 'claude-haiku-4-5-20251001'

const CATEGORY_LABEL: Record<string, string> = {
  FIT_SIZING: 'Fit / Sizing',
  DURABILITY: 'Durability',
  SHIPPING: 'Shipping',
  VALUE: 'Value',
  DESIGN: 'Design',
  QUALITY: 'Quality',
  SAFETY: 'Safety',
  COMFORT: 'Comfort',
  OTHER: 'Other',
}

const RECO_BY_CATEGORY: Record<string, { title: string; detail: string; area: string }> = {
  FIT_SIZING: {
    title: 'Clarify sizing',
    detail: 'Add or refine the size chart and call out fit (runs small/large) in the bullets and A+ content.',
    area: 'listing',
  },
  DURABILITY: {
    title: 'Address durability concerns',
    detail: 'Investigate the failing component with QA; consider a materials note and warranty messaging.',
    area: 'product',
  },
  SHIPPING: {
    title: 'Review packaging / carrier',
    detail: 'Shipping complaints recurring — check packaging robustness and carrier performance for the affected market.',
    area: 'ops',
  },
  QUALITY: {
    title: 'QA the build quality',
    detail: 'Pull the flagged units, check the supplier batch, and tighten incoming inspection.',
    area: 'product',
  },
  SAFETY: {
    title: 'Escalate safety signal',
    detail: 'Safety-related comments — review against GPSR/recall criteria for helmets and protective gear immediately.',
    area: 'product',
  },
  COMFORT: {
    title: 'Improve comfort messaging',
    detail: 'Set comfort expectations (break-in period, padding) in the listing and consider design tweaks.',
    area: 'content',
  },
  DESIGN: {
    title: 'Capture design feedback',
    detail: 'Feed recurring design notes to product development for the next revision.',
    area: 'product',
  },
  VALUE: {
    title: 'Reframe value',
    detail: 'Reinforce value (quality, certifications, included accessories) in bullets to justify price.',
    area: 'listing',
  },
}

export interface SpotlightContent {
  sentiment: { positive: number; neutral: number; negative: number; total: number; avgRating: number | null }
  complaints: { theme: string; count: number; severity: 'high' | 'medium' | 'low'; quotes: string[] }[]
  praises: { theme: string; count: number; quotes: string[] }[]
  emerging: { theme: string; note: string }[]
  recommendations: { title: string; detail: string; area: string; sku?: string }[]
}

export interface SpotlightOptions {
  productId?: string | null
  marketplace?: string | null
  windowDays?: number
}

async function gather(opts: SpotlightOptions) {
  const windowDays = opts.windowDays ?? 30
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
  const where: Record<string, unknown> = { postedAt: { gte: since } }
  if (opts.productId) where.productId = opts.productId
  if (opts.marketplace) where.marketplace = opts.marketplace
  const reviews = await prisma.review.findMany({
    where,
    orderBy: { postedAt: 'desc' },
    take: 150,
    include: {
      sentiment: { select: { label: true, categories: true, topPhrases: true } },
      product: { select: { sku: true, name: true } },
    },
  })
  return { windowDays, reviews }
}

function heuristicBrief(reviews: Awaited<ReturnType<typeof gather>>['reviews']): SpotlightContent {
  const counts = { positive: 0, neutral: 0, negative: 0 }
  const negCat: Record<string, { count: number; quotes: Set<string> }> = {}
  const posCat: Record<string, { count: number; quotes: Set<string> }> = {}
  let ratingSum = 0
  let ratingN = 0
  for (const r of reviews) {
    if (r.rating != null) {
      ratingSum += r.rating
      ratingN += 1
    }
    const s = r.sentiment
    if (!s) continue
    if (s.label === 'POSITIVE') counts.positive += 1
    else if (s.label === 'NEGATIVE') counts.negative += 1
    else counts.neutral += 1
    const bucket = s.label === 'NEGATIVE' ? negCat : s.label === 'POSITIVE' ? posCat : null
    if (bucket) {
      for (const c of s.categories) {
        const e = (bucket[c] ??= { count: 0, quotes: new Set() })
        e.count += 1
        for (const p of s.topPhrases.slice(0, 1)) if (e.quotes.size < 3) e.quotes.add(p)
      }
    }
  }
  const toList = (m: typeof negCat) =>
    Object.entries(m)
      .map(([cat, v]) => ({ cat, count: v.count, quotes: Array.from(v.quotes) }))
      .sort((a, b) => b.count - a.count)
  const complaints = toList(negCat)
    .slice(0, 5)
    .map((c) => ({
      theme: CATEGORY_LABEL[c.cat] ?? c.cat,
      count: c.count,
      severity: (c.count >= 5 ? 'high' : c.count >= 2 ? 'medium' : 'low') as 'high' | 'medium' | 'low',
      quotes: c.quotes,
    }))
  const praises = toList(posCat)
    .slice(0, 5)
    .map((c) => ({ theme: CATEGORY_LABEL[c.cat] ?? c.cat, count: c.count, quotes: c.quotes }))
  const recommendations = toList(negCat)
    .slice(0, 4)
    .map((c) => {
      const reco = RECO_BY_CATEGORY[c.cat]
      return reco
        ? { title: reco.title, detail: reco.detail, area: reco.area }
        : { title: `Address ${CATEGORY_LABEL[c.cat] ?? c.cat}`, detail: 'Recurring complaint theme — investigate.', area: 'product' }
    })
  return {
    sentiment: {
      positive: counts.positive,
      neutral: counts.neutral,
      negative: counts.negative,
      total: counts.positive + counts.neutral + counts.negative,
      avgRating: ratingN > 0 ? ratingSum / ratingN : null,
    },
    complaints,
    praises,
    emerging: [],
    recommendations,
  }
}

function stripJson(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
}

async function aiBrief(
  reviews: Awaited<ReturnType<typeof gather>>['reviews'],
  fallback: SpotlightContent,
): Promise<{ content: SpotlightContent; usedAi: boolean }> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey || reviews.length === 0) return { content: fallback, usedAi: false }

  const compact = reviews
    .slice(0, 120)
    .map((r) => {
      const label = r.sentiment?.label ?? 'NEUTRAL'
      const star = r.rating != null ? `${r.rating}★` : '—'
      return `[${star} ${label}] ${r.body.replace(/\s+/g, ' ').slice(0, 220)}`
    })
    .join('\n')

  const system =
    `You are a senior e-commerce CX analyst. Synthesize customer reviews into a JSON "Voice of the Customer" brief. ` +
    `Output ONLY valid JSON (no prose, no markdown) matching exactly this TypeScript type:\n` +
    `{ "complaints": {"theme": string, "count": number, "severity": "high"|"medium"|"low", "quotes": string[]}[],` +
    ` "praises": {"theme": string, "count": number, "quotes": string[]}[],` +
    ` "emerging": {"theme": string, "note": string}[],` +
    ` "recommendations": {"title": string, "detail": string, "area": "listing"|"product"|"ops"|"content"}[] }\n` +
    `Rules: ≤5 complaints, ≤5 praises, ≤3 emerging, ≤5 recommendations. Quotes are short verbatim snippets from the reviews (≤12 words), max 3 per theme. Recommendations must be concrete and actionable for the seller. Be specific to what customers actually said.`

  const userText = `Reviews (most recent first):\n${compact}\n\nProduce the JSON brief now.`

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
        max_tokens: 1500,
        temperature: 0.3,
        system,
        messages: [{ role: 'user', content: userText }],
      }),
    })
    if (!res.ok) throw new Error(`anthropic HTTP ${res.status}`)
    const json = (await res.json()) as { content?: { type: string; text?: string }[] }
    const text = (json.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    const parsed = JSON.parse(stripJson(text)) as Partial<SpotlightContent>
    return {
      content: {
        sentiment: fallback.sentiment, // counts are deterministic — keep ours
        complaints: parsed.complaints ?? fallback.complaints,
        praises: parsed.praises ?? fallback.praises,
        emerging: parsed.emerging ?? [],
        recommendations: parsed.recommendations ?? fallback.recommendations,
      },
      usedAi: true,
    }
  } catch (err) {
    logger.warn('[review-spotlight] AI brief failed, using heuristic', {
      error: err instanceof Error ? err.message : String(err),
    })
    return { content: fallback, usedAi: false }
  }
}

export async function generateSpotlight(opts: SpotlightOptions = {}) {
  const { windowDays, reviews } = await gather(opts)
  const fallback = heuristicBrief(reviews)
  const { content, usedAi } = await aiBrief(reviews, fallback)
  const headline =
    content.sentiment.total === 0
      ? 'No reviews in this window yet.'
      : content.complaints.length > 0
        ? `Top concern: ${content.complaints[0].theme} (${content.complaints[0].count})`
        : 'Sentiment is healthy — no dominant complaint theme.'
  const row = await prisma.reviewSpotlight.create({
    data: {
      productId: opts.productId ?? null,
      marketplace: opts.marketplace ?? null,
      windowDays,
      reviewCount: reviews.length,
      headline,
      content: content as unknown as object,
      model: usedAi ? MODEL : 'heuristic',
      usedAi,
    },
  })
  return row
}

export async function getLatestSpotlight(opts: SpotlightOptions = {}) {
  return prisma.reviewSpotlight.findFirst({
    where: {
      productId: opts.productId ?? null,
      marketplace: opts.marketplace ?? null,
    },
    orderBy: { generatedAt: 'desc' },
  })
}
