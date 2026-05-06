/**
 * F.2 — ATP (Available-to-Promise) resolver. R.2: multi-location.
 *
 * For a batch of products, computes per-product:
 *   - leadTimeDays + leadTimeSource (which level of the supplier hierarchy
 *     supplied the value) so the UI can show "from SupplierProduct override"
 *     vs. "from Supplier default" vs. "fallback (no supplier set)"
 *   - byLocation[]: per-StockLocation breakdown with quantity / reserved /
 *     available / reorderThreshold / reorderQuantity / servesMarketplaces.
 *     Channel-specific stock pools are picked from this array via
 *     atp-channel.service.resolveStockForChannel().
 *   - totalQuantity / totalAvailable: sums across locations (the "ATP
 *     total" figures the drawer renders below the per-location list).
 *   - stockSource: 'STOCK_LEVEL' when StockLevel rows exist; 'PRODUCT_-
 *     TOTAL_STOCK_FALLBACK' for legacy products that haven't been
 *     migrated to per-location tracking. Fallback path synthesizes one
 *     row against the default warehouse (IT-MAIN) so existing
 *     recommendations don't disappear overnight; UI flags it amber.
 *   - inboundWithinLeadTime: units arriving via open InboundShipment rows
 *     before today + leadTimeDays (the only inbound that affects the
 *     immediate replenishment decision)
 *   - totalOpenInbound: all units in non-closed shipments regardless of
 *     date (information for the UI; not used in urgency math)
 *   - openShipments: minimal shipment refs so the UI can render
 *     "200 inbound from PO #1234 expected 2026-05-12"
 *
 * Lead-time resolution precedence:
 *   1. SupplierProduct.leadTimeDaysOverride
 *   2. Supplier.leadTimeDays
 *   3. DEFAULT_LEAD_TIME_DAYS = 14
 *
 * Pre-R.2 ATP read Product.totalStock exclusively. Post-R.2 it reads
 * StockLevel — fixing the bug where a "47 units in stock" recommendation
 * was misleading when those 47 sat at Riccione while Amazon-FBA was
 * empty. Legacy callers can still consume `totalAvailable` (additive,
 * non-breaking).
 */

import prisma from '../db.js'
import type { InboundStatus } from '@prisma/client'
import type { AtpLocationRow } from './atp-channel.service.js'

export const DEFAULT_LEAD_TIME_DAYS = 14

export type LeadTimeSource =
  | 'SUPPLIER_PRODUCT_OVERRIDE'
  | 'SUPPLIER_DEFAULT'
  | 'FALLBACK'

export type StockSource = 'STOCK_LEVEL' | 'PRODUCT_TOTAL_STOCK_FALLBACK'

export interface OpenInboundShipmentRef {
  shipmentId: string
  type: string
  status: string
  expectedAt: Date | null
  remainingUnits: number
  reference: string | null
}

export interface ProductAtp {
  productId: string
  sku: string

  // R.2 — per-location breakdown
  byLocation: AtpLocationRow[]
  totalQuantity: number
  totalAvailable: number
  stockSource: StockSource

  // Lead time
  leadTimeDays: number
  leadTimeSource: LeadTimeSource

  // Inbound
  inboundWithinLeadTime: number
  totalOpenInbound: number
  openShipments: OpenInboundShipmentRef[]
}

interface ResolveAtpArgs {
  /** Products to resolve. We need both id and sku because lead-time data
   *  joins on productId but inbound items link via sku (sku is always
   *  populated; productId on InboundShipmentItem can be null). */
  products: Array<{ id: string; sku: string; totalStock?: number | null }>
}

const OPEN_INBOUND_STATUSES: InboundStatus[] = [
  'DRAFT',
  'IN_TRANSIT',
  'ARRIVED',
  'RECEIVING',
]

