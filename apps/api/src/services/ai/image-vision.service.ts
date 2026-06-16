/**
 * IR.6.2 — Gemini Vision image analysis.
 *
 * Sends a master product image to Gemini's multimodal model and asks
 * for a structured JSON evaluation of four marketplace-critical
 * attributes:
 *
 *   - hasWhiteBackground: pure white background, Amazon MAIN gate
 *   - frameFillPct: subject's bbox / frame area, Amazon wants ≥ 85 %
 *   - hasTextOverlay: text printed on top of the product (logos
 *     baked in, watermarks, callouts, language overlays)
 *   - offCenterScore: 0–1, subject centroid offset from frame center
 *     as a fraction of half-diagonal
 *
 * Results land on ProductImage's ai* columns (IR.6.1). Cost + token
 * count audit to AiUsageLog so the operator can see what vision
 * analysis spent against the budget.
 *
 * Failures don't poison the row — we update aiAnalyzedAt + aiNotes
 * with the error so the operator sees "tried but failed" rather than
 * "never tried".
 */

import { GoogleGenerativeAI } from '@google/generative-ai'
import prisma from '../../db.js'
import { getProvider, isAiKillSwitchOn } from './providers/index.js'
import { GEMINI_DEFAULT_MODEL, priceFor } from './rate-cards.js'
import { resolveModelForFeature } from './model-resolver.service.js'
import { logUsage } from './usage-logger.service.js'

// IR.6.2 + AI-2.1: use the live Gemini default rather than a pinned id
// (the previously-pinned gemini-2.0-flash was retired 2026-06-01).
const VISION_MODEL = GEMINI_DEFAULT_MODEL

export interface VisionResult {
  hasWhiteBackground: boolean
  frameFillPct: number
  hasTextOverlay: boolean
  offCenterScore: number
  rationale: string
}

const PROMPT = `You are evaluating a product image for marketplace publishing.

Return a STRICT JSON object with these exact fields and no prose around it:

{
  "hasWhiteBackground": boolean,  // true ONLY if the background is pure white (no scenery, no gradient, no shadows beyond the product's own)
  "frameFillPct": number,         // integer 0-100: how much of the frame's area the main subject occupies
  "hasTextOverlay": boolean,      // true if there is text, logos, watermarks, callouts, or language overlays added on top of the product
  "offCenterScore": number,       // 0.0 to 1.0: how far the subject's centroid is from the frame center (0 = perfectly centered, 1 = touching an edge)
  "rationale": string             // one short sentence in English explaining the scores
}

Be strict about white-background — a light grey or off-white photo studio backdrop does NOT count as white.
For frameFillPct, count the bounding box of the product, not the visible silhouette.
Return only the JSON object — no markdown fences, no preamble.`

async function fetchImageAsInlineData(url: string): Promise<{ data: string; mimeType: string }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`)
  const arrayBuffer = await res.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const headerMime = res.headers.get('content-type') ?? 'image/jpeg'
  const mimeType = headerMime.split(';')[0]!.trim() || 'image/jpeg'
  return { data: buffer.toString('base64'), mimeType }
}

function parseVisionJson(raw: string): VisionResult {
  // Trim any markdown fences the model wraps things in despite the
  // instruction not to.
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
  const parsed = JSON.parse(stripped) as Partial<VisionResult>
  return {
    hasWhiteBackground: !!parsed.hasWhiteBackground,
    frameFillPct: Math.max(0, Math.min(100, Math.round(Number(parsed.frameFillPct ?? 0)))),
    hasTextOverlay: !!parsed.hasTextOverlay,
    offCenterScore: Math.max(0, Math.min(1, Number(parsed.offCenterScore ?? 0))),
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
  }
}

export async function analyzeProductImage(opts: {
  productImageId: string
  url: string
  userId?: string
}): Promise<VisionResult> {
  if (isAiKillSwitchOn()) {
    throw new Error('AI temporarily disabled — kill switch on')
  }

  const provider = getProvider('gemini')
  if (!provider) throw new Error('Gemini provider not configured')
  const modelId = await resolveModelForFeature('image-vision', provider)

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')

  const started = Date.now()
  let result: VisionResult | null = null
  let inputTokens = 0
  let outputTokens = 0
  let ok = false
  let errorMessage: string | undefined

  try {
    const { data, mimeType } = await fetchImageAsInlineData(opts.url)

    // Direct SDK call — vision needs multimodal parts, the provider
    // abstraction only handles text. Keep that boundary clean.
    const client = new GoogleGenerativeAI(apiKey)
    const model = client.getGenerativeModel({ model: modelId })
    const response = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { text: PROMPT },
          { inlineData: { data, mimeType } },
        ],
      }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json',
        maxOutputTokens: 512,
      },
    })
    const text = response.response.text()
    result = parseVisionJson(text)

    const meta = (response.response as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }).usageMetadata ?? {}
    inputTokens = Number(meta.promptTokenCount ?? 0)
    outputTokens = Number(meta.candidatesTokenCount ?? 0)

    await prisma.productImage.update({
      where: { id: opts.productImageId },
      data: {
        aiAnalyzedAt: new Date(),
        aiHasWhiteBackground: result.hasWhiteBackground,
        aiFrameFillPct: result.frameFillPct,
        aiHasTextOverlay: result.hasTextOverlay,
        aiOffCenterScore: result.offCenterScore,
        aiNotes: { rationale: result.rationale, model: VISION_MODEL } as object,
      },
    })
    ok = true
    return result
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err)
    // Persist the failure so the operator sees "tried but failed".
    await prisma.productImage.update({
      where: { id: opts.productImageId },
      data: {
        aiAnalyzedAt: new Date(),
        aiNotes: { error: errorMessage, model: VISION_MODEL } as object,
      },
    }).catch(() => {/* writing the failure also failed — non-fatal */})
    throw err
  } finally {
    logUsage({
      provider: 'gemini',
      model: modelId,
      feature: 'image-vision-analysis',
      entityType: 'ProductImage',
      entityId: opts.productImageId,
      inputTokens,
      outputTokens,
      costUSD: priceFor('gemini', modelId, inputTokens, outputTokens),
      latencyMs: Date.now() - started,
      ok,
      errorMessage,
      userId: opts.userId,
    })
  }
}
