'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { isStepUpCancelled, liveMatches, useLive, useRecordTab, useStepUp } from '../../../quality/_shared/hooks'
import { problemKey } from '../../../quality/_shared/model'
import { RecordProblem, RecordSkeleton } from '../../../quality/_shared/parts'
import {
  cancelRepair,
  changeRepair,
  checkRepair,
  getRepair,
  listRepairPhotos,
  makeRepairWorkOrder,
  moveRepair,
  photoAddress,
  previewSourceDdt,
  receiveRepair,
  repairWorkOrderOptions,
  shipRepair,
  uploadRepairPhoto,
  type Repair,
  type RepairPatch,
} from '../api'
import { BLANK_CHECKLIST, checklistBody, checklistProblems, ddtBody, MOVE_OF, refusalOf, repairHref, returnsCan, romeToday, type ChecklistDraft, type Words } from '../model'
import { REPAIR_TABS, type IntakeDraft, type PhotoView, type RepairDialog, type RepairModel } from '../view-model'
import { ReturnsMessages, useWords } from '../view/parts'
import { RepairRecordView } from './view/RepairRecordView'

/**
 * A repair's container (`/w/<company>/sales/returns/repairs/<id>?tab=…`, SCR-112): reads the repair (its steps answered
 * by the API, held in our words) and its photos; runs ONE write at a time with the version read (a stale one reads the
 * repair again and says so). The safety check is an e-signature: the API asks a fresh code after every other check, the
 * DS step-up dialog takes it and the check is sent once more. The way back previews its DDT (Shipping's source DDT) and
 * issues it inside the ship step. Live repair events of this repair read it again, or, while a dialog or an edit is
 * open, say it changed with Reload. `?created=1` says the repair was made.
 */
export function RepairRecord({ repairId }: { repairId: string }) {
  return (
    <ReturnsMessages>
      <Container repairId={repairId} />
    </ReturnsMessages>
  )
}

const WIDE = '(min-width: 1280px)'
const DOCK_KEY = 'fw.returns.dock'

const intakeOf = (repair: Repair): IntakeDraft => ({
  kind: repair.kind,
  problem: repair.problem,
  inboundDdtNumber: repair.inboundDdt?.number ?? '',
  inboundDdtDate: repair.inboundDdt?.date ?? '',
  internalNote: repair.internalNote ?? '',
})

function patchOf(draft: IntakeDraft, repair: Repair): RepairPatch {
  const patch: RepairPatch = {}
  const text = (value: string) => (value.trim() === '' ? null : value.trim())
  if (draft.kind !== repair.kind) patch.kind = draft.kind
  if (draft.problem.trim() !== repair.problem) patch.problem = draft.problem.trim()
  if (text(draft.inboundDdtNumber) !== (repair.inboundDdt?.number ?? null)) patch.inboundDdtNumber = text(draft.inboundDdtNumber)
  if ((draft.inboundDdtDate || null) !== (repair.inboundDdt?.date ?? null)) patch.inboundDdtDate = draft.inboundDdtDate || null
  if (text(draft.internalNote) !== repair.internalNote) patch.internalNote = text(draft.internalNote)
  return patch
}

/** The last signed check as a draft (a person re-checks from what was found), else a blank one. */
function checklistOf(repair: Repair): ChecklistDraft {
  const list = repair.safety.checklist
  if (!list || repair.safety.state === 'OUTDATED') return BLANK_CHECKLIST
  const point = (value: string) => (value === 'PASS' || value === 'FAIL' || value === 'NOT_APPLICABLE' ? value : '')
  return {
    seams: point(list.seams),
    abrasionZones: point(list.abrasionZones),
    closures: point(list.closures),
    protectors: point(list.protectors.result),
    replaced: list.protectors.replaced,
    lot: list.protectors.lot ?? '',
    level: list.protectors.level === '1' || list.protectors.level === '2' ? list.protectors.level : '',
    certificateCovers: list.certificateCovers,
    note: list.note ?? '',
  }
}

