/**
 * MCP full control 08 S4 — supply reads for Claude: suppliers, purchase orders, inbound shipments and product costs.
 *
 * Read-only and low risk: this business's own database. The reads are the purchasing pages' own (services/supply/,
 * moved out of the routes) and the cost services. Money is shown only to a person who may see it: costs, landed
 * costs and PO totals sit under the keys named in each tool's `restrictedFields` (and the shared money registry), and
 * the door strips them for anyone without financials.costs.view / financials.suppliers.view. product-costs is about
 * money only, so it needs financials.costs.view to run at all. Secrets on a PO (the supplier's and approver's
 * acknowledgement links) are never part of any answer.
 */

import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
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
import { listSuppliers, readSupplier } from '../../supply/supplier.service.js'
import { listPurchaseOrders, readPurchaseOrder, readPurchaseOrderMatch } from '../../supply/purchase-order.service.js'
import { listInboundShipments, readInboundShipment } from '../../supply/inbound-shipment.service.js'
import { getCostGrid } from '../../product-costs.service.js'
import { getCurrentCost, listLayers } from '../../cost-layers.service.js'
import { loadCandidatesForProduct, rankSuppliers } from '../../supplier-comparison.service.js'
import { getStockoutSummary } from '../../stockout-detector.service.js'
import { projectStockout } from '../../forecast/stockout-projection.service.js'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { isLiveProduct, PRODUCT_NOT_FOUND } from './live-product.js'

const NESTED_CAP = 20
const LINES_CAP = 100
const TEXT_CAP = 200
const clip = (text: string | null | undefined, cap = TEXT_CAP) => (text == null ? null : text.length > cap ? `${text.slice(0, cap - 1)}…` : text)
const iso = (at: Date | string | null | undefined) => (at == null ? null : at instanceof Date ? at.toISOString() : at)
const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
/** A yes/no argument; the words true and false count as one (z.coerce.boolean would read "false" as true). */
const flag = z.preprocess((value) => (value === 'true' ? true : value === 'false' ? false : value), z.boolean())
const limitArg = (what: string) => z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional()
  .describe(`${what} (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE})`)
const cursorArg = z.string().min(1).max(MAX_CURSOR_LENGTH).optional()
  .describe('nextCursor from the previous page, with the same filters; omit it for the first page')
const capped = <T>(list: T[], cap = NESTED_CAP) => ({ shown: list.slice(0, cap), more: Math.max(0, list.length - cap) })

/** A cursor belongs to one tool, one business and one set of filters; `size` too when pages must line up. */
function scopeOf(tool: string, args: Record<string, unknown>, size?: number): string {
  const { limit: _limit, cursor: _cursor, ...filters } = args
  return cursorScope(tool, { business: workspaceIdForQuery(), ...filters, ...(size ? { size } : {}) })
}

async function readTool(name: string, work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof InvalidCursorError) return { ok: false, error: `${name} was called wrongly — cursor: ${error.message}` }
    throw error
  }
}

/** A page of a list read in a fixed order: the cursor carries where the next page starts. */
function offsetOf(scope: string, cursor: string | undefined): number {
  const start = decodeCursor(scope, cursor)
  if (!start) return 0
  const at = start.values[0]
  if (typeof at !== 'number' || !Number.isInteger(at) || at < 0) throw new InvalidCursorError()
  return at
}
const nextAt = (scope: string, at: number) => encodeCursor(scope, { values: [at], id: 'page' })

/** Money keys these tools add beyond the shared registry (costPrice, unitCostCents, costCents, … are already in it). */
const PO_MONEY = {
  totalCents: FIELDS.financialsSuppliersView,
  orderedCents: FIELDS.financialsSuppliersView,
  receivedCents: FIELDS.financialsSuppliersView,
  varianceCents: FIELDS.financialsSuppliersView,
  fiscal: FIELDS.financialsSuppliersView,
  receivedUnitCostCents: FIELDS.financialsCostsView,
  landedUnitCostCents: FIELDS.financialsCostsView,
  landedCost: FIELDS.financialsCostsView,
} as const

