import type { FactoryClient } from '@nexus/factory-db'
import type { OrderWarningKind } from '@nexus/factory-domain/sales/warnings/kinds'
import { leavingWarnings } from '@nexus/factory-domain/shipping/warehouse-leg/rules'
import type { CommandTx } from '../../../core/command'
import { ordersOfShipment, type ShipmentKey } from '../shipments/orders-of'

/**
 * A payment due is a warning when the goods leave (owb- order workflow, S3 ss1 step 1.4; settle L2, Owner R39 (a)): the system no
 * longer holds a shipment for the balance before shipping (factory-domain shipping/holds/system). Instead, at the moment the goods
 * leave TO THE CUSTOMER — POST /shipping/shipments/:id/ship and the DDT's issue-and-ship (../ddt/ddt.ts) for a shipment straight to
 * the customer, POST …/forward for one sent on from our warehouse — an OPEN before-shipping step of any order on the shipment is
 * the warning PAYMENT_DUE_AT_SHIP: the base's checkWarnings answers 409 with the list until the caller passes it on (`overrides`),
 * then the command's own audit row keeps `passedWarnings` (history: "Left with a payment open"). The way to our own warehouse
 * leaves without it (the goods stay ours).
 */
export async function leavingWarningsOf(db: FactoryClient | CommandTx, shipment: ShipmentKey, options: { readonly toOurWarehouse: boolean }): Promise<OrderWarningKind[]> {
  if (options.toOurWarehouse) return []
  const orderIds = await ordersOfShipment(db, shipment)
  const openBeforeShipping = await db.salesOrderMilestone.count({ where: { orderId: { in: orderIds }, kind: 'BEFORE_SHIPPING', status: 'OPEN' } })
  return leavingWarnings({ openBeforeShipping, toOurWarehouse: false })
}
