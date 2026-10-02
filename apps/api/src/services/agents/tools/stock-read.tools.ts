/**
 * MCP full control 08 S3 — stock reads for Claude: per-location stock, the ledger (transfers included), locations and
 * their routes and sync policies, reservations, cycle counts, shared stock and FBA.
 *
 * Read-only and low risk: this business's own database — no marketplace call, no gateway, no queue. The business is
 * the one call-tool.ts bound; no argument names one. The reads are the stock page's own (services/stock/
 * stock-read.service.ts, moved out of the routes) plus keyset pages for the lists. Every location says who owns its
 * number: `nexus` (it can change in Nexus), `amazon-fba` (the FBA mirror: Amazon's number, written only by the FBA
 * inventory sync; nothing here or in any tool changes it) or `shopify` (Shopify's own number).
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import {
  DEFAULT_PAGE_SIZE,
  InvalidCursorError,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
  cursorScope,
  decodeCursor,
  encodeCursor,
  pageSize,
} from '../../../lib/pagination/cursor.js'
import {
  STOCK_BANDS,
  listCycleCounts,
  listStockLocations,
  listStockReservations,
  locationOwner,
  readCycleCount,
  readProductStock,
  stockBand,
  stockMovementPage,
  stockRowPage,
  type StockBand,
} from '../../stock/stock-read.service.js'
import { findDueForCount, getCadenceConfig } from '../../cycle-count-scheduler.service.js'
import { listGrants } from '../../stock-pool/pool-grants.service.js'
import { loadPoolSources } from '../../stock-pool/pool-sources.js'
import { computePoolDrift } from '../../fulfillment-pool-drift.service.js'
import { getAgedInventory, getUnfulfillable, listPerFcTotals } from '../../fba-pan-eu.service.js'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { isLiveProduct, PRODUCT_NOT_FOUND } from './live-product.js'

/** Nested lists are cut to this many entries (the rest is counted); texts to TEXT_CAP characters. */
const NESTED_CAP = 20
const TEXT_CAP = 200
const clip = (text: string | null | undefined, cap = TEXT_CAP) => (text == null ? null : text.length > cap ? `${text.slice(0, cap - 1)}…` : text)
const iso = (at: Date | string | null | undefined) => (at == null ? null : at instanceof Date ? at.toISOString() : at)
const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)
/** A yes/no argument; the words true and false count as one (z.coerce.boolean would read "false" as true). */
const flag = z.preprocess((value) => (value === 'true' ? true : value === 'false' ? false : value), z.boolean())

const LOCATION_TYPES = ['WAREHOUSE', 'AMAZON_FBA', 'SHOPIFY_LOCATION', 'CHANNEL_RESERVED'] as const
const FBA_NOTE = 'FBA stock is Amazon-managed: Nexus mirrors it (the FBA inventory sync is its only writer) and no tool changes it.'

const limitArg = (what: string) => z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional()
  .describe(`${what} per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE})`)
const cursorArg = z.string().min(1).max(MAX_CURSOR_LENGTH).optional()
  .describe('nextCursor from the previous page, with the same filters; omit it for the first page')

/** A cursor belongs to one tool, one business and one set of filters. */
function scopeOf(tool: string, args: Record<string, unknown>): string {
  const { limit: _limit, cursor: _cursor, ...filters } = args
  return cursorScope(tool, { business: workspaceIdForQuery(), ...filters })
}

/** A bad cursor is a wrongly made call, said the way call-tool.ts says one; anything else is a real failure. */
async function readTool(name: string, work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof InvalidCursorError) return { ok: false, error: `${name} was called wrongly — cursor: ${error.message}` }
    throw error
  }
}

/** A location as every stock tool shows it: its code and name, its type and who owns its number. */
function locationView(location: { code: string; name?: string | null; type: string }) {
  return { code: location.code, ...(location.name != null ? { name: location.name } : {}), type: location.type, ...locationOwner(location.type) }
}

const capped = <T>(list: T[], cap = NESTED_CAP) => ({ shown: list.slice(0, cap), more: Math.max(0, list.length - cap) })

// ── stock-levels (changed): one product, per location ──────────────────────────────────────────────────

