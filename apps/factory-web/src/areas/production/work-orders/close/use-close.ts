'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import type { WorkOrder } from '../../_shared/api'
import { useLive } from '../../_shared/hooks'
import { closeWorkOrder, getCloseCheck, reopenWorkOrder, undoClose, type CloseCheck, type CloseReason } from './api'
import { checksClose, closeCanOf, closeInput, closeTouches, CLOSE_NS, readProblem, undoShownUntil, writeProblem, type CloseCan, type Phrase } from './model'

/** The close's part of the work order record (SCR-460). The view draws it and fetches nothing. */
export interface CloseModel {
  readonly can: CloseCan
  /** The close check of a completed or closed work order (null: not asked — another state). */
  readonly check: { readonly value: CloseCheck | null; readonly problem: string | null } | null
  /** The open dialog: Close work order, or Reopen. */
  readonly dialog: 'close' | 'reopen' | null
  readonly busy: boolean
  /** A refused write, said inside its dialog (what was typed stays). */
  readonly problem: Phrase | null
  /** The Undo after a close, for a few seconds (paused while the pointer or the focus is on it). */
  readonly undo: { readonly number: string; readonly settled: boolean; readonly problem: Phrase | null } | null
  /** Design cases: what is typed in the dialog. */
  readonly draft?: { readonly reason?: CloseReason | null; readonly note?: string; readonly reopenReason?: string }
}

export interface CloseActions {
  onOpen?: () => void
  onCancel?: () => void
  onRetry?: () => void
  onClose?: (input: { reason: CloseReason | null; note: string }) => void
  onUndo?: () => void
  /** The pointer or the focus is on the Undo (true) or left it (false): its few seconds pause meanwhile. */
  onHoldUndo?: (held: boolean) => void
  onDismissUndo?: () => void
  onOpenReopen?: () => void
  onReopen?: (reason: string) => void
}

/** A notice for the record (`costing-close:<key>`: the record's banner reads it from this catalogue). */
const notice = (key: string, params?: Phrase['params']) => ({ key: `${CLOSE_NS}:${key}`, ...(params ? { params } : {}) })

/**
 * The work order close (B-W2b-424 on B-W2b-411's API): reads the close check of a completed or closed work order (again on
 * its version, on a live close event and when the dialog opens), closes it with the version read and one Idempotency-Key
 * per attempt (the reason code only when the check asks for one), then offers Undo for a few seconds — paused while the
 * pointer or the focus is on it, never past the API's limit — and reopens a closed one with a reason. Every write hands
 * the work order it answers to the record (`onWritten`), which reads its parts again and says what happened.
 */
