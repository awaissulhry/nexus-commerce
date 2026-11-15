'use client'

import { useCallback, useEffect, useState } from 'react'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLive } from '../hooks'
import { failed, LOADING, ready, touchesShipment, type Read } from '../queue/shared/depth'
import { readCartons, type Bench } from './api'
import { stepOf, type CartonsContext } from './model'
import { CartonsView } from './view/CartonsView'

/**
 * The shipment's cartons on Lines & cartons (SCR-594): reads `GET …/cartons` (shipping.view), again when the record's
 * version moves (a W1 write), on a carton packed at the station (shipping.carton_packed), a packing change of this
 * shipment and on reconnect. Add carton, Weigh and measure, Remove and the packing list are the record's own (W1) dialogs.
 */
export function CartonsCard({
  shipmentId,
  version,
  context,
  onAdd,
  onWeigh,
  onRemove,
  onPackingList,
}: {
  shipmentId: string
  version: number
  context: CartonsContext
  onAdd: () => void
  onWeigh: (cartonId: string) => void
  onRemove: (cartonId: string) => void
  onPackingList: () => void
}) {
  const api = useOfficeApi()
  const [bench, setBench] = useState<Read<Bench>>(LOADING)
  const [openId, setOpenId] = useState<string | null>(null)

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setBench(LOADING)
      try {
        setBench(ready(await readCartons(api, shipmentId)))
      } catch (error) {
        setBench((state) => (quiet && state.state === 'ready' ? state : failed(error)))
      }
    },
    [api, shipmentId],
  )

  useEffect(() => {
    void load(true)
  }, [load, version])

  useLive(
    (change) => {
      if ((change.type === 'shipping.carton_packed' || change.type === 'shipment.packing_changed' || change.type === 'shipment.split') && touchesShipment(change, shipmentId)) void load(true)
    },
    () => void load(true),
  )

  return (
    <CartonsView
      model={{ bench, context, openId }}
      actions={{
        onRetry: () => void load(),
        onOpen: setOpenId,
        onStep: (step) => {
          if (bench.state !== 'ready') return
          const next = stepOf(bench.value, openId, step)
          if (next) setOpenId(next)
        },
        onAdd,
        onWeigh,
        onRemove,
        onPackingList,
      }}
    />
  )
}
