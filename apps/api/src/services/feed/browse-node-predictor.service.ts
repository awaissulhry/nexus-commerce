/**
 * CE.2 — AI Browse Node Engine.
 *
 * Given a Product, predicts the correct browse node ID + path for a
 * target channel × marketplace using Claude Haiku. Stores the result in
 * ChannelListing.platformAttributes.browseNodeId with a confidence score.
 *
 * Sandbox-safe: when ANTHROPIC_API_KEY is absent, returns the existing
 * platformAttributes.browseNodeId (or a deterministic fallback) without
 * calling the API. Never throws — degrades silently so the cron tick
 * doesn't abort on a missing key.
 *
 * Context efficiency: the channel taxonomy block (ChannelSchema nodes for
 * browse_node_id) is injected as the system prompt and marked with
 * cache_control=ephemeral — a single call's taxonomy block stays in the
 * prompt cache for ~5 min, amortizing cost across the batch sweep.
 */

import type { PrismaClient } from '@nexus/database'
import { logger } from '../../utils/logger.js'

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages'
const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const ANTHROPIC_VERSION = '2023-06-01'

export interface BrowseNodePrediction {
  nodeId: string
  nodePath: string
  confidence: number
  reasoning: string
  productId: string
  channel: string
  marketplace: string | null
}

// ── Known Amazon IT / eBay browse node taxonomy ───────────────────────────
// Curated set of motorcycle gear nodes to anchor Haiku's output.
// Extended at runtime with any ChannelSchema notes entries.
const AMAZON_IT_TAXONOMY = `
Amazon IT motorcycle/motorbike product categories (browseNodeId: label):
691262031: Giacche da Moto (Motorcycle Jackets)
1568684031: Pantaloni da Moto (Motorcycle Trousers)
1568683031: Tute da Moto (Motorcycle Suits / Combineds)
505468: Guanti da Moto (Motorcycle Gloves)
691264031: Caschi da Moto (Motorcycle Helmets)
691263031: Stivali da Moto (Motorcycle Boots)
505464: Abbigliamento da Moto (Motorcycle Apparel general)
691274031: Protezioni da Moto (Motorcycle Armour / Protectors)
2454186031: Accessori da Moto (Motorcycle Accessories)
`.trim()

const EBAY_IT_TAXONOMY = `
eBay IT motorcycle gear categories (categoryId: label):
179010: Abbigliamento da Moto (Motorcycle Clothing)
169166: Caschi da Moto (Motorcycle Helmets)
36455: Guanti da Moto (Motorcycle Gloves)
179290: Stivali da Moto (Motorcycle Boots)
179291: Protezioni (Body Armour)
`.trim()

function getTaxonomy(channel: string, marketplace: string | null): string {
  if (channel === 'AMAZON') return AMAZON_IT_TAXONOMY
  if (channel === 'EBAY') return EBAY_IT_TAXONOMY
  return 'No channel-specific taxonomy available; use your best judgment.'
}

// ── Anthropic call ──────────────────────────────────────────────────────────

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>
  error?: { message: string }
}

