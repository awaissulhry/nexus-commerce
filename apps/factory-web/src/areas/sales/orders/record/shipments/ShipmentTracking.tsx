'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useOwnTransport } from '../../../../warehouse/shipments/booking/CarrierDepth'
import type { TransportActions } from '../../../../warehouse/shipments/booking/model'
import { TrackingDoorDialog } from '../../../../warehouse/shipments/booking/view/TransportView'
import type { DepthAbilities } from '../../../../warehouse/shipments/queue/shared/depth'

/**
 * F-OP-119 (order page plan N5; 10-order-page §8.2): the tracking number of ONE shipment typed from the order's Shipments tab — the
 * Warehouse's own hook (useOwnTransport: GET …/own-transport, then PUT …/own-transport/tracking at the shipment's version) and its
 * own dialog, mounted only while that shipment's dialog is open (use-shipments-acts). It opens on the number the shipment holds;
 * a save closes it and the order reads itself again (`onChanged`); Cancel closes it.
 */
export function ShipmentTracking({ shipmentId, version, can, onChanged, onClose }: { shipmentId: string; version: number; can: DepthAbilities; onChanged: () => void; onClose: () => void }) {
  const { model, actions } = useOwnTransport(shipmentId, version, can, onChanged)
  const opened = useRef(false)
  const ready = model.transport.state === 'ready' ? model.transport.value : null
  useEffect(() => {
    if (!ready) return
    if (!opened.current) {
      opened.current = true
      actions.onDialog?.({ kind: 'tracking', text: ready.shipment.manualTrackingNumber ?? '', link: ready.shipment.manualTrackingUrl ?? '' /* F-OP-135 */ })
      return
    }
    // Saved (the hook closes its dialog once the write is through): this door closes too.
    if (model.dialog === null) onClose()
  }, [ready, model.dialog, actions, onClose])
  const door = useMemo<TransportActions>(() => ({ ...actions, onDialog: (dialog) => (dialog === null ? onClose() : actions.onDialog?.(dialog)) }), [actions, onClose])
  return <TrackingDoorDialog model={model} actions={door} onClose={onClose} />
}
