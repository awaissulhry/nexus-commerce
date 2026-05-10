/**
 * Phase 5.5: Amazon-listing content generation.
 *
 * Single entry point — `generate({ product, marketplace, fields, variant })`.
 * Each requested field has its own prompt builder + JSON-shape contract;
 * we run the requested generators in parallel and return a partial
 * response keyed by field name. Temperature is bumped per `variant`
 * so repeated regenerations produce noticeably different output.
 *
 * H.7 — provider-agnostic. The service holds an LLMProvider (Gemini
 * by default; Anthropic + future providers via the registry) instead
 * of the Google SDK directly. Cost + token telemetry comes back per
 * call so the route can persist AiUsageLog rows.
 */

import prisma from '../../db.js'
import {
  checkBudget,
  estimateCallCostUSD,
  type BudgetCheckScope,
} from './budget.service.js'
import { getProvider, isAiKillSwitchOn } from './providers/index.js'
import {
  sanitizeOutboundPrompt,
  totalRedactions,
  type RedactionCount,
} from './prompt-sanitizer.js'
import {
  findActivePromptTemplate,
  renderPromptBody,
} from './prompt-template.service.js'
import { renderBrandVoiceBlock } from './brand-voice.service.js'
import type {
  LLMProvider,
  ProviderName,
  ProviderUsage,
} from './providers/types.js'

/**
 * AI-1.3 — thrown when AiBudgetService refuses an outgoing AI call
 * because one of the four spend horizons (per-call / per-wizard /
 * per-day / per-month) would be exceeded. Distinguishable from
 * generic Errors so the route can map it to a specific HTTP code
 * (402 Payment Required is the closest semantic match) and the UI
 * can surface a budget-specific banner.
 */
export class BudgetExceededError extends Error {
  readonly reason: 'per_call' | 'per_wizard' | 'per_day' | 'per_month'
  constructor(
    reason: 'per_call' | 'per_wizard' | 'per_day' | 'per_month',
    message: string,
  ) {
    super(message)
    this.name = 'BudgetExceededError'
    this.reason = reason
  }
}

const LANGUAGE_FOR_MARKETPLACE: Record<string, string> = {
  IT: 'Italian',
  DE: 'German',
  FR: 'French',
  ES: 'Spanish',
  UK: 'British English (use UK spellings — colour, organise, …)',
  US: 'American English',
  NL: 'Dutch',
  SE: 'Swedish',
  PL: 'Polish',
  CA: 'Canadian English',
  MX: 'Mexican Spanish',
}

export type ContentField = 'title' | 'bullets' | 'description' | 'keywords'

export interface ProductContext {
  id: string
  sku: string
  name: string
  brand: string | null
  description: string | null
  bulletPoints: string[]
  keywords: string[]
  weightValue: number | null
  weightUnit: string | null
  dimLength: number | null
  dimWidth: number | null
  dimHeight: number | null
  dimUnit: string | null
  productType: string | null
  variantAttributes: unknown
  categoryAttributes: unknown
}

export interface TerminologyEntry {
  preferred: string
  avoid: string[]
  context: string | null
}

export interface GenerationParams {
  product: ProductContext
  marketplace: string
  fields: ContentField[]
  /** 0–4. Higher values nudge temperature so regenerations yield
   *  visibly different copy. */
  variant?: number
  /** Per-brand / per-marketplace terminology to inject into every
   *  prompt. Fetched by the route from TerminologyPreference. */
  terminology?: TerminologyEntry[]
  /** H.7 — caller-chosen provider. Falls back to AI_PROVIDER env or
   *  the first configured provider. */
  provider?: string | null
  /** AI-1.3 — budget scope. When set, AiBudgetService is consulted
   *  before each underlying vendor call; the call is refused (with a
   *  BudgetExceededError) when one of the four spend horizons would
   *  be crossed. When unset, no budget check runs (legacy / dev). */
  budgetScope?: BudgetCheckScope
}

export interface TitleResult {
  content: string
  charCount: number
  insights: string[]
}

export interface BulletsResult {
  content: string[]
  charCounts: number[]
  insights: string[]
}

export interface DescriptionResult {
  content: string
  preview: string
  insights: string[]
}

export interface KeywordsResult {
  content: string
  charCount: number
  insights: string[]
}

// AI-4.3 — channel suggestion result. Returned by suggestChannels()
// for the Step 1 "AI: which channels should I publish to?" CTA.
export interface ChannelSuggestion {
  platform: string
  marketplace: string
  fit: 'high' | 'medium' | 'low'
  rank: number
  reason: string
}

// AI-4.7 — per-channel listing quality score returned by
// scoreListingQuality() for the Step 9 "AI: score this listing" CTA.
export interface QualityDimensionScore {
  /** Short tag, e.g. "title", "bullets", "images", "compliance". */
  name: string
  /** 0–100 score for this dimension. */
  score: number
  /** Single sentence — how to lift this dimension's score. Empty
   *  string when nothing to improve at this score. */
  hint: string
}
export interface ChannelQualityScore {
  platform: string
  marketplace: string
  /** 0–100. Composite score across the dimensions. */
  overallScore: number
  dimensions: QualityDimensionScore[]
}
export interface SuggestQualityScoreParams {
  product: ProductContext
  /** Per-channel payload snapshot. Caller passes a trimmed view
   *  (title, description, bullets, keywords, image count, price)
   *  rather than the full SP-API payload — keeps the prompt small
   *  and the cost predictable. */
  channels: Array<{
    platform: string
    marketplace: string
    title?: string | null
    description?: string | null
    bullets?: string[] | null
    keywords?: string | null
    imageCount?: number
    price?: number | null
    currency?: string | null
  }>
  budgetScope?: BudgetCheckScope
  provider?: string | null
}
export interface SuggestQualityScoreResult {
  perChannel: ChannelQualityScore[]
  /** Average overallScore across channels. */
  overallScore: number
  /** 3–5 sentences naming the highest-leverage fixes across the
   *  whole listing set. Cross-channel suggestions live here. */
  topImprovements: string[]
  usage: ProviderUsage
  redactions: RedactionCount[]
  redactionTotal: number
  metadata: {
    productSku: string
    model: string
    provider: ProviderName
    elapsedMs: number
    generatedAt: string
  }
}

// AI-4.6 — per-channel pricing recommendation returned by
// suggestPricing() for the Step 7 "AI: recommend prices" CTA.
export interface PricingRecommendation {
  platform: string
  marketplace: string
  recommendedPrice: number
  currency: string
  /** Recommended compare-at price (strikethrough on the listing).
   *  Optional; AI omits when no anchor pricing makes sense. */
  compareAtPrice?: number
  reasoning: string
  /** Margin estimate when cost is supplied. Null otherwise. */
  marginPercent: number | null
}
export interface SuggestPricingParams {
  product: ProductContext
  /** Per-channel context the AI uses to anchor recommendations. */
  channels: Array<{
    platform: string
    marketplace: string
    currency: string
    /** Operator's current price on this channel, if any. */
    currentPrice?: number | null
    /** Approximate referral / FBA fee fraction (0–1). */
    referralFee?: number | null
    fulfillmentFee?: number | null
  }>
  /** Master cost for margin math. Optional — when missing, AI
   *  omits margin numbers and reasons stay strategic only. */
  costPrice?: number | null
  /** Master price floor (MAP). When set, AI never recommends below. */
  minPrice?: number | null
  /** Operator's target margin as a fraction (0.30 = 30%). When set,
   *  AI optimises around it. */
  targetMargin?: number | null
  budgetScope?: BudgetCheckScope
  provider?: string | null
}
export interface SuggestPricingResult {
  recommendations: PricingRecommendation[]
  /** 1–3 sentence overall strategy summary for the operator. */
  strategy: string
  usage: ProviderUsage
  redactions: RedactionCount[]
  redactionTotal: number
  metadata: {
    productSku: string
    model: string
    provider: ProviderName
    elapsedMs: number
    generatedAt: string
  }
}

