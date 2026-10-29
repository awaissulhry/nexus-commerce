'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { findSuppliers, listSites, type SiteOption } from '../../../_shared/buying/api'
import { downloadText, useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { buyingCan, csvOf, phrase, readProblem, writeProblem } from '../../../_shared/buying/model'
import { createOrder, listOrders, type OrderRow, type OrderSummary } from '../api'
import { NO_NEW_ORDER, orderQuery, orderViewOf, type NewOrderModel, type OrdersListModel, type OrderView } from '../model'
import { OrdersListView } from './view/OrdersListView'

/**
 * `/w/<company>/purchasing/orders` (SCR-058): the orders of the saved view (`?view=`, or the API's own `?status=` and
 * `?waitingOver48h=true` as Today links them) and the search (`?q=`), 50 a page with "Show more", the tiles' counts
 * (the list's summary), the sites (for the site column and New purchase order), and live purchase_order.* events behind
 * "N updates · Show". `?new=1` opens New purchase order; it opens the new draft's studio.
 */
export function OrdersPage() {
  return (
    <WithMessages namespaces={['buying', 'lists']}>
      <OrdersContainer />
    </WithMessages>
  )
}

function OrdersContainer() {
  const t = useT('buying')
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/purchasing\/orders\/?$/, '')
  const can = useMemo(() => buyingCan(session.permissions), [session.permissions])
  const view = orderViewOf(params)
  const q = params?.get('q') ?? ''
  const newAsked = params?.get('new') === '1'

  const [rows, setRows] = useState<OrdersListModel['rows']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [summary, setSummary] = useState<OrderSummary | null>(null)
  const [sites, setSites] = useState<SiteOption[]>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<OrdersListModel['notice']>(null)
  const [newOrder, setNewOrder] = useState<NewOrderModel | null>(null)
  const readId = useRef(0)

  const address = useCallback(
    (next: { view?: OrderView; q?: string }) => {
      const query = new URLSearchParams()
      const nextView = next.view ?? view
      const nextQ = next.q ?? q
      if (nextView !== 'all') query.set('view', nextView)
      if (nextQ.trim()) query.set('q', nextQ.trim())
      const qs = query.toString()
      return `${pathname}${qs ? `?${qs}` : ''}`
    },
    [pathname, view, q],
  )

  const load = useCallback(async () => {
    if (!can.poView) return
    const id = ++readId.current
    try {
      const page = await listOrders(api, orderQuery(view, q))
      if (id !== readId.current) return
      setRows({ items: page.orders, more: page.nextCursor !== null, problem: null })
      setSummary(page.summary)
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readProblem(error) })
    }
  }, [api, can.poView, view, q])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])

  useEffect(() => {
    if (!can.sites) return
    listSites(api, session.company?.id ?? null)
      .then(setSites)
      .catch(() => setSites([]))
  }, [api, can.sites, session.company?.id])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listOrders(api, orderQuery(view, q, cursor))
      setRows((current) => ({ items: [...(current.items ?? []), ...page.orders.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: phrase(readProblem(error)) })
    }
  }, [api, cursor, view, q])

  // Live: an order changed somewhere → "N updates · Show" (rows never move under the cursor); the tiles follow at once.
  const recount = useCoalesced(() => {
    listOrders(api, { ...orderQuery(view, q), limit: 1 })
      .then((page) => setSummary(page.summary))
      .catch(() => undefined)
  }, 800)
  const live = useLive(
    (change) => {
      if (!change.type.startsWith('purchase_order.')) return
      setUpdates((count) => count + 1)
      recount()
    },
    () => void load(),
    can.poView,
  )

  // ?new=1 (Today's New ▾, the band's button): the dialog, once.
  const openNew = useCallback(() => {
    const draft: NewOrderModel = { ...NO_NEW_ORDER, siteId: sites.length === 1 ? sites[0]!.id : null }
    setNewOrder(draft)
    findSuppliers(api, '')
      .then((suppliers) => setNewOrder((current) => (current && current.query === '' ? { ...current, suppliers } : current)))
      .catch((error: unknown) => setNewOrder((current) => (current ? { ...current, suppliers: [], suppliersProblem: readProblem(error) } : current)))
  }, [api, sites])
  useEffect(() => {
    if (newAsked && !newOrder && can.poManage) openNew()
    // Only when the address asks.
  }, [newAsked])

  const searchSuppliers = useCallback(
    (text: string) => {
      setNewOrder((current) => (current ? { ...current, query: text, suppliers: null, suppliersProblem: null } : current))
      findSuppliers(api, text)
        .then((suppliers) => setNewOrder((current) => (current && current.query === text ? { ...current, suppliers } : current)))
        .catch((error: unknown) => setNewOrder((current) => (current && current.query === text ? { ...current, suppliers: [], suppliersProblem: readProblem(error) } : current)))
    },
    [api],
  )

  const create = useCallback(async () => {
    const draft = newOrder
    if (!draft || draft.busy || !draft.supplier || !draft.siteId) return
    const site = sites.find((entry) => entry.id === draft.siteId)
    const companyId = site?.companyId ?? session.company?.id
    if (!companyId) return
    setNewOrder({ ...draft, busy: true, problem: null })
    try {
      const order = await createOrder(api, { companyId, siteId: draft.siteId, partyId: draft.supplier.id, ...(draft.requestedDate ? { requestedDate: draft.requestedDate } : {}) })
      setNewOrder(null)
      router.push(`${prefix}/purchasing/orders/${order.id}?tab=lines`)
    } catch (error) {
      setNewOrder((current) => (current ? { ...current, busy: false, problem: writeProblem(error, (_paths, info) => (info.kind === 'conflict' ? phrase('po.new.refused') : null)) } : current))
    }
  }, [api, newOrder, prefix, router, session.company?.id, sites])

  const exportRows = useCallback(
    (ids: string[]) => {
      const picked = (rows.items ?? []).filter((row: OrderRow) => ids.includes(row.id))
      const header = ['number', 'supplier', 'status', 'orderDate', 'need', 'confirmed', 'lines', ...(can.cost ? ['value', 'currency'] : []), 'site'].map((column) => t(`po.csv.${column}`))
      const csvRows = picked.map((row) => [
        row.number,
        row.supplierName,
        t(`poStatus.${row.status}`),
        row.orderDate,
        row.earliestNeedDate ?? '',
        row.latestConfirmedDate ?? '',
        row.lineCount,
        ...(can.cost ? [row.netAmount === undefined ? '' : (row.netAmount / 100).toFixed(2), row.currency] : []),
        sites.find((site) => site.id === row.siteId)?.code ?? '',
      ])
      downloadText(`purchase-orders-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(header, csvRows))
    },
    [rows.items, can.cost, sites, t],
  )

  const model: OrdersListModel = { prefix, can, view, q, rows, summary, sites, asOf, live, updates, notice, newOrder }

  return (
    <OrdersListView
      model={model}
      actions={{
        onView: (next) => router.replace(address({ view: next })),
        onSearch: (next) => router.replace(address({ q: next })),
        onMore: () => void more(),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onExport: exportRows,
        onOpen: (id) => router.push(`${prefix}/purchasing/orders/${id}`),
        onDismissNotice: () => setNotice(null),
        onNew: (open) => {
          if (open) openNew()
          else {
            setNewOrder(null)
            if (newAsked) router.replace(address({}))
          }
        },
        newOrder: {
          onQuery: searchSuppliers,
          onSupplier: (supplier) => setNewOrder((current) => (current ? { ...current, supplier } : current)),
          onSite: (siteId) => setNewOrder((current) => (current ? { ...current, siteId: siteId || null } : current)),
          onRequestedDate: (requestedDate) => setNewOrder((current) => (current ? { ...current, requestedDate } : current)),
          onCreate: () => void create(),
        },
      }}
    />
  )
}
