'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { isApiError } from '../../../../../lib/api/errors'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { useOfficeApi } from '../../../../../lib/session/context'
import { todayIn } from '../../../../_shared/buying/model'
import type { SubcontractOrder } from '../../api'
import { words } from '../../model'
import type { Loaded, ReceiveDraft } from '../record-model'
import { actForWorkshop, cancelReturn, decideDate, getWorkshop, sendJobLink, type ForWorkshop, type WorkshopAnswer } from './api'
import { answerAct, dialogHeld, kitAct, linkBody, progressAct, readProblem, receiveDraftFrom, returnsAct, writeProblem, type WorkshopDialog, type WorkshopPanelModel } from './model'
import { WorkshopSection } from './view/WorkshopPanelView'

/**
 * What the workshop said, under the subcontract order's Kit tab (B-W2b-176): reads GET …/workshop when the tab shows and
 * again whenever the record's order moved to another version (the record re-reads on its live subcontract_order.* events,
 * the workshop's own among them), and writes one thing at a time — the job link, our answer to a proposed date, the
 * workshop's acts recorded for it (Owner answer C3), the cancel of a send-back — each with the job's version as read and
 * one Idempotency-Key per dialog, never optimistically: a 409 reads again and says so. "Receive back from this" opens the
 * record's own Receive back prefilled from the send-back (the record's slot `onReceiveWith`). The link's address shown
 * after "Get the link to pass on" lives in this state only, once.
 */