// AI-4.4 — variation theme recommendation. Returned by
// suggestVariationTheme() for the Step 4 "AI: pick the right theme"
// CTA.
export interface VariationThemeOption {
  id: string
  label: string
  requiredAttributes: string[]
}
export interface VariationThemeRecommendation {
  themeId: string
  reason: string
  alternatives: Array<{
    themeId: string
    reason: string
  }>
}

export interface SuggestVariationThemeParams {
  product: ProductContext
  /** Lowercased attribute keys present across the variation children
   *  (e.g. ["size", "color"]). Comes from VariationsPayload.
   *  presentAttributes — the client already has this loaded. */
  presentAttributes: string[]
  /** Themes available across the wizard's selected channels (the
   *  intersection / common-themes set works well here). Pass the full
   *  list so AI can rank — it'll only recommend from this set. */
  availableThemes: VariationThemeOption[]
  budgetScope?: BudgetCheckScope
  provider?: string | null
}

export interface SuggestVariationThemeResult {
  recommendation: VariationThemeRecommendation
  usage: ProviderUsage
  redactions: RedactionCount[]
  redactionTotal: number
  metadata: {
    productSku: string
    model: string
    provider: ProviderName
    elapsedMs: number
    generatedAt: string
  }
}

export interface SuggestChannelsParams {
  product: ProductContext
  availableChannels: Array<{ platform: string; marketplace: string }>
  /** AI-1.3 budget scope. Recommend always passing — channel
   *  suggestion is cheap (one call) but the per-day / per-month
   *  horizons still need the read so a bulk-suggest cron job (when
   *  it lands) doesn't burn the budget unsupervised. */
  budgetScope?: BudgetCheckScope
  provider?: string | null
}

export interface SuggestChannelsResult {
  recommendations: ChannelSuggestion[]
  usage: ProviderUsage
  redactions: RedactionCount[]
  redactionTotal: number
  metadata: {
    productSku: string
    model: string
    provider: ProviderName
    elapsedMs: number
    generatedAt: string
  }
}

export interface GenerationResult {
  title?: TitleResult
  bullets?: BulletsResult
  description?: DescriptionResult
  keywords?: KeywordsResult
  /** H.7 — per-field token + cost ledger. The route flushes these to
   *  AiUsageLog so the settings page can render 7-day rollups. */
  usage: ProviderUsage[]
  /** AI-1.3 — soft signal: spend on one of the budget horizons is
   *  ≥90% of the configured ceiling. Caller can render a "you've
   *  used 90% of today's budget" banner without blocking. Undefined
   *  when no budget scope was provided OR no horizon is in the warn
   *  zone. */
  budgetWarn?: 'per_wizard' | 'per_day' | 'per_month'
  /** AI-3.1 — per-kind tally of fiscal / personal-data redactions
   *  applied to every prompt before it left for the vendor. Empty
   *  array when prompts were clean. */
  redactions: RedactionCount[]
  /** AI-3.1 — convenience: redactions.reduce((s, r) => s + r.count, 0). */
  redactionTotal: number
  metadata: {
    productSku: string
    marketplace: string
    language: string
    model: string
    provider: ProviderName
    elapsedMs: number
    generatedAt: string
    /** BV.5 — short preview of the BrandVoice body that was injected
     *  into this generation, so the wizard can surface "Brand voice:
     *  Xavia formal" without a separate fetch. Empty string when no
     *  BrandVoice row matched. */
    brandVoicePreview?: string
  }
}

export class ListingContentService {
  isConfigured(): boolean {
    return getProvider() != null
  }

  /**
   * AI-4.2 — return a cost forecast for what generate() WOULD charge
   * without actually calling the vendor. Same per-field estimation
   * the AI-1.3 budget pre-check uses, exposed for the orchestrator's
   * pre-flight estimate endpoint so the operator can see "this will
   * cost ~$X" before clicking Confirm.
   *
   * Returns zero-cost rows when the kill switch is on or no provider
   * is configured — the estimator is read-only and never throws.
   * Token estimation skews over for non-English content (4 chars/
   * token heuristic), which is the safe direction for pre-flight
   * forecasting.
   */
  previewCost(params: GenerationParams): {
    estimatedCostUSD: number
    callCount: number
    provider: ProviderName | null
    model: string | null
    perField: Array<{ field: ContentField; estimatedCostUSD: number }>
  } {
    if (isAiKillSwitchOn()) {
      return {
        estimatedCostUSD: 0,
        callCount: 0,
        provider: null,
        model: null,
        perField: [],
      }
    }
    const provider = getProvider(params.provider)
    if (!provider) {
      return {
        estimatedCostUSD: 0,
        callCount: 0,
        provider: null,
        model: null,
        perField: [],
      }
    }
    const language =
      LANGUAGE_FOR_MARKETPLACE[params.marketplace.toUpperCase()] ?? 'English'
    let total = 0
    const perField: Array<{ field: ContentField; estimatedCostUSD: number }> = []
    for (const f of params.fields) {
      const prompt =
        f === 'title'
          ? this.titlePrompt(params, language)
          : f === 'bullets'
            ? this.bulletsPrompt(params, language)
            : f === 'description'
              ? this.descriptionPrompt(params, language)
              : this.keywordsPrompt(params, language)
      const cost = estimateCallCostUSD({
        prompt,
        maxOutputTokens: 4096,
        provider: provider.name,
        model: provider.defaultModel,
      })
      perField.push({ field: f, estimatedCostUSD: cost })
      total += cost
    }
    return {
      estimatedCostUSD: total,
      callCount: params.fields.length,
      provider: provider.name,
      model: provider.defaultModel,
      perField,
    }
  }

