'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { LABOUR_LIMITS } from '@nexus/factory-domain/production/labour/rules'
import { OFF_STANDARD_LIMITS } from '@nexus/factory-domain/production/offstandard/rules'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { linesFromFloor, whatYouSee } from '../../people/_shared/api'
import { useCoalesced, useLive } from '../_shared/hooks'
import { listRules } from '../settings/api'
import {
  answerDispute,
  approveBlock,
  approveBlocks,
  approveCorrection,
  closeDay,
  correctionRequest,
  figureAccess,
  findPeople,
  labourCounts,
  labourDay,
  labourDays,
  labourDispute,
  labourEdits,
  labourInbox,
  labourRecord,
  normalBlocks,
  offStandardBlock,
  offStandardCodes,
  offStandardCounts,
  openSheet,
  refuseCorrection,
  rejectBlock,
  reopenDay,
  scansAround,
  type BlockCounts,
  type InboxItem,
  type LabourCounts,
  type OffStandardCode,
  type Place,
} from './api'
import {
  addressOf,
  addressText,
  blockCorrection,
  chunks,
  isLabourChange,
  itemDayTarget,
  itemKey,
  LABOUR_NAMESPACE,
  LABOUR_NAMESPACES,
  labourCanOf,
  legalRowOf,
  lineDayOf,
  linesOffered,
  nextAfter,
  openOf,
  readProblem,
  writeProblem,
  type DayTarget,
  type ItemRecord,
  type LabourAddress,
  type LegalRow,
  type OpenItem,
  type Phrase,
} from './model'
import { LabourView, type LabourDialog, type LabourModel, type RejectTarget } from './view/LabourView'

const TIME_ZONE = 'Europe/Rome'
const PAGE = 200
const EDITS_PAGE = 100
/** Own writes come back as live messages: for this long they are not "updates". */
const OWN_WRITE_MS = 2500

const dayIn = (at: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)

/**
 * `/w/<company>/production/labour?kind=&line=&q=&open=&state=&from=&to=&editKind=&editFrom=&editTo=` (SCR-139, SCR-143): the
 * legal band first (the site's recorded basis, the API's own reading of its gate), then the tiles, the queue, the line days
 * and the changes of the top bar's site (all of the person's when none is chosen). Writes go to each kind's own route, with
 * the version read and a key per decision: a correction → the scans' approve / refuse, a dispute → this module's answer, a
 * block → its approve / reject, a day → close / reopen. Live: the tiles follow at once, the rows wait behind "N updates ·
 * Show". After a decision the next item opens. The Daily sheet's figures stay in its dialog and go when it closes.
 */
export function LabourPage() {
  return (
    <WithMessages namespaces={LABOUR_NAMESPACES}>
      <Container />
    </WithMessages>
  )
}

