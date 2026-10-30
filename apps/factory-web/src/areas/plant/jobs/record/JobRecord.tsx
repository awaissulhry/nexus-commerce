'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { getJob, moveJob, plantTechnicians, updateJob, type JobChange, type JobMove, type JobRecord as JobRecordValue } from '../../_shared/api'
import { useLive } from '../../_shared/hooks'
import { assigneeFields, assigneeValue, instantOf, localOf, plantCan, problemOf, readProblem, TIME_ZONE } from '../../_shared/model'
import type { Loaded, Notice } from '../../_shared/parts'
import { JOB_TABS, type HandBackDraft, type JobEditDraft, type JobRecordDialog, type JobRecordModel, type JobTab } from '../view-model'
import { JobRecordView } from './view/JobRecordView'

/**
 * `/w/<company>/plant/jobs/<id>` (SCR-149 record; `?tab=problem|handback|activity`): the job read once and again on its
 * live changes (the job, its machine); the moves (plan, start, wait, hand back, reopen, close, cancel with its reason),
 * each one command with the version read; the side panel's explicit edit (type, priority, technician, due, problem).
 */
export function JobRecord({ jobId }: { jobId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => plantCan(session.permissions), [session.permissions])
  const asked = params?.get('tab') ?? ''
  const tab: JobTab = (JOB_TABS as readonly string[]).includes(asked) ? (asked as JobTab) : 'problem'

  const [loaded, setLoaded] = useState<Loaded<JobRecordValue>>({ status: 'loading' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      const value = await getJob(api, jobId)
      setLoaded({ status: 'ready', value })
      setAsOf(new Date().toISOString())
    } catch (error) {
      setLoaded(isApiError(error) && error.kind === 'not_found' ? { status: 'notFound' } : isApiError(error) && error.kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) })
    }
  }, [api, jobId])
  useEffect(() => {
    if (!can.view) {
      setLoaded({ status: 'forbidden' })
      return
    }
    void load()
  }, [load, can.view])

  const value = loaded.status === 'ready' ? loaded.value : null
  const live = useLive(
    (change) => {
      if (!value) return
      if (change.fields.jobId === value.job.id || (change.type === 'machine.status_changed' && change.fields.machineId === value.job.machine.id)) void load()
    },
    () => void load(),
    can.view,
  )

  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [handBack, setHandBack] = useState<HandBackDraft>({ workDone: '', machineAfter: null })
  const [dialog, setDialog] = useState<JobRecordDialog | null>(null)

  const move = useCallback(
    async (kind: JobMove, body: Record<string, unknown> = {}): Promise<boolean> => {
      if (!value || busy) return false
      setBusy(true)
      setNotice(null)
      try {
        const answer = await moveJob(api, value.job.id, kind, { version: value.job.version, ...body } as never)
        setLoaded({ status: 'ready', value: { ...value, job: answer.job, card: { ...value.card, machine: answer.machine } } })
        setNotice({ tone: 'success', words: { key: `done.move.${kind}`, params: { number: answer.job.number } } })
        setDialog(null)
        void load()
        return true
      } catch (error) {
        setNotice({ tone: 'danger', words: { key: 'done.moveRefused', params: { number: value.job.number } }, detail: problemOf(error) })
        setDialog((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
        return false
      } finally {
        setBusy(false)
      }
    },
    [api, value, busy, load],
  )

  // ---- the side panel's edit --------------------------------------------------------------------------------------------------
  const [edit, setEdit] = useState<JobEditDraft | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [technicians, setTechnicians] = useState<JobRecordModel['technicians']>(null)
  const startEdit = useCallback(() => {
    if (!value) return
    const job = value.job
    setEdit({ type: job.type, problem: job.problem, priority: job.priority, assignee: assigneeValue(job), due: localOf(job.dueAt, TIME_ZONE) })
    if (!technicians && can.manageJobs)
      plantTechnicians(api, job.siteId)
        .then((answer) => setTechnicians({ ...answer, problem: null }))
        .catch((error: unknown) => setTechnicians({ technicians: [], floorListed: false, problem: isApiError(error) && error.kind === 'forbidden' ? 'field.assigneeNoRight' : readProblem(error) }))
  }, [api, value, technicians, can.manageJobs])

  const applyEdit = useCallback(async () => {
    if (!value || !edit || editBusy) return
    const job = value.job
    const change: JobChange = { version: job.version }
    if (edit.type !== job.type) change.type = edit.type
    if (edit.problem.trim() !== job.problem) change.problem = edit.problem.trim()
    if (edit.priority !== job.priority) change.priority = edit.priority
    const due = instantOf(edit.due, TIME_ZONE)
    if ((due ? new Date(due).getTime() : null) !== (job.dueAt ? new Date(job.dueAt).getTime() : null)) change.dueAt = due
    // An unnamed floor technician (no id in the view) is kept unless another one is picked.
    if (edit.assignee !== assigneeValue(job) && !(edit.assignee === '' && job.assignee?.kind === 'WORKER' && !job.assignee.id)) Object.assign(change, assigneeFields(edit.assignee))
    if (Object.keys(change).length === 1) {
      setEdit(null)
      return
    }
    setEditBusy(true)
    try {
      const saved = await updateJob(api, job.id, change)
      setLoaded({ status: 'ready', value: { ...value, job: saved } })
      setEdit(null)
      setNotice({ tone: 'success', words: { key: 'done.saved', params: { number: saved.number } } })
    } catch (error) {
      setNotice({ tone: 'danger', words: { key: 'cell.refused', params: { number: job.number } }, detail: problemOf(error) })
    } finally {
      setEditBusy(false)
    }
  }, [api, value, edit, editBusy])

  const model: JobRecordModel = {
    prefix,
    can,
    tab,
    loaded,
    timeZone: TIME_ZONE,
    now: new Date().toISOString(),
    live,
    asOf,
    technicians,
    edit,
    editBusy,
    handBack,
    busy,
    dialog,
    notice,
  }

  const panels = value && tab === 'activity' ? <RecordPanels record={{ type: 'MaintenanceJob', id: value.job.id, companyId: value.job.companyId, siteId: value.job.siteId }} title={`${value.job.number} · ${value.job.machine.assetNumber}`} /> : null

  return (
    <JobRecordView
      model={model}
      panels={panels}
      actions={{
        onRetry: () => void load(),
        onMove: (kind) => void move(kind),
        onEdit: startEdit,
        onEditDraft: (patch) => setEdit((current) => (current ? { ...current, ...patch } : current)),
        onEditCancel: () => setEdit(null),
        onEditApply: () => void applyEdit(),
        onHandBackDraft: (patch) => setHandBack((current) => ({ ...current, ...patch })),
        onHandBack: () => {
          if (!handBack.machineAfter) return
          void move('handBack', { workDone: handBack.workDone.trim(), machineAfter: handBack.machineAfter }).then((done) => done && setHandBack({ workDone: '', machineAfter: null }))
        },
        onCancelJob: () => setDialog({ kind: 'cancel', reason: '', busy: false, problem: null }),
        onDialogDraft: (reason) => setDialog((current) => (current ? { ...current, reason } : current)),
        onDialogClose: () => setDialog(null),
        onDialogSubmit: () => {
          if (!dialog) return
          setDialog({ ...dialog, busy: true, problem: null })
          void move('cancel', { reason: dialog.reason.trim() })
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
