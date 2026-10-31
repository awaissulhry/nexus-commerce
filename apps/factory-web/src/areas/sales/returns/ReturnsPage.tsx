'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { downloadText, liveMatches, useLive } from '../../quality/_shared/hooks'
import { problemKey } from '../../quality/_shared/model'
import {
  closeReturn,
  createRepair,
  createReturn,
  getReturn,
  listCustomers,
  listPeople,
  listRepairs,
  listReturnable,
  listReturnReasons,
  listReturns,
  previewRepair,
  previewReturn,
  repairCounts,
  returnCounts,
  type Person,
  type RepairCounts,
  type RepairRow,
  type ReturnCounts,
  type ReturnRow,
} from './api'
import {
  BLANK_REPAIR,
  BLANK_RETURN,
  closeReasonText,
  LIVE_TYPES,
  mergedRows,
  newRepairBody,
  newRepairProblems,
  newReturnBody,
  newReturnProblems,
  queryOf,
  addressOf,
  refusalOf,
  repairHref,
  returnHref,
  returnsCan,
  romeToday,
  rowHref,
  rowStatusWords,
  rowsCsv,
  sourcesOf,
  type AfterSalesRow,
  type ListAddress,
} from './model'
import type { CloseModel, NewRepairModel, NewReturnModel, Notice, ReturnsListModel } from './view-model'
import { ReturnsMessages, say, useWords } from './view/parts'
import { ReturnsView } from './view/ReturnsView'

/**
 * `/w/<company>/sales/returns` (SCR-111): reads the view of the address from both sources — `GET /sales/returns` and
 * `GET /sales/repairs` with their own views (two sources, one grid; the repairs only with sales.repairs.view) — the tiles
 * (`…/counts` of each), the office people (owners' names) and listens to the live stream: a new or changed return or
 * repair waits behind "N updates · Show" (rows never move under the cursor) while the tiles read at once. `?new=return`
 * and `?new=repair` open the dialogs; every create sends an Idempotency-Key and opens the new record.
 */
export function ReturnsPage() {
  return (
    <ReturnsMessages>
      <ReturnsContainer />
    </ReturnsMessages>
  )
}

