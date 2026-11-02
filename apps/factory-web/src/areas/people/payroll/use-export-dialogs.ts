'use client'

import { useRef, useState } from 'react'
import { isApiError } from '../../../lib/api/errors'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import type { Locale } from '../../../lib/i18n/locales'
import { cancelExport, createExport, getMonth, previewMonth, sendExport, withdrawLink, type ExportRecord } from './api'
import { correctHeld, payrollProblem, sendBody, sendDraftOf, sendHeld, type PayrollCan } from './model'
import { PREVIEW_IDLE, type CancelDialog, type CorrectDialog, type ExportDialogActions, type ExportDialogs, type ExportTarget, type SendDialog } from './view-model'

/** The kind of failure after which the same Idempotency-Key finishes the same work. */
const mayHaveLanded = (error: unknown): boolean => !isApiError(error) || error.kind === 'unavailable' || error.kind === 'internal'

/**
 * The three pop-ups a file has, wherever it is shown (Exports, step 5, the Past export): Send to the labour consultant, Make
 * correction export, Cancel a draft. Each write is one command with its Idempotency-Key; a send or a correction that may have
 * landed repeats with the same key. `onChanged` reads the page again; `onMade` hands over a new file.
 */
export function useExportDialogs(api: ApiClient, facts: { companyId: string | null; can: PayrollCan; locale: Locale; own: () => void; onChanged: () => void; onMade?: (record: ExportRecord) => void }): { dialogs: ExportDialogs; actions: ExportDialogActions } {
  const { companyId, can, locale, own, onChanged, onMade } = facts
  const [send, setSend] = useState<SendDialog | null>(null)
  const [correct, setCorrect] = useState<CorrectDialog | null>(null)
  const [cancel, setCancel] = useState<CancelDialog | null>(null)
  const sendKey = useRef<string | null>(null)
  const correctKey = useRef<string | null>(null)

  const openCorrect = (target: ExportTarget) => {
    setCorrect({ target, month: null, readProblem: null, busy: false, startedAt: null, problem: null, changes: PREVIEW_IDLE, done: null })
    correctKey.current = null
    if (!companyId) return
    getMonth(api, { companyId, month: target.month, layoutId: target.layout.id })
      .then((month) => setCorrect((current) => (current && current.target.id === target.id ? { ...current, month } : current)))
      .catch((error: unknown) => setCorrect((current) => (current && current.target.id === target.id ? { ...current, readProblem: payrollProblem(error) } : current)))
  }

  const actions: ExportDialogActions = {
    onOpenSend: (target) => {
      sendKey.current = null
      setSend({ target, draft: sendDraftOf(locale, target.sentTo[0] ?? ''), busy: false, problem: null, done: null, withdrawing: false, withdrawn: false })
    },
    onSendDraft: (patch) => setSend((current) => (current ? { ...current, draft: { ...current.draft, ...patch }, problem: null } : current)),
    onSend: () => {
      if (!send || send.done || sendHeld(send.draft, can, send.busy)) return
      const key = (sendKey.current ??= newIdempotencyKey())
      setSend({ ...send, busy: true, problem: null })
      own()
      sendExport(api, send.target.id, sendBody(send.draft), key)
        .then((done) => {
          sendKey.current = null
          setSend((current) => (current ? { ...current, busy: false, done } : current))
          onChanged()
        })
        .catch((error: unknown) => {
          if (!mayHaveLanded(error)) sendKey.current = null
          setSend((current) => (current ? { ...current, busy: false, problem: payrollProblem(error) } : current))
        })
    },
    onWithdrawSent: () => {
      if (!send?.done || send.withdrawing || send.withdrawn) return
      setSend({ ...send, withdrawing: true, problem: null })
      own()
      withdrawLink(api, send.target.id, send.done.link.id)
        .then(() => {
          setSend((current) => (current ? { ...current, withdrawing: false, withdrawn: true } : current))
          onChanged()
        })
        .catch((error: unknown) => setSend((current) => (current ? { ...current, withdrawing: false, problem: payrollProblem(error) } : current)))
    },
    onCloseSend: () => setSend(null),
    onOpenCorrect: openCorrect,
    onReadChanges: () => {
      if (!correct || !companyId || !can.records || correct.changes.status === 'reading') return
      const target = correct.target
      setCorrect({ ...correct, changes: { status: 'reading', value: null, problem: null } })
      previewMonth(api, { companyId, month: target.month })
        .then((value) => setCorrect((current) => (current && current.target.id === target.id ? { ...current, changes: { status: 'ready', value, problem: null } } : current)))
        .catch((error: unknown) => setCorrect((current) => (current && current.target.id === target.id ? { ...current, changes: { status: 'error', value: null, problem: payrollProblem(error) } } : current)))
    },
    onCorrect: () => {
      if (!correct || !companyId || correct.done || correctHeld({ month: correct.month, can, busy: correct.busy })) return
      const key = (correctKey.current ??= newIdempotencyKey())
      setCorrect({ ...correct, busy: true, startedAt: Date.now(), problem: null })
      own()
      createExport(api, { companyId, month: correct.target.month, correctionOfId: correct.target.id }, key)
        .then((record) => {
          correctKey.current = null
          setCorrect((current) => (current ? { ...current, busy: false, startedAt: null, changes: PREVIEW_IDLE, done: record } : current))
          onMade?.(record)
          onChanged()
        })
        .catch((error: unknown) => {
          if (!mayHaveLanded(error)) correctKey.current = null
          setCorrect((current) => (current ? { ...current, busy: false, startedAt: null, problem: payrollProblem(error) } : current))
        })
    },
    onCloseCorrect: () => setCorrect(null),
    onOpenCancel: (target) => setCancel({ target, reason: '', busy: false, problem: null }),
    onCancelReason: (text) => setCancel((current) => (current ? { ...current, reason: text, problem: null } : current)),
    onCancelDraft: () => {
      if (!cancel || cancel.busy || cancel.reason.trim().length < 3) return
      setCancel({ ...cancel, busy: true, problem: null })
      own()
      cancelExport(api, cancel.target.id, { version: cancel.target.version, reason: cancel.reason.trim() })
        .then(() => {
          setCancel(null)
          onChanged()
        })
        .catch((error: unknown) => setCancel((current) => (current ? { ...current, busy: false, problem: payrollProblem(error) } : current)))
    },
    onCloseCancel: () => setCancel(null),
  }

  return { dialogs: { send, correct, cancel }, actions }
}
