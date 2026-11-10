'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { openPreview } from '../../../admin/users/partners/preview'
import { csvLine, downloadText, liveMatches, useLive } from '../../../quality/_shared/hooks'
import { failedRead, problemKey, ready, reading, type Notice, type Read } from '../../../quality/_shared/model'
import { listProfiles } from '../profiles/api'
import { toAsk } from '../profiles/model'
import { DEPTH_NAMESPACE } from '../substances/frame/parts'
import {
  acceptRequest,
  answerRequest,
  askAgain,
  cancelRequest,
  fileBytes,
  getRequest,
  listRequests,
  refuseRequest,
  remindRequest,
  reviewAsk,
  sendAsk,
  uploadAnswerFile,
  writeLines,
  type DeclarationKind,
  type DeclarationList,
  type DeclarationRecord,
  type DeclarationRequest,
} from './api'
import {
  askBodyOf,
  blankAsk,
  declarationsAddressOf,
  declarationsAddressText,
  declarationsCan,
  declarationsCsv,
  remindHeld,
  suggestedKinds,
  todayInRome,
  withDeclarations,
  writeProblemKey,
  type AskMaterialOption,
  type DeclarationsAddress,
  type RecordTab,
} from './model'
import type { AnswerDraft, AskModel, LineDraft, PageFrame, VerbDialog } from './view-model'
import { DeclarationsView } from './view/DeclarationsView'

const EVENTS = ['compliance_material_tests.', 'supplier_document.']

const lineDraftOf = (line: DeclarationRecord['request']['lineRows'][number]): LineDraft => ({
  lineId: line.id,
  answer: line.contains === null ? '' : !line.contains ? 'none' : line.aboveThreshold ? 'above' : 'below',
  substanceName: line.substanceName ?? line.substance?.name ?? '',
  concentration: line.concentration ?? '',
})

/**
 * `?view=declarations` of Compliance › Tests & substances (B-W2b-267 on B-W2b-256's API): the list (GET
 * /compliance/declarations-asked with the address's filters), the record (`open`, its tab, the answer's file read for the
 * viewer only on the Answer tab), Request declarations (`ask=1`: the materials from the profiles' list, the review as a dry
 * run, then ONE send), and every verb as one write with its own Idempotency-Key, at the version read (a 409 reads again and
 * says so). Live: `compliance_material_tests.*` and the supplier's uploads count as "N updates · Show" and re-read the open
 * record; rows never move under the cursor.
 */
