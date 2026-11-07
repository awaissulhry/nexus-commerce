'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { businessDate } from '@nexus/factory-domain/core/time'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { findSuppliers, getMachine, listClasses, plantPlaces, retireMachine, updateMachine, type MachineClass, type MachineFields, type MachineRecord as MachineRecordValue, type PlantSite, type SupplierChoice } from '../../_shared/api'
import { isStepUpCancelled, useLive, useStepUp } from '../../_shared/hooks'
import { changeStatus, documentBytes, readDepth, readDocuments, readHistory, readTagJobs, removeDocument, uploadDocument, type DocumentGroup, type DocumentsAnswer, type HistoryAnswer, type MachineDepth, type MachineDocument, type TagJob } from '../depth/api'
import { depthProblemOf, groupHeld, releases, weekStart } from '../depth/model'
import { tagMachineOf, useTags } from '../depth/use-tags'
import type { DocumentsState } from '../depth/view/DocumentsTab'
import type { StatusDialogState } from '../depth/view/StatusDialog'
import { costMinorOf, costTextOf, fieldOf, plantCan, problemOf, readProblem, TIME_ZONE, yearOf } from '../../_shared/model'
import type { Loaded, Notice } from '../../_shared/parts'
import { MACHINE_TABS, type MachineDraft, type MachineRecordModel, type MachineTab, type RecordDepth } from '../view-model'
import { MachineRecordView } from './view/MachineRecordView'

/**
 * `/w/<company>/plant/machines/<id>` (SCR-150 record; `?tab=overview|history`): the machine read once and again on its live
 * changes (its status, its requests and jobs); the explicit edit of its facts (only what changed is sent, with the version
 * read); Retire with its reason.
 */
