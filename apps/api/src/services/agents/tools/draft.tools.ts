/**
 * ACP.1 — draft tools (low risk, auto-runnable). They GENERATE a
 * suggestion via AI-2 routing and return it — they never apply it (that
 * is a mutating tool, Phase 3). Read-only in the side-effect sense.
 */

import prisma from '../../../db.js'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool } from '../tool-types.js'
import {
  getProviderForFeature,
  resolveModelForFeature,
} from '../../ai/model-resolver.service.js'
import { logUsage } from '../../ai/usage-logger.service.js'
import { liveProduct } from './live-product.js'

/**
 * MCP.7 — the drafts call OUR AI provider and spend OUR AI budget. Claude writes its own
 * drafts, so over MCP they would only add cost: they are offered in the app alone.
 */
export const AI_DRAFT_SURFACES = ['app'] as const

export async function aiDraft(
  feature: string,
  prompt: string,
  entityType?: string,
  entityId?: string,
): Promise<{ suggestion: string; model: string; costUSD: number }> {
  const provider = await getProviderForFeature(feature)
  if (!provider) throw new Error('No AI provider configured')
  const model = await resolveModelForFeature(feature, provider)
  const res = await provider.generate({
    prompt,
    model,
    feature,
    temperature: 0.5,
    maxOutputTokens: 1024,
    entityType,
    entityId,
  })
  logUsage({
    provider: res.usage.provider,
    model: res.usage.model,
    feature,
    inputTokens: res.usage.inputTokens,
    outputTokens: res.usage.outputTokens,
    costUSD: res.usage.costUSD,
    ok: true,
    entityType,
    entityId,
  })
  return { suggestion: res.text, model: res.usage.model, costUSD: res.usage.costUSD }
}

async function loadProduct(id: string) {
  return prisma.product.findFirst({
    where: liveProduct(id),
    select: {
      sku: true,
      name: true,
      brand: true,
      productType: true,
      description: true,
      bulletPoints: true,
      keywords: true,
    },
  })
}

const draftListingContent: AgentTool = {
  name: 'draft-listing-content',
  title: 'Draft listing content',
  input: z.object({ productId: z.string().min(1).describe('Nexus product id') }),
  requires: [F.productsView],
  surfaces: AI_DRAFT_SURFACES,
  category: 'products',
  riskTier: 'low',
  readOnly: true,
  description:
    'Draft an improved title, bullet points, and description for a product (suggestion only).',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const p = await loadProduct(id)
    if (!p) return { ok: false, error: 'Product not found' }
    const out = await aiDraft(
      'listing-content',
      [
        'Draft best-in-class marketplace listing content for this product.',
        'Return a punchy title (<=150 chars), 5 benefit-led bullet points,',
        'and a short description. Suggestion only.',
        '',
        JSON.stringify(p, null, 2),
      ].join('\n'),
      'Product',
      id,
    )
    return { ok: true, data: out }
  },
}

const draftSeo: AgentTool = {
  name: 'draft-seo',
  title: 'Draft SEO keywords',
  input: z.object({ productId: z.string().min(1).describe('Nexus product id') }),
  requires: [F.productsView],
  surfaces: AI_DRAFT_SURFACES,
  category: 'products',
  riskTier: 'low',
  readOnly: true,
  description: 'Suggest SEO keywords + a meta description for a product.',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const p = await loadProduct(id)
    if (!p) return { ok: false, error: 'Product not found' }
    const out = await aiDraft(
      'seo-regen',
      `Suggest 10 high-intent search keywords and one 155-char meta description for this product:\n${JSON.stringify(p, null, 2)}`,
      'Product',
      id,
    )
    return { ok: true, data: out }
  },
}

const translateContent: AgentTool = {
  name: 'translate-content',
  title: 'Translate product content',
  input: z.object({
    productId: z.string().min(1).describe('Nexus product id'),
    target: z.string().trim().min(1).describe('target market language, e.g. de'),
  }),
  requires: [F.productsView],
  surfaces: AI_DRAFT_SURFACES,
  category: 'products',
  riskTier: 'low',
  readOnly: true,
  description:
    'Translate a product title + description into a target market language (suggestion only).',
  async handler(args) {
    const id = String(args.productId ?? '')
    const target = String(args.target ?? args.language ?? '').trim()
    if (!id || !target)
      return { ok: false, error: 'productId and target (language) are required' }
    const p = await loadProduct(id)
    if (!p) return { ok: false, error: 'Product not found' }
    const out = await aiDraft(
      'translate',
      `Translate this product's title and description into ${target}. Keep brand names + SKUs verbatim.\nTitle: ${p.name}\nDescription: ${p.description ?? '(none)'}`,
      'Product',
      id,
    )
    return { ok: true, data: { target, ...out } }
  },
}

const draftCustomerMessage: AgentTool = {
  name: 'draft-customer-message',
  title: 'Draft a customer message',
  input: z.object({
    intent: z.string().trim().min(1).describe('what the message should say'),
    orderId: z.string().min(1).optional().describe('the order it is about'),
  }),
  requires: [F.ordersView],
  surfaces: AI_DRAFT_SURFACES,
  category: 'comms',
  riskTier: 'low',
  readOnly: true,
  description:
    'Draft a customer reply for an order (suggestion only — sending is a separate, approval-gated tool).',
  async handler(args) {
    const intent = String(args.intent ?? args.context ?? '').trim()
    if (!intent)
      return { ok: false, error: 'intent (what to say) is required' }
    let ctx = ''
    const orderId = String(args.orderId ?? '')
    if (orderId) {
      const o = await prisma.order.findUnique({
        where: { id: orderId },
        select: {
          customerName: true,
          marketplace: true,
          channelOrderId: true,
        },
      })
      if (o) ctx = `\nOrder context: ${JSON.stringify(o)}`
    }
    const out = await aiDraft(
      'products-copilot',
      `Draft a concise, friendly customer message. Intent: ${intent}${ctx}`,
      orderId ? 'Order' : undefined,
      orderId || undefined,
    )
    return { ok: true, data: out }
  },
}

export const DRAFT_TOOLS: AgentTool[] = [
  draftListingContent,
  draftSeo,
  translateContent,
  draftCustomerMessage,
]
