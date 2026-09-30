/**
 * ACP.1 — read tools (low risk, auto-runnable, no side effects).
 * Thin, self-contained Prisma reads across the domains.
 */

import prisma from '../../../db.js'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool } from '../tool-types.js'
import { likeEscaped } from '../../../lib/like-pattern.js'
import { isLiveProduct, liveProduct, PRODUCT_NOT_FOUND } from './live-product.js'

// MCP.12 — the caller's text is matched as typed: `_` and `%` in a SKU, a name or an email are characters, not wildcards.
const ci = (q: string) => ({ contains: likeEscaped(q), mode: 'insensitive' as const })

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

/** MCP.12 — listings a snapshot names; the rest are counted. */
const SNAPSHOT_LISTINGS = 20

const productSnapshot: AgentTool = {
  name: 'product-snapshot',
  title: 'Product snapshot',
  input: z.object({ productId: z.string().min(1).describe('Nexus product id') }),
  requires: [F.productsView],
  category: 'products',
  riskTier: 'low',
  readOnly: true,
  description:
    'Read a product and summarise its catalog completeness, and the channel listings Nexus holds for it and its '
    + 'variations: each one\'s channel, market and status; draft = Nexus has not sent it yet; linked = it carries the '
    + 'channel\'s own item id (an ASIN, an eBay item number), so the channel has an item it points at — a draft can be '
    + 'linked. hasAmazon / hasEbay are true when Nexus holds any listing on that channel, a draft included.',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    // MCP.12 — a deleted product (soft delete, `deletedAt`) is not found, as everywhere else in the app.
    const p = await prisma.product.findFirst({
      where: liveProduct(id),
      select: {
        sku: true,
        name: true,
        brand: true,
        productType: true,
        description: true,
        bulletPoints: true,
        keywords: true,
        status: true,
        _count: { select: { images: true, variations: true } },
      },
    })
    if (!p) return { ok: false, error: 'Product not found' }
    // MCP.12 — the listings themselves, not Product.amazonAsin / ebayItemId: those older columns are not written for
    // a listing made in Nexus, so the snapshot said "no eBay" while an eBay draft existed. A parent's listings are
    // usually its variations', so theirs count too.
    const listings = await prisma.channelListing.findMany({
      where: { OR: [{ productId: id }, { product: { parentId: id, deletedAt: null } }] },
      select: { channel: true, marketplace: true, listingStatus: true, externalListingId: true, product: { select: { sku: true } } },
      orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { product: { sku: 'asc' } }, { id: 'asc' }],
    })
    const gaps: string[] = []
    if (!p.brand) gaps.push('brand')
    if (!p.productType) gaps.push('productType')
    if (!p.description) gaps.push('description')
    if (!p.bulletPoints?.length) gaps.push('bulletPoints')
    if (!p.keywords?.length) gaps.push('keywords')
    if (!p._count.images) gaps.push('images')
    const on = (channel: string) => listings.some((l) => l.channel === channel)
    const drafts = listings.filter((l) => l.listingStatus === 'DRAFT').length
    return {
      ok: true,
      data: {
        sku: p.sku,
        name: p.name,
        brand: p.brand,
        productType: p.productType,
        status: p.status,
        hasAmazon: on('AMAZON'),
        hasEbay: on('EBAY'),
        listings: listings.slice(0, SNAPSHOT_LISTINGS).map((l) => ({
          sku: l.product.sku,
          channel: l.channel,
          market: l.marketplace,
          status: l.listingStatus,
          draft: l.listingStatus === 'DRAFT',
          // Not "published": 46 of 102 drafts in the development data carry an eBay item number (linked to an
          // existing item, not yet sent from Nexus), and "draft, published" read as a contradiction.
          linked: !!l.externalListingId,
        })),
        ...(listings.length > SNAPSHOT_LISTINGS ? { moreListings: listings.length - SNAPSHOT_LISTINGS } : {}),
        listingCounts: { total: listings.length, drafts, linked: listings.filter((l) => !!l.externalListingId).length },
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
  title: 'Search products',
  input: z.object({
    query: z.string().optional().describe('name, SKU or brand fragment'),
    limit: z.coerce.number().int().min(1).max(50).optional().describe('max products (default 10)'),
  }),
  requires: [F.productsView],
  category: 'products',
  riskTier: 'low',
  readOnly: true,
  description: 'Search the catalog by name / SKU / brand. The text is matched as typed: _ and % are characters, not wildcards.',
  async handler(args) {
    const q = String(args.query ?? '').trim()
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50)
    // MCP.12 — deleted products (soft delete) are never results, as in every other catalogue read.
    const where = q
      ? { deletedAt: null, OR: [{ name: ci(q) }, { sku: ci(q) }, { brand: ci(q) }] }
      : { deletedAt: null }
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
  title: 'Search orders',
  input: z.object({
    marketplace: z.string().optional().describe('marketplace code, e.g. IT'),
    buyer: z.string().optional().describe('buyer name or email fragment'),
    status: z.string().optional().describe('order status, e.g. shipped'),
    limit: z.coerce.number().int().min(1).max(100).optional().describe('max orders (default 20)'),
  }),
  requires: [F.ordersView],
  category: 'orders',
  riskTier: 'low',
  readOnly: true,
  description:
    'Find recent orders, optionally filtered by marketplace / buyer / status. The buyer text is matched as typed: _ and % are characters, not wildcards.',
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
  title: 'Order details',
  input: z.object({ orderId: z.string().min(1).describe('Nexus order id') }),
  requires: [F.ordersView],
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
  title: 'Stock levels',
  input: z.object({ productId: z.string().min(1).describe('Nexus product id') }),
  requires: [F.inventoryView],
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description: 'Current stock + per-channel listed quantity for a product.',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const p = await prisma.product.findFirst({
      where: liveProduct(id),
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
  title: 'Price status',
  input: z.object({ productId: z.string().min(1).describe('Nexus product id') }),
  requires: [F.pricingView],
  category: 'pricing',
  riskTier: 'low',
  readOnly: true,
  description: 'Master price + per-channel listed price for a product.',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    const p = await prisma.product.findFirst({
      where: liveProduct(id),
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
  title: 'Listing health',
  input: z.object({ productId: z.string().min(1).describe('Nexus product id') }),
  requires: [F.listingsView],
  category: 'listings',
  riskTier: 'low',
  readOnly: true,
  description:
    'Per-channel listing readiness for a product (what is blocking a clean publish). Each listing says draft (Nexus '
    + 'has not sent it yet) and linked (it carries the channel\'s own item id; a draft can be linked).',
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    // MCP.12 — a deleted product is not found; its listings are not read.
    if (!(await isLiveProduct(id))) return { ok: false, error: PRODUCT_NOT_FOUND }
    const rows = await prisma.channelListing.findMany({
      where: { productId: id },
      select: {
        channel: true,
        marketplace: true,
        title: true,
        price: true,
        quantity: true,
        externalListingId: true,
        listingStatus: true,
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
        // MCP.12 — was `published: !!externalListingId`, which read a linked draft as published. Nothing reads the
        // old field (web, API, scheduled agents: grepped), so the honest pair replaces it, as in product-snapshot.
        draft: r.listingStatus === 'DRAFT',
        linked: !!r.externalListingId,
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