export async function resolveAtp(
  args: ResolveAtpArgs,
): Promise<Map<string, ProductAtp>> {
  const out = new Map<string, ProductAtp>()
  if (args.products.length === 0) return out

  const productIds = args.products.map((p) => p.id)
  const skus = args.products.map((p) => p.sku)

  // ── Lead time resolution ────────────────────────────────────────
  const rules = await prisma.replenishmentRule.findMany({
    where: { productId: { in: productIds } },
    select: { productId: true, preferredSupplierId: true },
  })
  const supplierIds = [
    ...new Set(rules.map((r) => r.preferredSupplierId).filter(Boolean) as string[]),
  ]
  const [supplierProducts, suppliers] =
    supplierIds.length > 0
      ? await Promise.all([
          prisma.supplierProduct.findMany({
            where: {
              supplierId: { in: supplierIds },
              productId: { in: productIds },
            },
            select: { supplierId: true, productId: true, leadTimeDaysOverride: true },
          }),
          prisma.supplier.findMany({
            where: { id: { in: supplierIds } },
            select: { id: true, leadTimeDays: true },
          }),
        ])
      : [[], []]

  const supplierById = new Map(suppliers.map((s) => [s.id, s.leadTimeDays]))
  const supplierProductByKey = new Map(
    supplierProducts.map((sp) => [
      `${sp.supplierId}:${sp.productId}`,
      sp.leadTimeDaysOverride,
    ]),
  )
  const ruleByProductId = new Map(rules.map((r) => [r.productId, r]))

  // ── R.2: Per-location stock ─────────────────────────────────────
  // One query pulls every StockLevel for these products with the
  // location joined, indexed scan on (productId).
  const stockLevels = await prisma.stockLevel.findMany({
    where: { productId: { in: productIds } },
    select: {
      locationId: true,
      productId: true,
      quantity: true,
      reserved: true,
      available: true,
      reorderThreshold: true,
      reorderQuantity: true,
      location: {
        select: {
          id: true,
          code: true,
          name: true,
          type: true,
          servesMarketplaces: true,
          isActive: true,
        },
      },
    },
  })

  // Index by productId. Skip rows whose location is inactive — the
  // operator may still be transitioning a warehouse out of service.
  const locationsByProductId = new Map<string, AtpLocationRow[]>()
  for (const sl of stockLevels) {
    if (!sl.location.isActive) continue
    const list = locationsByProductId.get(sl.productId) ?? []
    list.push({
      locationId: sl.location.id,
      locationCode: sl.location.code,
      locationName: sl.location.name,
      locationType: sl.location.type as AtpLocationRow['locationType'],
      servesMarketplaces: sl.location.servesMarketplaces,
      quantity: sl.quantity,
      reserved: sl.reserved,
      available: sl.available,
    })
    locationsByProductId.set(sl.productId, list)
  }

  // Default warehouse for legacy fallback (Product.totalStock without
  // any StockLevel rows).
  const defaultWarehouse = await prisma.stockLocation.findFirst({
    where: { type: 'WAREHOUSE', isActive: true },
    orderBy: [
      // IT-MAIN-first heuristic: order by code so 'IT-MAIN' sorts at
      // top of common Italian-warehouse codenames.
      { code: 'asc' },
    ],
    select: { id: true, code: true, name: true, type: true, servesMarketplaces: true },
  })

  // ── Inbound stock ──────────────────────────────────────────────
  const inboundItems = await prisma.inboundShipmentItem.findMany({
    where: {
      sku: { in: skus },
      inboundShipment: { status: { in: OPEN_INBOUND_STATUSES } },
    },
    select: {
      sku: true,
      quantityExpected: true,
      quantityReceived: true,
      inboundShipment: {
        select: { id: true, type: true, status: true, expectedAt: true, reference: true },
      },
    },
  })

  const inboundBySku = new Map<
    string,
    Array<{
      remaining: number
      shipment: { id: string; type: string; status: string; expectedAt: Date | null; reference: string | null }
    }>
  >()
  for (const item of inboundItems) {
    const remaining = Math.max(0, item.quantityExpected - item.quantityReceived)
    if (remaining === 0) continue
    const arr = inboundBySku.get(item.sku) ?? []
    arr.push({ remaining, shipment: item.inboundShipment })
    inboundBySku.set(item.sku, arr)
  }

  // ── Compose per-product ATP ────────────────────────────────────
  const now = Date.now()
  for (const p of args.products) {
    const rule = ruleByProductId.get(p.id)
    const supplierId = rule?.preferredSupplierId ?? null

    let leadTimeDays = DEFAULT_LEAD_TIME_DAYS
    let leadTimeSource: LeadTimeSource = 'FALLBACK'

    if (supplierId) {
      const override = supplierProductByKey.get(`${supplierId}:${p.id}`)
      if (override != null) {
        leadTimeDays = override
        leadTimeSource = 'SUPPLIER_PRODUCT_OVERRIDE'
      } else {
        const supplierDefault = supplierById.get(supplierId)
        if (supplierDefault != null) {
          leadTimeDays = supplierDefault
          leadTimeSource = 'SUPPLIER_DEFAULT'
        }
      }
    }

    // R.2 — stock breakdown with legacy fallback
    let byLocation = locationsByProductId.get(p.id) ?? []
    let stockSource: StockSource = 'STOCK_LEVEL'

    if (byLocation.length === 0 && (p.totalStock ?? 0) > 0 && defaultWarehouse) {
      // Legacy product: synthesize a single row against the default
      // warehouse so existing recommendations don't disappear. UI
      // flags this with an amber warning.
      byLocation = [{
        locationId: defaultWarehouse.id,
        locationCode: defaultWarehouse.code,
        locationName: defaultWarehouse.name,
        locationType: defaultWarehouse.type as AtpLocationRow['locationType'],
        servesMarketplaces: defaultWarehouse.servesMarketplaces,
        quantity: p.totalStock!,
        reserved: 0,
        available: p.totalStock!,
      }]
      stockSource = 'PRODUCT_TOTAL_STOCK_FALLBACK'
    }

    const totalQuantity = byLocation.reduce((s, r) => s + r.quantity, 0)
    const totalAvailable = byLocation.reduce((s, r) => s + r.available, 0)

    // Inbound
    const leadTimeCutoff = now + leadTimeDays * 86400000
    const inboundList = inboundBySku.get(p.sku) ?? []
    let inboundWithinLeadTime = 0
    let totalOpenInbound = 0
    const openShipments: OpenInboundShipmentRef[] = []

    for (const entry of inboundList) {
      totalOpenInbound += entry.remaining
      const within =
        entry.shipment.expectedAt == null ||
        entry.shipment.expectedAt.getTime() <= leadTimeCutoff
      if (within) inboundWithinLeadTime += entry.remaining

      openShipments.push({
        shipmentId: entry.shipment.id,
        type: entry.shipment.type,
        status: entry.shipment.status,
        expectedAt: entry.shipment.expectedAt,
        remainingUnits: entry.remaining,
        reference: entry.shipment.reference,
      })
    }

    out.set(p.id, {
      productId: p.id,
      sku: p.sku,
      byLocation,
      totalQuantity,
      totalAvailable,
      stockSource,
      leadTimeDays,
      leadTimeSource,
      inboundWithinLeadTime,
      totalOpenInbound,
      openShipments,
    })
  }

  return out
}
