/**
 * Provider-agnostic LLM interface.
 *
 * Anything calling text-completion-style AI on the server should depend
 * on `LLMProvider` rather than directly on a specific SDK. The
 * concrete provider is chosen at request time (env override + per-call
 * `?provider=` query param) so we can route a given call to whichever
 * vendor has the best price / quality / availability today.
 *
 * The contract is deliberately narrow:
 *   - one prompt in, one structured response out
 *   - JSON-mode is a hint (Gemini honours it natively, Anthropic emits
 *     plain text and we parse — both work)
 *   - usage / cost are part of the result so the caller can persist
 *     them via UsageLogger without a second round-trip
 *
 * We do NOT attempt to abstract tools, function calling, vision, or
 * streaming. Those are vendor-specific and the value-add of an
 * abstraction degrades fast as you push more features through it.
 * If a code path needs those features, depend on the vendor SDK
 * directly and skip this layer.
 */

export type ProviderName = 'gemini' | 'anthropic'

export interface ProviderUsage {
  inputTokens: number
  outputTokens: number
  /** USD; computed in-provider against per-model rate cards. */
  costUSD: number
  model: string
  provider: ProviderName
}

export interface GenerateOptions {
  prompt: string
  /** 0–1; passed through to vendor temperature. */
  temperature?: number
  /** Hard cap on response length. Vendors have different defaults; we
   *  set 4096 as a sensible ceiling for listing-content workloads. */
  maxOutputTokens?: number
  /** When true, ask the provider for JSON-only output. Required for
   *  ListingContentService whose parsers expect strict JSON. */
  jsonMode?: boolean
  /** Model override. Each provider has a sensible default for content
   *  generation; pass this to bypass it. */
  model?: string
  /** Free-form id propagated into AiUsageLog so analytics can group by
   *  feature (e.g. 'products-ai-bulk', 'listing-wizard'). */
  feature?: string
  /** Optional product id for cost-per-product analytics. */
  entityType?: string
  entityId?: string
}

export interface GenerateResult {
  text: string
  usage: ProviderUsage
}

export interface LLMProvider {
  name: ProviderName
  /** Default model for this provider's content workload. Surfaced to
   *  callers + telemetry so AiUsageLog.model is always populated. */
  defaultModel: string
  isConfigured(): boolean
  generate(options: GenerateOptions): Promise<GenerateResult>
}
