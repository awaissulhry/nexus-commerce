'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { formatDateTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { useCoalesced, useLive } from '../../_shared/buying/hooks'
import { downloadStored } from '../../finance/accounting/download'
import { liveMatches } from '../../quality/_shared/hooks'
import { readProblem, todayIn, TIME_ZONE, csvText } from '../_shared/model'
import type { Loaded, Notice } from '../_shared/parts'
import {
  archiveLayout,
  createExport,
  createLayout,
  getCodes,
  getExport,
  getLayouts,
  getMonth,
  listExports,
  openFile,
  patchLayout,
  previewMonth,
  putCode,
  showCheck,
  type CodeRow,
  type ExportRecord,
  type ExportRow,
  type LayoutsAnswer,
  type PayrollMonth,
} from './api'
import {
  chosenLayout,
  codeKey,
  columnsBody,
  columnsDraftOf,
  columnsHeld,
  confirmHeld,
  continueHeld,
  csvRow,
  fileHeld,
  makeHeld,
  mappingChange,
  monthWords,
  NAMESPACE,
  newColumn,
  payrollAddressOf,
  payrollCan,
  payrollHref,
  payrollProblem,
  recordHref,
  showKindOf,
  STEPS,
  wizardHref,
  type Step,
  type Words,
} from './model'
import { useExportDialogs } from './use-export-dialogs'
import { MAKING_IDLE, PREVIEW_IDLE, type CellMark, type CodesView, type ColumnsDialog, type ConfirmDialog, type MakingState, type PayrollActions, type PayrollModel, type PreviewState, type ShowDialog } from './view-model'
import { PayrollView } from './view/PayrollView'

const SLOW_MS = 1000
const OWN_MS = 5000
/** The month's checks are read again at most this often while things behind them change. */
const RECHECK_MS = 2000
const SAVED_MS = 2500
const MONTH_EVENTS = ['attendance.', 'overtime_entry.changed', 'timesheet.changed', 'pay_period.changed', 'employee.', 'payroll_code.changed', 'payroll_layout.changed', 'payroll_export.']
const EXPORT_EVENTS = ['payroll_export.']

/** A failed part of the page as a message key of this catalogue. */
const failed = (error: unknown) => ({ status: 'error' as const, problem: payrollProblem(error).key })

/**
 * `/w/<company>/people/payroll` (SCR-159): the Exports of the company (`?year=`) and the month in the band; the wizard
 * (`?new=1`, `?month=&step=&layout=`) reads the month for the layout in use, so its checks are the checks of that file. The
 * code mapping is read on its step, each code saved on its own (autosave, the version read). "Show me" and the preview are
 * recorded POSTs on the person's click: their names and figures live in this page's state alone, and leave it with the step.
 * The file is one request. Live: a change behind a check reads the month again; a file made, sent or downloaded shows
 * "N updates" on the list and the new facts on the step. Nexus does not run payroll: it makes a file for the labour consultant.
 */
export function PayrollPage() {
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Page />
    </WithMessages>
  )
}

