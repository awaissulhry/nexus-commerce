/**
 * NAF.A2 — local OpenAI-compatible provider (docs/2026-08-06-naf-a2-local-provider.md).
 *
 * Speaks the OpenAI `POST /chat/completions` wire shape, which is what LM
 * Studio, Ollama, vLLM, and llama.cpp's server all expose. Fetch-based, no
 * SDK, no new dependency — the same reasoning that keeps
 * anthropic.provider.ts SDK-free applies here, and more so: the whole point
 * of L9 is that adding a provider is a config change, not a dependency
 * decision.
 *
 * Configuration is env-only and the base URL is the on/off switch:
 *   NEXUS_LOCAL_AI_BASE_URL   e.g. http://127.0.0.1:1234/v1   ← isConfigured()
 *   NEXUS_LOCAL_AI_MODEL      the id from GET {base}/models
 *   NEXUS_LOCAL_AI_API_KEY    optional; LM Studio ignores it, vLLM may not
 *   NEXUS_LOCAL_AI_TIMEOUT_MS optional; default 300s
 * Unset base URL ⇒ isConfigured() false ⇒ getProvider() skips this provider
 * entirely, which is production's permanent state.
 *
 * Cost is **exactly zero**, not a placeholder: the electricity is not on the
 * AI ledger and there is no rate card to be stale about. rate-cards.ts prices
 * 'local' at {0, 0, known: true} so a local run is never flagged as an
 * estimate.
 *
 * jsonMode maps to `response_format: { type: 'json_object' }` — grammar-
 * constrained *validity*, unconstrained *shape*, the same fidelity Gemini
 * gets from responseMimeType. Deliberately NOT `json_schema`: constrained
 * decoding against the Zod shape would drive the schema-validation retry
 * rate to ~0 by construction and destroy the Phase J datapoint that
 * measuring it exists to produce (plan D6).
 *
 * Timeout: unlike the cloud providers this one sets an AbortSignal. Node's
 * fetch has no default timeout, and a local generation is minutes rather
 * than seconds — a stalled model load would otherwise wedge an AgentRun at
 * status 'running' forever.
 */

import type {
  GenerateOptions,
  GenerateResult,
  LLMProvider,
  ProviderUsage,
} from './types.js'

/** Used only when NEXUS_LOCAL_AI_MODEL is unset. Most servers JIT-load or
 *  ignore an unknown id; the operator is expected to set the real one. */
const FALLBACK_MODEL = 'local-model'
const DEFAULT_TIMEOUT_MS = 300_000

interface ChatCompletionResponse {
  model?: string
  choices?: Array<{ message?: { content?: string | null } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

function timeoutMs(): number {
  const raw = Number(process.env.NEXUS_LOCAL_AI_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS
}

export class LocalProvider implements LLMProvider {
  readonly name = 'local' as const

  /** Re-read per access, never frozen at import: this is a laptop-side
   *  switch the operator flips between runs, and the provider singleton is
   *  constructed at module load — possibly before dotenv has run. */
  get defaultModel(): string {
    return process.env.NEXUS_LOCAL_AI_MODEL?.trim() || FALLBACK_MODEL
  }

  isConfigured(): boolean {
    return !!process.env.NEXUS_LOCAL_AI_BASE_URL?.trim()
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const base = process.env.NEXUS_LOCAL_AI_BASE_URL?.trim()
    if (!base) {
      throw new Error('NEXUS_LOCAL_AI_BASE_URL is not set')
    }
    const endpoint = `${base.replace(/\/+$/, '')}/chat/completions`
    const modelName = options.model ?? this.defaultModel

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.NEXUS_LOCAL_AI_API_KEY?.trim() || 'local'}`,
      },
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: options.prompt }],
        temperature: options.temperature ?? 0.6,
        max_tokens: options.maxOutputTokens ?? 4096,
        ...(options.jsonMode
          ? { response_format: { type: 'json_object' } }
          : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs()),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Local AI error ${res.status}: ${body.slice(0, 500)}`)
    }
    const json = (await res.json()) as ChatCompletionResponse
    const text = json.choices?.[0]?.message?.content ?? ''
    const usage: ProviderUsage = {
      provider: 'local',
      model: json.model ?? modelName,
      inputTokens: Number(json.usage?.prompt_tokens ?? 0),
      outputTokens: Number(json.usage?.completion_tokens ?? 0),
      // Exact, not an estimate. See the header note.
      costUSD: 0,
    }
    return { text, usage }
  }
}
