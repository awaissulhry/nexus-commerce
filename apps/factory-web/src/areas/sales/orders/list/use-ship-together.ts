'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { joinableShipments, type Shipment } from '../../../warehouse/shipments/api'
import { abilitiesOf, shipmentOrders } from '../../../warehouse/shipments/model'
import { useNewShipment, type NewShipmentActions } from '../../../warehouse/shipments/new/use-new-shipment'
import { getOrder, type OrderRow } from '../api'
import { shipFirstOf, type ShipNotice, type ShipRow, type ShipTogetherModel } from './sheet/ship'

/**
 * F-CW-301 (customer Work tab plan §4; 10-design §6 W1; 13-backend §8) — "Ship N together…" and a row's "Create shipment…" on the ONE
 * Orders sheet: the THIRD mount of Warehouse's own New shipment window (the hook `useNewShipment`, its dialog — never a copy; the
 * other two mounts, Warehouse › Shipments and the order page, are untouched). The hook opens with the ticked orders (`asked`): it
 * picks the first ticked order with garments ready and pre-ticks the others whose verdict allows. This container adds what only
 * the sheet knows: the delivery terms of the orders on the shipment (ship complete: one order read each, five at a time), a DRAFT
 * of the customer that exists already (one read), and — after Create — ONE notice with the door to the draft and its orders.
 * A DRAFT is never shown to the customer: nothing is told.
 */

/** Orders read at once for their delivery terms. */
const READ_AT_ONCE = 5

export interface ShipTogether {
  readonly model: ShipTogetherModel
  /** The window's own actions (Warehouse's). */
  readonly actions: NewShipmentActions
  /** Ship N together…: the ticked rows. */
  readonly open: (rows: readonly ShipRow[]) => void
  /** Create shipment… on one row: this order, and beside it the customer's other open orders (as on the order page). */
  readonly openOne: (row: Pick<OrderRow, 'id'>) => void
  readonly dismiss: () => void
}

export function useShipTogether(api: ApiClient, permissions: readonly string[], onCreated: (orderIds: readonly string[]) => void): ShipTogether {
  const can = useMemo(() => abilitiesOf(permissions), [permissions])
  const [notice, setNotice] = useState<ShipNotice | null>(null)
  const [complete, setComplete] = useState<Readonly<Record<string, boolean>>>({})
  const [draft, setDraft] = useState<ShipTogetherModel['draft']>(null)
  const created = useRef(onCreated)
  created.current = onCreated
  const done = useCallback((shipment: Shipment) => {
    const orders = shipmentOrders(shipment).map((order) => ({ id: order.id, number: order.number }))
    setNotice({ shipmentId: shipment.id, number: shipment.number, orders, customer: shipment.party.legalName })
    created.current(orders.map((order) => order.id))
  }, [])
  // The site's default carrier and service come from the API (blank here); who carries it: a carrier — as on the order page.
  const defaults = useCallback(() => ({ transportBy: 'CARRIER' as const, carrierCode: '', serviceCode: '' }), [])
  const ship = useNewShipment({ api, defaults, onCreated: done })

  const open = useCallback(
    (rows: readonly ShipRow[]) => {
      const first = shipFirstOf(rows)
      if (!first || !can.manage) return
      setNotice(null)
      ship.open(first, { together: true, asked: rows.map((row) => row.id) })
    },
    [can.manage, ship],
  )
  const openOne = useCallback(
    (row: Pick<OrderRow, 'id'>) => {
      if (!can.manage) return
      setNotice(null)
      ship.open(row.id, { together: true })
    },
    [can.manage, ship],
  )

  // The delivery terms of the orders ON the shipment: each read once while the window is open ("wants it all in one delivery").
  const shown = ship.model
  const onIds = shown && shown.orders !== null ? [shown.salesOrderId, ...(shown.others ?? [])].filter((id): id is string => !!id) : []
  const onKey = onIds.join(',')
  const asked = useRef(new Set<string>())
  useEffect(() => {
    if (onKey === '') return
    const queue = onKey.split(',').filter((id) => !asked.current.has(id))
    for (const id of queue) asked.current.add(id)
    let live = true
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const orderId = id
        try {
          const order = await getOrder(api, orderId)
          if (live) setComplete((known) => ({ ...known, [orderId]: order.shipComplete === true }))
        } catch {
          // Not read: this order warns nothing (never a guess).
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(READ_AT_ONCE, queue.length) }, worker))
    return () => {
      live = false
    }
  }, [api, onKey])

  // A DRAFT of the customer that exists already (the first order's joinable read: its customer's DRAFTs it is not on yet).
  const first = shown && shown.orders !== null ? shown.salesOrderId : null
  const reads = can.view
  useEffect(() => {
    setDraft(null)
    if (!first || !reads) return
    let live = true
    joinableShipments(api, first).then(
      (answer) => {
        const row = answer.shipments.find((entry) => entry.status === 'DRAFT')
        if (live && row) setDraft({ shipmentId: row.shipmentId, number: row.number })
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [api, first, reads])

  // A closed window forgets what it read (the next one reads its own orders).
  const closed = shown === null
  useEffect(() => {
    if (!closed) return
    asked.current = new Set()
    setComplete({})
    setDraft(null)
  }, [closed])

  const model: ShipTogetherModel = { can, window: shown, complete, draft, notice }
  return { model, actions: ship.actions, open, openOne, dismiss: useCallback(() => setNotice(null), []) }
}
