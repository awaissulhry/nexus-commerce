/**
 * W11.3 — AI bulk alt-text generation.
 *
 * Generates accessibility-grade alt text for ProductImage rows.
 * v0 is text-only: the prompt receives the product's master copy
 * (name, brand, productType, image type/role) and asks the LLM
 * to write a concise descriptive alt. A v1 follow-up could send
 * the image URL to a vision-capable model, but the LLMProvider
 * abstraction we have today is text-only — and a context-aware
 * alt is already a major upgrade over the empty-string status
 * quo for ~95% of catalog images.
 *
 * Output is intentionally short (≤125 chars) — screen readers
 * truncate longer alt text and Google penalises "keyword-stuffed"
 * alt attributes. Hard-clipped defensively at write time.
 */

import { getProvider, isAiKillSwitchOn } from './providers/index.js'
import { logUsage } from './usage-logger.service.js'
import type { ProviderName } from './providers/types.js'

export interface AltTextInput {
  source: {
    name: string
    brand?: string | null
    productType?: string | null
    /** Free-form image role hint: 'MAIN' | 'ALT' | 'LIFESTYLE'
     *  | 'SWATCH' | 'DIAGRAM'. Drives the prompt's framing —
     *  lifestyle alt reads differently from a swatch alt. */
    imageType?: string | null
  }
  /** BCP 47 lowercase. Default 'en'. */
  locale?: string
  provider?: ProviderName | null
  feature?: string
  productId?: string
  /** Image record id for cost-per-image telemetry. */
  imageId?: string
}

export interface AltTextResult {
  alt: string | null
  source: 'ai-gemini' | 'ai-anthropic'
  sourceModel: string
  inputTokens: number
  outputTokens: number
  costUSD: number
}

const ALT_MAX_CHARS = 125

function buildPrompt(input: AltTextInput): string {
  const locale = (input.locale ?? 'en').toLowerCase()
  const role = (input.source.imageType ?? 'MAIN').toUpperCase()
  const lines: string[] = [
    `Generate a single accessibility-grade alt text in ${locale}.`,
    `Output strict JSON only, no commentary, no markdown fences.`,
    `Schema: { "alt": string }`,
    ``,
    `Constraints:`,
    `- Max ${ALT_MAX_CHARS} characters; aim for 80–110.`,
    `- Describe the product concretely (what it IS), not the marketing message.`,
    `- Lead with the product type, then 1–2 distinguishing details.`,
    `- No "image of" / "picture of" preambles — screen readers add that already.`,
    `- ${
      role === 'LIFESTYLE'
        ? 'For LIFESTYLE shots: include the scene context (rider on bike, model wearing it) before the product detail.'
        : role === 'SWATCH'
          ? 'For SWATCH shots: describe the colour / material visible.'
          : role === 'DIAGRAM'
            ? 'For DIAGRAM shots: name the labelled feature (e.g. "rear vent diagram").'
            : 'For MAIN/ALT product shots: clean product description.'
    }`,
    ``,
    `Source:`,
    `name: ${input.source.name}`,
  ]
  if (input.source.brand) lines.push(`brand: ${input.source.brand}`)
  if (input.source.productType) lines.push(`productType: ${input.source.productType}`)
  lines.push(`imageType: ${role}`)
  return lines.join('\n')
}

function parseAltJson(text: string): { alt?: string } {
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
      `Alt-text response was not parseable JSON: ${e instanceof Error ? e.message : String(e)} — raw: ${text.slice(0, 200)}`,
    )
  }
}

function clipAlt(s: string | undefined): string | null {
  if (typeof s !== 'string') return null
  const t = s.trim().replace(/\s+/g, ' ')
  if (!t) return null
  return t.length <= ALT_MAX_CHARS ? t : t.slice(0, ALT_MAX_CHARS).trimEnd()
}

export async function generateAltText(
  input: AltTextInput,
): Promise<AltTextResult> {
  if (!input.source.name?.trim()) {
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
      maxOutputTokens: 256,
      temperature: 0.3,
      feature: input.feature ?? 'bulk-alt-text',
      entityType: input.imageId ? 'ProductImage' : input.productId ? 'Product' : undefined,
      entityId: input.imageId ?? input.productId,
    })
  } catch (err) {
    logUsage({
      provider: provider.name,
      model: provider.defaultModel,
      feature: input.feature ?? 'bulk-alt-text',
      entityType: input.imageId ? 'ProductImage' : input.productId ? 'Product' : undefined,
      entityId: input.imageId ?? input.productId,
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
    feature: input.feature ?? 'bulk-alt-text',
    entityType: input.imageId ? 'ProductImage' : input.productId ? 'Product' : undefined,
    entityId: input.imageId ?? input.productId,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUSD: result.usage.costUSD,
    latencyMs: Date.now() - startedAt,
    ok: true,
    metadata: { locale: input.locale ?? 'en', imageType: input.source.imageType ?? null },
  })

  const parsed = parseAltJson(result.text)
  const sourceTag: 'ai-gemini' | 'ai-anthropic' =
    result.usage.provider === 'gemini' ? 'ai-gemini' : 'ai-anthropic'
  return {
    alt: clipAlt(parsed.alt),
    source: sourceTag,
    sourceModel: result.usage.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUSD: result.usage.costUSD,
  }
}
