/**
 * Anthropic provider — fetch-based, no SDK dependency.
 *
 * Calls api.anthropic.com/v1/messages directly. Avoiding the
 * @anthropic-ai/sdk install keeps the dependency surface tight and
 * the build simple; the Messages API is a small enough HTTP shape
 * that wrapping it here is cleaner than carrying another transitive
 * tree.
 *
 * Pricing (as of 2026-05): claude-haiku-4-5 is $0.25 / 1M input,
 * $1.25 / 1M output. claude-sonnet-4-6 is $3.00 / 1M input, $15.00
 * / 1M output. Update RATE_CARD when Anthropic revises pricing —
 * AiUsageLog.cost is committed at write time and never recomputed.
 *
 * Default model: Haiku for content generation. It's fast, cheap,
 * and the listing-content prompts don't need Opus-grade reasoning.
 * Callers can override via options.model.
 *
 * JSON-mode handling: Anthropic doesn't have a native JSON mode like
 * Gemini. We append a system instruction asking for JSON-only output
 * and rely on the parser in ListingContentService to strip any
 * markdown fences.
 */

import type {
  GenerateOptions,
  GenerateResult,
  LLMProvider,
  ProviderUsage,
} from './types.js'

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'
const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

interface RateCard {
  inputPer1M: number
  outputPer1M: number
}
const RATE_CARD: Record<string, RateCard> = {
  'claude-haiku-4-5-20251001': { inputPer1M: 0.25, outputPer1M: 1.25 },
  'claude-haiku-4-5': { inputPer1M: 0.25, outputPer1M: 1.25 },
  'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-opus-4-7': { inputPer1M: 15.0, outputPer1M: 75.0 },
}

function priceFor(model: string, inputTokens: number, outputTokens: number) {
  // Strip the date suffix for matching: "claude-haiku-4-5-20251001" →
  // "claude-haiku-4-5". Date-suffixed and bare names share the rate.
  const bare = model.replace(/-\d{8}$/, '')
  const rate = RATE_CARD[model] ?? RATE_CARD[bare] ?? RATE_CARD[DEFAULT_MODEL]
  return (
    (inputTokens / 1_000_000) * rate.inputPer1M +
    (outputTokens / 1_000_000) * rate.outputPer1M
  )
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string
}

interface AnthropicResponse {
  content: Array<{ type: 'text'; text: string }>
  usage: { input_tokens: number; output_tokens: number }
  model: string
  stop_reason?: string
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic' as const
  readonly defaultModel = DEFAULT_MODEL

  isConfigured(): boolean {
    return !!process.env.ANTHROPIC_API_KEY
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set')
    }
    const modelName = options.model ?? DEFAULT_MODEL

    // JSON-mode shim — prepend an explicit instruction to the user
    // prompt so Claude returns plain JSON. The parser already
    // tolerates markdown fences, so this is best-effort.
    const userText = options.jsonMode
      ? `${options.prompt}\n\nRespond with ONLY a valid JSON object. No prose, no markdown fences.`
      : options.prompt

    const messages: AnthropicMessage[] = [
      { role: 'user', content: userText },
    ]

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: modelName,
        max_tokens: options.maxOutputTokens ?? 4096,
        temperature: options.temperature ?? 0.6,
        messages,
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(
        `Anthropic API error ${res.status}: ${body.slice(0, 500)}`,
      )
    }
    const json = (await res.json()) as AnthropicResponse
    const text = (json.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
    const inputTokens = Number(json.usage?.input_tokens ?? 0)
    const outputTokens = Number(json.usage?.output_tokens ?? 0)
    const usage: ProviderUsage = {
      provider: 'anthropic',
      model: json.model ?? modelName,
      inputTokens,
      outputTokens,
      costUSD: priceFor(json.model ?? modelName, inputTokens, outputTokens),
    }
    return { text, usage }
  }
}
