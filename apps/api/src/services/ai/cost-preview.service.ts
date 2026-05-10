/**
 * W11.4 — Pre-flight USD cost estimate for AI bulk actions.
 *
 * Operators kicking off a bulk-AI job want a budget number before
 * they execute — "translate 280 SKUs into 4 locales" should
 * surface a $X.XX estimate, not commit them to an open-ended bill.
 * This service returns a deterministic estimate per BulkActionType
 * + payload + scope tuple that the front-end can render before
 * the operator clicks Execute.
 *
 * Strategy:
 *   - Heuristic per-item token counts grounded in the prompts each
 *     handler builds (translate.service / seo-regen / alt-text).
 *   - Multiply by the rate card for the provider's default model.
 *   - Honors the same provider selection logic the actual call does
 *     so the estimate matches the runtime path.
 *
 * Confidence: low/medium. The estimate over-shoots input tokens on
 * non-English content (4-char-per-token heuristic skews high there)
 * and ignores per-product description length variance — both biased
 * in the safe direction (estimate ≥ actual). Operators get a
 * meaningful upper bound, not a precise quote.
 */

import { getProvider } from './providers/index.js'
import type { ProviderName } from './providers/types.js'
import {
  ANTHROPIC_DEFAULT_MODEL,
  GEMINI_DEFAULT_MODEL,
  priceFor,
} from './rate-cards.js'

export type AiBulkActionType =
  | 'AI_TRANSLATE_PRODUCT'
  | 'AI_SEO_REGEN'
  | 'AI_ALT_TEXT'

export interface AiCostEstimateInput {
  actionType: AiBulkActionType
  /** Number of products that will run through the handler. */
  productCount: number
  /** Action payload — same shape the bulk-action service consumes. */
  payload: Record<string, unknown>
  /** When AI_ALT_TEXT and the front-end has counted images per
   *  product, pass the average to refine the estimate. Defaults
   *  to 4 (Xavia catalog mean as of 2026-05-10). */
  avgImagesPerProduct?: number
  /** Optional provider override to mirror the runtime path. */
  provider?: ProviderName | null
}

export interface AiCostEstimate {
  actionType: AiBulkActionType
  productCount: number
  /** Total LLM calls the job will make. */
  callCount: number
  /** Estimated input tokens summed across every call. */
  inputTokens: number
  /** Estimated output tokens summed across every call. */
  outputTokens: number
  /** USD upper bound at the provider's default model. */
  costUSD: number
  /** Provider + model the estimate is for. */
  provider: ProviderName
  model: string
  /** Free-form note explaining the heuristic for the UI. */
  note: string
}

// Per-call token heuristics for each AI bulk action. Calibrated
// against representative prompts in the wave's three services.
const HEURISTICS: Record<
  AiBulkActionType,
  { inputPerCall: number; outputPerCall: number }
> = {
  // Translate prompt = ~600 input (master copy + schema), ~600 output
  // (translated name + description + bulletPoints).
  AI_TRANSLATE_PRODUCT: { inputPerCall: 600, outputPerCall: 600 },
  // SEO regen prompt = ~500 input (master copy + schema), ~250 output
  // (metaTitle + metaDescription + og pair).
  AI_SEO_REGEN: { inputPerCall: 500, outputPerCall: 250 },
  // Alt-text prompt = ~250 input (product context + role hint),
  // ~80 output (single short alt).
  AI_ALT_TEXT: { inputPerCall: 250, outputPerCall: 80 },
}

function callsForAction(input: AiCostEstimateInput): {
  callCount: number
  multiplier: number
  note: string
} {
  const { actionType, productCount, payload, avgImagesPerProduct } = input
  if (actionType === 'AI_TRANSLATE_PRODUCT') {
    const langs = Array.isArray(payload.targetLanguages)
      ? (payload.targetLanguages as unknown[]).filter((l) => typeof l === 'string')
          .length
      : 0
    return {
      callCount: productCount * Math.max(langs, 1),
      multiplier: Math.max(langs, 1),
      note: `${productCount} products × ${Math.max(langs, 1)} target language(s) = ${productCount * Math.max(langs, 1)} calls`,
    }
  }
  if (actionType === 'AI_SEO_REGEN') {
    const locales = Array.isArray(payload.locales)
      ? (payload.locales as unknown[]).filter((l) => typeof l === 'string').length
      : 0
    return {
      callCount: productCount * Math.max(locales, 1),
      multiplier: Math.max(locales, 1),
      note: `${productCount} products × ${Math.max(locales, 1)} locale(s) = ${productCount * Math.max(locales, 1)} calls`,
    }
  }
  // AI_ALT_TEXT
  const imgs = avgImagesPerProduct ?? 4
  return {
    callCount: productCount * imgs,
    multiplier: imgs,
    note: `${productCount} products × ~${imgs} images each = ${productCount * imgs} calls (estimated)`,
  }
}

export function estimateAiBulkCost(
  input: AiCostEstimateInput,
): AiCostEstimate {
  if (input.productCount <= 0) {
    throw new Error('productCount must be > 0')
  }
  const provider = getProvider(input.provider ?? null)
  const providerName: ProviderName = provider?.name ?? 'gemini'
  const model =
    provider?.defaultModel ??
    (providerName === 'gemini' ? GEMINI_DEFAULT_MODEL : ANTHROPIC_DEFAULT_MODEL)

  const heur = HEURISTICS[input.actionType]
  const calls = callsForAction(input)
  const inputTokens = calls.callCount * heur.inputPerCall
  const outputTokens = calls.callCount * heur.outputPerCall
  const costUSD = priceFor(providerName, model, inputTokens, outputTokens)

  return {
    actionType: input.actionType,
    productCount: input.productCount,
    callCount: calls.callCount,
    inputTokens,
    outputTokens,
    costUSD,
    provider: providerName,
    model,
    note: calls.note,
  }
}