  async generate(params: GenerationParams): Promise<GenerationResult> {
    const language =
      LANGUAGE_FOR_MARKETPLACE[params.marketplace.toUpperCase()] ?? 'English'

    // AI-1.2 — distinguish kill-switch ON from no-credentials so the
    // wizard surfaces the right error to the operator. Both cases
    // result in `getProvider()` returning null, but the remediation
    // is opposite: kill switch is intentional, no-credentials means
    // someone forgot to set GEMINI_API_KEY / ANTHROPIC_API_KEY.
    if (isAiKillSwitchOn()) {
      throw new Error(
        'AI is temporarily disabled (NEXUS_AI_KILL_SWITCH is on). Contact an admin to re-enable.',
      )
    }
    const provider = getProvider(params.provider)
    if (!provider) {
      throw new Error(
        'No AI provider configured — set GEMINI_API_KEY or ANTHROPIC_API_KEY',
      )
    }

    // AI-2.3 — resolve every requested field's prompt body once,
    // up-front. Each lookup tries findActivePromptTemplate() first;
    // a hit renders the DB body with {marketplace} / {language} /
    // {contextBlock} / {terminologyBlock} substitutions, a miss
    // falls back to the inline static body. The resolved strings
    // feed both the AI-1.3 budget pre-check below and the runOne
    // task fan-out below — keeping a single resolved-prompts map
    // means we don't double-resolve (and don't surprise operators
    // with a budget estimate built from the inline body when the
    // actual call would use a DB-templated body).
    const resolvedPrompts: Partial<Record<ContentField, string>> = {}
    const promptFeatureMap: Record<ContentField, string> = {
      title: 'listing-wizard.title',
      bullets: 'listing-wizard.bullets',
      description: 'listing-wizard.description',
      keywords: 'listing-wizard.keywords',
    }
    // BV.2 — resolve the brand-voice block once for this generation
    // call (same scope across every requested field). renderBrand-
    // VoiceBlock returns "" when no row matched, so the prompt
    // renderer concats unconditionally without a guard.
    const brandVoiceBlock = await renderBrandVoiceBlock(prisma, {
      brand: params.product.brand,
      marketplace: params.marketplace,
      language: language.toLowerCase(),
    })
    const resolveOne = async (f: ContentField): Promise<string> => {
      const active = await findActivePromptTemplate(prisma, promptFeatureMap[f], {
        language: language.toLowerCase(),
        marketplace: params.marketplace,
        // AB.3 — same product → same variant across fields and
        // regenerations, so per-listing A/B observability stays
        // clean.
        stableSeed: params.product.id,
      })
      if (active) {
        return renderPromptBody(active.body, {
          marketplace: params.marketplace,
          language,
          contextBlock: this.contextBlock(params.product),
          terminologyBlock: this.terminologyBlock(params.terminology),
          brandVoiceBlock,
        })
      }
      // Fall back to the inline static body — what every wizard call
      // resolves to today since the AI-2.2 seed lands rows as DRAFT.
      if (f === 'title') return this.titlePrompt(params, language, brandVoiceBlock)
      if (f === 'bullets') return this.bulletsPrompt(params, language, brandVoiceBlock)
      if (f === 'description') return this.descriptionPrompt(params, language, brandVoiceBlock)
      return this.keywordsPrompt(params, language, brandVoiceBlock)
    }
    await Promise.all(
      params.fields.map(async (f) => {
        resolvedPrompts[f] = await resolveOne(f)
      }),
    )

    // AI-1.3 — pre-call budget check. Sum estimated cost across every
    // requested field, run a single AiBudgetService.checkBudget() with
    // the total. Single read instead of N (one per field) — the budget
    // service hits AiUsageLog three times per call, so a 4-field
    // generate would otherwise burn 12 DB reads for one user click.
    //
    // AI-2.3 — uses resolvedPrompts so the estimate matches whatever
    // body actually goes to the vendor (template vs inline).
    let budgetWarn: BudgetCheckScope extends never ? never : ('per_wizard' | 'per_day' | 'per_month' | undefined) =
      undefined as never
    if (params.budgetScope) {
      let totalEstimateUSD = 0
      for (const f of params.fields) {
        const prompt = resolvedPrompts[f] ?? ''
        totalEstimateUSD += estimateCallCostUSD({
          prompt,
          // Mirror the cap used in runOne — hardcoded 4096 in the
          // provider call. Update if the cap changes there.
          maxOutputTokens: 4096,
          provider: provider.name,
          model: provider.defaultModel,
        })
      }
      const verdict = await checkBudget(totalEstimateUSD, params.budgetScope)
      if (!verdict.allowed) {
        throw new BudgetExceededError(
          verdict.reason ?? 'per_call',
          verdict.message ??
            'AI call refused — budget ceiling reached. Adjust limits or wait for the window to roll over.',
        )
      }
      budgetWarn = (verdict.hitWarn ?? undefined) as never
    }

    const start = Date.now()

    const tasks: Array<Promise<{
      field: ContentField
      result: unknown
      usage: ProviderUsage
      redactions: RedactionCount[]
    }>> = []
    for (const f of params.fields) {
      if (f === 'title') {
        tasks.push(
          this.runOne(provider, resolvedPrompts.title ?? '', params.variant).then(
            (r) => ({
              field: 'title',
              result: this.parseTitle(r.text),
              usage: r.usage,
              redactions: r.redactions,
            }),
          ),
        )
      } else if (f === 'bullets') {
        tasks.push(
          this.runOne(
            provider,
            resolvedPrompts.bullets ?? '',
            params.variant,
            0.05,
          ).then((r) => ({
            field: 'bullets',
            result: this.parseBullets(r.text),
            usage: r.usage,
            redactions: r.redactions,
          })),
        )
      } else if (f === 'description') {
        tasks.push(
          this.runOne(
            provider,
            resolvedPrompts.description ?? '',
            params.variant,
          ).then((r) => ({
            field: 'description',
            result: this.parseDescription(r.text),
            usage: r.usage,
            redactions: r.redactions,
          })),
        )
      } else if (f === 'keywords') {
        tasks.push(
          this.runOne(
            provider,
            resolvedPrompts.keywords ?? '',
            params.variant,
          ).then((r) => ({
            field: 'keywords',
            result: this.parseKeywords(r.text),
            usage: r.usage,
            redactions: r.redactions,
          })),
        )
      }
    }

    const settled = await Promise.all(tasks)
    const usageList = settled.map((s) => s.usage)

    // AI-3.1 — sum redactions across every field's prompt. The route
    // logs this to AiUsageLog.metadata so audits can flag operators
    // / surfaces / products that consistently leak fiscal data into
    // AI prompts. Returned to the caller for UI surfacing too.
    const redactionTotals = new Map<string, number>()
    for (const s of settled) {
      for (const r of s.redactions) {
        redactionTotals.set(r.kind, (redactionTotals.get(r.kind) ?? 0) + r.count)
      }
    }
    const redactions: RedactionCount[] = Array.from(redactionTotals.entries()).map(
      ([kind, count]) => ({ kind: kind as RedactionCount['kind'], count }),
    )
    const redactionTotal = totalRedactions(redactions)

    // BV.5 — capture a short, operator-visible preview of the
    // BrandVoice body. The renderer prefixes "Brand voice:\n" so we
    // strip it for the UI chip. Cap at 120 chars so a verbose voice
    // body doesn't bloat the response.
    const trimmedVoice = brandVoiceBlock
      .replace(/^\s*\n+Brand voice:\s*\n*/, '')
      .trim()
    const brandVoicePreview =
      trimmedVoice.length > 120
        ? `${trimmedVoice.slice(0, 117)}…`
        : trimmedVoice

    const result: GenerationResult = {
      usage: usageList,
      budgetWarn: budgetWarn === undefined ? undefined : budgetWarn,
      redactions,
      redactionTotal,
      metadata: {
        productSku: params.product.sku,
        marketplace: params.marketplace,
        language,
        // Report whichever model the provider actually used for the
        // first generated field — every field shares a provider per
        // call, so this is unambiguous.
        model: usageList[0]?.model ?? provider.defaultModel,
        provider: provider.name,
        elapsedMs: Date.now() - start,
        generatedAt: new Date().toISOString(),
        brandVoicePreview,
      },
    }
    for (const { field, result: value } of settled) {
      ;(result as any)[field] = value
    }
    return result
  }

