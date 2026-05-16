/**
 * SR.1 — Anthropic-powered review sentiment + category extraction.
 *
 * **First codebase use of Anthropic prompt caching.** The classifier
 * system prompt + Italian terminology glossary + category taxonomy
 * (combined ~2000 input tokens) are marked `cache_control: ephemeral`
 * so subsequent reviews within the 5-min cache window pay ~10% of the
 * input-token cost. At Xavia's review volume (≤200/day) this drops
 * sentiment-extraction cost from ~$0.50/day to ~$0.05/day.
 *
 * The model is Haiku by default (fast, cheap, strong-enough on
 * classification). Override per call via `model` option. Output is
 * strict JSON enforced via "Respond with ONLY JSON" instruction +
 * defensive parse.
 *
 * Sandbox-safe: when ANTHROPIC_API_KEY is not set, returns a rule-
 * based fallback so the loop still produces deterministic data for
 * verifier scripts.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

const ANTHROPIC_VERSION = '2023-06-01'
const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

// Closed category set. Match anything outside → 'OTHER'.
// FIT_SIZING and SAFETY are Xavia-relevant (motorcycle gear): mostly
// helmets/jackets/gloves where fit failure or PPE rating issues are
// the highest-stakes complaint themes.
const CATEGORIES = [
  'FIT_SIZING',
  'DURABILITY',
  'SHIPPING',
  'VALUE',
  'DESIGN',
  'QUALITY',
  'SAFETY',
  'COMFORT',
  'OTHER',
] as const
export type ReviewCategory = (typeof CATEGORIES)[number]

const LABELS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as const
export type SentimentLabel = (typeof LABELS)[number]

export interface ExtractInput {
  reviewId: string
  body: string
  title?: string | null
  rating?: number | null
  marketplace?: string | null
  /** Optional product context — productType + brand help classify edge
   *  cases (e.g. "non protegge" on a Casco is SAFETY, on a Giubbotto
   *  is generally COMFORT/QUALITY). */
  productType?: string | null
  brand?: string | null
}

export interface ExtractResult {
  reviewId: string
  label: SentimentLabel
  score: number // -1..1
  categories: ReviewCategory[]
  topPhrases: string[]
  model: string
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheWriteTokens: number
  costUSD: number
  rawText: string // for debugging
}

// ── Pricing (matches AiUsageLog rate card) ─────────────────────────────
// Haiku 4.5: $1/M input, $5/M output. Prompt-cache reads are 10% of
// input ($0.10/M), writes are 25% extra on first creation ($1.25/M).
function priceCents(args: {
  model: string
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheWriteTokens: number
}): number {
  const m = args.model.toLowerCase()
  const isOpus = m.includes('opus')
  const isSonnet = m.includes('sonnet')
  // Per-million-token rates in USD.
  const inputRate = isOpus ? 15.0 : isSonnet ? 3.0 : 1.0
  const outputRate = isOpus ? 75.0 : isSonnet ? 15.0 : 5.0
  const cacheHitRate = inputRate * 0.1 // 10% of base input rate
  const cacheWriteRate = inputRate * 1.25 // 25% premium
  const inputUSD = ((args.inputTokens - args.cacheHitTokens) * inputRate) / 1_000_000
  const cacheHitUSD = (args.cacheHitTokens * cacheHitRate) / 1_000_000
  const cacheWriteUSD = (args.cacheWriteTokens * cacheWriteRate) / 1_000_000
  const outputUSD = (args.outputTokens * outputRate) / 1_000_000
  return inputUSD + cacheHitUSD + cacheWriteUSD + outputUSD
}

// ── Prompt (cached) ────────────────────────────────────────────────────

const SYSTEM_PROMPT_CACHED = `You classify customer reviews for an Italian motorcycle-gear e-commerce platform (Xavia). Output STRICT JSON only.

Schema:
{
  "label": "POSITIVE" | "NEUTRAL" | "NEGATIVE",
  "score": number in [-1, 1] (rounded to 3 decimals),
  "categories": string[] (subset of FIT_SIZING, DURABILITY, SHIPPING, VALUE, DESIGN, QUALITY, SAFETY, COMFORT, OTHER),
  "topPhrases": string[] (1-3 verbatim quotes from the review, max 80 chars each, no paraphrasing)
}

Rules:
- "score" magnitude must roughly match the customer rating when present: 5 stars → ≥0.6, 1 star → ≤-0.6.
- "categories" may contain multiple themes when the review touches several (e.g. ["FIT_SIZING", "QUALITY"]). Empty array is invalid — pick OTHER if nothing else fits.
- "topPhrases" are EXACT verbatim quotes from the review body. NEVER paraphrase. Pick the most informative phrases. If review is <30 chars, return [review].
- Map Italian terminology:
  * casco / caschi → motorcycle helmet (SAFETY-critical category)
  * giacca / giubbotto → motorcycle jacket
  * pantaloni / cargo → motorcycle trousers
  * stivali → motorcycle boots
  * guanti → motorcycle gloves
  * pelle → leather (DURABILITY/QUALITY signal)
  * protezioni → armor inserts (SAFETY)
  * rete → mesh fabric (DESIGN/COMFORT for summer gear)
  * "non protegge" / "non aderente" on a casco → SAFETY (high severity)
  * "vestibilità" / "taglia piccola" / "taglia grande" → FIT_SIZING
  * "spedizione lenta" / "arrivato in ritardo" → SHIPPING
  * "consegna" / "imballaggio" → SHIPPING
  * "non vale il prezzo" / "troppo caro" → VALUE
  * "estetica" / "colore" → DESIGN
  * "cuciture" / "si è rotto" / "dopo poco" → DURABILITY
- Output JSON only. No markdown fences. No prose.`