// ── suppliers ─────────────────────────────────────────────────────────────────────────────────────────

const suppliers: AgentTool = {
  name: 'supplier-search',
  title: 'Suppliers',
  input: z.object({
    supplierId: z.string().trim().min(1).max(64).optional().describe('one supplier: contacts, products with cost and MOQ, recent POs'),
    query: z.string().trim().min(1).max(100).optional().describe('suppliers whose name contains this text'),
    activeOnly: flag.optional().describe('only active suppliers'),
    limit: limitArg('suppliers listed'),
  }),
  requires: [F.suppliersView],
  restrictedFields: { totalCents: FIELDS.financialsSuppliersView },
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'Suppliers. Without supplierId: the suppliers by name, each with country, currency, lead time and how many '
    + 'products and purchase orders it has. With supplierId: that supplier\'s details, lead and production times, '
    + 'contacts, the products it supplies (supplier SKU, cost, MOQ, case pack, lead time, primary or not, last landed '
    + 'cost) and its 20 latest purchase orders. Costs, payment terms and PO totals are shown only to a person who may '
    + 'see supplier money.',
  async handler(args) {
    const id = args.supplierId as string | undefined
    if (id) {
      const s = await readSupplier(id)
      if (!s) return { ok: false, error: 'Supplier not found' }
      const productIds = s.products.map((p) => p.productId)
      const skus = productIds.length
        ? new Map((await prisma.product.findMany({ where: { id: { in: productIds }, deletedAt: null }, select: { id: true, sku: true, name: true } })).map((p) => [p.id, p]))
        : new Map<string, { sku: string; name: string }>()
      const products = capped(s.products.filter((p) => skus.has(p.productId)), 50)
      return {
        ok: true,
        data: {
          id: s.id,
          name: s.name,
          isActive: s.isActive,
          contact: { name: s.contactName, email: s.email, phone: s.phone },
          address: { line1: s.addressLine1, city: s.city, postalCode: s.postalCode, country: s.country },
          taxId: s.taxId,
          paymentTerms: s.paymentTerms,
          defaultCurrency: s.defaultCurrency,
          leadTimeDays: s.leadTimeDays,
          productionTimeDays: s.productionTimeDays,
          shippingTimeDays: s.shippingTimeDays,
          autoReorder: s.autoTriggerEnabled,
          notes: clip(s.notes),
          contacts: s.contacts.slice(0, NESTED_CAP).map((c) => ({ name: c.name, role: c.role, email: c.email, phone: c.phone, isPrimary: c.isPrimary })),
          products: products.shown.map((p) => ({
            productId: p.productId,
            sku: skus.get(p.productId)!.sku,
            name: skus.get(p.productId)!.name,
            supplierSku: p.supplierSku,
            costCents: p.costCents,
            currencyCode: p.currencyCode,
            moq: p.moq,
            casePack: p.casePack,
            leadTimeDays: p.leadTimeDaysOverride ?? s.leadTimeDays,
            isPrimary: p.isPrimary,
            lastLandedCostCents: p.lastLandedCostCents,
          })),
          ...(products.more ? { moreProducts: products.more } : {}),
          recentPurchaseOrders: s.purchaseOrders.filter((po) => !po.deletedAt).map((po) => ({
            id: po.id, poNumber: po.poNumber, status: po.status, totalCents: po.totalCents, currencyCode: po.currencyCode,
            expectedDeliveryDate: iso(po.expectedDeliveryDate), createdAt: iso(po.createdAt),
          })),
        },
      }
    }
    const limit = pageSize(args.limit as number | undefined)
    const out = await listSuppliers({ search: args.query, activeOnly: args.activeOnly === true ? 'true' : undefined })
    return {
      ok: true,
      data: {
        total: out.total,
        suppliers: out.items.slice(0, limit).map((s) => ({
          id: s.id, name: s.name, isActive: s.isActive, country: s.country, defaultCurrency: s.defaultCurrency,
          leadTimeDays: s.leadTimeDays, products: s._count.products, purchaseOrders: s._count.purchaseOrders,
        })),
        ...(out.total > limit ? { note: `${out.total} suppliers match; this answer has ${limit}. Narrow by query.` } : {}),
      },
    }
  },
}

