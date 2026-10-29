'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { StoreError } from '../../../../record-panels/store'
import { liveMatches, useLive, useRecordTab } from '../../../quality/_shared/hooks'
import { failedRead, problemKey, qualityCan, reading, ready, refusalLines, type Notice, type Read } from '../../../quality/_shared/model'
import { attachDocument, decideLot, downloadAddress, getLot, pickedFile, recordResult, type LotDecision, type LotDetail, type PickedFile, type RecordAnswer, type WorkOrderUse } from '../api'
import { blankDocument, blankResult, decimalText, RECORD_TABS, recordResultHeld, type DocumentDraft, type RecordDialog, type ResultDraft } from '../model'
import { LabMessages } from '../view/parts'
import { LotRecordView } from './view/LotRecordView'

/**
 * The lot record container (`/w/<company>/compliance/tests/<lotId>?tab=results|documents|release|activity`, SCR-054):
 * reads the lot (`GET /quality/lots/:lotId`: its results, documents, the rule in force and the release checklist for the
 * viewer), records a Cr VI result with its report (announce → the store → record), attaches a supplier document, takes
 * the decisions with the lot's version (release and reject with the typed code), and re-reads on the lot's live events.
 * `?act=result|release|reject|…` opens that dialog once the lot is read (the list's row verbs link here). The release
 * after a passing result is a second step that still asks for the typed code: nothing is ever released without it.
 */
export function LotRecord({ lotId }: { lotId: string }) {
  return (
    <LabMessages>
      <LotRecordContainer lotId={lotId} />
    </LabMessages>
  )
}

const WIDE = '(min-width: 1280px)'
const DOCK_KEY = 'fw.lab.dock'
const today = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const ACTS: readonly string[] = ['result', 'document', 'release', 'reject', 'block', 'unblock', 'clearHold']

/** The API's sentences of a refused result or document (`body/<field>`): data lines under our words. */
const issueLines = (error: unknown): string[] => (isApiError(error) ? error.issues.map((issue) => issue.message ?? '').filter((line) => line !== '') : [])