  /**
   * AI-4.3 — rank the operator's available channels by goodness-of-
   * fit for this product. The Step 1 "AI: suggest channels" CTA
   * calls this to pre-select the boxes for the operator before they
   * land on the multi-channel grid.
   *
   * Single AI call. Sanitisation + budget gate flow through the same
   * runOne path content generation uses, so kill-switch / fiscal
   * redaction / per-call ceiling all apply transitively.
   *
   * Returns recommendations sorted high-fit first. The route surfaces
   * the full list — including 'low' fit channels with an explanation
   * — so operators have the option to override the AI's call when
   * they have channel-specific knowledge it doesn't.
   */
  async suggestChannels(
    params: SuggestChannelsParams,
  ): Promise<SuggestChannelsResult> {
    if (isAiKillSwitchOn()) {
      throw new Error(
        'AI is temporarily disabled (NEXUS_AI_KILL_SWITCH is on). Contact an admin to re-enable.',
      )
    }
    const provider = getProvider(params.provider)
    if (!provider) {
      throw new Error(
        'No AI provider configured — set GEMINI_API_KEY or ANTHROPIC_API_KEY',
      )
    }

    const prompt = this.suggestChannelsPrompt(params)

    if (params.budgetScope) {
      const estimateUSD = estimateCallCostUSD({
        prompt,
        maxOutputTokens: 4096,
        provider: provider.name,
        model: provider.defaultModel,
      })
      const verdict = await checkBudget(estimateUSD, params.budgetScope)
      if (!verdict.allowed) {
        throw new BudgetExceededError(
          verdict.reason ?? 'per_call',
          verdict.message ??
            'Channel suggestion refused — budget ceiling reached.',
        )
      }
    }

    const start = Date.now()
    const { text, usage, redactions } = await this.runOne(provider, prompt, 0)
    const recommendations = this.parseChannelSuggestions(text, params.availableChannels)
    const redactionTotal = totalRedactions(redactions)

    return {
      recommendations,
      usage,
      redactions,
      redactionTotal,
      metadata: {
        productSku: params.product.sku,
        model: usage.model,
        provider: usage.provider,
        elapsedMs: Date.now() - start,
        generatedAt: new Date().toISOString(),
      },
    }
  }

  /**
   * AI-4.7 — score a wizard's prepared per-channel listings and
   * surface concrete improvements. Single AI call sees ALL channels
   * at once so cross-channel observations ("eBay title is generic
   * compared to your Amazon title") are possible.
   *
   * Returns 0–100 per-channel + a dimensions breakdown (title,
   * bullets, images, keywords, price-positioning, compliance) +
   * a topImprovements list with the highest-leverage fixes across
   * the whole listing set.
   *
   * Honours kill-switch + budget + sanitiser (no fiscal data leaves
   * the API in scoring prompts either).
   */
  async scoreListingQuality(
    params: SuggestQualityScoreParams,
  ): Promise<SuggestQualityScoreResult> {
    if (isAiKillSwitchOn()) {
      throw new Error(
        'AI is temporarily disabled (NEXUS_AI_KILL_SWITCH is on). Contact an admin to re-enable.',
      )
    }
    const provider = getProvider(params.provider)
    if (!provider) {
      throw new Error(
        'No AI provider configured — set GEMINI_API_KEY or ANTHROPIC_API_KEY',
      )
    }
    if (params.channels.length === 0) {
      throw new Error('No channels supplied — nothing to score.')
    }

    const prompt = this.scoreListingQualityPrompt(params)

    if (params.budgetScope) {
      const estimateUSD = estimateCallCostUSD({
        prompt,
        maxOutputTokens: 4096,
        provider: provider.name,
        model: provider.defaultModel,
      })
      const verdict = await checkBudget(estimateUSD, params.budgetScope)
      if (!verdict.allowed) {
        throw new BudgetExceededError(
          verdict.reason ?? 'per_call',
          verdict.message ??
            'Quality scoring refused — budget ceiling reached.',
        )
      }
    }

    const start = Date.now()
    const { text, usage, redactions } = await this.runOne(provider, prompt, 0)
    const parsed = this.parseQualityScores(text, params)
    const overallScore = parsed.perChannel.length > 0
      ? Math.round(
          parsed.perChannel.reduce((s, c) => s + c.overallScore, 0) /
            parsed.perChannel.length,
        )
      : 0
    const redactionTotal = totalRedactions(redactions)
    return {
      perChannel: parsed.perChannel,
      overallScore,
      topImprovements: parsed.topImprovements,
      usage,
      redactions,
      redactionTotal,
      metadata: {
        productSku: params.product.sku,
        model: usage.model,
        provider: usage.provider,
        elapsedMs: Date.now() - start,
        generatedAt: new Date().toISOString(),
      },
    }
  }

  private scoreListingQualityPrompt(params: SuggestQualityScoreParams): string {
    const channelsBlock = params.channels
      .map((c, i) => {
        const lines = [`Channel ${i + 1}: ${c.platform.toUpperCase()}:${c.marketplace.toUpperCase()}`]
        if (c.title) lines.push(`  title: ${truncate(c.title, 200)}`)
        if (c.description) lines.push(`  description (first 600c): ${truncate(c.description, 600)}`)
        if (Array.isArray(c.bullets) && c.bullets.length > 0) {
          lines.push(
            `  bullets: ${c.bullets
              .slice(0, 5)
              .map((b, j) => `(${j + 1}) ${truncate(b, 200)}`)
              .join(' ')}`,
          )
        }
        if (c.keywords) lines.push(`  keywords: ${truncate(c.keywords, 250)}`)
        if (typeof c.imageCount === 'number') lines.push(`  images: ${c.imageCount}`)
        if (typeof c.price === 'number') {
          lines.push(`  price: ${c.price.toFixed(2)} ${c.currency ?? ''}`.trim())
        }
        return lines.join('\n')
      })
      .join('\n\n')

    return `You are an Amazon / eBay / Shopify catalog quality auditor. Score each prepared listing on 0–100 and call out concrete improvements.

Product:
${this.contextBlock(params.product)}

Listings to score:
${channelsBlock}

Score each channel along these dimensions (each 0–100):
  - title: clarity, keyword density, brand prominence, length use
  - bullets: customer-benefit framing, specificity, length, no keyword stuffing
  - description: structure, persuasion, completeness
  - keywords: relevance, no title duplication, language mix where useful
  - images: presence + count vs platform expectations (Amazon prefers 7+, eBay 4+, Shopify any)
  - price: positioning vs platform norms (no competitor data — judge from product / brand context only)
  - compliance: visible signals like brand name, materials, intended use

Return JSON only — no markdown, no commentary, no surrounding text:
{
  "perChannel": [
    {
      "platform": "AMAZON",
      "marketplace": "IT",
      "overallScore": 78,
      "dimensions": [
        { "name": "title", "score": 85, "hint": "..." },
        { "name": "bullets", "score": 72, "hint": "..." },
        { "name": "description", "score": 80, "hint": "" },
        { "name": "keywords", "score": 70, "hint": "..." },
        { "name": "images", "score": 60, "hint": "..." },
        { "name": "price", "score": 80, "hint": "" },
        { "name": "compliance", "score": 90, "hint": "" }
      ]
    }
  ],
  "topImprovements": [
    "1–2 sentences naming the single highest-leverage fix across the whole listing set",
    "..."
  ]
}

Rules:
- Score honestly — most listings score 60–80. 90+ requires the listing genuinely is best-in-class.
- "hint" is empty when score ≥ 90 (nothing to fix). Otherwise 1 sentence — what to change.
- topImprovements: 3–5 entries, prioritised by impact. Cross-channel observations welcome.`
  }