export function MachineRecord({ machineId }: { machineId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => plantCan(session.permissions), [session.permissions])
  const asked = params?.get('tab') ?? ''
  const tab: MachineTab = (MACHINE_TABS as readonly string[]).includes(asked) ? (asked as MachineTab) : 'overview'

  const [loaded, setLoaded] = useState<Loaded<MachineRecordValue>>({ status: 'loading' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      const value = await getMachine(api, machineId)
      setLoaded({ status: 'ready', value })
      setAsOf(new Date().toISOString())
    } catch (error) {
      setLoaded(isApiError(error) && error.kind === 'not_found' ? { status: 'notFound' } : isApiError(error) && error.kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) })
    }
  }, [api, machineId])
  useEffect(() => {
    if (!can.view) {
      setLoaded({ status: 'forbidden' })
      return
    }
    void load()
  }, [load, can.view])

  const [sites, setSites] = useState<PlantSite[]>([])
  const [classes, setClasses] = useState<MachineClass[]>([])
  useEffect(() => {
    if (!can.view) return
    plantPlaces(api)
      .then(setSites)
      .catch(() => setSites([]))
    listClasses(api)
      .then((found) => setClasses(found.filter((entry) => entry.active)))
      .catch(() => setClasses([]))
  }, [api, can.view])

  const value = loaded.status === 'ready' ? loaded.value : null

  // ---- B-W2b-136: machines in depth ---------------------------------------------------------------------------------------
  const router = useRouter()
  const canPrint = session.permissions.includes('print.labels')
  const [today, setToday] = useState(() => businessDate(new Date()))
  const [facts, setFacts] = useState<MachineDepth | null>(null)
  const readFacts = useCallback(() => {
    readDepth(api, null, [machineId])
      .then((answer) => {
        setFacts(answer.machines[0] ?? null)
        setToday(answer.today)
      })
      .catch(() => setFacts(null))
  }, [api, machineId])
  const [documents, setDocuments] = useState<Loaded<DocumentsAnswer>>({ status: 'loading' })
  const readDocs = useCallback(() => {
    readDocuments(api, machineId)
      .then((value) => setDocuments({ status: 'ready', value }))
      .catch((error: unknown) => setDocuments(isApiError(error) && error.kind === 'not_found' ? { status: 'notFound' } : isApiError(error) && error.kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) }))
  }, [api, machineId])
  const [week, setWeek] = useState(() => weekStart(businessDate(new Date())))
  const [history, setHistory] = useState<Loaded<HistoryAnswer>>({ status: 'loading' })
  const historyTurn = useRef(0)
  const readWeek = useCallback(() => {
    const turn = ++historyTurn.current
    readHistory(api, machineId, week, 7)
      .then((value) => turn === historyTurn.current && setHistory({ status: 'ready', value }))
      .catch((error: unknown) => turn === historyTurn.current && setHistory({ status: 'error', problem: readProblem(error) }))
  }, [api, machineId, week])
  const [tagJob, setTagJob] = useState<Loaded<TagJob | null>>({ status: 'loading' })
  const readTag = useCallback(() => {
    readTagJobs(api, [machineId])
      .then((jobs) => setTagJob({ status: 'ready', value: jobs[0] ?? null }))
      .catch((error: unknown) => setTagJob({ status: 'error', problem: readProblem(error) }))
  }, [api, machineId])
  useEffect(() => {
    if (!can.view) return
    readFacts()
    readDocs()
    readTag()
  }, [can.view, readFacts, readDocs, readTag])
  useEffect(() => {
    if (!can.view) return
    setHistory({ status: 'loading' })
    readWeek()
  }, [can.view, readWeek])

  const live = useLive(
    (change) => {
      if (!value || change.fields.machineId !== value.card.machine.id) return
      void load()
      readFacts()
      readWeek()
    },
    () => {
      void load()
      readFacts()
      readDocs()
      readWeek()
      readTag()
    },
    can.view,
  )

  // Documents & CE
  const [upload, setUpload] = useState<DocumentsState['upload']>({ group: 'MACHINE_CE', onTablets: true, busy: false, problem: null, done: null })
  const [viewer, setViewer] = useState<DocumentsState['viewer']>(null)
  const [removing, setRemoving] = useState<DocumentsState['remove']>(null)
  const onFiles = useCallback(
    async (files: File[]) => {
      const file = files[0]
      if (!file || upload.busy) return
      const held = groupHeld(upload.group, file.type || 'application/pdf')
      if (held) {
        setUpload((current) => ({ ...current, problem: { key: `depth:${held}` }, done: null }))
        return
      }
      setUpload((current) => ({ ...current, busy: true, problem: null, done: null }))
      try {
        await uploadDocument(api, machineId, file, { group: upload.group, onTablets: upload.onTablets })
        setUpload((current) => ({ ...current, busy: false, done: file.name }))
        readDocs()
        readFacts()
      } catch (error) {
        setUpload((current) => ({ ...current, busy: false, problem: depthProblemOf(error) }))
      }
    },
    [api, machineId, upload, readDocs, readFacts],
  )
  const view = useCallback(
    async (document: MachineDocument) => {
      setViewer({ document, bytes: null, url: null, problem: null })
      try {
        const read = await documentBytes(api, machineId, document.id)
        setViewer((current) => (current?.document.id === document.id ? { ...current, bytes: read.bytes } : current))
      } catch (error) {
        setViewer((current) => (current?.document.id === document.id ? { ...current, problem: depthProblemOf(error) } : current))
      }
    },
    [api, machineId],
  )
  const download = useCallback(
    async (document: MachineDocument) => {
      try {
        const read = viewer?.document.id === document.id && viewer.bytes ? { bytes: viewer.bytes, fileName: document.originalName, contentType: document.contentType } : await documentBytes(api, machineId, document.id)
        const url = URL.createObjectURL(new Blob([read.bytes as BlobPart], { type: read.contentType }))
        const link = window.document.createElement('a')
        link.href = url
        link.download = read.fileName
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
      } catch (error) {
        setNotice({ tone: 'danger', words: { key: 'record.failed' }, detail: problemOf(error) })
      }
    },
    [api, machineId, viewer],
  )
  const submitRemove = useCallback(async () => {
    if (!removing || removing.busy || removing.reason.trim().length < 3) return
    setRemoving({ ...removing, busy: true, problem: null })
    try {
      await removeDocument(api, machineId, removing.document.id, { version: removing.document.version, reason: removing.reason.trim() })
      setRemoving(null)
      readDocs()
      readFacts()
    } catch (error) {
      setRemoving((current) => (current ? { ...current, busy: false, problem: depthProblemOf(error) } : current))
    }
  }, [api, machineId, removing, readDocs, readFacts])

  // Change status (a release from do-not-use asks a technician's fresh code, then runs again with the same key)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const [status, setStatus] = useState<StatusDialogState | null>(null)
  const statusKey = useRef(newIdempotencyKey())
  const submitStatus = useCallback(async () => {
    if (!value || !status || status.busy || !status.draft.to) return
    const machine = value.card.machine
    const to = status.draft.to
    setStatus({ ...status, busy: true, problem: null })
    const work = () => changeStatus(api, machine.id, { version: machine.version, to, reason: status.draft.reason.trim() }, statusKey.current)
    try {
      const saved = releases(machine.status, to) ? await guard('depth:stepUp.release', work) : await work()
      setStatus(null)
      statusKey.current = newIdempotencyKey()
      setLoaded({ status: 'ready', value: { ...value, card: { ...value.card, machine: saved } } })
      setNotice({ tone: 'success', words: { key: 'done.machineSaved', params: { machine: saved.assetNumber } } })
      void load()
      readWeek()
    } catch (error) {
      setStatus((current) => (current ? { ...current, busy: false, problem: isStepUpCancelled(error) ? { key: 'depth:status.cancelled' } : depthProblemOf(error) } : current))
    }
  }, [api, value, status, guard, load, readWeek])

  // Print QR tags
  const { tags, openTags, closeTags, setPrinter, setCopies, printTagsNow, retryTag } = useTags(api, locale, readTag)

  const depth: RecordDepth = {
    today,
    facts,
    documents: { loaded: documents, upload, viewer, remove: removing },
    history: { loaded: history, week },
    tagJob,
    status,
    tags,
    stepUp: { ...stepUp, sentence: stepUp.sentence.replace(/^depth:/, '') },
    canPrint,
  }

  const [notice, setNotice] = useState<Notice | null>(null)
  const [edit, setEdit] = useState<MachineDraft | null>(null)
  const [suppliers, setSuppliers] = useState<SupplierChoice[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [field, setField] = useState<string | null>(null)
  const [retire, setRetire] = useState<MachineRecordModel['retire']>(null)

  const startEdit = useCallback(() => {
    if (!value) return
    const machine = value.card.machine
    setEdit({
      siteId: machine.siteId,
      assetNumber: machine.assetNumber,
      classId: machine.class.id,
      make: machine.make ?? '',
      modelName: machine.modelName ?? '',
      serialNumber: machine.serialNumber ?? '',
      year: machine.year !== null ? String(machine.year) : '',
      stationId: machine.station?.id ?? null,
      workCentreId: machine.workCentre?.id ?? null,
      supplier: machine.supplier ? { id: machine.supplier.id, code: machine.supplier.code, legalName: machine.supplier.name } : null,
      cost: costTextOf(machine.purchaseCost, locale),
      note: machine.note ?? '',
    })
    setField(null)
  }, [value, locale])

  const apply = useCallback(async () => {
    if (!value || !edit || busy) return
    const machine = value.card.machine
    const change: MachineFields & { version: number } = { version: machine.version }
    const text = (next: string, now: string | null) => (next.trim() === (now ?? '') ? undefined : next.trim() || null)
    if (edit.classId && edit.classId !== machine.class.id) change.classId = edit.classId
    const make = text(edit.make, machine.make)
    if (make !== undefined) change.make = make
    const modelName = text(edit.modelName, machine.modelName)
    if (modelName !== undefined) change.modelName = modelName
    const serial = text(edit.serialNumber, machine.serialNumber)
    if (serial !== undefined) change.serialNumber = serial
    const year = yearOf(edit.year)
    if (year !== undefined && year !== machine.year) change.year = year
    if (edit.stationId !== (machine.station?.id ?? null)) change.stationId = edit.stationId
    if (edit.workCentreId !== (machine.workCentre?.id ?? null)) change.workCentreId = edit.workCentreId
    if (can.parties && (edit.supplier?.id ?? null) !== (machine.supplier?.id ?? null)) change.supplierId = edit.supplier?.id ?? null
    const cost = costMinorOf(edit.cost)
    if (can.cost && cost !== undefined && cost !== (machine.purchaseCost ?? null)) change.purchaseCost = cost
    const note = text(edit.note, machine.note)
    if (note !== undefined) change.note = note
    if (Object.keys(change).length === 1) {
      setEdit(null)
      return
    }
    setBusy(true)
    try {
      const saved = await updateMachine(api, machine.id, change)
      setLoaded({ status: 'ready', value: { ...value, card: { ...value.card, machine: saved } } })
      setEdit(null)
      setNotice({ tone: 'success', words: { key: 'done.machineSaved', params: { machine: saved.assetNumber } } })
    } catch (error) {
      setField(fieldOf(error))
      setNotice({ tone: 'danger', words: { key: 'cell.refusedMachine', params: { machine: machine.assetNumber } }, detail: problemOf(error) })
    } finally {
      setBusy(false)
    }
  }, [api, value, edit, busy, can.parties, can.cost])

  const submitRetire = useCallback(async () => {
    if (!value || !retire || retire.busy) return
    setRetire({ ...retire, busy: true, problem: null })
    try {
      const machine = await retireMachine(api, value.card.machine.id, { version: value.card.machine.version, reason: retire.reason.trim() })
      setRetire(null)
      setNotice({ tone: 'success', words: { key: 'done.retired', params: { count: 1 } } })
      setLoaded({ status: 'ready', value: { ...value, card: { ...value.card, machine } } })
      void load()
    } catch (error) {
      setRetire((current) => (current ? { ...current, busy: false, problem: problemOf(error) } : current))
    }
  }, [api, value, retire, load])

  const model: MachineRecordModel = { prefix, can, tab, loaded, timeZone: TIME_ZONE, live, asOf, sites, classes, edit, suppliers, busy, field, retire, notice, depth }

  return (
    <MachineRecordView
      model={model}
      actions={{
        onRetry: () => void load(),
        onEdit: startEdit,
        onDraft: (patch) => {
          setEdit((current) => (current ? { ...current, ...patch } : current))
          setField(null)
        },
        onFindSupplier: (text) => {
          if (!can.parties || text.trim().length < 2) {
            setSuppliers(null)
            return
          }
          findSuppliers(api, text)
            .then(setSuppliers)
            .catch(() => setSuppliers([]))
        },
        onEditCancel: () => setEdit(null),
        onEditApply: () => void apply(),
        onRetire: () => setRetire({ reason: '', busy: false, problem: null }),
        onRetireReason: (reason) => setRetire((current) => (current ? { ...current, reason } : current)),
        onRetireClose: () => setRetire(null),
        onRetireSubmit: () => void submitRetire(),
        onDismissNotice: () => setNotice(null),
        depth: {
          onReport: () => router.push(`${prefix}/plant/requests?report=1&machine=${encodeURIComponent(machineId)}`),
          onRetry: readDocs,
          onGroup: (group: DocumentGroup) => setUpload((current) => ({ ...current, group, onTablets: group === 'MACHINE_CE' || group === 'MANUAL', problem: null, done: null })),
          onTablets: (on) => setUpload((current) => ({ ...current, onTablets: on })),
          onFiles: (files) => void onFiles(files),
          onView: (document) => void view(document),
          onDownload: (document) => void download(document),
          onCloseViewer: () => setViewer(null),
          onRemove: (document) => setRemoving({ document, reason: '', busy: false, problem: null }),
          onRemoveReason: (reason) => setRemoving((current) => (current ? { ...current, reason } : current)),
          onRemoveSubmit: () => void submitRemove(),
          onCloseRemove: () => setRemoving(null),
          onWeek: (monday) => setWeek(monday),
          onRetryHistory: readWeek,
          onOpenStatus: () => {
            statusKey.current = newIdempotencyKey()
            setStatus({ draft: { to: null, reason: '' }, busy: false, problem: null })
          },
          onStatusDraft: (patch) => setStatus((current) => (current ? { ...current, draft: { ...current.draft, ...patch }, problem: null } : current)),
          onStatusClose: () => setStatus(null),
          onStatusSubmit: () => void submitStatus(),
          onOpenTags: () => value && openTags([tagMachineOf(value.card.machine, locale)], canPrint),
          onTagPrinter: setPrinter,
          onTagCopies: setCopies,
          onTagPrint: () => void printTagsNow(),
          onTagRetry: (job) => void retryTag(job),
          onTagsClose: closeTags,
          onStepUpSubmit: (code) => void submitStepUp(code),
          onStepUpCancel: cancelStepUp,
        },
      }}
    />
  )
}
