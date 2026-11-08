'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { useLive, useRecordTab } from '../../_shared/hooks'
import {
  actionFiles,
  addAction,
  cancelAction,
  cancelCapa,
  capaPeople,
  closeCapa,
  doneAction,
  editAction,
  editCapa,
  fileAddress,
  findCustomers,
  getCapa,
  keepReport,
  moveCapa,
  newIdempotencyKey,
  remindAction,
  removeSource,
  reportPreview,
  shareWithCustomer,
  uploadEvidence,
  type CapaPerson,
  type CapaRecord as CapaRecordValue,
  type CapaStatus,
  type ReportLanguage,
} from '../api'
import { actionBodyOf, actionCellChange, capaCan, closeLinesOfRecord, emptyActionDraft, problemChangesOf, problemDraftOf, readProblem, recordHref, RECORD_TABS, refusalOf, stepAction, todayOf, type ProblemDraft } from '../model'
import type { CapaNotice, CellState } from '../parts'
import type { CloseDialogModel } from '../view/CloseCapaDialog'
import type { CapaRecordActions, CapaRecordModel, DrawerModel, Loaded, RecordDialog, ReportModel } from './view-model'
import { CapaRecordView } from './view/CapaRecordView'

/**
 * `/w/<company>/quality/capa/<id>` (SCR-146-record; `?tab=problem|actions|report|activity`, `&add=1` opens Add action,
 * `&action=<id>` docks an action): the CAPA read once and again on its live changes (any `capa.` event that names it;
 * while a dialog or the Problem draft holds work, a banner says it changed instead); the people who may own it or be given
 * an action; the 8D preview when the Report tab opens. Every write is one call with its own Idempotency-Key and the
 * version read (the CAPA's; an action's for its cells, Done, Cancel and Remind); the answer is the record as it is now. A
 * stale version reads the record again and says so.
 */
