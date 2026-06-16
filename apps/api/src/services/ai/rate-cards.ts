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
 *
 * AI-2.1 (2026-06-16) — prices refreshed to the current published rate
 * cards. Corrections: the Anthropic Opus tier is 5/25 (a stale 15/75
 * lingered on 4.7) and Haiku 4.5 is 1/5 (a stale 0.25/1.25 from the 3.5
 * era); Gemini 2.5 Flash is 0.30/2.50 and 2.5 Pro output is 10.0 (both
 * were stale). Added 2.5 Flash-Lite and the 3.x line. The default Gemini
 * model moved off gemini-2.0-flash — Google shut that model down
 * 2026-06-01 — to gemini-2.5-flash; the retired id stays in the table
 * for historical AiUsageLog cost lookups only. rateInfoFor() reports
 * `known: false` for any model the table hasn't seen so the live model
 * catalog can mark its cost "estimated" instead of mis-charging.
 */

export interface RateCard {
  /** USD per 1M input tokens. */
  inputPer1M: number
  /** USD per 1M output tokens. */
  outputPer1M: number
}

/** A rate-card lookup that also reports whether the price is a real
 *  seeded rate (`known: true`) or a default-rate placeholder for a
 *  model the table hasn't seen yet (`known: false`). The model catalog
 *  surfaces `known` so cost analytics can flag estimated charges on a
 *  brand-new model instead of silently mis-pricing it. */
export interface RateLookup extends RateCard {
  known: boolean
}

/** Gemini (Google). USD per 1M tokens, paid standard tier. */
export const GEMINI_RATES: Record<string, RateCard> = {
  // Current 2.5 line.
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10.0 },
  'gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5 },
  'gemini-2.5-flash-lite': { inputPer1M: 0.1, outputPer1M: 0.4 },
  // 3.x line — ids are best-effort pending live-discovery confirmation;
  // the catalog reconciles the real ids from the models API at runtime,
  // and an id miss here just falls through to an estimated rate.
  'gemini-3.5-flash': { inputPer1M: 1.5, outputPer1M: 9.0 },
  'gemini-3.1-pro': { inputPer1M: 2.0, outputPer1M: 12.0 },
  'gemini-3.1-flash-lite': { inputPer1M: 0.25, outputPer1M: 1.5 },
  // Retired 2026-06-01 — kept only so historical AiUsageLog rows resolve
  // a sane rate. Not a valid target for new calls; not the default.
  'gemini-2.0-flash': { inputPer1M: 0.1, outputPer1M: 0.4 },
}
export const GEMINI_DEFAULT_MODEL = 'gemini-2.5-flash'

/** Anthropic (Claude). USD per 1M tokens. */
export const ANTHROPIC_RATES: Record<string, RateCard> = {
  'claude-fable-5': { inputPer1M: 10.0, outputPer1M: 50.0 },
  'claude-opus-4-8': { inputPer1M: 5.0, outputPer1M: 25.0 },
  'claude-opus-4-7': { inputPer1M: 5.0, outputPer1M: 25.0 },
  'claude-opus-4-6': { inputPer1M: 5.0, outputPer1M: 25.0 },
  'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-haiku-4-5-20251001': { inputPer1M: 1.0, outputPer1M: 5.0 },
  'claude-haiku-4-5': { inputPer1M: 1.0, outputPer1M: 5.0 },
}
export const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

/**
 * Look up the rate card for a model, reporting whether the rate is real
 * or an estimate. Tries the model name verbatim, then strips a trailing
 * -YYYYMMDD date suffix and tries again (so dated snapshots inherit the
 * bare-name rate), then falls back to the provider default with
 * `known: false`. A `known: false` result means "we don't have a seeded
 * price for this model yet" — the call still works, but the catalog
 * marks its cost estimated rather than mis-charging.
 */
export function rateInfoFor(
  provider: 'gemini' | 'anthropic',
  model: string,
): RateLookup {
  const cards = provider === 'gemini' ? GEMINI_RATES : ANTHROPIC_RATES
  if (cards[model]) return { ...cards[model], known: true }
  const bare = model.replace(/-\d{8}$/, '')
  if (cards[bare]) return { ...cards[bare], known: true }
  const fallback =
    provider === 'gemini'
      ? cards[GEMINI_DEFAULT_MODEL]
      : cards[ANTHROPIC_DEFAULT_MODEL]
  // Unknown model — fall back to the provider default rate as an
  // estimate (flagged) rather than throwing, so a budget check or cost
  // log never sinks a request just because a new model isn't seeded.
  return { ...(fallback ?? { inputPer1M: 0, outputPer1M: 0 }), known: false }
}

/**
 * Back-compat shim for callers that only need the bare rate (budget +
 * provider cost logging). Delegates to rateInfoFor and drops the flag.
 */
export function rateCardFor(
  provider: 'gemini' | 'anthropic',
  model: string,
): RateCard {
  const { inputPer1M, outputPer1M } = rateInfoFor(provider, model)
  return { inputPer1M, outputPer1M }
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
