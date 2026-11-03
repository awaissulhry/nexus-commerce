'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { moveJob, photoAddress, plantTechnicians, signSafe, updateJob, type JobChange, type JobMove } from '../../_shared/api'
import { isStepUpCancelled, useLive, useStepUp } from '../../_shared/hooks'
import { assigneeFields, assigneeValue, instantOf, localOf, plantCan, readProblem, TIME_ZONE } from '../../_shared/model'
import { PlantMessages, useWords, type Loaded, type Notice } from '../../_shared/parts'
import { confirmJobWorks, getDeepJob, handBackJob, uploadMedia, type DeepJobRecord, type MediaCategory } from '../../requests/depth/api'
import { audioRefusal, closeBody, closeDraftOf, depthProblemOf, mediaName, mediaViews, type CloseDraft } from '../../requests/depth/model'
import { JOB_TABS, type Capture, type JobEditDraft, type JobRecordDialog, type JobRecordModel, type JobTab } from '../view-model'
import { JobRecordView } from './view/JobRecordView'

/**
 * `/w/<company>/plant/jobs/<id>` (SCR-149 record; `?tab=problem|photos|handback|activity`): the job read once and again
 * on its live changes (the job, its machine, its requests); the moves (plan, start, wait, reopen, close, cancel with its
 * reason), each one command with the version read; the side panel's explicit edit. B-W2b-140: the one-screen close
 * (the tab and the Hand back dialog), Sign safe from the Unsafe lock panel (a fresh code), the line lead's confirmation,
 * photos before / after and voice notes (the plant files routes), each address read with the files right.
 */
export function JobRecord({ jobId }: { jobId: string }) {
  return (
    <PlantMessages>
      <JobRecordContainer jobId={jobId} />
    </PlantMessages>
  )
}