// Italian motorcycle-gear terminology block — same content as
// Xavia's TerminologyPreference seed, frozen here so prompt-caching
// can hit it consistently. Update both when adding entries.
const TERMINOLOGY_BLOCK = `Italian terminology context (Xavia catalog):
- Giacca: motorcycle jacket (casual / city)
- Giubbotto: motorcycle jacket (sport / aggressive cut)
- Casco: motorcycle helmet (integrale = full-face, modulare = modular, jet = open-face)
- Stivali: motorcycle boots
- Pantaloni: motorcycle trousers
- Protezioni: CE armor (back / shoulder / elbow / knee)
- Pelle: leather (vacchetta = cow, capra = goat)
- Rete: mesh fabric (summer / ventilated gear)`

// ── Extraction ─────────────────────────────────────────────────────────

interface AnthropicCacheBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
  model: string
}

/**
 * Rule-based fallback when ANTHROPIC_API_KEY is missing — used by
 * verifier scripts + dev environments without LLM credentials. Not as
 * accurate as the model but deterministic + fast.
 */
function ruleBased(input: ExtractInput): ExtractResult {
  const text = `${input.title ?? ''} ${input.body}`.toLowerCase()
  let label: SentimentLabel = 'NEUTRAL'
  let score = 0
  if (input.rating != null) {
    if (input.rating >= 4) {
      label = 'POSITIVE'
      score = 0.7
    } else if (input.rating <= 2) {
      label = 'NEGATIVE'
      score = -0.7
    }
  }
  // Keyword overrides (rough — exists to keep the pipeline testable).
  const negativeWords = ['rotto', 'difetto', 'mai più', 'mai piu', 'pessimo', 'orribile', 'broken', 'terrible']
  const positiveWords = ['perfetto', 'ottimo', 'fantastico', 'great', 'love', 'amazing']
  if (negativeWords.some((w) => text.includes(w))) {
    label = 'NEGATIVE'
    score = Math.min(score, -0.7)
  } else if (positiveWords.some((w) => text.includes(w))) {
    label = 'POSITIVE'
    score = Math.max(score, 0.7)
  }
  const categories: ReviewCategory[] = []
  if (text.match(/tagli[ae]|vestibilit[aà]|fit\b|size/)) categories.push('FIT_SIZING')
  if (text.match(/cuciture|rotto|broken|durat|durab/)) categories.push('DURABILITY')
  if (text.match(/spediz|consegna|imballag|shipping|delivery/)) categories.push('SHIPPING')
  if (text.match(/prezzo|valore|caro|costoso|price|value/)) categories.push('VALUE')
  if (text.match(/colore|estetic|design|aspetto/)) categories.push('DESIGN')
  if (text.match(/qualit|materiale|finitur/)) categories.push('QUALITY')
  if (text.match(/protezion|sicur|safety|protect|aderent|non protegge/)) categories.push('SAFETY')
  if (text.match(/comod|comfort|sentir/)) categories.push('COMFORT')
  if (categories.length === 0) categories.push('OTHER')
  const topPhrases = [
    input.title?.slice(0, 80),
    input.body.slice(0, 80),
  ].filter((s): s is string => !!s && s.length > 0)
  return {
    reviewId: input.reviewId,
    label,
    score,
    categories,
    topPhrases: topPhrases.slice(0, 3),
    model: 'rule-based-fallback',
    inputTokens: 0,
    outputTokens: 0,
    cacheHitTokens: 0,
    cacheWriteTokens: 0,
    costUSD: 0,
    rawText: 'fallback (no ANTHROPIC_API_KEY)',
  }
}

