'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { getBoard, listOrders, type OrderBoard } from '../api'
import { downloadText, useCoalesced, useLive } from '../hooks'
import { abilitiesOf, boardLanes, laneQuery, layoutFromAddress, listAddress, listTouches, ordersCsv, readProblem, romeToday, rowsFromAddress, rowsQuery, type Lane, type Layout, type RowView } from '../model'
import type { OrdersListModel } from './list-model'
import { OrdersListView } from './view/OrdersListView'

/**
 * `/w/<company>/sales/orders` (SCR-038): reads the orders of the saved rows view and the search from the address (the
 * API's own filters: `?late=true`, `?deposit=OPEN`, `?status=…`, `?rows=all`, `?q=`; `?view=board` the board), 50 a
 * page with "Show more" (cursor), the tiles' and lanes' counts (GET /sales/orders/board), and keeps them live: a new
 * order from an accepted quote, a deposit paid, a state that moved wait behind "N updates · Show" (rows never move under
 * the cursor; the tiles follow at once). The board reads each lane (50 cards each). Export N = CSV of the loaded rows.
 */
export function OrdersPage() {
  return (
    <WithMessages namespaces={['orders', 'lists']}>
      <OrdersContainer />
    </WithMessages>
  )
}

function OrdersContainer() {
  const t = useT('orders')
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/sales\/orders\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const rows = rowsFromAddress(params)
  const layout = layoutFromAddress(params)
  const q = params?.get('q') ?? ''

  const [list, setList] = useState<OrdersListModel['list']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [lanes, setLanes] = useState<Lane[]>([])
  const [board, setBoard] = useState<OrderBoard | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<OrdersListModel['notice']>(null)
  const readId = useRef(0)

  const go = useCallback((next: { rows?: RowView; q?: string; layout?: Layout }) => router.replace(listAddress(pathname, { rows: next.rows ?? rows, q: next.q ?? q, layout: next.layout ?? layout })), [router, pathname, rows, q, layout])

  const readBoard = useCallback(
    (id: number) => {
      getBoard(api, q)
        .then((answer) => id === readId.current && setBoard(answer))
        .catch(() => id === readId.current && setBoard(null))
    },
    [api, q],
  )

  const load = useCallback(async () => {
    const id = ++readId.current
    readBoard(id)
    if (layout === 'board') {
      const shown = boardLanes(rows)
      setLanes(shown.map((status) => ({ status, items: null, more: false, problem: null })))
      await Promise.all(
        shown.map(async (status) => {
          try {
            const page = await listOrders(api, laneQuery(status, rows, q))
            if (id !== readId.current) return
            setLanes((current) => current.map((lane) => (lane.status === status ? { status, items: page.orders, more: page.nextCursor !== null, problem: null } : lane)))
          } catch (error) {
            if (id !== readId.current) return
            setLanes((current) => current.map((lane) => (lane.status === status ? { status, items: null, more: false, problem: readProblem(error) } : lane)))
          }
        }),
      )
      if (id === readId.current) {
        setAsOf(new Date().toISOString())
        setUpdates(0)
      }
      return
    }
    setList((current) => ({ ...current, problem: null }))
    try {
      const page = await listOrders(api, rowsQuery(rows, q))
      if (id !== readId.current) return
      setList({ items: page.orders, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setList({ items: null, more: false, problem: readProblem(error) })
    }
  }, [api, rows, q, layout, readBoard])

  useEffect(() => {
    setList({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listOrders(api, rowsQuery(rows, q, cursor))
      setList((current) => ({ items: [...(current.items ?? []), ...page.orders.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: { key: readProblem(error) } })
    }
  }, [api, cursor, rows, q])

  // Live: an order event (a new order, a move, a deposit paid…) → "N updates · Show"; the tiles follow at once.
  const recount = useCoalesced(() => readBoard(readId.current), 800)
  const live = useLive(
    (change) => {
      if (!listTouches(change)) return
      setUpdates((count) => count + 1)
      recount()
    },
    () => void load(),
  )

  const exportRows = useCallback(
    (ids: string[]) => {
      const picked = (list.items ?? []).filter((row) => ids.includes(row.id))
      downloadText(
        `orders-${romeToday()}.csv`,
        ordersCsv(picked, can.price, { header: (column) => t(`csv.${column}`), status: (status) => t(`status.${status}`), deposit: (state) => t(`deposit.${state}`) }, locale),
      )
    },
    [list.items, can.price, t, locale],
  )

  const model: OrdersListModel = { prefix, can, today: romeToday(), layout, rows, q, list, lanes, board, asOf, live, updates, notice }

  return (
    <OrdersListView
      model={model}
      actions={{
        onRows: (next) => go({ rows: next }),
        onLayout: (next) => go({ layout: next }),
        onSearch: (next) => go({ q: next }),
        onMore: () => void more(),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(`${prefix}/sales/orders/${id}`),
        onExport: exportRows,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
