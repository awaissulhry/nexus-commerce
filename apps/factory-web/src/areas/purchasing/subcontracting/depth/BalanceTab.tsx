'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { isApiError } from '../../../../lib/api/errors'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import type { SubcontractOrder } from '../api'
import type { Words } from '../model'
import type { Loaded } from '../record/record-model'
import { adjustBalance, declareBalance, orderBalance, type BalanceBooked, type OrderBalance } from './api'
import { adjustBody, adjustHeldDraft, balanceRefusal, bookedWords, declareBody, declareHeldDraft, readProblem, softLocked, type BalanceDialog, type BalanceModel, type DepthCan } from './model'
import { BalanceTabView } from './view/BalanceTabView'

/**
 * Subcontract order › Material balance (B-W2b-344; SCM-143, SCM-144): reads GET …/balance when the tab shows and again
 * whenever the record's order moved to a version this tab did not bring (the record re-reads on its live
 * subcontract_order.* events: a receipt, the workshop's kit check, a booking elsewhere), and books one thing at a time —
 * the workshop's declaration, an over- or under-consumption — with the order's version as read and one Idempotency-Key per
 * dialog, never optimistically: a 409 reads again and says so. A booking moves stock and the work order's cost: the record
 * reads the order again after it (`onChanged`).
 */
export function BalanceTab({ order, can, timeZone, onChanged }: { order: Pick<SubcontractOrder, 'id' | 'version' | 'workOrder'>; can: DepthCan; timeZone: string; onChanged?: () => void }) {
  const api = useOfficeApi()
  const [balance, setBalance] = useState<Loaded<OrderBalance>>({ status: 'loading' })
  const current = useRef<OrderBalance | null>(null)
  const [slow, setSlow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialogState] = useState<BalanceDialog | null>(null)
  const dialogRef = useRef<BalanceDialog | null>(null)
  dialogRef.current = dialog
  const [problem, setProblem] = useState<Words | null>(null)
  const [notice, setNotice] = useState<BalanceModel['notice']>(null)
  const key = useRef<string | null>(null)

  const show = (value: OrderBalance) => {
    current.current = value
    setBalance({ status: 'ready', value })
  }

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const timer = setTimeout(() => setSlow(true), 1000)
      try {
        show(await orderBalance(api, order.id, signal))
      } catch (error) {
        if (signal?.aborted) return
        if (isApiError(error) && error.kind === 'not_found') setBalance({ status: 'not_found' })
        else if (isApiError(error) && error.kind === 'forbidden') setBalance({ status: 'forbidden' })
        else setBalance({ status: 'error', problem: readProblem(error) })
      } finally {
        clearTimeout(timer)
        setSlow(false)
      }
    },
    [api, order.id],
  )

  // Read when the tab shows, and again when the order moved on (unless this tab's own booking brought that version).
  useEffect(() => {
    if (current.current && current.current.order.version >= order.version) return
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, order.version])

  const setDialog = useCallback((next: BalanceDialog | null) => {
    // An edit clears the last refusal (it said why the draft as it was could not be booked).
    setProblem(null)
    if (next && (!dialogRef.current || dialogRef.current.kind !== next.kind)) key.current = newIdempotencyKey()
    dialogRef.current = next
    setDialogState(next)
  }, [])

  const book = useCallback(
    async (run: (version: number, idempotencyKey: string) => Promise<BalanceBooked>) => {
      const value = current.current
      if (!value || busy) return
      setBusy(true)
      setProblem(null)
      try {
        const answer = await run(Math.max(value.order.version, order.version), key.current ?? newIdempotencyKey())
        show(answer.balance)
        setDialogState(null)
        dialogRef.current = null
        key.current = null
        setNotice({ tone: 'success', words: bookedWords(answer, can) })
        onChanged?.()
      } catch (error) {
        setProblem(balanceRefusal(error))
        // B-W2b-408 (follow-up GL1:01): a soft-locked month takes it with a reason: the dialog asks for one (a hard lock never).
        const open = dialogRef.current
        if (softLocked(error) && open && open.draft.lockReason === null) {
          const next = { ...open, draft: { ...open.draft, lockReason: '' } } as BalanceDialog
          dialogRef.current = next
          setDialogState(next)
        }
        if (isApiError(error) && error.kind === 'conflict') {
          // A new key for the next try: the same key would replay the refused booking.
          key.current = newIdempotencyKey()
          void load()
        }
      } finally {
        setBusy(false)
      }
    },
    [busy, can, load, onChanged, order.version],
  )

  const declare = () => {
    const open = dialogRef.current
    const value = current.current
    if (open?.kind !== 'declare' || !value || declareHeldDraft(open.draft, value)) return
    void book((version, idempotencyKey) => declareBalance(api, order.id, declareBody(open.draft, version), idempotencyKey))
  }

  const adjust = () => {
    const open = dialogRef.current
    const line = current.current?.lines.find((entry) => entry.kitLineId === (open?.kind === 'adjust' ? open.draft.kitLineId : ''))
    if (open?.kind !== 'adjust' || !line || adjustHeldDraft(open.draft, line)) return
    void book((version, idempotencyKey) => adjustBalance(api, order.id, adjustBody(open.draft, version), idempotencyKey))
  }

  const model: BalanceModel = { balance, can, workOrder: order.workOrder.number, busy, dialog, problem, notice, timeZone, slow }
  return <BalanceTabView model={model} actions={{ onRetry: () => void load(), onDialog: setDialog, onDeclare: declare, onAdjust: adjust, onDismissNotice: () => setNotice(null) }} />
}
