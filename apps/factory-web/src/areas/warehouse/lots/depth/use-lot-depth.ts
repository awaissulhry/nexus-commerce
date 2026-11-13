'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useT } from '../../../../lib/i18n/provider'
import { isApiError } from '../../../../lib/api/errors'
import { storeUrl } from '../../../../record-panels/store'
import { phrase, readProblem } from '../../../_shared/stock/model'
import { part, PART_LOADING, type Part } from '../shared/model'
import { checkLifecycle, fileLink, lotDepth, makeTraceReport, regroupLot, saveAttributes, splitLot, splitRead, traceReports, type LotDepth, type TraceReportRow } from './api'
import { attributeChanges, attributeDraftOf, attributeProblems, blankReport, DEPTH_NAMESPACE, depthCan, draftOf, regroupBodyOf, reportBodyOf, reportHeld, splitBodyOf, splitHeld, splitProblem, todayIn } from './model'
import type { AttributesDialog, LotDepthActions, LotDepthModel, ReportDialog, SplitDialog } from './view-model'

/**
 * B-W2b-320 — the lot record's W2b parts (container hook; SCR-201-record): reads `GET /inventory/lots/:id/depth` with the
 * lot, the reports made when the Trace tab opens (`GET /inventory/trace/reports?kind=LOT`), and writes: Check the lifecycle
 * (`POST …/lifecycle/check`), the attributes (`PATCH …/attributes` at the version read), Split into shade groups (`GET
 * …/split`, then `POST …/split` or `…/regroup` at the family parent's version), and the dated trace report (`POST
 * /inventory/trace/report`, its file opened in a tab taken in the click itself so a pop-up blocker lets it through).
 * Every write has its own Idempotency-Key; after one, the W1 lot is read again by `onChanged`.
 */
