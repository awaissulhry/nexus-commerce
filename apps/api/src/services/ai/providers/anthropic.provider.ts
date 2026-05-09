/**
 * Anthropic provider — fetch-based, no SDK dependency.
 *
 * Calls api.anthropic.com/v1/messages directly. Avoiding the
 * @anthropic-ai/sdk install keeps the dependency surface tight and
 * the build simple; the Messages API is a small enough HTTP shape
 * that wrapping it here is cleaner than carrying another transitive
 * tree.
 *
 * Default model: Haiku for content generation. It's fast, cheap,
 * and the listing-content prompts don't need Opus-grade reasoning.
 * Callers can override via options.model.
 *
 * JSON-mode handling: Anthropic doesn't have a native JSON mode like
 * Gemini. We append a system instruction asking for JSON-only output
 * and rely on the parser in ListingContentService to strip any
 * markdown fences.
 *
 * AI-1.3: rate card moved to ../rate-cards.ts (shared with the budget
 * service for pre-call estimation). The date-suffix-stripping fallback
 * lives in rate-cards.ts now.
 */

import {
  ANTHROPIC_DEFAULT_MODEL,
  priceFor as priceForShared,
} from '../rate-cards.js'
import type {
  GenerateOptions,
  GenerateResult,
  LLMProvider,
  ProviderUsage,
} from './types.js'

const DEFAULT_MODEL = ANTHROPIC_DEFAULT_MODEL
const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

function priceFor(model: string, inputTokens: number, outputTokens: number) {
  return priceForShared('anthropic', model, inputTokens, outputTokens)
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
