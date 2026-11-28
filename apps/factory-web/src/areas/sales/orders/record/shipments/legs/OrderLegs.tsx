'use client'

import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import type { AtWarehouse } from '../where'
import type { Leg } from './api'
import { LegActWindow } from './LegActWindow'
import { atWarehouseIds, legByShipment, shipRightsOf, type LegAct, type ShipRights } from './model'
import { useOfficeApiIfAny, useOfficeSessionIfAny, useOrderLegs } from './use-legs'

/** What the order's Shipments tab draws of the legs: each shipment's leg, the "At our warehouse" part, the reader's two rights. */
export interface OrderLegsModel {
  readonly legs: ReadonlyMap<string, Leg>
  /** The shipments at our warehouse now; null while not read (the bar then draws as before). */
  readonly atWarehouse: AtWarehouse | null
  readonly rights: ShipRights
  /** Opens the leg's window on a shipment ("It arrived at the warehouse" · "Send on to the customer"). */
  readonly onAct: (shipmentId: string, act: LegAct) => void
}

const NO_RIGHTS: ShipRights = Object.freeze({ plan: false, send: false })

/**
 * owb-ss3 step 3.2 — the order Shipments tab's leg container (the tab's layout is a view: it fetches nothing, so it hands its sections
 * to this part): reads the order's legs (`GET /shipping/warehouse-legs?salesOrderId=`, again when the order's shipments change and
 * after an act), the reader's two rights (plan · pack and send), and mounts the leg's window while one is open. Drawn without the
 * office session (the design index, the render tests): nothing is read and the sections draw as before.
 */
export function OrderLegs({ orderId, stamp, children }: { orderId: string; stamp: string; children: (model: OrderLegsModel) => ReactNode }): ReactElement {
  const session = useOfficeSessionIfAny()
  const api = useOfficeApiIfAny(session)
  const permissions = session?.permissions ?? null
  const rights = useMemo(() => (permissions ? shipRightsOf(permissions) : NO_RIGHTS), [permissions])
  const read = useOrderLegs(api, orderId, stamp)
  const [open, setOpen] = useState<{ readonly shipmentId: string; readonly act: LegAct } | null>(null)
  const model: OrderLegsModel = {
    legs: legByShipment(read.legs),
    atWarehouse: read.legs ? atWarehouseIds(read.legs) : null,
    rights,
    onAct: (shipmentId, act) => setOpen({ shipmentId, act }),
  }
  return (
    <>
      {children(model)}
      {open && session ? <LegActWindow open act={open.act} salesOrderId={orderId} shipmentId={open.shipmentId} onClose={() => setOpen(null)} onDone={read.reload} /> : null}
    </>
  )
}