function LotRecordContainer({ lotId }: { lotId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const can = useMemo(() => qualityCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = useRecordTab(RECORD_TABS)
  const [detail, setDetail] = useState<Read<LotDetail>>(reading())
  const [asOf, setAsOf] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [resultDraft, setResultDraft] = useState<ResultDraft>(() => blankResult(today()))
  const [documentDraft, setDocumentDraft] = useState<DocumentDraft>(blankDocument())
  const [decideDraft, setDecideDraft] = useState({ code: '', reason: '' })
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [dialogLines, setDialogLines] = useState<readonly string[]>([])
  const [answer, setAnswer] = useState<Pick<RecordAnswer, 'effect' | 'trace'> | null>(null)
  const [blocked, setBlocked] = useState<readonly WorkOrderUse[] | null>(null)
  const [dockOpen, setDockOpen] = useState(false)
  const resultFile = useRef<PickedFile | null>(null)
  const documentFile = useRef<PickedFile | null>(null)
  const acted = useRef(false)

  const load = useCallback(async () => {
    if (!can.lotsView) return
    try {
      const read = await getLot(api, lotId)
      setDetail(ready(read))
      setAsOf(new Date().toISOString())
    } catch (error) {
      setDetail(failedRead(problemKey(error)))
    }
  }, [api, can.lotsView, lotId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    try {
      setDockOpen(window.localStorage.getItem(DOCK_KEY) === '1' && window.matchMedia(WIDE).matches)
    } catch {
      setDockOpen(false)
    }
  }, [])

  const live = useLive(
    (change) => {
      if (liveMatches(change, ['lot.']) && change.fields.lotId === lotId && !dialog) void load()
    },
    () => void load(),
  )

  const openDialog = useCallback((next: RecordDialog | null) => {
    setDialog(next)
    setDialogProblem(null)
    setDialogLines([])
    if (next?.kind === 'result') {
      setResultDraft(blankResult(today()))
      resultFile.current = null
    }
    if (next?.kind === 'document') {
      setDocumentDraft(blankDocument())
      documentFile.current = null
    }
    if (next?.kind === 'decide') setDecideDraft({ code: '', reason: '' })
  }, [])

  // `?act=` from the list's row verbs: open that dialog once, when the lot is read and the person may.
  const value = detail.value
  useEffect(() => {
    if (acted.current || !value) return
    const act = params?.get('act') ?? ''
    if (!ACTS.includes(act)) return
    acted.current = true
    if (act === 'result') {
      if (recordResultHeld(value.lot, can) === null) openDialog({ kind: 'result' })
    } else if (act === 'document') openDialog({ kind: 'document' })
    // A held decision opens too: its dialog says why in words (the open checks, the receiver).
    else openDialog({ kind: 'decide', decision: act as LotDecision })
    const search = new URLSearchParams(params?.toString() ?? '')
    search.delete('act')
    router.replace(`${pathname}${search.toString() ? `?${search}` : ''}`, { scroll: false })
  }, [can, openDialog, params, pathname, router, value])

  const saveResult = async () => {
    const lot = value?.lot
    const file = resultFile.current
    if (!lot || !file) return
    setBusy(true)
    setDialogProblem(null)
    setDialogLines([])
    const draft = resultDraft
    try {
      const done = await recordResult(
        api,
        lot.id,
        lot.version,
        {
          method: draft.method,
          valueMgKg: draft.belowDetectionLimit ? null : decimalText(draft.valueMgKg),
          belowDetectionLimit: draft.belowDetectionLimit,
          detectionLimitMgKg: draft.belowDetectionLimit ? decimalText(draft.detectionLimitMgKg) : null,
          lab: draft.lab.trim(),
          reportNumber: draft.reportNumber.trim() || null,
          testedOn: draft.testedOn,
          evidence: draft.evidence,
          article: draft.article.trim() || null,
          periodFrom: draft.periodFrom || null,
          periodTo: draft.periodTo || null,
          note: draft.note.trim() || null,
        },
        file,
      )
      setAnswer(done.trace ? { effect: done.effect, trace: done.trace } : null)
      setNotice({ key: done.result.verdict === 'PASS' ? 'done.resultPass' : done.trace ? 'done.resultLaterFail' : 'done.resultFail', params: { code: lot.code }, tone: done.result.verdict === 'PASS' ? 'success' : 'danger' })
      await load()
      if (draft.thenRelease && done.result.verdict === 'PASS' && done.lot.qualityStatus === 'QUARANTINE') openDialog({ kind: 'decide', decision: 'release' })
      else setDialog(null)
    } catch (error) {
      if (error instanceof StoreError) setDialogProblem('result.problem.upload')
      else if (isApiError(error) && error.kind === 'invalid') {
        setDialogProblem('result.problem.refused')
        setDialogLines(issueLines(error))
      } else if (isApiError(error) && error.kind === 'conflict') {
        setDialogProblem('result.problem.conflict')
        setDialogLines(issueLines(error))
        void load()
      } else setDialogProblem(problemFor(error))
    } finally {
      setBusy(false)
    }
  }

  const saveDocument = async () => {
    const lot = value?.lot
    const file = documentFile.current
    if (!lot || !file) return
    setBusy(true)
    setDialogProblem(null)
    try {
      await attachDocument(api, lot.id, { kind: documentDraft.kind, validTo: documentDraft.validTo || null, note: documentDraft.note.trim() || null }, file)
      setNotice({ key: 'done.document', params: { code: lot.code }, tone: 'success' })
      setDialog(null)
      await load()
    } catch (error) {
      if (error instanceof StoreError) setDialogProblem('result.problem.upload')
      else if (isApiError(error) && error.kind === 'invalid') setDialogProblem('document.problem.refused')
      else setDialogProblem(problemFor(error))
    } finally {
      setBusy(false)
    }
  }

  const decide = async (decision: LotDecision) => {
    const lot = value?.lot
    if (!lot) return
    setBusy(true)
    setDialogProblem(null)
    setDialogLines([])
    try {
      const done = await decideLot(api, lot.id, decision, { version: lot.version, confirmCode: decideDraft.code.trim(), reason: decideDraft.reason.trim() })
      setBlocked(decision === 'block' ? (done.trace?.workOrders ?? []) : null)
      setNotice({ key: `done.${decision}`, params: { code: lot.code }, tone: decision === 'reject' || decision === 'block' ? 'warning' : 'success' })
      setDialog(null)
      await load()
    } catch (error) {
      const checks = refusalLines(error, 'checks')
      if (checks.length > 0) {
        setDialogProblem('decide.problem.checks')
        setDialogLines(checks.map((line) => line.message))
        void load()
      } else if (isApiError(error) && error.kind === 'invalid') {
        setDialogProblem(error.issues.some((issue) => issuePath(issue).endsWith('confirmCode')) ? 'decide.problem.codeRefused' : 'decide.problem.refused')
        setDialogLines(issueLines(error))
      } else if (isApiError(error) && error.kind === 'conflict') {
        setDialogProblem('decide.problem.conflict')
        setDialogLines(issueLines(error))
        void load()
      } else setDialogProblem(problemFor(error))
    } finally {
      setBusy(false)
    }
  }

  const download = async (fileId: string) => {
    try {
      const href = await downloadAddress(api, fileId)
      const link = document.createElement('a')
      link.href = href
      link.rel = 'noopener'
      document.body.append(link)
      link.click()
      link.remove()
    } catch {
      setNotice({ key: 'done.downloadFailed', tone: 'warning' })
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

  const toggleDock = () => {
    let wide = false
    try {
      wide = window.matchMedia(WIDE).matches
    } catch {
      wide = false
    }
    if (!wide) {
      router.push(`${pathname}?tab=activity`)
      return
    }
    setDockOpen((current) => {
      const next = !current
      try {
        window.localStorage.setItem(DOCK_KEY, next ? '1' : '0')
      } catch {
        // Not kept on this device; the dock still toggles.
      }
      return next
    })
  }

  const lot = value?.lot ?? null
  const panels =
    lot && session.permissions.includes('threads.read') ? <RecordPanels record={{ type: 'Lot', id: lot.id, companyId: lot.companyId, siteId: lot.siteId }} title={lot.code} /> : null

  return (
    <LotRecordView
      model={{
        prefix,
        tab,
        detail,
        can,
        me: session.user.id,
        today: today(),
        asOf,
        live,
        notice,
        dialog,
        resultDraft,
        documentDraft,
        decideDraft,
        busy,
        dialogProblem,
        dialogLines,
        answer,
        blocked,
        dockOpen,
      }}
      panels={panels}
      actions={{
        onDialog: openDialog,
        onResultDraft: setResultDraft,
        onResultFile: (file) =>
          void pickedFile(file).then((picked) => {
            resultFile.current = picked
            setResultDraft((current) => ({ ...current, fileName: picked.name }))
          }),
        onSaveResult: () => void saveResult(),
        onDocumentDraft: setDocumentDraft,
        onDocumentFile: (file) =>
          void pickedFile(file).then((picked) => {
            documentFile.current = picked
            setDocumentDraft((current) => ({ ...current, fileName: picked.name }))
          }),
        onSaveDocument: () => void saveDocument(),
        onDecideDraft: setDecideDraft,
        onDecide: (decision) => void decide(decision),
        onDownload: (fileId) => void download(fileId),
        onCopy: (text) => void copy(text),
        onRetry: () => void load(),
        onDismissNotice: () => setNotice(null),
        onDock: toggleDock,
      }}
    />
  )
}

/** A failed write in the lab's words: the common kinds. */
function problemFor(error: unknown): string {
  if (!isApiError(error)) return 'write.problem.unavailable'
  switch (error.kind) {
    case 'forbidden':
      return 'write.problem.forbidden'
    case 'not_found':
      return 'write.problem.notFound'
    case 'signed_out':
      return 'write.problem.signedOut'
    case 'rate_limited':
      return 'write.problem.rateLimited'
    default:
      return 'write.problem.unavailable'
  }
}
