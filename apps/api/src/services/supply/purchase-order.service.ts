/**
 * MCP full control 08 S4 — the purchase order reads, out of the routes, so the purchasing pages and Claude's supply tools read the same
 * thing. Each function is the body of its route, moved as it was (supply-read.vitest.test.ts holds the routes'
 * answers): the route keeps its status codes and error handling, and returns what the function returns.
 *
 *   listPurchaseOrders      GET /api/fulfillment/purchase-orders           live (or deleted) POs, filtered, newest 200
 *   readPurchaseOrder       GET /api/fulfillment/purchase-orders/:id       one PO with fiscal preview (null: not found)
 *   readPurchaseOrderMatch  GET /api/fulfillment/purchase-orders/:id/match  ordered vs received vs landed (null: not found)
 *   createPurchaseOrder     POST /api/fulfillment/purchase-orders          a DRAFT PO with its lines (08 S9)
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { publishPoEvent } from '../po-events.service.js'
import { PO_SECRET_OMIT } from './po-secrets.js'

/** Query of GET /api/fulfillment/purchase-orders: deleted, status, supplierIds / supplierId, warehouseId, currencyCode, min/maxValueCents, expectedFrom/To, lateOnly. */
export async function listPurchaseOrders(q: Record<string, any>) {
  const where: any = {}
  // RB.1 — recycle-bin scope. Default = live-only.
  const showDeleted = q.deleted === 'true'
  where.deletedAt = showDeleted ? { not: null } : null
  // H.4: status accepts comma-separated multi-select. Used by the
  // create-inbound modal to limit the PO picker to in-flight POs
  // (SUBMITTED, CONFIRMED, PARTIAL).
  if (q.status && q.status !== 'ALL') {
    const statuses = String(q.status).split(',').map((s) => s.trim()).filter(Boolean)
    if (statuses.length === 1) where.status = statuses[0]
    else if (statuses.length > 1) where.status = { in: statuses }
  }
  // PO.14 — supplier filter accepts comma-separated multi-select.
  // Legacy `supplierId` (single) still honored for backward-compat
  // with /products?supplierId= deep-links.
  if (q.supplierIds) {
    const ids = String(q.supplierIds).split(',').map((s) => s.trim()).filter(Boolean)
    if (ids.length === 1) where.supplierId = ids[0]
    else if (ids.length > 1) where.supplierId = { in: ids }
  } else if (q.supplierId) {
    where.supplierId = q.supplierId
  }
  // PO.14 — warehouse filter (single).
  if (q.warehouseId) where.warehouseId = q.warehouseId
  // PO.14 — currency filter (single 3-char code, uppercased).
  if (q.currencyCode) {
    where.currencyCode = String(q.currencyCode).trim().toUpperCase()
  }
  // PO.14 — value range. Cents are integers so no FX conversion
  // here; mixed-ccy bands are operator's responsibility.
  const minValue = q.minValueCents != null ? Number(q.minValueCents) : null
  const maxValue = q.maxValueCents != null ? Number(q.maxValueCents) : null
  if (Number.isFinite(minValue) || Number.isFinite(maxValue)) {
    where.totalCents = {}
    if (Number.isFinite(minValue) && minValue! >= 0) {
      where.totalCents.gte = Math.floor(minValue!)
    }
    if (Number.isFinite(maxValue) && maxValue! >= 0) {
      where.totalCents.lte = Math.floor(maxValue!)
    }
  }
  // PO.14 — expectedDeliveryDate range.
  const fromDate = q.expectedFrom ? new Date(String(q.expectedFrom)) : null
  const toDate = q.expectedTo ? new Date(String(q.expectedTo)) : null
  if (fromDate || toDate) {
    where.expectedDeliveryDate = {}
    if (fromDate && !isNaN(fromDate.getTime())) {
      where.expectedDeliveryDate.gte = fromDate
    }
    if (toDate && !isNaN(toDate.getTime())) {
      // Make `to` inclusive of the whole day.
      const inclusive = new Date(toDate.getTime())
      inclusive.setHours(23, 59, 59, 999)
      where.expectedDeliveryDate.lte = inclusive
    }
  }
  // PO.14 — lateOnly preset. Past expectedDeliveryDate AND status
  // not yet fully received/cancelled. Combines with any explicit
  // status filter via AND.
  if (q.lateOnly === 'true') {
    where.expectedDeliveryDate = {
      ...(where.expectedDeliveryDate ?? {}),
      lt: new Date(),
    }
    const lateStatuses = ['DRAFT', 'REVIEW', 'APPROVED', 'SUBMITTED', 'ACKNOWLEDGED', 'CONFIRMED', 'PARTIAL']
    if (!where.status) {
      where.status = { in: lateStatuses }
    }
  }

  const items = await prisma.purchaseOrder.findMany({
    where,
    omit: PO_SECRET_OMIT,
    include: {
      supplier: { select: { id: true, name: true } },
      warehouse: { select: { code: true } },
      items: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  return { items, total: items.length }
}

export async function readPurchaseOrder(id: string) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    omit: PO_SECRET_OMIT,
    include: {
      supplier: true,
      warehouse: true,
      // PO.1 — line ordering is now durable; sort by lineOrder ASC
      // with id tiebreak so the detail page matches the edit grid.
      items: { orderBy: [{ lineOrder: 'asc' }, { id: 'asc' }] },
      inboundShipments: { orderBy: { createdAt: 'desc' } },
      // PO.1 — surface attachments, revisions, comments. Empty
      // collections until PO.5+ populate them, but already wired so
      // the detail page (PO.2) can render skeleton sections without
      // a second backend trip.
      attachments: { orderBy: { uploadedAt: 'desc' } },
      revisions: { orderBy: { version: 'asc' } },
      comments: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!po) return null

  // PO.12 — fiscal preview attached to the detail response. Only
  // populated when BrandSettings.piva is set; non-IT operators see
  // null and the detail UI skips the strip. Reverse-charge is
  // auto-detected from supplier.country against the EU-non-IT set.
  const brand = await prisma.brandSettings.findFirst({
    select: { piva: true, vatScheme: true, codiceFiscale: true },
  })
  let fiscal: {
    piva: string
    vatScheme: string | null
    ivaRateBp: number
    reverseCharge: boolean
    totalNetCents: number
    ivaCents: number
    totalGrossCents: number
  } | null = null
  if (brand?.piva) {
    const EU_NON_IT_INLINE = new Set([
      'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE',
      'LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE',
    ])
    const supplierCountry = (po.supplier?.country ?? null)?.toUpperCase() ?? null
    const reverseCharge =
      supplierCountry !== null && EU_NON_IT_INLINE.has(supplierCountry)
    const ivaRateBp = Math.max(
      0,
      Number(process.env.NEXUS_DEFAULT_IVA_RATE_BP) || 2200,
    )
    const totalNetCents = po.totalCents
    const ivaCents = reverseCharge
      ? 0
      : Math.round((totalNetCents * ivaRateBp) / 10000)
    fiscal = {
      piva: brand.piva,
      vatScheme: brand.vatScheme,
      ivaRateBp,
      reverseCharge,
      totalNetCents,
      ivaCents,
      totalGrossCents: totalNetCents + ivaCents,
    }
  }

  return { ...po, fiscal }
}

/** The three-way match of a PO (ordered, received, landed cost), or null when there is no such PO. */
export async function readPurchaseOrderMatch(id: string) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: {
      items: { orderBy: [{ lineOrder: 'asc' }, { id: 'asc' }] },
      // PO.11 — fetch the full cost detail for each linked shipment
      // so the landed-cost roll-up can prorate shipping / customs /
      // duties / insurance across the receive batches.
      inboundShipments: {
        select: {
          id: true,
          status: true,
          arrivedAt: true,
          currencyCode: true,
          exchangeRate: true,
          shippingCostCents: true,
          customsCostCents: true,
          dutiesCostCents: true,
          insuranceCostCents: true,
          items: {
            select: {
              purchaseOrderItemId: true,
              quantityReceived: true,
              unitCostCents: true,
            },
          },
        },
      },
    },
  })
  if (!po) return null

  const poiIds = po.items.map((it) => it.id)
  // PO.10 still wants the flat list of shipment items; flatten from
  // the nested include rather than running a second query.
  const shipmentItems = po.inboundShipments.flatMap((s) =>
    s.items
      .filter((it) => it.purchaseOrderItemId && poiIds.includes(it.purchaseOrderItemId))
      .map((it) => ({
        purchaseOrderItemId: it.purchaseOrderItemId,
        quantityReceived: it.quantityReceived,
        unitCostCents: it.unitCostCents,
      })),
  )

  // Roll up per-line actuals from the receive side.
  const byPoi = new Map<string, { qty: number; weightedCostNum: number; sampleCount: number }>()
  for (const si of shipmentItems) {
    if (!si.purchaseOrderItemId) continue
    const prev = byPoi.get(si.purchaseOrderItemId) ?? { qty: 0, weightedCostNum: 0, sampleCount: 0 }
    prev.qty += si.quantityReceived ?? 0
    if (si.unitCostCents != null && si.quantityReceived > 0) {
      prev.weightedCostNum += si.unitCostCents * si.quantityReceived
      prev.sampleCount += si.quantityReceived
    }
    byPoi.set(si.purchaseOrderItemId, prev)
  }

  // ── PO.11 — landed-cost rollup ─────────────────────────────
  //
  // For each linked InboundShipment:
  //   1. overhead = shipping + customs + duties + insurance,
  //      in the shipment's currency
  //   2. receivedUnits = sum(quantityReceived across items)
  //   3. per-unit overhead = overhead / receivedUnits
  //   4. for each item: landed_unit_cost (shipment-ccy) =
  //                       unitCostCents + per_unit_overhead
  //   5. EUR conversion via shipment.exchangeRate (Decimal → number)
  //
  // Aggregate per POI:
  //   - sum landed cost in shipment ccy AND in EUR
  //   - units count
  //
  // Totals block reports overhead breakdown in EUR (the canonical
  // base) so the UI doesn't have to mix currencies.
  const landedByPoi = new Map<
    string,
    { units: number; landedCentsPoCcy: number; landedCentsEur: number }
  >()
  let overheadShippingEurCents = 0
  let overheadCustomsEurCents = 0
  let overheadDutiesEurCents = 0
  let overheadInsuranceEurCents = 0
  let goodsEurCents = 0

  // PO currency may differ from each shipment's. We report landed
  // unit cost in the PO currency when the shipment matches, and
  // fall back to EUR-converted figures otherwise. The UI surfaces
  // EUR-converted totals to keep the page readable when mixed.
  for (const ship of po.inboundShipments) {
    const overheadShipCents =
      (ship.shippingCostCents ?? 0) +
      (ship.customsCostCents ?? 0) +
      (ship.dutiesCostCents ?? 0) +
      (ship.insuranceCostCents ?? 0)
    const receivedUnits = ship.items.reduce(
      (s, it) => s + (it.quantityReceived ?? 0),
      0,
    )
    const perUnitOverhead =
      receivedUnits > 0 ? overheadShipCents / receivedUnits : 0

    // Shipment-currency → EUR conversion. exchangeRate is a Decimal;
    // null/missing falls back to 1.0 (treat as EUR when unknown).
    const fxToEur = ship.exchangeRate ? Number(ship.exchangeRate) : 1

    overheadShippingEurCents += Math.round((ship.shippingCostCents ?? 0) * fxToEur)
    overheadCustomsEurCents += Math.round((ship.customsCostCents ?? 0) * fxToEur)
    overheadDutiesEurCents += Math.round((ship.dutiesCostCents ?? 0) * fxToEur)
    overheadInsuranceEurCents += Math.round((ship.insuranceCostCents ?? 0) * fxToEur)

    for (const item of ship.items) {
      if (!item.purchaseOrderItemId) continue
      const q = item.quantityReceived ?? 0
      if (q <= 0) continue
      const unitCost = item.unitCostCents ?? 0
      const landedShipUnitCents = unitCost + perUnitOverhead
      const landedShipTotalCents = landedShipUnitCents * q
      const landedEurTotalCents = Math.round(landedShipTotalCents * fxToEur)
      goodsEurCents += Math.round(unitCost * q * fxToEur)

      const prev = landedByPoi.get(item.purchaseOrderItemId) ?? {
        units: 0,
        landedCentsPoCcy: 0,
        landedCentsEur: 0,
      }
      prev.units += q
      prev.landedCentsPoCcy += landedShipTotalCents
      prev.landedCentsEur += landedEurTotalCents
      landedByPoi.set(item.purchaseOrderItemId, prev)
    }
  }

  const ppvWarningBp = Math.max(0, Number(process.env.NEXUS_PO_PPV_WARNING_BP) || 200)
  const tolerance = Math.max(0, Number(process.env.NEXUS_PO_AUTO_CLOSE_TOLERANCE_UNITS) || 0)

  let totalOrdered = 0
  let totalReceived = 0
  let totalOrderedCents = 0
  let totalReceivedCents = 0
  let ppvFlags = 0
  let overReceipts = 0
  let underReceipts = 0

  const lines = po.items.map((it) => {
    const actuals = byPoi.get(it.id)
    const receivedQty = actuals?.qty ?? 0
    const receivedAvgUnitCostCents =
      actuals && actuals.sampleCount > 0
        ? Math.round(actuals.weightedCostNum / actuals.sampleCount)
        : null

    const orderedSubtotal = it.unitCostCents * it.quantityOrdered
    const receivedSubtotal =
      receivedAvgUnitCostCents != null
        ? receivedAvgUnitCostCents * receivedQty
        : it.unitCostCents * receivedQty // fall back to ordered cost when actuals unknown

    const qtyDelta = receivedQty - it.quantityOrdered // negative = under, positive = over
    const ppvBp =
      receivedAvgUnitCostCents != null && it.unitCostCents > 0
        ? Math.round(((receivedAvgUnitCostCents - it.unitCostCents) / it.unitCostCents) * 10000)
        : 0

    let lineStatus: 'matched' | 'partial' | 'over' | 'price-variance' | 'pending'
    if (receivedQty === 0) lineStatus = 'pending'
    else if (qtyDelta > 0) lineStatus = 'over'
    else if (qtyDelta < -tolerance) lineStatus = 'partial'
    else if (Math.abs(ppvBp) > ppvWarningBp) lineStatus = 'price-variance'
    else lineStatus = 'matched'

    if (qtyDelta > 0) overReceipts++
    if (lineStatus === 'partial') underReceipts++
    if (Math.abs(ppvBp) > ppvWarningBp) ppvFlags++

    totalOrdered += it.quantityOrdered
    totalReceived += receivedQty
    totalOrderedCents += orderedSubtotal
    totalReceivedCents += receivedSubtotal

    // PO.11 — landed cost lookup for this PO line.
    const landed = landedByPoi.get(it.id)
    const landedUnitCentsPoCcy =
      landed && landed.units > 0
        ? Math.round(landed.landedCentsPoCcy / landed.units)
        : null
    const landedUnitCentsEur =
      landed && landed.units > 0
        ? Math.round(landed.landedCentsEur / landed.units)
        : null

    return {
      purchaseOrderItemId: it.id,
      productId: it.productId,
      sku: it.sku,
      supplierSku: it.supplierSku,
      note: it.note,
      orderedQty: it.quantityOrdered,
      receivedQty,
      openQty: Math.max(0, it.quantityOrdered - receivedQty),
      orderedUnitCostCents: it.unitCostCents,
      receivedAvgUnitCostCents,
      orderedSubtotalCents: orderedSubtotal,
      receivedSubtotalCents: receivedSubtotal,
      qtyDelta,
      ppvBp,
      ppvCents:
        receivedAvgUnitCostCents != null && receivedQty > 0
          ? (receivedAvgUnitCostCents - it.unitCostCents) * receivedQty
          : 0,
      status: lineStatus,
      // PO.11 — per-line landed cost. PoCcy = PO currency, Eur =
      // canonical base. UI surfaces Eur when shipments mix
      // currencies; PoCcy when they match.
      landedUnitCentsPoCcy,
      landedUnitCentsEur,
      landedSubtotalCentsEur: landed?.landedCentsEur ?? 0,
    }
  })

  const totalCostVarianceCents = totalReceivedCents - totalOrderedCents
  const shortfallUnits = totalOrdered - totalReceived
  const withinTolerance = shortfallUnits >= 0 && shortfallUnits <= tolerance
  const linkedShipmentCount = po.inboundShipments.length

  // PO.11 — total landed cost in EUR = goods + overhead.
  const overheadTotalEurCents =
    overheadShippingEurCents +
    overheadCustomsEurCents +
    overheadDutiesEurCents +
    overheadInsuranceEurCents
  const landedTotalEurCents = goodsEurCents + overheadTotalEurCents

  return {
    poNumber: po.poNumber,
    status: po.status,
    currencyCode: po.currencyCode,
    toleranceUnits: tolerance,
    ppvWarningBp,
    totals: {
      orderedQty: totalOrdered,
      receivedQty: totalReceived,
      shortfallUnits,
      orderedCents: totalOrderedCents,
      receivedCents: totalReceivedCents,
      varianceCents: totalCostVarianceCents,
      withinTolerance,
    },
    // PO.11 — Landed cost roll-up. All amounts in EUR cents so the
    // UI doesn't have to mix currencies; line-level landedUnitCents
    // also exposes the PO-currency figure for unmixed cases.
    landed: {
      goodsEurCents,
      overheadShippingEurCents,
      overheadCustomsEurCents,
      overheadDutiesEurCents,
      overheadInsuranceEurCents,
      overheadTotalEurCents,
      totalEurCents: landedTotalEurCents,
      overheadShareBp:
        landedTotalEurCents > 0
          ? Math.round((overheadTotalEurCents / landedTotalEurCents) * 10000)
          : 0,
    },
    flags: {
      ppvLines: ppvFlags,
      overReceiptLines: overReceipts,
      underReceiptLines: underReceipts,
    },
    invoice: {
      // No invoice ingestion yet; placeholder so the UI can keep
      // the third column reserved.
      status: 'not-tracked' as const,
    },
    linkedShipmentCount,
    lines,
  }
}

