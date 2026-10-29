'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import {
  countWorkOrders,
  createWorkOrder,
  findOrders,
  getOpenLines,
  getWorkOrder,
  listWorkOrders,
  releaseWorkOrder,
  type OrderOption,
  type WorkOrderCounts,
  type WorkOrderRow,
} from '../_shared/api'
import { downloadText, useCoalesced, useLive } from '../_shared/hooks'
import { abilitiesOf, liveTouches, readProblem, releaseRefusalCodes, viewFromAddress, viewQuery, workOrdersCsv, writeProblem, type ListView } from '../_shared/model'
import { linesOfStyle, NO_NEW_ORDER, openGridOf, stylesOf, type BulkReleaseModel, type NewWorkOrderModel, type WorkOrdersListModel } from './list-model'
import { WorkOrdersListView } from './view/WorkOrdersListView'

/**
 * `/w/<company>/production/work-orders` (SCR-069): reads the work orders of the saved view (`?view=`, default open) and
 * the search (`?q=`), 50 a page with "Show more" (cursor), the tiles' counts, and keeps them live (workorder.* and
 * production.* events wait behind "N updates · Show": rows never move under the cursor). `?new=1` opens New work order.
 * Bulk: Export N (CSV, the loaded rows) and Release N (one release per draft, in turn, each with its version; the API
 * checks each one again and says what holds it).
 */
export function WorkOrdersPage() {
  return (
    <WithMessages namespaces={['production', 'lists']}>
      <WorkOrdersContainer />
    </WithMessages>
  )
}

function WorkOrdersContainer() {
  const t = useT('production')
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/production\/work-orders\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const view = viewFromAddress(params)
  const q = params?.get('q') ?? ''
  const newAsked = params?.get('new') === '1'

  const [rows, setRows] = useState<WorkOrdersListModel['rows']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [counts, setCounts] = useState<WorkOrderCounts | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<WorkOrdersListModel['notice']>(null)
  const [newOrder, setNewOrder] = useState<NewWorkOrderModel | null>(null)
  const [release, setRelease] = useState<BulkReleaseModel | null>(null)
  const readId = useRef(0)

  const address = useCallback(
    (next: { view?: ListView; q?: string; new?: boolean }) => {
      const query = new URLSearchParams()
      const nextView = next.view ?? view
      const nextQ = next.q ?? q
      if (nextView !== 'open') query.set('view', nextView)
      if (nextQ.trim()) query.set('q', nextQ.trim())
      if (next.new) query.set('new', '1')
      const qs = query.toString()
      return `${pathname}${qs ? `?${qs}` : ''}`
    },
    [pathname, view, q],
  )

  const load = useCallback(async () => {
    const id = ++readId.current
    setRows((current) => ({ ...current, problem: null, items: current.items }))
    try {
      const page = await listWorkOrders(api, viewQuery(view, q))
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
  }, [api, view, q])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listWorkOrders(api, viewQuery(view, q, cursor))
      setRows((current) => ({ items: [...(current.items ?? []), ...page.workOrders.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: { key: readProblem(error) } })
    }
  }, [api, cursor, view, q])

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
      } catch (error) {
        setNewOrder((current) => (current && current.query === query ? { ...current, orders: null, ordersProblem: readProblem(error) } : current))
      }
    },
    [api],
  )
  useEffect(() => {
    if (newOrder && newOrder.orders === null && newOrder.ordersProblem === null && newOrder.query === '' && can.orders) void searchOrders('')
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

  const exportRows = useCallback(
    (ids: string[]) => {
      const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
      const header = ['number', 'batch', 'status', 'style', 'styleName', 'colourways', 'customer', 'orders', 'pieces', 'cut', 'bundled', 'sewn', 'finished', 'due', 'daysLate', 'priority', 'site'].map((column) => t(`csv.${column}`))
      downloadText(`work-orders-${new Date().toISOString().slice(0, 10)}.csv`, workOrdersCsv(picked, { header, status: (status) => t(`status.${status}`) }))
    },
    [rows.items, t],
  )

  const runRelease = useCallback(async () => {
    if (!release || release.running) return
    setRelease({ ...release, running: true })
    const results: BulkReleaseModel['results'] = {}
    for (const row of release.rows) {
      try {
        // The version as it is now (a draft may have changed since the list was read).
        const current = await getWorkOrder(api, row.id)
        const released = await releaseWorkOrder(api, row.id, { version: current.version })
        results[row.id] = { state: 'released', batchNumber: released.batchNumber }
      } catch (error) {
        const codes = releaseRefusalCodes(error)
        results[row.id] = codes.length > 0 ? { state: 'held', codes } : { state: 'failed', words: writeProblem(error) }
      }
      setRelease((state) => (state ? { ...state, results: { ...results } } : state))
    }
    setRelease((state) => (state ? { ...state, running: false, done: true, results: { ...results } } : state))
    void load()
  }, [api, release, load])

  const model: WorkOrdersListModel = {
    prefix,
    can,
    view,
    q,
    rows,
    counts,
    asOf,
    live,
    updates,
    notice,
    newOrder,
    release,
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
        onExport: exportRows,
        onReleaseMany: (ids) => {
          const picked = (rows.items ?? []).filter((row: WorkOrderRow) => ids.includes(row.id))
          setRelease({ rows: picked.map((row) => ({ id: row.id, number: row.number, styleCode: row.styleCode })), running: false, done: false, results: {} })
        },
        onRunRelease: () => void runRelease(),
        onCloseRelease: () => setRelease(null),
        onDismissNotice: () => setNotice(null),
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
