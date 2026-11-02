'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { acceptAnomaly, approveDay, correctDay, fixDay, readCorrections, readDay, reopenDay, type AbsenceCode, type DayCorrections, type DayRecord } from './api'
import { figureOf, fixActionOf, fixDraftOf, isGateClosed, problemOf, readProblem, reasonOf, type CorrectionDraft, type FixDraft, type ManualReason, type Words } from './model'
import type { Loaded } from '../_shared/parts'

/**
 * One person's day (design pop-up "Day detail"): the record, the corrections when its month is closed, and every decision
 * about it — Approve, Fix a day, accept an anomaly, reopen, Correct a closed day. ONE hook for the Attendance page and the
 * employee's Attendance tab. Every write sends the version read and answers with the day as it stands now.
 */

export type DayDialog =
  | { kind: 'fix'; draft: FixDraft; busy: boolean; problem: Words | null }
  | { kind: 'accept'; anomalyId: string; note: string; busy: boolean; problem: Words | null }
  | { kind: 'reopen'; reason: string; busy: boolean; problem: Words | null }
  | { kind: 'correct'; record: DayCorrections; draft: CorrectionDraft; busy: boolean; problem: Words | null }

export interface DayState {
  id: string
  loaded: Loaded<DayRecord>
  /** Its month is closed: what the sealed calendar says and what was corrected. */
  corrections: DayCorrections | null
  busy: boolean
  problem: Words | null
  dialog: DayDialog | null
}

export interface DayActions {
  onRetry: () => void
  onApprove: () => void
  onFix: () => void
  onFixDraft: (patch: Partial<FixDraft>) => void
  onFixSave: () => void
  onAccept: (anomalyId: string) => void
  onAcceptNote: (note: string) => void
  onAcceptSave: () => void
  onReopen: () => void
  onReopenReason: (reason: string) => void
  onReopenSave: () => void
  onCorrect: () => void
  onCorrectDraft: (patch: Partial<CorrectionDraft>) => void
  onCorrectSave: () => void
  onCloseDialog: () => void
}