// ── 08 S9 — the writes ─────────────────────────────────────────────────────────────────────────────────

export function generatePoNumber(): string {
  const d = new Date()
  const yymmdd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `PO-${yymmdd}-${rand}`
}

/** The input of POST /api/fulfillment/purchase-orders (and Claude's draft-purchase-order). */
export type CreatePurchaseOrderInput = {
    supplierId?: string
    warehouseId?: string
    expectedDeliveryDate?: string
    notes?: string
    // PO.5 — currency lives on the PO header so line-item cents
    // are unambiguous. Default EUR matches the Supplier model's
    // defaultCurrency default.
    currencyCode?: string
    // PO-Plus.8 — optional drop-ship address. JSON blob passed
    // through verbatim; the factory PDF renders it as the
    // "Ship to" block when present (instead of the warehouse).
    shipToAddress?: Record<string, unknown> | null
    items?: Array<{
      productId?: string
      sku: string
      supplierSku?: string
      quantityOrdered: number
      unitCostCents?: number
      // PO.5 — per-line note, persisted via the PO.1 column added
      // to PurchaseOrderItem. Surfaces in the factory PDF in PO.12.
      note?: string
      // PD.1 — factory-facing naming (per-line override).
      factoryName?: string
      factorySize?: string
      factorySpec?: string
    }>
}

