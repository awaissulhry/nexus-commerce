/**
 * BD.2 — Bundle consume service.
 *
 * Uses the existing Bundle + BundleComponent catalog tables (one
 * Bundle per bundle Product, components are referenced products).
 * When a bundle product sells, fans out to one applyStockMovement
 * per component (componentQuantity * order qty).
 *
 * The dispatch is opt-in via Product.isBundle = true. Callers ask
 * consumeBundleOrPassthrough(args); if the product isn't a bundle,
 * a single applyStockMovement runs unchanged.
 */

import prisma from '../db.js'
import { applyStockMovement, type StockMovementInput } from './stock-movement.service.js'

export interface BundleConsumeArgs {
  productId: string
  variationId?: string
  quantity: number
  reason: StockMovementInput['reason']
  locationId?: string
  warehouseId?: string
  referenceType?: string
  referenceId?: string
  orderId?: string
  shipmentId?: string
  returnId?: string
  reservationId?: string
  notes?: string
  actor?: string
}

/**
 * Consume a bundle by decrementing each component's stock. Returns
 * the per-component movement IDs.
 *
 * Throws if the product is marked isBundle but has zero
 * BundleComponent rows — that's a misconfiguration the operator must
 * fix before selling the bundle. (Allowing it would silently sell a
 * bundle that decrements nothing.)
 */
export async function consumeBundle(args: BundleConsumeArgs): Promise<{ componentMovementIds: string[]; componentsConsumed: number }> {
  if (args.quantity <= 0) throw new Error('consumeBundle: quantity must be > 0')
  const bundle = await prisma.bundle.findUnique({
    where: { productId: args.productId },
    include: { components: true },
  })
  if (!bundle) {
    throw new Error(`consumeBundle: product ${args.productId} marked isBundle but has no Bundle row`)
  }
  if (bundle.components.length === 0) {
    throw new Error(`consumeBundle: bundle ${bundle.id} has no components — refusing to silently consume nothing`)
  }
  if (!bundle.isActive) {
    throw new Error(`consumeBundle: bundle ${bundle.id} is inactive`)
  }

  const componentMovementIds: string[] = []
  for (const c of bundle.components) {
    const totalQty = c.quantity * args.quantity
    const m = await applyStockMovement({
      productId: c.productId,
      change: -totalQty,
      reason: args.reason,
      locationId: args.locationId,
      warehouseId: args.warehouseId,
      referenceType: args.referenceType ?? 'BundleConsume',
      referenceId: args.referenceId,
      orderId: args.orderId,
      shipmentId: args.shipmentId,
      returnId: args.returnId,
      reservationId: args.reservationId,
      notes: args.notes
        ? `${args.notes} [bundle ${args.productId} component]`
        : `Bundle ${args.productId} component`,
      actor: args.actor,
    })
    componentMovementIds.push(m.id)
  }
  return { componentMovementIds, componentsConsumed: bundle.components.length }
}

/**
 * Dispatch helper: if the product isBundle, fan out to component
 * consumes; otherwise pass through to a single applyStockMovement.
 * The order-ingest / consume-reservation hot paths can call this
 * unconditionally — the runtime decides which path to take.
 */
export async function consumeBundleOrPassthrough(args: BundleConsumeArgs) {
  const product = await prisma.product.findUnique({
    where: { id: args.productId },
    select: { isBundle: true },
  })
  if (product?.isBundle) {
    return { kind: 'bundle' as const, ...(await consumeBundle(args)) }
  }
  // Pass-through: single applyStockMovement, mimics original behavior.
  const m = await applyStockMovement({
    productId: args.productId,
    variationId: args.variationId,
    change: -args.quantity,
    reason: args.reason,
    locationId: args.locationId,
    warehouseId: args.warehouseId,
    referenceType: args.referenceType,
    referenceId: args.referenceId,
    orderId: args.orderId,
    shipmentId: args.shipmentId,
    returnId: args.returnId,
    reservationId: args.reservationId,
    notes: args.notes,
    actor: args.actor,
  })
  return { kind: 'passthrough' as const, movementId: m.id }
}

/**
 * Bundle ATP: a bundle's available qty is min(component.totalStock /
 * componentQuantity) across components. Surfaces in the StockDrawer
 * for bundle products.
 */
export async function bundleAtp(productId: string): Promise<{
  available: number
  limitingComponentId: string | null
  components: Array<{ productId: string; sku: string; required: number; onHand: number; canFulfill: number }>
}> {
  const bundle = await prisma.bundle.findUnique({
    where: { productId },
    include: {
      components: {
        include: {
          // BundleComponent.product relation isn't defined on the
          // existing model; resolve names manually below.
        },
      },
    },
  })
  if (!bundle) return { available: 0, limitingComponentId: null, components: [] }

  const componentProducts = await prisma.product.findMany({
    where: { id: { in: bundle.components.map((c) => c.productId) } },
    select: { id: true, sku: true, totalStock: true },
  })
  const byId = new Map(componentProducts.map((p) => [p.id, p]))

  let available = Number.POSITIVE_INFINITY
  let limiting: string | null = null
  const rows = bundle.components.map((c) => {
    const p = byId.get(c.productId)
    const onHand = p?.totalStock ?? 0
    const canFulfill = Math.floor(onHand / c.quantity)
    if (canFulfill < available) {
      available = canFulfill
      limiting = c.id
    }
    return {
      productId: c.productId,
      sku: p?.sku ?? '?',
      required: c.quantity,
      onHand,
      canFulfill,
    }
  })

  return {
    available: Number.isFinite(available) ? available : 0,
    limitingComponentId: limiting,
    components: rows,
  }
}
