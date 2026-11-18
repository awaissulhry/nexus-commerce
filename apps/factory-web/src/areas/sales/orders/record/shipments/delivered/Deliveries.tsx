'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useOfficeApi } from '../../../../../../lib/session/context'
import { storeUrl } from '../../../../../../record-panels/store'
import { useLiveBus } from '../../../../../../shell/live/use-live'
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame' // B-SA-0xxb: the thread's ONE viewer
import { podDownload, readDeliveries } from './api'
import { initialDeliveries, type DeliveriesActions, type DeliveriesModel } from './model'
import { proofFileOf } from './model' // B-SA-0xxb
import { DeliveriesView } from './view/DeliveriesView'

/** The live events after which the card reads again (a shipment of this order arrived, its proof came, the order moved). */
const LIVE = new Set(['shipment.status_changed', 'shipment.pod_recorded', 'shipment.tracking_problem_raised', 'shipment.tracking_problem_resolved', 'sales_order.status_changed'])

/**
 * The order's "Delivered (from carrier)" card (B-W2b-398; LOG-065, LOG-067): reads the deliveries
 * (`GET /sales/orders/:id/deliveries`), again on a live change of a shipment or of the order and on reconnect; Download opens
 * the proof's image (a presigned address of 60 seconds) in a new tab.
 */
export function Deliveries({ orderId, prefix }: { orderId: string; prefix: string }) {
  const api = useOfficeApi()
  const frame = useRecordFrame() // B-SA-0xxb
  const [model, setModel] = useState<DeliveriesModel>(() => initialDeliveries(prefix))

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setModel((state) => ({ ...state, state: state.read ? state.state : 'loading' }))
      try {
        const read = await readDeliveries(api, orderId)
        setModel((state) => ({ ...state, state: 'ready', read }))
      } catch {
        setModel((state) => (quiet && state.read ? state : { ...state, state: 'error' }))
      }
    },
    [api, orderId],
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const sync = () => setModel((state) => ({ ...state, offline: !navigator.onLine }))
    sync()
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  useLiveBus({
    onChange: (change) => {
      if (!LIVE.has(change.type)) return
      if (change.type === 'sales_order.status_changed' && change.fields.orderId !== orderId) return
      void load(true)
    },
    onReconnect: () => void load(true),
  })

  const openFiles = frame?.openFiles
  const read = model.read
  const actions = useMemo<DeliveriesActions>(
    () => ({
      // ---- B-SA-0xxb / F-SA-266b: the proof in the thread's ONE viewer (its own file; the viewer asks its address by its id).
      ...(openFiles
        ? {
            onView: (shipmentId: string) => {
              const file = read?.shipments.find((row) => row.id === shipmentId)
              const proof = file ? proofFileOf(file) : null
              if (proof) openFiles({ files: [proof], fileId: proof.id, returnTo: document.activeElement as HTMLElement | null })
            },
          }
        : {}),
      // ---- end B-SA-0xxb
      onRetry: () => void load(),
      onDismiss: () => setModel((state) => ({ ...state, problem: null })),
      onDownload: (shipmentId) => {
        // The tab opens at the click (a browser opens no window after an await), then goes to the address.
        const tab = window.open('', '_blank')
        if (tab) tab.opener = null
        setModel((state) => ({ ...state, downloading: shipmentId, problem: null }))
        podDownload(api, shipmentId)
          .then((url) => {
            if (tab) tab.location.href = storeUrl(url)
            else window.location.assign(storeUrl(url))
            setModel((state) => ({ ...state, downloading: null }))
          })
          .catch(() => {
            tab?.close()
            setModel((state) => ({ ...state, downloading: null, problem: 'dv.downloadFailed' }))
          })
      },
    }),
    [api, load, openFiles, read],
  )

  return <DeliveriesView model={model} actions={actions} />
}
