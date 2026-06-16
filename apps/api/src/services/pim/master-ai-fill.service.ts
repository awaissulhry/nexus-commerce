/**
 * MA.5 — AI gap-fill for empty master attributes.
 *
 * After Import-from-Amazon (MA.3), some schema attributes are still empty.
 * This infers them from the product's title/description/known attributes in
 * ONE batched LLM call (reuses the budget-capped provider + parseAiJson from
 * BM.2). Select attributes are constrained to their allowedValues; low
 * confidence is dropped. Review-gated — the operator accepts before any write.
 */

import prisma from '../../db.js'
import {
  getProviderForFeature,
  resolveModelForFeature,
} from '../ai/model-resolver.service.js'
import { logUsage } from '../ai/usage-logger.service.js'
import { getMasterAttributeSchema, type MasterAttribute } from './master-schema.service.js'
import { parseAiJson } from './mapping-suggest-ai.service.js'

export interface AiFillSuggestion {
  key: string
  label: string
  value: string
  confidence: 'high' | 'medium'
  reason: string
}

function buildPrompt(ctx: {
  productType: string | null
  brand: string | null
  title: string
  description: string
  knownAttrs: string
  empty: MasterAttribute[]
}): string {
  const lines = ctx.empty.map((a) => {
    const opts = a.allowedValues && a.allowedValues.length > 0 ? ` (choose ONE of: ${a.allowedValues.join(' | ')})` : a.type === 'number' ? ' (number)' : ''
    return `- ${a.key} — ${a.label}${opts}`
  })
  return [
    `You enrich a product's master attributes for a PIM. Infer the value of each EMPTY attribute below from the product context. Only answer when the context clearly supports it — omit a field if you are unsure. Never invent certifications, measurements, or identifiers.`,
    ``,
    `Product type: ${ctx.productType ?? 'unknown'}`,
    ctx.brand ? `Brand: ${ctx.brand}` : '',
    ctx.title ? `Title: ${ctx.title}` : '',
    ctx.description ? `Description: ${ctx.description.slice(0, 1200)}` : '',
    ctx.knownAttrs ? `Known attributes: ${ctx.knownAttrs}` : '',
    ``,
    `Empty attributes to infer:`,
    ...lines,
    ``,
    `For attributes with an allowed-values list, the value MUST be exactly one of them. Return ONLY JSON: { "<key>": { "value": "<value>", "confidence": "high|medium|low", "reason": "<short>" }, ... }.`,
  ]
    .filter(Boolean)
    .join('\n')
}

export async function suggestMasterAttributes(productId: string): Promise<{ suggestions: AiFillSuggestion[]; aiUsed: boolean; reason?: string }> {
  const { attributes } = await getMasterAttributeSchema(productId)
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { name: true, description: true, brand: true, productType: true, categoryAttributes: true, localizedContent: true },
  })
  if (!product) throw new Error(`Product ${productId} not found`)

  const current = (product.categoryAttributes as Record<string, unknown> | null) ?? {}
  const empty = attributes.filter((a) => {
    const v = current[a.key]
    return v == null || v === ''
  })
  if (empty.length === 0) return { suggestions: [], aiUsed: false, reason: 'All schema attributes are already filled.' }

  const provider = await getProviderForFeature('pim-master-fill')
  if (!provider) return { suggestions: [], aiUsed: false, reason: 'AI unavailable (kill-switch on or no provider configured).' }

  const model = await resolveModelForFeature('pim-master-fill', provider)
  const lc = (product.localizedContent as Record<string, { title?: string; description?: string }> | null) ?? {}
  const title = lc.en?.title || lc.it?.title || product.name || ''
  const description = lc.en?.description || lc.it?.description || product.description || ''
  const knownAttrs = Object.entries(current)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('/') : String(v)}`)
    .join(', ')

  const prompt = buildPrompt({ productType: product.productType, brand: product.brand, title, description, knownAttrs, empty })

  const startedAt = Date.now()
  let raw: string
  try {
    const res = await provider.generate({ prompt, model, jsonMode: true, maxOutputTokens: 1536, temperature: 0.1, feature: 'pim-master-fill' })
    raw = res.text
    logUsage({
      provider: res.usage.provider,
      model: res.usage.model,
      feature: 'pim-master-fill',
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUSD: res.usage.costUSD,
      latencyMs: Date.now() - startedAt,
      ok: true,
      metadata: { productId, empty: empty.length },
    })
  } catch (err) {
    logUsage({
      provider: provider.name,
      model,
      feature: 'pim-master-fill',
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      latencyMs: Date.now() - startedAt,
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    })
    return { suggestions: [], aiUsed: false, reason: `AI call failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const parsed = parseAiJson(raw)
  const byKey = new Map(empty.map((a) => [a.key, a]))
  const suggestions: AiFillSuggestion[] = []
  for (const [key, v] of Object.entries(parsed)) {
    const attr = byKey.get(key)
    if (!attr) continue
    const obj = v as { value?: unknown; confidence?: unknown; reason?: unknown }
    const value = obj?.value
    if (value == null || value === '') continue
    // select attrs must answer with an allowed value
    if (attr.allowedValues && attr.allowedValues.length > 0 && !attr.allowedValues.includes(String(value))) continue
    if (obj.confidence === 'low') continue
    suggestions.push({
      key,
      label: attr.label,
      value: String(value),
      confidence: obj.confidence === 'high' ? 'high' : 'medium',
      reason: typeof obj.reason === 'string' ? obj.reason : 'AI inference',
    })
  }
  return { suggestions, aiUsed: true }
}