const stockLevels: AgentTool = {
  name: 'stock-levels',
  title: 'Stock levels',
  input: z.object({ productId: z.string().min(1).describe('Nexus product id') }),
  requires: [F.inventoryView],
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'One product\'s stock: per location (code, type, who owns the number — nexus, amazon-fba or shopify — quantity, '
    + 'reserved, available), the totals, what is available to promise with open inbound, where its listings take '
    + 'their number (stockSource: own, or a pool another business lends), the active reservations, and per channel '
    + 'listing the quantity listed and the quantity Nexus would send. A parent also lists its variations. '
    + FBA_NOTE,
  async handler(args) {
    const id = String(args.productId ?? '')
    if (!id) return { ok: false, error: 'productId is required' }
    if (!(await isLiveProduct(id))) return { ok: false, error: PRODUCT_NOT_FOUND }
    const bundle = await readProductStock(id, { family: true })
    if (!bundle) return { ok: false, error: PRODUCT_NOT_FOUND }
    const p = bundle.product
    const levels = bundle.stockLevels
    const fbaOnHand = levels.filter((l) => l.location.type === 'AMAZON_FBA').reduce((sum, l) => sum + l.quantity, 0)
    const reservations = capped(bundle.reservations)
    const channels = capped(bundle.atpPerChannel)
    const variations = bundle.family ? capped(bundle.family.children) : null
    const pool = bundle.poolSource
    return {
      ok: true,
      data: {
        sku: p.sku,
        name: p.name,
        totalStock: p.totalStock,
        lowStockThreshold: p.lowStockThreshold,
        lowStock: p.totalStock <= p.lowStockThreshold,
        stockSource: pool
          ? { kind: 'pool', lender: pool.lenderName, quantity: pool.quantity, reserved: pool.reserved, available: pool.available,
              note: 'Its listings sell from this shared stock; the business that lends it counts it.' }
          : { kind: 'own' },
        locations: levels.map((l) => ({
          ...locationView(l.location),
          quantity: l.quantity,
          reserved: l.reserved,
          available: l.available,
          activeReservations: l.activeReservations,
          lastUpdatedAt: iso(l.lastUpdatedAt),
        })),
        totals: {
          onHand: levels.reduce((sum, l) => sum + l.quantity, 0),
          reserved: levels.reduce((sum, l) => sum + l.reserved, 0),
          available: levels.reduce((sum, l) => sum + l.available, 0),
          fbaOnHand,
        },
        availableToPromise: bundle.atp
          ? { available: bundle.atp.totalAvailable, inboundWithinLeadTime: bundle.atp.inboundWithinLeadTime, openInbound: bundle.atp.totalOpenInbound, leadTimeDays: bundle.atp.leadTimeDays }
          : null,
        channels: channels.shown.map((c) => ({
          channel: c.channel,
          marketplace: c.marketplace,
          fulfillment: c.fulfillmentMethod,
          status: c.listingStatus,
          listed: c.channelQuantity,
          wouldSend: c.available,
          from: c.source === 'SHARED_POOL' ? `shared stock of ${c.poolLenderName ?? 'another business'}` : c.resolvedLocationCode,
          buffer: c.stockBuffer,
          followsStock: c.followMasterQuantity,
        })),
        ...(channels.more ? { moreChannels: channels.more } : {}),
        reservations: reservations.shown.map((r) => ({
          quantity: r.quantity,
          reason: r.reason,
          location: r.location.code,
          orderId: r.orderId,
          expiresAt: iso(r.expiresAt),
          ...(r.usedBy ? { forBusiness: r.usedBy.businessName, orderRef: r.usedBy.orderRef } : {}),
        })),
        ...(reservations.more ? { moreReservations: reservations.more } : {}),
        ...(variations
          ? {
              variations: variations.shown.map((v) => ({
                productId: v.id, sku: v.sku, onHand: v.totalStock, reserved: v.totalReserved, available: v.totalAvailable,
                sellsFromPool: !!v.poolSource,
              })),
              ...(variations.more ? { moreVariations: variations.more } : {}),
            }
          : {}),
        ...(fbaOnHand > 0 ? { note: FBA_NOTE } : {}),
      },
    }
  },
}

// ── stock-search: stock rows by text, location and band ────────────────────────────────────────────────