  private parseQualityScores(
    raw: string,
    params: SuggestQualityScoreParams,
  ): {
    perChannel: ChannelQualityScore[]
    topImprovements: string[]
  } {
    const j = this.parseJson<{
      perChannel?: unknown
      topImprovements?: unknown
    }>(raw, 'quality-score')
    const allowed = new Set(
      params.channels.map(
        (c) => `${c.platform.toUpperCase()}:${c.marketplace.toUpperCase()}`,
      ),
    )
    const perChannel: ChannelQualityScore[] = []
    if (Array.isArray(j.perChannel)) {
      for (const c of j.perChannel) {
        if (!c || typeof c !== 'object') continue
        const ch = c as Record<string, unknown>
        const platform = typeof ch.platform === 'string'
          ? ch.platform.toUpperCase()
          : null
        const marketplace = typeof ch.marketplace === 'string'
          ? ch.marketplace.toUpperCase()
          : null
        if (!platform || !marketplace) continue
        if (!allowed.has(`${platform}:${marketplace}`)) continue
        const overallScore = clampScore(ch.overallScore)
        const dimensions: QualityDimensionScore[] = []
        if (Array.isArray(ch.dimensions)) {
          for (const d of ch.dimensions) {
            if (!d || typeof d !== 'object') continue
            const dim = d as Record<string, unknown>
            const name = typeof dim.name === 'string'
              ? dim.name.trim().slice(0, 40)
              : ''
            if (!name) continue
            dimensions.push({
              name,
              score: clampScore(dim.score),
              hint: typeof dim.hint === 'string'
                ? dim.hint.trim().slice(0, 300)
                : '',
            })
          }
        }
        perChannel.push({ platform, marketplace, overallScore, dimensions })
      }
    }
    const topImprovements: string[] = []
    if (Array.isArray(j.topImprovements)) {
      for (const t of j.topImprovements) {
        if (typeof t !== 'string') continue
        const trimmed = t.trim().slice(0, 400)
        if (trimmed.length === 0) continue
        topImprovements.push(trimmed)
        if (topImprovements.length >= 6) break
      }
    }
    return { perChannel, topImprovements }
  }

  /**
   * AI-4.6 — recommend per-channel prices for the wizard's Step 7
   * "AI: recommend prices" CTA. Single AI call per request.
   *
   * v1 is category-norm + brand-context driven — no competitor-data
   * lookups (which would need a separate scraping / API integration).
   * The reasoning is therefore strategic ("luxury brand → Amazon US
   * accepts 15% premium over master") rather than data-driven
   * ("undercut Buy Box by 2%"). Subsequent commits can fold in
   * BuyBoxOffers when that data path lands.
   *
   * Honours kill-switch + budget gate + outbound sanitiser. Margin
   * percent is only populated when cost is supplied; otherwise null.
   */
  async suggestPricing(
    params: SuggestPricingParams,
  ): Promise<SuggestPricingResult> {
    if (isAiKillSwitchOn()) {
      throw new Error(
        'AI is temporarily disabled (NEXUS_AI_KILL_SWITCH is on). Contact an admin to re-enable.',
      )
    }
    const provider = getProvider(params.provider)
    if (!provider) {
      throw new Error(
        'No AI provider configured — set GEMINI_API_KEY or ANTHROPIC_API_KEY',
      )
    }
    if (params.channels.length === 0) {
      throw new Error('No channels supplied — nothing to price.')
    }

    const prompt = this.suggestPricingPrompt(params)

    if (params.budgetScope) {
      const estimateUSD = estimateCallCostUSD({
        prompt,
        maxOutputTokens: 4096,
        provider: provider.name,
        model: provider.defaultModel,
      })
      const verdict = await checkBudget(estimateUSD, params.budgetScope)
      if (!verdict.allowed) {
        throw new BudgetExceededError(
          verdict.reason ?? 'per_call',
          verdict.message ??
            'Pricing suggestion refused — budget ceiling reached.',
        )
      }
    }

    const start = Date.now()
    const { text, usage, redactions } = await this.runOne(provider, prompt, 0)
    const parsed = this.parsePricingRecommendations(text, params)
    const redactionTotal = totalRedactions(redactions)
    return {
      recommendations: parsed.recommendations,
      strategy: parsed.strategy,
      usage,
      redactions,
      redactionTotal,
      metadata: {
        productSku: params.product.sku,
        model: usage.model,
        provider: usage.provider,
        elapsedMs: Date.now() - start,
        generatedAt: new Date().toISOString(),
      },
    }
  }

  private suggestPricingPrompt(params: SuggestPricingParams): string {
    const channelsList = params.channels
      .map((c) => {
        const fee = typeof c.referralFee === 'number'
          ? `${(c.referralFee * 100).toFixed(1)}% referral`
          : 'fee unknown'
        const fulfil = typeof c.fulfillmentFee === 'number'
          ? `${c.fulfillmentFee.toFixed(2)} ${c.currency} fulfilment`
          : 'no fulfilment fee'
        const current = typeof c.currentPrice === 'number'
          ? `current=${c.currentPrice.toFixed(2)} ${c.currency}`
          : 'no current price'
        return `- ${c.platform}:${c.marketplace} [${c.currency}] · ${current} · ${fee} · ${fulfil}`
      })
      .join('\n')
    const costLine = typeof params.costPrice === 'number'
      ? `Master cost: ${params.costPrice.toFixed(2)}`
      : 'Master cost: not supplied (omit margin numbers; reasoning stays strategic)'
    const floorLine = typeof params.minPrice === 'number'
      ? `Floor (MAP): never recommend below ${params.minPrice.toFixed(2)}`
      : 'Floor: none'
    const targetLine = typeof params.targetMargin === 'number'
      ? `Target margin: ${(params.targetMargin * 100).toFixed(0)}% (optimise around this where possible)`
      : 'Target margin: not supplied'

    return `You are an e-commerce pricing strategist. Recommend per-channel prices for this product across the operator's selected channels. v1 — no competitor-data lookups available; reason from category norms + brand context.

Product:
${this.contextBlock(params.product)}

${costLine}
${floorLine}
${targetLine}

Channels:
${channelsList}

Rules:
- Recommend in EACH channel's currency (don't re-quote everything in EUR).
- Account for the channel's fee structure when targeting margin.
- Higher prices on D2C (Shopify) are reasonable when brand storytelling is the value prop; marketplace channels (Amazon, eBay) usually need to be more competitive.
- compareAtPrice (strike-through anchor) is OPTIONAL — include only when it's a credible MSRP, not a fake markdown.
- 1–2 sentence reasoning per channel — specific to THIS product, not generic platform advice.

Return JSON only — no markdown, no commentary, no surrounding text:
{
  "strategy": "1–3 sentence overall strategy across the channels — why this product positions where it does",
  "recommendations": [
    {
      "platform": "AMAZON",
      "marketplace": "IT",
      "recommendedPrice": 99.00,
      "currency": "EUR",
      "compareAtPrice": 119.00,
      "reasoning": "1–2 sentences specific to this product on this channel"
    }
  ]
}

Return one entry per channel. Prices as numbers (not strings). Skip compareAtPrice when no anchor makes sense.`
  }

