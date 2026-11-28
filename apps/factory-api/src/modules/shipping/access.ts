import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { SHIPPING_MANAGE, SHIPPING_PLAN, SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import type { CommandCaller } from '../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../core/context'

/**
 * Who works on shipments, and where (plan A1 §2.2, §3.11): the office over the companies, sites and parties its grants
 * reach; a floor device packs at its own site only (can() pins it, row-level security too). The floor never plans,
 * ships or cancels a shipment, and reads no sales order or party: its routes take only what packing needs.
 */

export type ShippingContext = OfficeContext | FloorContext

export function shippingContextOf(caller: CommandCaller): ShippingContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office' && context.audience !== 'floor') throw new ForbiddenError()
  return context
}

export function officeContextOf(caller: CommandCaller): OfficeContext {
  const context = shippingContextOf(caller)
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** The scope of a shipment (or a row of it): its company, site and party. */
export interface ShipmentScope {
  readonly companyId: string
  /** Absent for a row of no site (a sales order). */
  readonly siteId?: string | null
  readonly partyId?: string | null
}

export const mayOn = (context: ShippingContext, permission: Permission, row: ShipmentScope): boolean =>
  can(actorOf(context), permission, { companyId: row.companyId, ...(row.siteId ? { siteId: row.siteId } : {}), ...(row.partyId ? { partyId: row.partyId } : {}) })

/**
 * The caller may see the row (`see`, else it is not found) and do `permission` on it (else forbidden). A floor device
 * sees only its own site's rows (row-level security has already hidden the others).
 */
export function assertMay(context: ShippingContext, see: Permission, permission: Permission, row: ShipmentScope | null, what = 'Shipment'): asserts row is ShipmentScope {
  if (!row || !mayOn(context, see, row)) throw new NotFoundError(`${what} not found.`)
  if (!mayOn(context, permission, row)) throw new ForbiddenError()
}

// ── owb- (order workflow, S3 ss1 step 1.1; settle L3, plan.md § 5 D, R38): planning a shipment is apart from packing and sending it ──
/**
 * Who PLANS a shipment — how an order travels: a new DRAFT (alone, together, to our warehouse first), its lines and delivery
 * details, cancelling it, moving, merging, taking an order off, splitting it: shipping.plan (Sales, the production manager) OR
 * shipping.manage (the warehouse, which packs and sends: still everything). The routes' manifest asks shipping.view (it takes ONE
 * right, core/manifest.ts); EVERY plan handler asks this one helper over the shipment's company, site and customer. Holds, packing,
 * the DDT, labels, ship, proof of delivery and own transport keep their own rights.
 */
export const mayPlanShipments = (context: ShippingContext, row: ShipmentScope): boolean => mayOn(context, SHIPPING_PLAN, row) || mayOn(context, SHIPPING_MANAGE, row)

/** The caller may see the row (else it is not found) and plan it (shipping.plan or shipping.manage; else forbidden). */
export function assertMayPlan(context: ShippingContext, row: ShipmentScope | null, what = 'Shipment'): asserts row is ShipmentScope {
  if (!row || !mayOn(context, SHIPPING_VIEW, row)) throw new NotFoundError(`${what} not found.`)
  if (!mayPlanShipments(context, row)) throw new ForbiddenError()
}
// ── end owb- ──
