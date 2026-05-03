/**
 * Step 3 — Product Type picker backing service.
 *
 * Three responsibilities:
 *   1. `listProductTypes` — return a search-filtered list of candidate
 *      productTypes for (channel, marketplace). Bundled fallback list
 *      is the floor; SP-API live results enrich when configured.
 *   2. `suggestProductTypes` — opt-in AI ranking via Gemini. Returns
 *      503 to caller when no GEMINI_API_KEY is set so the UI can
 *      degrade gracefully rather than blocking the picker.
 *   3. `prefetchSchema` — once selected, warm the CategorySchema cache
 *      for that productType so Step 4 loads instantly.
 *
 * Design intent (Rithum-style): the manual search picker is the
 * primary path. AI is decoration that helps when present, never
 * gatekeeps. The picker works end-to-end with neither SP-API nor
 * Gemini configured — the bundled list + the rule-based hint from
 * `Product.productType` is enough for a useful first guess.
 */

import { GoogleGenerativeAI } from '@google/generative-ai'
import type { PrismaClient } from '@nexus/database'
import { AmazonService } from '../marketplaces/amazon.service.js'
import { CategorySchemaService } from '../categories/schema-sync.service.js'
import { amazonMarketplaceId } from '../categories/marketplace-ids.js'
import {
  BUNDLED_AMAZON_PRODUCT_TYPES,
  findHintFromNexusProductType,
  type BundledProductType,
} from './product-types.constants.js'

export interface ProductTypeListItem {
  productType: string
  displayName: string
  /** TRUE when this row came from the bundled list rather than a live
   *  SP-API call. The UI can render a subtle "offline" badge if it
   *  cares; the wizard treats both sources interchangeably. */
  bundled: boolean
}

export interface SuggestionContext {
  productId: string
  name: string
  brand?: string | null
  productType?: string | null
  description?: string | null
}

export interface RankedSuggestion {
  productType: string
  displayName: string
  confidence: number // 0..1
  reason: string
}

export interface SuggestResult {
  suggestions: RankedSuggestion[]
  source: 'gemini' | 'rule-based'
  /** When true, the returned suggestions were derived without the
   *  Gemini API. The UI may want to offer "regenerate with AI" once
   *  the key is configured. */
  ruleBasedFallback: boolean
}

