'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { isStepUpCancelled, liveMatches, useLive, useRecordTab, useStepUp } from '../../_shared/hooks'
import { failedRead, hasIssue, problemKey, qualityCan, ready, reading, refusalLines, type Notice, type Read } from '../../_shared/model'
import { QualityMessages, RecordProblem, RecordSkeleton } from '../../_shared/parts'
import {
  cancelInspection,
  decideInspection,
  getFinalState,
  getInspection,
  getWorkOrderCells,
  listReleases,
  patchInspection,
  putDefects,
  releaseGarments,
  type FinalState,
  type InspectionRead,
  type Release,
} from '../api'
import {
  answer,
  checklistBody,
  checklistRows,
  defectsBody,
  defectsDraftOf,
  planBody,
  planDraftOf,
  RECORD_TABS,
  releaseDraftOf,
  signDraftOf,
  type ChecklistRow,
  type DefectDraft,
  type PlanDraft,
  type RecordDialog,
  type ReleaseDraft,
  type SignDraft,
} from '../model'
import { InspectionRecordView } from './view/InspectionRecordView'

/**
 * The inspection record's container (`/w/<company>/quality/inspections/<id>?tab=checks|decision`, SCR-076): reads the
 * inspection (with the maker check and whether it is the viewer's), the work order's final state (cells and the release
 * gate per cell for the viewer), the work order's releases and its style; saves the checklist per answer (one PATCH at a
 * time with the version read; a failed check asks for its note), the plan and the defects; signs the result and releases
 * garments (both ask for a fresh code on a 403 `stepUp`; a refused release says every open check in words); cancels.
 * Live events re-read; while a dialog holds work a banner says the record changed instead.
 */
export function InspectionRecord({ inspectionId }: { inspectionId: string }) {
  return (
    <QualityMessages>
      <Container inspectionId={inspectionId} />
    </QualityMessages>
  )
}

const DECISION_EVENTS = ['quality.inspection_', 'quality.garments_released', 'quality.release_reversed', 'quality.release_rule_changed'] as const