const STOCK_SEARCH = 'stock-search'
const stockSearch: AgentTool = {
  name: STOCK_SEARCH,
  title: 'Search stock',
  input: z.object({
    query: z.string().trim().min(1).max(100).optional().describe('SKU, product name or ASIN fragment'),
    location: z.string().trim().min(1).max(64).optional().describe('only this location code, e.g. IT-MAIN (see stock-locations)'),
    locationType: z.preprocess(upper, z.enum(LOCATION_TYPES)).optional().describe('only locations of this type'),
    band: z.preprocess(lower, z.enum(Object.keys(STOCK_BANDS) as [StockBand, ...StockBand[]])).optional()
      .describe('the stock page\'s bands: out = 0, critical = 1–5, low = 6–15, in-stock = more than 15'),
    belowThreshold: flag.optional().describe('only rows at or below the product\'s own low-stock threshold'),
    limit: limitArg('stock rows'),
    cursor: cursorArg,
  }),
  requires: [F.inventoryView],
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'Find stock rows (one product at one location) by SKU, name or ASIN, location, location type, the stock page\'s '
    + 'bands (out, critical, low, in-stock) or "at or below the product\'s own threshold". Each row: product, location '
    + '(and who owns its number), quantity, reserved, available, band, and whether the product sells from shared stock. '
    + 'Products that sell only from another business\'s stock have no row here: see shared-stock. Returns { items, '
    + 'nextCursor }.',
  handler: (args) => readTool(STOCK_SEARCH, async () => {
    const a = args as { query?: string; location?: string; locationType?: string; band?: StockBand; belowThreshold?: boolean; limit?: number; cursor?: string }
    const size = pageSize(a.limit)
    const scope = scopeOf(STOCK_SEARCH, args)
    const start = decodeCursor(scope, a.cursor)
    const after = start ? { sku: String(start.values[0]), locationCode: String(start.values[1]), id: start.id } : null
    const page = await stockRowPage({
      text: a.query, locationCode: a.location, locationType: a.locationType, band: a.band, belowThreshold: a.belowThreshold, after, take: size,
    })
    const pools = await loadPoolSources(prisma, [...new Set(page.items.map((r) => r.product.id))])
    return {
      ok: true,
      data: {
        items: page.items.map((r) => ({
          productId: r.product.id,
          sku: r.product.sku,
          name: r.product.name,
          location: locationView(r.location),
          quantity: r.quantity,
          reserved: r.reserved,
          available: r.available,
          band: stockBand(r.quantity),
          belowThreshold: r.quantity <= r.product.lowStockThreshold,
          ...(r.variationId ? { variationId: r.variationId } : {}),
          ...(pools.has(r.product.id) ? { sellsFromPool: true } : {}),
        })),
        nextCursor: page.next ? encodeCursor(scope, { values: [page.next.sku, page.next.locationCode], id: page.next.id }) : null,
      },
    }
  }),
}

// ── stock-locations: locations, their routes and the channel sync policies ────────────────────────────

const stockLocations: AgentTool = {
  name: 'stock-locations',
  title: 'Stock locations',
  input: z.object({
    includeInactive: flag.optional().describe('also list locations that are switched off (default: active only)'),
  }),
  requires: [F.inventoryView],
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'Every stock location: code, name, type, who owns its number (nexus, amazon-fba, shopify), the markets it serves, '
    + 'its Sync Control routes (which channels and markets take their number from it; none = all), and its totals '
    + '(SKUs, on hand, reserved, available). Also the channel sync policies: a channel or market whose stock pushes '
    + 'are paused, and the mode new listings start in. ' + FBA_NOTE,
  async handler(args) {
    const includeInactive = args.includeInactive === true
    const [{ locations }, routes, policies] = await Promise.all([
      listStockLocations(),
      prisma.stockLocation.findMany({ select: { id: true, syncRoutes: true } }),
      prisma.syncChannelPolicy.findMany({ orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }] }),
    ])
    const routesOf = new Map(routes.map((r) => [r.id, r.syncRoutes ?? []]))
    const shown = locations.filter((l) => includeInactive || l.isActive)
    return {
      ok: true,
      data: {
        locations: shown.map((l) => ({
          id: l.id,
          ...locationView(l),
          isActive: l.isActive,
          servesMarketplaces: l.servesMarketplaces,
          syncRoutes: routesOf.get(l.id) ?? [],
          skuCount: l.skuCount,
          onHand: l.totalQuantity,
          reserved: l.totalReserved,
          available: l.totalAvailable,
        })),
        ...(shown.length < locations.length ? { inactiveNotShown: locations.length - shown.length } : {}),
        syncPolicies: policies.map((p) => ({
          channel: p.channel,
          market: p.marketplace === '*' ? 'every market' : p.marketplace,
          account: p.channelConnectionId ? 'one account' : 'every account',
          pushesPaused: p.pushesPaused,
          newListingsStart: p.newListingDefaultMode === 'PAUSED' ? 'paused' : 'following stock',
        })),
      },
    }
  },
}

