/**
 * Gemini provider — thin wrapper around @google/generative-ai's
 * generateContent. Exists so callers can depend on `LLMProvider`
 * without seeing the SDK shape.
 *
 * Pricing (as of 2026-05): gemini-2.0-flash is $0.075 / 1M input
 * tokens, $0.30 / 1M output. gemini-2.5-pro is $1.25 / 1M input,
 * $5.00 / 1M output. Update RATE_CARD when Google revises these —
 * AiUsageLog.cost is computed at write time, not lazy-evaluated, so
 * historical rows reflect what was charged at the time they ran.
 */

import { GoogleGenerativeAI } from '@google/generative-ai'
import type {
  GenerateOptions,
  GenerateResult,
  LLMProvider,
  ProviderUsage,
} from './types.js'

const DEFAULT_MODEL = 'gemini-2.0-flash'

interface RateCard {
  /** USD per 1M input tokens. */
  inputPer1M: number
  /** USD per 1M output tokens. */
  outputPer1M: number
}
const RATE_CARD: Record<string, RateCard> = {
  'gemini-2.0-flash': { inputPer1M: 0.075, outputPer1M: 0.3 },
  'gemini-2.5-flash': { inputPer1M: 0.075, outputPer1M: 0.3 },
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 5.0 },
}

function priceFor(model: string, inputTokens: number, outputTokens: number) {
  const rate = RATE_CARD[model] ?? RATE_CARD[DEFAULT_MODEL]
  return (
    (inputTokens / 1_000_000) * rate.inputPer1M +
    (outputTokens / 1_000_000) * rate.outputPer1M
  )
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini' as const
  readonly defaultModel = DEFAULT_MODEL
  private client: GoogleGenerativeAI | null = null

  isConfigured(): boolean {
    return !!process.env.GEMINI_API_KEY
  }

  private getClient(): GoogleGenerativeAI {
    if (this.client) return this.client
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set')
    }
    this.client = new GoogleGenerativeAI(apiKey)
    return this.client
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const modelName = options.model ?? DEFAULT_MODEL
    const model = this.getClient().getGenerativeModel({ model: modelName })
    const response = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: options.prompt }] }],
      generationConfig: {
        temperature: options.temperature ?? 0.6,
        maxOutputTokens: options.maxOutputTokens ?? 4096,
        ...(options.jsonMode
          ? { responseMimeType: 'application/json' }
          : {}),
      },
    })
    const text = response.response.text()
    // The SDK returns usageMetadata on the response; the field shape
    // is documented but stringly-typed in TS, so we read defensively.
    const meta = (response.response as any).usageMetadata ?? {}
    const inputTokens = Number(meta.promptTokenCount ?? 0)
    const outputTokens = Number(meta.candidatesTokenCount ?? 0)
    const usage: ProviderUsage = {
      provider: 'gemini',
      model: modelName,
      inputTokens,
      outputTokens,
      costUSD: priceFor(modelName, inputTokens, outputTokens),
    }
    return { text, usage }
  }
}
