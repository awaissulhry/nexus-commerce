'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive } from '../../shell/frame'
import { fetchRequests, type RequestRow } from '../requests/api'
import { fetchInTransit, fetchOrders, ORDER_CHIPS, PAGE_SIZE, type InTransitRead, type OrderRow, type OrdersRead } from './api'
import { listBandOf } from './band'
import { CLOSED_REQUESTS, isListChip, listCsv, listQuery, listRows, NAV_KEY, NS, opens, ordersInChip, recordHref, rowHref, type ListChip } from './model'
import { saveText, useOffline } from './hooks'
import { OrdersListView } from './view/OrdersListView'
import { OrdersPrintView } from './view/OrdersPrintView'
import { NotInAccess } from './view/parts'
import { useOrderWords } from './words'

/**
 * `/p/<party>/orders` for a customer — Orders & requests (B-W2b-191; B-TH-223, B-TH-303; design portal.customer.orders): reads
 * GET /portal/sales-orders with the chip and search of the address (pages of 50 by `offset`), the customer's requests (GET
 * /portal/inquiries, every state, up to 200: the chip and the search narrow them here), and "On the way" (GET …/in-transit);
 * fills the band (Updated, New order, Export this view, Print this list), keeps the selection (Export N), tells of changes on
 * the live channel without moving the rows ("N updates · Show"; a request's event reads the requests again), and keeps what
 * was loaded when the connection is gone. `?print=1` is the print view.
 */
export function CustomerOrdersPage() {
  return (
    <WithMessages namespaces={[NS, 'ds-words', 'lists']}>
      <Suspense fallback={null}>
        <OrdersRoute />
      </Suspense>
    </WithMessages>
  )
}

function OrdersRoute() {
  const frame = usePortalFrame()
  const search = useSearchParams()
  const allowed = frame.kinds.includes('CUSTOMER') && frame.me.permissions.includes('portal.salesOrders.view')
  const { t } = useOrderWords()
  if (!allowed) return <Closed title={t('list.title')} />
  return search?.get('print') === '1' ? <PrintContainer /> : <ListContainer />
}

export function Closed({ title }: { title: string }) {
  const frame = usePortalFrame()
  usePortalBand({ title })
  return <NotInAccess admins={(frame.access?.admins ?? []).map((admin) => admin.displayName)} homeHref={frame.prefix} />
}

