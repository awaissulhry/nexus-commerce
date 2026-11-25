'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive } from '../../shell/frame'
import { fetchRequests, type RequestRow } from '../requests/api'
import type { OrderRow, OrdersRead } from './api'
// B-TH-246: the customer's own sheet — the list's rows with the portal columns, and "Download (Excel)" written by the server.
import { downloadSheet, fetchSheet } from './api'
import { sheetFileName } from './model'
import { saveBytes } from './hooks'
import { listBandOf } from './band'
import { NAV_KEY, NS, opens, rowHref } from './model'
// pg-w2 (portal grid plan § 3): the groups of the band, the rows of a group, the address.
import { groupOfAddress, groupQuery, holdsOrders, listRowsOf, sheetChipOf } from './list-view-model'
import type { CustomerGroup } from '../../../lib/order-groups/groups'
import { useOffline } from './hooks'
import { OrdersListView } from './view/OrdersListView'
// B-TH-230: the New messages column — one read of the rows shown (the portal's own client: its party's shared messages only).
import { readUnreadWith } from '../../../lib/last-message-cell/api'
import { useUnread } from '../../../lib/last-message-cell/use-unread'
import { threadOf } from './model'
// pg-w2 (D4): the customer's own orders' pictures (the walled partner read; one batch per page).
import { pictureReader } from '../../../lib/record-picture/api'
import { NotInAccess } from './view/parts'
import { useOrderWords } from './words'