export function useClose(
  api: ApiClient,
  workOrder: Pick<WorkOrder, 'id' | 'number' | 'status' | 'version'> | null,
  permissions: readonly string[],
  onWritten: (next: WorkOrder, words: { key: string; params?: Phrase['params'] } | null) => void,
): { model: CloseModel; actions: CloseActions } {
  const can = useMemo(() => closeCanOf(permissions), [permissions])
  const [check, setCheck] = useState<CloseModel['check']>(null)
  const [dialog, setDialog] = useState<CloseModel['dialog']>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Phrase | null>(null)
  const [undo, setUndo] = useState<CloseModel['undo']>(null)
  const turn = useRef(0)
  const attempt = useRef<string | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The API's limit for this Undo, and when it leaves the screen (null while paused). */
  const undoLimit = useRef<number | null>(null)
  const undoEnds = useRef<number | null>(null)
  const undoLeft = useRef<number | null>(null)
  const current = useRef(workOrder)
  current.current = workOrder
  const id = workOrder?.id ?? null
  const asks = checksClose(workOrder?.status)

  const read = useCallback(() => {
    if (!id) return
    const mine = ++turn.current
    setCheck((now) => ({ value: now?.value ?? null, problem: null }))
    getCloseCheck(api, id)
      .then((value) => mine === turn.current && setCheck({ value, problem: null }))
      .catch((error: unknown) => mine === turn.current && setCheck({ value: null, problem: readProblem(error) }))
  }, [api, id])

  useEffect(() => {
    if (asks) read()
    else setCheck(null)
  }, [asks, read, workOrder?.version])

  useLive(
    (change) => {
      if (id && asks && closeTouches(change, id)) read()
    },
    () => {
      if (asks) read()
    },
    asks,
  )

  const stopUndo = useCallback(() => {
    if (undoTimer.current) clearTimeout(undoTimer.current)
    undoTimer.current = null
    undoLimit.current = null
    undoEnds.current = null
    undoLeft.current = null
    setUndo(null)
  }, [])
  const runUndoTimer = useCallback(
    (ms: number) => {
      if (undoTimer.current) clearTimeout(undoTimer.current)
      const wait = Math.max(0, ms)
      undoEnds.current = Date.now() + wait
      undoTimer.current = setTimeout(stopUndo, wait)
    },
    [stopUndo],
  )
  useEffect(() => () => void (undoTimer.current && clearTimeout(undoTimer.current)), [])

  const actions: CloseActions = {
    onOpen: () => {
      attempt.current = null
      setProblem(null)
      setDialog('close')
      read()
    },
    onCancel: () => {
      if (busy) return
      setDialog(null)
      setProblem(null)
    },
    onRetry: read,
    onClose: (input) => {
      const wo = current.current
      const value = check?.value
      if (!wo || !value || busy) return
      attempt.current ??= newIdempotencyKey()
      setBusy(true)
      setProblem(null)
      closeWorkOrder(api, wo.id, closeInput(value, wo.version, input), attempt.current)
        .then((answer) => {
          attempt.current = null
          setDialog(null)
          const until = undoShownUntil(answer.close, Date.now())
          if (until !== null) {
            undoLimit.current = Date.parse(answer.close.undoUntil ?? '')
            setUndo({ number: answer.workOrder.number, settled: answer.close.settled, problem: null })
            runUndoTimer(until - Date.now())
            onWritten(answer.workOrder, null)
          } else {
            onWritten(answer.workOrder, notice(answer.close.settled ? 'notice.closedSettled' : 'notice.closed', { number: answer.workOrder.number }))
          }
        })
        .catch((error: unknown) => {
          attempt.current = null
          setProblem(writeProblem(error))
          read()
        })
        .finally(() => setBusy(false))
    },
    onUndo: () => {
      const wo = current.current
      if (!wo || busy) return
      setBusy(true)
      undoClose(api, wo.id, wo.version)
        .then((answer) => {
          stopUndo()
          onWritten(answer.workOrder, notice('notice.undone', { number: answer.workOrder.number }))
        })
        .catch((error: unknown) => setUndo((shown) => (shown ? { ...shown, problem: writeProblem(error) } : shown)))
        .finally(() => setBusy(false))
    },
    onHoldUndo: (held) => {
      if (!undo || undoLimit.current === null) return
      if (held) {
        if (undoEnds.current === null) return
        if (undoTimer.current) clearTimeout(undoTimer.current)
        undoTimer.current = null
        undoLeft.current = Math.max(UNDO_LEFT_MIN, undoEnds.current - Date.now())
        undoEnds.current = null
        // The API's limit still holds while paused.
        undoTimer.current = setTimeout(stopUndo, Math.max(0, undoLimit.current - Date.now()))
      } else if (undoLeft.current !== null) {
        runUndoTimer(Math.min(undoLeft.current, undoLimit.current - Date.now()))
        undoLeft.current = null
      }
    },
    onDismissUndo: stopUndo,
    onOpenReopen: () => {
      attempt.current = null
      setProblem(null)
      setDialog('reopen')
    },
    onReopen: (reason) => {
      const wo = current.current
      if (!wo || busy) return
      attempt.current ??= newIdempotencyKey()
      setBusy(true)
      setProblem(null)
      reopenWorkOrder(api, wo.id, { version: wo.version, reason }, attempt.current)
        .then((answer) => {
          attempt.current = null
          setDialog(null)
          onWritten(answer.workOrder, notice('notice.reopened', { number: answer.workOrder.number }))
        })
        .catch((error: unknown) => {
          attempt.current = null
          setProblem(writeProblem(error))
        })
        .finally(() => setBusy(false))
    },
  }

  return { model: { can, check, dialog, busy, problem, undo }, actions }
}

/** After the pointer or the focus leaves the Undo, it stays at least a few seconds more (within the API's limit). */
const UNDO_LEFT_MIN = 4_000
