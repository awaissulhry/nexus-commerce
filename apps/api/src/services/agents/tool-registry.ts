/**
 * ACP.1 — capability/tool registry (code-first, MCP-shaped).
 *
 * Tools are typed functions with a stable name, a default risk tier, and
 * a handler. The DB `AgentTool` row holds the operator-editable POLICY
 * (tier override, enabled, approval, budget); the code here is the source
 * of truth for what a tool DOES. ACP.0 ships one read-only tool to prove
 * the spine; Phase 1 grows this to 15-25.
 */

import prisma from '../../db.js'

export type RiskTier = 'low' | 'medium' | 'high'

export interface ToolContext {
  userId?: string | null
}
export interface ToolResult {
  ok: boolean
  data?: unknown
  error?: string
}

export interface AgentTool {
  name: string
  description: string
  riskTier: RiskTier
  /** Read-only tools auto-run; mutating tools route through the approval
   *  gate (Phase 3). The ACP.0 slice ships read-only only. */
  readOnly: boolean
  handler: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolResult>
}

// product-snapshot — read-only catalog completeness snapshot for one SKU.
const productSnapshot: AgentTool = {
  name: 'product-snapshot',
  description:
    'Read a product and summarise its catalog completeness (read-only).',
  riskTier: 'low',
  readOnly: true,
  async handler(args) {
    const productId = String(args.productId ?? '')
    if (!productId) return { ok: false, error: 'productId is required' }
    const p = await prisma.product.findUnique({
      where: { id: productId },
      select: {
        sku: true,
        name: true,
        brand: true,
        productType: true,
        description: true,
        bulletPoints: true,
        keywords: true,
        status: true,
        amazonAsin: true,
        ebayItemId: true,
        _count: { select: { images: true, variations: true } },
      },
    })
    if (!p) return { ok: false, error: 'Product not found' }
    const gaps: string[] = []
    if (!p.brand) gaps.push('brand')
    if (!p.productType) gaps.push('productType')
    if (!p.description) gaps.push('description')
    if (!p.bulletPoints?.length) gaps.push('bulletPoints')
    if (!p.keywords?.length) gaps.push('keywords')
    if (!p._count.images) gaps.push('images')
    return {
      ok: true,
      data: {
        sku: p.sku,
        name: p.name,
        brand: p.brand,
        productType: p.productType,
        status: p.status,
        hasAmazon: !!p.amazonAsin,
        hasEbay: !!p.ebayItemId,
        imageCount: p._count.images,
        variationCount: p._count.variations,
        bulletCount: p.bulletPoints?.length ?? 0,
        keywordCount: p.keywords?.length ?? 0,
        descriptionChars: p.description?.length ?? 0,
        completenessGaps: gaps,
      },
    }
  },
}

const REGISTRY = new Map<string, AgentTool>([
  [productSnapshot.name, productSnapshot],
])

export function getTool(name: string): AgentTool | undefined {
  return REGISTRY.get(name)
}
export function listTools(): AgentTool[] {
  return [...REGISTRY.values()]
}