function useOnline(): boolean {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const update = () => setOnline(typeof navigator === 'undefined' ? true : navigator.onLine !== false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}

const DISMISSED_KEY = 'fw.returns.notices'

function ReturnsContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const t = useWords()
  const can = useMemo(() => returnsCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? session.companies[0]?.id ?? ''
  const me = session.user.id
  const address = useMemo(() => addressOf(params), [params])
  const offline = !useOnline()
  const today = romeToday()
  const asked = params?.get('new') ?? null

  const go = useCallback((patch: Partial<ListAddress>, extra: Record<string, string | null> = {}) => router.replace(`${pathname}${queryOf({ ...address, ...patch }, extra)}`, { scroll: false }), [router, pathname, address])

  // ---- the rows (both sources) and the tiles --------------------------------------------------------------------------------
  const [returns, setReturns] = useState<{ items: ReturnRow[] | null; truncated: boolean }>({ items: null, truncated: false })
  const [repairs, setRepairs] = useState<{ items: RepairRow[] | null; truncated: boolean; people: Person[] }>({ items: null, truncated: false, people: [] })
  const [rowsProblem, setRowsProblem] = useState<string | null>(null)
  const [counts, setCounts] = useState<{ returns: ReturnCounts | null; repairs: RepairCounts | null; failed: boolean }>({ returns: null, repairs: null, failed: false })
  const [people, setPeople] = useState<Person[]>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [receipt, setReceipt] = useState<ReturnsListModel['receipt']>(null)
  const [dismissed, setDismissed] = useState<readonly string[]>([])
  const readId = useRef(0)
  const sources = sourcesOf(address.view)
  const listKey = JSON.stringify({ sources, q: address.q.trim(), repairs: can.repairsView })

  useEffect(() => {
    try {
      setDismissed(JSON.parse(window.sessionStorage.getItem(DISMISSED_KEY) ?? '[]') as string[])
    } catch {
      setDismissed([])
    }
  }, [])

  const loadCounts = useCallback(async () => {
    if (!can.view) return
    try {
      const [returnsAnswer, repairsAnswer] = await Promise.all([returnCounts(api), can.repairsView ? repairCounts(api) : Promise.resolve(null)])
      setCounts({ returns: returnsAnswer.counts, repairs: repairsAnswer?.counts ?? null, failed: false })
    } catch {
      setCounts((current) => ({ ...current, failed: true }))
    }
  }, [api, can.view, can.repairsView])

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    const { sources: wanted, q, repairs: withRepairs } = JSON.parse(listKey) as { sources: ReturnType<typeof sourcesOf>; q: string; repairs: boolean }
    try {
      const [returnsAnswer, repairsAnswer] = await Promise.all([
        wanted.returns ? listReturns(api, { view: wanted.returns, q }) : Promise.resolve({ returns: [], truncated: false }),
        wanted.repairs && withRepairs ? listRepairs(api, { view: wanted.repairs, q }) : Promise.resolve({ repairs: [], truncated: false, people: [], asOf: '' }),
      ])
      if (id !== readId.current) return
      setReturns({ items: returnsAnswer.returns, truncated: returnsAnswer.truncated })
      setRepairs({ items: repairsAnswer.repairs, truncated: repairsAnswer.truncated, people: repairsAnswer.people })
      setRowsProblem(null)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRowsProblem(`quality:${problemKey(error)}`)
    }
  }, [api, can.view, listKey])

  useEffect(() => {
    setReturns({ items: null, truncated: false })
    void load()
  }, [load])
  useEffect(() => {
    void loadCounts()
  }, [loadCounts])
  useEffect(() => {
    if (!can.people) return
    listPeople(api)
      .then(setPeople)
      .catch(() => setPeople([]))
  }, [api, can.people])

  const live = useLive(
    (change) => {
      if (!liveMatches(change, LIVE_TYPES)) return
      setUpdates((count) => count + 1)
      void loadCounts()
    },
    () => {
      void load()
      void loadCounts()
    },
  )

  const items = useMemo(() => (returns.items === null || repairs.items === null ? null : mergedRows(returns.items, repairs.items)), [returns.items, repairs.items])

  // ---- notices: one at a time, the most serious first; dismissed by value -------------------------------------------------
  const notices = useMemo<Notice[]>(() => {
    const out: Notice[] = []
    if (counts.returns && counts.returns.late > 0) out.push({ id: `late:${counts.returns.late}`, tone: 'warning', words: { key: 'notice.late', params: { count: counts.returns.late } }, href: `${prefix}/sales/returns?view=late`, linkWords: { key: 'notice.lateLink' } })
    if (counts.repairs && counts.repairs.toCheck > 0) out.push({ id: `check:${counts.repairs.toCheck}`, tone: 'warning', words: { key: 'notice.toCheck', params: { count: counts.repairs.toCheck } } })
    if (counts.returns && counts.returns.toDecide > 0) out.push({ id: `decide:${counts.returns.toDecide}`, tone: 'info', words: { key: 'notice.toDecide', params: { count: counts.returns.toDecide } } })
    if (counts.repairs && counts.repairs.toShip > 0) out.push({ id: `ship:${counts.repairs.toShip}`, tone: 'info', words: { key: 'notice.toShip', params: { count: counts.repairs.toShip } } })
    if (returns.truncated || repairs.truncated) out.push({ id: 'truncated', tone: 'info', words: { key: 'notice.truncated' } })
    if (!can.repairsView) out.push({ id: 'noRepairs', tone: 'info', words: { key: 'notice.noRepairs' } })
    return out.filter((notice) => !dismissed.includes(notice.id))
  }, [counts, returns.truncated, repairs.truncated, can.repairsView, dismissed, prefix])

  // ---- New return -------------------------------------------------------------------------------------------------------------
  const [newReturn, setNewReturn] = useState<NewReturnModel | null>(null)
  const returnKey = useRef<string | null>(null)
  const openNewReturn = useCallback(() => {
    returnKey.current = newIdempotencyKey()
    setNewReturn({ draft: BLANK_RETURN, customers: { items: null, problem: can.partiesView ? null : 'newReturn.customerNoRight' }, returnable: { value: null, loading: false, problem: null }, reasons: null, preview: null, previewing: false, showProblems: false, busy: false, problem: null, today, price: can.price })
    if (can.partiesView)
      listCustomers(api)
        .then((items) => setNewReturn((current) => (current ? { ...current, customers: { items, problem: null } } : current)))
        .catch((error) => setNewReturn((current) => (current ? { ...current, customers: { items: null, problem: `quality:${problemKey(error)}` } } : current)))
    listReturnReasons(api)
      .then((reasons) => setNewReturn((current) => (current ? { ...current, reasons } : current)))
      .catch(() => setNewReturn((current) => (current ? { ...current, reasons: [] } : current)))
  }, [api, can.partiesView, can.price, today])

  const partyId = newReturn?.draft.partyId ?? ''
  useEffect(() => {
    if (!partyId || !companyId) return
    setNewReturn((current) => (current ? { ...current, returnable: { value: null, loading: true, problem: null }, preview: null } : current))
    listReturnable(api, { companyId, partyId })
      .then((value) => setNewReturn((current) => (current && current.draft.partyId === partyId ? { ...current, returnable: { value, loading: false, problem: null } } : current)))
      .catch((error) => setNewReturn((current) => (current ? { ...current, returnable: { value: null, loading: false, problem: `quality:${problemKey(error)}` } } : current)))
  }, [api, companyId, partyId])

  // The preview while typing (debounced): what the API would make, its problems by place.
  const returnDraftKey = newReturn ? JSON.stringify(newReturn.draft) : ''
  useEffect(() => {
    if (!newReturn || !newReturn.returnable.value) return
    const body = newReturnBody(newReturn.draft, newReturn.returnable.value.lines, companyId)
    if (body.lines.length === 0) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setNewReturn((current) => (current ? { ...current, previewing: true } : current))
      previewReturn(api, body, controller.signal)
        .then((preview) => setNewReturn((current) => (current ? { ...current, preview, previewing: false } : current)))
        .catch(() => setNewReturn((current) => (current ? { ...current, previewing: false } : current)))
    }, 350)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
    // The draft's text is the dependency (the model object changes on every answer).
  }, [api, companyId, returnDraftKey, !!newReturn?.returnable.value])

  const submitNewReturn = useCallback(async () => {
    const current = newReturn
    if (!current || current.busy) return
    const returnable = current.returnable.value?.lines ?? null
    const problems = newReturnProblems(current.draft, returnable)
    if (problems.length > 0 || !returnable || (current.preview && !current.preview.ok)) {
      setNewReturn({ ...current, showProblems: true })
      return
    }
    setNewReturn({ ...current, busy: true, problem: null })
    try {
      const answer = await createReturn(api, newReturnBody(current.draft, returnable, companyId), returnKey.current ?? newIdempotencyKey())
      setNewReturn(null)
      router.push(returnHref(prefix, answer.return.id, '?created=1'))
    } catch (error) {
      setNewReturn((latest) => (latest ? { ...latest, busy: false, showProblems: true, problem: refusalOf(error) } : latest))
    }
  }, [api, companyId, newReturn, prefix, router])

  // ---- New repair -------------------------------------------------------------------------------------------------------------
  const [newRepair, setNewRepair] = useState<NewRepairModel | null>(null)
  const repairKey = useRef<string | null>(null)
  const openNewRepair = useCallback(() => {
    repairKey.current = newIdempotencyKey()
    setNewRepair({ draft: BLANK_REPAIR, fromLine: null, customers: { items: null, problem: can.partiesView ? null : 'newReturn.customerNoRight' }, preview: null, previewing: false, showProblems: false, busy: false, problem: null, today })
    if (can.partiesView)
      listCustomers(api)
        .then((items) => setNewRepair((current) => (current ? { ...current, customers: { items, problem: null } } : current)))
        .catch((error) => setNewRepair((current) => (current ? { ...current, customers: { items: null, problem: `quality:${problemKey(error)}` } } : current)))
  }, [api, can.partiesView, today])

  const lookUpRepair = useCallback(async () => {
    const current = newRepair
    if (!current) return
    setNewRepair({ ...current, previewing: true })
    try {
      const preview = await previewRepair(api, newRepairBody(current.draft, companyId))
      setNewRepair((latest) => (latest ? { ...latest, preview, previewing: false, draft: preview.draft && !latest.draft.partyId ? { ...latest.draft, partyId: preview.draft.partyId } : latest.draft } : latest))
    } catch {
      setNewRepair((latest) => (latest ? { ...latest, previewing: false } : latest))
    }
  }, [api, companyId, newRepair])

  // The preview again while the draft changes (debounced) once it names a garment or a customer.
  const repairDraftKey = newRepair ? JSON.stringify(newRepair.draft) : ''
  useEffect(() => {
    if (!newRepair || (!newRepair.draft.serial.trim() && !newRepair.draft.partyId)) return
    const body = newRepairBody(newRepair.draft, companyId)
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      previewRepair(api, body, controller.signal)
        .then((preview) => setNewRepair((latest) => (latest ? { ...latest, preview } : latest)))
        .catch(() => undefined)
    }, 500)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
    // The draft's text is the dependency.
  }, [api, companyId, repairDraftKey])

  const submitNewRepair = useCallback(async () => {
    const current = newRepair
    if (!current || current.busy) return
    if (newRepairProblems(current.draft).length > 0) {
      setNewRepair({ ...current, showProblems: true })
      return
    }
    setNewRepair({ ...current, busy: true, problem: null })
    try {
      const answer = await createRepair(api, newRepairBody(current.draft, companyId), repairKey.current ?? newIdempotencyKey())
      setNewRepair(null)
      router.push(repairHref(prefix, answer.repair.id, '?created=1'))
    } catch (error) {
      // The preview says by place what stops it (a garment with an open repair, the numbering).
      const preview = await previewRepair(api, newRepairBody(current.draft, companyId)).catch(() => null)
      setNewRepair((latest) => (latest ? { ...latest, busy: false, showProblems: true, preview: preview ?? latest.preview, problem: refusalOf(error) } : latest))
    }
  }, [api, companyId, newRepair, prefix, router])

  // ---- Close return -----------------------------------------------------------------------------------------------------------
  const [close, setClose] = useState<(CloseModel & { id: string }) | null>(null)
  const closeKey = useRef<string | null>(null)
  const submitClose = useCallback(async () => {
    const current = close
    if (!current || current.busy || !current.reason) return
    setClose({ ...current, busy: true, problem: null })
    try {
      const rma = await getReturn(api, current.id)
      const answer = await closeReturn(api, rma, closeReasonText(t(`finish.${current.reason}`), current.note), closeKey.current ?? newIdempotencyKey())
      setClose({ ...current, busy: false, warnings: answer.warnings.length })
      void load()
      void loadCounts()
    } catch (error) {
      setClose((latest) => (latest ? { ...latest, busy: false, problem: refusalOf(error) } : latest))
    }
  }, [api, close, load, loadCounts, t])

  // `?new=return|repair` (a link from elsewhere, the empty state) opens a dialog once; then the address forgets it.
  useEffect(() => {
    if (asked === 'return' && can.manage && !newReturn) openNewReturn()
    if (asked === 'repair' && can.repairsManage && !newRepair) openNewRepair()
    if (asked) go({}, { new: null })
    // Only when the address asks.
  }, [asked])

  const exportRows = useCallback(
    (list: readonly AfterSalesRow[]) => {
      const headers = ['number', 'type', 'customer', 'order', 'units', 'status', 'received', 'deadline', 'credit'].map((key) => t(`csv.${key}`))
      downloadText(t('csv.file', { day: today }), rowsCsv(list, headers, (row) => t(`kind.${row.kind}`), (row) => `${t(row.status.kind === 'RETURN' ? `status.${row.status.status}` : `stagePill.${row.status.stage}`)} · ${say(t, rowStatusWords(row, today))}`, can.price))
    },
    [can.price, t, today],
  )

  const model: ReturnsListModel = {
    prefix,
    can,
    me,
    address,
    rows: { items, problem: rowsProblem, truncated: returns.truncated || repairs.truncated },
    counts,
    people: [...people, ...repairs.people.filter((person) => !people.some((known) => known.id === person.id))],
    asOf,
    live,
    offline,
    updates,
    today,
    notices,
    receipt,
    newReturn,
    newRepair,
    close,
  }

  return (
    <ReturnsView
      model={model}
      actions={{
        onAddress: (patch) => go(patch),
        onClearFilters: () => router.replace(pathname, { scroll: false }),
        onRetry: () => {
          void load()
          void loadCounts()
        },
        onShowUpdates: () => void load(),
        onOpen: (row) => router.push(rowHref(prefix, row)),
        onCopy: (text) => {
          void navigator.clipboard?.writeText(text).then(
            () => setReceipt({ tone: 'success', words: { key: 'done.copied' } }),
            () => undefined,
          )
        },
        onExport: exportRows,
        onDismissNotice: (id) =>
          setDismissed((current) => {
            const next = [...current, id]
            try {
              window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
            } catch {
              // Not kept on this device; the notice still goes for now.
            }
            return next
          }),
        onDismissReceipt: () => setReceipt(null),
        onNewReturn: openNewReturn,
        onNewReturnDraft: (patch) => setNewReturn((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current)),
        onNewReturnLine: (key, patch) =>
          setNewReturn((current) => {
            if (!current) return current
            const before = current.draft.lines[key] ?? { quantity: '', reasonCode: '', note: '' }
            return { ...current, draft: { ...current.draft, lines: { ...current.draft.lines, [key]: { ...before, ...patch } } } }
          }),
        onNewReturnSubmit: () => void submitNewReturn(),
        onNewReturnClose: () => setNewReturn(null),
        onNewRepair: openNewRepair,
        onNewRepairDraft: (patch) => setNewRepair((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current)),
        onNewRepairLookUp: () => void lookUpRepair(),
        onNewRepairSubmit: () => void submitNewRepair(),
        onNewRepairClose: () => setNewRepair(null),
        onClose: (row) => {
          closeKey.current = newIdempotencyKey()
          setClose({ id: row.id, number: row.number, reason: '', note: '', busy: false, problem: null, warnings: null })
        },
        onCloseDraft: (patch) => setClose((current) => (current ? { ...current, ...patch } : current)),
        onCloseSubmit: () => void submitClose(),
        onCloseDismiss: () => setClose(null),
      }}
    />
  )
}