function Page() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const t = useT(NAMESPACE)
  const prefix = pathname.replace(/\/people\/payroll\/?$/, '')
  const can = useMemo(() => payrollCan(session.permissions), [session.permissions])
  const address = useMemo(() => payrollAddressOf(params), [params])
  const companyId = session.company?.id ?? null
  const today = todayIn()

  const [asOf, setAsOf] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const ownUntil = useRef(0)
  const own = () => {
    ownUntil.current = Date.now() + OWN_MS
  }

  // ---- the Exports ---------------------------------------------------------------------------------------------------------------
  const [exportsRead, setExportsRead] = useState<{ rows: ExportRow[] | null; nextCursor: string | null; problem: string | null; slow: boolean }>({ rows: null, nextCursor: null, problem: null, slow: false })
  const [updates, setUpdates] = useState(0)
  const cursor = useRef<string | null>(null)
  cursor.current = exportsRead.nextCursor
  const readExports = useCallback(
    async (more = false) => {
      if (!can.view || !companyId) return
      const slow = setTimeout(() => setExportsRead((current) => (current.rows || current.problem ? current : { ...current, slow: true })), SLOW_MS)
      try {
        const page = await listExports(api, { companyId, year: address.year, cursor: more ? cursor.current : null })
        setExportsRead((current) => ({ rows: more && current.rows ? [...current.rows, ...page.rows] : page.rows, nextCursor: page.nextCursor, problem: null, slow: false }))
        setAsOf(new Date().toISOString())
        if (!more) setUpdates(0)
      } catch (error) {
        setExportsRead((current) => ({ ...current, rows: more ? current.rows : null, problem: readProblem(error), slow: false }))
      } finally {
        clearTimeout(slow)
      }
    },
    [api, can.view, companyId, address.year],
  )
  useEffect(() => {
    setExportsRead((current) => ({ ...current, rows: null, problem: null }))
    void readExports()
  }, [readExports])

  // ---- layouts --------------------------------------------------------------------------------------------------------------------
  const [layouts, setLayouts] = useState<Loaded<LayoutsAnswer>>({ status: 'loading' })
  const readLayouts = useCallback(async () => {
    if (!can.view || !companyId) return
    try {
      setLayouts({ status: 'ready', value: await getLayouts(api, companyId) })
    } catch (error) {
      setLayouts(failed(error))
    }
  }, [api, can.view, companyId])
  useEffect(() => {
    void readLayouts()
  }, [readLayouts])

  // ---- the month, for the layout in use --------------------------------------------------------------------------------------------
  const [month, setMonth] = useState<Loaded<PayrollMonth>>({ status: 'loading' })
  const value = month.status === 'ready' ? month.value : null
  const allLayouts = layouts.status === 'ready' ? layouts.value.layouts : []
  const layout = chosenLayout(allLayouts, address.layoutId, value?.latest?.layout.id ?? null)
  const layoutId = layout?.id ?? null
  const layoutsSettled = layouts.status !== 'loading'
  const wanted = address.month
  const reading = useRef(0)
  const readMonth = useCallback(
    async (quiet = false) => {
      if (!can.view || !companyId || !layoutsSettled) return
      const ticket = ++reading.current
      if (!quiet) setMonth((current) => (current.status === 'ready' && (wanted === null || current.value.month === wanted) ? current : { status: 'loading' }))
      try {
        const answer = await getMonth(api, { companyId, month: wanted, layoutId })
        if (ticket === reading.current) setMonth({ status: 'ready', value: answer })
      } catch (error) {
        if (ticket === reading.current && !quiet) setMonth(failed(error))
      }
    },
    [api, can.view, companyId, wanted, layoutId, layoutsSettled],
  )
  useEffect(() => {
    void readMonth()
  }, [readMonth])
  const monthKey = value?.month ?? null

  // ---- the code mapping, read on its step --------------------------------------------------------------------------------------------
  const [codes, setCodes] = useState<Loaded<CodesView>>({ status: 'loading' })
  const [marks, setMarks] = useState<Record<string, CellMark>>({})
  const readCodes = useCallback(async () => {
    if (!can.view || !companyId) return
    try {
      const answer = await getCodes(api, companyId)
      setCodes({ status: 'ready', value: { rows: answer.codes, unmapped: answer.unmapped } })
    } catch (error) {
      setCodes(failed(error))
    }
  }, [api, can.view, companyId])
  const onMapping = address.wizard && address.step === 'mapping'
  useEffect(() => {
    if (onMapping) void readCodes()
  }, [onMapping, readCodes])

  const saveCode = (row: CodeRow, typed: string) => {
    const next = mappingChange(row, typed)
    if (next === undefined || !companyId || !can.manage) return
    const key = codeKey(row)
    setMarks((current) => ({ ...current, [key]: { state: 'saving' } }))
    own()
    putCode(api, { companyId, kind: row.kind, ourCode: row.ourCode, providerCode: next, ...(row.version !== null ? { version: row.version } : {}) })
      .then((saved) => {
        setCodes((current) => {
          if (current.status !== 'ready') return current
          const rows = current.value.rows.map((entry) => (codeKey(entry) === key ? saved : entry))
          return { status: 'ready', value: { rows, unmapped: rows.filter((entry) => entry.inUse && entry.providerCode === null).length } }
        })
        setMarks((current) => ({ ...current, [key]: { state: 'saved' } }))
        setTimeout(() => setMarks(({ [key]: mark, ...rest }) => (mark?.state === 'saved' ? rest : { ...rest, ...(mark ? { [key]: mark } : {}) })), SAVED_MS)
        void readMonth(true)
      })
      .catch((error: unknown) => {
        setMarks((current) => ({ ...current, [key]: { state: 'failed', words: payrollProblem(error) } }))
        if (isApiError(error) && error.kind === 'conflict') void readCodes()
      })
  }

  // ---- the preview: recorded, on the person's step; gone when the step is left -------------------------------------------------------
  const [preview, setPreview] = useState<PreviewState>(PREVIEW_IDLE)
  const [onlyChanged, setOnlyChanged] = useState(false)
  const readPreview = useCallback(
    (target: string) => {
      if (!companyId || !can.records) return
      setPreview({ status: 'reading', value: null, problem: null })
      previewMonth(api, { companyId, month: target })
        .then((answer) => setPreview({ status: 'ready', value: answer, problem: null }))
        .catch((error: unknown) => setPreview({ status: 'error', value: null, problem: payrollProblem(error) }))
    },
    [api, can.records, companyId],
  )

  // ---- the month's file -------------------------------------------------------------------------------------------------------------
  const [record, setRecord] = useState<Loaded<ExportRecord> | null>(null)
  const latestId = value?.latest?.id ?? null
  const onSend = address.wizard && address.step === 'send'
  const readRecord = useCallback(
    async (id: string) => {
      try {
        setRecord({ status: 'ready', value: await getExport(api, id) })
      } catch (error) {
        setRecord(failed(error))
      }
    },
    [api],
  )
  useEffect(() => {
    if (!onSend) return
    if (!latestId) return setRecord(null)
    setRecord((current) => (current?.status === 'ready' && current.value.id === latestId ? current : { status: 'loading' }))
    void readRecord(latestId)
  }, [onSend, latestId, readRecord])

  // ---- the pop-ups of a file ---------------------------------------------------------------------------------------------------------
  const readAll = () => {
    void readExports()
    void readMonth(true)
  }
  const exportDialogs = useExportDialogs(api, {
    companyId,
    can,
    locale,
    own,
    onChanged: () => {
      readAll()
      if (latestId) void readRecord(latestId)
    },
    onMade: (made) => setRecord({ status: 'ready', value: made }),
  })

  // ---- live ------------------------------------------------------------------------------------------------------------------------
  const recheck = useCoalesced(() => {
    void readMonth(true)
    if (onSend && latestId) void readRecord(latestId)
  }, RECHECK_MS)
  const later = useCoalesced(() => setUpdates((count) => count + 1), SLOW_MS)
  const live = useLive(
    (change) => {
      if (liveMatches(change, MONTH_EVENTS)) recheck()
      if (liveMatches(change, EXPORT_EVENTS) && Date.now() > ownUntil.current) later()
    },
    () => {
      void readExports()
      void readMonth(true)
    },
    can.view,
  )

  // ---- "Show me" --------------------------------------------------------------------------------------------------------------------
  const [show, setShow] = useState<ShowDialog | null>(null)

  // ---- CSV columns and the consultant's confirmation ---------------------------------------------------------------------------------
  const [columns, setColumns] = useState<ColumnsDialog | null>(null)
  const [confirm, setConfirm] = useState<ConfirmDialog | null>(null)
  const afterLayout = () => {
    void readLayouts()
    void readMonth(true)
  }

  // ---- the wizard's own state --------------------------------------------------------------------------------------------------------
  const [note, setNote] = useState('')
  const [making, setMaking] = useState<MakingState>(MAKING_IDLE)
  const [heldNote, setHeldNote] = useState<Words | null>(null)
  const makingKey = useRef<string | null>(null)

  // A new month: what was read and typed for the one before is forgotten.
  useEffect(() => {
    setPreview(PREVIEW_IDLE)
    setOnlyChanged(false)
    setNote('')
    setMaking(MAKING_IDLE)
    setHeldNote(null)
    setRecord(null)
    setShow(null)
    makingKey.current = null
  }, [monthKey])

  const facts = { month: value, can }
  const go = (step: Step) => {
    setHeldNote(null)
    if (step !== 'preview') setPreview(PREVIEW_IDLE)
    router.replace(wizardHref(prefix, value?.month ?? address.month, step, address.layoutId), { scroll: false })
    // Going to the step is the person's click: the numbers open and the opening is recorded. A page load shows the button instead.
    if (step === 'preview' && address.step !== 'preview' && value) readPreview(value.month)
  }

  const actions: PayrollActions = {
    ...exportDialogs.actions,
    onDismissNotice: () => setNotice(null),
    onRetryMonth: () => void readMonth(),
    onYear: (year) => router.replace(payrollHref(prefix, year), { scroll: false }),
    onMore: () => void readExports(true),
    onRetryExports: () => void readExports(),
    onShowUpdates: () => void readExports(),
    onExportCsv: (rows) => {
      const place = { locale, timeZone: TIME_ZONE }
      const when = (at: string | null) => (at ? formatDateTime(at, place) : '')
      const text = csvText(
        ['period', 'company', 'format', 'version', 'number', 'status', 'made', 'at', 'sent', 'downloaded', 'seal'].map((name) => t(`csv.${name}`)),
        rows.map((row) => csvRow(row, { status: t(`status.${row.status}`), format: t(`format.${row.layout.format}`), month: monthWords(row.month, locale) }, when)),
      )
      const anchor = document.createElement('a')
      anchor.href = URL.createObjectURL(new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }))
      anchor.download = t('csv.file')
      anchor.click()
      URL.revokeObjectURL(anchor.href)
    },
    onOpenExport: (id) => router.push(recordHref(prefix, id)),
    onStart: () => router.push(wizardHref(prefix, value?.month ?? null)),
    onLeave: () => router.push(payrollHref(prefix, address.year)),
    onMonth: (target) => router.replace(wizardHref(prefix, target, 'period', address.layoutId), { scroll: false }),
    onStep: go,
    onContinue: () => {
      const held = continueHeld(address.step, facts)
      if (held) return setHeldNote(held)
      const next = STEPS[STEPS.indexOf(address.step) + 1]
      if (next) go(next)
    },
    onBack: () => {
      const previous = STEPS[STEPS.indexOf(address.step) - 1]
      if (previous) go(previous)
    },
    onShow: (check) => {
      if (!companyId || !value || showKindOf(check.code) === 'place' || !can.records) return
      setShow({ check, answer: null, problem: null })
      showCheck(api, { companyId, month: value.month, code: check.code })
        .then((answer) => setShow((current) => (current?.check.code === check.code ? { ...current, answer } : current)))
        .catch((error: unknown) => setShow((current) => (current?.check.code === check.code ? { ...current, problem: payrollProblem(error) } : current)))
    },
    onCloseShow: () => setShow(null),
    onRetryCodes: () => {
      setCodes({ status: 'loading' })
      void readCodes()
    },
    onCode: saveCode,
    onReadPreview: () => {
      if (value) readPreview(value.month)
    },
    onOnlyChanged: setOnlyChanged,
    onLayout: (id) => router.replace(wizardHref(prefix, value?.month ?? address.month, address.step, id), { scroll: false }),
    onAddLayout: (starter) => {
      if (!companyId) return
      own()
      createLayout(api, { companyId, starter })
        .then((made) => {
          void readLayouts()
          router.replace(wizardHref(prefix, value?.month ?? address.month, address.step, made.id), { scroll: false })
        })
        .catch((error: unknown) => setNotice({ tone: 'danger', words: payrollProblem(error) }))
    },
    onArchiveLayout: (target) => {
      own()
      archiveLayout(api, target.id, target.version)
        .then(() => {
          setNotice({ tone: 'success', words: { key: 'notice.archived', params: { name: target.name } } })
          afterLayout()
        })
        .catch((error: unknown) => setNotice({ tone: 'danger', words: payrollProblem(error) }))
    },
    onRetryLayouts: () => {
      setLayouts({ status: 'loading' })
      void readLayouts()
    },
    onNote: setNote,
    onMake: () => {
      if (!companyId || !value || !layout || makeHeld({ ...facts, layout, busy: making.busy })) return
      const key = (makingKey.current ??= newIdempotencyKey())
      setMaking({ busy: true, startedAt: Date.now(), problem: null })
      own()
      createExport(api, { companyId, month: value.month, layoutId: layout.id, ...(note.trim() ? { note: note.trim() } : {}) }, key)
        .then((made) => {
          makingKey.current = null
          setMaking(MAKING_IDLE)
          setRecord({ status: 'ready', value: made })
          readAll()
        })
        .catch((error: unknown) => {
          if (isApiError(error) && error.kind !== 'unavailable' && error.kind !== 'internal') makingKey.current = null
          setMaking({ busy: false, startedAt: null, problem: payrollProblem(error) })
          void readMonth(true)
        })
    },
    onDownload: (target, file) => {
      if (fileHeld(target, can)) return
      downloadStored(() => openFile(api, target.id, file.id), file.name).catch((error: unknown) => setNotice({ tone: 'danger', words: payrollProblem(error) }))
    },
    onRetryRecord: () => {
      if (latestId) void readRecord(latestId)
    },
    onOpenColumns: (target) => setColumns({ layout: target, draft: columnsDraftOf(target), busy: false, problem: null }),
    onColumnsDraft: (patch) => setColumns((current) => (current ? { ...current, draft: { ...current.draft, ...patch }, problem: null } : current)),
    onColumnAdd: (key) => setColumns((current) => (current ? { ...current, draft: { ...current.draft, columns: [...current.draft.columns, newColumn(current.draft.columns, key)] }, problem: null } : current)),
    onSaveColumns: () => {
      if (!columns || columnsHeld(columns.draft, can, columns.busy)) return
      setColumns({ ...columns, busy: true, problem: null })
      own()
      const name = columns.draft.name.trim()
      patchLayout(api, columns.layout.id, { version: columns.layout.version, ...(name !== columns.layout.name ? { name } : {}), definition: columnsBody(columns.draft) })
        .then((saved) => {
          setColumns(null)
          setNotice({ tone: 'success', words: { key: 'notice.layoutSaved', params: { name: saved.name } } })
          afterLayout()
        })
        .catch((error: unknown) => setColumns((current) => (current ? { ...current, busy: false, problem: payrollProblem(error) } : current)))
    },
    onCloseColumns: () => setColumns(null),
    onOpenConfirm: (target) => setConfirm({ layout: target, draft: { by: target.definition.confirmation?.by ?? '', on: target.definition.confirmation?.on ?? today }, busy: false, problem: null }),
    onConfirmDraft: (patch) => setConfirm((current) => (current ? { ...current, draft: { ...current.draft, ...patch }, problem: null } : current)),
    onSaveConfirm: () => {
      if (!confirm || confirmHeld(confirm.draft, can, confirm.busy)) return
      setConfirm({ ...confirm, busy: true, problem: null })
      own()
      patchLayout(api, confirm.layout.id, { version: confirm.layout.version, confirmation: { on: confirm.draft.on, by: confirm.draft.by.trim() } })
        .then(() => {
          setConfirm(null)
          afterLayout()
        })
        .catch((error: unknown) => setConfirm((current) => (current ? { ...current, busy: false, problem: payrollProblem(error) } : current)))
    },
    onTakeBackConfirm: () => {
      if (!confirm || confirm.busy) return
      setConfirm({ ...confirm, busy: true, problem: null })
      own()
      patchLayout(api, confirm.layout.id, { version: confirm.layout.version, confirmation: null })
        .then(() => {
          setConfirm(null)
          afterLayout()
        })
        .catch((error: unknown) => setConfirm((current) => (current ? { ...current, busy: false, problem: payrollProblem(error) } : current)))
    },
    onCloseConfirm: () => setConfirm(null),
  }

  const model: PayrollModel = {
    prefix,
    can,
    today,
    address,
    live,
    asOf,
    month,
    layouts,
    layout,
    exports: { rows: exportsRead.rows, more: !!exportsRead.nextCursor, problem: exportsRead.problem, slow: exportsRead.slow, updates },
    wizard: address.wizard ? { step: address.step, heldNote, codes, marks, preview, onlyChanged, note, making, record } : null,
    show,
    columns,
    confirm,
    dialogs: exportDialogs.dialogs,
    notice,
    pages: OFFICE_PAGES,
  }
  return <PayrollView model={model} actions={actions} />
}

