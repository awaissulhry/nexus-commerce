'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { findCustomers, getParty } from '../../quotes/api'
import { getBoard, getOrderPicture, listOrderCustomers, listOrders, nextOrderNumber, type OrderBoard, type OrderCustomer } from '../api'
import { useCoalesced, useLive } from '../hooks'
import { abilitiesOf, boardLanes, brandFromAddress, companyFromAddress, laneQuery, layoutFromAddress, listAddress, listTouches, partyFromAddress, readProblem, romeToday, rowsFromAddress, rowsQuery, type Lane, type Layout, type Narrowing, type RowView } from '../model'
import { newOrderAddress } from '../new/new-model'
import type { NewOrderDialogModel, OrdersListModel } from './list-model'
import { OrdersListView } from './view/OrdersListView'
import { useListMargins } from './margin/use-list-margins'
// ---- B-W2b-323 (orders in depth on screen) ----
import { useListDepth } from '../list-depth/use-list-depth'
import { usePromiseWeek } from '../week/use-promise-week'
import { useOrdersImport } from '../import/use-orders-import'
import { NAMESPACE as DEPTH } from '../depth/model'
// ---- B-TH-225 / B-TH-226 (TH-1a: the Orders sheet and the Customer switcher) ----
import { brandName, NAMESPACE as SHEET } from './sheet/model'
import type { PictureLoader } from './sheet/parts'

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
    <WithMessages namespaces={['orders', 'lists', DEPTH /* B-W2b-323 */, SHEET /* B-TH-225 */]}>
      <OrdersContainer />
    </WithMessages>
  )
}

