'use client'

import { useCallback, useRef, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { isStepUpCancelled, useStepUp } from '../_shared/hooks'
import { closeNcr, getNcr, newIdempotencyKey, type NcrRecord } from './api'
import { checksSay, factsOfRecord, readProblem, refusalOf, type Say } from './model'
import type { NcrNotice } from './parts'
import type { CloseDialogModel } from './view/CloseNcrDialog'

/**
 * The closing flow (design ncr-close), the same from the board's drop on Closed and the record's band: read the NCR
 * again (its closing checklist as it is now), the note, then ONE close command with its own Idempotency-Key, asked again
 * with the same key after the office's step-up (a 403 `stepUp` opens the DS code dialog; closing is an e-signature).
 * The answer names the holds closed with it. A drop resolves `true` once closed, `false` when the dialog is left.
 */
export function useCloseFlow(api: ApiClient, onClosed: (record: NcrRecord, holdsClosed: number) => void) {
  const [dialog, setDialog] = useState<CloseDialogModel | null>(null)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const read = useRef<NcrRecord | null>(null)
  const key = useRef<string | null>(null)
  const settle = useRef<((closed: boolean) => void) | null>(null)

  const finish = useCallback((closed: boolean) => {
    settle.current?.(closed)
    settle.current = null
    read.current = null
    key.current = null
    setDialog(null)
  }, [])

  /** Opens the dialog for one NCR; the promise says whether it was closed (the board waits for it). */
  const open = useCallback(
    (ncr: { id: string; number: string }, held: Say | null, known?: NcrRecord | null): Promise<boolean> => {
      settle.current?.(false)
      key.current = null
      const fill = (record: NcrRecord) => {
        read.current = record
        setDialog((current) => (current && current.ncrId === record.ncr.id ? { ...current, checks: checksSay(record.closing.checks, factsOfRecord(record), 'CLOSED'), ready: record.closing.ready, readProblem: null } : current))
      }
      setDialog({ ncrId: ncr.id, number: ncr.number, checks: null, ready: false, note: '', busy: false, notice: null, readProblem: null, held })
      if (known) fill(known)
      else
        getNcr(api, ncr.id)
          .then(fill)
          .catch((error: unknown) => setDialog((current) => (current && current.ncrId === ncr.id ? { ...current, readProblem: readProblem(error) } : current)))
      return new Promise<boolean>((resolve) => {
        settle.current = resolve
      })
    },
    [api],
  )

  const submit = useCallback(async () => {
    const current = dialog
    const record = read.current
    if (!current || !record || current.busy) return
    setDialog({ ...current, busy: true, notice: null })
    key.current ??= newIdempotencyKey()
    const idempotencyKey = key.current
    try {
      const answer = await guard('close.stepUp', () => closeNcr(api, record.ncr.id, { version: record.ncr.version, note: current.note.trim() }, idempotencyKey))
      onClosed(answer.record, answer.holdsClosed.length)
      finish(true)
    } catch (error) {
      if (isStepUpCancelled(error)) {
        setDialog((now) => (now ? { ...now, busy: false, notice: { say: { key: 'close.cancelled' }, tone: 'warning' } } : now))
        return
      }
      const refusal = refusalOf(error)
      key.current = null
      // The record as it is now: the checklist says what is missing.
      getNcr(api, record.ncr.id)
        .then((fresh) => {
          read.current = fresh
          setDialog((now) => (now ? { ...now, checks: checksSay(fresh.closing.checks, factsOfRecord(fresh), 'CLOSED'), ready: fresh.closing.ready } : now))
        })
        .catch(() => undefined)
      const notice: NcrNotice = { say: refusal.say, tone: 'danger', detail: refusal.detail }
      setDialog((now) => (now ? { ...now, busy: false, notice } : now))
    }
  }, [dialog, api, guard, onClosed, finish])

  return {
    dialog,
    stepUp,
    open,
    submitStepUp,
    cancelStepUp,
    actions: {
      onNote: (note: string) => setDialog((current) => (current ? { ...current, note } : current)),
      onSubmit: () => void submit(),
      onCancel: () => finish(false),
    },
  }
}
