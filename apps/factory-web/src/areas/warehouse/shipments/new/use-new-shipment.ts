'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { addLines, createShipment, getShipment, readyToShip, type Shipment, type TransportBy } from '../api'
import type { NewShipmentModel } from '../list/list-model'
import { newShipmentLines, ordersOfNew, readProblem, togetherRows, writeProblem } from '../model'

/**
 * F-OP-121 (order page plan N6): New shipment as ONE hook — the Warehouse list (choose among every order with released garments)
 * and the order page's Create shipment… in place (this order, and beside it the SAME customer's other open orders from the walled
 * ship-together read, B-OP-070: each held with its reason — another delivery address, another site, several orders held off until
 * the switch B-OP-047; never another customer's order, not even held). Step 2: how many of each colour and size, grouped by order,
 * each capped at what that cell can still ship. Create makes a DRAFT with the next SHIPMENT number; the caller says what follows
 * (the Warehouse opens it, the order page reads the order again and says where to pack it).
 */

export interface NewShipmentDefaults {
  readonly transportBy: TransportBy
  readonly carrierCode: string
  readonly serviceCode: string
}

export interface NewShipmentActions {
  onNewClose: () => void
  onNewOrder: (salesOrderId: string) => void
  /** Ship together: add (or take off) another order of the customer — only one its verdict allows. */
  onNewOther: (salesOrderId: string, on: boolean) => void
  onNewStep: (step: 1 | 2) => void
  onNewQuantity: (cellId: string, quantity: number) => void
  onNewAll: () => void
  onNewDelivery: (next: { transportBy?: TransportBy; carrierCode?: string; serviceCode?: string }) => void
  onNewCreate: () => void
}

const CLOSED: NewShipmentModel = { step: 1, orders: null, problem: null, salesOrderId: null, quantities: {}, transportBy: 'CARRIER', carrierCode: '', serviceCode: '', busy: false, refused: null }

/** What the write made: a new DRAFT, or this order's garments added to a DRAFT already there (F-OP-122). */
export type NewShipmentDone = { readonly kind: 'created' | 'joined'; readonly garments: number }