function Container({ repairId }: { repairId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const t = useWords()
  const can = useMemo(() => returnsCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = useRecordTab(REPAIR_TABS)
  const today = romeToday()
  const [offline, setOffline] = useState(false)
  useEffect(() => {
    const update = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const [repair, setRepair] = useState<Repair | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [changedAt, setChangedAt] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<RepairModel['receipt']>(null)
  const [edit, setEdit] = useState<RepairModel['edit']>(null)
  const [photos, setPhotos] = useState<PhotoView[]>([])
  const [uploading, setUploading] = useState(false)
  const [checklist, setChecklist] = useState<ChecklistDraft>(BLANK_CHECKLIST)
  const [checkBusy, setCheckBusy] = useState(false)
  const [checkProblem, setCheckProblem] = useState<Words | null>(null)
  const [showCheckProblems, setShowCheckProblems] = useState(false)
  const [dialog, setDialog] = useState<RepairDialog | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<Words | null>(null)
  const [dockOpen, setDockOpen] = useState(false)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const latest = useRef<Repair | null>(null)
  latest.current = repair
  const quiet = useRef(false)
  quiet.current = dialog !== null || edit !== null || checkBusy
  const dialogKey = useRef<string>(newIdempotencyKey())

  const load = useCallback(async () => {
    try {
      const next = await getRepair(api, repairId)
      setRepair(next)
      setProblem(null)
      setAsOf(new Date().toISOString())
      setChangedAt(null)
      return next
    } catch (error) {
      setProblem(problemKey(error))
      return null
    }
  }, [api, repairId])

  const loadPhotos = useCallback(async () => {
    if (!can.filesRead) return
    const files = await listRepairPhotos(api, repairId).catch(() => [])
    setPhotos(files.map((file) => ({ id: file.id, name: file.originalName, src: null })))
    for (const file of files) {
      photoAddress(api, file.id)
        .then((src) => setPhotos((current) => current.map((entry) => (entry.id === file.id ? { ...entry, src } : entry))))
        .catch(() => undefined)
    }
  }, [api, can.filesRead, repairId])

  useEffect(() => {
    void load()
    void loadPhotos()
  }, [load, loadPhotos])
  // The checklist starts from the last signed one when the record (re)arrives with a new check.
  const checkedAt = repair?.safety.checkedAt ?? null
  useEffect(() => {
    if (repair) setChecklist(checklistOf(repair))
  }, [repair?.id, checkedAt, repair?.repairedAt])
  useEffect(() => {
    try {
      setDockOpen(window.localStorage.getItem(DOCK_KEY) === '1' && window.matchMedia(WIDE).matches)
    } catch {
      setDockOpen(false)
    }
  }, [])

  const live = useLive(
    (change) => {
      if (!liveMatches(change, ['repair.', 'workorder.']) ) return
      if (change.type.startsWith('repair.') && change.fields.repairId !== repairId) return
      if (change.type.startsWith('workorder.') && change.fields.workOrderId !== latest.current?.workOrder?.id) return
      if (quiet.current) setChangedAt(new Date().toISOString())
      else void load()
    },
    () => void load(),
  )

  const created = params?.get('created') === '1'
  useEffect(() => {
    if (!repair || !created) return
    setReceipt({ tone: 'success', words: { key: 'done.repairCreated', params: { number: repair.number } } })
    router.replace(pathname, { scroll: false })
  }, [repair?.id, created])

  // The work order's options when its dialog opens (Production's routing steps).
  const wantOptions = dialog?.kind === 'workOrder' && dialog.options === null && dialog.problem === null
  useEffect(() => {
    if (!wantOptions || !repair) return
    repairWorkOrderOptions(api, repair.id)
      .then((options) => setDialog((open) => (open?.kind === 'workOrder' ? { ...open, options, seqs: options.steps.filter((step) => step.available).length === 1 ? options.steps.filter((step) => step.available).map((step) => step.seq) : open.seqs } : open)))
      .catch((error) => setDialog((open) => (open?.kind === 'workOrder' ? { ...open, problem: `quality:${problemKey(error)}` } : open)))
  }, [api, wantOptions, repair?.id])

  const openDialog = (next: RepairDialog | null) => {
    if (next && (dialog === null || dialog.kind !== next.kind)) {
      dialogKey.current = newIdempotencyKey()
      setDialogProblem(null)
    }
    setDialog(next)
  }

  const previewShip = async () => {
    const current = latest.current
    if (!current || dialog?.kind !== 'ship' || dialog.useLive) return
    setDialog({ ...dialog, previewing: true })
    try {
      const preview = await previewSourceDdt(api, 'RepairOrder', current, ddtBody(dialog.draft, 'REPAIR'))
      setDialog((open) => (open?.kind === 'ship' ? { ...open, preview, previewing: false } : open))
    } catch (error) {
      setDialog((open) => (open?.kind === 'ship' ? { ...open, previewing: false } : open))
      setDialogProblem(refusalOf(error))
    }
  }

  const done = async (words: Words, href?: string) => {
    setReceipt({ tone: 'success', words, ...(href ? { href } : {}) })
    await load()
  }

  const submitDialog = async () => {
    const current = latest.current
    if (!current || !dialog || dialogBusy) return
    setDialogBusy(true)
    setDialogProblem(null)
    try {
      switch (dialog.kind) {
        case 'receive':
          await receiveRepair(api, current, { inboundDdtNumber: dialog.ddtNumber.trim() || null, inboundDdtDate: dialog.ddtDate || null, note: dialog.note.trim() || null }, dialogKey.current)
          setDialog(null)
          await done({ key: 'done.repairReceived', params: { number: current.number } })
          break
        case 'move': {
          const next = await moveRepair(api, current, MOVE_OF[dialog.action], dialog.note.trim() || null, dialogKey.current)
          setDialog(null)
          setRepair(next)
          setReceipt({ tone: 'success', words: { key: 'done.moved', params: { stage: `stagePill.${next.stage}` } } })
          break
        }
        case 'workOrder': {
          const order = await makeRepairWorkOrder(api, current, [...dialog.seqs], dialogKey.current)
          setDialog(null)
          await done({ key: 'done.workOrder', params: { number: order.number } }, `${prefix}/production/work-orders/${encodeURIComponent(order.id)}`)
          break
        }
        case 'ship': {
          const answer = await shipRepair(api, current, { note: dialog.note.trim() || null, ...(dialog.useLive ? {} : { ddt: ddtBody(dialog.draft, 'REPAIR') }) }, dialogKey.current)
          setDialog(null)
          setRepair(answer.repair)
          setReceipt({ tone: answer.warnings.length > 0 ? 'warning' : 'success', words: { key: answer.warnings.length > 0 ? 'done.shippedWarning' : 'done.shipped', params: { number: answer.ddt.number } } })
          break
        }
        case 'cancel': {
          const answer = await cancelRepair(api, current, dialog.reason.trim())
          setDialog(null)
          setRepair(answer.repair)
          setReceipt({ tone: answer.warnings.length > 0 ? 'warning' : 'success', words: { key: answer.warnings.length > 0 ? 'done.repairCancelledHere' : 'done.repairCancelled', params: { number: current.number } } })
          break
        }
      }
    } catch (error) {
      setDialogProblem(refusalOf(error))
      void load()
    } finally {
      setDialogBusy(false)
    }
  }

  const sign = async () => {
    const current = latest.current
    if (!current || checkBusy) return
    if (checklistProblems(checklist).length > 0) {
      setShowCheckProblems(true)
      return
    }
    setCheckBusy(true)
    setCheckProblem(null)
    const key = newIdempotencyKey()
    try {
      // The API asks the fresh code after every other check: the dialog opens only when the check itself may be signed.
      const answer = await guard('stepUp.sentence.sign', () => checkRepair(api, latest.current ?? current, checklistBody(checklist), key))
      setRepair(answer.repair)
      setShowCheckProblems(false)
      setReceipt({ tone: answer.result === 'PASS' ? 'success' : 'warning', words: { key: answer.result === 'PASS' ? 'done.checkPassed' : 'done.checkFailed', params: { number: current.number } } })
    } catch (error) {
      if (isStepUpCancelled(error)) setCheckProblem({ key: 'quality:stepUp.cancelled' })
      else setCheckProblem(refusalOf(error))
      if (!isStepUpCancelled(error) && isApiError(error)) void load()
    } finally {
      setCheckBusy(false)
    }
  }

  const saveEdit = async () => {
    const current = latest.current
    if (!current || !edit || edit.busy) return
    const patch = patchOf(edit.draft, current)
    if (Object.keys(patch).length === 0) return setEdit(null)
    if (!edit.draft.problem.trim()) return setEdit({ ...edit, problem: { key: 'newRepair.problem.problem' } })
    setEdit({ ...edit, busy: true, problem: null })
    try {
      const answer = await changeRepair(api, current, patch)
      setRepair(answer.repair)
      setEdit(null)
      setReceipt({ tone: 'success', words: { key: 'done.saved' } })
    } catch (error) {
      setEdit((open) => (open ? { ...open, busy: false, problem: refusalOf(error) } : open))
      void load()
    }
  }

  const addPhotos = async (files: readonly File[]) => {
    const current = latest.current
    if (!current || files.length === 0) return
    setUploading(true)
    try {
      for (const file of files) await uploadRepairPhoto(api, current, file)
      setReceipt({ tone: 'success', words: { key: 'done.photos', params: { count: files.length } } })
    } catch (error) {
      setReceipt({ tone: 'danger', words: refusalOf(error) })
    } finally {
      setUploading(false)
      void loadPhotos()
    }
  }

  if (problem && !repair) return <RecordProblem problem={problem} back={<a className="fw-q-link" href={`${prefix}/sales/returns`}>{t('record.back')}</a>} onRetry={() => void load()} />
  if (!repair) return <RecordSkeleton />

  const panels = can.threadsRead ? <RecordPanels record={{ type: 'RepairOrder', id: repair.id, companyId: repair.companyId, siteId: repair.site.id }} title={repair.number} party={{ id: repair.party.id, name: repair.party.legalName, emails: [] }} /> : undefined

  const model: RepairModel = {
    prefix,
    can,
    me: session.user.id,
    tab,
    repair,
    asOf,
    live,
    offline,
    today,
    receipt,
    changedAt,
    edit,
    photos,
    uploading,
    checklist,
    checkProblem,
    checkBusy,
    showCheckProblems,
    stepUp,
    dialog,
    dialogBusy,
    dialogProblem,
    dockOpen,
  }

  return (
    <RepairRecordView
      model={model}
      panels={panels}
      actions={{
        onReload: () => void load(),
        onDismissReceipt: () => setReceipt(null),
        onDock: () =>
          setDockOpen((open) => {
            const next = !open
            if (next && !window.matchMedia(WIDE).matches) {
              router.push(repairHref(prefix, repair.id, '?tab=activity'))
              return open
            }
            try {
              window.localStorage.setItem(DOCK_KEY, next ? '1' : '0')
            } catch {
              // Not kept on this device; the dock still toggles.
            }
            return next
          }),
        onEdit: () => setEdit({ draft: intakeOf(repair), busy: false, problem: null }),
        onEditDraft: (patch) => setEdit((open) => (open ? { ...open, draft: { ...open.draft, ...patch } } : open)),
        onEditSave: () => void saveEdit(),
        onEditCancel: () => setEdit(null),
        onPhotos: (files) => void addPhotos(files),
        onChecklist: (patch) => setChecklist((current) => ({ ...current, ...patch })),
        onSign: () => void sign(),
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
        onDialog: openDialog,
        onDialogSubmit: () => void submitDialog(),
        onShipPreview: () => void previewShip(),
        onCopy: (text) => {
          void navigator.clipboard?.writeText(text).then(
            () => setReceipt({ tone: 'success', words: { key: 'done.copied' } }),
            () => undefined,
          )
        },
      }}
    />
  )
}