/** A DRAFT PO with its lines (null: no lines). Publishes po.created. Moved as it was from the route (08 S9). */
export async function createPurchaseOrder(body: CreatePurchaseOrderInput) {
  const items = Array.isArray(body.items) ? body.items : []
  if (items.length === 0) return null
  const totalCents = items.reduce((s, it) => s + (it.unitCostCents ?? 0) * it.quantityOrdered, 0)
  const warehouseId = body.warehouseId ?? (await prisma.warehouse.findFirst({ where: { isDefault: true } }))?.id

  const po = await prisma.purchaseOrder.create({
    data: {
      poNumber: generatePoNumber(),
      supplierId: body.supplierId ?? null,
      warehouseId,
      status: 'DRAFT',
      expectedDeliveryDate: body.expectedDeliveryDate ? new Date(body.expectedDeliveryDate) : null,
      notes: body.notes ?? null,
      totalCents,
      currencyCode: body.currencyCode?.toUpperCase() || 'EUR',
      shipToAddress:
        body.shipToAddress && typeof body.shipToAddress === 'object'
          ? (body.shipToAddress as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      items: {
        create: items.map((it, idx) => ({
          productId: it.productId ?? null,
          sku: it.sku,
          supplierSku: it.supplierSku ?? null,
          quantityOrdered: it.quantityOrdered,
          unitCostCents: it.unitCostCents ?? 0,
          note: it.note ?? null,
          lineOrder: idx,
          // PD.1 — factory-facing naming on the new line.
          factoryName: it.factoryName ?? null,
          factorySize: it.factorySize ?? null,
          factorySpec: it.factorySpec ?? null,
        })),
      },
    },
    include: { items: true },
  })
  // PO.4 — emit po.created so the list refreshes on every peer
  // browser sub-second.
  publishPoEvent({
    type: 'po.created',
    poId: po.id,
    poNumber: po.poNumber,
    ts: Date.now(),
  })
  return po
}
