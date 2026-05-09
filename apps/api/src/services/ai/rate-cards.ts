/**
 * AI-1.3 — provider rate cards extracted to a shared module.
 *
 * Previously each provider held its own RATE_CARD constant inline. The
 * budget service (apps/api/src/services/ai/budget.service.ts) needs to
 * estimate cost BEFORE the call lands, which means it has to know the
 * rate card for the model the caller is about to use. Inlining a copy
 * would risk drift the moment a vendor changes a rate; the shared
 * module is the single place to update pricing.
 *
 * Rates are USD per 1M tokens. Update when vendors revise pricing —
 * AiUsageLog.cost is committed at write time and never recomputed, so
 * historical rows reflect what was charged at the time they ran.
 *
 * Date-suffix tolerance: Anthropic ships dated model strings (e.g.
 * "claude-haiku-4-5-20251001"). The lookup strips the suffix to find
 * the bare-name rate when the dated rate isn't explicitly listed. New
 * dates inherit the rate of their bare name automatically — no rate
 * card update needed for monthly model snapshots.
 */

export interface RateCard {
  /** USD per 1M input tokens. */
  inputPer1M: number
  /** USD per 1M output tokens. */
  outputPer1M: number
}

/** Gemini (Google). */
export const GEMINI_RATES: Record<string, RateCard> = {
  'gemini-2.0-flash': { inputPer1M: 0.075, outputPer1M: 0.3 },
  'gemini-2.5-flash': { inputPer1M: 0.075, outputPer1M: 0.3 },
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 5.0 },
}
export const GEMINI_DEFAULT_MODEL = 'gemini-2.0-flash'

/** Anthropic (Claude). */
export const ANTHROPIC_RATES: Record<string, RateCard> = {
  'claude-haiku-4-5-20251001': { inputPer1M: 0.25, outputPer1M: 1.25 },
  'claude-haiku-4-5': { inputPer1M: 0.25, outputPer1M: 1.25 },
  'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-opus-4-7': { inputPer1M: 15.0, outputPer1M: 75.0 },
}
export const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

/**
 * Look up the rate card for a model. Tries the model name verbatim,
 * then strips a trailing -YYYYMMDD date suffix and tries again, then
 * falls back to the provider default. Returns null only when neither
 * `gemini` nor `anthropic` rate cards know the model.
 */
export function rateCardFor(
  provider: 'gemini' | 'anthropic',
  model: string,
): RateCard {
  const cards = provider === 'gemini' ? GEMINI_RATES : ANTHROPIC_RATES
  if (cards[model]) return cards[model]
  const bare = model.replace(/-\d{8}$/, '')
  if (cards[bare]) return cards[bare]
  const fallback =
    provider === 'gemini'
      ? cards[GEMINI_DEFAULT_MODEL]
      : cards[ANTHROPIC_DEFAULT_MODEL]
  // Defensive — both default models are listed above, so this branch
  // is unreachable at runtime. Returning a zero-cost card rather than
  // throwing keeps the budget check from sinking a request when an
  // operator adds a new model name without seeding rates.
  return fallback ?? { inputPer1M: 0, outputPer1M: 0 }
}

/**
 * Compute USD cost for a (model, inputTokens, outputTokens) triple
 * using the shared rate card. Used both at write time (post-call,
 * exact) and at estimate time (pre-call, against an estimated token
 * count) by AiBudgetService.
 */
export function priceFor(
  provider: 'gemini' | 'anthropic',
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rate = rateCardFor(provider, model)
  return (
    (inputTokens / 1_000_000) * rate.inputPer1M +
    (outputTokens / 1_000_000) * rate.outputPer1M
  )
}

/**
 * Heuristic token estimator used by the budget service when we don't
 * have actual token counts yet (pre-call enforcement). 4 chars per
 * token is the conventional rule for English; non-English content
 * (Italian, German, Cyrillic, CJK) skews higher tokens-per-char, so
 * the heuristic over-estimates input cost on those — which is the
 * safe direction for a budget gate.
 */
export function estimateInputTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4)
}