// ── stock-movements: the ledger, transfers included ────────────────────────────────────────────────────

const REASONS = [
  'ORDER_PLACED', 'ORDER_CANCELLED', 'ORDER_REFUNDED', 'RETURN_RECEIVED', 'RETURN_RESTOCKED', 'INBOUND_RECEIVED',
  'SUPPLIER_DELIVERY', 'MANUFACTURING_OUTPUT', 'FBA_TRANSFER_OUT', 'FBA_TRANSFER_IN', 'MANUAL_ADJUSTMENT', 'INVENTORY_COUNT',
  'WRITE_OFF', 'RESERVATION_RELEASED', 'SYNC_RECONCILIATION', 'RESERVATION_CREATED', 'RESERVATION_CONSUMED', 'TRANSFER_OUT',
  'TRANSFER_IN', 'PARENT_PRODUCT_CLEANUP', 'STOCKLEVEL_BACKFILL', 'CHANNEL_STOCK_RECONCILIATION',
] as const
/** Kinds a person asks for, each a set of ledger reasons. */
const KINDS: Record<string, readonly (typeof REASONS)[number][]> = {
  transfers: ['TRANSFER_OUT', 'TRANSFER_IN'],
  adjustments: ['MANUAL_ADJUSTMENT', 'WRITE_OFF'],
  counts: ['INVENTORY_COUNT'],
  sales: ['ORDER_PLACED', 'ORDER_CANCELLED', 'ORDER_REFUNDED'],
  returns: ['RETURN_RECEIVED', 'RETURN_RESTOCKED'],
  receiving: ['INBOUND_RECEIVED', 'SUPPLIER_DELIVERY', 'MANUFACTURING_OUTPUT'],
  sync: ['SYNC_RECONCILIATION', 'CHANNEL_STOCK_RECONCILIATION'],
  fba: ['FBA_TRANSFER_OUT', 'FBA_TRANSFER_IN'],
}
const KIND_NAMES = Object.keys(KINDS) as [string, ...string[]]