function parseJson(text: string): {
  label?: string
  score?: number
  categories?: string[]
  topPhrases?: string[]
} | null {
  // Strip markdown fences just in case.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
  try {
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}

function clampScore(n: unknown): number {
  const v = typeof n === 'number' ? n : 0
  if (!Number.isFinite(v)) return 0
  return Math.max(-1, Math.min(1, Math.round(v * 1000) / 1000))
}

function normalizeLabel(s: unknown): SentimentLabel {
  if (typeof s !== 'string') return 'NEUTRAL'
  const up = s.toUpperCase()
  if (up === 'POSITIVE' || up === 'NEGATIVE' || up === 'NEUTRAL') return up
  return 'NEUTRAL'
}

function normalizeCategories(arr: unknown): ReviewCategory[] {
  if (!Array.isArray(arr)) return ['OTHER']
  const out: ReviewCategory[] = []
  for (const v of arr) {
    if (typeof v !== 'string') continue
    const up = v.toUpperCase()
    if ((CATEGORIES as readonly string[]).includes(up)) {
      out.push(up as ReviewCategory)
    }
  }
  return out.length > 0 ? Array.from(new Set(out)) : ['OTHER']
}

function normalizePhrases(arr: unknown): string[] {
  if (!Array.isArray(arr)) return []
  return arr
    .filter((v): v is string => typeof v === 'string')
    .map((s) => s.slice(0, 80).trim())
    .filter((s) => s.length > 0)
    .slice(0, 3)
}

export async function extractSentiment(input: ExtractInput): Promise<ExtractResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return ruleBased(input)
  }
  const model = process.env.NEXUS_REVIEW_SENTIMENT_MODEL ?? DEFAULT_MODEL
  // System prompt structured as cache blocks so Anthropic can reuse
  // them across calls within the 5-min ephemeral cache window.
  const systemBlocks: AnthropicCacheBlock[] = [
    { type: 'text', text: SYSTEM_PROMPT_CACHED, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: TERMINOLOGY_BLOCK, cache_control: { type: 'ephemeral' } },
  ]
  const userText = [
    `Marketplace: ${input.marketplace ?? 'IT'}`,
    input.productType ? `Product type: ${input.productType}` : null,
    input.brand ? `Brand: ${input.brand}` : null,
    input.rating != null ? `Customer rating: ${input.rating}/5` : null,
    '',
    input.title ? `Title: ${input.title}` : null,
    `Body: ${input.body}`,
    '',
    'Output JSON only.',
  ]
    .filter(Boolean)
    .join('\n')

  let response: AnthropicResponse
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        // Prompt-caching beta header — required pre-GA. Removing once
        // Anthropic ships GA caching by default on this model family.
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        temperature: 0.1, // deterministic classification
        system: systemBlocks,
        messages: [{ role: 'user', content: userText }],
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      logger.warn('[sentiment] Anthropic API error — falling back to rule-based', {
        status: res.status,
        body: body.slice(0, 200),
      })
      return ruleBased(input)
    }
    response = (await res.json()) as AnthropicResponse
  } catch (err) {
    logger.warn('[sentiment] fetch failed — falling back', {
      error: err instanceof Error ? err.message : String(err),
    })
    return ruleBased(input)
  }

  const rawText = (response.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
  const parsed = parseJson(rawText)
  if (!parsed) {
    logger.warn('[sentiment] JSON parse failed', { rawText: rawText.slice(0, 200) })
    return ruleBased(input)
  }

  const inputTokens = response.usage?.input_tokens ?? 0
  const outputTokens = response.usage?.output_tokens ?? 0
  const cacheHitTokens = response.usage?.cache_read_input_tokens ?? 0
  const cacheWriteTokens = response.usage?.cache_creation_input_tokens ?? 0
  const costUSD = priceCents({
    model: response.model ?? model,
    inputTokens: inputTokens + cacheHitTokens, // base + cache reads
    outputTokens,
    cacheHitTokens,
    cacheWriteTokens,
  })

  return {
    reviewId: input.reviewId,
    label: normalizeLabel(parsed.label),
    score: clampScore(parsed.score),
    categories: normalizeCategories(parsed.categories),
    topPhrases: normalizePhrases(parsed.topPhrases),
    model: response.model ?? model,
    inputTokens,
    outputTokens,
    cacheHitTokens,
    cacheWriteTokens,
    costUSD,
    rawText,
  }
}

/**
 * Persist a sentiment extraction result. Idempotent: re-running on a
 * reviewId updates the existing row in place (the model may have
 * improved). Also writes an AiUsageLog row for spend tracking.
 */
export async function persistSentiment(result: ExtractResult): Promise<void> {
  await prisma.reviewSentiment.upsert({
    where: { reviewId: result.reviewId },
    create: {
      reviewId: result.reviewId,
      label: result.label,
      score: result.score,
      categories: result.categories,
      topPhrases: result.topPhrases,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheHitTokens: result.cacheHitTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      costUSD: result.costUSD,
    },
    update: {
      label: result.label,
      score: result.score,
      categories: result.categories,
      topPhrases: result.topPhrases,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheHitTokens: result.cacheHitTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      costUSD: result.costUSD,
      extractedAt: new Date(),
    },
  })
  // Only log when we actually called the model (skip rule-based fallback
  // since costUSD=0 + model='rule-based-fallback' isn't real spend).
  if (result.model !== 'rule-based-fallback') {
    await prisma.aiUsageLog
      .create({
        data: {
          provider: 'anthropic',
          model: result.model,
          feature: 'review-sentiment',
          entityType: 'Review',
          entityId: result.reviewId,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUSD: result.costUSD,
        },
      })
      .catch(() => {
        /* AiUsageLog write must not fail the sentiment pipeline */
      })
  }
}
