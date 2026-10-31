'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { formatDateTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { csvLine, downloadText, isStepUpCancelled, liveMatches, useLive, useStepUp } from '../_shared/hooks'
import { listLots, type Lot } from '../_shared/lots'
import { failedRead, newNcrAddress, problemKey, qualityCan, ready, reading, type Notice, type Read } from '../_shared/model'
import { QualityMessages } from '../_shared/parts'
import { PlaceHold, type PlaceHoldPrefill } from '../holds/place/PlaceHold'
import {
  assignInspections,
  findCustomers,
  getReturn,
  gradeReturn,
  getRelease,
  getReleaseRule,
  getWorkOrderCells,
  listInspectableWorkOrders,
  listInspections,
  listInspectors,
  listReleases,
  listReturnsToInspect,
  openInspection,
  reverseRelease,
  saveReleaseRule,
  setInspectionsDue,
  type InspectionRow,
  type Inspectors,
  type PartyPick,
  type Release,
  type ReleaseDetail,
  type ReleaseRule,
  type ReturnPick,
  type ReturnRecord,
  type WorkOrderCells,
  type WorkOrderPick,
} from './api'
import {
  assigneeBody,
  assigneeValue,
  finishedOf,
  holdsAddressFor,
  INSPECTION_CSV_HEAD,
  inspectionCsvRow,
  isSerialRelease,
  LIST_EVENTS,
  NEW_DRAFT,
  nextLimit,
  ownCustomerIds,
  PAGE,
  planBody,
  releaseLabel,
  reversedOf,
  REVERSE_DRAFT,
  RETURN_DRAFT,
  returnBody,
  ruleDraftOf,
  ruleLoosens,
  TILES,
  viewFromAddress,
  viewKind,
  whoKey,
  type AssignState,
  type CellMark,
  type DueState,
  type ListDialog,
  type NewDraft,
  type ReverseAnswerWords,
  type ReturnDraft,
  type ReverseDraft,
  type RuleDraft,
  type TileCount,
  type TileId,
  type View,
} from './model'
import { InspectionsView } from './view/InspectionsView'

/**
 * The Inspections container (`/w/<company>/quality/inspections`, SCR-075): reads the view's rows (inspections, the reversed
 * releases, or the lots on hold), the tiles' counts (one read each, at most 200), the release rule in force, and a
 * release in its DetailModal (`?open=`); opens a new inspection (`?new=1`, `c`), saves the release rule (loosening asks a
 * reason, then the API asks a fresh code), takes released garments back (impact first), exports the selection as CSV,
 * and listens to the live stream: changes wait behind "N updates · Show" (rows never move under the cursor).
 */
export function InspectionsPage() {
  return (
    <QualityMessages>
      <InspectionsContainer />
    </QualityMessages>
  )
}

function InspectionsContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const t = useT('quality')
  const locale = useLocale()
  const can = useMemo(() => qualityCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? null
  const [view, setViewState] = useState<View>(() => viewFromAddress(params))
  const [limit, setLimit] = useState(PAGE)
  const [rows, setRows] = useState<Read<readonly InspectionRow[]>>(reading())
  const [releases, setReleases] = useState<Read<readonly Release[]>>(reading())
  const [lots, setLots] = useState<Read<readonly Lot[]>>(reading())
  const [tiles, setTiles] = useState<Partial<Record<TileId, TileCount>>>({})
  const [rule, setRule] = useState<Read<ReleaseRule>>(reading())
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [reverseAnswer, setReverseAnswer] = useState<ReverseAnswerWords | null>(null)
  const openId = params?.get('open') ?? null
  const [detail, setDetail] = useState<Read<ReleaseDetail>>(reading())
  const [dialog, setDialog] = useState<ListDialog | null>(() =>
    params?.get('new') === '1' && can.inspectionsRecord && can.workOrdersView ? { kind: 'new' } : params?.get('rules') === '1' ? { kind: 'rules' } : null,
  )
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [dialogLines, setDialogLines] = useState<readonly string[]>([])
  const [newDraft, setNewDraft] = useState<NewDraft>(NEW_DRAFT)
  const [workOrders, setWorkOrders] = useState<Read<readonly WorkOrderPick[]>>(reading())
  const [cells, setCells] = useState<Read<WorkOrderCells> | null>(null)
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | undefined>(undefined)
  const [customerSearch, setCustomerSearch] = useState<Read<readonly PartyPick[]> | null>(null)
  const [reverseDraft, setReverseDraft] = useState<ReverseDraft>(REVERSE_DRAFT)
  // W2a (B-W2a-67): Assign inspector (dialog and the inline cell), Place hold, Create NCR (B-W2a-68's New NCR), New inspection's inspector and Return kind.
  const [assign, setAssign] = useState<AssignState | null>(null)
  const [people, setPeople] = useState<Record<string, Read<Inspectors>>>({})
  const [marks, setMarks] = useState<Record<string, CellMark>>({})
  const [hold, setHold] = useState<PlaceHoldPrefill | null>(null)
  const [newPeople, setNewPeople] = useState<Read<Inspectors> | null>(null)
  const [returns, setReturns] = useState<Read<readonly ReturnPick[]> | null>(null)
  const [returnRecord, setReturnRecord] = useState<Read<ReturnRecord> | null>(null)
  const [returnDraft, setReturnDraft] = useState<ReturnDraft>(RETURN_DRAFT)
  // B-W2b-17: Set due date (the bulk dialog) and the inline Due cell.
  const [due, setDue] = useState<DueState | null>(null)
  const dueKey = useRef<string | null>(null)
  const assignKey = useRef<string | null>(null)
  const gradeKey = useRef<string | null>(null)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const request = useRef<AbortController | null>(null)
  const createKey = useRef<string | null>(null)
  const reverseKey = useRef<string | null>(null)
  const ruleKey = useRef<string | null>(null)
  const kind = viewKind(view)

  // Owner answer Q3: W1's "On hold" view moved to Quality › Holds; an old address goes there.
  const holdsAddress = holdsAddressFor(params)
  useEffect(() => {
    if (holdsAddress) router.replace(`${prefix}${holdsAddress}`)
  }, [holdsAddress, prefix, router])

  /** The address keeps the view and the open release (Back closes it; a copied address opens it). */
  const writeAddress = useCallback(
    (next: { view?: View; open?: string | null }) => {
      const query = new URLSearchParams()
      const nextView = next.view ?? view
      if (nextView !== 'all') query.set('view', nextView)
      const nextOpen = next.open === undefined ? openId : next.open
      if (nextOpen) query.set('open', nextOpen)
      const qs = query.toString()
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [openId, pathname, router, view],
  )

  const load = useCallback(async () => {
    if (!can.inspectionsView) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    try {
      if (kind === 'inspections') {
        const query = { status: view === 'open' ? ('OPEN' as const) : null, waitingRelease: view === 'waiting', failedUndecided: view === 'failed', mine: view === 'mine', overdue: view === 'overdue', limit }
        const answer = await listInspections(api, query, controller.signal)
        if (controller.signal.aborted) return
        setRows(ready(answer))
        setSelected((current) => current.filter((id) => answer.some((row) => row.id === id)))
      } else if (kind === 'releases') {
        const answer = await listReleases(api, { reversed: true, limit }, controller.signal)
        if (controller.signal.aborted) return
        setReleases(ready(answer))
        setSelected((current) => current.filter((id) => answer.some((row) => row.id === id)))
      } else if (can.lotsView) {
        const answer = await listLots(api, { onHold: true, limit }, controller.signal)
        if (controller.signal.aborted) return
        setLots(ready(answer))
        setSelected((current) => current.filter((id) => answer.some((row) => row.id === id)))
      } else {
        setLots(failedRead('problem.forbidden'))
      }
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') return
      const problem = failedRead<never>(problemKey(error))
      if (kind === 'inspections') setRows(problem)
      else if (kind === 'releases') setReleases(problem)
      else setLots(problem)
    }
  }, [api, can.inspectionsView, can.lotsView, kind, limit, view])

  const loadTiles = useCallback(async () => {
    if (!can.inspectionsView) return
    const counted = (rowsRead: readonly unknown[]): TileCount => ({ count: rowsRead.length, capped: rowsRead.length >= 200 })
    const readers: Record<TileId, () => Promise<TileCount>> = {
      open: async () => counted(await listInspections(api, { status: 'OPEN', limit: 200 })),
      overdue: async () => counted(await listInspections(api, { overdue: true, limit: 200 })),
      waiting: async () => counted(await listInspections(api, { waitingRelease: true, limit: 200 })),
      failed: async () => counted(await listInspections(api, { failedUndecided: true, limit: 200 })),
      reversed: async () => counted(await listReleases(api, { reversed: true, limit: 200 })),
      lots: async () => (can.lotsView ? counted(await listLots(api, { onHold: true, limit: 200 })) : { count: null, capped: false }),
    }
    await Promise.all(
      TILES.map(async (tile) => {
        try {
          const value = await readers[tile]()
          setTiles((current) => ({ ...current, [tile]: value }))
        } catch {
          setTiles((current) => ({ ...current, [tile]: { count: null, capped: false } }))
        }
      }),
    )
  }, [api, can.inspectionsView, can.lotsView])

  const loadRule = useCallback(async () => {
    if (!can.inspectionsView) return
    try {
      setRule(ready(await getReleaseRule(api, companyId)))
    } catch (error) {
      setRule(failedRead(problemKey(error)))
    }
  }, [api, can.inspectionsView, companyId])

  const loadDetail = useCallback(async () => {
    if (!openId || !can.inspectionsView) return
    setDetail(reading())
    try {
      setDetail(ready(await getRelease(api, openId)))
    } catch (error) {
      setDetail(failedRead(problemKey(error)))
    }
  }, [api, can.inspectionsView, openId])

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    void loadTiles()
    void loadRule()
  }, [loadTiles, loadRule])
  useEffect(() => {
    void loadDetail()
  }, [loadDetail])

  const live = useLive(
    (change) => {
      if (liveMatches(change, LIST_EVENTS) || liveMatches(change, ['quality.hold_', 'ncr.created'])) setUpdates((count) => count + 1)
      if (change.type === 'quality.release_rule_changed') void loadRule()
    },
    () => {
      void load()
      void loadTiles()
      void loadRule()
    },
  )

  // ---- New inspection: the work orders when it opens, the picked one's finished garments ----
  useEffect(() => {
    if (dialog?.kind !== 'new' || !can.workOrdersView) return
    setWorkOrders(reading())
    listInspectableWorkOrders(api)
      .then((list) => setWorkOrders(ready(list)))
      .catch((error: unknown) => setWorkOrders(failedRead(problemKey(error))))
  }, [api, can.workOrdersView, dialog?.kind])

  const pickWorkOrder = useCallback(
    async (workOrderId: string) => {
      setNewDraft((draft) => ({ ...draft, workOrderId, assignee: '' }))
      setCells(reading())
      const picked = (workOrders.value ?? []).find((wo) => wo.id === workOrderId)
      if (picked && can.inspectionsRecord) {
        setNewPeople(reading())
        listInspectors(api, picked.siteId, [workOrderId])
          .then((found) => setNewPeople(ready(found)))
          .catch((error: unknown) => setNewPeople(failedRead(problemKey(error))))
      }
      try {
        const answer = await getWorkOrderCells(api, workOrderId)
        setCells(ready(answer))
        const finished = finishedOf(answer)
        setNewDraft((draft) => (draft.workOrderId === workOrderId && draft.lotSize === '' && finished ? { ...draft, lotSize: String(finished) } : draft))
      } catch (error) {
        setCells(failedRead(problemKey(error)))
      }
    },
    [api, can.inspectionsRecord, workOrders.value],
  )

  // ---- New inspection › Return: the returns waiting for their inspection, the picked one's lines, the grades ----
  useEffect(() => {
    if (dialog?.kind !== 'new' || newDraft.kind !== 'RETURN' || !can.returnsView || returns !== null) return
    setReturns(reading())
    listReturnsToInspect(api)
      .then((found) => setReturns(ready(found)))
      .catch((error: unknown) => setReturns(failedRead(problemKey(error))))
  }, [api, can.returnsView, dialog?.kind, newDraft.kind, returns])

  const pickReturn = useCallback(
    (returnId: string) => {
      setReturnDraft({ returnId, lines: {} })
      setReturnRecord(reading())
      gradeKey.current = null
      getReturn(api, returnId)
        .then((record) => {
          setReturnRecord(ready(record))
          setReturnDraft((draft) => (draft.returnId === returnId ? { returnId, lines: Object.fromEntries(record.lines.map((line) => [line.id, { grade: line.grade ?? '', cause: line.cause ?? '', note: line.conditionNote ?? '' }])) } : draft))
        })
        .catch((error: unknown) => setReturnRecord(failedRead(problemKey(error))))
    },
    [api],
  )

  const gradeTheReturn = useCallback(async () => {
    const record = returnRecord?.value
    if (!record || !returnDraft.returnId) return
    setBusy(true)
    setDialogProblem(null)
    setDialogLines([])
    gradeKey.current ??= newIdempotencyKey()
    try {
      await gradeReturn(api, record.id, returnBody(returnDraft, record), gradeKey.current)
      gradeKey.current = null
      setDialog(null)
      setNotice({ key: 'new.return.done', tone: 'success', params: { number: record.number } })
      setReturns(null)
      setReturnRecord(null)
      setReturnDraft(RETURN_DRAFT)
    } catch (error) {
      if (!isApiError(error) || error.kind !== 'conflict') gradeKey.current = null
      setDialogProblem(isApiError(error) && (error.kind === 'invalid' || error.kind === 'conflict') ? 'new.return.problem.refused' : problemKey(error))
      if (isApiError(error)) setDialogLines(error.issues.map((issue) => issue.message ?? '').filter(Boolean))
    } finally {
      setBusy(false)
    }
  }, [api, returnDraft, returnRecord?.value])

  const create = useCallback(async () => {
    if (!newDraft.workOrderId) return
    setBusy(true)
    setDialogProblem(null)
    createKey.current ??= newIdempotencyKey()
    try {
      const inspection = await openInspection(
        api,
        { workOrderId: newDraft.workOrderId, ...planBody(newDraft), note: newDraft.note.trim() || null, ...(newDraft.assignee ? assigneeBody(newDraft.assignee) : {}), ...(newDraft.dueAt ? { dueAt: newDraft.dueAt } : {}) },
        createKey.current,
      )
      createKey.current = null
      setDialog(null)
      setNewDraft(NEW_DRAFT)
      router.push(`${prefix}/quality/inspections/${encodeURIComponent(inspection.id)}?tab=checks`)
    } catch (error) {
      if (!isApiError(error) || error.kind !== 'conflict') createKey.current = null
      setDialogProblem(isApiError(error) && error.kind === 'conflict' ? 'new.problem.refused' : problemKey(error))
    } finally {
      setBusy(false)
    }
  }, [api, newDraft, prefix, router])

  // ---- the release rule ----
  useEffect(() => {
    if (dialog?.kind === 'rules' && rule.value) setRuleDraft(ruleDraftOf(rule.value))
  }, [dialog?.kind, rule.value])

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchCustomers = useCallback(
    (q: string) => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
      if (!q.trim()) {
        setCustomerSearch(null)
        return
      }
      setCustomerSearch(reading())
      searchTimer.current = setTimeout(() => {
        findCustomers(api, q)
          .then((found) => setCustomerSearch(ready(found)))
          .catch((error: unknown) => setCustomerSearch(failedRead(problemKey(error))))
      }, 250)
    },
    [api],
  )

  const saveRule = useCallback(async () => {
    if (!rule.value || !ruleDraft) return
    const loosens = ruleLoosens(rule.value, ruleDraft)
    setBusy(true)
    setDialogProblem(null)
    ruleKey.current ??= newIdempotencyKey()
    const key = ruleKey.current
    try {
      const answer = await guard('stepUp.sentence.loosenRule', () =>
        saveReleaseRule(api, { companyId, releaseFourEyes: ruleDraft.rule, secondPersonPartyIds: ownCustomerIds(ruleDraft), version: rule.value!.version, reason: loosens ? ruleDraft.reason.trim() : null }, key),
      )
      ruleKey.current = null
      setRule(ready(answer.rule))
      setDialog(null)
      setNotice({ key: answer.loosened ? 'rules.savedLoosened' : 'rules.saved', tone: 'success' })
    } catch (error) {
      if (isStepUpCancelled(error)) setDialogProblem('stepUp.cancelled')
      else {
        ruleKey.current = null
        setDialogProblem(problemKey(error))
        if (isApiError(error) && error.kind === 'conflict') void loadRule()
      }
    } finally {
      setBusy(false)
    }
  }, [api, companyId, guard, loadRule, rule.value, ruleDraft])

  // ---- reversal ----
  const reverse = useCallback(async () => {
    const value = detail.value
    if (!value || !reverseDraft.reasonCode) return
    setBusy(true)
    setDialogProblem(null)
    setDialogLines([])
    reverseKey.current ??= newIdempotencyKey()
    const serial = isSerialRelease(value.release)
    try {
      const answer = await reverseRelease(
        api,
        value.release.id,
        {
          quantity: serial ? reverseDraft.serialIds.length : Number(reverseDraft.quantity),
          ...(serial ? { serialIds: reverseDraft.serialIds, serialsTo: reverseDraft.serialsTo } : {}),
          reasonCode: reverseDraft.reasonCode,
          reason: reverseDraft.reason.trim(),
        },
        reverseKey.current,
      )
      reverseKey.current = null
      setDialog(null)
      setReverseDraft(REVERSE_DRAFT)
      setReverseAnswer({ quantity: serial ? reverseDraft.serialIds.length : Number(reverseDraft.quantity), register: answer.register })
      void loadDetail()
      void load()
      void loadTiles()
    } catch (error) {
      reverseKey.current = null
      setDialogProblem(isApiError(error) && error.kind === 'conflict' ? 'reverse.problem.refused' : problemKey(error))
      if (isApiError(error)) setDialogLines(error.issues.map((issue) => issue.message ?? '').filter(Boolean))
    } finally {
      setBusy(false)
    }
  }, [api, detail.value, load, loadDetail, loadTiles, reverseDraft])

  // ---- Assign inspector (qi-assign): the dialog for rows, the inline cell for one ----
  const openAssign = useCallback(
    (picked: readonly InspectionRow[]) => {
      const first = picked[0]
      if (!first) return
      assignKey.current = null
      const value = picked.every((row) => assigneeValue(row.assigned) === assigneeValue(first.assigned)) ? assigneeValue(first.assigned) : ''
      setAssign({ ids: picked.map((row) => row.id), siteId: first.siteId, people: reading(), value, busy: false, problem: null, lines: [] })
      listInspectors(api, first.siteId, picked.map((row) => row.workOrderId))
        .then((found) => setAssign((current) => (current ? { ...current, people: ready(found) } : current)))
        .catch((error: unknown) => setAssign((current) => (current ? { ...current, people: failedRead(problemKey(error)) } : current)))
    },
    [api],
  )

  const saveAssign = useCallback(async () => {
    if (!assign) return
    const picked = (rows.value ?? []).filter((row) => assign.ids.includes(row.id))
    setAssign({ ...assign, busy: true, problem: null, lines: [] })
    assignKey.current ??= newIdempotencyKey()
    try {
      await assignInspections(api, { inspections: picked.map((row) => ({ id: row.id, version: row.version })), ...assigneeBody(assign.value) }, assignKey.current)
      assignKey.current = null
      setAssign(null)
      setSelected([])
      setNotice({ key: assign.value ? 'assign.done' : 'assign.cleared', tone: 'success', params: { count: picked.length } })
      void load()
    } catch (error) {
      if (!isApiError(error) || error.kind !== 'conflict') assignKey.current = null
      setAssign((current) => (current ? { ...current, busy: false, problem: isApiError(error) && error.kind === 'conflict' ? 'assign.problem.refused' : problemKey(error), lines: isApiError(error) ? error.issues.map((issue) => issue.message ?? '').filter(Boolean) : [] } : current))
    }
  }, [api, assign, load, rows.value])

  const needPeople = useCallback(
    (siteId: string, workOrderIds: readonly string[]) => {
      if (people[siteId]) return
      setPeople((current) => ({ ...current, [siteId]: reading() }))
      listInspectors(api, siteId, workOrderIds)
        .then((found) => setPeople((current) => ({ ...current, [siteId]: ready(found) })))
        .catch((error: unknown) => setPeople((current) => ({ ...current, [siteId]: failedRead(problemKey(error)) })))
    },
    [api, people],
  )

  /** The inline Inspector cell: one assignment, saved at once with the row's version (CellSaveMark; a refusal says why). */
  const assignCell = useCallback(
    async (row: InspectionRow, value: string) => {
      setMarks((current) => ({ ...current, [row.id]: { state: 'saving' } }))
      try {
        const [answer] = await assignInspections(api, { inspections: [{ id: row.id, version: row.version }], ...assigneeBody(value) }, newIdempotencyKey())
        setRows((current) => (current.value ? ready(current.value.map((entry) => (entry.id === row.id && answer ? { ...entry, version: answer.version, assigned: answer.assigned } : entry))) : current))
        setMarks((current) => ({ ...current, [row.id]: { state: 'saved' } }))
      } catch (error) {
        setMarks((current) => ({ ...current, [row.id]: isApiError(error) && error.kind === 'conflict' ? { state: 'refused', problem: 'assign.problem.refused', lines: error.issues.map((issue) => issue.message ?? '').filter(Boolean) } : isApiError(error) ? { state: 'refused', problem: problemKey(error) } : { state: 'unknown' } }))
      }
    },
    [api],
  )

  // ---- B-W2b-17: by when inspections are due — the inline cell (one) and Set due date (the selection): one call each ----
  const applyDue = (answers: readonly { id: string; version: number; dueAt: string | null; overdue: boolean }[]) =>
    setRows((current) => (current.value ? ready(current.value.map((entry) => {
      const answer = answers.find((item) => item.id === entry.id)
      return answer ? { ...entry, version: answer.version, dueAt: answer.dueAt, overdue: answer.overdue } : entry
    })) : current))
  const refusalOf = (error: unknown): CellMark =>
    isApiError(error) && (error.kind === 'conflict' || error.kind === 'invalid')
      ? { state: 'refused', problem: error.kind === 'invalid' ? 'due.problem.refused' : 'due.problem.conflict', lines: error.issues.map((issue) => issue.message ?? '').filter(Boolean) }
      : isApiError(error)
        ? { state: 'refused', problem: problemKey(error) }
        : { state: 'unknown' }

  const dueCell = useCallback(
    async (row: InspectionRow, dueAt: string | null) => {
      const key = `due:${row.id}`
      setMarks((current) => ({ ...current, [key]: { state: 'saving' } }))
      try {
        applyDue(await setInspectionsDue(api, { inspections: [{ id: row.id, version: row.version }], dueAt }))
        setMarks((current) => ({ ...current, [key]: { state: 'saved' } }))
      } catch (error) {
        setMarks((current) => ({ ...current, [key]: refusalOf(error) }))
        if (isApiError(error) && error.kind === 'conflict') void load()
      }
    },
    [api, load],
  )

  const openDue = useCallback((picked: readonly InspectionRow[]) => {
    if (picked.length === 0) return
    dueKey.current = null
    const first = picked[0]!.dueAt ?? ''
    setDue({ ids: picked.map((row) => row.id), value: picked.every((row) => (row.dueAt ?? '') === first) ? first : '', busy: false, problem: null, lines: [] })
  }, [])

  const saveDue = useCallback(async () => {
    if (!due) return
    const picked = (rows.value ?? []).filter((row) => due.ids.includes(row.id))
    setDue({ ...due, busy: true, problem: null, lines: [] })
    dueKey.current ??= newIdempotencyKey()
    try {
      applyDue(await setInspectionsDue(api, { inspections: picked.map((row) => ({ id: row.id, version: row.version })), dueAt: due.value || null }, dueKey.current))
      dueKey.current = null
      setDue(null)
      setSelected([])
      setNotice({ key: due.value ? 'due.done' : 'due.cleared', tone: 'success', params: { count: picked.length } })
      void loadTiles()
    } catch (error) {
      if (!isApiError(error) || error.kind !== 'conflict') dueKey.current = null
      const mark = refusalOf(error)
      setDue((current) => (current ? { ...current, busy: false, problem: mark.state === 'refused' ? mark.problem : 'due.problem.unknown', lines: mark.state === 'refused' ? (mark.lines ?? []) : [] } : current))
    }
  }, [api, due, loadTiles, rows.value])

  // ---- export ----
  const exportRows = useCallback(
    (exportKind: 'inspections' | 'releases' | 'lots', ids: readonly string[]) => {
      const pick = new Set(ids)
      const stamp = new Date().toISOString().slice(0, 10)
      if (exportKind === 'inspections') {
        const lines = [csvLine(INSPECTION_CSV_HEAD.map((key) => t(key))), ...(rows.value ?? []).filter((row) => pick.has(row.id)).map((row) => csvLine(inspectionCsvRow(row, t)))]
        downloadText(`inspections-${stamp}.csv`, lines.join('\n'))
      } else if (exportKind === 'releases') {
        const head = ['csv.release', 'csv.workOrder', 'csv.garments', 'csv.takenBack', 'csv.onHold', 'csv.releasedBy', 'csv.releasedAt'].map((key) => t(key))
        const body = (releases.value ?? [])
          .filter((row) => pick.has(row.id))
          .map((row) => {
            const label = releaseLabel(row)
            return csvLine([t(label.key, label.params), row.number, row.quantity, reversedOf(row), row.onHold, t(whoKey(row.releasedBy, session.user.id).key), formatDateTime(row.releasedAt, { locale })])
          })
        downloadText(`releases-${stamp}.csv`, [csvLine(head), ...body].join('\n'))
      } else {
        const head = ['csv.lot', 'csv.material', 'csv.lotStatus', 'csv.crVi', 'csv.why'].map((key) => t(key))
        const body = (lots.value ?? []).filter((row) => pick.has(row.id)).map((row) => csvLine([row.code, `${row.item.code} ${row.item.name}`, t(`lotStatus.${row.qualityStatus}`), t(`crVi.${row.crVi.status}`), row.hold ?? row.qualityNote ?? '']))
        downloadText(`lots-on-hold-${stamp}.csv`, [csvLine(head), ...body].join('\n'))
      }
    },
    [locale, lots.value, releases.value, rows.value, session.user.id, t],
  )

  const setView = (next: View) => {
    setViewState(next)
    setLimit(PAGE)
    setSelected([])
    if (viewKind(next) === 'inspections') setRows(reading())
    else if (viewKind(next) === 'releases') setReleases(reading())
    else setLots(reading())
    writeAddress({ view: next })
  }

  const openDialog = (next: ListDialog | null) => {
    setDialogProblem(null)
    setDialogLines([])
    if (next?.kind === 'new') {
      setNewDraft(NEW_DRAFT)
      setCells(null)
      setNewPeople(null)
      setReturns(null)
      setReturnRecord(null)
      setReturnDraft(RETURN_DRAFT)
      createKey.current = null
      gradeKey.current = null
    }
    if (next?.kind === 'reverse') {
      setReverseDraft(REVERSE_DRAFT)
      reverseKey.current = null
    }
    if (next?.kind === 'rules') setCustomerSearch(null)
    setDialog(next)
  }

  if (holdsAddress) return null
  return (
    <>
    <InspectionsView
      model={{
        prefix,
        me: session.user.id,
        companyName: session.company?.name ?? '',
        can,
        view,
        rows,
        releases,
        lots,
        limit,
        tiles,
        rule,
        asOf,
        live,
        updates,
        selected,
        notice,
        open: openId ? { id: openId, detail } : null,
        dialog,
        busy,
        dialogProblem,
        dialogLines,
        reverseAnswer,
        pick: { workOrders, cells },
        newDraft,
        ruleDraft,
        customerSearch,
        reverseDraft,
        assign,
        people,
        marks,
        newPeople,
        returns,
        returnRecord,
        returnDraft,
        due,
      }}
      stepUp={stepUp}
      actions={{
        onView: setView,
        onMore: () => setLimit((current) => nextLimit(current)),
        onRetry: () => void load(),
        onShowUpdates: () => {
          void load()
          void loadTiles()
        },
        onSelect: (ids) => setSelected([...ids]),
        onDialog: openDialog,
        onOpenInspection: (row) => router.push(`${prefix}/quality/inspections/${encodeURIComponent(row.id)}`),
        onOpenRelease: (id) => writeAddress({ open: id }),
        onOpenLot: (lot) => router.push(`${prefix}/warehouse/lots/${encodeURIComponent(lot.id)}`),
        onRetryRelease: () => void loadDetail(),
        onExport: exportRows,
        onNewDraft: setNewDraft,
        onPickWorkOrder: (id) => void pickWorkOrder(id),
        onCreate: () => void create(),
        onRuleDraft: setRuleDraft,
        onFindCustomers: searchCustomers,
        onSaveRule: () => void saveRule(),
        onReverseDraft: setReverseDraft,
        onReverse: () => void reverse(),
        onDismissNotice: () => {
          setNotice(null)
          setReverseAnswer(null)
        },
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
        onAssign: openAssign,
        onAssignValue: (value) => setAssign((current) => (current ? { ...current, value } : current)),
        onAssignSave: () => void saveAssign(),
        onAssignClose: () => setAssign(null),
        onNeedPeople: needPeople,
        onAssignCell: (row, value) => void assignCell(row, value),
        onPlaceHold: (row) => setHold({ subjectType: 'WorkOrder', subjectIds: [row.workOrderId], sourceType: 'Inspection', sourceId: row.id, fromLabel: row.label }),
        onRaiseNcr: (row) => router.push(newNcrAddress(prefix, 'Inspection', row.id)),
        onPickReturn: pickReturn,
        onReturnDraft: setReturnDraft,
        onGradeReturn: () => void gradeTheReturn(),
        onDue: openDue,
        onDueValue: (value) => setDue((current) => (current ? { ...current, value } : current)),
        onDueSave: () => void saveDue(),
        onDueClose: () => setDue(null),
        onDueCell: (row, dueAt) => void dueCell(row, dueAt),
      }}
    />
    <PlaceHold
      open={hold !== null}
      prefill={hold}
      onClose={() => setHold(null)}
      onPlaced={(placed) => {
        setHold(null)
        setNotice({ key: placed.workOrdersHeld > 0 ? 'hold.placedWorkOrder' : 'hold.placed', tone: 'success' })
        void load()
        void loadTiles()
      }}
    />
    </>
  )
}