export function useLotDepth(api: ApiClient, lotId: string, permissions: readonly string[], options: { timeZone: string; language: 'it' | 'en'; traceOpen: boolean; onChanged: () => void }) {
  const can = useMemo(() => depthCan(permissions), [permissions])
  const words = useT(DEPTH_NAMESPACE)
  const [depth, setDepth] = useState<Part<LotDepth>>(PART_LOADING)
  const [reports, setReports] = useState<Part<TraceReportRow[]> | null>(null)
  const [attributes, setAttributes] = useState<AttributesDialog | null>(null)
  const [split, setSplit] = useState<SplitDialog | null>(null)
  const [report, setReport] = useState<ReportDialog | null>(null)
  const [checking, setChecking] = useState(false)
  const [notice, setNotice] = useState<LotDepthModel['notice']>(null)
  const onChanged = useRef(options.onChanged)
  onChanged.current = options.onChanged
  const value = depth.value

  const load = useCallback(async () => {
    try {
      setDepth(part(await lotDepth(api, lotId)))
    } catch (error) {
      setDepth({ value: null, problem: readProblem(error) })
    }
  }, [api, lotId])
  useEffect(() => {
    void load()
  }, [load])

  const loadReports = useCallback(async () => {
    try {
      setReports(part(await traceReports(api, 'LOT', lotId)))
    } catch (error) {
      setReports({ value: null, problem: readProblem(error) })
    }
  }, [api, lotId])
  const asked = useRef(false)
  useEffect(() => {
    if (!options.traceOpen || asked.current) return
    asked.current = true
    setReports(PART_LOADING)
    void loadReports()
  }, [options.traceOpen, loadReports])

  const check = useCallback(async () => {
    if (checking) return
    setChecking(true)
    try {
      const answer = await checkLifecycle(api, lotId)
      setDepth(part(answer.lot))
      setNotice(answer.changed ? { tone: 'success', words: phrase('ld.life.checked', { from: answer.from, to: answer.to }) } : { tone: 'info', words: phrase('ld.life.unchanged') })
      if (answer.changed) onChanged.current()
    } catch (error) {
      setNotice({ tone: 'danger', words: isApiError(error) && (error.kind === 'forbidden' || error.kind === 'step_up') ? phrase('ld.split.held.noRight') : phrase('ld.life.checkFailed') })
    } finally {
      setChecking(false)
    }
  }, [api, lotId, checking])

  // ---- attributes ------------------------------------------------------------------------------------------------------------
  const saveAttributesNow = useCallback(async () => {
    if (!attributes || !value || attributes.busy) return
    const { changes, badMix } = attributeChanges(value.attributes.values, value.attributes.keys, attributes.draft)
    const problems = attributeProblems(value.attributes.kind, value.attributes.values, changes, badMix)
    const first = Object.values(problems)[0]
    if (first) {
      setAttributes({ ...attributes, problem: first })
      return
    }
    if (Object.keys(changes).length === 0) {
      setAttributes(null)
      return
    }
    setAttributes({ ...attributes, busy: true, problem: null })
    try {
      setDepth(part(await saveAttributes(api, lotId, value.lot.version, changes)))
      setAttributes(null)
      setNotice({ tone: 'success', words: phrase('ld.attr.saved') })
    } catch (error) {
      const key = isApiError(error) ? (error.issues.map((issue) => (typeof issue.path === 'string' ? issue.path : '')).find((path) => path.startsWith('body/attributes/'))?.split('/')[2] ?? null) : null
      setAttributes((current) => (current ? { ...current, busy: false, problem: key ? phrase(`ld.attr.problem.${key}`) : isApiError(error) && error.kind === 'conflict' ? phrase('ld.attr.changed') : phrase('ld.attr.failed') } : current))
      if (isApiError(error) && error.kind === 'conflict') void load()
    }
  }, [api, lotId, attributes, value, load])

  // ---- split and regroup -------------------------------------------------------------------------------------------------------
  const readSplit = useCallback(async () => {
    setSplit({ read: PART_LOADING, draft: null, busy: false, problem: null, done: null })
    try {
      const read = await splitRead(api, lotId)
      setSplit((current) => (current ? { ...current, read: part(read), draft: draftOf(read, (key) => words(key)) } : current))
    } catch (error) {
      setSplit((current) => (current ? { ...current, read: { value: null, problem: readProblem(error) } } : current))
    }
  }, [api, lotId, words])

  const confirmSplit = useCallback(async () => {
    const read = split?.read.value
    const draft = split?.draft
    if (!split || !read || !draft || splitHeld(read, draft, can, split.busy)) return
    setSplit({ ...split, busy: true, problem: null })
    try {
      const done = draft.mode === 'regroup' ? await regroupLot(api, lotId, regroupBodyOf(read, draft)) : await splitLot(api, lotId, splitBodyOf(read, draft))
      setSplit((current) => (current ? { ...current, busy: false, done } : current))
      void load()
      onChanged.current()
    } catch (error) {
      setSplit((current) => (current ? { ...current, busy: false, problem: splitProblem(isApiError(error) ? error : null) } : current))
      if (isApiError(error) && error.kind === 'conflict') {
        try {
          const read2 = await splitRead(api, lotId)
          setSplit((current) => (current ? { ...current, read: part(read2), draft: current.draft && current.draft.mode === draft.mode ? { ...current.draft, assign: Object.fromEntries(Object.entries(current.draft.assign).filter(([hideId]) => read2.hides.some((hide) => hide.id === hideId && hide.refusal === null))) } : draftOf(read2, (key) => words(key)) } : current))
        } catch {
          /* the refusal stays said */
        }
      }
    }
  }, [api, lotId, split, can, load, words])

  // ---- the dated trace report ----------------------------------------------------------------------------------------------------
  const openReport = useCallback(() => {
    const today = todayIn(options.timeZone)
    setReport({ draft: blankReport(today, options.language), today, busy: false, problem: null, done: null })
  }, [options.timeZone, options.language])

  const openFile = useCallback(
    async (fileId: string, tab?: Window | null) => {
      const target = tab === undefined ? window.open('', '_blank') : tab
      try {
        const link = await fileLink(api, fileId)
        const url = storeUrl(link.url)
        if (target && !target.closed) target.location.href = url
        else window.location.assign(url)
      } catch {
        target?.close()
        setNotice({ tone: 'danger', words: phrase('ld.report.fileFailed') })
      }
    },
    [api],
  )

  const confirmReport = useCallback(async () => {
    if (!report || reportHeld(report.draft, report.today, can, report.busy)) return
    // The tab is taken in the click (a pop-up blocker lets it through), filled once the file is stored.
    const tab = can.files ? window.open('', '_blank') : null
    setReport({ ...report, busy: true, problem: null })
    try {
      const done = await makeTraceReport(api, reportBodyOf(lotId, report.draft))
      setReport((current) => (current ? { ...current, busy: false, done } : current))
      if (tab) void openFile(done.file.id, tab)
      void loadReports()
    } catch (error) {
      tab?.close()
      const path = isApiError(error) ? (error.issues.map((issue) => (typeof issue.path === 'string' ? issue.path : '')).find((entry) => entry.startsWith('body/')) ?? '') : ''
      const field = path.split('/')[1]
      setReport((current) =>
        current
          ? {
              ...current,
              busy: false,
              problem: field && ['recipient', 'reference', 'requestedOn', 'asOf', 'note'].includes(field) ? phrase(`ld.report.problem.${field}`, { today: current.today }) : isApiError(error) && (error.kind === 'forbidden' || error.kind === 'step_up') ? phrase('ld.report.held.noRight') : readProblem(error) === 'problem.offline' ? phrase('ld.report.offline') : phrase('ld.report.failed'),
            }
          : current,
      )
    }
  }, [api, lotId, report, can, openFile, loadReports])

  const model: LotDepthModel = { can, depth, reports, attributes, split, report, checking, notice }
  const actions: LotDepthActions = {
    onRetry: () => void load(),
    onRetryReports: () => void loadReports(),
    onCheck: () => void check(),
    onAttributes: (open) => setAttributes(open && value ? { draft: attributeDraftOf(value.attributes.values, value.attributes.keys), busy: false, problem: null } : null),
    onAttributeDraft: (patch) => setAttributes((current) => (current ? { ...current, draft: { ...current.draft, ...patch }, problem: null } : current)),
    onSaveAttributes: () => void saveAttributesNow(),
    onSplit: (open) => (open ? void readSplit() : setSplit(null)),
    onRetrySplit: () => void readSplit(),
    onSplitDraft: (next) => setSplit((current) => (current ? { ...current, draft: next, problem: null } : current)),
    onConfirmSplit: () => void confirmSplit(),
    onReport: (open) => (open ? openReport() : setReport(null)),
    onReportDraft: (patch) => setReport((current) => (current ? { ...current, draft: { ...current.draft, ...patch }, problem: null } : current)),
    onConfirmReport: () => void confirmReport(),
    onOpenFile: (fileId) => void openFile(fileId),
    onDismissNotice: () => setNotice(null),
  }
  /** A live change of the lot (lot.lifecycle_changed, lot.split, lot.attributes_changed, lot.trace_report_made): read again. */
  const reread = useCallback(() => {
    void load()
    if (asked.current) void loadReports()
  }, [load, loadReports])
  return { model, actions, reread }
}
