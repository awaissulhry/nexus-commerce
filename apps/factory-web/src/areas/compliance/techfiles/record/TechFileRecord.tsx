'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { AnnexIIIPoint, ItemState } from '@nexus/factory-domain/compliance/techfiles/rules'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useLocale } from '../../../../lib/i18n/provider'
import { companyPrefix } from '../../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { isStepUpCancelled, liveMatches, useLive, useRecordTab, useStepUp } from '../../../quality/_shared/hooks'
import {
  addItem,
  addRiskRow,
  archiveFile,
  completeFile,
  editFile,
  editItem,
  editRevision,
  editRiskRow,
  evidenceOptions,
  fileBytes,
  newRevision,
  planTest,
  readFile,
  readKeepers,
  readPacks,
  readParties,
  readProduction,
  readReports,
  readRisk,
  recordTest,
  removeItem,
  removePack,
  removeRevision,
  removeRiskRow,
  removeTest,
  reopenFile,
  sharePack,
  signRevision,
  uploadOnto,
  withdrawLink,
  type EvidenceRef,
  type FileRecord,
  type PacksAnswer,
  type Production,
  type ReportsAnswer,
  type RiskAnswer,
  type RiskRowBody,
} from '../api'
import {
  authorityAddress,
  emptyRecord,
  emptySchedule,
  emptyShare,
  failed,
  LOADING,
  newRiskRow,
  packWindowAddress,
  problemOf,
  ready,
  RECORD_TABS,
  recordAddress,
  refusalDetail,
  riskCellProblem,
  romeToday,
  shownAssessment,
  techfilesCan,
  unreviewState,
  valueOf,
  type Read,
  type RiskCell,
} from '../model'
import { useOnline } from '../use-online'
import { usePackDialog } from '../use-pack-dialog'
import type { Notice } from '../view/parts'
import { IDLE, optionKey, UPLOAD_CHOICE, type EvidenceDialog, type FileDialog, type Mark, type RiskUi, type ShareState, type TestDialog, type WithdrawState } from './view-model'
import { RecordLoadingView, RecordProblemView, TechFileRecordView } from './view/TechFileRecordView'

const WIDE = '(min-width: 1280px)'
const DOCK_KEY = 'fw.techfiles.dock'
const NO_RISK_UI: RiskUi = { shown: null, zone: null, marks: {}, selected: [], reasoning: null, reasoningMark: null, sign: null, writing: IDLE }

/** A refusal in our words with the API's sentences under it (a 409 in words: the open points, "kept until …"). */
const refused = (error: unknown, key?: string): Notice => ({ tone: 'danger', key: key && isApiError(error) && (error.kind === 'conflict' || error.kind === 'invalid') ? key : problemOf(error), detail: refusalDetail(error) })

/** A file's content type from its name (the viewer in a new tab needs one). */
const typeOf = (name: string): string => (/\.pdf$/i.test(name) ? 'application/pdf' : /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : 'application/octet-stream')

/**
 * A technical file's container (`/w/<company>/compliance/techfiles/<id>?tab=annex|risk|tests|production|pack|activity`,
 * SCR-120-file): reads the file (its Annex III points), and each tab's part once it is opened (risk, test reports, production
 * control, packs), each failing on its own; runs ONE write at a time per pop-up with the version read and an Idempotency-Key; a
 * 409 is said in our words with the API's sentences under it (the record read again). Signing and sending by link ask for a
 * fresh code (step-up) only when pressed. Live technical_file.* events read the part again — or, while a pop-up is open, say it
 * changed with Reload. `?share=<pack>` opens Send by link; `?rev=<id>` shows a risk revision.
 */