function JobRecordContainer({ jobId }: { jobId: string }) {
  const t = useWords()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => plantCan(session.permissions), [session.permissions])
  const asked = params?.get('tab') ?? ''
  const tab: JobTab = (JOB_TABS as readonly string[]).includes(asked) ? (asked as JobTab) : 'problem'

  const [loaded, setLoaded] = useState<Loaded<DeepJobRecord>>({ status: 'loading' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [media, setMedia] = useState<JobRecordModel['media']>([])
  const mediaRef = useRef(media)
  mediaRef.current = media
  const addressRun = useRef(0)
  const [handBack, setHandBack] = useState<CloseDraft>(closeDraftOf(null))
  const drafted = useRef(false)

  const load = useCallback(async () => {
    try {
      const value = await getDeepJob(api, jobId)
      setLoaded({ status: 'ready', value })
      setAsOf(new Date().toISOString())
      const files = [...value.files, ...value.requestFiles]
      setMedia((current) => mediaViews(files, current))
      // The close starts with Running chosen unless the lock holds it (H1); a draft already touched is kept.
      if (!drafted.current) setHandBack(closeDraftOf(value.close))
      else if (value.close.runningHeld) setHandBack((current) => (current.after === 'RUNNING' ? { ...current, after: null } : current))
      // The addresses one after another, only those not read yet, one reading at a time (a newer read takes over):
      // parallel reads made the database answer "busy" (503).
      if (can.readFiles) {
        const run = ++addressRun.current
        const known = new Set(mediaRef.current.filter((entry) => entry.src).map((entry) => entry.id))
        for (const file of files.filter((entry) => !known.has(entry.id))) {
          if (run !== addressRun.current) break
          try {
            const src = await photoAddress(api, file.id)
            setMedia((current) => current.map((entry) => (entry.id === file.id ? { ...entry, src } : entry)))
          } catch {
            // Said on screen: "couldn't be shown".
          }
        }
      }
    } catch (error) {
      setLoaded(isApiError(error) && error.kind === 'not_found' ? { status: 'notFound' } : isApiError(error) && error.kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) })
    }
  }, [api, jobId, can.readFiles])
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
      const machineId = value.job.machine.id
      // The job, its machine, and its requests (design live "request.merged → Problem tab"; a lock, a sign-safe).
      if (change.fields.jobId === value.job.id || (change.fields.machineId === machineId && (change.type === 'machine.status_changed' || change.type.startsWith('maintenance_request.')))) void load()
    },
    () => void load(),
    can.view,
  )

  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<JobRecordDialog | null>(null)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)

  const refused = useCallback(
    (error: unknown, number: string, key = 'done.moveRefused') => {
      const words = depthProblemOf(error)
      setNotice({ tone: 'danger', words: { key, params: { number } }, detail: words })
      setDialog((current) => (current ? { ...current, busy: false, problem: words } : current))
    },
    [],
  )

  const move = useCallback(
    async (kind: JobMove, body: Record<string, unknown> = {}): Promise<boolean> => {
      if (!value || busy) return false
      setBusy(true)
      setNotice(null)
      try {
        const answer = await moveJob(api, value.job.id, kind, { version: value.job.version, ...body } as never)
        setNotice({ tone: 'success', words: { key: `done.move.${kind}`, params: { number: answer.job.number } } })
        setDialog(null)
        void load()
        return true
      } catch (error) {
        refused(error, value.job.number)
        return false
      } finally {
        setBusy(false)
      }
    },
    [api, value, busy, load, refused],
  )

  /** The one-screen close (the tab or the Hand back dialog). */
  const sendHandBack = useCallback(async () => {
    if (!value || busy) return
    setBusy(true)
    setNotice(null)
    setDialog((current) => (current?.kind === 'handBack' ? { ...current, busy: true, problem: null } : current))
    try {
      const answer = await handBackJob(api, value.job.id, closeBody(handBack, value.job.version))
      setNotice({ tone: 'success', words: { key: 'done.move.handBack', params: { number: answer.job.number } } })
      setDialog(null)
      drafted.current = false
      void load()
    } catch (error) {
      refused(error, value.job.number)
    } finally {
      setBusy(false)
    }
  }, [api, value, busy, handBack, load, refused])

  /** The line lead confirms the machine works (office: plant.requests.triage). */
  const confirmLead = useCallback(async () => {
    if (!value || busy) return
    setBusy(true)
    setNotice(null)
    try {
      const answer = await confirmJobWorks(api, value.job.id, value.job.version)
      setNotice({ tone: 'success', words: { key: 'done.leadConfirmed', params: { number: answer.job.number } } })
      void load()
    } catch (error) {
      refused(error, value.job.number, 'done.leadRefused')
    } finally {
      setBusy(false)
    }
  }, [api, value, busy, load, refused])

  /** Sign safe from the Unsafe lock panel: the request that locks, a fresh code asked after every other check (H1). */
  const signKey = useRef<string | null>(null)
  const sendSignSafe = useCallback(async () => {
    if (!value || dialog?.kind !== 'signSafe' || dialog.busy || !value.lock) return
    const lock = value.lock
    const draft = dialog.draft
    setDialog({ ...dialog, busy: true, problem: null })
    signKey.current = signKey.current ?? newIdempotencyKey()
    const key = signKey.current
    try {
      const answer = await guard('stepUp.sentence.signSafe', () => signSafe(api, lock.request.id, { version: lock.request.version, note: draft.note.trim(), ...(draft.machineAfter ? { machineAfter: draft.machineAfter } : {}) }, key))
      signKey.current = null
      setDialog(null)
      setNotice({ tone: 'success', words: { key: 'done.signedSafe', params: { machine: answer.machine.assetNumber, status: t(`machineStatus.${answer.machine.status}`) } } })
      void load()
    } catch (error) {
      if (isStepUpCancelled(error)) {
        setDialog((current) => (current ? { ...current, busy: false } : current))
        return
      }
      signKey.current = null
      setDialog((current) => (current ? { ...current, busy: false, problem: depthProblemOf(error) } : current))
    }
  }, [api, value, dialog, guard, load, t])

  // ---- photos and voice notes ---------------------------------------------------------------------------------------------
  const [capture, setCapture] = useState<Capture | null>(null)
  const retry = useRef<(() => Promise<void>) | null>(null)
  const send = useCallback(
    async (kind: 'PHOTO' | 'AUDIO', blob: Blob, category: MediaCategory | null) => {
      if (!value) return
      const index = value.files.filter((file) => file.kind === kind && file.category === category).length + 1
      const name = mediaName(value.job.number, kind, category, index, blob.type || (kind === 'PHOTO' ? 'image/jpeg' : 'audio/webm'))
      const attempt = async () => {
        setCapture({ state: 'sending', kind })
        try {
          await uploadMedia(api, { type: 'job', id: value.job.id, category }, kind, blob, name)
          setCapture(null)
          retry.current = null
          setNotice({ tone: 'success', words: { key: kind === 'AUDIO' ? 'done.voiceAdded' : 'done.photoAdded', params: { number: value.job.number } } })
          void load()
        } catch (error) {
          retry.current = attempt
          setCapture({ state: 'failed', kind, words: depthProblemOf(error) })
        }
      }
      await attempt()
    },
    [api, value, load],
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
      setEdit(null)
      setNotice({ tone: 'success', words: { key: 'done.saved', params: { number: saved.number } } })
      void load()
    } catch (error) {
      setNotice({ tone: 'danger', words: { key: 'cell.refused', params: { number: job.number } }, detail: depthProblemOf(error) })
    } finally {
      setEditBusy(false)
    }
  }, [api, value, edit, editBusy, load])

  const [lightbox, setLightbox] = useState<number | null>(null)

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
    media,
    lightbox,
    capture,
    stepUp,
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
        onHandBackDraft: (patch) => {
          drafted.current = true
          setHandBack((current) => ({ ...current, ...patch }))
        },
        onHandBack: () => void sendHandBack(),
        onOpenHandBack: () => setDialog({ kind: 'handBack', busy: false, problem: null }),
        onConfirmLead: () => void confirmLead(),
        onSignSafe: () => setDialog({ kind: 'signSafe', draft: { note: '', machineAfter: null }, busy: false, problem: null }),
        onSignSafeDraft: (patch) => setDialog((current) => (current?.kind === 'signSafe' ? { ...current, draft: { ...current.draft, ...patch } } : current)),
        onSubmitStepUp: (code) => void submitStepUp(code),
        onCancelStepUp: cancelStepUp,
        onCancelJob: () => setDialog({ kind: 'cancel', reason: '', busy: false, problem: null }),
        onDialogDraft: (reason) => setDialog((current) => (current?.kind === 'cancel' ? { ...current, reason } : current)),
        onDialogClose: () => setDialog(null),
        onDialogSubmit: () => {
          if (!dialog) return
          if (dialog.kind === 'signSafe') {
            void sendSignSafe()
            return
          }
          if (dialog.kind !== 'cancel') return
          setDialog({ ...dialog, busy: true, problem: null })
          void move('cancel', { reason: dialog.reason.trim() })
        },
        onPhoto: (index) => setLightbox(index !== null && index < 0 ? null : index),
        onCamera: (category) => setCapture(category ? { state: 'camera', category } : null),
        onPhotoTaken: (photo: CapturedPhoto) => {
          const category = capture?.state === 'camera' ? capture.category : null
          // The marked picture when there are marks (arrows, circles): what the next person needs to see.
          void send('PHOTO', photo.marked ?? photo.photo, category)
        },
        onVoicePicked: (file) => {
          const refusal = audioRefusal(file)
          if (refusal) {
            setCapture({ state: 'failed', kind: 'AUDIO', words: { key: refusal } })
            retry.current = null
            return
          }
          void send('AUDIO', file, null)
        },
        onRetryUpload: () => {
          if (retry.current) void retry.current()
          else setCapture(null)
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
