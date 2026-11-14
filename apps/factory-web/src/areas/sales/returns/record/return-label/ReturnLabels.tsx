'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { useOfficeApi } from '../../../../../lib/session/context'
import { useLiveBus } from '../../../../../shell/live/use-live'
import { cancelReturnLabel, makeReturnLabel, readReturnLabels } from './api'
import { firstDraft, initialModel, makeBodyOf, outcomeOfError, type ReturnLabelsActions, type ReturnLabelsModel } from './model'
import { ReturnLabelsView } from './view/ReturnLabelsView'

/**
 * The return's labels on the RMA's Shipments tab (B-W2b-398; LOG-112): reads them (`GET /sales/returns/:id/return-labels`),
 * again on a live return_label.changed of this return and on reconnect, and does what the view asks, one write at a time,
 * each with its own Idempotency-Key. A link to pass on is copied to the clipboard at once and shown this once. Offline (the
 * browser says so) every write is held with the reason: the office keeps no queue.
 */
export function ReturnLabels({ returnId, prefix }: { returnId: string; prefix: string }) {
  const api = useOfficeApi()
  const [model, setModel] = useState<ReturnLabelsModel>(() => initialModel(prefix))
  const latest = useRef(model)
  latest.current = model

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setModel((state) => ({ ...state, state: state.read ? state.state : 'loading' }))
      try {
        const read = await readReturnLabels(api, returnId)
        setModel((state) => ({ ...state, state: 'ready', read }))
      } catch {
        setModel((state) => (quiet && state.read ? state : { ...state, state: 'error' }))
      }
    },
    [api, returnId],
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
      if (change.type === 'return_label.changed' && change.fields.returnId === returnId) void load(true)
    },
    onReconnect: () => void load(true),
  })

  const copyText = (text: string) =>
    navigator.clipboard
      ?.writeText(text)
      .then(() => true)
      .catch(() => false) ?? Promise.resolve(false)

  const actions = useMemo<ReturnLabelsActions>(
    () => ({
      onRetry: () => void load(),
      onMake: () => setModel((state) => (state.read ? { ...state, dialog: firstDraft(state.read), outcome: null } : state)),
      onDraft: (draft) => setModel((state) => ({ ...state, dialog: draft })),
      onCloseDialog: () => setModel((state) => ({ ...state, dialog: null, outcome: state.outcome?.kind === 'failed' ? null : state.outcome })),
      onConfirmMake: () => {
        const { read, dialog } = latest.current
        if (!read || !dialog) return
        setModel((state) => ({ ...state, busy: 'make', outcome: null, passOn: null }))
        makeReturnLabel(api, returnId, makeBodyOf(read, dialog), newIdempotencyKey())
          .then(async (made) => {
            const copied = made.url ? await copyText(made.url) : false
            setModel((state) => ({
              ...state,
              busy: null,
              dialog: null,
              read: made.labels,
              passOn: made.url ? { url: made.url, copied } : null,
              outcome: dialog.mode === 'LABEL' ? { kind: 'booked' } : made.url ? null : { kind: 'offered', mailed: made.labels.recipients.length },
            }))
          })
          .catch((error: unknown) => setModel((state) => ({ ...state, busy: null, outcome: outcomeOfError(error) })))
      },
      onCancel: (labelId) => setModel((state) => ({ ...state, cancel: labelId, outcome: labelId ? null : state.outcome })),
      onConfirmCancel: () => {
        const labelId = latest.current.cancel
        if (!labelId) return
        setModel((state) => ({ ...state, busy: `cancel:${labelId}`, outcome: null }))
        cancelReturnLabel(api, returnId, labelId, newIdempotencyKey())
          .then((read) => setModel((state) => ({ ...state, busy: null, cancel: null, read, outcome: { kind: 'cancelled' } })))
          .catch((error: unknown) => setModel((state) => ({ ...state, busy: null, cancel: null, outcome: outcomeOfError(error) })))
      },
      onCopyAgain: () => {
        const passOn = latest.current.passOn
        if (passOn) void copyText(passOn.url).then((copied) => setModel((state) => (state.passOn ? { ...state, passOn: { ...state.passOn, copied } } : state)))
      },
      onDismiss: () => setModel((state) => ({ ...state, outcome: null })),
    }),
    [api, returnId, load],
  )

  return <ReturnLabelsView model={model} actions={actions} />
}
