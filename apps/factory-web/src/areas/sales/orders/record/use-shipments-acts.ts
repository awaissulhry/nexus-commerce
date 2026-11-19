'use client'

import { createElement, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
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
// F-OP-122: the customer's DRAFT shipments this order may join (the walled joinable read), each held with why.
import { joinableShipments } from '../../../warehouse/shipments/api'
import type { NewShipmentDone } from '../../../warehouse/shipments/new/use-new-shipment'
import { mayCreateShipment } from '../model'
import { joinableRows, type JoinableRow } from './shipments/model'

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
 *
 * F-OP-122 (order page plan N6): the customer's DRAFT shipments of the same site and delivery address (the joinable read: those
 * whose only reason is the hold of several orders, or none) each offer "Add this order's garments…" — the same step 2 — held with
 * MULTI_ORDER_OFF's words until the switch B-OP-047; a DRAFT only (the API keeps the last word).
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
  model: { shipmentTracking: ReactNode | null; /* F-OP-121 */ newShipment: ReactNode | null; /* F-OP-122 */ joinable: JoinableRow[] | null }
  actions: { onShipmentTracking: (shipmentId: string) => void; /* F-OP-121 */ onCreateShipment: () => void; /* F-OP-122 */ onJoinShipment: (shipmentId: string) => void }
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
    (shipment: Shipment, done: NewShipmentDone) => {
      reload()
      // F-OP-122: garments added to a DRAFT already there say so (how many, onto which shipment).
      const words = done.kind === 'joined' ? { key: 'ship.joined', params: { count: done.garments, number: shipment.number } } : { key: 'ship.created', params: { number: shipment.number } }
      setNotice({ tone: 'success', words, door: { href: `${prefix}/warehouse/shipments/${shipment.id}`, words: { key: 'ship.createdDoor' } } })
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

  // ---- F-OP-122: the DRAFT shipments this order may join ----
  const [joinable, setJoinable] = useState<{ orderId: string; rows: JoinableRow[] } | null>(null)
  const mayJoin = !!order && shipping.view && mayCreateShipment(order, { createShipment: shipping.manage })
  // Read again whenever the order's shipments change (made, joined, left, cancelled).
  const shipmentsKey = order ? order.chain.shipments.map((row) => `${row.id}:${row.status}`).join(',') : ''
  const orderId = order?.id ?? null
  useEffect(() => {
    if (!orderId || !mayJoin) return
    let live = true
    joinableShipments(api, orderId)
      .then((answer) => {
        // The same customer, site and delivery address: allowed, or held only while several orders in one shipment are held off.
        if (live) setJoinable({ orderId, rows: joinableRows(answer.shipments) })
      })
      .catch(() => live && setJoinable({ orderId, rows: [] }))
    return () => {
      live = false
    }
  }, [api, orderId, mayJoin, shipmentsKey])
  const onJoinShipment = useCallback(
    (shipmentId: string) => {
      const row = joinable?.rows.find((entry) => entry.shipmentId === shipmentId)
      if (order && row && !row.held) create.openJoin(order.id, { id: row.shipmentId, number: row.number })
    },
    [create, joinable, order],
  )
  const joinableRows = mayJoin && joinable?.orderId === orderId ? joinable.rows : null
  // ---- end F-OP-122
  return {
    delivered: order ? createElement(Deliveries, { orderId: order.id, prefix }) : null,
    model: { shipmentTracking, newShipment, joinable: joinableRows },
    actions: { onShipmentTracking, onCreateShipment, onJoinShipment },
  }
}
