/**
 * SC.2 — Sync Control read surface (owner-approved program, read-only phase).
 *
 * Registered under /api/stock/sync-control so reads inherit the stock
 * inventoryView permission (permissions-manifest pfx('/api/stock')).
 *
 * Every quantity/mode shown here derives from resolveIntendedQuantity /
 * resolveMembershipIntended — the SAME core the cascade, dispatch and
 * read-backs consume — so the tab can never disagree with the engine.
 *
 *   GET /api/stock/sync-control/overview   — summary, locations, policies, audit
 *   GET /api/stock/sync-control/listings   — flat rows (listings + shared
 *       memberships), filters channel/market/mode/q, paginated
 */
import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import {
  resolveIntendedQuantity,
  resolveMembershipIntended,
  type RoutedLedgerRow,
} from '../services/sync-control-core.js'
import { loadChannelPolicies, policyFor } from '../services/sync-control-policy.service.js'

type Mode = 'FOLLOW' | 'PINNED' | 'PAUSED' | 'PAUSED_POLICY' | 'UNCOUNTED' | 'FBA' | 'EXCLUDED'

interface SyncControlRow {
  lane: 'LISTING' | 'SHARED'
  sku: string
  productId: string | null
  channel: string
  marketplace: string
  mode: Mode
  intendedQty: number | null
  liveQty: number | null
  buffer: number
  routedLocations: string[]
  itemId?: string
}

async function buildLedgers(productIds: string[]): Promise<Map<string, RoutedLedgerRow[]>> {
  const levels = await prisma.stockLevel.findMany({
    where: { productId: { in: productIds }, location: { type: 'WAREHOUSE' } },
    select: { productId: true, available: true, location: { select: { code: true, syncRoutes: true } } },
  })
  const map = new Map<string, RoutedLedgerRow[]>()
  for (const l of levels) {
    const arr = map.get(l.productId) ?? []
    arr.push({ locationCode: l.location?.code ?? '?', available: l.available, syncRoutes: l.location?.syncRoutes ?? [] })
    map.set(l.productId, arr)
  }
  return map
}

function modeOf(r: ReturnType<typeof resolveIntendedQuantity>, isShared: boolean): Mode {
  switch (r.kind) {
    case 'FBA_EXCLUDED': return 'FBA'
    case 'PAUSED': return r.via === 'POLICY' ? 'PAUSED_POLICY' : isShared ? 'EXCLUDED' : 'PAUSED'
    case 'PINNED': return 'PINNED'
    case 'UNCOUNTED': return 'UNCOUNTED'
    case 'FOLLOW': return 'FOLLOW'
  }
}

async function computeRows(): Promise<SyncControlRow[]> {
  const [listings, memberships, policies] = await Promise.all([
    prisma.channelListing.findMany({
      where: { isPublished: true, listingStatus: { notIn: ['ENDED', 'REMOVED'] } },
      select: {
        productId: true, channel: true, marketplace: true, quantity: true, stockBuffer: true,
        followMasterQuantity: true, fulfillmentMethod: true, syncPaused: true, sourceLocationCodes: true,
        product: { select: { sku: true, fulfillmentMethod: true } },
      },
    }),
    prisma.sharedListingMembership.findMany({
      where: { status: 'ACTIVE' },
      select: { sku: true, itemId: true, marketplace: true, productId: true, lastQtyPushed: true, followPool: true, stockBuffer: true },
    }),
    loadChannelPolicies(),
  ])
  const productIds = [
    ...new Set([
      ...listings.map((l) => l.productId),
      ...memberships.map((m) => m.productId).filter((p): p is string => Boolean(p)),
    ]),
  ]
  const ledgers = await buildLedgers(productIds)
  const rows: SyncControlRow[] = []

  for (const cl of listings) {
    const isFba =
      cl.fulfillmentMethod === 'FBA' ||
      (cl.fulfillmentMethod == null && cl.product?.fulfillmentMethod === 'FBA') ||
      cl.product?.fulfillmentMethod === 'FBA'
    const r = resolveIntendedQuantity({
      channel: cl.channel,
      marketplace: cl.marketplace,
      isFba,
      followMasterQuantity: cl.followMasterQuantity,
      syncPaused: cl.syncPaused,
      pinnedQuantity: cl.quantity,
      stockBuffer: cl.stockBuffer ?? 0,
      sourceLocationCodes: cl.sourceLocationCodes ?? [],
      channelPolicy: policyFor(policies, cl.channel, cl.marketplace),
      ledger: ledgers.get(cl.productId) ?? [],
    })
    rows.push({
      lane: 'LISTING',
      sku: cl.product?.sku ?? '?',
      productId: cl.productId,
      channel: cl.channel,
      marketplace: cl.marketplace,
      mode: modeOf(r, false),
      intendedQty: r.kind === 'FOLLOW' ? r.quantity : r.kind === 'PINNED' ? r.quantity : null,
      liveQty: cl.quantity,
      buffer: cl.stockBuffer ?? 0,
      routedLocations: r.kind === 'FOLLOW' ? r.routedLocations : [],
    })
  }

  for (const m of memberships) {
    const r = resolveMembershipIntended({
      marketplace: m.marketplace,
      followPool: m.followPool ?? true,
      stockBuffer: m.stockBuffer ?? 0,
      channelPolicy: policyFor(policies, 'EBAY', m.marketplace),
      ledger: m.productId ? (ledgers.get(m.productId) ?? []) : [],
    })
    rows.push({
      lane: 'SHARED',
      sku: m.sku,
      productId: m.productId,
      channel: 'EBAY',
      marketplace: m.marketplace,
      mode: modeOf(r, true),
      intendedQty: r.kind === 'FOLLOW' ? r.quantity : null,
      liveQty: m.lastQtyPushed,
      buffer: m.stockBuffer ?? 0,
      routedLocations: r.kind === 'FOLLOW' ? r.routedLocations : [],
      itemId: m.itemId,
    })
  }
  return rows
}

