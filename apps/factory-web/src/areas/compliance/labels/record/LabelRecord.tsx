'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { liveMatches, useLive, useRecordTab } from '../../../quality/_shared/hooks'
import { failedRead, problemKey, reading, ready, type Notice, type Read } from '../../../quality/_shared/model'
import {
  activateTemplate,
  getPrintJob,
  getStyle,
  getTemplate,
  listPrinters,
  listTestPrints,
  previewLabel,
  previewPdf,
  retireTemplate,
  retryPrintJob,
  reviseTemplate,
  testPrint,
  updateTemplate,
  type LabelDetail,
  type Preview,
  type PreviewAsk,
  type PrintJob,
  type Printer,
} from '../api'
import { draftOf, isDirty, jobSettled, LABEL_EVENTS, labelHref, labelsCan, patchOf, type LabelDraft } from '../model'
import { LabelsMessages } from '../view/parts'
import type { CellChoices, LabelRecordModel, RecordDialog, RecordTab, TestPrintState } from '../view-model'
import { LabelRecordView } from './view/LabelRecordView'

const TABS: readonly RecordTab[] = ['content', 'versions', 'prints']
/** The business day in Europe/Rome (the API's "today"; the date field's default). */
const todayInRome = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
/** A live event right after our own write is our own: it says nothing new. */
const OWN_ECHO_MS = 4000

/**
 * The label record container (`/w/<company>/compliance/labels/<id>?tab=content|versions|prints`, SCR-053): reads the label
 * (`GET /compliance/labels/:id`), its style's colourways and sizes (product.styles.view), the server's preview of the
 * saved content for the asked cell with the values it used (so the page renders the draft as it is typed), the label
 * printers and its test prints (print.view). Writes one at a time with the version read: Save (only what changed),
 * Activate, Retire, New revision, a test print (then its job is asked about until printed or failed). `?act=retire|revise`
 * opens that dialog once the label is read (the list's row verbs link here). Live events of the code re-read the label
 * when nothing is typed, else say someone changed it.
 */
export function LabelRecord({ templateId }: { templateId: string }) {
  return (
    <LabelsMessages>
      <LabelContainer templateId={templateId} />
    </LabelsMessages>
  )
}