function ListContainer() {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const search = useSearchParams()
  const words = useOrderWords()
  const { t, locale, day } = words
  const offline = useOffline()
  const chipParam = search?.get('chip') ?? null
  const chip: ListChip | null = isListChip(chipParam, ORDER_CHIPS) ? chipParam : null
  const q = search?.get('q') ?? ''
  // B-TH-223: the requests are read whole (every state) and narrowed here; a reader without the orders' right reads none.
  const seesRequests = frame.me.permissions.includes('portal.salesOrders.view')
  const [requests, setRequests] = useState<{ state: 'loading' | 'error' | 'ready' | 'none'; rows: RequestRow[]; complete: boolean }>({ state: seesRequests ? 'loading' : 'none', rows: [], complete: true })

  const [read, setRead] = useState<OrdersRead | null>(null)
  const [rows, setRows] = useState<OrderRow[]>([])
  const [state, setState] = useState<'loading' | 'error' | 'ready' | 'forbidden'>('loading')
  const [selected, setSelected] = useState<string[]>([])
  const [updates, setUpdates] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [transit, setTransit] = useState<{ state: 'loading' | 'error' | 'ready'; read: InTransitRead | null }>({ state: 'loading', read: null })
  const reading = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    reading.current?.abort()
    const control = new AbortController()
    reading.current = control
    try {
      // Closed requests hold no order: the orders' read only brings the chips' counts then.
      const next = chip !== null && !ordersInChip(chip) ? await fetchOrders(api, { chip: 'OPEN', q, limit: 1 }, control.signal) : await fetchOrders(api, { chip: chip as Exclude<ListChip, typeof CLOSED_REQUESTS> | null, q }, control.signal)
      if (control.signal.aborted) return
      setRead(next)
      setRows(chip !== null && !ordersInChip(chip) ? [] : next.items)
      setState('ready')
      setUpdates(0)
      setSelected((current) => current.filter((id) => next.items.some((row) => row.id === id)))
    } catch (error) {
      if (control.signal.aborted) return
      setState(isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : 'error')
    }
  }, [api, chip, q])

  const loadRequests = useCallback(async () => {
    if (!seesRequests) return
    try {
      const next = await fetchRequests(api, { state: 'ALL', limit: 200 })
      setRequests({ state: 'ready', rows: next.rows, complete: next.complete })
    } catch {
      setRequests((current) => ({ ...current, state: 'error' }))
    }
  }, [api, seesRequests])
  useEffect(() => {
    void loadRequests()
  }, [loadRequests])

  const loadTransit = useCallback(async () => {
    try {
      setTransit({ state: 'ready', read: await fetchInTransit(api) })
    } catch {
      setTransit((current) => ({ state: 'error', read: current.read }))
    }
  }, [api])

  useEffect(() => {
    setState((current) => (current === 'ready' ? current : 'loading'))
    void load()
    return () => reading.current?.abort()
  }, [load])
  useEffect(() => {
    void loadTransit()
  }, [loadTransit])

  // J / K on an order walk the list the person came from.
  useEffect(() => {
    try {
      window.sessionStorage.setItem(NAV_KEY, JSON.stringify((chip !== null && !ordersInChip(chip) ? [] : rows).filter(opens).map((row) => row.id)))
    } catch {
      // No storage (a private window): J / K simply have no list.
    }
  }, [rows])

  usePortalLive({
    onChange: (change) => {
      if (read?.live.events.includes(change.type)) setUpdates((count) => count + 1)
      // B-TH-223: a request of this customer moved (our answer, a quote, its order): its row reads again in place.
      if (change.type.startsWith('inquiry.')) void loadRequests()
      void loadTransit()
    },
    onReconnect: () => {
      setUpdates((count) => count + 1)
      void loadRequests()
    },
  })

  const more = async () => {
    if (!read || loadingMore || (chip !== null && !ordersInChip(chip))) return
    setLoadingMore(true)
    try {
      const next = await fetchOrders(api, { chip: chip as Exclude<ListChip, typeof CLOSED_REQUESTS> | null, q, offset: rows.length })
      setRows((current) => [...current, ...next.items.filter((row) => !current.some((old) => old.id === row.id))])
    } catch {
      setState('error')
    } finally {
      setLoadingMore(false)
    }
  }

  const go = (nextChip: ListChip | null, nextQ: string) => router.replace(`${pathname}${listQuery(nextChip, nextQ)}`, { scroll: false })
  // B-TH-223: the file holds the rows shown (requests and orders), each with the customer's own number.
  const shownRows = listRows(chip ?? read?.chip ?? 'OPEN', q, requests.state === 'ready' ? requests.rows : [], rows, locale)
  const exportRows = (ids: readonly string[] | null) => {
    const shown = ids ? shownRows.filter((row) => ids.includes(row.id)) : shownRows
    saveText(`${t('list.fileName')}.csv`, listCsv(shown, t, locale, read?.seesPrices ?? false, day))
  }

  // B-W2b-194: New order (a person who may order, not in a preview).
  const newOrder = frame.me.permissions.includes('portal.orderRequests.manage') && !frame.me.preview ? `${frame.prefix}/orders/new` : null
  usePortalBand(state === 'forbidden' ? { title: t('list.title') } : listBandOf({ words, asOf: read?.asOf ?? null, rows: shownRows.length, chip, q, prefix: frame.prefix, onExport: () => exportRows(null), newOrder }))

  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  useEffect(() => {
    if (read) setLoadedAt(read.asOf)
  }, [read])

  if (state === 'forbidden') return <NotInAccess admins={(frame.access?.admins ?? []).map((admin) => admin.displayName)} homeHref={frame.prefix} />

  return (
    <OrdersListView
      model={{
        state: state === 'loading' && !read ? 'loading' : state === 'error' ? 'error' : 'ready',
        read,
        rows,
        requests,
        chip,
        q,
        prefix: frame.prefix,
        selected,
        updates,
        offlineSince: offline ? loadedAt : null,
        more: read && (chip === null || ordersInChip(chip)) && rows.length < read.count ? { loading: loadingMore } : null,
        transit,
        // B-W2b-194: the empty state's New order.
        newOrderHref: newOrder,
      }}
      actions={{
        onChip: (next) => go(next, q),
        onSearch: (next) => go(chip, next),
        onClear: () => go(null, ''),
        onSelect: setSelected,
        onOpen: (row) => {
          const href = rowHref(frame.prefix, row)
          if (href) router.push(href)
        },
        onRetry: () => {
          setState('loading')
          void load()
        },
        onShowUpdates: () => void load(),
        onMore: () => void more(),
        onExport: exportRows,
        onRetryRequests: () => {
          setRequests((current) => ({ ...current, state: 'loading' }))
          void loadRequests()
        },
        onRetryTransit: () => {
          setTransit({ state: 'loading', read: null })
          void loadTransit()
        },
        onOpenShipment: (row) => router.push(`${recordHref(frame.prefix, row.order.id, 'shipments')}#shipment-${row.shipmentId}`),
      }}
    />
  )
}

