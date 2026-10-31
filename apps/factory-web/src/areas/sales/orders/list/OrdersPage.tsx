'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { findCustomers, getParty } from '../../quotes/api'
import { getBoard, listOrders, nextOrderNumber, type OrderBoard } from '../api'
import { downloadText, useCoalesced, useLive } from '../hooks'
import { abilitiesOf, boardLanes, laneQuery, layoutFromAddress, listAddress, listTouches, ordersCsv, readProblem, romeToday, rowsFromAddress, rowsQuery, type Lane, type Layout, type RowView } from '../model'
import { newOrderAddress } from '../new/new-model'
import type { NewOrderDialogModel, OrdersListModel } from './list-model'
import { OrdersListView } from './view/OrdersListView'
import { useListMargins } from './margin/use-list-margins'

/**
 * `/w/<company>/sales/orders` (SCR-038): reads the orders of the saved rows view and the search from the address (the
 * API's own filters: `?late=true`, `?deposit=OPEN`, `?status=…`, `?rows=all`, `?q=`; `?view=board` the board), 50 a
 * page with "Show more" (cursor), the tiles' and lanes' counts (GET /sales/orders/board), and keeps them live: a new
 * order from an accepted quote, a deposit paid, a state that moved wait behind "N updates · Show" (rows never move under
 * the cursor; the tiles follow at once). The board reads each lane (50 cards each). Export N = CSV of the loaded rows.
 * B-W2a-50: the board follows live changes by itself (it is left open on a second screen: the cards hold no selection);
 * New order (`?new=1` opens it): the customer search, the customer read in full, the number it will get → the typed
 * order's page.
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
  const companyId = session.company?.id ?? session.companies[0]?.id ?? ''
  const [newOrder, setNewOrder] = useState<NewOrderDialogModel | null>(params?.get('new') === '1' && can.manage ? emptyNew(session.companies, companyId) : null)
  const searchSeq = useRef(0)

  const go = useCallback((next: { rows?: RowView; q?: string; layout?: Layout }) => router.replace(listAddress(pathname, { rows: next.rows ?? rows, q: next.q ?? q, layout: next.layout ?? layout })), [router, pathname, rows, q, layout])

  const readBoard = useCallback(
    (id: number) => {
      getBoard(api, q)
        .then((answer) => id === readId.current && setBoard(answer))
        .catch(() => id === readId.current && setBoard(null))
    },
    [api, q],
  )

  const load = useCallback(async (silent = false) => {
    const id = ++readId.current
    readBoard(id)
    if (layout === 'board') {
      const shown = boardLanes(rows)
      // A live re-read keeps the cards in place (the focus stays) until the new ones arrive.
      if (!silent) setLanes(shown.map((status) => ({ status, items: null, more: false, problem: null })))
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

  // Live: an order event (a new order, a move, a deposit paid…) → "N updates · Show"; the tiles follow at once. The
  // board reads its lanes again by itself (B-W2a-50: a board left open on a second screen).
  const recount = useCoalesced(() => readBoard(readId.current), 800)
  const rereadBoard = useCoalesced(() => void load(true), 900)
  const live = useLive(
    (change) => {
      if (!listTouches(change)) return
      if (layout === 'board') {
        rereadBoard()
        return
      }
      setUpdates((count) => count + 1)
      recount()
    },
    () => void load(),
  )

  // ---- New order (B-W2a-50) --------------------------------------------------------------------------------------------
  const searchCustomers = useCallback(
    (query: string, company: string) => {
      const mine = ++searchSeq.current
      setNewOrder((current) => (current ? { ...current, results: null, searchProblem: null } : current))
      findCustomers(api, query, company || null)
        .then((results) => mine === searchSeq.current && setNewOrder((current) => (current ? { ...current, results } : current)))
        .catch((error: unknown) => mine === searchSeq.current && setNewOrder((current) => (current ? { ...current, searchProblem: readProblem(error) } : current)))
    },
    [api],
  )
  const readNumber = useCallback(
    (company: string) => {
      setNewOrder((current) => (current ? { ...current, number: undefined } : current))
      nextOrderNumber(api, company)
        .then((number) => setNewOrder((current) => (current && current.companyId === company ? { ...current, number } : current)))
        .catch(() => setNewOrder((current) => (current && current.companyId === company ? { ...current, number: null } : current)))
    },
    [api],
  )
  const opened = newOrder !== null
  const openedCompany = newOrder?.companyId ?? ''
  useEffect(() => {
    if (!opened) return
    searchCustomers('', openedCompany)
    readNumber(openedCompany)
  }, [opened, openedCompany, searchCustomers, readNumber])

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

  // B-W2a-72: the Margin % column (margin grain): the margins of the orders on screen.
  const margins = useListMargins(api, layout === 'board' ? null : list.items, q, session.permissions, asOf)

  const model: OrdersListModel = { prefix, can, today: romeToday(), layout, rows, q, list, lanes, board, asOf, live, updates, notice, newOrder, margins }

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
        onNewOrder: (open) => setNewOrder(open && can.manage ? emptyNew(session.companies, companyId) : null),
        onNewCompany: (company) => setNewOrder((current) => (current ? { ...current, companyId: company, party: null, contactId: '' } : current)),
        onNewSearch: (query) => newOrder && searchCustomers(query, newOrder.companyId),
        onNewPick: (partyId) => {
          if (!partyId) {
            setNewOrder((current) => (current ? { ...current, party: null, partyProblem: null, contactId: '' } : current))
            return
          }
          getParty(api, partyId)
            .then((party) => {
              const orders = party.contacts.find((contact) => contact.status === 'ACTIVE' && contact.roles.includes('ORDERS'))
              setNewOrder((current) => (current ? { ...current, party, partyProblem: null, contactId: orders?.id ?? '' } : current))
            })
            .catch((error: unknown) => setNewOrder((current) => (current ? { ...current, partyProblem: readProblem(error) } : current)))
        },
        onNewField: (field, value) => setNewOrder((current) => (current ? { ...current, [field]: value } : current)),
        onNewCreate: () => {
          if (!newOrder?.party) return
          router.push(newOrderAddress(prefix, { companyId: newOrder.companyId, partyId: newOrder.party.id, contactId: newOrder.contactId, customerRef: newOrder.customerRef }))
        },
      }}
    />
  )
}

function emptyNew(companies: NewOrderDialogModel['companies'], companyId: string): NewOrderDialogModel {
  return { companies, companyId, results: null, searchProblem: null, party: null, partyProblem: null, contactId: '', customerRef: '', number: undefined }
}
