/**
 * IR.14 — Imagen 3 lifestyle generation.
 *
 * Calls the Google AI Studio Imagen 3 `:predict` endpoint directly
 * — the @google/generative-ai SDK (v0.24) doesn't surface Imagen yet,
 * so we use plain fetch with the same GEMINI_API_KEY auth.
 *
 * Returns base64 PNG bytes which the caller uploads to Cloudinary
 * (we don't want to re-implement Cloudinary's upload primitive).
 *
 * Imagen 3 access requires a paid plan on the API key. Free-tier
 * calls return 403; we translate that into a clear error so the
 * operator sees "Imagen needs a paid plan" rather than the raw
 * vendor message.
 */

import { logger } from '../../utils/logger.js'
import { isAiKillSwitchOn } from './providers/index.js'
import { priceFor } from './rate-cards.js'
import { logUsage } from './usage-logger.service.js'

const IMAGEN_MODEL = 'imagen-3.0-generate-002'
const IMAGEN_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGEN_MODEL}:predict`

export type ImagenAspectRatio = '1:1' | '3:4' | '4:3' | '9:16' | '16:9'

interface ImagenPrediction {
  bytesBase64Encoded?: string
  mimeType?: string
}

interface ImagenResponse {
  predictions?: ImagenPrediction[]
  // Error responses come back with this shape from the predict endpoint
  error?: { code?: number; message?: string; status?: string }
}

export interface GenerateLifestyleInput {
  prompt: string
  aspectRatio?: ImagenAspectRatio
  /** Caller's product/image context for audit trail. */
  entityType: 'Product'
  entityId: string
  userId?: string | null
}

export interface GenerateLifestyleOutput {
  base64: string
  mimeType: string
  prompt: string
  aspectRatio: ImagenAspectRatio
}

export async function generateLifestyleImage(
  input: GenerateLifestyleInput,
): Promise<GenerateLifestyleOutput> {
  if (isAiKillSwitchOn()) {
    throw new Error('AI temporarily disabled — kill switch on')
  }
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')

  const aspectRatio = input.aspectRatio ?? '1:1'
  const started = Date.now()
  let ok = false
  let errorMessage: string | undefined

  try {
    const res = await fetch(`${IMAGEN_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt: input.prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio,
          // safetyFilterLevel: 'block_some' is the default; left implicit.
          // personGeneration: 'allow_adult' is the default; left implicit.
        },
      }),
    })

    const body: ImagenResponse = await res.json().catch(() => ({}))

    if (!res.ok) {
      const vendor = body.error?.message ?? `Imagen HTTP ${res.status}`
      // Imagen 3 needs a paid plan on the developer key. Translate the
      // common failure modes so the operator gets actionable text.
      if (res.status === 403 || /quota|billing|tier/i.test(vendor)) {
        throw new Error('Imagen 3 needs a paid plan on the Gemini API key. Enable billing at https://aistudio.google.com/apikey then retry.')
      }
      if (res.status === 400 && /policy|safety/i.test(vendor)) {
        throw new Error('Prompt rejected by Imagen safety filter. Soften the wording (no people specifics, no brand names of competitors) and retry.')
      }
      throw new Error(vendor)
    }

    const pred = body.predictions?.[0]
    if (!pred?.bytesBase64Encoded) {
      throw new Error('Imagen returned no image bytes')
    }

    ok = true
    return {
      base64: pred.bytesBase64Encoded,
      mimeType: pred.mimeType ?? 'image/png',
      prompt: input.prompt,
      aspectRatio,
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err)
    logger.warn('[image-generation] imagen call failed', { errorMessage, prompt: input.prompt.slice(0, 80) })
    throw err
  } finally {
    // Imagen pricing isn't in our rate-card yet; logUsage with 0
    // input/output tokens and a fixed $0.04 cost per generation
    // (Imagen 3 Fast pricing) so the audit isn't pretending the
    // call was free. Rate-card will own this once stable.
    logUsage({
      provider: 'gemini',
      model: IMAGEN_MODEL,
      feature: 'image-lifestyle-generation',
      entityType: input.entityType,
      entityId: input.entityId,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: ok ? 0.04 : 0,
      metadata: { aspectRatio, promptPreview: input.prompt.slice(0, 200) },
      latencyMs: Date.now() - started,
      ok,
      errorMessage,
      userId: input.userId ?? undefined,
    })
  }
}