function OrdersContainer() {
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
  const party = partyFromAddress(params) // B-TH-201: one customer's orders (Sales › Reports' drill)
  // B-TH-225: the label on the garment and the company narrow every read too (the address keeps them).
  const brand = brandFromAddress(params)
  const company = companyFromAddress(params)
  const narrow = useMemo<Narrowing>(() => ({ brand, companyId: company }), [brand, company])

  const [list, setList] = useState<OrdersListModel['list']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [lanes, setLanes] = useState<Lane[]>([])
  const [board, setBoard] = useState<OrderBoard | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<OrdersListModel['notice']>(null)
  const [weekTick, setWeekTick] = useState(0) // B-W2b-323
  const readId = useRef(0)
  const companyId = session.company?.id ?? session.companies[0]?.id ?? ''
  const [newOrder, setNewOrder] = useState<NewOrderDialogModel | null>(params?.get('new') === '1' && can.manage ? emptyNew(session.companies, companyId, incomingOf(prefix, session.permissions)) : null)
  const searchSeq = useRef(0)

  const go = useCallback(
    (next: { rows?: RowView; q?: string; layout?: Layout; party?: string | null; brand?: string | null; company?: string | null }) =>
      router.replace(
        listAddress(pathname, {
          rows: next.rows ?? rows,
          q: next.q ?? q,
          layout: next.layout ?? layout,
          party: next.party === undefined ? party : next.party,
          brand: next.brand === undefined ? brand : next.brand, // B-TH-225
          company: next.company === undefined ? company : next.company, // B-TH-225
        }),
      ),
    [router, pathname, rows, q, layout, party, brand, company],
  )

  const readBoard = useCallback(
    (id: number) => {
      getBoard(api, q, undefined, party, narrow)
        .then((answer) => id === readId.current && setBoard(answer))
        .catch(() => id === readId.current && setBoard(null))
    },
    [api, q, party, narrow],
  )

  const load = useCallback(async (silent = false) => {
    const id = ++readId.current
    readBoard(id)
    // B-W2b-323: By promise week reads its own lines (usePromiseWeek); the page keeps the tiles.
    if (layout === 'week') {
      setAsOf(new Date().toISOString())
      setUpdates(0)
      setWeekTick((tick) => tick + 1)
      return
    }
    if (layout === 'board') {
      const shown = boardLanes(rows)
      // A live re-read keeps the cards in place (the focus stays) until the new ones arrive.
      if (!silent) setLanes(shown.map((status) => ({ status, items: null, more: false, problem: null })))
      await Promise.all(
        shown.map(async (status) => {
          try {
            const page = await listOrders(api, laneQuery(status, rows, q, party, narrow))
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
      const page = await listOrders(api, rowsQuery(rows, q, null, party, narrow))
      if (id !== readId.current) return
      setList({ items: page.orders, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setList({ items: null, more: false, problem: readProblem(error) })
    }
  }, [api, rows, q, party, narrow, layout, readBoard])

  useEffect(() => {
    setList({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listOrders(api, rowsQuery(rows, q, cursor, party, narrow))
      setList((current) => ({ items: [...(current.items ?? []), ...page.orders.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: { key: readProblem(error) } })
    }
  }, [api, cursor, rows, q, party, narrow])

  // ── B-TH-226: the Customer switcher — the reader's customers with their open and late orders (GET /sales/orders/customers);
  // its search reads the API again (after 250 ms); the chosen customer's name comes from it first. ──
  const [customers, setCustomers] = useState<{ customers: OrderCustomer[] | null; total: number; limited: boolean; problem: string | null }>({ customers: null, total: 0, limited: false, problem: null })
  const [customerQuery, setCustomerQuery] = useState('')
  const [searched, setSearched] = useState('')
  const [customersTick, setCustomersTick] = useState(0)
  useEffect(() => {
    const timer = setTimeout(() => setSearched(customerQuery.trim()), 250)
    return () => clearTimeout(timer)
  }, [customerQuery])
  useEffect(() => {
    const abort = new AbortController()
    setCustomers((current) => ({ ...current, customers: searched ? null : current.customers, problem: null }))
    listOrderCustomers(api, { q: searched || undefined, companyId: company, limit: 50 }, abort.signal)
      .then((answer) => !abort.signal.aborted && setCustomers({ customers: answer.customers, total: answer.total, limited: answer.limited, problem: null }))
      .catch((error: unknown) => !abort.signal.aborted && setCustomers({ customers: [], total: 0, limited: false, problem: readProblem(error) }))
    return () => abort.abort()
  }, [api, searched, company, customersTick])
  // ── end B-TH-226 (the switcher's read) ──

  // ── B-TH-201: the customer's name for the chip — from the rows read, else the customer's record (404 when the person may
  // not open it: then the chip names no one). ──
  const nameInRows = useMemo(() => {
    if (!party) return null
    const read = [...(list.items ?? []), ...lanes.flatMap((lane) => lane.items ?? [])]
    return read.find((row) => row.partyId === party)?.partyName || null
  }, [party, list.items, lanes])
  const [looked, setLooked] = useState<{ id: string; name: string | null } | null>(null)
  useEffect(() => {
    if (!party || nameInRows || looked?.id === party || customers.customers === null || customers.customers.some((entry) => entry.id === party)) return
    let gone = false
    getParty(api, party)
      .then((found) => !gone && setLooked({ id: party, name: found.legalName }))
      .catch(() => !gone && setLooked({ id: party, name: null }))
    return () => {
      gone = true
    }
  }, [api, party, nameInRows, looked?.id, customers.customers])
  // ── end B-TH-201 ──

  const nameInSwitcher = party ? (customers.customers?.find((entry) => entry.id === party)?.name ?? null) : null
  const customer = party ? { id: party, name: nameInSwitcher ?? nameInRows ?? (looked?.id === party ? looked.name : undefined) } : null
  // ── end B-TH-226 ──

  // ── B-TH-225: the label's and the company's names for their chips; the pictures' small previews; a row opens its order ──
  const brandNamed = brand ? { value: brand, name: brandName([...(list.items ?? []), ...lanes.flatMap((lane) => lane.items ?? [])], brand).name } : null
  const companyNamed = company ? { id: company, name: session.companies.find((entry) => entry.id === company)?.name ?? company } : null
  const loadPicture = useCallback<PictureLoader>(async (orderId) => {
    const picture = await getOrderPicture(api, orderId)
    return picture.small ? { url: picture.small.url, expiresAt: picture.small.expiresAt } : null
  }, [api])
  // ── end B-TH-225 ──

  // Live: an order event (a new order, a move, a deposit paid…) → "N updates · Show"; the tiles follow at once. The
  // board reads its lanes again by itself (B-W2a-50: a board left open on a second screen).
  const recount = useCoalesced(() => readBoard(readId.current), 800)
  const rereadBoard = useCoalesced(() => void load(true), 900)
  const live = useLive(
    (change) => {
      if (!listTouches(change)) return
      if (layout === 'board' || layout === 'week' /* B-W2b-323 */) {
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

  // B-W2a-72: the Margin % column (margin grain): the margins of the orders on screen.
  const margins = useListMargins(api, layout === 'board' ? null : list.items, q, session.permissions, asOf)

  // ---- B-W2b-323: priority and season, By promise week, Import orders ----
  const listDepth = useListDepth(api, layout === 'list' ? list.items : null, session.permissions, (changes) =>
    setList((current) => ({ ...current, items: current.items?.map((row) => { const change = changes.find((entry) => entry.id === row.id); return change?.version ? { ...row, version: change.version } : row }) ?? null })),
  )
  const week = usePromiseWeek(api, session, { enabled: layout === 'week', asked: params?.get('site') ?? null, q, tick: weekTick, partyId: party /* B-TH-201 */ })
  const importer = useOrdersImport(api, session, locale === 'en' ? 'en' : 'it', () => void load())

  const model: OrdersListModel = {
    prefix, can, today: romeToday(), layout, rows, q, list, lanes, board, asOf, live, updates, notice, newOrder, margins,
    customer, // B-TH-201
    // ---- B-TH-225 / B-TH-226 ----
    brand: brandNamed,
    company: companyNamed,
    companies: session.companies.map((entry) => ({ id: entry.id, name: entry.name })),
    switcher: { ...customers, query: customerQuery, searching: customerQuery.trim() !== searched || (searched !== '' && customers.customers === null) },
    depth: listDepth.model,
    week: { state: week.state, sites: week.sites, siteId: week.siteId },
    importer: { held: importer.held, sheet: importer.model },
  }

  return (
    <OrdersListView
      model={model}
      actions={{
        onRows: (next) => go({ rows: next, ...(layout === 'week' ? { layout: 'list' as const } : {}) /* B-W2b-323: a tile opens the list */ }),
        onLayout: (next) => go({ layout: next }),
        onSearch: (next) => go({ q: next }),
        onClearCustomer: () => go({ party: null }), // B-TH-201
        // ---- B-TH-225 / B-TH-226 ----
        onCustomer: (next) => {
          setCustomerQuery('')
          go({ party: next })
        },
        onCustomerSearch: setCustomerQuery,
        onCustomerRetry: () => setCustomersTick((tick) => tick + 1),
        onBrand: (next) => go({ brand: next, ...(layout === 'week' ? { layout: 'list' as const } : {}) }),
        onCompany: (next) => go({ company: next, ...(layout === 'week' ? { layout: 'list' as const } : {}) }),
        onClearAll: () => go({ rows: 'open', q: '', party: null, brand: null, company: null }),
        loadPicture,
        onOpenRow: (id, newTab) => {
          const href = `${prefix}/sales/orders/${id}`
          if (newTab) window.open(href, '_blank', 'noopener')
          else router.push(href)
        },
        onMore: () => void more(),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(`${prefix}/sales/orders/${id}`),
        onDismissNotice: () => setNotice(null),
        onNewOrder: (open) => setNewOrder(open && can.manage ? emptyNew(session.companies, companyId, incomingOf(prefix, session.permissions)) : null),
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
        // ---- B-W2b-323 ----
        depth: listDepth.actions,
        onImport: importer.open,
        importActions: importer.actions,
        onWeekSite: (siteId) => {
          const next = new URLSearchParams(params?.toString() ?? '')
          next.set('site', siteId)
          router.replace(`${pathname}?${next.toString()}`)
        },
        onWeekRetry: week.retry,
        onNewCreate: () => {
          if (!newOrder?.party) return
          router.push(newOrderAddress(prefix, { companyId: newOrder.companyId, partyId: newOrder.party.id, contactId: newOrder.contactId, customerRef: newOrder.customerRef }))
        },
      }}
    />
  )
}

function emptyNew(companies: NewOrderDialogModel['companies'], companyId: string, incomingHref: string | null): NewOrderDialogModel {
  return { companies, companyId, results: null, searchProblem: null, party: null, partyProblem: null, contactId: '', customerRef: '', number: undefined, incomingHref }
}

/** B-TH-221: New order's one pointer — a written request goes to Incoming's New request, for who may make one there. */
const incomingOf = (prefix: string, permissions: readonly string[]): string | null => (permissions.includes('sales.inquiries.manage') ? `${prefix}/sales/incoming?new=1` : null)
