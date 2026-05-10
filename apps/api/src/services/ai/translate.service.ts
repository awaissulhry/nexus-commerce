/**
 * W11.1 — Product copy translation via the LLM provider abstraction.
 *
 * Translates Product.name / description / bulletPoints into a target
 * language and returns a structured payload. Designed for the bulk-
 * translate action handler in bulk-action.service.ts; safe to call
 * from any other server context that has a single product in hand.
 *
 * Why a dedicated service vs reusing ListingContentService:
 * ListingContentService is the listing-wizard generator — it builds
 * marketplace-specific titles + bullets + descriptions FROM master
 * content. Translation is the inverse — keep the master content's
 * meaning, just render it in another locale, no marketplace
 * adaptation. Lighter prompt, cheaper call, cleaner responsibilities.
 */

import { getProvider, isAiKillSwitchOn } from './providers/index.js'
import { logUsage } from './usage-logger.service.js'
import type { ProviderName } from './providers/types.js'

export type TranslatableField = 'name' | 'description' | 'bulletPoints'

export interface TranslateInput {
  /** Source product copy. Empty / null fields are skipped. */
  source: {
    name?: string | null
    description?: string | null
    bulletPoints?: string[] | null
  }
  /** ISO 639-1 lower-case (it, de, fr, es, en, nl, sv, pl). */
  targetLanguage: string
  /** Subset of fields to translate. Defaults to all three. */
  fields?: TranslatableField[]
  /** Optional product context to keep brand voice consistent across
   *  the catalog. */
  brand?: string | null
  productType?: string | null
  /** Optional provider override; defaults to env-selected. */
  provider?: ProviderName | null
  /** AiUsageLog tag — defaults to 'bulk-translate'. */
  feature?: string
  /** AiUsageLog entity binding (productId here). */
  productId?: string
}

export interface TranslateResult {
  language: string
  name: string | null
  description: string | null
  bulletPoints: string[] | null
  /** Provider + model that produced the output. Stamped on
   *  ProductTranslation.source / sourceModel. */
  source: 'ai-gemini' | 'ai-anthropic'
  sourceModel: string
  inputTokens: number
  outputTokens: number
  costUSD: number
}

const ISO_639_1_RE = /^[a-z]{2}$/
const SUPPORTED_FIELDS: TranslatableField[] = ['name', 'description', 'bulletPoints']

function buildPrompt(input: TranslateInput, fields: TranslatableField[]): string {
  const lines: string[] = [
    `Translate the following product copy into ${input.targetLanguage}.`,
    `Keep the brand voice consistent. Preserve product-specific terms`,
    `(model names, sizes, motorcycle gear terminology) verbatim.`,
    `Return strict JSON only, no commentary, no markdown fences.`,
    `Schema: { "name"?: string, "description"?: string, "bulletPoints"?: string[] }`,
    `Only include keys for fields you actually translated.`,
    ``,
    input.brand ? `Brand: ${input.brand}` : '',
    input.productType ? `Product type: ${input.productType}` : '',
    ``,
    `Source (English unless otherwise tagged):`,
  ]
  if (fields.includes('name') && input.source.name) {
    lines.push(`name: ${input.source.name}`)
  }
  if (fields.includes('description') && input.source.description) {
    lines.push(`description: ${input.source.description}`)
  }
  if (
    fields.includes('bulletPoints') &&
    Array.isArray(input.source.bulletPoints) &&
    input.source.bulletPoints.length > 0
  ) {
    lines.push(`bulletPoints:`)
    for (const b of input.source.bulletPoints) lines.push(`- ${b}`)
  }
  return lines.filter((s) => s !== '').join('\n')
}

/**
 * Robust JSON extraction. Some providers wrap JSON in code fences
 * even when asked not to; we strip them and parse. Throws with the
 * raw text included so the caller can attach context to the error.
 */
function parseTranslationJson(text: string): {
  name?: string
  description?: string
  bulletPoints?: string[]
} {
  let candidate = text.trim()
  if (candidate.startsWith('```')) {
    candidate = candidate.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  }
  // If multiple JSON blocks come back, try the first balanced one.
  const firstBrace = candidate.indexOf('{')
  if (firstBrace > 0) candidate = candidate.slice(firstBrace)
  try {
    return JSON.parse(candidate)
  } catch (e) {
    throw new Error(
      `Translation response was not parseable JSON: ${e instanceof Error ? e.message : String(e)} — raw: ${text.slice(0, 200)}`,
    )
  }
}

export async function translateProductCopy(
  input: TranslateInput,
): Promise<TranslateResult> {
  if (!ISO_639_1_RE.test(input.targetLanguage)) {
    throw new Error(
      `targetLanguage must be ISO 639-1 lowercase (e.g. "it", "de"); got "${input.targetLanguage}"`,
    )
  }
  const fields = (input.fields ?? SUPPORTED_FIELDS).filter((f) =>
    SUPPORTED_FIELDS.includes(f),
  )
  if (fields.length === 0) {
    throw new Error('translateProductCopy: at least one field must be requested')
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

  const prompt = buildPrompt(input, fields)
  const startedAt = Date.now()
  let result
  try {
    result = await provider.generate({
      prompt,
      jsonMode: true,
      maxOutputTokens: 4096,
      temperature: 0.2,
      feature: input.feature ?? 'bulk-translate',
      entityType: input.productId ? 'Product' : undefined,
      entityId: input.productId,
    })
  } catch (err) {
    logUsage({
      provider: provider.name,
      model: provider.defaultModel,
      feature: input.feature ?? 'bulk-translate',
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
    feature: input.feature ?? 'bulk-translate',
    entityType: input.productId ? 'Product' : undefined,
    entityId: input.productId,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUSD: result.usage.costUSD,
    latencyMs: Date.now() - startedAt,
    ok: true,
    metadata: { targetLanguage: input.targetLanguage, fields },
  })

  const parsed = parseTranslationJson(result.text)
  const sourceTag: 'ai-gemini' | 'ai-anthropic' =
    result.usage.provider === 'gemini' ? 'ai-gemini' : 'ai-anthropic'
  return {
    language: input.targetLanguage,
    name: typeof parsed.name === 'string' ? parsed.name.trim() : null,
    description:
      typeof parsed.description === 'string' ? parsed.description.trim() : null,
    bulletPoints: Array.isArray(parsed.bulletPoints)
      ? parsed.bulletPoints
          .filter((b): b is string => typeof b === 'string')
          .map((b) => b.trim())
          .filter(Boolean)
      : null,
    source: sourceTag,
    sourceModel: result.usage.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUSD: result.usage.costUSD,
  }
}