// ── purchase-orders ───────────────────────────────────────────────────────────────────────────────────

const PO_STATUSES = ['DRAFT', 'REVIEW', 'APPROVED', 'SUBMITTED', 'ACKNOWLEDGED', 'CONFIRMED', 'PARTIAL', 'RECEIVED', 'CANCELLED'] as const
const OPEN_PO = ['DRAFT', 'REVIEW', 'APPROVED', 'SUBMITTED', 'ACKNOWLEDGED', 'CONFIRMED', 'PARTIAL']

const purchaseOrders: AgentTool = {
  name: 'purchase-orders',
  title: 'Purchase orders',
  input: z.object({
    purchaseOrderId: z.string().trim().min(1).max(64).optional()
      .describe('one PO: its lines with ordered, received and open quantities, the match and landed cost, its shipments'),
    status: z.preprocess(upper, z.enum(PO_STATUSES)).optional().describe('only POs in this status'),
    supplierId: z.string().trim().min(1).max(64).optional().describe('only this supplier\'s POs'),
    lateOnly: flag.optional().describe('only open POs past their expected delivery date'),
    limit: limitArg('POs listed'),
  }),
  requires: [F.poView],
  restrictedFields: PO_MONEY,
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'Purchase orders. Without purchaseOrderId: the newest POs (not deleted), each with supplier, status, currency, '
    + 'lines, units ordered and received, expected delivery and whether it is late; filter by status, supplier or '
    + 'late. With purchaseOrderId: the PO, its workflow dates (reviewed, approved, sent, acknowledged), each line\'s '
    + 'ordered, received and open quantity and match status (pending, partial, matched, over, price-variance), the '
    + 'totals, landed cost and its inbound shipments. Totals, unit and landed costs are shown only to a person who may '
    + 'see them. Drafting, approving and sending happen in Nexus.',
  async handler(args) {
    const id = args.purchaseOrderId as string | undefined
    if (id) {
      const [po, match] = await Promise.all([readPurchaseOrder(id), readPurchaseOrderMatch(id)])
      if (!po || !match || po.deletedAt) return { ok: false, error: 'Purchase order not found' }
      const lines = capped(match.lines, LINES_CAP)
      return {
        ok: true,
        data: {
          id: po.id,
          poNumber: po.poNumber,
          status: po.status,
          version: po.version,
          supplier: po.supplier ? { id: po.supplier.id, name: po.supplier.name, email: po.supplier.email } : null,
          warehouse: po.warehouse?.code ?? null,
          currencyCode: po.currencyCode,
          totalCents: po.totalCents,
          expectedDeliveryDate: iso(po.expectedDeliveryDate),
          supplierConfirmedDeliveryDate: iso(po.supplierConfirmedDeliveryDate),
          workflow: {
            createdAt: iso(po.createdAt), reviewedAt: iso(po.reviewedAt), approvedAt: iso(po.approvedAt),
            sentAt: iso(po.submittedAt), acknowledgedAt: iso(po.acknowledgedAt), cancelledAt: iso(po.cancelledAt),
            cancelledReason: clip(po.cancelledReason),
          },
          notes: clip(po.notes),
          lines: lines.shown.map((l) => ({
            productId: l.productId, sku: l.sku, supplierSku: l.supplierSku, ordered: l.orderedQty, received: l.receivedQty, open: l.openQty,
            match: l.status, unitCostCents: l.orderedUnitCostCents, receivedUnitCostCents: l.receivedAvgUnitCostCents,
            landedUnitCostCents: l.landedUnitCentsEur,
          })),
          ...(lines.more ? { moreLines: lines.more } : {}),
          totals: {
            orderedQty: match.totals.orderedQty, receivedQty: match.totals.receivedQty, shortfallUnits: match.totals.shortfallUnits,
            withinTolerance: match.totals.withinTolerance, orderedCents: match.totals.orderedCents, receivedCents: match.totals.receivedCents,
            varianceCents: match.totals.varianceCents,
          },
          landedCost: { currency: 'EUR', ...match.landed },
          flags: match.flags,
          inboundShipments: po.inboundShipments.slice(0, NESTED_CAP).map((s) => ({
            id: s.id, reference: s.reference, status: s.status, expectedAt: iso(s.expectedAt), arrivedAt: iso(s.arrivedAt),
          })),
          ...(po.fiscal ? { fiscal: po.fiscal } : {}),
        },
      }
    }
    const limit = pageSize(args.limit as number | undefined)
    const out = await listPurchaseOrders({ status: args.status, supplierId: args.supplierId, lateOnly: args.lateOnly === true ? 'true' : undefined })
    const now = Date.now()
    return {
      ok: true,
      data: {
        total: out.total,
        purchaseOrders: out.items.slice(0, limit).map((po) => ({
          id: po.id,
          poNumber: po.poNumber,
          status: po.status,
          supplier: po.supplier?.name ?? null,
          warehouse: po.warehouse?.code ?? null,
          currencyCode: po.currencyCode,
          totalCents: po.totalCents,
          lines: po.items.length,
          unitsOrdered: po.items.reduce((sum, i) => sum + i.quantityOrdered, 0),
          unitsReceived: po.items.reduce((sum, i) => sum + i.quantityReceived, 0),
          expectedDeliveryDate: iso(po.expectedDeliveryDate),
          late: !!po.expectedDeliveryDate && po.expectedDeliveryDate.getTime() < now && OPEN_PO.includes(po.status),
          createdAt: iso(po.createdAt),
        })),
        ...(out.total > limit ? { note: `${out.total} POs match (newest 200 at most); this answer has ${limit}. Narrow by status or supplier.` } : {}),
      },
    }
  },
}

