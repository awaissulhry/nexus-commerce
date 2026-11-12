'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { isApiError } from '../../../../lib/api/errors'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import type { SubcontractOrder } from '../api'
import { words, type Words } from '../model'
import type { Loaded } from '../record/record-model'
import { bookCost, orderCost, reverseCost, type CostBooked, type OrderCost } from './api'
import { bookBody, bookHeldDraft, costRefusal, readProblem, type CostDialog, type CostModel, type DepthCan } from './model'
import { CostTabView } from './view/CostTabView'

/**
 * Subcontract order › Cost (B-W2b-344; SCM-146): reads GET …/cost when the tab shows and again whenever the record's order
 * moved to a version this tab did not bring (a receipt posts the earned fee; a charge booked elsewhere), and books one
 * thing at a time — a charge, a take-back — with the order's version and one Idempotency-Key per dialog, never
 * optimistically: a 409 reads again and says so. A booking changes the order's version and the work order's cost: the
 * record reads the order again after it (`onChanged`).
 */
export function CostTab({ order, can, timeZone, onChanged }: { order: Pick<SubcontractOrder, 'id' | 'version' | 'receipts'>; can: DepthCan; timeZone: string; onChanged?: () => void }) {
  const api = useOfficeApi()
  const [cost, setCost] = useState<Loaded<OrderCost>>({ status: 'loading' })
  const current = useRef<OrderCost | null>(null)
  /** The order's version the tab's last read or booking stands on (a booking adds one). */
  const readAt = useRef(0)
  const [slow, setSlow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialogState] = useState<CostDialog | null>(null)
  const dialogRef = useRef<CostDialog | null>(null)
  dialogRef.current = dialog
  const [problem, setProblem] = useState<Words | null>(null)
  const [notice, setNotice] = useState<CostModel['notice']>(null)
  const key = useRef<string | null>(null)

  const show = (value: OrderCost) => {
    current.current = value
    setCost({ status: 'ready', value })
  }

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const timer = setTimeout(() => setSlow(true), 1000)
      const at = order.version
      try {
        show(await orderCost(api, order.id, signal))
        readAt.current = Math.max(readAt.current, at)
      } catch (error) {
        if (signal?.aborted) return
        if (isApiError(error) && error.kind === 'not_found') setCost({ status: 'not_found' })
        else if (isApiError(error) && error.kind === 'forbidden') setCost({ status: 'forbidden' })
        else setCost({ status: 'error', problem: readProblem(error) })
      } finally {
        clearTimeout(timer)
        setSlow(false)
      }
    },
    [api, order.id, order.version],
  )

  useEffect(() => {
    if (current.current && readAt.current >= order.version) return
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, order.version])

  const setDialog = useCallback((next: CostDialog | null) => {
    // An edit clears the last refusal (it said why the draft as it was could not be booked).
    setProblem(null)
    if (next && (!dialogRef.current || dialogRef.current.kind !== next.kind)) key.current = newIdempotencyKey()
    dialogRef.current = next
    setDialogState(next)
  }, [])

  const book = useCallback(
    async (run: (version: number, idempotencyKey: string) => Promise<CostBooked>, done: Words) => {
      if (!current.current || busy) return
      setBusy(true)
      setProblem(null)
      const version = Math.max(order.version, readAt.current)
      try {
        const answer = await run(version, key.current ?? newIdempotencyKey())
        readAt.current = version + 1
        show(answer.view)
        setDialogState(null)
        dialogRef.current = null
        key.current = null
        setNotice({ tone: answer.ledger.waiting.length > 0 ? 'info' : 'success', words: answer.ledger.waiting.length > 0 ? words('cost.done.waiting') : done })
        onChanged?.()
      } catch (error) {
        setProblem(costRefusal(error))
        if (isApiError(error) && error.kind === 'conflict') {
          key.current = newIdempotencyKey()
          onChanged?.()
          void load()
        }
      } finally {
        setBusy(false)
      }
    },
    [busy, load, onChanged, order.version],
  )

  const bookNow = () => {
    const open = dialogRef.current
    const value = current.current
    if (open?.kind !== 'book' || !value || bookHeldDraft(open.draft, value)) return
    void book((version, idempotencyKey) => bookCost(api, order.id, bookBody(open.draft, version), idempotencyKey), words('cost.done.booked', { kind: `@cost.kind.${open.draft.kind}` }))
  }

  const reverseNow = () => {
    const open = dialogRef.current
    if (open?.kind !== 'reverse' || open.reason.trim() === '') return
    void book((version, idempotencyKey) => reverseCost(api, order.id, open.entryId, { version, reason: open.reason.trim() }, idempotencyKey), words('cost.done.reversed'))
  }

  const receipts = order.receipts.map((receipt, index) => ({ id: receipt.id, seq: index + 1, receivedAt: receipt.receivedAt }))
  const model: CostModel = { cost, can, receipts, busy, dialog, problem, notice, timeZone, slow }
  return <CostTabView model={model} actions={{ onRetry: () => void load(), onDialog: setDialog, onBook: bookNow, onReverse: reverseNow, onDismissNotice: () => setNotice(null) }} />
}