  private parsePricingRecommendations(
    raw: string,
    params: SuggestPricingParams,
  ): { recommendations: PricingRecommendation[]; strategy: string } {
    const j = this.parseJson<{
      strategy?: unknown
      recommendations?: unknown
    }>(raw, 'pricing')
    const strategy = typeof j.strategy === 'string'
      ? j.strategy.trim().slice(0, 600)
      : ''
    const allowed = new Set(
      params.channels.map(
        (c) => `${c.platform.toUpperCase()}:${c.marketplace.toUpperCase()}`,
      ),
    )
    const channelByKey = new Map(
      params.channels.map((c) => [
        `${c.platform.toUpperCase()}:${c.marketplace.toUpperCase()}`,
        c,
      ]),
    )
    const out: PricingRecommendation[] = []
    if (!Array.isArray(j.recommendations)) {
      return { recommendations: out, strategy }
    }
    for (const r of j.recommendations) {
      if (!r || typeof r !== 'object') continue
      const rec = r as Record<string, unknown>
      const platform = typeof rec.platform === 'string'
        ? rec.platform.toUpperCase()
        : null
      const marketplace = typeof rec.marketplace === 'string'
        ? rec.marketplace.toUpperCase()
        : null
      if (!platform || !marketplace) continue
      const channelKey = `${platform}:${marketplace}`
      if (!allowed.has(channelKey)) continue
      const channelCtx = channelByKey.get(channelKey)
      const recommendedPrice = typeof rec.recommendedPrice === 'number'
        && Number.isFinite(rec.recommendedPrice)
        && rec.recommendedPrice > 0
        ? rec.recommendedPrice
        : null
      if (recommendedPrice == null) continue
      // Honour the MAP floor server-side too, in case AI ignored it.
      if (
        typeof params.minPrice === 'number' &&
        recommendedPrice < params.minPrice
      ) {
        continue
      }
      const currency = typeof rec.currency === 'string'
        ? rec.currency.toUpperCase().slice(0, 4)
        : (channelCtx?.currency ?? 'USD')
      const compareAtPrice = typeof rec.compareAtPrice === 'number'
        && Number.isFinite(rec.compareAtPrice)
        && rec.compareAtPrice > recommendedPrice
        ? rec.compareAtPrice
        : undefined
      const reasoning = typeof rec.reasoning === 'string'
        ? rec.reasoning.trim().slice(0, 500)
        : ''
      // Margin = (price - cost - fees) / price × 100
      let marginPercent: number | null = null
      if (typeof params.costPrice === 'number' && params.costPrice > 0) {
        const referral = typeof channelCtx?.referralFee === 'number'
          ? channelCtx.referralFee * recommendedPrice
          : 0
        const fulfil = typeof channelCtx?.fulfillmentFee === 'number'
          ? channelCtx.fulfillmentFee
          : 0
        const net = recommendedPrice - params.costPrice - referral - fulfil
        marginPercent = (net / recommendedPrice) * 100
      }
      out.push({
        platform,
        marketplace,
        recommendedPrice,
        currency,
        compareAtPrice,
        reasoning,
        marginPercent,
      })
    }
    return { recommendations: out, strategy }
  }

  /**
   * AI-4.4 — recommend the best variation theme for a multi-variant
   * product given the wizard's available themes (channel
   * intersection) and the variation axes the children actually use.
   *
   * Single AI call. Same cost-safety stack as suggestChannels.
   *
   * Returns one primary recommendation + up to 3 alternatives. The
   * UI surfaces the primary as the suggested radio button and lists
   * alternatives so operators see the AI's reasoning across options.
   */
  async suggestVariationTheme(
    params: SuggestVariationThemeParams,
  ): Promise<SuggestVariationThemeResult> {
    if (isAiKillSwitchOn()) {
      throw new Error(
        'AI is temporarily disabled (NEXUS_AI_KILL_SWITCH is on). Contact an admin to re-enable.',
      )
    }
    const provider = getProvider(params.provider)
    if (!provider) {
      throw new Error(
        'No AI provider configured — set GEMINI_API_KEY or ANTHROPIC_API_KEY',
      )
    }
    if (params.availableThemes.length === 0) {
      throw new Error(
        'No themes available — Step 4 has nothing to choose from. Pick a product type in Step 2 first.',
      )
    }

    const prompt = this.suggestVariationThemePrompt(params)

    if (params.budgetScope) {
      const estimateUSD = estimateCallCostUSD({
        prompt,
        maxOutputTokens: 4096,
        provider: provider.name,
        model: provider.defaultModel,
      })
      const verdict = await checkBudget(estimateUSD, params.budgetScope)
      if (!verdict.allowed) {
        throw new BudgetExceededError(
          verdict.reason ?? 'per_call',
          verdict.message ??
            'Variation theme suggestion refused — budget ceiling reached.',
        )
      }
    }

    const start = Date.now()
    const { text, usage, redactions } = await this.runOne(provider, prompt, 0)
    const recommendation = this.parseVariationThemeRecommendation(
      text,
      params.availableThemes,
    )
    const redactionTotal = totalRedactions(redactions)
    return {
      recommendation,
      usage,
      redactions,
      redactionTotal,
      metadata: {
        productSku: params.product.sku,
        model: usage.model,
        provider: usage.provider,
        elapsedMs: Date.now() - start,
        generatedAt: new Date().toISOString(),
      },
    }
  }

  private suggestVariationThemePrompt(
    params: SuggestVariationThemeParams,
  ): string {
    const themesList = params.availableThemes
      .map(
        (t) =>
          `- id="${t.id}" label="${t.label}" requires=[${t.requiredAttributes
            .map((a) => `"${a}"`)
            .join(', ')}]`,
      )
      .join('\n')
    const presentList = params.presentAttributes
      .map((a) => `"${a}"`)
      .join(', ')
    return `You are an Amazon catalog specialist. Pick the best variation theme for this product given the children's actual variation axes.

Product:
${this.contextBlock(params.product)}

Variation axes used by children: [${presentList}]

Available themes (only choose from these — DO NOT invent new ones):
${themesList}

Rules:
- The picked theme's "requires" array MUST be a subset of the children's variation axes (otherwise children would fail Amazon's variation validation).
- Prefer the most specific theme that fits — e.g. if children use both size and color, "SizeColor" beats plain "Color" because it carries more information for buyers and lets Amazon render the right swatch grid.
- When two themes equally fit, prefer the one whose label is closer to the product's category convention.

Return JSON only — no markdown, no commentary, no surrounding text:
{
  "themeId": "...",
  "reason": "1–2 sentences explaining why this theme is the right pick for THIS product",
  "alternatives": [
    {
      "themeId": "...",
      "reason": "1 sentence — why this is also viable but not the top pick"
    }
  ]
}

Up to 3 alternatives. Empty array when no other theme is viable.`
  }