export function CapaRecord({ capaId }: { capaId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = companyPrefix(session.company?.code ?? '')
  const me = session.user.id
  const can = useMemo(() => capaCan(session.permissions), [session.permissions])
  const tab = useRecordTab(RECORD_TABS)
  const [opened] = useState(() => new Date().toISOString())
  const today = todayOf(opened)

  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [people, setPeople] = useState<readonly CapaPerson[] | null>(null)
  const [draft, setDraft] = useState<ProblemDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [cells, setCells] = useState<Record<string, CellState>>({})
  const [customers, setCustomers] = useState<CapaRecordModel['customers']>({ items: null, problem: null })
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [close, setClose] = useState<CloseDialogModel | null>(null)
  const [notice, setNotice] = useState<CapaNotice | null>(null)
  const [stale, setStale] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [drawer, setDrawer] = useState<DrawerModel | null>(null)
  const [report, setReport] = useState<ReportModel>({ language: locale === 'en' ? 'en' : 'it', pdf: null, problem: null, keeping: false, sharing: null })
  const record = loaded.status === 'ready' ? loaded.record : null
  const current = useRef<CapaRecordValue | null>(null)
  current.current = record
  const holding = useRef(false)
  holding.current = !!dialog || !!close || (draft !== null && record !== null && Object.keys(problemChangesOf(record.capa, draft)).length > 0)
  const keys = useRef<Record<string, string>>({})
  const keyOf = (name: string) => (keys.current[name] ??= newIdempotencyKey())
  const dropKey = (name: string) => void delete keys.current[name]

  const take = useCallback((next: CapaRecordValue) => {
    setLoaded({ status: 'ready', record: next })
    setAsOf(new Date().toISOString())
    setStale(null)
  }, [])

  const load = useCallback(async () => {
    try {
      take(await getCapa(api, capaId))
    } catch (error) {
      setLoaded(isApiError(error) && error.kind === 'not_found' ? { status: 'notFound' } : isApiError(error) && error.kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) })
    }
  }, [api, capaId, take])

  useEffect(() => {
    if (!can.view) {
      setLoaded({ status: 'forbidden' })
      return
    }
    void load()
  }, [load, can.view])

  const companyId = record?.capa.companyId ?? null
  const customerId = record?.capa.customer?.id ?? null
  useEffect(() => {
    if (!companyId || !can.view) return
    capaPeople(api, companyId, customerId)
      .then(setPeople)
      .catch(() => setPeople(null))
  }, [api, companyId, customerId, can.view])

  const live = useLive(
    (change) => {
      if (!change.type.startsWith('capa.') || change.fields.capaId !== capaId) return
      if (holding.current) setStale(formatTime(new Date(), { locale }))
      else void load()
    },
    () => void load(),
  )
  const offline = live === 'offline'

  // ---- the 8D preview (read when the Report tab opens, again on a language change) ------------------------------------------
  const readReport = useCallback(
    (language: ReportLanguage) => {
      setReport((now) => ({ ...now, language, pdf: null, problem: null }))
      reportPreview(api, capaId, language)
        .then((pdf) => setReport((now) => (now.language === language ? { ...now, pdf } : now)))
        .catch((error: unknown) => setReport((now) => ({ ...now, problem: readProblem(error) })))
    },
    [api, capaId],
  )
  const reportRead = useRef(false)
  useEffect(() => {
    if (tab !== 'report' || reportRead.current || !can.view) return
    reportRead.current = true
    readReport(report.language)
  }, [tab, can.view, readReport, report.language])

  // ---- addresses that open a dialog or the drawer (`&add=1` from the list's verb, `&action=<id>`) ----------------------------
  const asked = useRef(false)
  useEffect(() => {
    if (asked.current || !record) return
    asked.current = true
    if (params.get('add') === '1' && tab === 'actions') setDialog({ kind: 'addAction', draft: emptyActionDraft(today, me), busy: false, notice: null })
    const action = params.get('action')
    if (action && record.actions.some((entry) => entry.id === action)) openDrawer(action)
    // Once, after the first read.
  }, [record])

  // ---- writes -------------------------------------------------------------------------------------------------------------
  const refused = useCallback(
    (error: unknown): CapaNotice => {
      const refusal = refusalOf(error)
      if (refusal.stale) void load()
      return { say: refusal.say, tone: 'danger', lines: refusal.lines }
    },
    [load],
  )

  const move = useCallback(
    async (to: CapaStatus) => {
      const now = current.current
      if (!now || busy) return
      setBusy(true)
      try {
        const next = await moveCapa(api, now.capa.id, { version: now.capa.version, to })
        take(next)
        setNotice({ say: { key: 'record.moved', params: { stage: to } }, tone: 'success' })
      } catch (error) {
        setNotice(refused(error))
      } finally {
        setBusy(false)
      }
    },
    [api, busy, take, refused],
  )

  const openClose = useCallback(() => {
    const now = current.current
    if (!now) return
    dropKey('close')
    setClose({ capaId: now.capa.id, number: now.capa.number, type: now.capa.type, version: now.capa.version, lines: closeLinesOfRecord(now), note: '', busy: false, notice: null, offline, canClose: can.manage })
  }, [offline, can.manage])

  const submitClose = useCallback(async () => {
    if (!close || close.busy) return
    setClose({ ...close, busy: true, notice: null })
    try {
      const next = await closeCapa(api, close.capaId, { version: close.version, note: close.note.trim() }, keyOf('close'))
      dropKey('close')
      setClose(null)
      take(next)
      setNotice({ say: { key: 'close.done', params: { number: next.capa.number } }, tone: 'success' })
    } catch (error) {
      dropKey('close')
      setClose((now) => (now ? { ...now, busy: false, notice: refused(error) } : now))
    }
  }, [close, api, take, refused])

  const save = useCallback(async () => {
    const now = current.current
    if (!now || !draft || saving) return
    const changes = problemChangesOf(now.capa, draft)
    if (Object.keys(changes).length === 0) return
    setSaving(true)
    try {
      take(await editCapa(api, now.capa.id, { version: now.capa.version, ...changes }))
      setDraft(null)
      setNotice({ say: { key: 'problem.saved' }, tone: 'success' })
    } catch (error) {
      setNotice(refused(error))
    } finally {
      setSaving(false)
    }
  }, [api, draft, saving, take, refused])

  const cell = useCallback(
    async (actionId: string, field: 'description' | 'kind' | 'ownerId' | 'dueOn' | 'escalateToId', value: string) => {
      const now = current.current
      const action = now?.actions.find((entry) => entry.id === actionId)
      if (!now || !action) return
      const change = actionCellChange(action, field, value, today)
      if (!change) return
      const name = `${actionId}:${field}`
      setCells((marks) => ({ ...marks, [name]: { state: 'saving' } }))
      try {
        take(await editAction(api, now.capa.id, actionId, { version: action.version, ...change }))
        setCells((marks) => ({ ...marks, [name]: { state: 'saved' } }))
      } catch (error) {
        setCells((marks) => ({ ...marks, [name]: { state: 'failed' } }))
        setNotice(refused(error))
      }
    },
    [api, today, take, refused],
  )

  const readFiles = useCallback(
    (actionId: string) => {
      if (!can.filesRead) {
        setDrawer((now) => (now && now.actionId === actionId ? { ...now, files: { items: [], problem: null } } : now))
        return
      }
      actionFiles(api, actionId)
        .then((items) => setDrawer((now) => (now && now.actionId === actionId ? { ...now, files: { items, problem: null } } : now)))
        .catch((error: unknown) => setDrawer((now) => (now && now.actionId === actionId ? { ...now, files: { items: null, problem: readProblem(error) } } : now)))
    },
    [api, can.filesRead],
  )
  function openDrawer(actionId: string | null) {
    if (!actionId) {
      setDrawer(null)
      return
    }
    setDrawer({ actionId, files: { items: null, problem: null }, uploading: false })
    readFiles(actionId)
  }

  const submitDialog = useCallback(async () => {
    const now = current.current
    if (!now || !dialog || dialog.busy) return
    setDialog({ ...dialog, busy: true, notice: null })
    const fail = (error: unknown) => setDialog((open) => (open ? { ...open, busy: false, notice: refused(error) } : open))
    try {
      if (dialog.kind === 'addAction') {
        const answer = await addAction(api, now.capa.id, actionBodyOf(dialog.draft), keyOf('add'))
        dropKey('add')
        take(answer.record)
        setNotice({ say: { key: 'add.done', params: { seq: answer.record.actions.find((entry) => entry.id === answer.actionId)?.seq ?? '' } }, tone: 'success' })
      } else if (dialog.kind === 'done') {
        const action = now.actions.find((entry) => entry.id === dialog.actionId)
        if (!action) return
        take(await doneAction(api, now.capa.id, action.id, { version: action.version, evidenceNote: dialog.evidence.trim() || null }, keyOf(`done:${action.id}`)))
        dropKey(`done:${action.id}`)
        setNotice({ say: { key: 'done.done', params: { seq: action.seq } }, tone: 'success' })
      } else if (dialog.kind === 'cancelAction') {
        const action = now.actions.find((entry) => entry.id === dialog.actionId)
        if (!action) return
        take(await cancelAction(api, now.capa.id, action.id, { version: action.version, reason: dialog.reason.trim() }, keyOf(`cancel:${action.id}`)))
        dropKey(`cancel:${action.id}`)
        setNotice({ say: { key: 'cancelAction.done', params: { seq: action.seq } }, tone: 'success' })
      } else if (dialog.kind === 'cancelCapa') {
        take(await cancelCapa(api, now.capa.id, { version: now.capa.version, reason: dialog.reason.trim() }, keyOf('cancelCapa')))
        dropKey('cancelCapa')
        setNotice({ say: { key: 'cancel.done', params: { number: now.capa.number } }, tone: 'success' })
      } else if (dialog.kind === 'stage') {
        if (!dialog.to) return
        take(await moveCapa(api, now.capa.id, { version: now.capa.version, to: dialog.to }))
        setNotice({ say: { key: 'record.moved', params: { stage: dialog.to } }, tone: 'success' })
      } else {
        const source = now.sources.find((entry) => entry.id === dialog.sourceId)
        take(await removeSource(api, now.capa.id, dialog.sourceId, now.capa.version))
        setNotice({ say: { key: 'removeSource.done', params: { number: source?.record?.number ?? '' } }, tone: 'success' })
      }
      setDialog(null)
    } catch (error) {
      for (const name of Object.keys(keys.current)) if (name !== 'close') dropKey(name)
      fail(error)
    }
  }, [api, dialog, take, refused])

  const actions: CapaRecordActions = {
    onRetry: () => void load(),
    onReload: () => {
      setDraft(null)
      void load()
    },
    onDraft: (patch) => {
      const now = current.current
      if (!now) return
      setDraft((before) => ({ ...(before ?? problemDraftOf(now.capa)), ...patch }))
    },
    onDiscard: () => setDraft(null),
    onSave: () => void save(),
    onFindCustomers: (q) => {
      if (!can.partiesView) return
      findCustomers(api, q)
        .then((items) => setCustomers({ items, problem: null }))
        .catch((error: unknown) => setCustomers({ items: null, problem: readProblem(error) }))
    },
    onMove: (to) => void move(to),
    onClose: openClose,
    close: {
      onNote: (note) => setClose((now) => (now ? { ...now, note } : now)),
      onCancel: () => setClose(null),
      onSubmit: () => void submitClose(),
    },
    onDialog: (next) => setDialog(next),
    onDialogChange: (patch) => setDialog((now) => (now ? ({ ...now, ...patch } as RecordDialog) : now)),
    onSubmitDialog: () => void submitDialog(),
    onActionCell: (actionId, field, value) => void cell(actionId, field, value),
    onOpenAction: openDrawer,
    onStepAction: (by) => {
      const now = current.current
      if (!now || !drawer) return
      const next = stepAction(now.actions, drawer.actionId, by)
      if (next) openDrawer(next)
    },
    onRemind: (actionId) => {
      const now = current.current
      const action = now?.actions.find((entry) => entry.id === actionId)
      if (!now || !action) return
      remindAction(api, now.capa.id, actionId, action.version)
        .then((answer) => {
          take(answer.record)
          setNotice({ say: { key: answer.reminder.assigneeId ? 'drawer.reminded' : 'drawer.remindedNobody', params: { seq: action.seq } }, tone: answer.reminder.assigneeId ? 'success' : 'warning' })
        })
        .catch((error: unknown) => setNotice(refused(error)))
    },
    onUpload: (file) => {
      const now = current.current
      if (!now || !drawer) return
      const actionId = drawer.actionId
      setDrawer((open) => (open ? { ...open, uploading: true } : open))
      uploadEvidence(api, { companyId: now.capa.companyId, actionId }, file, file.name)
        .then(() => {
          setNotice({ say: { key: 'drawer.uploaded', params: { name: file.name } }, tone: 'success' })
          readFiles(actionId)
          void load()
        })
        .catch((error: unknown) => setNotice(refused(error)))
        .finally(() => setDrawer((open) => (open ? { ...open, uploading: false } : open)))
    },
    onOpenFile: (fileId) => {
      fileAddress(api, fileId).then(
        (url) => window.open(url, '_blank', 'noopener'),
        (error: unknown) => setNotice(refused(error)),
      )
    },
    onLanguage: (language) => readReport(language),
    onKeep: () => {
      const now = current.current
      if (!now || report.keeping) return
      setReport((open) => ({ ...open, keeping: true }))
      keepReport(api, now.capa.id, report.language, keyOf('keep'))
        .then((answer) => {
          dropKey('keep')
          setNotice({ say: { key: answer.made ? 'report.kept' : 'report.same', params: { version: answer.report.version } }, tone: 'success' })
          void load()
        })
        .catch((error: unknown) => {
          dropKey('keep')
          setNotice(refused(error))
        })
        .finally(() => setReport((open) => ({ ...open, keeping: false })))
    },
    onShare: (complaintId) => {
      const now = current.current
      if (!now || report.sharing) return
      const source = now.sources.find((entry) => entry.recordId === complaintId)
      setReport((open) => ({ ...open, sharing: complaintId }))
      shareWithCustomer(api, complaintId, now.capa.id, keyOf(`share:${complaintId}`))
        .then((shared) => {
          dropKey(`share:${complaintId}`)
          setNotice({ say: { key: shared.made ? 'report.shared' : 'report.sharedSame', params: { version: shared.version, number: source?.record?.number ?? '' } }, tone: 'success' })
        })
        .catch((error: unknown) => {
          dropKey(`share:${complaintId}`)
          setNotice(refused(error))
        })
        .finally(() => setReport((open) => ({ ...open, sharing: null })))
    },
    onCopy: () => {
      const now = current.current
      if (!now) return
      void navigator.clipboard
        ?.writeText(now.capa.number)
        .then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        })
        .catch(() => undefined)
    },
    onKeys: setKeysOpen,
    onDismissNotice: () => setNotice(null),
  }

  // A cancelled CAPA has nothing to add: drop `&add=1` from the address after it opened.
  useEffect(() => {
    if (params.get('add') === '1' && record) router.replace(recordHref(prefix, record.capa.id, tab), { scroll: false })
  }, [record?.capa.id])

  const model: CapaRecordModel = {
    prefix,
    me,
    today,
    can,
    tab,
    loaded,
    live,
    asOf,
    people,
    draft,
    saving,
    cells,
    customers,
    dialog,
    close: close ? { ...close, offline } : null,
    notice,
    stale,
    busy,
    keysOpen,
    copied,
    drawer: tab === 'actions' ? drawer : null,
    report,
  }

  const panels = record && tab === 'activity' ? <RecordPanels record={{ type: 'Capa', id: record.capa.id, companyId: record.capa.companyId, siteId: null }} title={`${record.capa.number} · ${record.capa.title}`} party={record.capa.customer ? { id: record.capa.customer.id, name: record.capa.customer.name, emails: [] } : null} /> : null
  return <CapaRecordView model={model} actions={actions} panels={panels} />
}