export class ProductTypesService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly amazon: AmazonService,
    private readonly schemas: CategorySchemaService,
  ) {}

  // ── 1. List ────────────────────────────────────────────────────

  async listProductTypes(opts: {
    channel: string
    marketplace: string | null
    search?: string
  }): Promise<ProductTypeListItem[]> {
    const channel = opts.channel.toUpperCase()
    if (channel !== 'AMAZON') {
      // For now only Amazon has a meaningful productType taxonomy in
      // this pipeline. Shopify/Woo skip Step 3 entirely; eBay is
      // blocked behind Phase 2A.
      return []
    }

    const search = opts.search?.trim().toLowerCase() ?? ''

    // Try the live SP-API search first when configured. It returns
    // marketplace-specific results and is keyword-aware, so it beats
    // the bundled list when available. If anything goes wrong (no
    // creds, network, throttle), fall back to the bundled list silently.
    const live = await this.fetchLiveAmazonProductTypes({
      marketplace: opts.marketplace,
      search,
    }).catch(() => null)

    if (live && live.length > 0) {
      return live
    }

    return this.searchBundled(search)
  }

  private async fetchLiveAmazonProductTypes(opts: {
    marketplace: string | null
    search: string
  }): Promise<ProductTypeListItem[] | null> {
    if (!this.amazon.isConfigured()) return null

    const sp = await (this.amazon as unknown as {
      getClient: () => Promise<{ callAPI: (req: unknown) => Promise<unknown> }>
    }).getClient()
    const marketplaceId = amazonMarketplaceId(opts.marketplace)

    const res = (await sp.callAPI({
      operation: 'searchDefinitionsProductTypes',
      endpoint: 'productTypeDefinitions',
      version: '2020-09-01',
      query: {
        marketplaceIds: [marketplaceId],
        ...(opts.search ? { keywords: [opts.search] } : {}),
      },
    })) as {
      productTypes?: Array<{ name?: string; displayName?: string }>
    }

    const rows = res?.productTypes ?? []
    if (!Array.isArray(rows)) return null
    return rows
      .filter((r) => typeof r?.name === 'string' && r.name.length > 0)
      .map((r) => ({
        productType: r.name as string,
        displayName: r.displayName ?? humanise(r.name as string),
        bundled: false,
      }))
  }

  private searchBundled(search: string): ProductTypeListItem[] {
    if (!search) {
      return BUNDLED_AMAZON_PRODUCT_TYPES.map((b) => toListItem(b))
    }
    return BUNDLED_AMAZON_PRODUCT_TYPES.filter((b) =>
      matchesSearch(b, search),
    ).map((b) => toListItem(b))
  }

  // ── 2. Suggest ─────────────────────────────────────────────────

  async suggestProductTypes(
    ctx: SuggestionContext,
    candidates: ProductTypeListItem[],
  ): Promise<SuggestResult> {
    if (candidates.length === 0) {
      return {
        suggestions: [],
        source: 'rule-based',
        ruleBasedFallback: true,
      }
    }

    // Always compute the rule-based hint first — it's deterministic,
    // free, and we'll either return it as-is (no API key) or merge it
    // with the AI ranking.
    const hint = findHintFromNexusProductType(ctx.productType)
    const ruleBased = ruleBasedSuggestions(ctx, candidates, hint)

    if (!process.env.GEMINI_API_KEY) {
      return {
        suggestions: ruleBased,
        source: 'rule-based',
        ruleBasedFallback: true,
      }
    }

    try {
      const ranked = await this.askGemini(ctx, candidates)
      // Boost the rule-based hint to the top if Gemini missed it but
      // it's a strong literal match — covers the case where the
      // master product is already tagged with a known type.
      const merged = mergeWithHint(ranked, ruleBased)
      return {
        suggestions: merged,
        source: 'gemini',
        ruleBasedFallback: false,
      }
    } catch {
      // Don't bubble the AI failure — degrade to rule-based silently.
      return {
        suggestions: ruleBased,
        source: 'rule-based',
        ruleBasedFallback: true,
      }
    }
  }

  private async askGemini(
    ctx: SuggestionContext,
    candidates: ProductTypeListItem[],
  ): Promise<RankedSuggestion[]> {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })

    const candidateLines = candidates
      .slice(0, 60) // keep prompt small even when SP-API returns the full list
      .map((c) => `- ${c.productType} — ${c.displayName}`)
      .join('\n')

    const prompt = `You rank Amazon productType identifiers by fit for a given product. Reply with strict JSON only.

Product:
- Name: ${ctx.name}
- Brand: ${ctx.brand ?? '(unknown)'}
- Internal type tag: ${ctx.productType ?? '(none)'}
- Description: ${(ctx.description ?? '').slice(0, 400)}

Candidate productTypes:
${candidateLines}

Return JSON in this exact shape:
{
  "ranked": [
    { "productType": "<one of the candidates>", "confidence": <0..1>, "reason": "<short, <120 chars>" }
  ]
}

Rank the top 5 best matches. If nothing fits well, return fewer entries with low confidence rather than padding. Do not invent productType values that aren't in the candidate list.`

    const res = await model.generateContent(prompt)
    const text = res.response.text()
    const parsed = parseGeminiResponse(text)
    if (!parsed) return []

    const candidateMap = new Map(
      candidates.map((c) => [c.productType, c.displayName] as const),
    )

    return parsed
      .filter((r) => candidateMap.has(r.productType))
      .map((r) => ({
        productType: r.productType,
        displayName: candidateMap.get(r.productType)!,
        confidence: clamp(r.confidence, 0, 1),
        reason: (r.reason ?? '').slice(0, 200),
      }))
      .slice(0, 5)
  }

  // ── 3. Prefetch ────────────────────────────────────────────────

  async prefetchSchema(opts: {
    channel: string
    marketplace: string
    productType: string
  }): Promise<{ ok: boolean; reason?: string }> {
    const channel = opts.channel.toUpperCase()
    if (channel !== 'AMAZON') {
      // Other channels don't have a CategorySchema pipeline yet.
      return { ok: false, reason: 'channel-not-supported' }
    }
    if (!this.amazon.isConfigured()) {
      return { ok: false, reason: 'sp-api-not-configured' }
    }
    try {
      await this.schemas.getSchema({
        channel: 'AMAZON',
        marketplace: opts.marketplace,
        productType: opts.productType,
      })
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────

function toListItem(b: BundledProductType): ProductTypeListItem {
  return {
    productType: b.productType,
    displayName: b.displayName,
    bundled: true,
  }
}

function matchesSearch(b: BundledProductType, search: string): boolean {
  if (b.productType.toLowerCase().includes(search)) return true
  if (b.displayName.toLowerCase().includes(search)) return true
  return b.keywords.some((k) => k.toLowerCase().includes(search))
}

function humanise(productType: string): string {
  return productType
    .toLowerCase()
    .split(/[_\s]+/)
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : ''))
    .join(' ')
}