  private parseVariationThemeRecommendation(
    raw: string,
    available: VariationThemeOption[],
  ): VariationThemeRecommendation {
    const j = this.parseJson<{
      themeId?: unknown
      reason?: unknown
      alternatives?: unknown
    }>(raw, 'variation-theme')
    const allowed = new Set(available.map((t) => t.id))
    const themeId = typeof j.themeId === 'string' && allowed.has(j.themeId)
      ? j.themeId
      : (available[0]?.id ?? '')
    const reason = typeof j.reason === 'string'
      ? j.reason.trim().slice(0, 500)
      : ''
    const alternatives: VariationThemeRecommendation['alternatives'] = []
    if (Array.isArray(j.alternatives)) {
      for (const a of j.alternatives) {
        if (!a || typeof a !== 'object') continue
        const alt = a as Record<string, unknown>
        const altId = typeof alt.themeId === 'string' && allowed.has(alt.themeId)
          ? alt.themeId
          : null
        if (!altId) continue
        if (altId === themeId) continue // dedupe with primary
        const altReason = typeof alt.reason === 'string'
          ? alt.reason.trim().slice(0, 500)
          : ''
        alternatives.push({ themeId: altId, reason: altReason })
        if (alternatives.length >= 3) break
      }
    }
    return { themeId, reason, alternatives }
  }

  private suggestChannelsPrompt(params: SuggestChannelsParams): string {
    const channelsList = params.availableChannels
      .map((c) => `- ${c.platform.toUpperCase()}:${c.marketplace.toUpperCase()}`)
      .join('\n')
    return `You are an e-commerce strategist. Rank the operator's available channels by goodness-of-fit for this product. Consider the product category, brand strength in the destination marketplace, language overhead, and platform-specific strengths (Amazon for high-velocity searchable goods, eBay for niche / used / collector items, Shopify for D2C brand storytelling).

Product:
${this.contextBlock(params.product)}

Available channels (operator already has credentials):
${channelsList}

Return JSON only — no markdown, no commentary, no surrounding text:
{
  "recommendations": [
    {
      "platform": "AMAZON",
      "marketplace": "IT",
      "fit": "high",
      "rank": 1,
      "reason": "1–2 sentence explanation tying this product's traits to this channel's strengths"
    }
  ]
}

Rules for the response:
- Include EVERY channel from the available list, even low-fit ones (operators want to see the AI's call on every option, not just the top picks)
- "fit" is "high" | "medium" | "low" — be honest about the floor; if a brand is unknown in a marketplace, low is correct
- "rank" is 1..N starting at 1 for the best fit; ties allowed
- "reason" is 1–2 sentences in English, specific to THIS product (not generic platform marketing)
- DO NOT invent channels not in the available list`
  }

  private parseChannelSuggestions(
    raw: string,
    available: SuggestChannelsParams['availableChannels'],
  ): ChannelSuggestion[] {
    const j = this.parseJson<{ recommendations?: unknown }>(
      raw,
      'channel-suggestions',
    )
    const allowed = new Set(
      available.map((c) => `${c.platform.toUpperCase()}:${c.marketplace.toUpperCase()}`),
    )
    const out: ChannelSuggestion[] = []
    if (!Array.isArray(j.recommendations)) return out
    for (const r of j.recommendations) {
      if (!r || typeof r !== 'object') continue
      const rec = r as Record<string, unknown>
      const platform = typeof rec.platform === 'string'
        ? rec.platform.toUpperCase()
        : null
      const marketplace = typeof rec.marketplace === 'string'
        ? rec.marketplace.toUpperCase()
        : null
      if (!platform || !marketplace) continue
      // Drop AI hallucinations that name channels not in the
      // available list — operators shouldn't see suggestions they
      // can't act on.
      if (!allowed.has(`${platform}:${marketplace}`)) continue
      const fit = rec.fit === 'high' || rec.fit === 'medium' || rec.fit === 'low'
        ? rec.fit
        : 'medium'
      const rank = typeof rec.rank === 'number' && Number.isFinite(rec.rank)
        ? Math.max(1, Math.floor(rec.rank))
        : 99
      const reason = typeof rec.reason === 'string'
        ? rec.reason.trim().slice(0, 500)
        : ''
      out.push({ platform, marketplace, fit, rank, reason })
    }
    // Sort high-fit first, then by rank ascending for tie-breakers.
    const fitWeight: Record<ChannelSuggestion['fit'], number> = {
      high: 3,
      medium: 2,
      low: 1,
    }
    out.sort((a, b) => {
      const w = fitWeight[b.fit] - fitWeight[a.fit]
      if (w !== 0) return w
      return a.rank - b.rank
    })
    return out
  }

  // ── Prompt builders ────────────────────────────────────────────

  /**
   * P0 #27: brand terminology block. Returns a "STRICTLY FOLLOW"
   * preferences section if any preferences are configured, or an
   * empty string if none. Goes into every prompt before the JSON
   * return contract.
   */
  private terminologyBlock(entries: TerminologyEntry[] | undefined): string {
    if (!entries || entries.length === 0) return ''
    const lines = entries.map((e) => {
      const ctx = e.context ? ` (${e.context})` : ''
      if (!e.avoid || e.avoid.length === 0) {
        return `- Use "${e.preferred}"${ctx}.`
      }
      return `- Use "${e.preferred}" instead of: ${e.avoid
        .map((a) => `"${a}"`)
        .join(', ')}${ctx}.`
    })
    return `\n\nTerminology preferences (STRICTLY FOLLOW — do not substitute synonyms):\n${lines.join('\n')}`
  }

  private contextBlock(product: ProductContext): string {
    const lines: string[] = []
    lines.push(`- Name: ${product.name}`)
    if (product.brand) lines.push(`- Brand: ${product.brand}`)
    if (product.description) {
      lines.push(`- Existing description: ${truncate(product.description, 600)}`)
    }
    if (product.bulletPoints.length > 0) {
      lines.push(
        `- Existing bullets: ${product.bulletPoints
          .map((b, i) => `(${i + 1}) ${truncate(b, 200)}`)
          .join(' ')}`,
      )
    }
    if (product.keywords.length > 0) {
      lines.push(`- Existing keywords: ${product.keywords.join(', ')}`)
    }
    if (product.productType) {
      lines.push(`- Amazon product type: ${product.productType}`)
    }
    if (product.weightValue != null) {
      lines.push(
        `- Weight: ${product.weightValue} ${product.weightUnit ?? ''}`.trim(),
      )
    }
    if (
      product.dimLength != null ||
      product.dimWidth != null ||
      product.dimHeight != null
    ) {
      const dims = [product.dimLength, product.dimWidth, product.dimHeight]
        .map((v) => (v == null ? '?' : String(v)))
        .join('×')
      lines.push(`- Dimensions (L×W×H): ${dims} ${product.dimUnit ?? ''}`.trim())
    }
    if (product.categoryAttributes && typeof product.categoryAttributes === 'object') {
      const flat = flattenAttrs(product.categoryAttributes as Record<string, unknown>)
      if (flat) lines.push(`- Category attributes: ${flat}`)
    }
    if (product.variantAttributes && typeof product.variantAttributes === 'object') {
      const flat = flattenAttrs(product.variantAttributes as Record<string, unknown>)
      if (flat) lines.push(`- Variation: ${flat}`)
    }
    return lines.join('\n')
  }

  private titlePrompt(
    params: GenerationParams,
    language: string,
    brandVoiceBlock = '',
  ): string {
    return `You are an Amazon SEO expert. Generate ONE optimised product title for Amazon ${params.marketplace}.

Product:
${this.contextBlock(params.product)}

Requirements:
- HARD MAX 200 characters
- Brand name at the start
- Include product type, the primary benefit, and one or two key features
- Add variation details (size, colour, material) at the end if applicable
- Natural language — no keyword stuffing, no SHOUTING CAPS, no emojis
- Optimised for ${params.marketplace} customer search behaviour
- Write in ${language}${this.terminologyBlock(params.terminology)}${brandVoiceBlock}

Return JSON only — no markdown, no commentary, no surrounding text:
{
  "content": "the title",
  "charCount": <number — count UTF-16 code units, must match content.length>,
  "insights": [
    "Short bullet noting why this title works",
    "Another short bullet",
    "..."
  ]
}`
  }