const STOCK_MOVEMENTS = 'stock-movements'
const stockMovements: AgentTool = {
  name: STOCK_MOVEMENTS,
  title: 'Stock movements',
  input: z.object({
    productId: z.string().trim().min(1).max(64).optional().describe('only this Nexus product id'),
    sku: z.string().trim().min(1).max(100).optional().describe('only the product with exactly this SKU'),
    location: z.string().trim().min(1).max(64).optional().describe('only movements at, from or to this location code'),
    kind: z.preprocess(lower, z.enum(KIND_NAMES)).optional()
      .describe('only one kind: transfers, adjustments, counts, sales, returns, receiving, sync (FBA sync and channel numbers) or fba'),
    reason: z.preprocess(upper, z.enum(REASONS)).optional().describe('only this exact ledger reason'),
    since: z.string().trim().min(10).max(40).refine((v) => !Number.isNaN(Date.parse(v)), 'an ISO date, e.g. 2026-09-01').optional()
      .describe('only movements at or after this time (ISO date or date-time)'),
    limit: limitArg('movements'),
    cursor: cursorArg,
  }),
  requires: [F.inventoryView],
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'The stock ledger, newest first: every change to a product\'s stock at a location, with the change, the balance '
    + 'after it, the reason, what caused it (order, return, count, transfer…), who, and when. A transfer is two rows '
    + '(TRANSFER_OUT at the source, TRANSFER_IN at the destination), both naming from and to; kind = transfers lists '
    + 'only those. A row made for another business\'s order (shared stock) names that business. Returns { items, '
    + 'nextCursor }.',
  handler: (args) => readTool(STOCK_MOVEMENTS, async () => {
    const a = args as { productId?: string; sku?: string; location?: string; kind?: string; reason?: string; since?: string; limit?: number; cursor?: string }
    if (a.productId && !(await isLiveProduct(a.productId))) return { ok: false, error: PRODUCT_NOT_FOUND }
    const size = pageSize(a.limit)
    const scope = scopeOf(STOCK_MOVEMENTS, args)
    const start = decodeCursor(scope, a.cursor)
    const reasons = a.reason ? [a.reason] : a.kind ? [...KINDS[a.kind]] : undefined
    const page = await stockMovementPage({
      productId: a.productId, sku: a.sku, locationCode: a.location, reasons, since: a.since ? new Date(a.since) : undefined,
      after: start ? { at: String(start.values[0]), id: start.id } : null, take: size,
    })
    const names = await businessNames(page.items.map((m) => m.consumerWorkspaceId))
    return {
      ok: true,
      data: {
        items: page.items.map((m) => ({
          id: m.id,
          at: iso(m.createdAt),
          productId: m.productId,
          sku: m.product.sku,
          location: m.location ? locationView(m.location) : null,
          change: m.change,
          balanceAfter: m.balanceAfter,
          reason: m.reason,
          ...(m.fromLocation || m.toLocation ? { from: m.fromLocation?.code ?? null, to: m.toLocation?.code ?? null } : {}),
          ...(m.referenceType ? { cause: { type: m.referenceType, id: m.referenceId } } : {}),
          ...(m.orderId ? { orderId: m.orderId } : {}),
          ...(m.consumerWorkspaceId ? { forBusiness: names.get(m.consumerWorkspaceId) ?? 'another business', orderRef: m.consumerOrderRef } : {}),
          actor: m.actor,
          notes: clip(m.notes),
        })),
        nextCursor: page.next ? encodeCursor(scope, { values: [page.next.at], id: page.next.id }) : null,
      },
    }
  }),
}

/** The names of the businesses a lender's movements and holds were made for (shared stock). */
async function businessNames(ids: Array<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))]
  if (!wanted.length) return new Map()
  const rows = await prisma.workspace.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } })
  return new Map(rows.map((r) => [r.id, r.name]))
}

// ── stock-reservations ────────────────────────────────────────────────────────────────────────────────

const RESERVATION_STATUSES = ['active', 'consumed', 'released', 'all'] as const
const stockReservations: AgentTool = {
  name: 'stock-reservations',
  title: 'Stock reservations',
  input: z.object({
    status: z.preprocess(lower, z.enum(RESERVATION_STATUSES)).optional().describe('active (default), consumed, released or all'),
    limit: limitArg('reservations'),
  }),
  requires: [F.inventoryView],
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'Stock held for orders and by hand, newest first: quantity, reason (PENDING_ORDER, OPEN_ORDER, MANUAL_HOLD, '
    + 'PROMOTION, CART_HOLD), status (active, expired, consumed, released), the order, the location and product, and '
    + 'the stock level it holds from. One product\'s active holds are also in stock-levels.',
  async handler(args) {
    const status = (args.status as string | undefined) ?? 'active'
    const limit = pageSize(args.limit as number | undefined)
    const out = await listStockReservations({ status, limit })
    return {
      ok: true,
      data: {
        status,
        count: out.count,
        reservations: out.reservations.map((r) => ({
          id: r.id,
          quantity: r.quantity,
          reason: r.reason,
          status: r.status,
          orderId: r.orderId,
          createdAt: iso(r.createdAt),
          expiresAt: iso(r.expiresAt),
          location: locationView(r.location),
          product: r.product ? { productId: r.product.id, sku: r.product.sku, name: r.product.name } : null,
          stockLevel: r.stockLevel,
        })),
        ...(out.count === limit ? { note: `The newest ${limit}; raise limit (max ${MAX_PAGE_SIZE}) or narrow by status for more.` } : {}),
      },
    }
  },
}

// ── cycle-counts ──────────────────────────────────────────────────────────────────────────────────────