export function WorkshopPanel({ order, timeZone, onReceiveWith, onChanged }: { order: SubcontractOrder; timeZone: string; onReceiveWith?: (shape: (draft: ReceiveDraft) => ReceiveDraft) => void; onChanged?: () => void }) {
  const api = useOfficeApi()
  const [answer, setAnswer] = useState<Loaded<WorkshopAnswer>>({ status: 'loading' })
  const [slow, setSlow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialogState] = useState<WorkshopDialog | null>(null)
  const [problem, setProblem] = useState<WorkshopPanelModel['problem']>(null)
  const [notice, setNotice] = useState<WorkshopPanelModel['notice']>(null)
  const [handed, setHanded] = useState<string | null>(null)
  const key = useRef<string | null>(null)
  const current = useRef<WorkshopAnswer | null>(null)
  const dialogRef = useRef<WorkshopDialog | null>(null)
  dialogRef.current = dialog

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const timer = setTimeout(() => setSlow(true), 1000)
      try {
        const value = await getWorkshop(api, order.id, signal)
        current.current = value
        setAnswer({ status: 'ready', value })
      } catch (error) {
        if (signal?.aborted) return
        if (isApiError(error) && error.kind === 'not_found') setAnswer({ status: 'not_found' })
        else if (isApiError(error) && error.kind === 'forbidden') setAnswer({ status: 'forbidden' })
        else setAnswer({ status: 'error', problem: readProblem(error) })
      } finally {
        clearTimeout(timer)
        setSlow(false)
      }
    },
    [api, order.id],
  )

  // Read when the tab shows, and again when the order moved on (unless this panel's own write brought that version).
  useEffect(() => {
    if (current.current && current.current.job.version === order.version) return
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, order.version])

  const setDialog = useCallback((next: WorkshopDialog | null) => {
    if (!next) setProblem(null)
    if (next && (!dialogRef.current || dialogRef.current.kind !== next.kind)) key.current = newIdempotencyKey()
    setDialogState(next)
  }, [])

  const write = useCallback(
    async (work: (value: WorkshopAnswer, idempotencyKey: string) => Promise<WorkshopAnswer & { url?: string | null }>, done: WorkshopPanelModel['notice']) => {
      const value = current.current
      if (!value || busy) return
      setBusy(true)
      setProblem(null)
      try {
        const next = await work(value, key.current ?? newIdempotencyKey())
        current.current = next
        setAnswer({ status: 'ready', value: next })
        setDialogState(null)
        if (next.url) setHanded(next.url)
        setNotice(done)
        key.current = null
        onChanged?.()
      } catch (error) {
        setProblem(writeProblem(error))
        if (isApiError(error) && error.kind === 'conflict') {
          key.current = newIdempotencyKey()
          void load()
        }
      } finally {
        setBusy(false)
      }
    },
    [busy, load, onChanged],
  )

  const today = todayIn(timeZone)
  const confirm = (kind: WorkshopDialog['kind'], run: (open: WorkshopDialog, value: WorkshopAnswer, idempotencyKey: string) => Promise<WorkshopAnswer & { url?: string | null }>, done: WorkshopPanelModel['notice']) => {
    const open = dialogRef.current
    const value = current.current
    if (!open || open.kind !== kind || !value || dialogHeld(open, value, today)) return
    void write((latest, idempotencyKey) => run(open, latest, idempotencyKey), done)
  }
  const forWorkshop = (act: (open: WorkshopDialog) => ForWorkshop, doneKey: string) =>
    confirm(dialogRef.current?.kind ?? 'answer', (open, value, idempotencyKey) => actForWorkshop(api, order.id, value.job.version, act(open), idempotencyKey), { tone: 'success', words: words(doneKey) })

  const model: WorkshopPanelModel = { answer, slow, busy, dialog, problem, notice, handed, timeZone, today }

  return (
    <WorkshopSection
      model={model}
      actions={{
        onRetry: () => void load(),
        onDialog: setDialog,
        onSendLink: () =>
          confirm('link', (open, _value, idempotencyKey) => sendJobLink(api, order.id, linkBody(open as Extract<WorkshopDialog, { kind: 'link' }>), idempotencyKey), {
            tone: 'success',
            words: words((dialogRef.current as Extract<WorkshopDialog, { kind: 'link' }> | null)?.mode === 'hand' ? 'notice.linkHanded' : 'notice.linkSent'),
          }),
        onDecideDate: () =>
          confirm('date', (open, value, idempotencyKey) => decideDate(api, order.id, value.job.version, (open as Extract<WorkshopDialog, { kind: 'date' }>).decision, idempotencyKey), {
            tone: 'success',
            words: words((dialogRef.current as Extract<WorkshopDialog, { kind: 'date' }> | null)?.decision === 'REFUSED' ? 'notice.dateRefused' : 'notice.dateAccepted'),
          }),
        onAnswer: () => forWorkshop((open) => answerAct(open as Extract<WorkshopDialog, { kind: 'answer' }>), (dialogRef.current as Extract<WorkshopDialog, { kind: 'answer' }> | null)?.mode === 'decline' ? 'notice.declined' : 'notice.accepted'),
        onKit: () => forWorkshop((open) => kitAct(open as Extract<WorkshopDialog, { kind: 'kit' }>), 'notice.kit'),
        onProgress: () => forWorkshop((open) => progressAct(open as Extract<WorkshopDialog, { kind: 'progress' }>), 'notice.progress'),
        onReturn: () => forWorkshop((open) => returnsAct(open as Extract<WorkshopDialog, { kind: 'returns' }>), 'notice.returns'),
        onCancelReturn: () =>
          confirm(
            'cancelReturn',
            (open, value, idempotencyKey) => {
              const cancel = open as Extract<WorkshopDialog, { kind: 'cancelReturn' }>
              return cancelReturn(api, order.id, cancel.returnNoticeId, value.job.version, cancel.reason.trim(), idempotencyKey)
            },
            { tone: 'success', words: words('notice.returnCancelled') },
          ),
        onReceiveFrom: (returnNoticeId) => {
          const prefill = current.current?.prefills.find((entry) => entry.returnNoticeId === returnNoticeId)
          if (prefill) onReceiveWith?.((draft) => receiveDraftFrom(draft, prefill))
        },
        onCopyLink: () => {
          if (handed) void navigator.clipboard?.writeText(handed).then(() => setNotice({ tone: 'info', words: words('notice.linkCopied') })).catch(() => undefined)
        },
        onForgetLink: () => setHanded(null),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