// ── inbound-shipments ─────────────────────────────────────────────────────────────────────────────────

const INBOUND_TYPES = ['FBA', 'SUPPLIER', 'MANUFACTURING', 'TRANSFER'] as const
const INBOUND_STATUSES = ['DRAFT', 'SUBMITTED', 'IN_TRANSIT', 'ARRIVED', 'RECEIVING', 'PARTIALLY_RECEIVED', 'RECEIVED', 'RECONCILED', 'CLOSED', 'CANCELLED'] as const
const INBOUND = 'inbound-shipments'

const inboundShipments: AgentTool = {
  name: INBOUND,
  title: 'Inbound shipments',
  input: z.object({
    shipmentId: z.string().trim().min(1).max(64).optional().describe('one shipment: its lines, receipts, discrepancies and landed cost'),
    type: z.preprocess(upper, z.enum(INBOUND_TYPES)).optional().describe('only this kind: FBA, SUPPLIER, MANUFACTURING or TRANSFER'),
    status: z.preprocess(upper, z.enum(INBOUND_STATUSES)).optional().describe('only shipments in this status'),
    query: z.string().trim().min(1).max(100).optional().describe('reference, tracking number, carrier, FBA shipment id, ASN, PO number or a SKU on it'),
    delayedOnly: flag.optional().describe('only open shipments past their expected date'),
    limit: limitArg('shipments per page'),
    cursor: cursorArg,
  }),
  requires: [F.inboundManage],
  restrictedFields: PO_MONEY,
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'Inbound shipments (from suppliers, manufacturing, transfers and to Amazon FBA), newest first. Each with type, '
    + 'status, reference, PO, warehouse, expected and arrival dates, carrier and tracking, units expected and '
    + 'received, and open discrepancies; plus the latest FBA inbound plans. With shipmentId: its lines (expected, '
    + 'received, QC, lot), discrepancies and landed cost (goods, shipping, customs, duties, insurance — shown only to '
    + 'a person who may see costs). Receiving happens in Nexus. Returns { items, nextCursor, total }.',
  handler: (args) => readTool(INBOUND, async () => {
    const id = args.shipmentId as string | undefined
    if (id) {
      const s = await readInboundShipment(id)
      if (!s || s.deletedAt) return { ok: false, error: 'Inbound shipment not found' }
      const lines = capped(s.items, LINES_CAP)
      const discrepancies = [...s.discrepancies, ...s.items.flatMap((i) => i.discrepancies)]
      return {
        ok: true,
        data: {
          id: s.id, type: s.type, status: s.status, reference: s.reference, purchaseOrder: s.purchaseOrder?.poNumber ?? null,
          purchaseOrderId: s.purchaseOrderId, warehouse: s.warehouse?.code ?? null, fbaShipmentId: s.fbaShipmentId, asnNumber: s.asnNumber,
          expectedAt: iso(s.expectedAt), arrivedAt: iso(s.arrivedAt), closedAt: iso(s.closedAt),
          carrier: s.carrierCode, trackingNumber: s.trackingNumber, notes: clip(s.notes),
          lines: lines.shown.map((i) => ({
            productId: i.productId, sku: i.sku, expected: i.quantityExpected, received: i.quantityReceived, open: Math.max(0, i.quantityExpected - i.quantityReceived),
            qcStatus: i.qcStatus, lotNumber: i.lotNumber, expiryDate: iso(i.expiryDate), unitCostCents: i.unitCostCents, receipts: i.receipts.length,
          })),
          ...(lines.more ? { moreLines: lines.more } : {}),
          discrepancies: discrepancies.slice(0, NESTED_CAP).map((d) => ({
            reason: d.reasonCode, status: d.status, expected: d.expectedValue, actual: d.actualValue, quantityImpact: d.quantityImpact,
            costImpactCents: d.costImpactCents, description: clip(d.description), reportedAt: iso(d.reportedAt),
          })),
          landedCost: { ...s.landedCost, exchangeRate: s.landedCost.exchangeRate == null ? null : Number(s.landedCost.exchangeRate) },
        },
      }
    }
    const size = pageSize(args.limit as number | undefined)
    // The moved list reads by page number, so a cursor is bound to the page size it was made with.
    const scope = scopeOf(INBOUND, args, size)
    const at = offsetOf(scope, args.cursor as string | undefined)
    if (at % size !== 0) throw new InvalidCursorError()
    const page = at / size + 1
    const out = await listInboundShipments({
      type: args.type, status: args.status, search: args.query, delayed: args.delayedOnly === true ? 'true' : undefined, page, pageSize: size,
    })
    const plans = at === 0
      ? await prisma.fbaInboundPlanV2.findMany({ orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, name: true, status: true, currentStep: true, inboundShipmentId: true, shipmentIds: true, createdAt: true, lastError: true } })
      : []
    const now = Date.now()
    return {
      ok: true,
      data: {
        total: out.total,
        items: out.items.map((s) => ({
          id: s.id, type: s.type, status: s.status, reference: s.reference, purchaseOrder: s.purchaseOrder?.poNumber ?? null,
          warehouse: s.warehouse?.code ?? null, expectedAt: iso(s.expectedAt), arrivedAt: iso(s.arrivedAt),
          carrier: s.carrierCode, trackingNumber: s.trackingNumber,
          lines: s.items.length,
          unitsExpected: s.items.reduce((sum, i) => sum + i.quantityExpected, 0),
          unitsReceived: s.items.reduce((sum, i) => sum + i.quantityReceived, 0),
          discrepancies: s._count.discrepancies,
          delayed: !!s.expectedAt && s.expectedAt.getTime() < now && !['RECEIVED', 'RECONCILED', 'CLOSED', 'CANCELLED'].includes(s.status),
        })),
        nextCursor: page * size < out.total ? nextAt(scope, page * size) : null,
        ...(plans.length ? {
          fbaInboundPlans: plans.map((p) => ({
            id: p.id, name: p.name, status: p.status, step: p.currentStep, inboundShipmentId: p.inboundShipmentId, amazonShipments: p.shipmentIds.length,
            createdAt: iso(p.createdAt), lastError: clip(p.lastError),
          })),
        } : {}),
      },
    }
  }),
}

