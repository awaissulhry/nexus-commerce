/**
 * ACP.1 — read tools (low risk, auto-runnable, no side effects).
 * Thin, self-contained Prisma reads across the domains.
 */

import prisma from '../../../db.js'
import type { AgentTool } from '../tool-types.js'

const ci = (q: string) => ({ contains: q, mode: 'insensitive' as const })

function orderStatus(o: {
  cancelledAt: Date | null
  deliveredAt: Date | null
  shippedAt: Date | null
  paidAt: Date | null
}): string {
  if (o.cancelledAt) return 'cancelled'
  if (o.deliveredAt) return 'delivered'
  if (o.shippedAt) return 'shipped'
  if (o.paidAt) return 'paid'
  return 'pending'
}

const productSnapshot: AgentTool = {
  name: 'product-snapshot',
  category: 'products',
  riskTier: 'low',
  readOnly: true,
  description: 'Read a product and summarise its catalog completeness.',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const p = await prisma.product.findUnique({
      where: { id },
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

const productSearch: AgentTool = {
  name: 'product-search',
  category: 'products',
  riskTier: 'low',
  readOnly: true,
  description: 'Search the catalog by name / SKU / brand.',
  async handler(args) {
    const q = String(args.query ?? '').trim()
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50)
    const where = q
      ? { OR: [{ name: ci(q) }, { sku: ci(q) }, { brand: ci(q) }] }
      : {}
    const rows = await prisma.product.findMany({
      where,
      take: limit,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        sku: true,
        name: true,
        brand: true,
        productType: true,
        status: true,
        basePrice: true,
        totalStock: true,
      },
    })
    return { ok: true, data: { count: rows.length, products: rows } }
  },
}

const orderSearch: AgentTool = {
  name: 'order-search',
  category: 'orders',
  riskTier: 'low',
  readOnly: true,
  description:
    'Find recent orders, optionally filtered by marketplace / buyer / status.',
  async handler(args) {
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
    const where: Record<string, unknown> = {}
    if (args.marketplace) where.marketplace = String(args.marketplace)
    if (args.buyer)
      where.OR = [
        { customerName: ci(String(args.buyer)) },
        { customerEmail: ci(String(args.buyer)) },
      ]
    const rows = await prisma.order.findMany({
      where,
      take: limit,
      orderBy: { purchaseDate: 'desc' },
      select: {
        id: true,
        marketplace: true,
        channelOrderId: true,
        totalPrice: true,
        currencyCode: true,
        customerName: true,
        purchaseDate: true,
        paidAt: true,
        shippedAt: true,
        deliveredAt: true,
        cancelledAt: true,
      },
    })
    let out = rows.map((o) => ({ ...o, status: orderStatus(o) }))
    if (args.status)
      out = out.filter((o) => o.status === String(args.status).toLowerCase())
    return { ok: true, data: { count: out.length, orders: out } }
  },
}

const orderDetail: AgentTool = {
  name: 'order-detail',
  category: 'orders',
  riskTier: 'low',
  readOnly: true,
  description: 'Read one order (header + line-item count + fiscal kind).',
  async handler(args) {
    const id = String(args.orderId ?? '')
    if (!id) return { ok: false, error: 'orderId is required' }
    const o = await prisma.order.findUnique({
      where: { id },
      select: {
        marketplace: true,
        channelOrderId: true,
        totalPrice: true,
        currencyCode: true,
        customerName: true,
        customerEmail: true,
        fiscalKind: true,
        purchaseDate: true,
        paidAt: true,
        shippedAt: true,
        deliveredAt: true,
        cancelledAt: true,
        _count: { select: { items: true } },
      },
    })
    if (!o) return { ok: false, error: 'Order not found' }
    return {
      ok: true,
      data: { ...o, status: orderStatus(o), itemCount: o._count.items },
    }
  },
}

const stockLevels: AgentTool = {
  name: 'stock-levels',
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description: 'Current stock + per-channel listed quantity for a product.',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const p = await prisma.product.findUnique({
      where: { id },
      select: {
        sku: true,
        name: true,
        totalStock: true,
        lowStockThreshold: true,
        channelListings: {
          select: { channel: true, marketplace: true, quantity: true },
        },
      },
    })
    if (!p) return { ok: false, error: 'Product not found' }
    return {
      ok: true,
      data: {
        sku: p.sku,
        totalStock: p.totalStock,
        lowStockThreshold: p.lowStockThreshold,
        lowStock: p.totalStock <= p.lowStockThreshold,
        channels: p.channelListings,
      },
    }
  },
}

const priceStatus: AgentTool = {
  name: 'price-status',
  category: 'pricing',
  riskTier: 'low',
  readOnly: true,
  description: 'Master price + per-channel listed price for a product.',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const p = await prisma.product.findUnique({
      where: { id },
      select: {
        sku: true,
        basePrice: true,
        channelListings: {
          select: {
            channel: true,
            marketplace: true,
            price: true,
            salePrice: true,
          },
        },
      },
    })
    if (!p) return { ok: false, error: 'Product not found' }
    return {
      ok: true,
      data: {
        sku: p.sku,
        masterPrice: p.basePrice,
        channels: p.channelListings,
      },
    }
  },
}

const listingHealth: AgentTool = {
  name: 'listing-health',
  category: 'listings',
  riskTier: 'low',
  readOnly: true,
  description:
    'Per-channel listing readiness for a product (what is blocking a clean publish).',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const rows = await prisma.channelListing.findMany({
      where: { productId: id },
      select: {
        channel: true,
        marketplace: true,
        title: true,
        price: true,
        quantity: true,
        externalListingId: true,
      },
    })
    const channels = rows.map((r) => {
      const missing: string[] = []
      if (!r.title) missing.push('title')
      if (r.price == null) missing.push('price')
      if (r.quantity == null) missing.push('quantity')
      return {
        channel: r.channel,
        marketplace: r.marketplace,
        published: !!r.externalListingId,
        missing,
        ready: missing.length === 0,
      }
    })
    return { ok: true, data: { channelCount: channels.length, channels } }
  },
}

export const READ_TOOLS: AgentTool[] = [
  productSnapshot,
  productSearch,
  orderSearch,
  orderDetail,
  stockLevels,
  priceStatus,
  listingHealth,
]
