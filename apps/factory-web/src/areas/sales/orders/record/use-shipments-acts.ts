'use client'

import { createElement, useCallback, useMemo, useState, type ReactNode } from 'react'
import type { Order } from '../api'
// B-W2b-398: the Shipments tab's card "Delivered (from carrier)".
import { Deliveries } from './shipments/delivered/Deliveries'
// F-OP-119: the tracking number of one shipment typed in place (the Warehouse's own hook and dialog).
import { depthAbilitiesOf } from '../../../warehouse/shipments/queue/shared/depth'
import { ShipmentTracking } from './shipments/ShipmentTracking'
// F-OP-121 (order page plan N6): Create shipment… in place — the Warehouse's ONE New shipment hook and its dialog.
import type { ApiClient } from '../../../../lib/api/client'
import type { Shipment } from '../../../warehouse/shipments/api'
import { abilitiesOf } from '../../../warehouse/shipments/model'
import { useNewShipment } from '../../../warehouse/shipments/new/use-new-shipment'
import { NewShipmentDialog } from '../../../warehouse/shipments/list/view/NewShipmentDialog'
import type { OrderRecordModel } from './record-model'

/**
 * F-OP-134 (N-5): the Shipments tab's container side — B-W2b-398: the card "Delivered (from carrier)" (its own container: it reads
 * the carrier's deliveries of the order). Mounted by the container (OrderRecord.tsx), which hands it to the view as a plain prop; a
 * view never imports it. The hooks a shipment's acts need (the hand-booked carrier's tracking, a new shipment) are mounted here.
 *
 * F-OP-119 (order page plan N5): "Tracking number…" on a shipment row opens the Warehouse's tracking dialog for that ONE shipment
 * (useOwnTransport mounted lazily, only while it is open: `model.shipmentTracking`); a save reads the order again.
 *
 * F-OP-121 (order page plan N6): "Create shipment…" opens Warehouse's New shipment IN PLACE (useNewShipment, `together`): this
 * order and the same customer's other open orders beside it (each held with its reason; several orders held off until the switch).
 * Create makes a DRAFT; the order is read again and the notice says where to pack it ("Pack and ship it in Warehouse ›").
 */
export function useShipmentsActs(input: {
  readonly order: Order | null
  readonly prefix: string
  /* F-OP-119 */ readonly permissions: readonly string[]
  readonly reload: () => void
  /* F-OP-121 */ readonly api: ApiClient
  /* F-OP-121 */ readonly setNotice: (notice: OrderRecordModel['notice']) => void
}): {
  delivered: ReactNode
  model: { shipmentTracking: ReactNode | null; /* F-OP-121 */ newShipment: ReactNode | null }
  actions: { onShipmentTracking: (shipmentId: string) => void; /* F-OP-121 */ onCreateShipment: () => void }
} {
  const { order, prefix, permissions, reload, api, setNotice } = input
  // ---- F-OP-119 ----
  const [open, setOpen] = useState<string | null>(null)
  // The shipment's own rights as Warehouse reads them (no label check from here: `pack` off).
  const can = useMemo(() => ({ ...depthAbilitiesOf(permissions), pack: false }), [permissions])
  const close = useCallback(() => setOpen(null), [])
  const row = open && order ? (order.chain.shipments.find((entry) => entry.id === open) ?? null) : null
  const shipmentTracking = row ? createElement(ShipmentTracking, { key: row.id, shipmentId: row.id, version: row.version ?? 1, can, onChanged: reload, onClose: close }) : null
  const onShipmentTracking = useCallback((shipmentId: string) => setOpen(shipmentId), [])
  // ---- end F-OP-119

  // ---- F-OP-121: Create shipment… in place ----
  const shipping = useMemo(() => abilitiesOf(permissions), [permissions])
  const created = useCallback(
    (shipment: Shipment) => {
      reload()
      setNotice({ tone: 'success', words: { key: 'ship.created', params: { number: shipment.number } }, door: { href: `${prefix}/warehouse/shipments/${shipment.id}`, words: { key: 'ship.createdDoor' } } })
    },
    [prefix, reload, setNotice],
  )
  // The site's default carrier and service come from the API (blank here); who carries it: a carrier.
  const defaults = useCallback(() => ({ transportBy: 'CARRIER' as const, carrierCode: '', serviceCode: '' }), [])
  const create = useNewShipment({ api, defaults, onCreated: created })
  const onCreateShipment = useCallback(() => {
    if (order) create.open(order.id, { together: true })
  }, [create, order])
  const newShipment = create.model ? createElement(NewShipmentDialog, { model: create.model, can: shipping, actions: create.actions }) : null
  // ---- end F-OP-121
  return { delivered: order ? createElement(Deliveries, { orderId: order.id, prefix }) : null, model: { shipmentTracking, newShipment }, actions: { onShipmentTracking, onCreateShipment } }
}