// ── product-costs ─────────────────────────────────────────────────────────────────────────────────────

const PRODUCT_COSTS = 'product-costs'
const productCosts: AgentTool = {
  name: PRODUCT_COSTS,
  title: 'Product costs',
  input: z.object({
    productId: z.string().trim().min(1).max(64).optional().describe('one product: its cost, costing method, cost layers and supplier costs'),
    sku: z.string().trim().min(1).max(100).optional().describe('one product by its exact SKU'),
    missingOnly: flag.optional().describe('in the list: only products with no cost price'),
    limit: limitArg('products per page'),
    cursor: cursorArg,
  }),
  requires: [F.productsView, FIELDS.financialsCostsView],
  category: 'products',
  riskTier: 'low',
  readOnly: true,
  description:
    'Product costs (needs permission to see costs). Without a product: the active products, best sellers on Amazon '
    + 'in the last 90 days first, each with its cost price (EUR) or none, and how many have no cost. With productId or '
    + 'sku: its cost price, costing method (WAC, FIFO, LIFO), the current unit cost, the weighted average, its stock '
    + 'cost layers (newest 20: units, unit cost, freight, duty, insurance), what each supplier charges and the last '
    + 'landed cost, and its latest PO lines. Returns { items, nextCursor, missingCost } for the list.',
  handler: (args) => readTool(PRODUCT_COSTS, async () => {
    const sku = args.sku as string | undefined
    let productId = args.productId as string | undefined
    if (productId && !(await isLiveProduct(productId))) return { ok: false, error: PRODUCT_NOT_FOUND }
    if (!productId && sku) {
      productId = (await prisma.product.findFirst({ where: { sku, deletedAt: null }, select: { id: true } }))?.id
      if (!productId) return { ok: false, error: PRODUCT_NOT_FOUND }
    }
    if (productId) {
      const p = await prisma.product.findFirst({
        where: { id: productId, deletedAt: null },
        select: { id: true, sku: true, name: true, costPrice: true, costingMethod: true, weightedAvgCostCents: true },
      })
      if (!p) return { ok: false, error: PRODUCT_NOT_FOUND }
      const [current, layers, supplierRows, poLines] = await Promise.all([
        getCurrentCost(p.id),
        listLayers(p.id, NESTED_CAP),
        prisma.supplierProduct.findMany({
          where: { productId: p.id },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          take: NESTED_CAP,
          select: { costCents: true, currencyCode: true, moq: true, isPrimary: true, lastLandedCostCents: true, lastLandedCostUpdatedAt: true, supplier: { select: { id: true, name: true } } },
        }),
        prisma.purchaseOrderItem.findMany({
          where: { productId: p.id, purchaseOrder: { deletedAt: null } },
          orderBy: { purchaseOrder: { createdAt: 'desc' } },
          take: 5,
          select: { quantityOrdered: true, quantityReceived: true, unitCostCents: true, purchaseOrder: { select: { id: true, poNumber: true, status: true, currencyCode: true, createdAt: true } } },
        }),
      ])
      return {
        ok: true,
        data: {
          productId: p.id,
          sku: p.sku,
          name: p.name,
          costPrice: p.costPrice == null ? null : Number(p.costPrice),
          costPriceCurrency: 'EUR',
          costingMethod: p.costingMethod ?? 'WAC',
          weightedAvgCostCents: p.weightedAvgCostCents,
          currentUnitCostCents: current,
          layers: layers.map((l) => ({
            receivedAt: iso(l.receivedAt), location: (l as { locationCode?: string | null }).locationCode ?? null, unitsReceived: l.unitsReceived,
            unitsRemaining: l.unitsRemaining, unitCostCents: l.unitCostCents, freightCents: l.freightCents, dutyCents: l.dutyCents,
            insuranceCents: l.insuranceCents, inboundShipmentId: l.inboundShipmentId,
          })),
          suppliers: supplierRows.map((s) => ({
            supplierId: s.supplier.id, supplier: s.supplier.name, isPrimary: s.isPrimary, costCents: s.costCents, currencyCode: s.currencyCode,
            moq: s.moq, lastLandedCostCents: s.lastLandedCostCents, lastLandedAt: iso(s.lastLandedCostUpdatedAt),
          })),
          recentPurchaseLines: poLines.map((l) => ({
            purchaseOrderId: l.purchaseOrder.id, poNumber: l.purchaseOrder.poNumber, status: l.purchaseOrder.status, at: iso(l.purchaseOrder.createdAt),
            ordered: l.quantityOrdered, received: l.quantityReceived, unitCostCents: l.unitCostCents, currencyCode: l.purchaseOrder.currencyCode,
          })),
        },
      }
    }
    const size = pageSize(args.limit as number | undefined)
    const scope = scopeOf(PRODUCT_COSTS, args)
    const at = offsetOf(scope, args.cursor as string | undefined)
    const grid = await getCostGrid()
    const rows = args.missingOnly === true ? grid.products.filter((r) => r.costPrice == null) : grid.products
    const page = rows.slice(at, at + size)
    return {
      ok: true,
      data: {
        missingCost: grid.missingCost,
        total: rows.length,
        items: page.map((r) => ({ productId: r.id, sku: r.sku, name: r.name, costPrice: r.costPrice, unitsSold90dAmazon: r.unitsSold90d })),
        nextCursor: at + size < rows.length ? nextAt(scope, at + size) : null,
      },
    }
  }),
}

