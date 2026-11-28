'use client'

import type { ReactElement } from 'react'
import { LegActWindow } from './legs/LegActWindow'

/**
 * SLOT — owner: S3 (owb-ss3); filled by ss3 step 3.2 (the warehouse leg: ARRIVED = It arrived at the warehouse · SEND_ON = Send on to the customer).
 * Placed by the base (owb-b5 w5.5) with its FINAL export name and props, so the owner edits only this file. Where: the band opens it at
 * our warehouse (S2 of5 mounts it; S2 ask 23:35); not mounted by the base. Office only: the customer never reaches it.
 *
 * owb-ss3 (design plan § 7; settles L2, L5; server Shape owb-ss1): the order's legs are read (`GET /shipping/warehouse-legs`), the
 * shipments that fit the act are offered (one: it opens on it; several: the person picks), and the act is done ONE time — the same
 * window the order's Shipments tab, the Warehouse shipment record and Our warehouses open (`legs/LegActWindow`). The page that mounts
 * it reads itself again on the shipment's events (the leg's events: shipment.arrived_at_warehouse, shipment.forwarded).
 */
export interface WarehouseLegWindowProps {
  readonly open: boolean
  readonly onClose: () => void
  /** The company the page works in (the session's). */
  readonly companyId: string
  /** The order (SalesOrder id). */
  readonly orderId: string
  /** Which act the window does: the order arrived at our warehouse, or it is sent on to the customer. */
  readonly act: 'ARRIVED' | 'SEND_ON'
}

export function WarehouseLegWindow({ open, onClose, orderId, act }: WarehouseLegWindowProps): ReactElement | null {
  if (!open) return null
  return <LegActWindow open={open} onClose={onClose} act={act} salesOrderId={orderId} />
}