function LabelContainer({ templateId }: { templateId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const params = useSearchParams()
  const can = useMemo(() => labelsCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = useRecordTab(TABS)
  const [detail, setDetail] = useState<Read<LabelDetail>>(reading())
  const [draft, setDraft] = useState<LabelDraft | null>(null)
  const [ask, setAsk] = useState<PreviewAsk>({})
  const [preview, setPreview] = useState<Read<Preview>>(reading())
  const [style, setStyle] = useState<CellChoices | null>(null)
  const [save, setSave] = useState<LabelRecordModel['save']>({ state: 'idle', at: null })
  const [changed, setChanged] = useState<{ at: string } | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [printers, setPrinters] = useState<Read<Printer[]>>(reading())
  const [prints, setPrints] = useState<Read<PrintJob[]>>(reading())
  const [test, setTest] = useState<TestPrintState>({ job: null, label: null, printer: null })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<LabelRecordModel['problem']>(null)
  const lastWrite = useRef(0)
  const today = useMemo(todayInRome, [])
  const current = detail.value

  const load = useCallback(async () => {
    try {
      const value = await getTemplate(api, templateId)
      setDetail(ready(value))
      setDraft(value.status === 'DRAFT' && can.manage ? draftOf(value) : null)
      setChanged(null)
    } catch (error) {
      setDetail(failedRead(problemKey(error)))
    }
  }, [api, templateId, can.manage])

  useEffect(() => {
    void load()
  }, [load])

  // The style the preview is drawn on: the label's own, else (a shared label) the first style naming it.
  const styleId = current ? (current.styleId ?? current.usage.styleRevisions[0]?.styleId ?? null) : null

  const loadPreview = useCallback(
    async (signal?: AbortSignal) => {
      if (!current) return
      if (!styleId) {
        setPreview(failedRead('preview.needStyle'))
        return
      }
      setPreview(reading())
      try {
        const answer = await previewLabel(api, current.id, { ...ask, styleId: current.styleId ? undefined : styleId }, signal)
        if (!signal?.aborted) setPreview(ready(answer))
      } catch (error) {
        if ((error as { name?: string } | null)?.name === 'AbortError') return
        setPreview(failedRead(problemKey(error)))
      }
    },
    [api, current, styleId, ask],
  )

  useEffect(() => {
    const controller = new AbortController()
    void loadPreview(controller.signal)
    return () => controller.abort()
  }, [loadPreview])

  useEffect(() => {
    if (!styleId || !can.styles) return
    getStyle(api, styleId)
      .then((value) => setStyle({ colourways: value.colourways.filter((entry) => entry.status === 'ACTIVE').map((entry) => ({ id: entry.id, code: entry.code, name: entry.name })), sizes: value.sizes }))
      .catch(() => setStyle(null))
  }, [api, styleId, can.styles])

  const loadPrinters = useCallback(() => {
    if (!can.printView) {
      setPrinters(ready([]))
      return
    }
    listPrinters(api)
      .then((list) => setPrinters(ready(list)))
      .catch((error) => setPrinters(failedRead(problemKey(error))))
  }, [api, can.printView])
  useEffect(() => loadPrinters(), [loadPrinters])

  const loadPrints = useCallback(() => {
    if (!can.printView) return
    listTestPrints(api, templateId)
      .then((jobs) => setPrints(ready([...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))))
      .catch((error) => setPrints(failedRead(problemKey(error))))
  }, [api, templateId, can.printView])
  useEffect(() => {
    if (tab === 'prints') loadPrints()
  }, [tab, loadPrints])

  // ?act=retire|revise (the list's row verbs) opens that dialog once the label is read.
  const act = params?.get('act') ?? null
  const acted = useRef(false)
  useEffect(() => {
    if (!current || acted.current) return
    acted.current = true
    if (act === 'retire' && current.status !== 'RETIRED') setDialog({ kind: 'retire', reason: '' })
    if (act === 'revise' && current.status !== 'DRAFT') setDialog({ kind: 'revise' })
  }, [current, act])

  const live = useLive(
    (change) => {
      if (!current || !liveMatches(change, LABEL_EVENTS)) return
      if (change.fields.templateId !== current.id && change.fields.code !== current.code) return
      if (Date.now() - lastWrite.current < OWN_ECHO_MS) return
      if (isDirty(current, draft)) setChanged({ at: new Date().toISOString() })
      else void load()
    },
    () => void load(),
  )

  // A test print's job is asked about every 2 s until it is printed or failed (at most a minute).
  const job = test.job
  useEffect(() => {
    if (!job || jobSettled(job)) return
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      if (tries > 30) {
        clearInterval(timer)
        return
      }
      getPrintJob(api, job.id)
        .then((next) => {
          setTest((state) => (state.job?.id === next.id ? { ...state, job: next } : state))
          if (jobSettled(next)) loadPrints()
        })
        .catch(() => undefined)
    }, 2000)
    return () => clearInterval(timer)
  }, [api, job, loadPrints])

  const refused = (error: unknown, fallback: string): LabelRecordModel['problem'] => {
    if (!isApiError(error)) return { key: fallback }
    const lines = error.issues.map((issue) => issue.message ?? '').filter(Boolean)
    if (error.kind === 'conflict') return { key: error.code === 'version_conflict' || error.issues.some((issue) => issuePath(issue).includes('version')) ? 'problem.moved' : 'problem.state', lines }
    if (error.kind === 'invalid') return { key: 'problem.invalid', lines }
    if (error.kind === 'forbidden') return { key: 'problem.forbidden' }
    return { key: fallback }
  }

  const write = async <T,>(work: () => Promise<T>, fallback: string, done: (value: T) => void) => {
    setBusy(true)
    setProblem(null)
    lastWrite.current = Date.now()
    try {
      done(await work())
    } catch (error) {
      const answer = refused(error, fallback)
      setProblem(answer)
      if (answer?.key === 'problem.moved') void load()
    } finally {
      setBusy(false)
    }
  }

  const saveDraft = async () => {
    if (!current || !draft) return
    const patch = patchOf(current, draft)
    if (Object.keys(patch).length === 0) return
    setSave({ state: 'saving', at: save.at })
    lastWrite.current = Date.now()
    try {
      const saved = await updateTemplate(api, current, patch)
      setDetail(ready(saved))
      setDraft(draftOf(saved))
      setSave({ state: 'idle', at: new Date().toISOString() })
      setChanged(null)
    } catch (error) {
      setSave({ state: 'failed', at: save.at })
      const answer = refused(error, 'problem.saveFailed')
      setNotice({ key: answer?.key === 'problem.moved' ? 'notice.moved' : answer?.key === 'problem.invalid' ? 'notice.saveRefused' : 'notice.saveFailed', tone: 'danger', detail: answer?.lines })
    }
  }

  const sheet = async () => {
    if (!current) return
    try {
      const bytes = await previewPdf(api, current.id, { ...ask, styleId: current.styleId ? undefined : styleId })
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `${current.code}-r${current.revision}-sample.pdf`
      document.body.append(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      setNotice({ key: 'notice.sheetFailed', tone: 'warning', detail: isApiError(error) ? error.issues.map((issue) => issue.message ?? '').filter(Boolean) : undefined })
    }
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setNotice({ key: 'done.copied', params: { code: text }, tone: 'success' })
    } catch {
      setNotice({ key: 'done.copyFailed', tone: 'warning' })
    }
  }

  const openDialog = (next: RecordDialog | null) => {
    setDialog(next)
    setProblem(null)
    if (next?.kind === 'test' && dialog?.kind !== 'test') setTest({ job: null, label: null, printer: null })
  }

  const model: LabelRecordModel = { prefix, can, tab, detail, today, draft, preview, ask, style, save, live, changed, notice, dialog, printers, prints, test, busy, problem }
  return (
    <LabelRecordView
      model={model}
      actions={{
        onRetry: () => void load(),
        onReload: () => void load(),
        onDraft: setDraft,
        onSave: () => void saveDraft(),
        onDiscard: () => {
          if (current) setDraft(draftOf(current))
          setDialog(null)
        },
        onAsk: setAsk,
        onRetryPreview: () => void loadPreview(),
        onDialog: openDialog,
        onActivate: () =>
          current &&
          void write(() => activateTemplate(api, current), 'problem.activateFailed', (value) => {
            setDetail(ready(value))
            setDraft(null)
            setDialog(null)
            setNotice({ key: 'done.activated', params: { code: value.code, revision: value.revision }, tone: 'success' })
            void loadPreview()
          }),
        onRetire: (reason) =>
          current &&
          void write(() => retireTemplate(api, current, reason), 'problem.retireFailed', (value) => {
            setDetail(ready(value))
            setDraft(null)
            setDialog(null)
            const released = value.usage.styleRevisions.filter((entry) => entry.status === 'RELEASED').length
            setNotice({ key: released > 0 ? 'done.retiredReleased' : 'done.retired', params: { code: value.code, revision: value.revision, count: released }, tone: released > 0 ? 'warning' : 'success' })
          }),
        onRevise: () =>
          current &&
          void write(() => reviseTemplate(api, current.id), 'problem.reviseFailed', (value) => {
            setDialog(null)
            router.push(labelHref(prefix, value.id))
          }),
        onTestPrint: (printerId, copies) =>
          current &&
          void write(() => testPrint(api, current.id, { printerId, copies, ...ask, styleId: current.styleId ? undefined : styleId }), 'problem.testFailed', (answer) => {
            setTest({ job: answer.job, label: answer.label, printer: (printers.value ?? []).find((entry) => entry.id === printerId) ?? null })
            loadPrints()
          }),
        onRetryJob: (jobId) =>
          void write(() => retryPrintJob(api, jobId), 'problem.retryFailed', (next) => {
            setTest((state) => (state.job?.id === next.id ? { ...state, job: next } : state))
            loadPrints()
          }),
        onPrintSheet: () => void sheet(),
        onCopy: (text) => void copy(text),
        onDismissNotice: () => setNotice(null),
        onRetryPrints: loadPrints,
      }}
    />
  )
}
