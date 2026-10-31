'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { listSites } from '../../_shared/buying/api'
import { downloadText, useCoalesced, useLive } from '../_shared/hooks'
import { getLedger, getMethod, getStandards, getWorkOrderCost, getWorkOrderCosts, reverseEntry, type CostEntryKind, type CostTiles, type LedgerEntry, type MethodView, type StandardCost, type WorkOrderCostRow } from './api'
import { addressOf, closedIn, costingCanOf, costingHref, liveTouches, periodOf, readProblem, recentMonths, romeToday, rowsQuery, workOrdersCsv, type CostingAddress } from './model'
import { CostingView, type CostingModel, type CostingPart, type ListPart } from './view/CostingView'
import type { DetailState, ReverseState } from './view/CostDialogs'

/** The "Still loading…" note after about a second (design: GridSheetNote slow). */
const SLOW_MS = 1000
const SEARCH_MS = 300

type Paged<T> = ListPart<T> & { readonly cursor: string | null }
const EMPTY = { rows: null, more: false, problem: null, slow: false, cursor: null } as const

/**
 * `/w/<company>/finance/costing` (SCR-154): reads the work orders with standard vs actual and the tiles (`?rows=&q=&site=`),
 * the frozen standards in force at the period's end, the cost ledger of the period (`?month=`, else this month), the
 * company's costing method, and the company's sites for the scope; counts the live cost events behind "N updates · Show";
 * opens a work order's cost (`?open=`, J / K over the list); reverses a ledger entry with its reason (one Idempotency-Key
 * per attempt; a refusal is said in the dialog). Without costing.view it asks the API nothing (the view says why).
 */
