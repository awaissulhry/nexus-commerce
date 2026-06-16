/**
 * BM.2 — AI mapping for the long tail.
 *
 * The free FM.13 heuristic (suggestSourceForField) maps the name-matchable
 * majority. This handles the REST — fields whose names don't match an alias —
 * with one batched LLM call that maps each fieldKey+label to the best master
 * attribute (constrained to a known catalog so it can't hallucinate sources).
 * Heuristic-first + AI-opt-in: callers run the heuristic, then offer this as
 * an "enhance" pass. Budget + kill-switch are enforced by the AI provider
 * (getProvider returns null when the kill-switch is on). Review-gated — the
 * caller still confirms before any rule is written (BM.1 bulk-apply).
 */

import prisma from '../../db.js'
import {
  getProviderForFeature,
  resolveModelForFeature,
} from '../ai/model-resolver.service.js'
import { logUsage } from '../ai/usage-logger.service.js'
import { getResolvedRules } from './schema-mapping.service.js'
import { suggestSourceForField, type MappingSuggestion, type SuggestConfidence } from './mapping-suggest.service.js'

// The master attributes the AI is allowed to map to. Mirrors the heuristic's
// canonical sources; product-specific attributes use categoryAttributes.<x>.
const MASTER_ATTRIBUTES = [
  'title',
  'description',
  'brand',
  'manufacturer',
  'our_price',
  'bulletPoints',
  'keywords',
  'ean',
  'upc',
  'gtin',
  'categoryAttributes.material',
  'categoryAttributes.color',
  'categoryAttributes.size',
]

export function isValidSource(s: unknown): s is string {
  return typeof s === 'string' && (MASTER_ATTRIBUTES.includes(s) || /^categoryAttributes\.[a-z0-9_]+$/i.test(s))
}

function buildPrompt(channel: string, fields: Array<{ fieldKey: string; label: string | null }>): string {
  return [
    `You map ${channel} marketplace listing fields to master product attributes for a PIM.`,
    `For each channel field below, choose the SINGLE best master attribute it should read its value from, or use null if none fits.`,
    `Allowed master attributes: ${MASTER_ATTRIBUTES.join(', ')}.`,
    `For any other product attribute, use "categoryAttributes.<snake_case_name>" (e.g. categoryAttributes.sleeve_type, categoryAttributes.waterproof_rating).`,
    `Return ONLY JSON of the form: { "<fieldKey>": { "source": "<attribute or null>", "confidence": "high|medium|low", "reason": "<short>" }, ... }.`,
    `Omit a field if you have no good guess.`,
    ``,
    `Channel fields (key — label):`,
    ...fields.map((f) => `- ${f.fieldKey}${f.label ? ` — ${f.label}` : ''}`),
  ].join('\n')
}

export function parseAiJson(raw: string): Record<string, unknown> {
  let s = raw.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) s = s.slice(start, end + 1)
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    return {}
  }
}

export interface AiSuggestResult {
  suggestions: MappingSuggestion[]
  aiUsed: boolean
  reason?: string
  scanned: number
}

export async function suggestMappingsAI(input: {
  channel: string
  code: string
  productType?: string | null
}): Promise<AiSuggestResult> {
  const rules = await getResolvedRules(input.channel, input.code, input.productType ?? undefined)
  const fields = await prisma.channelSchema.findMany({
    where: { channel: input.channel, OR: [{ marketplace: input.code }, { marketplace: null }] },
    orderBy: { fieldKey: 'asc' },
    select: { fieldKey: true, label: true },
  })
  // The long tail: unmapped AND the heuristic couldn't match it.
  const tail = fields.filter((f) => !rules[f.fieldKey] && !suggestSourceForField(f.fieldKey, f.label))
  if (tail.length === 0) {
    return { suggestions: [], aiUsed: false, reason: 'No long-tail fields — the heuristic covered everything.', scanned: 0 }
  }

  const provider = await getProviderForFeature('pim-mapping-suggest')
  if (!provider) {
    return { suggestions: [], aiUsed: false, reason: 'AI unavailable (kill-switch on or no provider configured).', scanned: tail.length }
  }

  const model = await resolveModelForFeature('pim-mapping-suggest', provider)
  const batch = tail.slice(0, 120) // one cheap call
  const startedAt = Date.now()
  let raw: string
  try {
    const res = await provider.generate({
      prompt: buildPrompt(input.channel, batch),
      model,
      jsonMode: true,
      maxOutputTokens: 2048,
      temperature: 0.1,
      feature: 'pim-map-suggest',
    })
    raw = res.text
    logUsage({
      provider: res.usage.provider,
      model: res.usage.model,
      feature: 'pim-map-suggest',
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUSD: res.usage.costUSD,
      latencyMs: Date.now() - startedAt,
      ok: true,
      metadata: { channel: input.channel, code: input.code, productType: input.productType ?? null, fields: batch.length },
    })
  } catch (err) {
    logUsage({
      provider: provider.name,
      model,
      feature: 'pim-map-suggest',
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      latencyMs: Date.now() - startedAt,
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    })
    return { suggestions: [], aiUsed: false, reason: `AI call failed: ${err instanceof Error ? err.message : String(err)}`, scanned: batch.length }
  }

  const parsed = parseAiJson(raw)
  const labelByKey = new Map(batch.map((f) => [f.fieldKey, f.label]))
  const suggestions: MappingSuggestion[] = []
  for (const [fieldKey, v] of Object.entries(parsed)) {
    if (!labelByKey.has(fieldKey)) continue
    const obj = v as { source?: unknown; confidence?: unknown; reason?: unknown }
    if (!isValidSource(obj?.source)) continue
    if (obj.confidence === 'low') continue // drop low-confidence AI guesses
    suggestions.push({
      fieldKey,
      label: labelByKey.get(fieldKey) ?? null,
      suggestedSource: obj.source,
      confidence: (obj.confidence === 'high' ? 'high' : 'medium') as SuggestConfidence,
      reason: typeof obj.reason === 'string' ? `AI: ${obj.reason}` : 'AI suggestion',
    })
  }
  return { suggestions, aiUsed: true, scanned: batch.length }
}
