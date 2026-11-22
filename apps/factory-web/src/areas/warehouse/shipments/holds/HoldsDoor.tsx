'use client'

import { useEffect, useMemo, useRef } from 'react'
import type { DepthAbilities } from '../queue/shared/depth'
import { useShipmentHolds } from './use-holds'
import type { HoldsDialog, HoldsPanelActions } from './model'
import { HoldsDialogsView } from './view/HoldsPanelView'

/**
 * F-OS-201 (order SHIPMENTS tab; 13-backend §7) — Place a hold… / Release the hold… of ONE shipment opened from another page (the
 * order's Shipments row ⋯): Warehouse's OWN hook (useShipmentHolds) and dialogs (HoldsDialogsView), mounted only while open. It opens
 * on the kind asked once the holds are read; a write closes it (the hook closes its dialog) and the page reads itself again; Cancel
 * closes it. Warehouse's record keeps its holds panel as it is.
 */
export type HoldsDoorKind = { readonly kind: 'place' } | { readonly kind: 'release'; readonly holdId: string }

export function HoldsDoor({ shipmentId, version, can, open, onChanged, onClose }: { shipmentId: string; version: number; can: DepthAbilities; open: HoldsDoorKind; onChanged: () => void; onClose: () => void }) {
  const { model, actions, holds } = useShipmentHolds(shipmentId, version, can, onChanged)
  const opened = useRef(false)
  useEffect(() => {
    if (!holds) return
    if (!opened.current) {
      opened.current = true
      const dialog: HoldsDialog = open.kind === 'place' ? { kind: 'place', reason: null, text: '' } : { kind: 'release', holdId: open.holdId, text: '' }
      actions.onDialog?.(dialog)
      return
    }
    // Written (the hook closes its dialog once the write is through): this door closes too.
    if (model.dialog === null) onClose()
  }, [holds, model.dialog, actions, open, onClose])
  const door = useMemo<HoldsPanelActions>(() => ({ ...actions, onDialog: (dialog) => (dialog === null ? onClose() : actions.onDialog?.(dialog)) }), [actions, onClose])
  return <HoldsDialogsView model={model} actions={door} />
}