async function callHaiku(systemPrompt: string, userMessage: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null

  try {
    const res = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 256,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: userMessage }],
      }),
    })

    if (!res.ok) {
      logger.warn('browse-node-predictor: Anthropic error', { status: res.status })
      return null
    }

    const json = (await res.json()) as AnthropicResponse
    if (json.error) {
      logger.warn('browse-node-predictor: Anthropic error body', { error: json.error.message })
      return null
    }

    return json.content?.find((b) => b.type === 'text')?.text ?? null
  } catch (err) {
    logger.warn('browse-node-predictor: fetch failed', {
      err: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

function parseResponse(text: string): {
  nodeId: string
  nodePath: string
  confidence: number
  reasoning: string
} {
  // Expect JSON output: {"nodeId": "...", "nodePath": "...", "confidence": 0.9, "reasoning": "..."}
  try {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) {
      const parsed = JSON.parse(match[0]) as {
        nodeId?: string
        nodePath?: string
        confidence?: number
        reasoning?: string
      }
      return {
        nodeId: parsed.nodeId ?? '',
        nodePath: parsed.nodePath ?? '',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
        reasoning: parsed.reasoning ?? '',
      }
    }
  } catch {
    // fall through to line-based parsing
  }

  // Fallback: extract key lines
  const nodeIdMatch = text.match(/nodeId["\s:]+([0-9A-Za-z_-]+)/)
  const confidenceMatch = text.match(/confidence["\s:]+([0-9.]+)/)
  return {
    nodeId: nodeIdMatch?.[1] ?? '',
    nodePath: '',
    confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5,
    reasoning: text.slice(0, 200),
  }
}

// ── Main predictor ─────────────────────────────────────────────────────────

export async function predictBrowseNode(
  prisma: PrismaClient,
  productId: string,
  channel: string,
  marketplace: string | null,
  opts: { force?: boolean } = {},
): Promise<BrowseNodePrediction | null> {
  const channelUp = channel.toUpperCase()
  const marketUp = marketplace?.toUpperCase() ?? null

  // Load product
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      id: true, name: true, productType: true, description: true, brand: true,
    },
  })
  if (!product) return null

  // Load existing channel listing
  const listing = await prisma.channelListing.findFirst({
    where: {
      productId,
      channel: channelUp,
      ...(marketUp ? { marketplace: marketUp } : {}),
    },
  })

  // Skip if already set and not forced
  const existing = (listing?.platformAttributes as Record<string, unknown> | null)
  if (!opts.force && existing?.browseNodeId) {
    return {
      nodeId: String(existing.browseNodeId),
      nodePath: String(existing.browseNodePath ?? ''),
      confidence: Number(existing.browseNodeConfidence ?? 1),
      reasoning: 'Already set',
      productId,
      channel: channelUp,
      marketplace: marketUp,
    }
  }

  // Build prompt
  const taxonomy = getTaxonomy(channelUp, marketUp)
  const systemPrompt = `You are a marketplace categorization expert. Given a product, select the most appropriate browse node / category from the taxonomy provided.

Respond with ONLY a JSON object on a single line:
{"nodeId": "123456", "nodePath": "Root > Category > Subcategory", "confidence": 0.95, "reasoning": "brief reason"}

Confidence: 0.0–1.0 where 1.0 = certain match, 0.5 = reasonable guess, below 0.5 = uncertain.

${taxonomy}`

  const userMessage = `Product: ${product.name}
Type: ${product.productType ?? 'unknown'}
Brand: ${product.brand ?? 'unknown'}
Description: ${(product.description ?? '').slice(0, 400)}

Channel: ${channelUp}${marketUp ? ` (${marketUp})` : ''}

Select the best matching browse node from the taxonomy above.`

  const text = await callHaiku(systemPrompt, userMessage)

  // If no API key or call failed, return deterministic fallback
  if (!text) {
    // Sandbox fallback: map product type keywords to known nodes
    const lower = `${product.name} ${product.productType ?? ''}`.toLowerCase()
    let fallbackId = '505464' // Abbigliamento da Moto (general)
    if (lower.includes('casco') || lower.includes('helmet')) fallbackId = '691264031'
    else if (lower.includes('giacca') || lower.includes('jacket')) fallbackId = '691262031'
    else if (lower.includes('pantalon') || lower.includes('trouser')) fallbackId = '1568684031'
    else if (lower.includes('guant') || lower.includes('glove')) fallbackId = '505468'
    else if (lower.includes('stival') || lower.includes('boot')) fallbackId = '691263031'
    else if (lower.includes('tuta') || lower.includes('suit') || lower.includes('combinat')) fallbackId = '1568683031'

    return {
      nodeId: fallbackId,
      nodePath: 'Moto > Abbigliamento',
      confidence: 0.6,
      reasoning: 'Keyword-matched fallback (no API key)',
      productId,
      channel: channelUp,
      marketplace: marketUp,
    }
  }

  const parsed = parseResponse(text)

  // Persist to platformAttributes
  if (listing && parsed.nodeId) {
    const attrs = { ...(existing ?? {}), browseNodeId: parsed.nodeId, browseNodePath: parsed.nodePath, browseNodeConfidence: parsed.confidence }
    await prisma.channelListing.update({
      where: { id: listing.id },
      data: { platformAttributes: attrs as never },
    })
  }

  return { ...parsed, productId, channel: channelUp, marketplace: marketUp }
}

// ── Batch sweep (cron) ─────────────────────────────────────────────────────

export async function sweepMissingBrowseNodes(
  prisma: PrismaClient,
  opts: { channel?: string; limit?: number } = {},
): Promise<{ attempted: number; succeeded: number; skipped: number; errors: number }> {
  const channel = opts.channel?.toUpperCase() ?? 'AMAZON'
  const limit = opts.limit ?? 50

  // Find ChannelListings where browseNodeId is null in platformAttributes
  const listings = await prisma.channelListing.findMany({
    where: {
      channel,
      // JSON path filter: rows where platformAttributes.browseNodeId is null/missing
      NOT: {
        platformAttributes: {
          path: ['browseNodeId'],
          not: null,
        },
      },
    },
    select: { productId: true, marketplace: true },
    take: limit,
    orderBy: { updatedAt: 'asc' },
  })

  let succeeded = 0, skipped = 0, errors = 0

  for (const row of listings) {
    try {
      const result = await predictBrowseNode(prisma, row.productId, channel, row.marketplace, { force: false })
      if (result?.nodeId) succeeded++
      else skipped++
    } catch (err) {
      errors++
      logger.warn('browse-node-predictor: sweep error', {
        productId: row.productId,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { attempted: listings.length, succeeded, skipped, errors }
}