/** tab:print — every row of the view (up to 200 orders and the chip's requests), its filters written at the top. */
function PrintContainer() {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const search = useSearchParams()
  const { t, locale } = useOrderWords()
  const chipParam = search?.get('chip') ?? null
  const chip: ListChip | null = isListChip(chipParam, ORDER_CHIPS) ? chipParam : null
  const q = search?.get('q') ?? ''
  const seesRequests = frame.me.permissions.includes('portal.salesOrders.view')
  const [read, setRead] = useState<OrdersRead | null>(null)
  const [requests, setRequests] = useState<RequestRow[]>([])
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading')
  const [printedAt] = useState(() => new Date().toISOString())

  const load = useCallback(async () => {
    try {
      const [orders, asked] = await Promise.all([
        chip !== null && !ordersInChip(chip) ? fetchOrders(api, { chip: 'OPEN', q, limit: 1 }) : fetchOrders(api, { chip: chip as Exclude<ListChip, typeof CLOSED_REQUESTS> | null, q, limit: PAGE_SIZE * 4 }),
        seesRequests ? fetchRequests(api, { state: 'ALL', limit: 200 }) : Promise.resolve(null),
      ])
      setRead(chip !== null && !ordersInChip(chip) ? { ...orders, items: [], count: 0 } : orders)
      setRequests(asked?.rows ?? [])
      setState('ready')
    } catch {
      setState('error')
    }
  }, [api, chip, q, seesRequests])
  useEffect(() => {
    void load()
  }, [load])

  usePortalBand({ title: t('print.title') })
  const current: ListChip = chip ?? read?.chip ?? 'OPEN'
  const rows = read ? listRows(current, q, requests, read.items, locale) : []
  const asked = rows.filter((row) => row.kind === 'request').length
  const chipWords = current === CLOSED_REQUESTS ? t('chips.closedRequests') : (read?.chips.find((entry) => entry.chip === current)?.words[locale] ?? t('print.chipOpen'))
  return (
    <OrdersPrintView
      model={{
        state,
        rows,
        count: (read?.count ?? 0) + asked,
        seesPrices: read?.seesPrices ?? false,
        filters: { chip: chipWords, q },
        partyName: frame.me.party.name,
        printedBy: frame.me.user.displayName,
        printedAt,
        backHref: `${frame.prefix}/orders${listQuery(chip, q)}`,
      }}
      onRetry={() => {
        setState('loading')
        void load()
      }}
    />
  )
}