function Container() {
  const t = useT(LABOUR_NAMESPACE)
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/production\/labour\/?$/, '')
  const can = useMemo(() => labourCanOf(session.permissions), [session.permissions])
  const address = addressOf(params)
  const siteId = scope.siteId
  const where = useMemo(() => ({ siteId, lineId: address.line }), [siteId, address.line])

  const [legal, setLegal] = useState<readonly LegalRow[] | null>(null)
  const [counts, setCounts] = useState<LabourCounts | null>(null)
  const [blocks, setBlocks] = useState<BlockCounts | null>(null)
  const [rows, setRows] = useState<LabourModel['rows']>({ items: null, more: false, limitReached: false, problem: null })
  const [limit, setLimit] = useState(PAGE)
  const [updates, setUpdates] = useState(0)
  const [days, setDays] = useState<LabourModel['days']>({ items: null, from: null, to: null, problem: null })
  const [edits, setEdits] = useState<LabourModel['edits']>({ items: null, from: null, to: null, more: false, limitReached: false, problem: null })
  const [editLimit, setEditLimit] = useState(EDITS_PAGE)
  const [readLines, setReadLines] = useState<readonly Place[]>([])
  const [codes, setCodes] = useState<readonly OffStandardCode[] | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<LabourModel['notice']>(null)
  const [detail, setDetail] = useState<LabourModel['detail']>(null)
  const [dialog, setDialog] = useState<LabourDialog | null>(null)
  const readId = useRef(0)
  const dialogKey = useRef(newIdempotencyKey())
  const quietUntil = useRef(0)
  const rowsRef = useRef(rows.items)
  rowsRef.current = rows.items
  const addressRef = useRef(address)
  addressRef.current = address

  const go = useCallback((next: Partial<LabourAddress>) => router.replace(`${pathname}${addressText({ ...addressRef.current, ...next })}`), [router, pathname])

  // ---- reads ----------------------------------------------------------------------------------------------------------------

  const sites = useMemo(() => (scope.site ? [scope.site] : scope.sites), [scope.site, scope.sites])
  useEffect(() => {
    if (!can.view) return
    let live = true
    setLegal(null)
    void (async () => {
      const [rules, sights] = await Promise.all([can.settings ? listRules(api, scope.company?.id ?? null).catch(() => null) : Promise.resolve(null), Promise.all(sites.map((site) => whatYouSee(api, site.id).catch(() => null)))])
      if (!live) return
      setLegal(sites.map((site, index) => legalRowOf(site, rules?.find((entry) => entry.site.id === site.id)?.rules ?? null, sights[index] ?? null)))
    })()
    return () => {
      live = false
    }
  }, [api, can.settings, can.view, scope.company?.id, sites])

  const loadTiles = useCallback(() => {
    if (!can.view) return
    labourCounts(api, where)
      .then(setCounts)
      .catch(() => setCounts(null))
    if (can.blocks)
      offStandardCounts(api, where)
        .then(setBlocks)
        .catch(() => setBlocks(null))
  }, [api, can.blocks, can.view, where])

  const loadQueue = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    try {
      const page = await labourInbox(api, where, address.kind, limit)
      if (id !== readId.current) return
      setRows({ items: page.items, more: page.more, limitReached: limit >= LABOUR_LIMITS.rows, problem: null })
      setUpdates(0)
      setAsOf(new Date().toISOString())
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, limitReached: false, problem: readProblem(error) })
    }
  }, [api, address.kind, can.view, limit, where])

  const loadDays = useCallback(async () => {
    if (!can.view) return
    try {
      const answer = await labourDays(api, where, { from: address.from, to: address.to, state: address.state })
      setDays({ items: answer.days, from: answer.from, to: answer.to, problem: null })
    } catch (error) {
      setDays({ items: null, from: null, to: null, problem: readProblem(error) })
    }
  }, [api, address.from, address.state, address.to, can.view, where])

  const loadEdits = useCallback(async () => {
    if (!can.view) return
    try {
      const answer = await labourEdits(api, where, { from: address.editFrom, to: address.editTo, kind: address.editKind, limit: editLimit })
      setEdits({ items: answer.edits, from: answer.from, to: answer.to, more: answer.more, limitReached: editLimit >= LABOUR_LIMITS.rows, problem: null })
    } catch (error) {
      setEdits({ items: null, from: null, to: null, more: false, limitReached: false, problem: readProblem(error) })
    }
  }, [api, address.editFrom, address.editKind, address.editTo, can.view, editLimit, where])

  const loadAll = useCallback(() => {
    loadTiles()
    void loadQueue()
    void loadDays()
    void loadEdits()
  }, [loadDays, loadEdits, loadQueue, loadTiles])

  useEffect(() => loadTiles(), [loadTiles])
  useEffect(() => {
    void loadQueue()
  }, [loadQueue])
  useEffect(() => {
    void loadDays()
  }, [loadDays])
  useEffect(() => {
    void loadEdits()
  }, [loadEdits])

  useEffect(() => {
    if (!can.view) return
    let live = true
    linesFromFloor(api, siteId)
      .then((lines) => live && setReadLines(lines))
      .catch(() => live && setReadLines([]))
    return () => {
      live = false
    }
  }, [api, can.view, siteId])

  useEffect(() => {
    if (!can.blocks) return
    offStandardCodes(api)
      .then(setCodes)
      .catch(() => setCodes(null))
  }, [api, can.blocks])

  // ---- the item open in its DetailModal ------------------------------------------------------------------------------------------

  const readRecord = useCallback(
    async (open: OpenItem): Promise<ItemRecord> => {
      const item = (rowsRef.current ?? []).find((row) => row.kind === open.kind && row.id === open.id) ?? null
      if (open.kind === 'DISPUTE') return { kind: 'DISPUTE', dispute: await labourDispute(api, open.id) }
      if (open.kind === 'LINE_DAY') {
        const place = lineDayOf(open.id)!
        return { kind: 'LINE_DAY', day: (await labourDay(api, place.lineId, place.workDate)).day }
      }
      if (open.kind === 'OFF_STANDARD') return { kind: 'OFF_STANDARD', block: can.blocks ? await offStandardBlock(api, open.id) : null, item }
      const request = can.correct ? await correctionRequest(api, open.id) : null
      const scanId = request?.scanId ?? item?.recordId ?? null
      const record = scanId && can.view ? await labourRecord(api, scanId).catch(() => null) : null
      if (!request && !record) throw new Error('gone')
      const workOrderId = request?.workOrderId ?? item?.workOrder?.id ?? record?.workOrder.id ?? null
      const bundleId = request?.bundleId ?? item?.bundle?.id ?? record?.bundle.id ?? null
      const around = can.workOrders && workOrderId && bundleId ? await scansAround(api, workOrderId, bundleId).catch(() => null) : null
      return { kind: 'CORRECTION', request, record, around }
    },
    [api, can.blocks, can.correct, can.view, can.workOrders],
  )

  const readDetail = useCallback(
    async (key: string, quiet = false) => {
      const open = openOf(key)
      if (!open) {
        setDetail({ key, loaded: { status: 'notFound' } })
        return
      }
      if (!quiet) setDetail({ key, loaded: { status: 'loading' } })
      try {
        const value = await readRecord(open)
        setDetail((current) => (current && current.key !== key ? current : { key, loaded: { status: 'ready', value } }))
      } catch (error) {
        setDetail((current) => (current && current.key !== key ? current : { key, loaded: !isApiError(error) || error.kind === 'not_found' ? { status: 'notFound' } : { status: 'error', problem: readProblem(error) } }))
      }
    },
    [readRecord],
  )

  useEffect(() => {
    if (!address.open) {
      setDetail(null)
      return
    }
    if (detail?.key !== address.open) void readDetail(address.open)
  }, [address.open, readDetail])

  // ---- live ---------------------------------------------------------------------------------------------------------------------

  const refreshTiles = useCoalesced(() => {
    loadTiles()
    void loadDays()
    void loadEdits()
  }, 800)
  const live = useLive(
    (change) => {
      if (!isLabourChange(change.type)) return
      refreshTiles()
      if (Date.now() < quietUntil.current) return
      setUpdates((count) => count + 1)
    },
    () => loadAll(),
    can.view,
  )

  // ---- decisions ----------------------------------------------------------------------------------------------------------------

  const wrote = useCallback(() => {
    quietUntil.current = Date.now() + OWN_WRITE_MS
  }, [])

  const openDialog = useCallback((next: LabourDialog | null) => {
    setDialog((current) => {
      if (next && next.kind !== current?.kind) dialogKey.current = newIdempotencyKey()
      return next
    })
  }, [])

  /** A decision is done: the row goes, the next item opens when one was open (design "then the next item"). */
  const decided = useCallback(
    (key: string, words: Phrase) => {
      wrote()
      const keys = (rowsRef.current ?? []).map(itemKey)
      setRows((current) => (current.items ? { ...current, items: current.items.filter((item) => itemKey(item) !== key) } : current))
      setNotice({ tone: 'success', words })
      setAnnouncement(null)
      if (addressRef.current.open === key) go({ open: nextAfter(keys, key) })
      // A day may have become ready: the queue is read again (a read of one's own decision moves nothing unexpected).
      loadAll()
    },
    [go, loadAll, wrote],
  )

  const run = useCallback(
    async (write: () => Promise<unknown>, key: string, words: Phrase, onRefused: (problem: Phrase) => void) => {
      if (busy) return
      setBusy(true)
      setNotice(null)
      try {
        await write()
        decided(key, words)
      } catch (error) {
        onRefused(writeProblem(error))
        void loadQueue()
        loadTiles()
      } finally {
        setBusy(false)
      }
    },
    [busy, decided, loadQueue, loadTiles],
  )

  const refused = useCallback((problem: Phrase) => setNotice({ tone: 'danger', words: problem }), [])

  // A dispute's answer needs its record, and sits over it: from a row, the record opens first and the dialog follows.
  const pendingAnswer = useRef<{ key: string; outcome: 'UPHELD' | 'REJECTED' } | null>(null)
  const answerDialog = useCallback((key: string, outcome: 'UPHELD' | 'REJECTED') => openDialog({ kind: 'answer', open: key, draft: { outcome, answer: '', fix: { codeId: '', startedAt: '', endedAt: '' } }, problem: null }), [openDialog])
  const draftOf = useCallback(
    (outcome: 'UPHELD' | 'REJECTED', key: string) => {
      if (detail?.key === key && detail.loaded.status === 'ready') {
        answerDialog(key, outcome)
        return
      }
      pendingAnswer.current = { key, outcome }
      if (addressRef.current.open !== key) go({ open: key })
    },
    [answerDialog, detail, go],
  )
  useEffect(() => {
    const wanted = pendingAnswer.current
    if (!wanted || detail?.key !== wanted.key || detail.loaded.status !== 'ready') return
    pendingAnswer.current = null
    answerDialog(wanted.key, wanted.outcome)
  }, [answerDialog, detail])

  const approveItem = useCallback(
    (item: InboxItem) => {
      const key = itemKey(item)
      if (item.kind === 'CORRECTION') void run(() => approveCorrection(api, item.id, newIdempotencyKey()), key, { key: 'notice.corrected' }, refused)
      else if (item.kind === 'OFF_STANDARD') void run(() => approveBlock(api, item.id, item.version ?? 1, newIdempotencyKey()), key, { key: 'notice.approved' }, refused)
      else if (item.kind === 'DISPUTE') draftOf('UPHELD', key)
      else {
        const target = itemDayTarget(item)
        if (target) openDialog({ kind: 'close', days: [target], note: '', problem: null })
      }
    },
    [api, draftOf, openDialog, refused, run],
  )

  const rejectItem = useCallback(
    (item: InboxItem) => {
      const key = itemKey(item)
      if (item.kind === 'DISPUTE') draftOf('REJECTED', key)
      else if (item.kind === 'CORRECTION' || item.kind === 'OFF_STANDARD') openDialog({ kind: 'reject', target: { kind: item.kind, id: item.id, version: item.version, open: key }, reason: '', problem: null })
    },
    [draftOf, openDialog],
  )

  const openRecord = detail?.loaded.status === 'ready' ? detail.loaded.value : null

  const approveOpen = useCallback(() => {
    if (!detail || !openRecord) return
    const key = detail.key
    const open = openOf(key)
    if (!open) return
    if (openRecord.kind === 'CORRECTION') void run(() => approveCorrection(api, open.id, newIdempotencyKey()), key, { key: 'notice.corrected' }, refused)
    else if (openRecord.kind === 'OFF_STANDARD') {
      const version = openRecord.block?.version ?? openRecord.item?.version
      if (version) void run(() => approveBlock(api, open.id, version, newIdempotencyKey()), key, { key: 'notice.approved' }, refused)
    } else if (openRecord.kind === 'DISPUTE') draftOf('UPHELD', key)
    else {
      const day = openRecord.day
      openDialog({ kind: 'close', days: [{ lineId: day.line.id, lineCode: day.line.code, lineName: day.line.name, workDate: day.workDate, version: day.version }], note: '', problem: null })
    }
  }, [api, detail, draftOf, openDialog, openRecord, refused, run])

  const rejectOpen = useCallback(() => {
    if (!detail || !openRecord) return
    const key = detail.key
    const open = openOf(key)
    if (!open) return
    if (openRecord.kind === 'DISPUTE') draftOf('REJECTED', key)
    else if (openRecord.kind === 'CORRECTION') openDialog({ kind: 'reject', target: { kind: 'CORRECTION', id: open.id, version: null, open: key }, reason: '', problem: null })
    else if (openRecord.kind === 'OFF_STANDARD') openDialog({ kind: 'reject', target: { kind: 'OFF_STANDARD', id: open.id, version: openRecord.block?.version ?? openRecord.item?.version ?? null, open: key }, reason: '', problem: null })
  }, [detail, draftOf, openDialog, openRecord])

  const dialogRefused = useCallback((problem: Phrase) => setDialog((current) => (current && 'problem' in current ? { ...current, problem } : current)), [])

  const rejectSend = useCallback(() => {
    if (dialog?.kind !== 'reject') return
    const { target, reason } = dialog
    const words = reason.trim()
    const key = dialogKey.current
    const write = (entry: RejectTarget) => (entry.kind === 'CORRECTION' ? refuseCorrection(api, entry.id, words, key) : rejectBlock(api, entry.id, entry.version ?? 1, words, key))
    void run(
      async () => {
        await write(target)
        setDialog(null)
      },
      target.open,
      { key: target.kind === 'CORRECTION' ? 'notice.refused' : 'notice.rejected' },
      dialogRefused,
    )
  }, [api, dialog, dialogRefused, run])

  const answerSend = useCallback(() => {
    if (dialog?.kind !== 'answer' || openRecord?.kind !== 'DISPUTE') return
    const { dispute } = openRecord
    const { draft, open } = dialog
    const correction = blockCorrection(dispute, draft)
    void run(
      async () => {
        await answerDispute(api, dispute.id, { version: dispute.version, outcome: draft.outcome, answer: draft.answer.trim(), ...(correction ? { correction } : {}) }, dialogKey.current)
        setDialog(null)
      },
      open,
      { key: draft.outcome === 'UPHELD' ? (correction ? 'notice.upheldCorrected' : 'notice.upheld') : 'notice.disputeRejected' },
      dialogRefused,
    )
  }, [api, dialog, dialogRefused, openRecord, run])

  const closeSend = useCallback(async () => {
    if (dialog?.kind !== 'close' || busy) return
    const current = dialog
    setBusy(true)
    setNotice(null)
    let done = 0
    let first: Phrase | null = null
    const note = current.note.trim()
    for (const day of current.days) {
      try {
        await closeDay(api, day.lineId, day.workDate, { ...(day.version !== null ? { version: day.version } : {}), ...(note ? { note } : {}) }, `${dialogKey.current}:${day.lineId}:${day.workDate}`)
        done += 1
      } catch (error) {
        first = first ?? writeProblem(error)
      }
    }
    setBusy(false)
    wrote()
    const missed = current.days.length - done
    if (done === 0) setDialog({ ...current, problem: first })
    else {
      setDialog(null)
      if (missed > 0) setNotice({ tone: 'info', words: { key: 'notice.closedPartly', params: { done, refused: missed } }, ...(first ? { detail: [first] } : {}) })
      else setNotice({ tone: 'success', words: { key: 'notice.closed', params: { count: done } } })
    }
    const openKey = addressRef.current.open
    if (done > 0 && openKey?.startsWith('LINE_DAY:')) {
      const keys = (rowsRef.current ?? []).map(itemKey)
      go({ open: keys.includes(openKey) ? nextAfter(keys, openKey) : null })
    }
    loadAll()
  }, [api, busy, dialog, go, loadAll, wrote])

  const reopenSend = useCallback(async () => {
    if (dialog?.kind !== 'reopen' || busy) return
    const current = dialog
    setBusy(true)
    setNotice(null)
    try {
      await reopenDay(api, current.day.lineId, current.day.workDate, { version: current.day.version ?? 1, reason: current.reason.trim() }, dialogKey.current)
      wrote()
      setDialog(null)
      setNotice({ tone: 'success', words: { key: 'notice.reopened' } })
      if (addressRef.current.open) void readDetail(addressRef.current.open, true)
      loadAll()
    } catch (error) {
      setDialog({ ...current, problem: writeProblem(error) })
    } finally {
      setBusy(false)
    }
  }, [api, busy, dialog, loadAll, readDetail, wrote])

  const approveNormal = useCallback(
    async (items: readonly InboxItem[] | null) => {
      if (busy) return
      setBusy(true)
      setNotice(null)
      try {
        const targets = items ? items.map((item) => ({ id: item.id, version: item.version ?? 1 })) : await normalBlocks(api, where, OFF_STANDARD_LIMITS.perBulk)
        let approved = 0
        const skipped: Phrase[] = []
        for (const part of chunks(targets)) {
          const answer = await approveBlocks(api, part, newIdempotencyKey())
          approved += answer.approved.length
          for (const entry of answer.skipped) skipped.push(entry.unusual.length > 0 ? { key: 'notice.skipped', params: { code: entry.code, why: entry.unusual.map((reason) => t(`unusual.${reason}`)).join(', ') } } : { key: 'notice.skippedOther', params: { code: entry.code } })
        }
        wrote()
        const others = blocks?.unusual ?? 0
        const left: Phrase[] = [...skipped, ...(!items && others > 0 ? [{ key: 'notice.leftOut', params: { count: others } }] : [])]
        setNotice({ tone: approved > 0 ? 'success' : 'info', words: { key: 'notice.approvedN', params: { count: approved } }, ...(left.length > 0 ? { detail: left } : {}) })
      } catch (error) {
        setNotice({ tone: 'danger', words: writeProblem(error) })
      } finally {
        setBusy(false)
        loadAll()
      }
    },
    [api, blocks?.unusual, busy, loadAll, t, where, wrote],
  )

  // ---- the Daily sheet --------------------------------------------------------------------------------------------------------

  const openDay = useCallback(
    (person: { employeeId: string; name: string | null }, workDate: string) => {
      openDialog({ kind: 'sheet', person, workDate, access: { status: 'loading' }, reason: '', note: '', sheet: null, problem: null })
      dialogKey.current = newIdempotencyKey()
      figureAccess(api, person.employeeId)
        .then((value) => setDialog((current) => (current?.kind === 'sheet' ? { ...current, access: { status: 'ready', value } } : current)))
        .catch((error: unknown) => setDialog((current) => (current?.kind === 'sheet' ? { ...current, access: { status: 'error', problem: readProblem(error) } } : current)))
    },
    [api, openDialog],
  )

  const sheetOpen = useCallback(async () => {
    if (dialog?.kind !== 'sheet' || busy) return
    const current = dialog
    setBusy(true)
    try {
      const sheet = await openSheet(api, { employeeId: current.person.employeeId, workDate: current.workDate, ...(current.reason ? { reason: current.reason } : {}), ...(current.note.trim() ? { note: current.note.trim() } : {}) }, dialogKey.current)
      setDialog((now) => (now?.kind === 'sheet' ? { ...now, sheet, problem: null } : now))
    } catch (error) {
      setDialog((now) => (now?.kind === 'sheet' ? { ...now, problem: writeProblem(error) } : now))
    } finally {
      setBusy(false)
    }
  }, [api, busy, dialog])

  const findTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const find = useCallback(
    (query: string) => {
      setDialog((current) => (current?.kind === 'find' ? { ...current, query, person: null, hits: query.trim().length < 2 ? null : { status: 'loading' } } : current))
      if (findTimer.current) clearTimeout(findTimer.current)
      if (query.trim().length < 2) return
      findTimer.current = setTimeout(() => {
        findPeople(api, siteId, query.trim())
          .then((value) => setDialog((current) => (current?.kind === 'find' && current.query === query ? { ...current, hits: { status: 'ready', value } } : current)))
          .catch((error: unknown) => setDialog((current) => (current?.kind === 'find' && current.query === query ? { ...current, hits: { status: 'error', problem: readProblem(error) } } : current)))
      }, 300)
    },
    [api, siteId],
  )

  const today = dayIn(new Date())
  const model: LabourModel = {
    prefix,
    can,
    address,
    scope,
    timeZone: TIME_ZONE,
    today,
    legal,
    counts,
    blocks,
    rows,
    updates,
    days,
    edits,
    lines: linesOffered(readLines, [...(rows.items ?? []), ...(days.items ?? [])]),
    codes,
    asOf,
    live,
    announcement,
    busy,
    notice,
    detail,
    dialog,
    payrollHref: OFFICE_PAGES.has('/people/payroll') ? `${prefix}/people/payroll` : null,
  }

  return (
    <LabourView
      model={model}
      actions={{
        onAddress: (next) => {
          setNotice(null)
          go(next)
        },
        onRetry: () => loadAll(),
        onMore: () => setLimit((current) => Math.min(current + PAGE, LABOUR_LIMITS.rows)),
        onMoreEdits: () => setEditLimit((current) => Math.min(current + EDITS_PAGE, LABOUR_LIMITS.rows)),
        onShowUpdates: () => void loadQueue(),
        onApprove: approveItem,
        onReject: rejectItem,
        onApproveOpen: approveOpen,
        onRejectOpen: rejectOpen,
        onApproveNormal: (items) => void approveNormal(items),
        onCloseItems: (items) => {
          const targets = items.map(itemDayTarget).filter((target): target is DayTarget => target !== null)
          if (targets.length > 0) openDialog({ kind: 'close', days: targets, note: '', problem: null })
        },
        onDialog: openDialog,
        onRejectSend: rejectSend,
        onAnswerSend: answerSend,
        onCloseSend: () => void closeSend(),
        onReopenSend: () => void reopenSend(),
        onOpenDay: openDay,
        onFind: find,
        onSheetOpen: () => void sheetOpen(),
        onRetryDetail: () => {
          if (address.open) void readDetail(address.open)
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}

