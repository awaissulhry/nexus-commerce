/**
 * ACP.1 — mutating tools (HIGH risk, alwaysAsk). Declared so the
 * permission surface is complete, but they ONLY return a dry-run preview
 * of their effect. They never execute — the approval gate + real
 * execution land in Phase 3. `alwaysAsk` is a hard floor the policy
 * layer cannot downgrade.
 */

import prisma from '../../../db.js'
import type { AgentTool } from '../tool-types.js'

const setPrice: AgentTool = {
  name: 'set-price',
  category: 'pricing',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  description:
    'Change a product / channel price. PREVIEW ONLY until the Phase 3 approval gate.',
  async handler(args) {
    const id = String(args.productId ?? '')
    const proposed = Number(args.price)
    if (!id || !Number.isFinite(proposed))
      return { ok: false, error: 'productId and numeric price are required' }
    const p = await prisma.product.findUnique({
      where: { id },
      select: { sku: true, basePrice: true },
    })
    if (!p) return { ok: false, error: 'Product not found' }
    const current = Number(p.basePrice)
    return {
      ok: true,
      preview: {
        action: 'set-price',
        sku: p.sku,
        channel: args.channel ?? 'master',
        current,
        proposed,
        deltaPct: current ? Math.round(((proposed - current) / current) * 1000) / 10 : null,
        note: 'Preview only — requires approval to execute (Phase 3).',
      },
    }
  },
}

const publishListing: AgentTool = {
  name: 'publish-listing',
  category: 'listings',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  description:
    'Publish / update a channel listing. PREVIEW ONLY until the Phase 3 approval gate.',
  async handler(args) {
    const id = String(args.productId ?? '')
    const channel = String(args.channel ?? '').toUpperCase()
    if (!id || !channel)
      return { ok: false, error: 'productId and channel are required' }
    const cl = await prisma.channelListing.findFirst({
      where: { productId: id, channel },
      select: { title: true, externalListingId: true },
    })
    return {
      ok: true,
      preview: {
        action: 'publish-listing',
        channel,
        currentlyPublished: !!cl?.externalListingId,
        title: cl?.title ?? null,
        note: 'Preview only — requires approval to execute (Phase 3).',
      },
    }
  },
}

const sendCustomerMessage: AgentTool = {
  name: 'send-customer-message',
  category: 'comms',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  description:
    'Send a message to a customer. PREVIEW ONLY until the Phase 3 approval gate.',
  async handler(args) {
    const orderId = String(args.orderId ?? '')
    const message = String(args.message ?? '').trim()
    if (!orderId || !message)
      return { ok: false, error: 'orderId and message are required' }
    const o = await prisma.order.findUnique({
      where: { id: orderId },
      select: { customerName: true, customerEmail: true, marketplace: true },
    })
    if (!o) return { ok: false, error: 'Order not found' }
    return {
      ok: true,
      preview: {
        action: 'send-customer-message',
        to: o.customerName,
        marketplace: o.marketplace,
        message,
        note: 'Preview only — requires approval to execute (Phase 3).',
      },
    }
  },
}

// apply-content — the reversible "copilot fixes the listing" action:
// writes drafted title / bullets / description to the MASTER product (not
// live to any channel). Medium tier but routed through the approval gate
// (requiresApprovalDefault) so the loop is proven on a safe action.
const applyContent: AgentTool = {
  name: 'apply-content',
  category: 'products',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  description:
    'Apply a drafted title / bullet points / description to the master product (reversible; requires approval).',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const p = await prisma.product.findUnique({
      where: { id },
      select: { name: true, bulletPoints: true, description: true },
    })
    if (!p) return { ok: false, error: 'Product not found' }
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    if (args.title != null) changes.title = { from: p.name, to: String(args.title) }
    if (Array.isArray(args.bulletPoints))
      changes.bulletPoints = {
        from: p.bulletPoints,
        to: (args.bulletPoints as unknown[]).map(String),
      }
    if (args.description != null)
      changes.description = { from: p.description, to: String(args.description) }
    if (Object.keys(changes).length === 0)
      return {
        ok: false,
        error: 'nothing to apply (title / bulletPoints / description)',
      }
    return {
      ok: true,
      preview: {
        action: 'apply-content',
        productId: id,
        changes,
        note: 'Reversible master-content edit; requires approval to apply.',
      },
    }
  },
  async execute(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const p = await prisma.product.findUnique({
      where: { id },
      select: { name: true, bulletPoints: true, description: true },
    })
    if (!p) return { ok: false, error: 'Product not found' }
    const data: Record<string, unknown> = {}
    const undo: Record<string, unknown> = {}
    if (args.title != null) {
      undo.name = p.name
      data.name = String(args.title)
    }
    if (Array.isArray(args.bulletPoints)) {
      undo.bulletPoints = p.bulletPoints
      data.bulletPoints = (args.bulletPoints as unknown[]).map(String)
    }
    if (args.description != null) {
      undo.description = p.description
      data.description = String(args.description)
    }
    if (Object.keys(data).length === 0)
      return { ok: false, error: 'nothing to apply' }
    await prisma.product.update({ where: { id }, data })
    return { ok: true, data: { applied: Object.keys(data), undo } }
  },
}

export const MUTATE_TOOLS: AgentTool[] = [
  applyContent,
  setPrice,
  publishListing,
  sendCustomerMessage,
]