export function DeclarationsPanel({ frame }: { frame: PageFrame }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const t = useT(DEPTH_NAMESPACE)
  const can = useMemo(() => declarationsCan(session.permissions), [session.permissions])
  const address = useMemo(() => declarationsAddressOf(params), [params])
  const prefix = pathname.replace(/\/compliance\/tests\/?$/, '')
  const today = useMemo(() => todayInRome(), [])

  const [list, setList] = useState<Read<DeclarationList>>(reading())
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialog, setDialog] = useState<VerbDialog | null>(null)
  const [online, setOnline] = useState(true)
  const [record, setRecord] = useState<Read<DeclarationRecord>>(reading())
  const [pdf, setPdf] = useState<Read<string | Uint8Array> | null>(null)
  const [lines, setLines] = useState<readonly LineDraft[] | null>(null)
  const [answer, setAnswer] = useState<AnswerDraft | null>(null)
  const [answerFile, setAnswerFile] = useState<File | null>(null)
  const [validTo, setValidTo] = useState('')
  const [reason, setReason] = useState('')
  const [recordProblem, setRecordProblem] = useState<string | null>(null)
  const [ask, setAsk] = useState<Omit<AskModel, 'today'> | null>(null)
  const turns = useRef({ list: 0, record: 0 })

  useEffect(() => {
    const update = () => setOnline(typeof navigator === 'undefined' || navigator.onLine !== false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  // Opening or closing the record (or the dialog) is a step of its own: Back closes it; J / K, a filter or a tab replace the address.
  const go = useCallback(
    (change: Partial<DeclarationsAddress>) => {
      const next = `${pathname}${declarationsAddressText(withDeclarations(address, change))}`
      const step = (change.open !== undefined && (change.open === null) !== (address.open === null)) || (change.ask !== undefined && change.ask !== address.ask)
      if (step) router.push(next, { scroll: false })
      else router.replace(next, { scroll: false })
    },
    [router, pathname, address],
  )

  // ---- the list -------------------------------------------------------------------------------------------------------------
  const { shown, kind, q: words } = address
  const readList = useCallback(async () => {
    if (!can.view) return
    const turn = ++turns.current.list
    try {
      const value = await listRequests(api, { shown, kind, q: words })
      if (turn !== turns.current.list) return
      setList(ready(value))
      setAsOf(value.asOf)
      setUpdates(0)
      setSelected((current) => current.filter((id) => value.requests.some((row) => row.id === id)))
    } catch (error) {
      if (turn === turns.current.list) setList(failedRead(problemKey(error)))
    }
  }, [api, can.view, shown, kind, words])
  useEffect(() => {
    const timer = setTimeout(() => void readList(), words ? 250 : 0)
    return () => clearTimeout(timer)
  }, [readList, words])

  // ---- the record -----------------------------------------------------------------------------------------------------------
  const openId = address.open
  const readRecord = useCallback(async () => {
    if (!openId || !can.view) return
    const turn = ++turns.current.record
    try {
      const value = await getRequest(api, openId)
      if (turn !== turns.current.record) return
      setRecord(ready(value))
      setValidTo((current) => current || value.request.upload?.expiresOn || value.request.validTo || '')
    } catch (error) {
      if (turn === turns.current.record) setRecord(failedRead(problemKey(error)))
    }
  }, [api, can.view, openId])
  useEffect(() => {
    setRecord(reading())
    setPdf(null)
    setLines(null)
    setAnswer(null)
    setAnswerFile(null)
    setValidTo('')
    setReason('')
    setRecordProblem(null)
    void readRecord()
  }, [readRecord])
  const fileId = record.value?.request.file?.fileId ?? null
  useEffect(() => {
    if (address.tab !== 'answer' || !fileId) return
    let gone = false
    setPdf(reading())
    fileBytes(api, fileId)
      .then((bytes) => !gone && setPdf(ready(bytes)))
      .catch((error) => !gone && setPdf(failedRead(problemKey(error))))
    return () => {
      gone = true
    }
  }, [api, address.tab, fileId])

  // ---- live -----------------------------------------------------------------------------------------------------------------
  const readers = useRef({ readList, readRecord })
  readers.current = { readList, readRecord }
  const live = useLive(
    (change) => {
      if (!can.view || !liveMatches(change, EVENTS)) return
      setUpdates((count) => count + 1)
      if (openId) void readers.current.readRecord()
    },
    () => {
      void readers.current.readList()
      void readers.current.readRecord()
    },
  )

  // ---- Request declarations -------------------------------------------------------------------------------------------------
  const askOpen = address.ask
  const itemsKey = address.items.join(',')
  const kindsKey = address.kinds.join(',')
  useEffect(() => {
    if (!askOpen || !can.view) {
      setAsk(null)
      return
    }
    let gone = false
    const items = itemsKey ? itemsKey.split(',') : []
    const kinds = (kindsKey ? kindsKey.split(',') : []) as DeclarationKind[]
    setAsk({ draft: blankAsk(today, items, kinds), options: reading(), review: null, result: null, problem: null })
    listProfiles(api, {})
      .then((answer) => {
        if (gone) return
        const options: AskMaterialOption[] = answer.profiles.map((row) => ({ itemId: row.material.id, code: row.material.code, name: row.material.name, kind: row.material.kind, supplier: row.supplier, missing: toAsk(row) }))
        setAsk((current) => (current ? { ...current, options: ready(options), draft: kinds.length === 0 && items.length > 0 ? { ...current.draft, kinds: suggestedKinds(options, items) } : current.draft } : current))
      })
      .catch((error) => !gone && setAsk((current) => (current ? { ...current, options: failedRead(problemKey(error)) } : current)))
    return () => {
      gone = true
    }
  }, [api, askOpen, can.view, itemsKey, kindsKey, today])

  const reviewNow = async () => {
    if (!ask) return
    const body = askBodyOf(ask.draft)
    setAsk({ ...ask, draft: { ...ask.draft, step: 'review' }, review: reading(), problem: null })
    try {
      const value = await reviewAsk(api, body)
      setAsk((current) => (current ? { ...current, review: ready(value) } : current))
    } catch (error) {
      setAsk((current) => (current ? { ...current, review: failedRead(problemKey(error)) } : current))
    }
  }
  const askKey = useRef<string | null>(null)
  const sendNow = async () => {
    if (!ask || busy) return
    setBusy(true)
    askKey.current = askKey.current ?? newIdempotencyKey()
    try {
      const value = await sendAsk(api, askBodyOf(ask.draft), askKey.current)
      askKey.current = null
      setAsk({ ...ask, draft: { ...ask.draft, step: 'done' }, result: value, problem: null })
      void readList()
    } catch (error) {
      askKey.current = null
      setAsk({ ...ask, problem: writeProblemKey('ask', error) })
    } finally {
      setBusy(false)
    }
  }

  // ---- verbs ----------------------------------------------------------------------------------------------------------------
  const rows = list.value?.requests ?? []
  const byId = (id: string): DeclarationRequest | null => rows.find((row) => row.id === id) ?? (record.value?.request.id === id ? record.value.request : null)
  const afterWrite = (request: DeclarationRequest | null) => {
    void readList()
    if (request && request.id === openId) void readRecord()
  }

  const remind = async (ids: readonly string[]) => {
    const targets = ids.map(byId).filter((row): row is DeclarationRequest => row !== null && remindHeld(row, can, online) === null)
    if (targets.length === 0) return
    setBusy(true)
    let done = 0
    let failed = 0
    for (const row of targets) {
      try {
        await remindRequest(api, row)
        done += 1
      } catch {
        failed += 1
      }
    }
    setBusy(false)
    setNotice(failed === 0 ? { key: 'done.reminded', params: { count: done }, tone: 'success' } : { key: 'done.remindedSome', params: { count: done, failed }, tone: 'warning' })
    setSelected([])
    afterWrite(targets.length === 1 ? targets[0]! : null)
  }

  const write = async (verb: string, work: () => Promise<unknown>, success: Notice, request: DeclarationRequest | null, inRecord = false) => {
    setBusy(true)
    setRecordProblem(null)
    try {
      await work()
      setNotice(success)
      afterWrite(request)
      return true
    } catch (error) {
      const key = writeProblemKey(verb, error)
      if (inRecord) setRecordProblem(key)
      else setNotice({ key, tone: 'danger' })
      afterWrite(request)
      return false
    } finally {
      setBusy(false)
    }
  }

  const cancelConfirm = async () => {
    if (dialog?.kind !== 'cancel') return
    const request = byId(dialog.id)
    if (!request) return
    const ok = await write('cancel', () => cancelRequest(api, request, dialog.reason, newIdempotencyKey()), { key: 'done.cancelled', params: { number: request.number }, tone: 'success' }, request)
    if (ok) setDialog(null)
  }
  const askAgainConfirm = async () => {
    if (dialog?.kind !== 'askAgain') return
    const request = byId(dialog.id)
    if (!request) return
    const every = dialog.reminderEveryDays.trim()
    let made: string | null = null
    const ok = await write(
      'askAgain',
      async () => {
        const answer = await askAgain(api, request, { dueOn: dialog.dueOn, reminderEveryDays: every === '' ? null : Number(every), message: dialog.message }, newIdempotencyKey())
        made = answer.request.number
      },
      { key: 'done.askedAgain', params: { number: request.number }, tone: 'success' },
      request,
    )
    if (ok) {
      setDialog(null)
      if (made) setNotice({ key: 'done.askedAgainAs', params: { number: request.number, made }, tone: 'success' })
    }
  }

  const detail = record.value?.request ?? null
  const accept = async (andNext: boolean) => {
    if (!detail) return
    const ids = rows.map((row) => row.id)
    const next = ids[ids.indexOf(detail.id) + 1] ?? null
    const ok = await write('accept', () => acceptRequest(api, detail, { validTo: validTo || null }, newIdempotencyKey()), { key: 'done.accepted', params: { number: detail.number }, tone: 'success' }, detail, true)
    if (ok && andNext && next) go({ open: next, tab: 'decision' })
  }
  const refuse = async () => {
    if (!detail) return
    const ok = await write('refuse', () => refuseRequest(api, detail, reason, newIdempotencyKey()), { key: 'done.refused', params: { number: detail.number }, tone: 'success' }, detail, true)
    if (ok) setReason('')
  }
  const saveLines = async () => {
    if (!detail || !lines) return
    const body = lines.map((line) => ({
      lineId: line.lineId,
      contains: line.answer === '' ? null : line.answer !== 'none',
      aboveThreshold: line.answer === 'above' ? true : line.answer === 'below' ? false : null,
      substanceName: line.answer === 'above' || line.answer === 'below' ? line.substanceName.trim() || null : null,
      concentration: line.answer === 'above' || line.answer === 'below' ? line.concentration.trim().replace(',', '.') || null : null,
      concentrationUnit: (line.answer === 'above' || line.answer === 'below') && line.concentration.trim() ? (detail.kind === 'REACH_SVHC' ? ('PERCENT_WW' as const) : ('MG_KG' as const)) : null,
    }))
    const ok = await write('lines', () => writeLines(api, detail, body, newIdempotencyKey()), { key: 'done.lines', params: { number: detail.number }, tone: 'success' }, detail, true)
    if (ok) setLines(null)
  }
  const saveAnswer = async () => {
    if (!detail || !answer || !answerFile) return
    const ok = await write(
      'answer',
      async () => {
        const id = await uploadAnswerFile(api, detail, answerFile)
        await answerRequest(api, detail, { fileId: id, validTo: answer.validTo || null }, newIdempotencyKey())
      },
      { key: 'done.answered', params: { number: detail.number }, tone: 'success' },
      detail,
      true,
    )
    if (ok) {
      setAnswer(null)
      setAnswerFile(null)
    }
  }
  const takeUpload = async () => {
    if (!detail) return
    await write('take', () => answerRequest(api, detail, {}, newIdempotencyKey()), { key: 'done.answered', params: { number: detail.number }, tone: 'success' }, detail, true)
  }
  const preview = async (request: DeclarationRequest) => {
    try {
      await openPreview(api, request.party.id, `/p/${encodeURIComponent(request.party.code)}/documents`)
    } catch (error) {
      setNotice({ key: writeProblemKey('preview', error), tone: 'danger' })
    }
  }
  const exportRows = (chosen: readonly DeclarationRequest[]) => {
    downloadText(`supplier-declarations-${today}.csv`, declarationsCsv(chosen, t).map(csvLine).join('\r\n'))
    setNotice({ key: 'done.exported', params: { count: chosen.length }, tone: 'success' })
  }
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setNotice({ key: 'done.copied', params: { code: text }, tone: 'success' })
    } catch {
      setNotice({ key: 'done.copyFailed', tone: 'warning' })
    }
  }

  return (
    <DeclarationsView
      model={{
        prefix,
        can,
        online,
        today,
        frame,
        address,
        list,
        asOf,
        live,
        updates,
        selected,
        notice,
        record: openId ? { id: openId, read: record, pdf, lines, answer, validTo, reason, problem: recordProblem } : null,
        ask: ask ? { ...ask, today } : null,
        dialog,
        busy,
      }}
      actions={{
        onAddress: go,
        onRetry: () => void readList(),
        onShowUpdates: () => void readList(),
        onSelect: (ids) => setSelected([...ids]),
        onOpen: (id, tab?: RecordTab) => go({ open: id, tab: tab ?? (id === openId ? address.tab : 'request') }),
        onTab: (tab) => go({ tab }),
        onRetryRecord: () => void readRecord(),
        onRemind: (ids) => void remind(ids),
        onExport: exportRows,
        onDialog: setDialog,
        onCancelConfirm: () => void cancelConfirm(),
        onAskAgainConfirm: () => void askAgainConfirm(),
        onPreview: (request) => void preview(request),
        onCopy: (text) => void copy(text),
        onDismissNotice: () => setNotice(null),
        onLinesStart: () => detail && setLines(detail.lineRows.map(lineDraftOf)),
        onLinesChange: (next) => setLines([...next]),
        onLinesSave: () => void saveLines(),
        onLinesCancel: () => setLines(null),
        onAnswerStart: () => setAnswer({ fileName: null, validTo: '' }),
        onAnswerFile: (file) => {
          setAnswerFile(file)
          setAnswer((current) => ({ fileName: file.name, validTo: current?.validTo ?? '' }))
        },
        onAnswerChange: setAnswer,
        onAnswerSave: () => void saveAnswer(),
        onAnswerCancel: () => {
          setAnswer(null)
          setAnswerFile(null)
        },
        onTakeUpload: () => void takeUpload(),
        onValidTo: setValidTo,
        onReason: setReason,
        onAccept: (andNext) => void accept(andNext),
        onRefuse: () => void refuse(),
        onAskOpen: (items, kinds) => go({ ask: true, items: [...items], kinds: [...kinds] }),
        onAskChange: (draft) => setAsk((current) => (current ? { ...current, draft, review: draft.step === 'form' ? null : current.review } : current)),
        onAskReview: () => void reviewNow(),
        onAskBack: () => setAsk((current) => (current ? { ...current, draft: { ...current.draft, step: 'form' }, review: null, problem: null } : current)),
        onAskSend: () => void sendNow(),
        onAskClose: () => go({ ask: false, items: [], kinds: [] }),
      }}
    />
  )
}
