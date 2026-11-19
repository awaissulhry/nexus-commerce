'use client'

import { createElement, useCallback, useMemo, useState, type ReactNode } from 'react'
import type { Order } from '../api'
// B-W2b-398: the Shipments tab's card "Delivered (from carrier)".
import { Deliveries } from './shipments/delivered/Deliveries'
// F-OP-119: the tracking number of one shipment typed in place (the Warehouse's own hook and dialog).
import { depthAbilitiesOf } from '../../../warehouse/shipments/queue/shared/depth'
import { ShipmentTracking } from './shipments/ShipmentTracking'
// F-OP-123 (order page N5): "Record a shipment made elsewhere…" (its container, mounted only while open; its door held with words).
import { RecordElsewhere } from './shipments/elsewhere/RecordElsewhere'
import { elsewhereDoor } from './shipments/elsewhere/model'
import type { Phrase } from '../model'

/**
 * F-OP-134 (N-5): the Shipments tab's container side — B-W2b-398: the card "Delivered (from carrier)" (its own container: it reads
 * the carrier's deliveries of the order). Mounted by the container (OrderRecord.tsx), which hands it to the view as a plain prop; a
 * view never imports it. The hooks a shipment's acts need (the hand-booked carrier's tracking, a new shipment) are mounted here.
 *
 * F-OP-119 (order page plan N5): "Tracking number…" on a shipment row opens the Warehouse's tracking dialog for that ONE shipment
 * (useOwnTransport mounted lazily, only while it is open: `model.shipmentTracking`); a save reads the order again.
 */
export function useShipmentsActs(input: { readonly order: Order | null; readonly prefix: string; /* F-OP-119 */ readonly permissions: readonly string[]; readonly reload: () => void }): {
  delivered: ReactNode
  model: { shipmentTracking: ReactNode | null; /* F-OP-123 */ elsewhere: { readonly held: Phrase | null; readonly dialog: ReactNode | null } | null }
  actions: { onShipmentTracking: (shipmentId: string) => void; /* F-OP-123 */ onRecordElsewhere: () => void }
} {
  const { order, prefix, permissions, reload } = input
  // ---- F-OP-119 ----
  const [open, setOpen] = useState<string | null>(null)
  // The shipment's own rights as Warehouse reads them (no label check from here: `pack` off).
  const can = useMemo(() => ({ ...depthAbilitiesOf(permissions), pack: false }), [permissions])
  const close = useCallback(() => setOpen(null), [])
  const row = open && order ? (order.chain.shipments.find((entry) => entry.id === open) ?? null) : null
  const shipmentTracking = row ? createElement(ShipmentTracking, { key: row.id, shipmentId: row.id, version: row.version ?? 1, can, onChanged: reload, onClose: close }) : null
  const onShipmentTracking = useCallback((shipmentId: string) => setOpen(shipmentId), [])
  // ---- end F-OP-119
  // ---- F-OP-123 (order page N5): Record a shipment made elsewhere… — held with words (the order's state, the rights: D4), else
  // the dialog's container while open; recorded, the order reads itself again.
  const [elsewhereOpen, setElsewhereOpen] = useState(false)
  const closeElsewhere = useCallback(() => setElsewhereOpen(false), [])
  const elsewhereHeld = order ? elsewhereDoor(order, permissions) : null
  const elsewhere = order
    ? { held: elsewhereHeld, dialog: elsewhereOpen && !elsewhereHeld ? createElement(RecordElsewhere, { key: order.id, order, prefix, onDone: () => { setElsewhereOpen(false); reload() }, onClose: closeElsewhere }) : null }
    : null
  const onRecordElsewhere = useCallback(() => setElsewhereOpen(true), [])
  // ---- end F-OP-123
  return { delivered: order ? createElement(Deliveries, { orderId: order.id, prefix }) : null, model: { shipmentTracking, elsewhere /* F-OP-123 */ }, actions: { onShipmentTracking, onRecordElsewhere /* F-OP-123 */ } }
}
