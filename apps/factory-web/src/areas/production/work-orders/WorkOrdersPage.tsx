'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { DEFAULT_TIME_ZONE } from '../../../lib/i18n/format'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { newIdempotencyKey } from '../../../lib/api/client'
import { WithMessages } from '../../../record-panels/i18n'
import {
  countWorkOrders,
  createWorkOrder,
  findOrders,
  getOpenLines,
  listWorkOrders,
  type OrderOption,
  type WorkOrderCounts,
  type WorkOrderRow,
} from '../_shared/api'
import { useCoalesced, useLive } from '../_shared/hooks'
import { abilitiesOf, liveTouches, readProblem, viewFromAddress, viewQuery, writeProblem, type ListView } from '../_shared/model'
import { daysLate } from '@nexus/factory-domain/production/work-orders/machine'
import { isRelativeDay, type RelativeDay } from '@nexus/factory-domain/views/quick/relative'
import { modeOfAddress, type ListMode } from '../../../list-frame/w2b/model'
import { linesOfStyle, NO_NEW_ORDER, openGridOf, stylesOf, type BulkReleaseModel, type NewWorkOrderModel, type WorkOrdersListModel } from './list-model'
import { WorkOrdersListView } from './view/WorkOrdersListView'
import { getReadiness, holdReasons, placeHold, type ReadinessRow } from './daily/api'
import { DAILY_NAMESPACE, dailyCan, dailyProblem, NO_DAILY, READINESS_STATUSES, type DailyModel } from './daily/model'
import { applyRowsOf } from '@nexus/factory-domain/views/bulk/rules'
import { applyRelease, previewRelease } from './every-shift/api'
import { SHIFT_NAMESPACE } from './every-shift/model'

/**
 * `/w/<company>/production/work-orders` (SCR-069): reads the work orders of the saved view (`?view=`, default open) and
 * the search (`?q=`), 50 a page with "Show more" (cursor), the tiles' counts, and keeps them live (workorder.* and
 * production.* events wait behind "N updates · Show": rows never move under the cursor). `?new=1` opens New work order.
 * `?new=1&order=<number>` opens it with that sales order chosen (the order studio's Make work orders).
 * Bulk: Export N (the selected rows through the shared export engine, B-W2b-13), Edit N (due date, priority and rush through
 * the review, then Undo) and Release N (B-W2b-59: the API's preview of the rows as they are now, with what holds each,
 * then each release through its own command). B-W2b-13: `?mode=board|calendar|cards` (the list frame's modes) and
 * `?due=<relative day>` (the quick filter; the API resolves the word with its today); the due date and priority edit in
 * the grid. B-W2b-59: `?rush=true` (the quick filter).
 */
const MODES: readonly ListMode[] = ['table', 'board', 'calendar', 'cards']
/** Today in the site's zone (YYYY-MM-DD): the calendar's today and the days late after a save. */
const romeDay = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
export function WorkOrdersPage() {
  return (
    <WithMessages namespaces={['production', DAILY_NAMESPACE, SHIFT_NAMESPACE, 'lists']}>
      <WorkOrdersContainer />
    </WithMessages>
  )
}

function WorkOrdersContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/production\/work-orders\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const view = viewFromAddress(params)
  const q = params?.get('q') ?? ''
  const mode = modeOfAddress(params, MODES)
  const dueWord = params?.get('due') ?? null
  const due: RelativeDay | null = isRelativeDay(dueWord) ? dueWord : null
  const rush = params?.get('rush') === 'true'
  const newAsked = params?.get('new') === '1'
  // `?new=1&order=<number>` (the sales order studio's "Make work orders"): the dialog opens with that order chosen.
  const autoPick = useRef<string | null>(newAsked ? (params?.get('order')?.trim() || null) : null)
  const chooseRef = useRef<(order: OrderOption | null) => void>(() => undefined)

  const [rows, setRows] = useState<WorkOrdersListModel['rows']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [counts, setCounts] = useState<WorkOrderCounts | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<WorkOrdersListModel['notice']>(null)
  const [newOrder, setNewOrder] = useState<NewWorkOrderModel | null>(null)
  const [release, setRelease] = useState<BulkReleaseModel | null>(null)
  const releaseKey = useRef(newIdempotencyKey())
  const readId = useRef(0)
  // B-W2a-46: the readiness word per row (one read per page of rows) and Hold N.
  const dcan = useMemo(() => dailyCan(session.permissions), [session.permissions])
  const [readiness, setReadiness] = useState<Record<string, ReadinessRow> | null>(null)
  const [daily, setDaily] = useState<DailyModel>(() => NO_DAILY(dcan))

  const address = useCallback(
    (next: { view?: ListView; q?: string; new?: boolean; mode?: ListMode; due?: RelativeDay | null; rush?: boolean }) => {
      const query = new URLSearchParams()
      const nextView = next.view ?? view
      const nextQ = next.q ?? q
      const nextMode = next.mode ?? mode
      const nextDue = next.due === undefined ? due : next.due
      const nextRush = next.rush ?? rush
      if (nextView !== 'open') query.set('view', nextView)
      if (nextQ.trim()) query.set('q', nextQ.trim())
      if (nextDue) query.set('due', nextDue)
      if (nextRush) query.set('rush', 'true')
      if (nextMode !== 'table') query.set('mode', nextMode)
      if (next.new) query.set('new', '1')
      const qs = query.toString()
      return `${pathname}${qs ? `?${qs}` : ''}`
    },
    [pathname, view, q, mode, due, rush],
  )

  const load = useCallback(async () => {
    const id = ++readId.current
    setRows((current) => ({ ...current, problem: null, items: current.items }))
    try {
      const page = await listWorkOrders(api, { ...viewQuery(view, q), due, rush })
      if (id !== readId.current) return
      setRows({ items: page.workOrders, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readProblem(error) })
    }
    countWorkOrders(api)
      .then((answer) => id === readId.current && setCounts(answer))
      .catch(() => id === readId.current && setCounts(null))
  }, [api, view, q, due, rush])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const readinessIds = (rows.items ?? []).filter((row) => READINESS_STATUSES.includes(row.status)).map((row) => row.id).slice(0, 100).join(',')
  useEffect(() => {
    if (!readinessIds) return
    getReadiness(api, readinessIds.split(','))
      .then((answer) => setReadiness(Object.fromEntries(answer.map((row) => [row.workOrderId, row]))))
      .catch(() => setReadiness(null))
  }, [api, readinessIds])

  useEffect(() => {
    if (daily.dialog?.kind !== 'hold' || daily.reasons) return
    holdReasons(api)
      .then((reasons) => setDaily((current) => ({ ...current, reasons })))
      .catch(() => setDaily((current) => ({ ...current, problem: { key: 'problem.read' } })))
  }, [api, daily.dialog, daily.reasons])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listWorkOrders(api, { ...viewQuery(view, q, cursor), due, rush })
      setRows((current) => ({ items: [...(current.items ?? []), ...page.workOrders.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: { key: readProblem(error) } })
    }
  }, [api, cursor, view, q, due, rush])

  // Live: a work order changed somewhere → "N updates · Show" (the tiles follow at once: they never move the cursor).
  const recount = useCoalesced(() => {
    countWorkOrders(api)
      .then(setCounts)
      .catch(() => undefined)
  }, 800)
  const live = useLive(
    (change) => {
      if (!liveTouches(change)) return
      if (change.type.startsWith('workorder.')) setUpdates((count) => count + 1)
      recount()
    },
    () => void load(),
  )

  // ?new=1 (Today's New ▾, the band's button): the dialog, once.
  useEffect(() => {
    if (newAsked && !newOrder && can.manage) setNewOrder({ ...NO_NEW_ORDER })
  }, [newAsked, newOrder, can.manage])

  // The dialog's order search.
  const searchOrders = useCallback(
    async (query: string) => {
      setNewOrder((current) => (current ? { ...current, query, orders: null, ordersProblem: null } : current))
      try {
        const orders = await findOrders(api, query)
        setNewOrder((current) => (current && current.query === query ? { ...current, orders } : current))
        const asked = autoPick.current
        if (asked && query === asked) {
          autoPick.current = null
          const match = orders.find((order) => order.number === asked)
          if (match) chooseRef.current(match)
        }
      } catch (error) {
        setNewOrder((current) => (current && current.query === query ? { ...current, orders: null, ordersProblem: readProblem(error) } : current))
      }
    },
    [api],
  )
  useEffect(() => {
    if (newOrder && newOrder.orders === null && newOrder.ordersProblem === null && newOrder.query === '' && can.orders) void searchOrders(autoPick.current ?? '')
    // Only when the dialog opens.
  }, [newOrder !== null])

  const chooseOrder = useCallback(
    async (order: OrderOption | null) => {
      setNewOrder((current) => (current ? { ...current, chosen: order, lines: null, linesProblem: null, styleId: null, picked: [], grid: {}, problem: null } : current))
      if (!order) return
      try {
        const lines = await getOpenLines(api, order.id)
        setNewOrder((current) => {
          if (!current || current.chosen?.id !== order.id) return current
          const styles = stylesOf(lines).filter((style) => style.open > 0)
          const styleId = styles[0]?.id ?? null
          const own = linesOfStyle(lines, styleId).filter((line) => !line.madeToMeasure && line.sizes.some((size) => size.open > 0))
          return { ...current, lines, styleId, picked: own.map((line) => line.id), grid: Object.fromEntries(own.map((line) => [line.id, openGridOf(line)])) }
        })
      } catch (error) {
        setNewOrder((current) => (current && current.chosen?.id === order.id ? { ...current, linesProblem: readProblem(error) } : current))
      }
    },
    [api],
  )

  chooseRef.current = (order) => void chooseOrder(order)

  const create = useCallback(async () => {
    const current = newOrder
    if (!current || current.busy) return
    setNewOrder({ ...current, busy: true, problem: null })
    try {
      const lines = current.picked.map((lineId) => ({
        salesOrderLineId: lineId,
        sizes: Object.entries(current.grid[lineId] ?? {})
          .filter(([, quantity]) => quantity > 0)
          .map(([size, quantity]) => ({ size, quantity })),
      }))
      const created = await createWorkOrder(api, { ...(current.dueDate ? { dueDate: current.dueDate } : {}), lines: lines.filter((line) => line.sizes.length > 0) })
      setNewOrder(null)
      router.push(`${prefix}/production/work-orders/${created.id}`)
    } catch (error) {
      setNewOrder((state) => (state ? { ...state, busy: false, problem: writeProblem(error) } : state))
    }
  }, [api, newOrder, prefix, router])

  // B-W2b-13: a cell or Edit N saved — the row takes its new due date, priority and version (days late follow the due date).
  const saved = useCallback((rowId: string, after: Readonly<Record<string, string | number | null>>, version: number) => {
    setRows((current) => ({
      ...current,
      items:
        current.items?.map((row) => {
          if (row.id !== rowId) return row
          const dueDate = 'due' in after ? ((after.due as string | null) ?? null) : row.dueDate
          const priority = typeof after.priority === 'number' ? after.priority : row.priority
          const rushed = typeof after.rush === 'string' ? after.rush === 'RUSH' : row.rush
          return { ...row, dueDate, priority, rush: rushed, version, daysLate: daysLate(row.status, dueDate, romeDay()) }
        }) ?? null,
    }))
  }, [])

  // B-W2b-59 (MES-017): Release N — the preview reads each row as it is now, Save releases each through its own command.
  const readRelease = useCallback(
    (ids: readonly string[]) => {
      setRelease((state) => (state ? { ...state, preview: null, state: { phase: 'reading' } } : state))
      previewRelease(api, ids)
        .then((preview) => setRelease((state) => (state ? { ...state, preview, state: { phase: 'ready' } } : state)))
        .catch((error: unknown) => setRelease((state) => (state ? { ...state, state: { phase: 'failed', words: { key: readProblem(error) } } } : state)))
    },
    [api],
  )
  const runRelease = useCallback(() => {
    if (!release?.preview || release.state.phase !== 'ready') return
    setRelease({ ...release, state: { phase: 'saving' } })
    applyRelease(api, applyRowsOf(release.preview), releaseKey.current)
      .then((results) => {
        setRelease((state) => (state ? { ...state, state: { phase: 'done', results } } : state))
        void load()
      })
      .catch((error: unknown) => setRelease((state) => (state ? { ...state, state: { phase: 'failed', words: writeProblem(error) } } : state)))
  }, [api, release, load])

  const model: WorkOrdersListModel = {
    prefix,
    can,
    view,
    q,
    mode,
    due,
    rush,
    today: romeDay(),
    rows,
    counts,
    asOf,
    live,
    updates,
    notice,
    newOrder,
    release,
    readiness,
    daily: { ...daily, can: dcan },
  }

  return (
    <WorkOrdersListView
      model={model}
      actions={{
        onView: (next) => router.replace(address({ view: next })),
        onSearch: (next) => router.replace(address({ q: next })),
        onMore: () => void more(),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(`${prefix}/production/work-orders/${id}`),
        onMode: (next) => router.replace(address({ mode: next })),
        onDue: (next) => router.replace(address({ due: next })),
        onRush: (next) => router.replace(address({ rush: next })),
        onSaved: saved,
        onReleaseMany: (ids) => {
          const picked = (rows.items ?? []).filter((row: WorkOrderRow) => ids.includes(row.id))
          releaseKey.current = newIdempotencyKey()
          setRelease({ rows: picked.map((row) => ({ id: row.id, number: row.number, styleCode: row.styleCode })), preview: null, state: { phase: 'reading' } })
          readRelease(ids)
        },
        onRunRelease: runRelease,
        onRetryRelease: () => release && readRelease(release.rows.map((row) => row.id)),
        onCloseRelease: () => setRelease(null),
        onDismissNotice: () => setNotice(null),
        daily: {
          onDialog: (next) => setDaily((current) => ({ ...current, dialog: next, problem: null })),
          onPlaceHold: (input) => {
            if (daily.busy) return
            setDaily((current) => ({ ...current, busy: true, problem: null }))
            placeHold(api, input)
              .then((answer) => {
                setDaily((current) => ({ ...current, busy: false, dialog: null }))
                setNotice({ tone: 'success', words: { key: `${DAILY_NAMESPACE}:notice.heldMany`, params: { count: answer.workOrdersHeld.length } } })
                void load()
              })
              .catch((error: unknown) => setDaily((current) => ({ ...current, busy: false, problem: dailyProblem(error) })))
          },
        },
        onNew: (open) => {
          if (open) setNewOrder({ ...NO_NEW_ORDER })
          else {
            setNewOrder(null)
            if (newAsked) router.replace(address({}))
          }
        },
        newOrder: {
          onQuery: (query) => void searchOrders(query),
          onChoose: (order) => void chooseOrder(order),
          onStyle: (styleId) =>
            setNewOrder((current) => {
              if (!current) return current
              const own = linesOfStyle(current.lines, styleId).filter((line) => !line.madeToMeasure && line.sizes.some((size) => size.open > 0))
              return { ...current, styleId, picked: own.map((line) => line.id), grid: Object.fromEntries(own.map((line) => [line.id, openGridOf(line)])) }
            }),
          onPick: (lineId, on) =>
            setNewOrder((current) => {
              if (!current) return current
              const line = current.lines?.lines.find((entry) => entry.id === lineId)
              const picked = on ? [...new Set([...current.picked, lineId])] : current.picked.filter((id) => id !== lineId)
              const grid = { ...current.grid }
              if (on && line && !grid[lineId]) grid[lineId] = openGridOf(line)
              return { ...current, picked, grid }
            }),
          onGrid: (grid) => setNewOrder((current) => (current ? { ...current, grid } : current)),
          onDueDate: (dueDate) => setNewOrder((current) => (current ? { ...current, dueDate } : current)),
          onCreate: () => void create(),
        },
      }}
    />
  )
}