export function useDayRecord(input: { api: ApiClient; dayId: string | null; reasonWords: (code: ManualReason) => string; onChanged: (day: DayRecord) => void; onGateClosed?: () => void; codes?: readonly AbsenceCode[] }): { state: DayState | null; actions: DayActions } {
  const { api, dayId, reasonWords, onGateClosed } = input
  const changed = useRef(input.onChanged)
  changed.current = input.onChanged
  const [loaded, setLoaded] = useState<Loaded<DayRecord>>({ status: 'loading' })
  const [corrections, setCorrections] = useState<DayCorrections | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Words | null>(null)
  const [dialog, setDialog] = useState<DayDialog | null>(null)
  const current = useRef<string | null>(dayId)
  current.current = dayId

  const read = useCallback(async () => {
    if (!dayId) return
    try {
      const value = await readDay(api, dayId)
      if (current.current !== dayId) return
      setLoaded({ status: 'ready', value })
      setCorrections(value.status === 'CLOSED' ? await readCorrections(api, dayId).catch(() => null) : null)
    } catch (error) {
      if (current.current !== dayId) return
      if (isGateClosed(error)) onGateClosed?.()
      setLoaded(isApiError(error) && error.kind === 'not_found' ? { status: 'notFound' } : isApiError(error) && error.kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) })
    }
  }, [api, dayId, onGateClosed])

  useEffect(() => {
    setLoaded({ status: 'loading' })
    setCorrections(null)
    setProblem(null)
    setDialog(null)
    void read()
  }, [read])

  const value = loaded.status === 'ready' ? loaded.value : null

  /** A write's answer is the day as it stands: the list and the tiles follow. */
  const took = useCallback((record: DayRecord) => {
    setLoaded({ status: 'ready', value: record })
    setProblem(null)
    setDialog(null)
    changed.current(record)
  }, [])

  const refused = useCallback(
    (error: unknown, family: 'day' = 'day') => {
      if (isGateClosed(error)) onGateClosed?.()
      return problemOf(error, family)
    },
    [onGateClosed],
  )

  const patch = useCallback((change: (entry: DayDialog) => DayDialog) => setDialog((entry) => (entry ? change(entry) : entry)), [])

  const actions: DayActions = {
    onRetry: () => void read(),
    onApprove: () => {
      if (!value || busy) return
      setBusy(true)
      setProblem(null)
      approveDay(api, value.id, value.version)
        .then(took)
        .catch((error: unknown) => {
          setProblem(refused(error))
          void read()
        })
        .finally(() => setBusy(false))
    },
    onFix: () => value && setDialog({ kind: 'fix', draft: fixDraftOf(value), busy: false, problem: null }),
    onFixDraft: (change) => patch((entry) => (entry.kind === 'fix' ? { ...entry, draft: { ...entry.draft, ...change }, problem: null } : entry)),
    onFixSave: () => {
      if (!value || dialog?.kind !== 'fix' || dialog.busy) return
      const { draft } = dialog
      patch((entry) => ({ ...entry, busy: true, problem: null }))
      fixDay(api, value.id, { version: value.version, action: fixActionOf(draft), ...(draft.reasonCode ? { reasonCode: draft.reasonCode } : {}), reason: reasonOf(draft, reasonWords) })
        .then(took)
        .catch((error: unknown) => patch((entry) => ({ ...entry, busy: false, problem: refused(error) })))
    },
    onAccept: (anomalyId) => setDialog({ kind: 'accept', anomalyId, note: '', busy: false, problem: null }),
    onAcceptNote: (note) => patch((entry) => (entry.kind === 'accept' ? { ...entry, note, problem: null } : entry)),
    onAcceptSave: () => {
      if (dialog?.kind !== 'accept' || dialog.busy) return
      const { anomalyId, note } = dialog
      patch((entry) => ({ ...entry, busy: true, problem: null }))
      acceptAnomaly(api, anomalyId, note.trim())
        .then(took)
        .catch((error: unknown) => patch((entry) => ({ ...entry, busy: false, problem: refused(error) })))
    },
    onReopen: () => setDialog({ kind: 'reopen', reason: '', busy: false, problem: null }),
    onReopenReason: (reason) => patch((entry) => (entry.kind === 'reopen' ? { ...entry, reason, problem: null } : entry)),
    onReopenSave: () => {
      if (!value || dialog?.kind !== 'reopen' || dialog.busy) return
      const { reason } = dialog
      patch((entry) => ({ ...entry, busy: true, problem: null }))
      reopenDay(api, value.id, { version: value.version, reason: reason.trim() })
        .then(took)
        .catch((error: unknown) => patch((entry) => ({ ...entry, busy: false, problem: refused(error) })))
    },
    onCorrect: () => {
      if (!corrections) return
      const first = corrections.figuresNow.absences[0]?.codeId ?? ''
      setDialog({ kind: 'correct', record: corrections, draft: { kind: 'PRESENT', absenceCodeId: first, minutes: String(corrections.figuresNow.presentMinutes), reason: '' }, busy: false, problem: null })
    },
    onCorrectDraft: (change) =>
      patch((entry) => {
        if (entry.kind !== 'correct') return entry
        const draft = { ...entry.draft, ...change }
        // A new figure to correct starts from what stands for it.
        const minutes = change.kind || change.absenceCodeId ? String(figureOf(entry.record.figuresNow, draft.kind, draft.absenceCodeId || null)) : draft.minutes
        return { ...entry, draft: { ...draft, minutes }, problem: null }
      }),
    onCorrectSave: () => {
      if (!value || dialog?.kind !== 'correct' || dialog.busy) return
      const { draft, record } = dialog
      const absenceCodeId = draft.kind === 'ABSENCE' ? draft.absenceCodeId : null
      const minutesBefore = figureOf(record.figuresNow, draft.kind, absenceCodeId)
      patch((entry) => ({ ...entry, busy: true, problem: null }))
      correctDay(api, value.id, { kind: draft.kind, absenceCodeId, minutesBefore, minutesAfter: Number(draft.minutes.trim()), reason: draft.reason.trim() })
        .then((next) => {
          setCorrections(next)
          setDialog(null)
          changed.current(value)
        })
        .catch((error: unknown) => {
          // Someone corrected it first: read what stands now and say so.
          if (isApiError(error) && error.kind === 'conflict') void readCorrections(api, value.id).then((next) => { setCorrections(next); patch((entry) => (entry.kind === 'correct' ? { ...entry, record: next, draft: { ...entry.draft, minutes: String(figureOf(next.figuresNow, entry.draft.kind, entry.draft.kind === 'ABSENCE' ? entry.draft.absenceCodeId : null)) } } : entry)) }).catch(() => undefined)
          patch((entry) => ({ ...entry, busy: false, problem: refused(error) }))
        })
    },
    onCloseDialog: () => setDialog(null),
  }

  return { state: dayId ? { id: dayId, loaded, corrections, busy, problem, dialog } : null, actions }
}