/**
 * `/p/<party>/orders` for a customer — Orders & requests (B-W2b-191; B-TH-223; pg-w2 — portal grid plan § 3): reads the customer's
 * own sheet (GET /portal/sales-orders/sheet) for the group of the address (`?chip=<GROUP>`, none: everything open) and its search
 * (pages of 50 by `offset`) — its answer also carries the band's numbers, counted by the server — and the customer's requests (GET
 * /portal/inquiries, every state, up to 200: the group and the search narrow them here). Fills the band (Updated, New order, ⋯
 * Download (Excel)), tells of changes on the live channel without moving the rows ("N updates · Show"; a request's event reads the
 * requests again), and keeps what was loaded when the connection is gone. No print view, no CSV, no "On the way" any more (Z8, D7).
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
  const allowed = frame.kinds.includes('CUSTOMER') && frame.me.permissions.includes('portal.salesOrders.view')
  const { t } = useOrderWords()
  if (!allowed) return <Closed title={t('list.title')} />
  return <ListContainer />
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
  const { t, locale } = words
  const offline = useOffline()
  const group: CustomerGroup | null = groupOfAddress(search?.get('chip'))
  const q = search?.get('q') ?? ''
  const orders = holdsOrders(group)
  // B-TH-223: the requests are read whole (every state) and narrowed here; a reader without the orders' right reads none.
  const seesRequests = frame.me.permissions.includes('portal.salesOrders.view')
  const [requests, setRequests] = useState<{ state: 'loading' | 'error' | 'ready' | 'none'; rows: RequestRow[]; complete: boolean }>({ state: seesRequests ? 'loading' : 'none', rows: [], complete: true })

  const [read, setRead] = useState<OrdersRead | null>(null)
  const [rows, setRows] = useState<OrderRow[]>([])
  const [state, setState] = useState<'loading' | 'error' | 'ready' | 'forbidden'>('loading')
  const [updates, setUpdates] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const reading = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    reading.current?.abort()
    const control = new AbortController()
    reading.current = control
    try {
      // The sheet's read: the group's rows with their portal columns, and the band's numbers (the server's, before the search). Closed
      // requests hold no order: the read then brings the band's numbers only.
      const next = await fetchSheet(api, { chip: sheetChipOf(group), q, ...(orders ? {} : { limit: 1 }) }, control.signal)
      if (control.signal.aborted) return
      setRead(next)
      setRows(orders ? next.items : [])
      setState('ready')
      setUpdates(0)
    } catch (error) {
      if (control.signal.aborted) return
      setState(isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : 'error')
    }
  }, [api, group, q, orders])

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

  useEffect(() => {
    setState((current) => (current === 'ready' ? current : 'loading'))
    void load()
    return () => reading.current?.abort()
  }, [load])

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
      // B-TH-223: a request of this customer moved (our answer, a quote, its order): its row reads again in place.
      if (change.type.startsWith('inquiry.')) void loadRequests()
    },
    onReconnect: () => {
      setUpdates((count) => count + 1)
      void loadRequests()
    },
  })

  const more = async () => {
    if (!read || loadingMore || !orders) return
    setLoadingMore(true)
    try {
      const next = await fetchSheet(api, { chip: sheetChipOf(group), q, offset: rows.length }) // B-TH-246
      setRows((current) => [...current, ...next.items.filter((row) => !current.some((old) => old.id === row.id))])
    } catch {
      setState('error')
    } finally {
      setLoadingMore(false)
    }
  }

  const go = (nextGroup: CustomerGroup | null, nextQ: string) => router.replace(`${pathname}${groupQuery(nextGroup, nextQ)}`, { scroll: false })
  const shownRows = listRowsOf(group, q, requests.state === 'ready' ? requests.rows : [], rows, locale)

  // B-W2b-194: New order (a person who may order, not in a preview).
  const newOrder = frame.me.permissions.includes('portal.orderRequests.manage') && !frame.me.preview ? `${frame.prefix}/orders/new` : null
  // ── B-TH-246, Z8: "Download (Excel)" of the group shown — the server writes the file in the customer's own scope (never the office's
  // export job); under Requests it holds the order requests (the inquiries are not in the file); Closed requests holds no order.
  const [downloading, setDownloading] = useState(false)
  const [downloadFailed, setDownloadFailed] = useState(false)
  const downloadAll = async () => {
    setDownloading(true)
    setDownloadFailed(false)
    try {
      const file = await downloadSheet(api, { chip: sheetChipOf(group), q, format: 'XLSX', locale: locale === 'it' ? 'it' : 'en' })
      saveBytes(file.fileName ?? sheetFileName(t('list.fileName'), 'XLSX'), file.bytes, file.contentType)
    } catch {
      setDownloadFailed(true)
    } finally {
      setDownloading(false)
    }
  }
  // ── end B-TH-246 ──
  usePortalBand(state === 'forbidden' ? { title: t('list.title') } : listBandOf({ words, asOf: read?.asOf ?? null, newOrder, ...(orders ? { onDownloadAll: () => void downloadAll() } : {}), downloading /* B-TH-246 */ }))

  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  useEffect(() => {
    if (read) setLoadedAt(read.asOf)
  }, [read])

  // ---- B-TH-230: the person's own new messages on the rows shown (threads.read; ONE POST /threads/unread of ≤ 200), again live ----
  const readsThreads = frame.me.permissions.includes('threads.read')
  const [unreadTick, setUnreadTick] = useState(0)
  usePortalLive({ onChange: (change) => (change.type.startsWith('thread.') || change.type === 'partner_notification.created' ? setUnreadTick((tick) => tick + 1) : undefined), onReconnect: () => setUnreadTick((tick) => tick + 1) }, readsThreads)
  const unreadRows = useMemo(() => shownRows.flatMap((row) => { const thread = threadOf(row); return thread ? [{ recordType: thread.recordType, id: row.id }] : [] }), [shownRows])
  const unread = useUnread(readsThreads ? readUnreadWith(api) : null, unreadRows, unreadTick)
  // ---- end B-TH-230
  // pg-w2 (D4): one picture reader for the page (the shared picture part batches the rows' asks; a 404 before the route: no picture).
  const pictures = useMemo(() => pictureReader(api), [api])

  if (state === 'forbidden') return <NotInAccess admins={(frame.access?.admins ?? []).map((admin) => admin.displayName)} homeHref={frame.prefix} />

  return (
    <OrdersListView
      model={{
        state: state === 'loading' && !read ? 'loading' : state === 'error' ? 'error' : 'ready',
        read,
        rows,
        requests,
        group,
        q,
        prefix: frame.prefix,
        updates,
        offlineSince: offline ? loadedAt : null,
        more: read && orders && rows.length < read.count ? { loading: loadingMore } : null,
        // B-W2b-194: the empty state's New order (only who may order: G1-B11).
        newOrderHref: newOrder,
        unread: readsThreads ? unread : null, // B-TH-230
        downloadFailed, // B-TH-246
        pictures,
      }}
      actions={{
        onGroup: (next) => go(next, q),
        onSearch: (next) => go(group, next),
        onClearSearch: () => go(group, ''),
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
        onRetryRequests: () => {
          setRequests((current) => ({ ...current, state: 'loading' }))
          void loadRequests()
        },
        onDownloadAll: () => void downloadAll(), // B-TH-246: Try again
      }}
    />
  )
}
