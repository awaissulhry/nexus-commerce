'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useOwnTransport } from '../../../../warehouse/shipments/booking/CarrierDepth'
import { arrangeDialogOf, etaDialogOf, type TransportActions, type TransportDialog } from '../../../../warehouse/shipments/booking/model'
import type { Transport } from '../../../../warehouse/shipments/booking/api'
import { TransportDoorDialog } from '../../../../warehouse/shipments/booking/view/TransportView'
import type { DepthAbilities } from '../../../../warehouse/shipments/queue/shared/depth'

/**
 * F-OP-119 → F-OS-201 (order SHIPMENTS tab; 13-backend §7; 18-lead-settles L1, L7) — one of Warehouse's How it travels windows for ONE
 * shipment, opened from the order's Shipments tab: Tracking number… · Mark delivered… / Mark returned… (the status dialog: a reason
 * over a carrier's labels) · Change how it travels… (the booking's arrange dialog, L7) · Set expected arrival…. The Warehouse's own
 * hook (useOwnTransport: GET …/own-transport, then its one write at the shipment's version) and its own dialogs, mounted only while
 * open (use-shipments-acts). It opens on the window asked once the arrangement is read; a save closes it and the order reads itself
 * again (`onChanged`); Cancel closes it.
 */
export type TransportDoorOpen = 'tracking' | 'delivered' | 'returned' | 'arrange' | 'eta'

/** The dialog a door opens on, from what the shipment has now. */
export function transportDialogOf(open: TransportDoorOpen, transport: Transport): TransportDialog {
  switch (open) {
    case 'tracking':
      return { kind: 'tracking', text: transport.shipment.manualTrackingNumber ?? '', link: transport.shipment.manualTrackingUrl ?? '' /* F-OP-135 */ }
    case 'delivered':
    case 'returned':
      return { kind: 'status', status: open === 'delivered' ? 'DELIVERED' : 'RETURNED', occurredAt: null, description: '', location: '', reason: '' }
    case 'arrange':
      return arrangeDialogOf(transport)
    case 'eta':
      return etaDialogOf(transport)
  }
}

export function ShipmentTransportDoor({ shipmentId, version, can, open, onChanged, onClose }: { shipmentId: string; version: number; can: DepthAbilities; open: TransportDoorOpen; onChanged: () => void; onClose: () => void }) {
  const { model, actions } = useOwnTransport(shipmentId, version, can, onChanged)
  const opened = useRef(false)
  const ready = model.transport.state === 'ready' ? model.transport.value : null
  useEffect(() => {
    if (!ready) return
    if (!opened.current) {
      opened.current = true
      actions.onDialog?.(transportDialogOf(open, ready))
      return
    }
    // Saved (the hook closes its dialog once the write is through): this door closes too.
    if (model.dialog === null) onClose()
  }, [ready, model.dialog, actions, open, onClose])
  const door = useMemo<TransportActions>(() => ({ ...actions, onDialog: (dialog) => (dialog === null ? onClose() : actions.onDialog?.(dialog)) }), [actions, onClose])
  return <TransportDoorDialog model={model} actions={door} onClose={onClose} />
}
