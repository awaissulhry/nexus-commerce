/**
 * F.2 — ATP (Available-to-Promise) resolver.
 *
 * For a batch of products, computes per-product:
 *   - leadTimeDays + leadTimeSource (which level of the supplier hierarchy
 *     supplied the value) so the UI can show "from SupplierProduct override"
 *     vs. "from Supplier default" vs. "fallback (no supplier set)"
 *   - inboundWithinLeadTime: units arriving via open InboundShipment rows
 *     before today + leadTimeDays (the only inbound that affects the
 *     immediate replenishment decision)
 *   - totalOpenInbound: all units in non-closed shipments regardless of date
 *     (information for the UI; not used in urgency math)
 *   - openShipments: minimal shipment refs so the UI can render
 *     "200 inbound from PO #1234 expected 2026-05-12"
 *
 * Two queries total — one for lead times (Rule + SupplierProduct +
 * Supplier joined for the products in scope), one for inbound items —
 * both indexed. Caller passes a list of products and gets back a Map
 * keyed by productId.
 *
 * Lead-time resolution precedence:
 *   1. SupplierProduct.leadTimeDaysOverride  (if ReplenishmentRule
 *      points at a supplier and the (supplier, product) row exists)
 *   2. Supplier.leadTimeDays                 (default for the supplier)
 *   3. DEFAULT_LEAD_TIME_DAYS = 14           (hardcoded fallback only when
 *      no supplier is configured at all)
 */

import prisma from '../db.js'
import type { InboundStatus } from '@prisma/client'

export const DEFAULT_LEAD_TIME_DAYS = 14

export type LeadTimeSource =
  | 'SUPPLIER_PRODUCT_OVERRIDE'
  | 'SUPPLIER_DEFAULT'
  | 'FALLBACK'

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
  leadTimeDays: number
  leadTimeSource: LeadTimeSource
  inboundWithinLeadTime: number
  totalOpenInbound: number
  openShipments: OpenInboundShipmentRef[]
}

interface ResolveAtpArgs {
  /** Products to resolve. We need both id and sku because lead-time data
   *  joins on productId but inbound items link via sku (sku is always
   *  populated; productId on InboundShipmentItem can be null). */
  products: Array<{ id: string; sku: string }>
}

/**
 * Statuses that count as "open" — inbound stock will eventually land.
 * CLOSED + CANCELLED inbound shipments are excluded; their stock has
 * either already been credited via StockMovement (CLOSED) or never
 * will be (CANCELLED).
 */
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
  // Pull every ReplenishmentRule for these products + the
  // SupplierProduct row (if any) for that (supplier, product) pair +
  // the Supplier itself. One query joins all three so the lead-time
  // hierarchy walk is in-memory, not N+1.
  const rules = await prisma.replenishmentRule.findMany({
    where: { productId: { in: productIds } },
    select: {
      productId: true,
      preferredSupplierId: true,
    },
  })
  // Index supplier products by (supplierId, productId) — we only need rows
  // for the supplier each rule points at, so the IN list is the union.
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
            select: {
              supplierId: true,
              productId: true,
              leadTimeDaysOverride: true,
            },
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

  // ── Inbound stock ──────────────────────────────────────────────
  // Pull every open InboundShipmentItem for the SKUs in scope. Group by
  // sku in JS — Prisma's groupBy doesn't include columns from the
  // related shipment in one shot, so a hand-rolled join keeps the
  // status + expectedAt + reference accessible per item.
  const inboundItems = await prisma.inboundShipmentItem.findMany({
    where: {
      sku: { in: skus },
      inboundShipment: {
        status: { in: OPEN_INBOUND_STATUSES },
      },
    },
    select: {
      sku: true,
      quantityExpected: true,
      quantityReceived: true,
      inboundShipment: {
        select: {
          id: true,
          type: true,
          status: true,
          expectedAt: true,
          reference: true,
        },
      },
    },
  })

  // Index inbound by SKU (not productId — InboundShipmentItem.productId
  // can be null; sku is the reliable join key).
  const inboundBySku = new Map<
    string,
    Array<{
      remaining: number
      shipment: {
        id: string
        type: string
        status: string
        expectedAt: Date | null
        reference: string | null
      }
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

    const leadTimeCutoff = now + leadTimeDays * 86400000

    const inboundList = inboundBySku.get(p.sku) ?? []
    let inboundWithinLeadTime = 0
    let totalOpenInbound = 0
    const openShipments: OpenInboundShipmentRef[] = []

    for (const entry of inboundList) {
      totalOpenInbound += entry.remaining
      // Within-lead-time: include shipments with no expectedAt date too.
      // A DRAFT/IN_TRANSIT shipment without a date is more conservatively
      // assumed to land within lead time (otherwise we'd over-reorder
      // because we ignored it). Recipients should set expectedAt to fix
      // the model.
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
      leadTimeDays,
      leadTimeSource,
      inboundWithinLeadTime,
      totalOpenInbound,
      openShipments,
    })
  }

  return out
}
