/**
 * Gemini provider — thin wrapper around @google/generative-ai's
 * generateContent. Exists so callers can depend on `LLMProvider`
 * without seeing the SDK shape.
 *
 * AI-1.3: rate card moved to ../rate-cards.ts so the budget service
 * can estimate cost pre-call against the same source of truth.
 */

import { GoogleGenerativeAI } from '@google/generative-ai'
import {
  GEMINI_DEFAULT_MODEL,
  priceFor as priceForShared,
} from '../rate-cards.js'
import type {
  GenerateOptions,
  GenerateResult,
  LLMProvider,
  ProviderUsage,
} from './types.js'

const DEFAULT_MODEL = GEMINI_DEFAULT_MODEL

function priceFor(model: string, inputTokens: number, outputTokens: number) {
  return priceForShared('gemini', model, inputTokens, outputTokens)
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