// ── replenishment-suggestions ─────────────────────────────────────────────────────────────────────────

const URGENCIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const
const URGENCY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
const REPLENISHMENT = 'replenishment-suggestions'

const replenishmentSuggestions: AgentTool = {
  name: REPLENISHMENT,
  title: 'Replenishment suggestions',
  input: z.object({
    productId: z.string().trim().min(1).max(64).optional()
      .describe('one product: its suggestion, its suppliers ranked for this order, and when it runs out'),
    urgency: z.preprocess(upper, z.enum(URGENCIES)).optional().describe('only suggestions of this urgency'),
    includeNotNeeded: flag.optional().describe('also products that need no reorder now (default: only those that do)'),
    limit: limitArg('suggestions per page'),
    cursor: cursorArg,
  }),
  requires: [F.replenishmentView, F.forecastView],
  restrictedFields: {
    unitCostCentsEur: FIELDS.financialsCostsView,
    totalLostRevenueCents: FIELDS.financialsRevenueView,
    totalLostMarginCents: FIELDS.financialsMarginsView,
  },
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  description:
    'What to reorder, as Nexus last worked it out (the stored suggestions; reading them changes nothing): per product '
    + 'the urgency (CRITICAL, HIGH, MEDIUM, LOW), how much and when (reorder quantity and point), stock with inbound, '
    + 'days of stock left, sales per day, lead time, the worst channel, Amazon\'s own restock number, most urgent first. '
    + 'With productId: its suggestion, its suppliers ranked for this order (cost, speed, MOQ, reliability, with why) '
    + 'and when it is projected to run out. The list also gives the stockouts of the last 30 days. Costs, lost revenue '
    + 'and margin are shown only to a person who may see them. Drafting a purchase order happens in Nexus.',
  handler: (args, ctx) => readTool(REPLENISHMENT, async () => {
    const productId = args.productId as string | undefined
    const seesCost = ctx.can(FIELDS.financialsCostsView)
    if (productId) {
      if (!(await isLiveProduct(productId))) return { ok: false, error: PRODUCT_NOT_FOUND }
      const [rec, candidates, projection] = await Promise.all([
        prisma.replenishmentRecommendation.findFirst({
          where: { productId, status: 'ACTIVE' },
          orderBy: { generatedAt: 'desc' },
          include: { product: { select: { sku: true, name: true } } },
        }),
        loadCandidatesForProduct({ productId }),
        projectStockout(prisma as never, productId),
      ])
      const ranked = rankSuppliers({ candidates, urgency: (rec?.urgency as (typeof URGENCIES)[number] | undefined) ?? undefined })
      return {
        ok: true,
        data: {
          suggestion: rec ? suggestionView(rec) : null,
          ...(rec ? {} : { note: 'No suggestion has been worked out for this product yet.' }),
          suppliers: ranked.slice(0, NESTED_CAP).map((r) => ({
            supplierId: r.supplierId, supplier: r.supplierName, rank: r.rank, score: Math.round(r.compositeScore * 100) / 100,
            unitCostCentsEur: r.unitCostCentsEur, currencyCode: r.currencyCode, leadTimeDays: r.leadTimeDays, moq: r.moq, casePack: r.casePack,
            paymentTerms: r.paymentTerms, preferred: r.isCurrentlyPreferred,
            // A note like "+€1.20/unit vs …" names a cost: only for a person who may see costs.
            why: r.notes.filter((n) => seesCost || !/€/.test(n)),
          })),
          runsOut: projection
            ? { velocity: projection.velocity, daysOfCover: projection.daysOfCover, on: iso(projection.stockoutDate), urgency: projection.urgency, basis: projection.basis }
            : null,
        },
      }
    }
    const size = pageSize(args.limit as number | undefined)
    const scope = scopeOf(REPLENISHMENT, args)
    const at = offsetOf(scope, args.cursor as string | undefined)
    const [rows, stockouts] = await Promise.all([
      prisma.replenishmentRecommendation.findMany({
        where: {
          status: 'ACTIVE',
          product: { deletedAt: null },
          ...(args.includeNotNeeded === true ? {} : { needsReorder: true }),
          ...(args.urgency ? { urgency: args.urgency as string } : {}),
        },
        include: { product: { select: { sku: true, name: true } } },
      }),
      at === 0 ? getStockoutSummary({ windowDays: 30 }) : Promise.resolve(null),
    ])
    rows.sort((a, b) => (URGENCY_RANK[a.urgency] ?? 9) - (URGENCY_RANK[b.urgency] ?? 9)
      || (a.daysOfStockLeft ?? Number.MAX_SAFE_INTEGER) - (b.daysOfStockLeft ?? Number.MAX_SAFE_INTEGER)
      || a.sku.localeCompare(b.sku) || a.id.localeCompare(b.id))
    const page = rows.slice(at, at + size)
    return {
      ok: true,
      data: {
        total: rows.length,
        items: page.map(suggestionView),
        nextCursor: at + size < rows.length ? nextAt(scope, at + size) : null,
        ...(stockouts ? {
          stockoutsLast30Days: {
            open: stockouts.openCount, started: stockouts.eventsInWindow, days: stockouts.totalDurationDays, lostUnits: stockouts.totalLostUnits,
            totalLostRevenueCents: stockouts.totalLostRevenueCents, totalLostMarginCents: stockouts.totalLostMarginCents,
            longest: stockouts.worstSku ? { sku: stockouts.worstSku.sku, days: stockouts.worstSku.durationDays == null ? null : Number(stockouts.worstSku.durationDays) } : null,
          },
        } : {}),
      },
    }
  }),
}