function Container({ inspectionId }: { inspectionId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const t = useT('quality')
  const locale = useLocale()
  const can = useMemo(() => qualityCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = useRecordTab(RECORD_TABS)
  const [read, setRead] = useState<Read<InspectionRead>>(reading())
  const [checklist, setChecklist] = useState<ChecklistRow[]>([])
  const [saving, setSaving] = useState<Record<string, 'saving' | 'saved' | 'failed'>>({})
  const [final, setFinal] = useState<Read<FinalState>>(reading())
  const [releases, setReleases] = useState<Read<readonly Release[]>>(reading())
  const [style, setStyle] = useState<Read<{ code: string; name: string }> | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [dialogLines, setDialogLines] = useState<readonly string[]>([])
  const [signDraft, setSignDraft] = useState<SignDraft | undefined>(undefined)
  const [releaseDraft, setReleaseDraft] = useState<ReleaseDraft | undefined>(undefined)
  const [planDraft, setPlanDraft] = useState<PlanDraft | undefined>(undefined)
  const [defectsDraft, setDefectsDraft] = useState<DefectDraft[] | undefined>(undefined)
  const [cancelReason, setCancelReason] = useState('')
  const [stale, setStale] = useState<string | null>(null)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const version = useRef<number | null>(null)
  const pending = useRef<ChecklistRow[] | null>(null)
  const savingNow = useRef(false)
  const signKey = useRef<string | null>(null)
  const releaseKey = useRef<string | null>(null)

  const load = useCallback(async () => {
    if (!can.inspectionsView) return
    try {
      const answerRead = await getInspection(api, inspectionId)
      setRead(ready(answerRead))
      setChecklist(checklistRows(answerRead.inspection))
      version.current = answerRead.inspection.version
      setAsOf(new Date().toISOString())
      setStale(null)
      const workOrderId = answerRead.inspection.workOrderId
      getFinalState(api, workOrderId)
        .then((state) => setFinal(ready(state)))
        .catch((error: unknown) => setFinal(failedRead(problemKey(error))))
      listReleases(api, { workOrderId, limit: 200 })
        .then((list) => setReleases(ready(list)))
        .catch((error: unknown) => setReleases(failedRead(problemKey(error))))
      if (can.workOrdersView) {
        getWorkOrderCells(api, workOrderId)
          .then((workOrder) => setStyle(ready({ code: workOrder.style.code, name: workOrder.style.name })))
          .catch(() => setStyle(null))
      }
    } catch (error) {
      setRead(failedRead(problemKey(error)))
    }
  }, [api, can.inspectionsView, can.workOrdersView, inspectionId])

  useEffect(() => {
    void load()
  }, [load])

  const live = useLive(
    (change) => {
      if (!liveMatches(change, DECISION_EVENTS)) return
      if (dialog && dialog.kind !== 'shortcuts') setStale(formatTime(new Date(), { locale }))
      else void load()
    },
    () => void load(),
  )

  // ---- the checklist: one PATCH at a time with the newest version; answers typed meanwhile wait and go next ----
  const flush = useCallback(async () => {
    if (savingNow.current || !pending.current || version.current === null) return
    const rows = pending.current
    pending.current = null
    savingNow.current = true
    const codes = rows.filter((row) => row.answered).map((row) => row.code)
    try {
      const inspection = await patchInspection(api, inspectionId, { version: version.current, checklist: checklistBody(rows) })
      version.current = inspection.version
      setRead((current) => (current.value ? ready({ ...current.value, inspection }) : current))
      setSaving((current) => Object.fromEntries(Object.entries(current).map(([code, state]) => [code, state === 'saving' && codes.includes(code) ? 'saved' : state])))
    } catch (error) {
      setSaving((current) => Object.fromEntries(Object.entries(current).map(([code, state]) => [code, state === 'saving' ? 'failed' : state])))
      setNotice({ key: isApiError(error) && error.kind === 'conflict' ? 'problem.conflict' : problemKey(error), tone: 'warning' })
      if (isApiError(error) && error.kind === 'conflict') void load()
    } finally {
      savingNow.current = false
      if (pending.current) void flush()
    }
  }, [api, inspectionId, load])

  const onAnswer = useCallback(
    (code: string, change: { ok?: boolean | null; note?: string | null }) => {
      setChecklist((current) => {
        const next = answer(current, code, change)
        const row = next.find((entry) => entry.code === code)!
        // A failed check waits for its note (the API refuses a failed check without one).
        if (row.ok === false && !(row.note ?? '').trim()) {
          setSaving((states) => ({ ...states, [code]: 'failed' }))
          setNotice({ key: 'checklist.needNote', tone: 'info' })
          return next
        }
        setSaving((states) => ({ ...states, [code]: 'saving' }))
        pending.current = next
        void flush()
        return next
      })
    },
    [flush],
  )

  // ---- dialogs ----
  const openDialog = (next: RecordDialog | null) => {
    setDialogProblem(null)
    setDialogLines([])
    const inspection = read.value?.inspection
    if (next?.kind === 'sign' && inspection) {
      setSignDraft(signDraftOf({ ...inspection, checklist: checklistBody(checklist) }))
      signKey.current = null
    }
    if (next?.kind === 'release' && final.value) {
      const cell = final.value.cells.find((entry) => entry.workOrderSizeId === next.workOrderSizeId)
      if (cell) setReleaseDraft(releaseDraftOf(cell))
      releaseKey.current = null
    }
    if (next?.kind === 'plan' && inspection) setPlanDraft(planDraftOf(inspection))
    if (next?.kind === 'defects' && inspection) setDefectsDraft(defectsDraftOf(inspection))
    if (next?.kind === 'cancel') setCancelReason('')
    setDialog(next)
    if (next === null && stale) void load()
  }

  const sign = useCallback(async () => {
    const value = read.value
    if (!value || !signDraft || version.current === null) return
    setBusy(true)
    setDialogProblem(null)
    setDialogLines([])
    signKey.current ??= newIdempotencyKey()
    const key = signKey.current
    try {
      const inspection = await guard('stepUp.sentence.sign', () =>
        decideInspection(
          api,
          inspectionId,
          {
            version: version.current!,
            result: signDraft.result,
            checklist: checklistBody(checklist),
            ...(value.statementNeeded ? { notMakerStatement: signDraft.statement } : {}),
            overrideReason: signDraft.overrideReason.trim() || null,
            note: signDraft.note.trim() || null,
          },
          key,
        ),
      )
      signKey.current = null
      version.current = inspection.version
      setDialog(null)
      setNotice({ key: inspection.status === 'PASSED' ? 'sign.donePass' : 'sign.doneFail', tone: inspection.status === 'PASSED' ? 'success' : 'warning' })
      void load()
      router.replace(`${prefix}/quality/inspections/${encodeURIComponent(inspectionId)}?tab=decision`, { scroll: false })
    } catch (error) {
      if (isStepUpCancelled(error)) setDialogProblem('stepUp.cancelled')
      else {
        signKey.current = null
        setDialogProblem(hasIssue(error, 'maker') ? 'sign.problem.maker' : isApiError(error) && (error.kind === 'invalid' || error.kind === 'conflict') ? 'sign.problem.refused' : problemKey(error))
        if (isApiError(error)) setDialogLines(error.issues.map((issue) => issue.message ?? '').filter(Boolean))
      }
    } finally {
      setBusy(false)
    }
  }, [api, checklist, guard, inspectionId, load, prefix, read.value, router, signDraft])

  const release = useCallback(async () => {
    if (!releaseDraft || dialog?.kind !== 'release') return
    const cellId = dialog.workOrderSizeId
    setBusy(true)
    setDialogProblem(null)
    setDialogLines([])
    releaseKey.current ??= newIdempotencyKey()
    const key = releaseKey.current
    try {
      const answerRelease = await guard('stepUp.sentence.release', () =>
        releaseGarments(
          api,
          { inspectionId, workOrderSizeId: cellId, quantity: Number(releaseDraft.quantity), ...(releaseDraft.serialIds.length > 0 ? { serialIds: releaseDraft.serialIds } : {}), note: releaseDraft.note.trim() || null },
          key,
        ),
      )
      releaseKey.current = null
      setDialog(null)
      setNotice({ key: 'release.done', tone: 'success', params: { count: answerRelease.release.quantity, number: answerRelease.release.releaseNumber ?? answerRelease.release.number } })
      void load()
    } catch (error) {
      if (isStepUpCancelled(error)) setDialogProblem('stepUp.cancelled')
      else {
        releaseKey.current = null
        const lines = refusalLines(error, 'checks')
        setDialogProblem(lines.length > 0 ? 'release.problem.gate' : hasIssue(error, 'maker') ? 'release.problem.maker' : problemKey(error))
        setDialogLines(lines.length > 0 ? lines.map((line) => `${t(`gate.${line.code}`)}: ${line.message}${line.fix ? ` → ${line.fix}` : ''}`) : isApiError(error) ? error.issues.map((issue) => issue.message ?? '').filter(Boolean) : [])
        getFinalState(api, read.value?.inspection.workOrderId ?? '')
          .then((state) => setFinal(ready(state)))
          .catch(() => undefined)
      }
    } finally {
      setBusy(false)
    }
  }, [api, dialog, guard, inspectionId, load, read.value, releaseDraft, t])

  const savePlan = useCallback(async () => {
    if (!planDraft || version.current === null) return
    setBusy(true)
    setDialogProblem(null)
    try {
      const inspection = await patchInspection(api, inspectionId, { version: version.current, ...planBody(planDraft) })
      version.current = inspection.version
      setRead((current) => (current.value ? ready({ ...current.value, inspection }) : current))
      setDialog(null)
      setNotice({ key: 'plan.saved', tone: 'success' })
    } catch (error) {
      setDialogProblem(isApiError(error) && error.kind === 'invalid' ? 'plan.problem.refused' : problemKey(error))
      if (isApiError(error) && error.kind === 'conflict') void load()
    } finally {
      setBusy(false)
    }
  }, [api, inspectionId, load, planDraft])

  const saveDefects = useCallback(async () => {
    if (!defectsDraft || version.current === null) return
    setBusy(true)
    setDialogProblem(null)
    try {
      const inspection = await putDefects(api, inspectionId, { version: version.current, defects: defectsBody(defectsDraft) })
      version.current = inspection.version
      setRead((current) => (current.value ? ready({ ...current.value, inspection }) : current))
      setDialog(null)
      setNotice({ key: 'defects.saved', tone: 'success' })
    } catch (error) {
      setDialogProblem(isApiError(error) && error.kind === 'invalid' ? 'defects.problem.refused' : problemKey(error))
      if (isApiError(error) && error.kind === 'conflict') void load()
    } finally {
      setBusy(false)
    }
  }, [api, defectsDraft, inspectionId, load])

  const cancel = useCallback(async () => {
    if (version.current === null) return
    setBusy(true)
    setDialogProblem(null)
    try {
      await cancelInspection(api, inspectionId, { version: version.current, reason: cancelReason.trim() })
      setDialog(null)
      setNotice({ key: 'cancel.done', tone: 'info' })
      void load()
    } catch (error) {
      setDialogProblem(problemKey(error))
    } finally {
      setBusy(false)
    }
  }, [api, cancelReason, inspectionId, load])

  const back = (
    <Link className="fw-q-link" href={`${prefix}/quality/inspections`}>
      {t('record.back')}
    </Link>
  )
  if (!can.inspectionsView) return <RecordProblem problem="problem.forbidden" back={back} />
  if (read.problem) return <RecordProblem problem={read.problem} back={back} onRetry={() => void load()} />
  if (!read.value) return <RecordSkeleton />

  return (
    <InspectionRecordView
      model={{
        prefix,
        me: session.user.id,
        can,
        tab,
        read: read.value,
        checklist,
        saving,
        final,
        releases,
        style,
        asOf,
        live,
        notice,
        dialog,
        busy,
        dialogProblem,
        dialogLines,
        signDraft,
        releaseDraft,
        planDraft,
        defectsDraft,
        cancelReason,
        stale,
      }}
      stepUp={stepUp}
      actions={{
        onDialog: openDialog,
        onAnswer,
        onSignDraft: setSignDraft,
        onSign: () => void sign(),
        onReleaseDraft: setReleaseDraft,
        onRelease: () => void release(),
        onPlanDraft: setPlanDraft,
        onSavePlan: () => void savePlan(),
        onDefectsDraft: setDefectsDraft,
        onSaveDefects: () => void saveDefects(),
        onCancelReason: setCancelReason,
        onCancel: () => void cancel(),
        onReload: () => void load(),
        onRetryFinal: () => void load(),
        onDismissNotice: () => setNotice(null),
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
      }}
    />
  )
}
