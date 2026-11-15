'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLive } from '../hooks'
import { failed, LOADING, ready, touchesShipment, writeWords } from '../queue/shared/depth'
import { readNotice, sendNotice } from './api'
import { NOTICE_HELD, type NoticeActions, type NoticeModel } from './model'
import { NoticeView } from './view/NoticeView'

/**
 * Tracking & delivery › Customer notice (SCR-598): reads `GET …/notice` (shipping.view), again when the record's version
 * moves, on shipment.customer_notice_sent of this shipment and on reconnect; Send again = ONE `POST …/notice` with the
 * contacts ticked and its own Idempotency-Key (FAKE e-mail locally).
 */
export function CustomerNotice({ shipmentId, version }: { shipmentId: string; version: number }) {
  const api = useOfficeApi()
  const [model, setModel] = useState<NoticeModel>({ notice: LOADING, dialog: null, busy: false, problem: null, sent: null })
  const latest = useRef(model)
  latest.current = model
  const key = useRef<string | null>(null)

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setModel((state) => ({ ...state, notice: LOADING }))
      try {
        const notice = await readNotice(api, shipmentId)
        setModel((state) => ({ ...state, notice: ready(notice) }))
      } catch (error) {
        setModel((state) => (quiet && state.notice.state === 'ready' ? state : { ...state, notice: failed(error) }))
      }
    },
    [api, shipmentId],
  )

  useEffect(() => {
    void load(true)
  }, [load, version])

  useLive(
    (change) => {
      if (change.type === 'shipment.customer_notice_sent' && touchesShipment(change, shipmentId)) void load(true)
    },
    () => void load(true),
  )

  const actions = useMemo<NoticeActions>(
    () => ({
      onRetry: () => void load(),
      onDialog: (dialog) => {
        if (dialog && !latest.current.dialog) key.current = newIdempotencyKey()
        setModel((state) => ({ ...state, dialog, problem: null, sent: dialog ? null : state.sent }))
      },
      onSend: () => {
        const state = latest.current
        if (!state.dialog || state.busy || state.dialog.contactIds.length === 0) return
        const contactIds = [...state.dialog.contactIds]
        setModel((current) => ({ ...current, busy: true, problem: null }))
        sendNotice(api, shipmentId, contactIds, key.current ?? newIdempotencyKey())
          .then((sent) => {
            key.current = null
            setModel((current) => ({ ...current, busy: false, dialog: null, sent, notice: ready(sent.notice) }))
          })
          .catch((error: unknown) => {
            const problem = writeWords(error, 'notice.why', NOTICE_HELD)
            setModel((current) => ({ ...current, busy: false, problem: { key: problem.key, params: problem.params } }))
            if (problem.reload) void load(true)
          })
      },
    }),
    [api, shipmentId, load],
  )

  return <NoticeView model={model} actions={actions} />
}