function clamp(n: number, lo: number, hi: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return lo
  return Math.min(Math.max(n, lo), hi)
}

interface ParsedRanking {
  productType: string
  confidence: number
  reason?: string
}

function parseGeminiResponse(text: string): ParsedRanking[] | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    const obj = JSON.parse(cleaned) as { ranked?: ParsedRanking[] }
    if (!Array.isArray(obj?.ranked)) return null
    return obj.ranked
  } catch {
    return null
  }
}

function ruleBasedSuggestions(
  ctx: SuggestionContext,
  candidates: ProductTypeListItem[],
  hint: string | null,
): RankedSuggestion[] {
  const out: RankedSuggestion[] = []
  const candidateMap = new Map(
    candidates.map((c) => [c.productType, c] as const),
  )

  // 1. Direct hint match — strongest signal.
  if (hint && candidateMap.has(hint)) {
    const c = candidateMap.get(hint)!
    out.push({
      productType: c.productType,
      displayName: c.displayName,
      confidence: 0.85,
      reason: `Mapped from internal type "${ctx.productType}".`,
    })
  }

  // 2. Token-overlap from product name → keywords.
  const tokens = (ctx.name ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)

  const scored = candidates
    .filter((c) => c.productType !== hint)
    .map((c) => {
      const bundled = BUNDLED_AMAZON_PRODUCT_TYPES.find(
        (b) => b.productType === c.productType,
      )
      if (!bundled) return { c, score: 0 }
      let score = 0
      for (const t of tokens) {
        if (bundled.productType.toLowerCase().includes(t)) score += 2
        if (bundled.displayName.toLowerCase().includes(t)) score += 2
        for (const kw of bundled.keywords) {
          if (kw.toLowerCase() === t) score += 3
          else if (kw.toLowerCase().includes(t)) score += 1
        }
      }
      return { c, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)

  for (const { c, score } of scored) {
    out.push({
      productType: c.productType,
      displayName: c.displayName,
      // Rough mapping: capped so rule-based never claims higher
      // confidence than the deterministic hint.
      confidence: Math.min(0.7, 0.3 + score * 0.05),
      reason: `Matched product name keywords.`,
    })
  }

  return out
}

function mergeWithHint(
  ai: RankedSuggestion[],
  hints: RankedSuggestion[],
): RankedSuggestion[] {
  if (hints.length === 0) return ai
  // If the AI's top pick already matches the strongest hint,
  // nothing to do.
  const topHint = hints[0]
  if (!topHint) return ai
  if (ai.length > 0 && ai[0]?.productType === topHint.productType) return ai

  // If the hint isn't anywhere in the AI list, prepend it. Otherwise
  // leave the AI ranking — Gemini saw the candidate and chose to rank
  // it lower; trust that judgment.
  if (!ai.some((s) => s.productType === topHint.productType)) {
    return [topHint, ...ai].slice(0, 5)
  }
  return ai
}
