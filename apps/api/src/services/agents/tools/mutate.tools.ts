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

export const MUTATE_TOOLS: AgentTool[] = [
  setPrice,
  publishListing,
  sendCustomerMessage,
]
