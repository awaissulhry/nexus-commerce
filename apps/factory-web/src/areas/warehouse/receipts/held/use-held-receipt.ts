'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import type { Receipt } from '../api'
import { cancelHeldReceipt, heldRequests, postHeldReceipt } from './api'
import { cancelReasonOf, heldActionHeld, heldLinesOf, heldProblem, heldStateOf, type HeldRequests, type HeldState } from './model'

export interface HeldLineRef {
  readonly lineId: string
  readonly seq: number
  readonly taskId: string
}

export interface HeldModel {
  readonly receipt: Receipt
  readonly state: HeldState
  /** The lines' requests the reader may see (null: not read, or the reader does not see approvals). */
  readonly requests: HeldRequests | null
  /** The 202's lines and requests, when the screen recorded the receipt itself. */
  readonly held: readonly HeldLineRef[]
  readonly prefix: string
  readonly timeZone: string
  /** Why Cancel and Post wait (a key of words-followups-w2b5), or null. */
  readonly actionHeld: string | null
  readonly busy: boolean
  readonly dialog: { readonly reason: string; readonly problem: string | null } | null
  readonly problem: string | null
  readonly done: { readonly key: 'held.notice.cancelled' | 'held.notice.posted'; readonly number: string } | null
}

export interface HeldActions {
  onCancel?: () => void
  onReason?: (text: string) => void
  onCancelConfirm?: () => void
  onCloseDialog?: () => void
  onPost?: () => void
  onDismiss?: () => void
}

/**
 * The container part of a receipt that waits for a yes (B-W2b-382): reads its held lines' requests (approvals.view), cancels it
 * with a reason and posts it once every line has its yes, each write with ONE Idempotency-Key per dialog or click; a refusal
 * is said in words and, when the receipt moved, it is read again (`onReload`). The receipt answered is handed to `onReceipt`.
 */
export function useHeldReceipt(input: {
  readonly api: ApiClient
  readonly receipt: Receipt | null
  readonly held?: readonly HeldLineRef[]
  readonly prefix: string
  readonly timeZone: string
  readonly receive: boolean
  readonly approvalsView: boolean
  readonly offline: boolean
  readonly onReceipt: (receipt: Receipt) => void
  readonly onReload: () => void
}): { model: HeldModel | null; actions: HeldActions } {
  const { api, receipt, held = [], prefix, timeZone, receive, approvalsView, offline, onReceipt, onReload } = input
  const [requests, setRequests] = useState<HeldRequests | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<HeldModel['dialog']>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<HeldModel['done']>(null)
  const cancelKey = useRef(newIdempotencyKey())
  const postKey = useRef(newIdempotencyKey())

  const lineIds = receipt ? heldLinesOf(receipt).map((line) => line.id) : []
  const lineKey = lineIds.join(',')
  useEffect(() => {
    if (!approvalsView || lineKey === '') {
      setRequests(null)
      return
    }
    const controller = new AbortController()
    heldRequests(api, lineKey.split(','), controller.signal)
      .then((value) => setRequests(value))
      .catch(() => {
        if (!controller.signal.aborted) setRequests(null)
      })
    return () => controller.abort()
  }, [api, approvalsView, lineKey, receipt?.version])

  const cancel = useCallback(async () => {
    if (!receipt || !dialog || busy) return
    const reason = cancelReasonOf(dialog.reason)
    if ('problem' in reason) return setDialog({ ...dialog, problem: reason.problem })
    setBusy(true)
    try {
      const answer = await cancelHeldReceipt(api, receipt.id, reason.reason, cancelKey.current)
      cancelKey.current = newIdempotencyKey()
      setDialog(null)
      setDone({ key: 'held.notice.cancelled', number: answer.number })
      onReceipt(answer)
    } catch (error) {
      const said = heldProblem(error)
      setDialog({ ...dialog, problem: said.key })
      cancelKey.current = newIdempotencyKey()
      if (said.reload) onReload()
    } finally {
      setBusy(false)
    }
  }, [api, busy, dialog, onReceipt, onReload, receipt])

  const post = useCallback(async () => {
    if (!receipt || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const answer = await postHeldReceipt(api, receipt.id, postKey.current)
      postKey.current = newIdempotencyKey()
      setDone({ key: 'held.notice.posted', number: answer.receipt.number })
      onReceipt(answer.receipt)
    } catch (error) {
      const said = heldProblem(error)
      setProblem(said.key)
      postKey.current = newIdempotencyKey()
      if (said.reload) onReload()
    } finally {
      setBusy(false)
    }
  }, [api, busy, onReceipt, onReload, receipt])

  const state = receipt ? heldStateOf(receipt, requests) : 'none'
  const model: HeldModel | null =
    receipt && (state !== 'none' || done || (held.length > 0 && receipt.status === 'CANCELLED'))
      ? { receipt, state, requests, held, prefix, timeZone, actionHeld: heldActionHeld({ receive, offline, busy }), busy, dialog, problem, done }
      : null
  return {
    model,
    actions: {
      onCancel: () => {
        cancelKey.current = newIdempotencyKey()
        setDialog({ reason: '', problem: null })
      },
      onReason: (text) => setDialog((current) => (current ? { reason: text, problem: null } : current)),
      onCancelConfirm: () => void cancel(),
      onCloseDialog: () => setDialog(null),
      onPost: () => void post(),
      onDismiss: () => setDone(null),
    },
  }
}