export function useNewShipment(input: { readonly api: ApiClient; readonly defaults: () => NewShipmentDefaults; readonly onCreated: (shipment: Shipment, done: NewShipmentDone) => void; readonly onClosed?: () => void }) {
  const { api, defaults, onCreated, onClosed } = input
  const [model, setModel] = useState<NewShipmentModel | null>(null)
  const key = useRef<string | null>(null)

  /**
   * Opens New shipment: `salesOrderId` chosen (or null: pick one); `together` (the order page): that order fixed, and the same
   * customer's other open orders with released garments beside it, each with its verdict.
   */
  const open = useCallback(
    (salesOrderId: string | null, options: { readonly together?: boolean } = {}) => {
      key.current = newIdempotencyKey()
      const given = defaults()
      const together = !!options.together && !!salesOrderId
      setModel({ ...CLOSED, salesOrderId, step: 1, transportBy: given.transportBy, carrierCode: given.carrierCode, serviceCode: given.serviceCode, together, others: [] })
      readyToShip(api, together ? { salesOrderId, together: true } : {})
        .then((orders) => {
          setModel((current) => {
            if (!current) return current
            const chosen = salesOrderId && orders.some((order) => order.salesOrderId === salesOrderId) ? salesOrderId : orders.length === 1 && !together ? orders[0]!.salesOrderId : current.salesOrderId
            return { ...current, orders, salesOrderId: chosen ?? null, step: chosen && salesOrderId && !together ? 2 : 1 }
          })
        })
        .catch((error: unknown) => setModel((current) => (current ? { ...current, problem: readProblem(error) } : current)))
    },
    [api, defaults],
  )

  /**
   * F-OP-122: "Add this order's garments…" onto a DRAFT of the same customer (the joinable read said it may join): the same step 2,
   * this order's cells only, sent through the shipment's lines route at the version read just before (the API keeps the last word:
   * DRAFT only, and several orders in one shipment refused in words until the switch).
   */
  const openJoin = useCallback(
    (salesOrderId: string, shipment: { readonly id: string; readonly number: string }) => {
      key.current = newIdempotencyKey()
      setModel({ ...CLOSED, salesOrderId, step: 2, join: { shipmentId: shipment.id, number: shipment.number } })
      readyToShip(api, { salesOrderId })
        .then((orders) => setModel((current) => (current ? { ...current, orders: orders.filter((order) => order.salesOrderId === salesOrderId) } : current)))
        .catch((error: unknown) => setModel((current) => (current ? { ...current, problem: readProblem(error) } : current)))
    },
    [api],
  )

  const close = useCallback(() => {
    setModel(null)
    onClosed?.()
  }, [onClosed])

  const submit = useCallback(async () => {
    if (!model || !model.salesOrderId || model.busy) return
    const orders = ordersOfNew(model)
    const lines = newShipmentLines(
      orders.flatMap((order) => order.cells),
      model.quantities,
    )
    if (lines.length === 0) return
    setModel({ ...model, busy: true, refused: null })
    const others = model.others ?? []
    const garments = lines.reduce((sum, line) => sum + line.quantity, 0)
    try {
      // F-OP-122: onto the DRAFT already there, at the version it has now.
      if (model.join) {
        const current = await getShipment(api, model.join.shipmentId)
        const joined = await addLines(api, model.join.shipmentId, current.version, lines)
        setModel(null)
        onCreated(joined, { kind: 'joined', garments })
        return
      }
      const shipment = await createShipment(
        api,
        {
          salesOrderId: model.salesOrderId,
          // Ship together: every order of the new shipment, the first = salesOrderId (refused with MULTI_ORDER_OFF's words until the switch).
          ...(others.length > 0 ? { salesOrderIds: [model.salesOrderId, ...others] } : {}),
          transportBy: model.transportBy,
          // Blank: the site's default carrier and service (the API fills them); none at all without a carrier.
          ...(model.transportBy === 'CARRIER'
            ? { ...(model.carrierCode.trim() ? { carrierCode: model.carrierCode.trim() } : {}), ...(model.serviceCode.trim() ? { serviceCode: model.serviceCode.trim() } : {}) }
            : { carrierCode: null, serviceCode: null }),
          lines,
        },
        key.current ?? newIdempotencyKey(),
      )
      setModel(null)
      onCreated(shipment, { kind: 'created', garments })
    } catch (error) {
      const problem = writeProblem(error)
      setModel((current) => (current ? { ...current, busy: false, refused: { words: { key: problem.key }, detail: problem.detail ?? null } } : current))
    }
  }, [api, model, onCreated])

  const actions: NewShipmentActions = useMemo(
    () => ({
      onNewClose: close,
      onNewOrder: (salesOrderId) => setModel((current) => (current && !current.together ? { ...current, salesOrderId, quantities: {}, refused: null } : current)),
      onNewOther: (salesOrderId, on) =>
        setModel((current) => {
          if (!current) return current
          const row = togetherRows(current).find((entry) => entry.order.salesOrderId === salesOrderId)
          if (on && (!row || row.held)) return current
          const others = (current.others ?? []).filter((id) => id !== salesOrderId)
          const dropped = on ? [] : (current.orders ?? []).find((order) => order.salesOrderId === salesOrderId)?.cells.map((cell) => cell.workOrderSizeId) ?? []
          const quantities = Object.fromEntries(Object.entries(current.quantities).filter(([cellId]) => !dropped.includes(cellId)))
          return { ...current, others: on ? [...others, salesOrderId] : others, quantities, refused: null }
        }),
      onNewStep: (step) => setModel((current) => (current ? { ...current, step, refused: null } : current)),
      onNewQuantity: (cellId, quantity) => setModel((current) => (current ? { ...current, quantities: { ...current.quantities, [cellId]: quantity } } : current)),
      onNewAll: () =>
        setModel((current) => {
          if (!current) return current
          const cells = ordersOfNew(current).flatMap((order) => order.cells)
          return cells.length > 0 ? { ...current, quantities: Object.fromEntries(cells.map((cell) => [cell.workOrderSizeId, cell.shippable])) } : current
        }),
      onNewDelivery: (next) => setModel((current) => (current ? { ...current, ...next } : current)),
      onNewCreate: () => void submit(),
    }),
    [close, submit],
  )

  return { model, actions, open, openJoin }
}