  private bulletsPrompt(
    params: GenerationParams,
    language: string,
    brandVoiceBlock = '',
  ): string {
    return `You are an Amazon SEO expert. Generate exactly 5 bullet points for Amazon ${params.marketplace}.

Product:
${this.contextBlock(params.product)}

Per-bullet requirements:
- Length: 200–500 characters
- Start with [BENEFIT_HEADER] in ALL CAPS inside square brackets
- Then explain the benefit in natural language
- Active voice, customer-benefit focus (not feature dumps)
- Naturally include searchable keywords; no keyword stuffing
- No emojis, no excessive punctuation, no SHOUTING outside the header
- Write in ${language}${this.terminologyBlock(params.terminology)}${brandVoiceBlock}

Bullet themes (one per bullet, in this order):
1. Premium quality, protection, or safety
2. Comfort, fit, or wearability
3. Versatility or use cases
4. Materials or construction quality
5. Brand confidence, warranty, or buyer reassurance

Return JSON only:
{
  "content": ["bullet 1", "bullet 2", "bullet 3", "bullet 4", "bullet 5"],
  "charCounts": [n1, n2, n3, n4, n5],
  "insights": ["why these bullets work, 2–4 short notes"]
}`
  }

  private descriptionPrompt(
    params: GenerationParams,
    language: string,
    brandVoiceBlock = '',
  ): string {
    return `You are an Amazon listing copywriter. Generate the long product description as Amazon-safe HTML for marketplace ${params.marketplace}.

Product:
${this.contextBlock(params.product)}

Format:
- Sections in this order, each with its own <h3>:
  1. Brand story (2–3 sentences)
  2. Key features (use <ul><li>, 4–6 items)
  3. Specifications (a simple <ul><li> list of label: value pairs)
  4. Use cases (one paragraph)
  5. Care instructions (one short paragraph; omit if not applicable)

HTML constraints (Amazon's Listing API restrictions):
- ONLY these tags: <h3>, <p>, <ul>, <li>, <strong>, <em>, <br>
- No inline styles, no class attributes, no other tags
- No <html>, <head>, <body>, <div>
- Total length 1000–2500 characters of HTML
- Write in ${language}${this.terminologyBlock(params.terminology)}${brandVoiceBlock}

Return JSON only:
{
  "content": "<h3>...</h3><p>...</p>...",
  "preview": "first ~200 plain-text characters with all HTML stripped",
  "insights": ["why this description works, 2–4 short notes"]
}`
  }

  private keywordsPrompt(
    params: GenerationParams,
    language: string,
    brandVoiceBlock = '',
  ): string {
    return `Generate Amazon backend search terms for marketplace ${params.marketplace}.

Product:
${this.contextBlock(params.product)}

Hard requirements:
- HARD MAX 250 characters total
- Space-separated keywords
- NO commas, NO punctuation between terms, NO duplicate words
- Do NOT repeat words already in the product title (Amazon ignores those)
- Mix ${language} + English where it makes sense (catches both audiences)
- Include synonyms, common misspellings, and use-case phrases (e.g. "summer riding")
- Include compatible items where relevant (e.g. for jackets: "helmet pants gloves")${this.terminologyBlock(params.terminology)}${brandVoiceBlock}

Return JSON only:
{
  "content": "keyword1 keyword2 keyword3 ...",
  "charCount": <number — must equal content.length>,
  "insights": ["why these keywords work, 2–4 short notes"]
}`
  }

  // ── Run + parse ────────────────────────────────────────────────

  private async runOne(
    provider: LLMProvider,
    prompt: string,
    variant: number = 0,
    extraTemperatureBump: number = 0,
  ): Promise<{
    text: string
    usage: ProviderUsage
    redactions: RedactionCount[]
  }> {
    // Base 0.6 + variant bump; bullets get a slightly higher base so
    // repeats feel meaningfully different.
    const temperature = Math.min(
      1.0,
      0.6 + variant * 0.07 + extraTemperatureBump,
    )
    // AI-3.1 — sanitize before the vendor call. Anything matching a
    // fiscal / personal-data shape becomes a [REDACTED:KIND]
    // placeholder; the redactions count gets bubbled up to the
    // caller for telemetry. The vendor sees the sanitized prompt
    // only.
    const { sanitized, redactions } = sanitizeOutboundPrompt(prompt)
    const result = await provider.generate({
      prompt: sanitized,
      temperature,
      jsonMode: true,
    })
    return { ...result, redactions }
  }

  private parseJson<T>(raw: string, field: string): T {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim()
    try {
      return JSON.parse(cleaned) as T
    } catch (e: any) {
      throw new Error(
        `Gemini returned invalid JSON for ${field}: ${e?.message ?? String(e)}`,
      )
    }
  }

  private parseTitle(raw: string): TitleResult {
    const j = this.parseJson<{ content?: string; insights?: string[] }>(
      raw,
      'title',
    )
    const content = (j.content ?? '').trim()
    return {
      content,
      charCount: content.length,
      insights: Array.isArray(j.insights) ? j.insights.slice(0, 6) : [],
    }
  }

  private parseBullets(raw: string): BulletsResult {
    const j = this.parseJson<{ content?: string[]; insights?: string[] }>(
      raw,
      'bullets',
    )
    const content = Array.isArray(j.content)
      ? j.content.slice(0, 5).map((s) => String(s).trim())
      : []
    return {
      content,
      charCounts: content.map((s) => s.length),
      insights: Array.isArray(j.insights) ? j.insights.slice(0, 6) : [],
    }
  }

  private parseDescription(raw: string): DescriptionResult {
    const j = this.parseJson<{
      content?: string
      preview?: string
      insights?: string[]
    }>(raw, 'description')
    const content = (j.content ?? '').trim()
    const preview =
      j.preview ?? content.replace(/<[^>]+>/g, '').slice(0, 240).trim()
    return {
      content,
      preview,
      insights: Array.isArray(j.insights) ? j.insights.slice(0, 6) : [],
    }
  }

  private parseKeywords(raw: string): KeywordsResult {
    const j = this.parseJson<{ content?: string; insights?: string[] }>(
      raw,
      'keywords',
    )
    const content = (j.content ?? '').trim()
    return {
      content,
      charCount: content.length,
      insights: Array.isArray(j.insights) ? j.insights.slice(0, 6) : [],
    }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

// AI-4.7 — clamp a candidate score to the 0–100 range. Returns 0 for
// non-numeric / NaN / Infinity. Used by parseQualityScores to keep
// AI hallucinations (e.g. score=999) from poisoning the rollup.
function clampScore(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0
  if (raw < 0) return 0
  if (raw > 100) return 100
  return Math.round(raw)
}

function flattenAttrs(obj: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue
    if (typeof v === 'object') {
      const inner = flattenAttrs(v as Record<string, unknown>)
      if (inner) parts.push(`${k}{${inner}}`)
    } else {
      parts.push(`${k}=${String(v)}`)
    }
  }
  return parts.join(', ')
}
