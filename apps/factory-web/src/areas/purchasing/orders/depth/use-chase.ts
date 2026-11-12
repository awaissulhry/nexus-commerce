'use client'

import { useCallback, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { readProblem, writeProblem, phrase } from '../../../_shared/buying/model'
import { getChase, sendChase } from './api'
import type { ChaseActions, ChaseModel } from './model'

/**
 * Chase a supplier (design purchasing.orders pop:chase "Chase Conceria Alfa", B-W2b-305's routes): open reads the preview
 * (the lines late or unconfirmed, to whom, the mail in the supplier's language), Send chase mails it on the order's thread
 * (FAKE outside production) with the order's version the preview read and one Idempotency-Key per dialog. The PO list and
 * the PO studio both use it (one dialog: `view/ChaseDialog.tsx`).
 */
export function useChase(input: { api: ApiClient; onSent: (to: string) => void }) {
  const { api, onSent } = input
  const [model, setModel] = useState<ChaseModel | null>(null)
  const key = useRef(newIdempotencyKey())
  const current = useRef<ChaseModel | null>(null)
  current.current = model

  const readPreview = useCallback(
    (orderId: string) => {
      setModel((open) => (open ? { ...open, preview: { status: 'loading' }, problem: null } : open))
      getChase(api, orderId)
        .then((value) => setModel((open) => (open && open.orderId === orderId ? { ...open, preview: { status: 'ready', value } } : open)))
        .catch((error: unknown) => setModel((open) => (open && open.orderId === orderId ? { ...open, preview: { status: 'error', problem: readProblem(error) } } : open)))
    },
    [api],
  )

  const open = useCallback(
    (order: { orderId: string; number: string; supplier: string }) => {
      key.current = newIdempotencyKey()
      setModel({ ...order, preview: { status: 'loading' }, lineIds: null, message: '', busy: false, problem: null, done: null })
      readPreview(order.orderId)
    },
    [readPreview],
  )

  const send = useCallback(async () => {
    const shown = current.current
    if (!shown || shown.busy || shown.done || shown.preview.status !== 'ready') return
    const preview = shown.preview.value
    const every = preview.lines.map((line) => line.lineId)
    const lineIds = shown.lineIds ?? every
    setModel({ ...shown, busy: true, problem: null })
    try {
      const answer = await sendChase(api, shown.orderId, { version: preview.version, ...(lineIds.length === every.length ? {} : { lineIds: [...lineIds] }), ...(shown.message.trim() ? { message: shown.message.trim() } : {}) }, key.current)
      setModel((open) => (open ? { ...open, busy: false, done: { to: answer.to, at: answer.sentAt } } : open))
      onSent(answer.to)
    } catch (error) {
      key.current = newIdempotencyKey()
      setModel((open) => (open ? { ...open, busy: false, problem: writeProblem(error, (_paths, info) => (info.kind === 'conflict' ? phrase('purchasing-orders-depth:chase.refused.changed') : null)) } : open))
      if (isApiError(error) && error.kind === 'conflict') readPreview(shown.orderId)
    }
  }, [api, onSent, readPreview])

  const actions: ChaseActions = {
    onClose: () => setModel(null),
    onLines: (lineIds) => setModel((shown) => (shown ? { ...shown, lineIds } : shown)),
    onMessage: (message) => setModel((shown) => (shown ? { ...shown, message } : shown)),
    onSend: () => void send(),
    onRetry: () => {
      if (current.current) readPreview(current.current.orderId)
    },
  }
  return { model, actions, open }
}
