'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive } from '../../shell/frame'
import { fetchInTransit, fetchOrders, isOrderChip, PAGE_SIZE, type InTransitRead, type OrderChip, type OrderRow, type OrdersRead } from './api'
import { listBandOf } from './band'
import { listQuery, NAV_KEY, NS, opens, ordersCsv, recordHref } from './model'
import { saveText, useOffline } from './hooks'
import { OrdersListView } from './view/OrdersListView'
import { OrdersPrintView } from './view/OrdersPrintView'
import { NotInAccess } from './view/parts'
import { useOrderWords } from './words'

/**
 * `/p/<party>/orders` for a customer (B-W2b-191; design portal.customer.orders): reads GET /portal/sales-orders with the
 * chip and search of the address (pages of 50 by `offset`), and "On the way" (GET …/in-transit), fills the band (Updated,
 * Export this view, Print this list), keeps the selection (Export N), tells of changes on the live channel without moving
 * the rows ("N updates · Show"), and keeps what was loaded when the connection is gone. `?print=1` is the print view.
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
  const chip: OrderChip | null = isOrderChip(chipParam) ? chipParam : null
  const q = search?.get('q') ?? ''

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
      const next = await fetchOrders(api, { chip, q }, control.signal)
      if (control.signal.aborted) return
      setRead(next)
      setRows(next.items)
      setState('ready')
      setUpdates(0)
      setSelected((current) => current.filter((id) => next.items.some((row) => row.id === id)))
    } catch (error) {
      if (control.signal.aborted) return
      setState(isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : 'error')
    }
  }, [api, chip, q])

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
      window.sessionStorage.setItem(NAV_KEY, JSON.stringify(rows.filter(opens).map((row) => row.id)))
    } catch {
      // No storage (a private window): J / K simply have no list.
    }
  }, [rows])

  usePortalLive({
    onChange: (change) => {
      if (read?.live.events.includes(change.type)) setUpdates((count) => count + 1)
      void loadTransit()
    },
    onReconnect: () => setUpdates((count) => count + 1),
  })

  const more = async () => {
    if (!read || loadingMore) return
    setLoadingMore(true)
    try {
      const next = await fetchOrders(api, { chip, q, offset: rows.length })
      setRows((current) => [...current, ...next.items.filter((row) => !current.some((old) => old.id === row.id))])
    } catch {
      setState('error')
    } finally {
      setLoadingMore(false)
    }
  }

  const go = (nextChip: OrderChip | null, nextQ: string) => router.replace(`${pathname}${listQuery(nextChip, nextQ)}`, { scroll: false })
  const exportRows = (ids: readonly string[] | null) => {
    const shown = ids ? rows.filter((row) => ids.includes(row.id)) : rows
    saveText(`${t('list.fileName')}.csv`, ordersCsv(shown, t, locale, read?.seesPrices ?? false, day))
  }

  usePortalBand(state === 'forbidden' ? { title: t('list.title') } : listBandOf({ words, asOf: read?.asOf ?? null, rows: rows.length, chip, q, prefix: frame.prefix, onExport: () => exportRows(null) }))

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
        chip,
        q,
        prefix: frame.prefix,
        selected,
        updates,
        offlineSince: offline ? loadedAt : null,
        more: read && rows.length < read.count ? { loading: loadingMore } : null,
        transit,
      }}
      actions={{
        onChip: (next) => go(next, q),
        onSearch: (next) => go(chip, next),
        onClear: () => go(null, ''),
        onSelect: setSelected,
        onOpen: (row) => router.push(recordHref(frame.prefix, row.id)),
        onRetry: () => {
          setState('loading')
          void load()
        },
        onShowUpdates: () => void load(),
        onMore: () => void more(),
        onExport: exportRows,
        onRetryTransit: () => {
          setTransit({ state: 'loading', read: null })
          void loadTransit()
        },
        onOpenShipment: (row) => router.push(`${recordHref(frame.prefix, row.order.id, 'shipments')}#shipment-${row.shipmentId}`),
      }}
    />
  )
}

/** tab:print — every row of the view (up to 200), its filters written at the top. */
function PrintContainer() {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const search = useSearchParams()
  const { t, locale } = useOrderWords()
  const chipParam = search?.get('chip') ?? null
  const chip: OrderChip | null = isOrderChip(chipParam) ? chipParam : null
  const q = search?.get('q') ?? ''
  const [read, setRead] = useState<OrdersRead | null>(null)
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading')
  const [printedAt] = useState(() => new Date().toISOString())

  const load = useCallback(async () => {
    try {
      setRead(await fetchOrders(api, { chip, q, limit: PAGE_SIZE * 4 }))
      setState('ready')
    } catch {
      setState('error')
    }
  }, [api, chip, q])
  useEffect(() => {
    void load()
  }, [load])

  usePortalBand({ title: t('print.title') })
  const chipWords = read?.chips.find((entry) => entry.chip === read.chip)?.words[locale] ?? t('print.chipOpen')
  return (
    <OrdersPrintView
      model={{
        state,
        rows: read?.items ?? [],
        count: read?.count ?? 0,
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
