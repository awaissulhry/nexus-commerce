'use client'

import { useEffect, useMemo, useRef } from 'react'
import type { DepthAbilities } from '../queue/shared/depth'
import { useDelivery } from './Delivery'
import type { DeliveryActions, DeliveryDialog } from './model'
import { DeliveryDialogs } from './view/DeliveryView'

/**
 * F-OS-201 (order SHIPMENTS tab; 13-backend §7) — Record the proof… / Resolve the problem… of ONE shipment opened from another page
 * (the order's Shipments row ⋯): Warehouse's OWN hook (useDelivery) and dialogs (DeliveryDialogs), mounted only while open. It opens
 * on the window asked once the proof and the problems are read (Resolve: the oldest open problem); a write closes it and the page
 * reads itself again (`onChanged`); Cancel closes it. Warehouse's record keeps its Proof of delivery and Tracking problems cards.
 */
export type DeliveryDoorKind = 'pod' | 'resolve'

export function DeliveryDoor({ shipment, version, can, open, onChanged, onClose }: { shipment: { id: string; companyId: string }; version: number; can: DepthAbilities; open: DeliveryDoorKind; onChanged: () => void; onClose: () => void }) {
  const facts = useMemo(() => ({ expectedAt: null, returnedAt: null }), [])
  const { model, actions } = useDelivery(shipment, version, can, facts)
  const opened = useRef(false)
  const ready = model.pod.state === 'ready' && model.problems.state === 'ready' ? model : null
  useEffect(() => {
    if (!ready) return
    if (!opened.current) {
      opened.current = true
      const problem = ready.problems.state === 'ready' ? (ready.problems.value.problems.find((entry) => entry.resolvedAt === null) ?? null) : null
      const dialog: DeliveryDialog = open === 'pod' ? { kind: 'pod', signedBy: '', signedAt: null, file: null } : problem ? { kind: 'resolve', problemId: problem.id, note: '' } : null
      if (!dialog) return onClose()
      actions.onDialog?.(dialog)
      return
    }
    // Written (the hook closes its dialog and says it is done): the page reads itself again, and this door closes.
    if (ready.dialog === null) {
      if (ready.done) onChanged()
      onClose()
    }
  }, [ready, actions, open, onChanged, onClose])
  const door = useMemo<DeliveryActions>(() => ({ ...actions, onDialog: (dialog) => (dialog === null ? onClose() : actions.onDialog?.(dialog)) }), [actions, onClose])
  return <DeliveryDialogs model={model} actions={door} />
}
