/**
 * W11.2 — Product SEO regeneration via the LLM provider.
 *
 * Generates ProductSeo.metaTitle / metaDescription / ogTitle /
 * ogDescription per locale from the master product copy. The
 * caller (bulk-action.service.ts AI_SEO_REGEN handler) upserts
 * the result into ProductSeo with @@unique(productId, locale).
 *
 * Distinct from translate.service.ts:
 *   - Translate preserves meaning and length.
 *   - SEO regen rewrites for SERP — 60-char meta title cap,
 *     160-char meta description cap, keyword-front-loaded.
 */

import { getProvider, isAiKillSwitchOn } from './providers/index.js'
import { logUsage } from './usage-logger.service.js'
import type { ProviderName } from './providers/types.js'

export interface SeoRegenInput {
  /** Master product copy that the prompt feeds the model. */
  source: {
    name: string
    description?: string | null
    bulletPoints?: string[] | null
    brand?: string | null
    productType?: string | null
    keywords?: string[] | null
  }
  /** BCP 47 locale, lowercase ('en', 'it', 'de-de', ...). */
  locale: string
  /** Optional provider override. */
  provider?: ProviderName | null
  /** AiUsageLog tag — defaults to 'bulk-seo-regen'. */
  feature?: string
  /** AiUsageLog entity binding. */
  productId?: string
}

export interface SeoRegenResult {
  locale: string
  metaTitle: string | null
  metaDescription: string | null
  ogTitle: string | null
  ogDescription: string | null
  source: 'ai-gemini' | 'ai-anthropic'
  sourceModel: string
  inputTokens: number
  outputTokens: number
  costUSD: number
}

const LOCALE_RE = /^[a-z]{2}(-[a-z0-9]{2,8})?$/

function buildPrompt(input: SeoRegenInput): string {
  const { source, locale } = input
  const lines: string[] = [
    `Generate SEO metadata for the following product, in ${locale}.`,
    `Output strict JSON only, no commentary, no markdown fences.`,
    `Schema: { "metaTitle": string, "metaDescription": string, "ogTitle"?: string, "ogDescription"?: string }`,
    ``,
    `Constraints:`,
    `- metaTitle: max 60 characters, brand + key benefit + product type.`,
    `- metaDescription: max 160 characters, action-oriented, includes primary keyword.`,
    `- ogTitle (optional): emotive variant for social shares; can exceed 60 chars.`,
    `- ogDescription (optional): conversational variant for social shares.`,
    `- Front-load keywords; avoid stuffing.`,
    `- Match the brand's voice; write naturally in ${locale}.`,
    ``,
    `Source product:`,
    `name: ${source.name}`,
  ]
  if (source.brand) lines.push(`brand: ${source.brand}`)
  if (source.productType) lines.push(`productType: ${source.productType}`)
  if (source.description) {
    lines.push(`description: ${source.description.slice(0, 600)}`)
  }
  if (Array.isArray(source.bulletPoints) && source.bulletPoints.length > 0) {
    lines.push(`bulletPoints:`)
    for (const b of source.bulletPoints.slice(0, 6)) lines.push(`- ${b}`)
  }
  if (Array.isArray(source.keywords) && source.keywords.length > 0) {
    lines.push(`keywords (must use, do not stuff): ${source.keywords.join(', ')}`)
  }
  return lines.join('\n')
}

function parseSeoJson(text: string): {
  metaTitle?: string
  metaDescription?: string
  ogTitle?: string
  ogDescription?: string
} {
  let candidate = text.trim()
  if (candidate.startsWith('```')) {
    candidate = candidate.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  }
  const firstBrace = candidate.indexOf('{')
  if (firstBrace > 0) candidate = candidate.slice(firstBrace)
  try {
    return JSON.parse(candidate)
  } catch (e) {
    throw new Error(
      `SEO response was not parseable JSON: ${e instanceof Error ? e.message : String(e)} — raw: ${text.slice(0, 200)}`,
    )
  }
}

/** Hard-clip a SERP-bound string. The prompt asks the model to
 *  honor the cap, but a defensive trim guarantees the row never
 *  hits ProductSeo with a Google-truncating value. */
function clip(s: string | undefined, max: number): string | null {
  if (typeof s !== 'string') return null
  const t = s.trim()
  if (t.length === 0) return null
  return t.length <= max ? t : t.slice(0, max).trimEnd()
}

export async function regenerateProductSeo(
  input: SeoRegenInput,
): Promise<SeoRegenResult> {
  if (!LOCALE_RE.test(input.locale)) {
    throw new Error(
      `locale must be BCP 47 lowercase (e.g. "en", "it", "de-de"); got "${input.locale}"`,
    )
  }
  if (!input.source.name || !input.source.name.trim()) {
    throw new Error('source.name is required')
  }
  if (isAiKillSwitchOn()) {
    throw new Error(
      'AI is temporarily disabled (NEXUS_AI_KILL_SWITCH is on). Contact an admin to re-enable.',
    )
  }
  const provider = getProvider(input.provider ?? null)
  if (!provider) {
    throw new Error(
      'No AI provider configured — set GEMINI_API_KEY or ANTHROPIC_API_KEY',
    )
  }

  const prompt = buildPrompt(input)
  const startedAt = Date.now()
  let result
  try {
    result = await provider.generate({
      prompt,
      jsonMode: true,
      maxOutputTokens: 1024,
      temperature: 0.4,
      feature: input.feature ?? 'bulk-seo-regen',
      entityType: input.productId ? 'Product' : undefined,
      entityId: input.productId,
    })
  } catch (err) {
    logUsage({
      provider: provider.name,
      model: provider.defaultModel,
      feature: input.feature ?? 'bulk-seo-regen',
      entityType: input.productId ? 'Product' : undefined,
      entityId: input.productId,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      latencyMs: Date.now() - startedAt,
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
  logUsage({
    provider: result.usage.provider,
    model: result.usage.model,
    feature: input.feature ?? 'bulk-seo-regen',
    entityType: input.productId ? 'Product' : undefined,
    entityId: input.productId,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUSD: result.usage.costUSD,
    latencyMs: Date.now() - startedAt,
    ok: true,
    metadata: { locale: input.locale },
  })

  const parsed = parseSeoJson(result.text)
  const sourceTag: 'ai-gemini' | 'ai-anthropic' =
    result.usage.provider === 'gemini' ? 'ai-gemini' : 'ai-anthropic'
  return {
    locale: input.locale,
    metaTitle: clip(parsed.metaTitle, 60),
    metaDescription: clip(parsed.metaDescription, 160),
    ogTitle: clip(parsed.ogTitle, 120),
    ogDescription: clip(parsed.ogDescription, 220),
    source: sourceTag,
    sourceModel: result.usage.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUSD: result.usage.costUSD,
  }
}