export function TechFileRecord({ fileId }: { fileId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => techfilesCan(session.permissions), [session.permissions])
  const tab = useRecordTab(RECORD_TABS)
  const online = useOnline()
  const today = romeToday()
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)

  const [record, setRecord] = useState<Read<FileRecord>>(LOADING)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(params?.get('created') === '1' ? { tone: 'success', key: 'done.created' } : null)
  const [changedAt, setChangedAt] = useState<string | null>(null)
  const [dockOpen, setDockOpen] = useState(false)
  const [fileDialog, setFileDialog] = useState<{ dialog: FileDialog; writing: typeof IDLE } | null>(null)
  const [keepers, setKeepers] = useState<Read<Awaited<ReturnType<typeof readKeepers>>> | null>(null)
  const [certificates, setCertificates] = useState<Read<Awaited<ReturnType<typeof evidenceOptions>>['options']> | null>(null)
  const [busyItem, setBusyItem] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<EvidenceDialog | null>(null)
  const evidenceFile = useRef<File | null>(null)
  const [risk, setRisk] = useState<Read<RiskAnswer> | null>(null)
  const [riskUi, setRiskUi] = useState<RiskUi>({ ...NO_RISK_UI, shown: params?.get('rev') ?? null })
  const [reports, setReports] = useState<Read<ReportsAnswer> | null>(null)
  const [production, setProduction] = useState<Read<Production> | null>(null)
  const [testDialog, setTestDialog] = useState<TestDialog | null>(null)
  const testFile = useRef<File | null>(null)
  const [packs, setPacks] = useState<Read<PacksAnswer> | null>(null)
  const [share, setShare] = useState<ShareState | null>(null)
  const [withdraw, setWithdraw] = useState<WithdrawState | null>(null)
  const file = valueOf(record)?.file ?? null

  // ---- reads ---------------------------------------------------------------------------------------------------------------

  const shownRef = useRef(false)
  shownRef.current = record.status === 'ready'
  const load = useCallback(async () => {
    try {
      const next = await readFile(api, fileId)
      setRecord(ready(next))
      setAsOf(new Date().toISOString())
      setChangedAt(null)
      setNotice((current) => (current?.key === 'record.reloadFailed' ? null : current))
    } catch (error) {
      // A later read that fails keeps the file on screen with its time, and says so.
      if (shownRef.current) setNotice({ tone: 'warning', key: 'record.reloadFailed' })
      else setRecord(failed(problemOf(error)))
    }
  }, [api, fileId])

  const loadRisk = useCallback(() => readRisk(api, fileId).then((value) => setRisk(ready(value)), (error) => setRisk((current) => (current?.status === 'ready' ? current : failed(problemOf(error))))), [api, fileId])
  const loadReports = useCallback(() => readReports(api, fileId).then((value) => setReports(ready(value)), (error) => setReports((current) => (current?.status === 'ready' ? current : failed(problemOf(error))))), [api, fileId])
  const loadProduction = useCallback(() => readProduction(api, fileId).then((value) => setProduction(ready(value)), (error) => setProduction((current) => (current?.status === 'ready' ? current : failed(problemOf(error))))), [api, fileId])
  const loadPacks = useCallback(() => readPacks(api, fileId).then((value) => setPacks(ready(value)), (error) => setPacks((current) => (current?.status === 'ready' ? current : failed(problemOf(error))))), [api, fileId])

  useEffect(() => {
    void load()
  }, [load])

  // Each tab's part is read when the tab is first opened (and the pack tab's when a pack pop-up needs it).
  useEffect(() => {
    if (tab === 'risk' && risk === null) {
      setRisk(LOADING)
      void loadRisk()
    }
    if (tab === 'tests' && reports === null) {
      setReports(LOADING)
      void loadReports()
    }
    if (tab === 'production' && production === null) {
      setProduction(LOADING)
      void loadProduction()
    }
    if (tab === 'pack' && packs === null) {
      setPacks(LOADING)
      void loadPacks()
    }
  }, [tab, risk, reports, production, packs, loadRisk, loadReports, loadProduction, loadPacks])

  useEffect(() => {
    try {
      setDockOpen(window.localStorage.getItem(DOCK_KEY) === '1' && window.matchMedia(WIDE).matches)
    } catch {
      setDockOpen(false)
    }
  }, [])

  // The one-off `?created=1` leaves the address once the notice shows.
  useEffect(() => {
    if (params?.get('created') !== '1') return
    const search = new URLSearchParams(params.toString())
    search.delete('created')
    router.replace(`${pathname}${search.toString() ? `?${search.toString()}` : ''}`, { scroll: false })
  }, [params, pathname, router])

  const pack = usePackDialog({
    api,
    can,
    language: locale,
    online,
    onBuilt: () => {
      void loadPacks()
      void load()
    },
  })

  const popUpOpen = !!fileDialog || !!evidence || !!testDialog || !!share || !!withdraw || !!riskUi.sign
  const popUp = useRef(popUpOpen)
  popUp.current = popUpOpen
  const styleId = file?.style.id ?? null

  const live = useLive(
    (change) => {
      if (!liveMatches(change, ['technical_file.'])) return
      const fields = change.fields
      const mine = fields.technicalFileId === fileId
      if (change.type === 'technical_file.pack_changed' && typeof fields.packId === 'string') pack.onLive(fields.packId)
      if ((change.type === 'technical_file.pack_changed' || change.type === 'technical_file.pack_requested') && mine && packs !== null) void loadPacks()
      if (change.type === 'technical_file.risk_changed' && mine && risk !== null) void loadRisk()
      if (change.type === 'technical_file.test_changed' && fields.styleId === styleId) {
        if (production !== null) void loadProduction()
        if (reports !== null) void loadReports()
      }
      if (mine || (change.type === 'technical_file.test_changed' && fields.styleId === styleId)) {
        if (popUp.current) setChangedAt(new Date().toISOString())
        else void load()
      }
    },
    () => {
      void load()
      if (risk !== null) void loadRisk()
      if (packs !== null) void loadPacks()
    },
  )

  // ---- Send by link follows `?share=<pack>` ----------------------------------------------------------------------------------

  const shareAsked = params?.get('share') ?? null
  useEffect(() => {
    if (!shareAsked) return
    if (packs === null) {
      setPacks(LOADING)
      void loadPacks()
      return
    }
    const found = valueOf(packs)?.packs.find((entry) => entry.id === shareAsked)
    if (found && (!share || share.packId !== found.id)) openShare(found.id)
  }, [shareAsked, packs])

  const openShare = (packId: string) => {
    const found = valueOf(packs)?.packs.find((entry) => entry.id === packId) ?? null
    setShare({ packId, draft: emptyShare(today, locale === 'it' ? 'it' : 'en', found?.recipientParty?.id ?? null), parties: can.parties ? LOADING : null, writing: IDLE, done: null })
    if (can.parties)
      readParties(api, '').then(
        (value) => setShare((current) => (current ? { ...current, parties: ready(value) } : current)),
        (error) => setShare((current) => (current ? { ...current, parties: failed(problemOf(error)) } : current)),
      )
  }

  const go = (patch: Record<string, string | null>) => {
    const search = new URLSearchParams(params?.toString() ?? '')
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) search.delete(key)
      else search.set(key, value)
    }
    router.replace(`${pathname}${search.toString() ? `?${search.toString()}` : ''}`, { scroll: false })
  }

  // ---- writes ----------------------------------------------------------------------------------------------------------------

  /** One write on the file record (an Annex III row, complete): the record after it, or a refusal said in words (read again). */
  const writeRecord = async (work: (current: FileRecord) => Promise<FileRecord>, done: string, params?: Notice['params']): Promise<boolean> => {
    const current = valueOf(record)
    if (!current) return false
    try {
      const next = await work(current)
      setRecord(ready(next))
      setAsOf(new Date().toISOString())
      setNotice({ tone: 'success', key: done, ...(params ? { params } : {}) })
      return true
    } catch (error) {
      setNotice(refused(error, 'refused.record'))
      if (isApiError(error) && error.kind === 'conflict') void load()
      return false
    }
  }

  const itemAction = async (itemId: string, action: 'review' | 'unreview' | 'clear' | 'remove') => {
    const current = valueOf(record)
    const item = current?.points.flatMap((point) => point.items).find((entry) => entry.id === itemId)
    if (!current || !item || busyItem) return
    setBusyItem(itemId)
    const key = newIdempotencyKey()
    const state: ItemState = action === 'review' ? 'REVIEWED' : action === 'unreview' ? unreviewState(item) : 'MISSING'
    await writeRecord(
      () =>
        action === 'remove'
          ? removeItem(api, fileId, itemId, item.version, key)
          : action === 'clear'
            ? editItem(api, fileId, itemId, { version: item.version, recordType: null, recordId: null, fileId: null, state: 'MISSING' }, key)
            : editItem(api, fileId, itemId, { version: item.version, state }, key),
      `done.item.${action}`,
      { letter: `(${item.point.charAt(0).toLowerCase()})` },
    )
    setBusyItem(null)
  }

  const openEvidence = (point: AnnexIIIPoint, itemId: string | null, mode: 'link' | 'na') => {
    evidenceFile.current = null
    setEvidence({ point, itemId, mode, options: LOADING, choice: '', note: '', upload: null, writing: IDLE })
    if (mode === 'link')
      evidenceOptions(api, fileId, point).then(
        (answer) => setEvidence((current) => (current && current.point === point ? { ...current, options: ready(answer.options) } : current)),
        (error) => setEvidence((current) => (current && current.point === point ? { ...current, options: failed(problemOf(error)) } : current)),
      )
  }

  const saveEvidence = async () => {
    const current = valueOf(record)
    if (!evidence || !current || evidence.writing.busy) return
    const state = evidence
    setEvidence({ ...state, writing: { busy: true, problem: null } })
    const item = state.itemId ? current.points.flatMap((point) => point.items).find((entry) => entry.id === state.itemId) ?? null : null
    try {
      let next: FileRecord
      const note = state.note.trim() || null
      if (state.mode === 'na') {
        const target = item ?? null
        if (target) next = await editItem(api, fileId, target.id, { version: target.version, recordType: null, recordId: null, fileId: null, state: 'NOT_APPLICABLE', note }, newIdempotencyKey())
        else {
          const added = await addItem(api, fileId, { point: state.point, note }, newIdempotencyKey())
          const row = added.record.points.flatMap((point) => point.items).find((entry) => entry.id === added.itemId)!
          next = await editItem(api, fileId, row.id, { version: row.version, state: 'NOT_APPLICABLE', note }, newIdempotencyKey())
        }
      } else {
        let ref: EvidenceRef
        if (state.choice === UPLOAD_CHOICE) {
          if (!evidenceFile.current) throw new Error('no file')
          const uploaded = await uploadOnto(api, { companyId: current.file.companyId, recordType: 'TechnicalFile', recordId: fileId, file: evidenceFile.current })
          ref = { fileId: uploaded }
        } else {
          const option = (valueOf(state.options) ?? []).find((entry) => optionKey(entry) === state.choice)
          if (!option) throw new Error('no option')
          ref = option.kind === 'FILE' ? { fileId: option.fileId } : { recordType: option.recordType, recordId: option.recordId }
        }
        next = item ? await editItem(api, fileId, item.id, { version: item.version, ...ref, ...(note ? { note } : {}) }, newIdempotencyKey()) : (await addItem(api, fileId, { point: state.point, ...ref, note }, newIdempotencyKey())).record
      }
      setRecord(ready(next))
      setAsOf(new Date().toISOString())
      setEvidence(null)
      setNotice({ tone: 'success', key: state.mode === 'na' ? 'done.item.na' : 'done.item.linked', params: { letter: `(${state.point.charAt(0).toLowerCase()})` } })
      if (reports !== null && (state.point === 'H_CALCULATIONS' || state.point === 'I_TEST_REPORTS')) void loadReports()
    } catch (error) {
      setEvidence((now) => (now ? { ...now, writing: { busy: false, problem: refused(error, 'refused.evidence') } } : now))
      if (isApiError(error) && error.kind === 'conflict') void load()
    }
  }

  const saveFileDialog = async () => {
    const current = valueOf(record)
    if (!fileDialog || !current || fileDialog.writing.busy) return
    const { dialog } = fileDialog
    setFileDialog({ dialog, writing: { busy: true, problem: null } })
    try {
      const version = current.file.version
      const key = newIdempotencyKey()
      const next =
        dialog.kind === 'edit'
          ? await editFile(
              api,
              fileId,
              {
                version,
                ...(current.file.status === 'OPEN' ? { certificateId: dialog.certificateId || null } : {}),
                keeperId: dialog.keeperId || null,
                note: dialog.note.trim() || null,
                ...(current.file.status === 'ARCHIVED' && dialog.retainUntil && dialog.retainUntil !== current.file.retainUntil ? { retainUntil: dialog.retainUntil } : {}),
              },
              key,
            )
          : dialog.kind === 'reopen'
            ? await reopenFile(api, fileId, { version, reason: dialog.reason.trim() }, key)
            : await archiveFile(api, fileId, { version, reason: dialog.reason.trim(), ...(dialog.retainUntil ? { retainUntil: dialog.retainUntil } : {}) }, key)
      setRecord(ready(next))
      setAsOf(new Date().toISOString())
      setFileDialog(null)
      setNotice({ tone: 'success', key: `done.${dialog.kind}`, params: { number: next.file.number } })
    } catch (error) {
      setFileDialog((now) => (now ? { ...now, writing: { busy: false, problem: refused(error, `refused.${dialog.kind}`) } } : now))
      if (isApiError(error) && error.kind === 'conflict') void load()
    }
  }

  // ---- the risk assessment ---------------------------------------------------------------------------------------------------

  const riskAnswer = valueOf(risk)
  const shown = riskAnswer ? shownAssessment(riskAnswer.assessments, riskUi.shown) : null
  const riskWrite = async (work: () => Promise<RiskAnswer>, done: string | null) => {
    setRiskUi((now) => ({ ...now, writing: { busy: true, problem: null } }))
    try {
      const next = await work()
      setRisk(ready(next))
      setRiskUi((now) => ({ ...now, writing: IDLE }))
      if (done) setNotice({ tone: 'success', key: done })
      void load()
      return next
    } catch (error) {
      setRiskUi((now) => ({ ...now, writing: { busy: false, problem: refused(error, 'refused.risk') } }))
      if (isApiError(error) && error.kind === 'conflict') void loadRisk()
      return null
    }
  }

  const setMark = (key: string, mark: Mark | null) =>
    setRiskUi((now) => {
      const marks = { ...now.marks }
      if (mark) marks[key] = mark
      else delete marks[key]
      return { ...now, marks }
    })

  const saveCell = (rowId: string, cell: RiskCell, value: string) => {
    if (!shown) return
    const row = shown.rows.find((entry) => entry.id === rowId)
    if (!row) return
    const text = value.trim()
    const before = cell === 'garmentZone' ? (row.garmentZone ?? '') : String(row[cell] ?? '')
    if (text === before) return
    const problem = riskCellProblem(cell, text)
    const key = `${rowId}:${cell}`
    if (problem) return setMark(key, { state: 'refused', problem })
    setMark(key, { state: 'saving' })
    const body: Partial<RiskRowBody> = cell === 'hazard' || cell === 'residualRisk' || cell === 'intendedUse' || cell === 'control' ? ({ [cell]: text } as Partial<RiskRowBody>) : ({ [cell]: text || null } as Partial<RiskRowBody>)
    editRiskRow(api, fileId, shown.id, rowId, { version: row.version, ...body }, newIdempotencyKey()).then(
      (next) => {
        setRisk(ready(next))
        setMark(key, { state: 'saved' })
        window.setTimeout(() => setMark(key, null), 1500)
      },
      (error) => {
        setMark(key, { state: isApiError(error) && error.kind === 'unavailable' ? 'unknown' : 'refused', problem: isApiError(error) && error.kind === 'conflict' ? 'problem.conflict' : problemOf(error) === 'problem.invalid' ? 'refused.cell' : problemOf(error) })
        if (isApiError(error) && error.kind === 'conflict') void loadRisk()
      },
    )
  }

  const saveReasoning = () => {
    if (!shown || riskUi.reasoning === null) return
    const text = riskUi.reasoning.trim()
    if (text === (shown.classReasoning ?? '')) return
    setRiskUi((now) => ({ ...now, reasoningMark: { state: 'saving' } }))
    editRevision(api, fileId, shown.id, { version: shown.version, classReasoning: text || null }, newIdempotencyKey()).then(
      (next) => {
        setRisk(ready(next))
        setRiskUi((now) => ({ ...now, reasoning: null, reasoningMark: { state: 'saved' } }))
      },
      (error) => setRiskUi((now) => ({ ...now, reasoningMark: { state: 'refused', problem: problemOf(error) } })),
    )
  }

  const sign = async () => {
    if (!shown || !riskUi.sign || riskUi.sign.writing.busy) return
    const typed = riskUi.sign
    setRiskUi((now) => (now.sign ? { ...now, sign: { ...now.sign, writing: { busy: true, problem: null } } } : now))
    const key = newIdempotencyKey()
    try {
      const answer = await guard('stepUp.sentence.sign', () => signRevision(api, fileId, shown.id, { version: shown.version, name: typed.name.trim(), function: typed.fn.trim() }, key))
      setRisk(ready(answer))
      setRiskUi((now) => ({ ...now, sign: null, shown: null }))
      setNotice({ tone: answer.reopened ? 'warning' : 'success', key: answer.reopened ? 'done.signedReopened' : 'done.signed', params: { revision: shown.revision } })
      void load()
    } catch (error) {
      const problem: Notice = isStepUpCancelled(error) ? { tone: 'info', key: 'stepUp.cancelled' } : refused(error, 'refused.sign')
      setRiskUi((now) => (now.sign ? { ...now, sign: { ...now.sign, writing: { busy: false, problem } } } : now))
    }
  }

  // ---- production control ------------------------------------------------------------------------------------------------------

  const saveTest = async () => {
    const current = valueOf(record)
    if (!testDialog || !current || testDialog.writing.busy) return
    const state = testDialog
    setTestDialog({ ...state, writing: { busy: true, problem: null } })
    const schedule = state.schedule
    const workOrder = schedule.workOrderId ? valueOf(production)?.batches.find((batch) => batch.workOrder.id === schedule.workOrderId) ?? null : null
    const plan = {
      styleId: current.file.style.id,
      // The file's company: a style of every company needs it (the API takes the style's own otherwise).
      companyId: current.file.companyId,
      ...(schedule.workOrderId ? { workOrderId: schedule.workOrderId } : schedule.batchNumber.trim() ? { batchNumber: schedule.batchNumber.trim() } : {}),
      test: schedule.test,
      testName: schedule.testName.trim() || null,
      standardClause: schedule.standardClause.trim() || null,
      frequency: schedule.frequency,
      sample: schedule.sample.trim() || null,
    }
    try {
      if (state.kind === 'schedule') {
        await planTest(api, { ...plan, dueOn: schedule.dueOn }, newIdempotencyKey())
        setNotice({ tone: 'success', key: 'done.scheduled', params: { test: schedule.testName.trim() || schedule.test } })
      } else {
        const fields = { result: state.record.result!, testedOn: state.record.testedOn, testedBy: state.record.testedBy.trim(), reportNumber: state.record.reportNumber.trim() || null, resultNote: state.record.resultNote.trim() || null }
        let test = state.testId ? valueOf(production)?.tests.find((entry) => entry.id === state.testId) ?? null : null
        // A test done without a plan: planned for the day it was tested, then recorded with its lab report.
        if (!test) test = await planTest(api, { ...plan, dueOn: state.record.testedOn }, newIdempotencyKey())
        const labReportFileId = testFile.current ? await uploadOnto(api, { companyId: test.companyId, recordType: 'ProductionControlTest', recordId: test.id, file: testFile.current }) : null
        await recordTest(api, test.id, { version: test.version, ...fields, ...(labReportFileId ? { labReportFileId } : {}) }, newIdempotencyKey())
        setNotice({ tone: fields.result === 'FAIL' ? 'warning' : 'success', key: fields.result === 'FAIL' ? 'done.recordedFail' : 'done.recorded', params: { workOrder: workOrder?.workOrder.number ?? '' } })
      }
      setTestDialog(null)
      testFile.current = null
      void loadProduction()
      if (reports !== null) void loadReports()
      void load()
    } catch (error) {
      setTestDialog((now) => (now ? { ...now, writing: { busy: false, problem: refused(error, `refused.test.${state.kind}`) } } : now))
      void loadProduction()
    }
  }

  // ---- files in a new tab ------------------------------------------------------------------------------------------------------

  const openFile = (id: string, name: string) => {
    const opened = window.open('', '_blank')
    fileBytes(api, id).then(
      (bytes) => {
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: typeOf(name) }))
        if (opened) opened.location.href = url
        else window.open(url, '_blank', 'noopener')
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      },
      (error) => {
        opened?.close()
        setNotice(refused(error))
      },
    )
  }

  if (record.status !== 'ready') {
    if (record.status === 'error') return <RecordProblemView problem={record.problem} prefix={prefix} onRetry={() => void load()} />
    return <RecordLoadingView />
  }

  const current = record.value
  const threads = session.permissions.includes('threads.read')
  const panels = threads ? <RecordPanels record={{ type: 'TechnicalFile', id: current.file.id, companyId: current.file.companyId, siteId: null }} title={`${current.file.number} · ${current.file.style.code}`} party={null} /> : undefined

  return (
    <TechFileRecordView
      model={{
        prefix,
        can,
        tab,
        record: current,
        asOf,
        live,
        online,
        today,
        notice,
        changedAt,
        dockOpen,
        fileDialog,
        keepers,
        certificates,
        busyItem,
        evidence,
        risk,
        riskUi,
        reports,
        production,
        testDialog,
        packs,
        share,
        withdraw,
        pack: pack.model,
        stepUp,
      }}
      panels={panels}
      actions={{
        onDismissNotice: () => setNotice(null),
        onReload: () => void load(),
        onDock: () => {
          let wide = false
          try {
            wide = window.matchMedia(WIDE).matches
          } catch {
            wide = false
          }
          if (!wide) return router.push(recordAddress(prefix, fileId, 'activity'))
          setDockOpen((now) => {
            try {
              window.localStorage.setItem(DOCK_KEY, now ? '0' : '1')
            } catch {
              // Not kept on this device; the dock still toggles.
            }
            return !now
          })
        },
        onRetry: (part) => {
          if (part === 'risk') {
            setRisk(LOADING)
            void loadRisk()
          } else if (part === 'reports') {
            setReports(LOADING)
            void loadReports()
          } else if (part === 'production') {
            setProduction(LOADING)
            void loadProduction()
          } else {
            setPacks(LOADING)
            void loadPacks()
          }
        },
        onComplete: () => void writeRecord((now) => completeFile(api, fileId, now.file.version, newIdempotencyKey()), 'done.completed', { number: current.file.number }),
        onFileDialog: (dialog) => {
          setFileDialog(dialog ? { dialog, writing: fileDialog?.writing ?? IDLE } : null)
          if (dialog?.kind === 'edit' && !fileDialog) {
            setKeepers(LOADING)
            readKeepers(api, fileId).then(
              (value) => setKeepers(ready(value)),
              (error) => setKeepers(failed(problemOf(error))),
            )
            if (current.file.status === 'OPEN') {
              setCertificates(LOADING)
              evidenceOptions(api, fileId, 'F_STANDARDS').then(
                (answer) => setCertificates(ready(answer.options)),
                (error) => setCertificates(failed(problemOf(error))),
              )
            }
          }
        },
        onFileSave: () => void saveFileDialog(),
        onPack: () => pack.open({ id: current.file.id, number: current.file.number, style: { code: current.file.style.code, name: current.file.style.name }, latestBatch: current.file.latestBatch?.batchNumber ?? null }),
        onEvidence: openEvidence,
        onEvidenceChange: (patch) => setEvidence((now) => (now ? { ...now, ...patch } : now)),
        onEvidenceFile: (chosen) => {
          evidenceFile.current = chosen
          setEvidence((now) => (now ? { ...now, upload: chosen ? { name: chosen.name, size: chosen.size, type: chosen.type } : null } : now))
        },
        onEvidenceSave: () => void saveEvidence(),
        onEvidenceClose: () => setEvidence(null),
        onItem: (itemId, action) => void itemAction(itemId, action),
        onOpenFile: openFile,
        onRevision: (assessmentId) => {
          setRiskUi((now) => ({ ...now, shown: assessmentId, selected: [], reasoning: null, reasoningMark: null }))
          go({ rev: assessmentId })
        },
        onNewRevision: () => void riskWrite(() => newRevision(api, fileId, { copyRows: true }, newIdempotencyKey()), 'done.revision').then(() => setRiskUi((now) => ({ ...now, shown: null }))),
        onRemoveRevision: () => {
          if (shown && shown.status === 'DRAFT') void riskWrite(() => removeRevision(api, fileId, shown.id, shown.version, newIdempotencyKey()), 'done.revisionRemoved').then(() => setRiskUi((now) => ({ ...now, shown: null })))
        },
        onZone: (zone) => setRiskUi((now) => ({ ...now, zone })),
        onCell: (rowId, cell, value) => saveCell(rowId, cell, value),
        onAddRow: () => {
          if (!shown) return
          void riskWrite(() => addRiskRow(api, fileId, shown.id, newRiskRow(shown.rows, riskUi.zone, { intendedUse: locale === 'it' ? 'Da descrivere' : 'To describe', control: locale === 'it' ? 'Da descrivere' : 'To describe' }), newIdempotencyKey()), null)
        },
        onRiskSelected: (ids) => setRiskUi((now) => ({ ...now, selected: ids })),
        onRemoveRows: async (ids) => {
          if (!shown) return
          let answer: RiskAnswer | null = null
          for (const id of ids) {
            const latest = valueOf(risk)?.assessments.find((entry) => entry.id === shown.id)?.rows.find((row) => row.id === id) ?? shown.rows.find((row) => row.id === id)
            if (!latest) continue
            answer = await riskWrite(() => removeRiskRow(api, fileId, shown.id, id, latest.version, newIdempotencyKey()), null)
            if (!answer) break
          }
          setRiskUi((now) => ({ ...now, selected: [] }))
          if (answer) setNotice({ tone: 'success', key: 'done.rowsRemoved', params: { count: ids.length } })
        },
        onReasoning: (text) => setRiskUi((now) => ({ ...now, reasoning: text, reasoningMark: null })),
        onReasoningSave: saveReasoning,
        onSign: (open) => setRiskUi((now) => ({ ...now, sign: open ? { name: session.user.displayName, fn: '', writing: IDLE } : null })),
        onSignChange: (patch) => setRiskUi((now) => (now.sign ? { ...now, sign: { ...now.sign, ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.fn !== undefined ? { fn: patch.fn } : {}) } } : now)),
        onSignSave: () => void sign(),
        onSchedule: (workOrderId) => {
          if (production === null) {
            setProduction(LOADING)
            void loadProduction()
          }
          setTestDialog({ kind: 'schedule', testId: null, schedule: emptySchedule(today, 'SEAM_STRENGTH', workOrderId), record: emptyRecord(today), writing: IDLE })
        },
        onRecord: (testId) => {
          testFile.current = null
          const planned = testId ? valueOf(production)?.tests.find((entry) => entry.id === testId) ?? null : null
          setTestDialog({ kind: 'record', testId, schedule: emptySchedule(today, planned?.test ?? 'SEAM_STRENGTH', planned?.workOrder?.id ?? null), record: emptyRecord(today), writing: IDLE })
        },
        onTestDraft: (patch) => setTestDialog((now) => (now ? { ...now, schedule: { ...now.schedule, ...patch.schedule }, record: { ...now.record, ...patch.record } } : now)),
        onTestFile: (chosen) => {
          testFile.current = chosen
          setTestDialog((now) => (now ? { ...now, record: { ...now.record, file: chosen ? { name: chosen.name, size: chosen.size, type: chosen.type } : null } } : now))
        },
        onTestSave: () => void saveTest(),
        onTestClose: () => setTestDialog(null),
        onRemoveTest: (testId) => {
          const test = valueOf(production)?.tests.find((entry) => entry.id === testId)
          if (!test) return
          removeTest(api, testId, test.version, newIdempotencyKey()).then(
            () => {
              setNotice({ tone: 'success', key: 'done.testRemoved' })
              void loadProduction()
            },
            (error) => setNotice(refused(error, 'refused.removeTest')),
          )
        },
        onOpenPdf: (packId) => window.open(packWindowAddress(prefix, packId), '_blank', 'noopener'),
        onAuthority: (packId) => window.open(authorityAddress(prefix, packId), '_blank', 'noopener'),
        onShare: (packId) => {
          if (packId) openShare(packId)
          else {
            setShare(null)
            if (shareAsked) go({ share: null })
          }
        },
        onShareDraft: (draft) => setShare((now) => (now ? { ...now, draft } : now)),
        onShareSave: async () => {
          if (!share || share.writing.busy) return
          const state = share
          setShare({ ...state, writing: { busy: true, problem: null } })
          const key = newIdempotencyKey()
          try {
            const draft = state.draft
            const answer = await guard('stepUp.sentence.share', () =>
              sharePack(
                api,
                state.packId,
                {
                  ...(draft.partyId ? { partyId: draft.partyId } : {}),
                  password: draft.password,
                  expiresOn: draft.expiresOn,
                  send: draft.send,
                  ...(draft.send ? { email: draft.email.trim(), language: draft.language, ...(draft.message.trim() ? { message: draft.message.trim() } : {}) } : {}),
                },
                key,
              ),
            )
            setPacks((now) => (now && now.status === 'ready' ? ready({ ...now.value, packs: now.value.packs.map((entry) => (entry.id === answer.pack.id ? answer.pack : entry)) }) : now))
            setShare((now) => (now ? { ...now, writing: IDLE, done: answer } : now))
          } catch (error) {
            const problem: Notice = isStepUpCancelled(error) ? { tone: 'info', key: 'stepUp.cancelled' } : refused(error, 'refused.share')
            setShare((now) => (now ? { ...now, writing: { busy: false, problem } } : now))
          }
        },
        onCopyUrl: (url) => void navigator.clipboard?.writeText(url).then(() => setNotice({ tone: 'success', key: 'done.copied' }), () => undefined),
        onWithdraw: (packId, linkId) => setWithdraw(linkId ? { packId, linkId, reason: '', writing: IDLE } : null),
        onWithdrawReason: (reason) => setWithdraw((now) => (now ? { ...now, reason } : now)),
        onWithdrawSave: () => {
          if (!withdraw || withdraw.writing.busy) return
          const state = withdraw
          setWithdraw({ ...state, writing: { busy: true, problem: null } })
          withdrawLink(api, state.packId, state.linkId, state.reason.trim() || null, newIdempotencyKey()).then(
            (next) => {
              setPacks((now) => (now && now.status === 'ready' ? ready({ ...now.value, packs: now.value.packs.map((entry) => (entry.id === next.id ? next : entry)) }) : now))
              setWithdraw(null)
              setNotice({ tone: 'success', key: 'done.withdrawn', params: { number: next.number } })
            },
            (error) => setWithdraw((now) => (now ? { ...now, writing: { busy: false, problem: refused(error, 'refused.withdraw') } } : now)),
          )
        },
        onRemovePack: (packId) => {
          const found = valueOf(packs)?.packs.find((entry) => entry.id === packId)
          if (!found) return
          removePack(api, packId, found.version, newIdempotencyKey()).then(
            () => {
              setNotice({ tone: 'success', key: 'done.packRemoved', params: { number: found.number } })
              void loadPacks()
            },
            (error) => setNotice(refused(error, 'refused.removePack')),
          )
        },
        pack: {
          ...pack.actions,
          onOpenPdf: (packId) => window.open(packWindowAddress(prefix, packId), '_blank', 'noopener'),
          onShare: (packId) => {
            pack.close()
            if (packs === null) {
              setPacks(LOADING)
              void loadPacks().then(() => go({ tab: 'pack', share: packId }))
            } else go({ tab: 'pack', share: packId })
          },
        },
        onStepUp: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
      }}
    />
  )
}