const COUNT_STATUSES = ['DRAFT', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'ALL'] as const
const COUNT_ITEMS_CAP = 100
const cycleCounts: AgentTool = {
  name: 'cycle-counts',
  title: 'Cycle counts',
  input: z.object({
    countId: z.string().trim().min(1).max(64).optional().describe('one count: its items, expected and counted quantities'),
    status: z.preprocess(upper, z.enum(COUNT_STATUSES)).optional().describe('only counts in this status (default ALL)'),
    dueAt: z.string().trim().min(1).max(64).optional()
      .describe('a location code: also list the products due for a count there (by their ABC class cadence)'),
    limit: limitArg('counts'),
  }),
  requires: [F.inventoryView],
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'Stock counts. Without countId: the counts, newest first, each with its location, status and item totals '
    + '(pending, counted, reconciled, ignored). With countId: that count and its items (SKU, expected, counted, '
    + 'variance, status), the first 100. With dueAt (a location code): the products due for a count there. Counting '
    + 'and reconciling happen in Nexus.',
  async handler(args) {
    const countId = args.countId as string | undefined
    if (countId) {
      const count = await readCycleCount(countId)
      if (!count) return { ok: false, error: 'Cycle count not found' }
      const items = capped(count.items, COUNT_ITEMS_CAP)
      return {
        ok: true,
        data: {
          id: count.id,
          status: count.status,
          location: locationView({ code: count.location.code, name: count.location.name, type: (await locationType(count.locationId)) ?? 'WAREHOUSE' }),
          notes: clip(count.notes),
          startedAt: iso(count.startedAt),
          completedAt: iso(count.completedAt),
          items: items.shown.map((i) => ({
            productId: i.productId, sku: i.sku, name: i.productName, expected: i.expectedQuantity, counted: i.countedQuantity,
            variance: i.variance, status: i.status,
          })),
          ...(items.more ? { moreItems: items.more } : {}),
        },
      }
    }
    const status = (args.status as string | undefined) ?? 'ALL'
    const limit = pageSize(args.limit as number | undefined)
    const counts = await listCycleCounts({ status: status === 'ALL' ? 'all' : status, limit: String(limit) })
    const dueAt = args.dueAt as string | undefined
    let due: unknown = undefined
    if (dueAt) {
      const location = await prisma.stockLocation.findFirst({ where: { code: dueAt }, select: { id: true } })
      if (!location) return { ok: false, error: `Location ${dueAt} not found` }
      const rows = await findDueForCount({ locationId: location.id, cadence: getCadenceConfig(), limit: NESTED_CAP })
      due = rows.map((r) => ({ productId: r.productId, sku: r.sku, quantity: r.quantity, abcClass: r.abcClass, lastCountedAt: iso(r.lastCountedAt) }))
    }
    return {
      ok: true,
      data: {
        counts: counts.map((c) => ({
          id: c.id,
          status: c.status,
          location: { code: c.location.code, name: c.location.name },
          notes: clip(c.notes),
          createdAt: iso(c.createdAt),
          startedAt: iso(c.startedAt),
          completedAt: iso(c.completedAt),
          items: c.itemTotals,
          totalItems: c.totalItems,
        })),
        ...(due !== undefined ? { dueForCount: { location: dueAt, products: due } } : {}),
      },
    }
  },
}

async function locationType(id: string): Promise<string | null> {
  return (await prisma.stockLocation.findUnique({ where: { id }, select: { type: true } }))?.type ?? null
}

// ── shared-stock ──────────────────────────────────────────────────────────────────────────────────────