export default async function syncControlRoutes(app: FastifyInstance): Promise<void> {
  app.get('/stock/sync-control/overview', async () => {
    try {
      const [rows, locations, policies, audit] = await Promise.all([
        computeRows(),
        prisma.stockLocation.findMany({
          select: {
            code: true, name: true, type: true, isActive: true,
            syncRoutes: true, servesMarketplaces: true,
            stockLevels: { select: { quantity: true } },
          },
          orderBy: { code: 'asc' },
        }),
        prisma.syncChannelPolicy.findMany({ orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }] }),
        prisma.syncControlAudit.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
      ])
      const byMode: Record<string, number> = {}
      for (const r of rows) byMode[r.mode] = (byMode[r.mode] ?? 0) + 1
      return {
        summary: {
          rows: rows.length,
          listings: rows.filter((r) => r.lane === 'LISTING').length,
          shared: rows.filter((r) => r.lane === 'SHARED').length,
          products: new Set(rows.map((r) => r.productId).filter(Boolean)).size,
          byMode,
          routedLocations: locations.filter((l) => (l.syncRoutes ?? []).length > 0).length,
          policies: policies.length,
        },
        locations: locations.map((l) => ({
          code: l.code, name: l.name, type: l.type, isActive: l.isActive,
          syncRoutes: l.syncRoutes ?? [],
          servesMarketplaces: l.servesMarketplaces ?? [],
          stockUnits: l.stockLevels.reduce((s, x) => s + x.quantity, 0),
        })),
        policies,
        audit,
      }
    } catch (err) {
      logger.error('[sync-control] overview failed', { error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  })

  app.get('/stock/sync-control/listings', async (request) => {
    const q = request.query as { channel?: string; market?: string; mode?: string; q?: string; page?: string; pageSize?: string }
    const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1)
    const pageSize = Math.min(200, Math.max(10, Number.parseInt(q.pageSize ?? '50', 10) || 50))
    let rows = await computeRows()
    if (q.channel) rows = rows.filter((r) => r.channel === q.channel!.toUpperCase())
    if (q.market) rows = rows.filter((r) => r.marketplace.toUpperCase().replace(/^EBAY_/, '') === q.market!.toUpperCase())
    if (q.mode) rows = rows.filter((r) => r.mode === q.mode!.toUpperCase())
    if (q.q) {
      const needle = q.q.toLowerCase()
      rows = rows.filter((r) => r.sku.toLowerCase().includes(needle))
    }
    rows.sort((a, b) => a.sku.localeCompare(b.sku) || a.channel.localeCompare(b.channel) || a.marketplace.localeCompare(b.marketplace))
    const total = rows.length
    return { total, page, pageSize, rows: rows.slice((page - 1) * pageSize, page * pageSize) }
  })
}