export function CostingPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = pathname.replace(/\/finance\/costing\/?$/, '')
  const can = useMemo(() => costingCanOf(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const companyId = session.company?.id ?? null
  const today = romeToday()
  const period = useMemo(() => periodOf(address.month, today), [address.month, today])
  const months = useMemo(() => recentMonths(today), [today])

  const [workOrders, setWorkOrders] = useState<Paged<WorkOrderCostRow> & { tiles: CostTiles | null }>({ ...EMPTY, tiles: null })
  const [standards, setStandards] = useState<Paged<StandardCost>>(EMPTY)
  const [ledger, setLedger] = useState<Paged<LedgerEntry>>(EMPTY)
  const [ledgerKind, setLedgerKind] = useState<CostEntryKind | null>(null)
  const [method, setMethod] = useState<MethodView | null>(null)
  const [sites, setSites] = useState<Array<{ id: string; code: string }>>([])
  const [readAt, setReadAt] = useState<number | null>(null)
  const [updates, setUpdates] = useState(0)
  const [detail, setDetail] = useState<DetailState | null>(null)
  const [reverse, setReverse] = useState<ReverseState | null>(null)
  const [notice, setNotice] = useState<CostingModel['notice']>(null)
  const asked = useRef(address)
  asked.current = address
  const attempt = useRef<string | null>(null)

  const keep = (rows: readonly WorkOrderCostRow[], target: CostingAddress) => (target.rows === 'closed' ? rows.filter((row) => closedIn(row, period)) : rows)

  const readWorkOrders = useCallback(async () => {
    if (!can.view) return
    const target = asked.current
    const slow = setTimeout(() => setWorkOrders((current) => (current.rows || current.problem ? current : { ...current, slow: true })), SLOW_MS)
    try {
      const page = await getWorkOrderCosts(api, rowsQuery(target, companyId))
      if (asked.current !== target) return
      setWorkOrders({ rows: keep(page.rows, target), more: page.nextCursor !== null, problem: null, slow: false, cursor: page.nextCursor, tiles: page.tiles })
      setReadAt(Date.now())
      setUpdates(0)
    } catch (error) {
      if (asked.current === target) setWorkOrders((current) => ({ ...current, rows: null, problem: readProblem(error), slow: false }))
    } finally {
      clearTimeout(slow)
    }
  }, [api, can.view, companyId, period])

  const readStandards = useCallback(async () => {
    if (!can.view) return
    const slow = setTimeout(() => setStandards((current) => (current.rows || current.problem ? current : { ...current, slow: true })), SLOW_MS)
    try {
      const page = await getStandards(api, { companyId, on: period.to })
      setStandards({ rows: page.standards, more: page.nextCursor !== null, problem: null, slow: false, cursor: page.nextCursor })
    } catch (error) {
      setStandards({ ...EMPTY, problem: readProblem(error) })
    } finally {
      clearTimeout(slow)
    }
  }, [api, can.view, companyId, period.to])

  const readLedger = useCallback(async () => {
    if (!can.view) return
    const slow = setTimeout(() => setLedger((current) => (current.rows || current.problem ? current : { ...current, slow: true })), SLOW_MS)
    try {
      const page = await getLedger(api, { companyId, siteId: asked.current.site, kinds: ledgerKind ? [ledgerKind] : null, from: period.from, to: period.to })
      setLedger({ rows: page.entries, more: page.nextCursor !== null, problem: null, slow: false, cursor: page.nextCursor })
    } catch (error) {
      setLedger({ ...EMPTY, problem: readProblem(error) })
    } finally {
      clearTimeout(slow)
    }
  }, [api, can.view, companyId, period.from, period.to, ledgerKind])

  const readDetail = useCallback(
    (id: string) => {
      setDetail({ id, value: null, problem: null })
      getWorkOrderCost(api, id)
        .then((value) => setDetail((current) => (current?.id === id ? { id, value, problem: null } : current)))
        .catch((error: unknown) => setDetail((current) => (current?.id === id ? { id, value: null, problem: readProblem(error) } : current)))
    },
    [api],
  )

  useEffect(() => {
    setWorkOrders({ ...EMPTY, tiles: null })
    void readWorkOrders()
  }, [readWorkOrders, address.rows, address.q, address.site])
  useEffect(() => {
    setStandards(EMPTY)
    void readStandards()
  }, [readStandards])
  useEffect(() => {
    setLedger(EMPTY)
    void readLedger()
  }, [readLedger, address.site])
  useEffect(() => {
    if (!can.view) return
    getMethod(api, companyId)
      .then(setMethod)
      .catch(() => setMethod(null))
  }, [api, can.view, companyId])
  useEffect(() => {
    if (!can.view || !can.sites) return
    listSites(api, companyId)
      .then((found) => setSites(found.map((site) => ({ id: site.id, code: site.code }))))
      .catch(() => setSites([]))
  }, [api, can.view, can.sites, companyId])
  // The cost that is open follows the address (`?open=`; J / K and the back button move it).
  useEffect(() => {
    if (!can.view) return
    if (!address.open) setDetail(null)
    else if (detail?.id !== address.open) readDetail(address.open)
  }, [address.open, can.view])

  const refreshAll = useCallback(() => {
    void readWorkOrders()
    void readLedger()
    void readStandards()
  }, [readWorkOrders, readLedger, readStandards])
  const rereadLedger = useCoalesced(() => void readLedger(), 900)
  const live = useLive(
    (change) => {
      if (!liveTouches(change)) return
      setUpdates((count) => count + 1)
      if (change.type.startsWith('work_order_cost.')) rereadLedger()
    },
    () => refreshAll(),
    can.view,
  )

  const go = (next: Partial<CostingAddress>) => router.replace(costingHref(prefix, { ...address, ...next }), { scroll: false })
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    },
    [],
  )

  const more = async (part: 'workOrders' | 'standards' | 'ledger') => {
    try {
      if (part === 'workOrders' && workOrders.cursor) {
        const page = await getWorkOrderCosts(api, rowsQuery(address, companyId, workOrders.cursor))
        setWorkOrders((current) => ({ ...current, rows: [...(current.rows ?? []), ...keep(page.rows, address).filter((row) => !current.rows?.some((seen) => seen.workOrder.id === row.workOrder.id))], more: page.nextCursor !== null, cursor: page.nextCursor }))
      }
      if (part === 'standards' && standards.cursor) {
        const page = await getStandards(api, { companyId, on: period.to, cursor: standards.cursor })
        setStandards((current) => ({ ...current, rows: [...(current.rows ?? []), ...page.standards], more: page.nextCursor !== null, cursor: page.nextCursor }))
      }
      if (part === 'ledger' && ledger.cursor) {
        const page = await getLedger(api, { companyId, siteId: address.site, kinds: ledgerKind ? [ledgerKind] : null, from: period.from, to: period.to, cursor: ledger.cursor })
        setLedger((current) => ({ ...current, rows: [...(current.rows ?? []), ...page.entries], more: page.nextCursor !== null, cursor: page.nextCursor }))
      }
    } catch (error) {
      setNotice({ tone: 'danger', words: { key: readProblem(error) } })
    }
  }

  const retry = (part: CostingPart) => {
    if (part === 'workOrders') void readWorkOrders()
    if (part === 'standards') void readStandards()
    if (part === 'ledger') void readLedger()
    if (part === 'detail' && address.open) readDetail(address.open)
  }

  const submitReverse = (reason: string) => {
    if (!reverse || reverse.busy) return
    const entry = reverse.entry
    attempt.current ??= newIdempotencyKey()
    setReverse({ entry, busy: true, problem: null })
    reverseEntry(api, entry.id, reason, attempt.current)
      .then(() => {
        attempt.current = null
        setReverse(null)
        setNotice({ tone: 'success', words: { key: 'notice.reversed', params: { number: entry.workOrder.number } } })
        refreshAll()
        if (detail?.id === entry.workOrder.id) readDetail(entry.workOrder.id)
      })
      .catch((error: unknown) => {
        attempt.current = null
        setReverse({ entry, busy: false, problem: { key: readProblem(error) } })
      })
  }

  const model: CostingModel = {
    prefix,
    can,
    today,
    address,
    period,
    months,
    sites,
    method,
    workOrders,
    standards,
    ledger,
    ledgerKind,
    readAt,
    live,
    updates,
    detail,
    reverse,
    notice,
  }
  return (
    <CostingView
      model={model}
      actions={{
        onSite: (site) => go({ site }),
        onRows: (rows) => go({ rows }),
        onMonth: (month) => go({ month }),
        onSearch: (text) => {
          if (searchTimer.current) clearTimeout(searchTimer.current)
          searchTimer.current = setTimeout(() => go({ q: text.trim() || null }), SEARCH_MS)
        },
        onRetry: retry,
        onMore: (part) => void more(part),
        onShowUpdates: () => refreshAll(),
        onOpen: (id) => go({ open: id }),
        onLedgerKind: setLedgerKind,
        onReverse: (entry) => {
          attempt.current = null
          setReverse(entry ? { entry, busy: false, problem: null } : null)
        },
        onReverseSubmit: submitReverse,
        onExport: (rows, words, fileName) => downloadText(fileName, workOrdersCsv(rows, can, words, locale)),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