const sharedStock: AgentTool = {
  name: 'shared-stock',
  title: 'Shared stock',
  input: z.object({
    sku: z.string().trim().min(1).max(100).optional()
      .describe('a SKU, or the start of one: where each matching product\'s listings take their number from'),
  }),
  requires: [F.inventoryView],
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'Shared stock between this business and others: what this business lends (to whom, which warehouses, how many '
    + 'products sell from it) and what it borrows (from whom, status). With sku: for each matching product, whether '
    + 'its listings sell from its own stock or from a pool another business lends, with the pool\'s numbers. Also the '
    + 'listings that show more than their stock can back (oversold), worst first. Sharing is set up and changed in '
    + 'Nexus by an owner, never here.',
  async handler(args) {
    const sku = args.sku as string | undefined
    const [grants, drift] = await Promise.all([listGrants(), computePoolDrift({ limit: 2000 })])
    const grantView = (g: Awaited<ReturnType<typeof listGrants>>['lending'][number]) => ({
      id: g.id,
      ...(g.side === 'lender' ? { lendsTo: g.workspaceName } : { borrowsFrom: g.ownerWorkspaceName }),
      status: g.status,
      warehouses: g.locations.map((l) => ({ code: l.code, name: l.name, usable: l.usable })),
      productsSellingFromIt: g.linkedProducts,
      since: iso(g.respondedAt ?? g.createdAt),
    })
    let products: unknown = undefined
    if (sku) {
      const rows = await prisma.product.findMany({
        where: { deletedAt: null, isParent: false, sku: { startsWith: sku, mode: 'insensitive' } },
        orderBy: { sku: 'asc' },
        take: NESTED_CAP + 1,
        select: { id: true, sku: true, name: true, stockLevels: { select: { quantity: true, available: true, location: { select: { type: true } } } } },
      })
      const pools = await loadPoolSources(prisma, rows.map((r) => r.id))
      products = rows.slice(0, NESTED_CAP).map((r) => {
        const pool = pools.get(r.id)
        const own = r.stockLevels.filter((l) => l.location.type === 'WAREHOUSE')
        return {
          productId: r.id,
          sku: r.sku,
          name: r.name,
          sellsFrom: pool ? 'pool' : 'own',
          ...(pool ? { lender: pool.lenderName, pool: { quantity: pool.quantity, reserved: pool.reserved, available: pool.available } } : {}),
          own: { onHand: own.reduce((s, l) => s + l.quantity, 0), available: own.reduce((s, l) => s + l.available, 0) },
        }
      })
      if (rows.length > NESTED_CAP) products = { shown: products, more: 'more products match: use a longer SKU' }
    }
    const oversold = drift.rows.filter((r) => r.drift > 0).slice(0, NESTED_CAP)
    return {
      ok: true,
      data: {
        lending: grants.lending.map(grantView),
        borrowing: grants.borrowing.map(grantView),
        ...(products !== undefined ? { products } : {}),
        oversold: oversold.map((r) => ({
          productId: r.productId, sku: r.sku, channel: r.channel, marketplace: r.marketplace, fulfillment: r.fulfillmentMethod,
          listed: r.publishedQty, canBack: r.availableToPublish, over: r.drift,
        })),
        ...(drift.oversold > oversold.length ? { moreOversold: drift.oversold - oversold.length } : {}),
      },
    }
  },
}

// ── fba-inventory (read-only) ─────────────────────────────────────────────────────────────────────────