type RecommendationRow = Awaited<ReturnType<typeof prisma.replenishmentRecommendation.findMany>>[number] & { product: { sku: string; name: string } }
function suggestionView(r: RecommendationRow) {
  return {
    productId: r.productId,
    sku: r.product.sku,
    name: r.product.name,
    urgency: r.urgency,
    needsReorder: r.needsReorder,
    reorderQuantity: r.reorderQuantity,
    reorderPoint: r.reorderPoint,
    available: r.totalAvailable,
    inboundWithinLeadTime: r.inboundWithinLeadTime,
    effectiveStock: r.effectiveStock,
    daysOfStockLeft: r.daysOfStockLeft,
    unitsPerDay: Number(r.velocity),
    leadTimeDays: r.leadTimeDays,
    safetyStockUnits: r.safetyStockUnits,
    ...(r.worstChannelKey ? { worstChannel: { key: r.worstChannelKey, daysOfCover: r.worstChannelDaysOfCover } } : {}),
    ...(r.amazonRecommendedQty != null ? { amazonRecommends: r.amazonRecommendedQty } : {}),
    unitCostCents: r.unitCostCents,
    landedCostPerUnitCents: r.landedCostPerUnitCents,
    preferredSupplierId: r.preferredSupplierId,
    workedOutAt: iso(r.generatedAt),
  }
}

export const SUPPLY_READ_TOOLS: AgentTool[] = [suppliers, purchaseOrders, inboundShipments, productCosts, replenishmentSuggestions]