const FBA_INVENTORY = 'fba-inventory'
const fbaInventory: AgentTool = {
  name: FBA_INVENTORY,
  title: 'FBA inventory',
  input: z.object({
    productId: z.string().trim().min(1).max(64).optional().describe('only this Nexus product id'),
    sku: z.string().trim().min(1).max(100).optional().describe('only the product with exactly this SKU'),
    limit: limitArg('FBA stock rows'),
    cursor: cursorArg,
  }),
  requires: [F.inventoryView, F.replenishmentView],
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'Amazon FBA stock as Nexus mirrors it, read-only: per product the FBA location\'s quantity, reserved and '
    + 'available; per fulfilment centre and condition (sellable, unfulfillable, inbound, reserved, researching) from '
    + 'the Pan-EU report; aged units (over 180 days) and unfulfillable units; and, for one product, Amazon\'s latest '
    + 'restock recommendation per market. ' + FBA_NOTE + ' Returns { items, nextCursor, … }.',
  handler: (args) => readTool(FBA_INVENTORY, async () => {
    const a = args as { productId?: string; sku?: string; limit?: number; cursor?: string }
    if (a.productId && !(await isLiveProduct(a.productId))) return { ok: false, error: PRODUCT_NOT_FOUND }
    const size = pageSize(a.limit)
    const scope = scopeOf(FBA_INVENTORY, args)
    const start = decodeCursor(scope, a.cursor)
    const after = start ? { sku: String(start.values[0]), locationCode: String(start.values[1]), id: start.id } : null
    const oneProduct = a.productId || a.sku
    const productFilter = a.productId ? { id: a.productId } : a.sku ? { sku: a.sku } : {}
    const rows = await prisma.stockLevel.findMany({
      where: {
        location: { type: 'AMAZON_FBA' },
        product: { deletedAt: null, ...productFilter },
        ...(after ? { OR: [
          { product: { sku: { gt: after.sku } } },
          { product: { sku: after.sku }, location: { code: { gt: after.locationCode } } },
          { product: { sku: after.sku }, location: { code: after.locationCode }, id: { gt: after.id } },
        ] } : {}),
      },
      orderBy: [{ product: { sku: 'asc' } }, { location: { code: 'asc' } }, { id: 'asc' }],
      take: size + 1,
      select: {
        id: true, quantity: true, reserved: true, available: true, lastUpdatedAt: true,
        location: { select: { code: true, name: true, type: true } },
        product: { select: { id: true, sku: true, name: true } },
      },
    })
    const page = rows.slice(0, size)
    const last = page.at(-1)
    const items = page.map((r) => ({
      productId: r.product.id, sku: r.product.sku, name: r.product.name, location: locationView(r.location),
      quantity: r.quantity, reserved: r.reserved, available: r.available, mirroredAt: iso(r.lastUpdatedAt),
    }))
    const nextCursor = rows.length > size && last ? encodeCursor(scope, { values: [last.product.sku, last.location.code], id: last.id }) : null
    if (oneProduct) {
      const skus = [...new Set(page.map((r) => r.product.sku).concat(a.sku ? [a.sku] : []))]
      const [details, restock] = await Promise.all([
        prisma.fbaInventoryDetail.findMany({
          where: { sku: { in: skus }, ...(a.productId ? { OR: [{ productId: a.productId }, { productId: null }] } : {}) },
          orderBy: [{ marketplaceId: 'asc' }, { fulfillmentCenterId: 'asc' }, { condition: 'asc' }],
          take: NESTED_CAP,
          select: { sku: true, marketplaceId: true, fulfillmentCenterId: true, condition: true, quantity: true, firstReceivedAt: true, lastSyncedAt: true },
        }),
        prisma.fbaRestockRow.findMany({
          where: { sku: { in: skus } },
          orderBy: [{ asOf: 'desc' }],
          take: NESTED_CAP,
          select: {
            sku: true, marketplace: true, recommendedReplenishmentQty: true, daysOfSupply: true, recommendedShipDate: true,
            daysToInbound: true, salesPace30dUnits: true, salesShortageUnits: true, alertType: true, asOf: true,
          },
        }),
      ])
      const latest = new Map<string, (typeof restock)[number]>()
      for (const r of restock) if (!latest.has(`${r.sku}:${r.marketplace}`)) latest.set(`${r.sku}:${r.marketplace}`, r)
      return {
        ok: true,
        data: {
          items,
          nextCursor,
          byFulfilmentCentre: details.map((d) => ({ ...d, firstReceivedAt: iso(d.firstReceivedAt), lastSyncedAt: iso(d.lastSyncedAt) })),
          restock: [...latest.values()].map((r) => ({
            sku: r.sku, marketplace: r.marketplace, recommendedQuantity: r.recommendedReplenishmentQty,
            daysOfSupply: r.daysOfSupply == null ? null : Number(r.daysOfSupply), shipBy: iso(r.recommendedShipDate),
            daysToInbound: r.daysToInbound, unitsSold30d: r.salesPace30dUnits, shortUnits: r.salesShortageUnits, alert: r.alertType, asOf: iso(r.asOf),
          })),
          note: FBA_NOTE,
        },
      }
    }
    const [perFc, aged, unfulfillable] = await Promise.all([
      listPerFcTotals(),
      getAgedInventory({ thresholdDays: 180, limit: 10 }),
      getUnfulfillable({ limit: 10 }),
    ])
    return {
      ok: true,
      data: {
        items,
        nextCursor,
        byFulfilmentCentre: perFc.slice(0, NESTED_CAP),
        aged: aged.map((r) => ({ productId: r.productId, sku: r.sku, marketplaceId: r.marketplaceId, fulfillmentCenterId: r.fulfillmentCenterId, quantity: r.quantity, ageDays: r.ageDays })),
        unfulfillable: unfulfillable.map((r) => ({ productId: r.productId, sku: r.sku, marketplaceId: r.marketplaceId, fulfillmentCenterId: r.fulfillmentCenterId, quantity: r.quantity })),
        note: FBA_NOTE,
      },
    }
  }),
}

export const STOCK_READ_TOOLS: AgentTool[] = [
  stockLevels,
  stockSearch,
  stockLocations,
  stockMovements,
  stockReservations,
  cycleCounts,
  sharedStock,
  fbaInventory,
]
