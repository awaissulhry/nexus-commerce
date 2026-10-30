'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { downloadText, useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { csvOf, readProblem, writeProblem } from '../../../_shared/buying/model'
import { createOrder, findWorkOrders, findWorkshops, listOrders, orderCounts, outsideOperations, workshopStock, type OrderRow, type TileCounts, type WorkOrderChoice, type WorkshopStock } from '../api'
import { orderQuery, showOf, subcontractCan, viewFromAddress, words, type OrderView, type PageShow, type Words } from '../model'
import { defaultPicks, NO_NEW_ORDER, newOrderBody, newOrderHeld, newOrderRefusal, workshopOf, type NewOrderDraft, type SubcontractingModel } from './list-model'
import { stockKey, stockRowsOf } from './view/StockSection'
import { SubcontractingView } from './view/SubcontractingView'

const TIME_ZONE = 'Europe/Rome'

/**
 * `/w/<company>/purchasing/subcontracting` (SCR-128; `?show=stock` SCR-129): the orders of the saved view (`?view=`, the
 * tiles' filters), the search (`?q=`), 50 a page with "Show more", the tiles (GET …/orders/counts), the stock at the
 * workshops when shown, and live subcontract_order.* events behind "N updates · Show". `?new=1` opens New subcontract
 * order; the draft it makes opens on its Operations & quantities.
 */
export function SubcontractingPage() {
  return (
    <WithMessages namespaces={['subcontracting', 'lists']}>
      <Container />
    </WithMessages>
  )
}

function Container() {
  const t = useT('subcontracting')
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/purchasing\/subcontracting\/?$/, '')
  const can = useMemo(() => subcontractCan(session.permissions), [session.permissions])
  const view = viewFromAddress(params)
  const show = showOf(params?.get('show'))
  const q = params?.get('q') ?? ''
  const newAsked = params?.get('new') === '1'

  const [rows, setRows] = useState<SubcontractingModel['rows']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [counts, setCounts] = useState<TileCounts | null>(null)
  const [countsProblem, setCountsProblem] = useState<string | null>(null)
  const [stock, setStock] = useState<{ value: WorkshopStock | null; problem: string | null }>({ value: null, problem: null })
  const [stockWorkshop, setStockWorkshop] = useState<string | null>(null)
  const [stockQ, setStockQ] = useState('')
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [slow, setSlow] = useState(false)
  const [notice, setNotice] = useState<SubcontractingModel['notice']>(null)
  const [draft, setDraft] = useState<NewOrderDraft | null>(null)
  const draftRef = useRef<NewOrderDraft | null>(null)
  draftRef.current = draft
  const createKey = useRef<string | null>(null)
  const readId = useRef(0)

  const address = useCallback(
    (next: { view?: OrderView; q?: string; show?: PageShow }) => {
      const query = new URLSearchParams()
      const nextView = next.view ?? view
      const nextQ = next.q ?? q
      const nextShow = next.show ?? show
      if (nextShow === 'stock') query.set('show', 'stock')
      if (nextView !== 'open') query.set('view', nextView)
      if (nextQ.trim()) query.set('q', nextQ.trim())
      const qs = query.toString()
      return `${pathname}${qs ? `?${qs}` : ''}`
    },
    [pathname, view, q, show],
  )

  const loadCounts = useCallback(() => {
    if (!can.view) return
    orderCounts(api)
      .then((value) => {
        setCounts(value)
        setCountsProblem(null)
      })
      .catch((error: unknown) => setCountsProblem(readProblem(error)))
  }, [api, can.view])

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    loadCounts()
    try {
      const page = await listOrders(api, orderQuery(view, q))
      if (id !== readId.current) return
      setRows({ items: page.items, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readProblem(error) })
    }
  }, [api, can.view, view, q, loadCounts])

  const loadStock = useCallback(async () => {
    if (!can.view) return
    try {
      setStock({ value: await workshopStock(api), problem: null })
    } catch (error) {
      setStock({ value: null, problem: readProblem(error) })
    }
  }, [api, can.view])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])

  useEffect(() => {
    if (show === 'stock') void loadStock()
  }, [show, loadStock])

  // "Still loading…" after about a second (the design's slow note); never while a read failed.
  useEffect(() => {
    setSlow(false)
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [view, q, show])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listOrders(api, orderQuery(view, q, cursor))
      setRows((current) => ({ items: [...(current.items ?? []), ...page.items.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: words(readProblem(error)) })
    }
  }, [api, cursor, view, q])

  // Live: an order changed somewhere → "N updates · Show" (rows never move under the cursor); the tiles follow at once.
  const recount = useCoalesced(() => loadCounts(), 800)
  const restock = useCoalesced(() => void loadStock(), 1200)
  const live = useLive(
    (change) => {
      if (!change.type.startsWith('subcontract_order.')) return
      setUpdates((count) => count + 1)
      recount()
      if (show === 'stock' && (change.type === 'subcontract_order.kit_sent' || change.type === 'subcontract_order.received' || change.type === 'subcontract_order.kit_returned')) restock()
    },
    () => {
      void load()
      if (show === 'stock') void loadStock()
    },
    can.view,
  )

  // ---- New subcontract order -----------------------------------------------------------------------------------------------

  const searchWorkOrders = useCallback(
    (text: string) => {
      setDraft((current) => (current ? { ...current, query: text, workOrders: null, workOrdersProblem: null } : current))
      findWorkOrders(api, text)
        .then((found) => setDraft((current) => (current && current.query === text ? { ...current, workOrders: found } : current)))
        .catch((error: unknown) => setDraft((current) => (current && current.query === text ? { ...current, workOrders: [], workOrdersProblem: readProblem(error) } : current)))
    },
    [api],
  )

  const openNew = useCallback(() => {
    createKey.current = newIdempotencyKey()
    setDraft({ ...NO_NEW_ORDER })
    searchWorkOrders('')
  }, [searchWorkOrders])

  useEffect(() => {
    if (newAsked && !draft && can.manage) openNew()
    // Only when the address asks.
  }, [newAsked])

  const closeNew = useCallback(() => {
    setDraft(null)
    if (newAsked) router.replace(address({}))
  }, [address, newAsked, router])

  const pickWorkOrder = useCallback(
    (choice: WorkOrderChoice | null) => {
      if (!choice) {
        setDraft((current) => (current ? { ...NO_NEW_ORDER, query: current.query, workOrders: current.workOrders } : current))
        return
      }
      setDraft((current) => (current ? { ...current, workOrder: choice, outside: null, outsideProblem: null, picked: [], workshop: null, problem: null } : current))
      outsideOperations(api, choice.id)
        .then((outside) => setDraft((current) => (current && current.workOrder?.id === choice.id ? { ...current, outside, picked: defaultPicks(outside) } : current)))
        .catch((error: unknown) => setDraft((current) => (current && current.workOrder?.id === choice.id ? { ...current, outsideProblem: readProblem(error) } : current)))
    },
    [api],
  )

  const searchOthers = useCallback(
    (text: string) => {
      setDraft((current) => (current ? { ...current, otherQuery: text, others: null } : current))
      findWorkshops(api, text)
        .then((found) => setDraft((current) => (current && current.otherQuery === text ? { ...current, others: found } : current)))
        .catch(() => setDraft((current) => (current && current.otherQuery === text ? { ...current, others: [] } : current)))
    },
    [api],
  )

  const create = useCallback(async () => {
    const current = draftRef.current
    if (!current || newOrderHeld(current, can)) return
    const key = createKey.current ?? newIdempotencyKey()
    createKey.current = key
    setDraft({ ...current, busy: true, problem: null })
    try {
      const order = await createOrder(api, newOrderBody(current), key)
      setDraft(null)
      router.push(`${prefix}/purchasing/subcontracting/${order.id}?tab=ops`)
    } catch (error) {
      const name = workshopOf(current)?.name ?? ''
      const problem: Words = writeProblem(error, (paths, info) => newOrderRefusal(paths, info.kind, isApiError(error) ? error.message : '', name))
      // A refused create used no number: the next try is a new request.
      createKey.current = newIdempotencyKey()
      setDraft((latest) => (latest ? { ...latest, busy: false, problem } : latest))
    }
  }, [api, can, prefix, router])

  // ---- export --------------------------------------------------------------------------------------------------------------------

  const exportRows = useCallback(
    (ids: string[]) => {
      const picked = (rows.items ?? []).filter((row: OrderRow) => ids.includes(row.id))
      const header = ['number', 'status', 'workshop', 'workOrder', 'style', 'services', 'ordered', 'sent', 'backGood', 'backDefective', 'scrapped', 'kit', 'expectedBack', ...(can.cost ? ['fee', 'currency'] : []), 'site'].map((column) => t(`csv.${column}`))
      const csvRows = picked.map((row) => [
        row.number,
        t(`status.${row.status}`),
        row.workshop.name,
        row.workOrder.number,
        row.workOrder.style.code,
        row.services.map((service) => service.code).join(' '),
        row.pieces.ordered,
        row.pieces.sent,
        row.pieces.backGood,
        row.pieces.backDefective,
        row.pieces.scrapped,
        t(`kit.${row.kit.state}`),
        row.expectedBackDate ?? '',
        ...(can.cost ? [row.netAmount === undefined ? '' : (row.netAmount / 100).toFixed(2), row.currency] : []),
        row.site.code,
      ])
      downloadText(`subcontract-orders-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(header, csvRows))
    },
    [rows.items, can.cost, t],
  )

  const exportStock = useCallback(
    (keys: string[]) => {
      const all = stock.value ? stockRowsOf(stock.value.rows, stockWorkshop, stockQ) : []
      const picked = all.filter((row) => keys.includes(stockKey(row)))
      const header = [t('stock.col.workshop'), t('csv.site'), t('stock.col.material'), t('stock.col.lot'), t('stock.col.quantity'), 'UoM', ...(can.cost ? [t('stock.col.value'), t('csv.currency')] : []), t('stock.col.lastSent')]
      const csvRows = picked.map((row) => [
        row.workshop.name,
        row.site.code,
        `${row.item.code} ${row.item.name}${row.colour ? ` ${row.colour.code}` : ''}`,
        row.lot?.code ?? row.hide?.code ?? '',
        row.onHand,
        row.item.baseUom,
        ...(can.cost ? [row.value === null || row.value === undefined ? '' : (row.value / 100).toFixed(2), row.currency] : []),
        row.lastSentAt?.slice(0, 10) ?? '',
      ])
      downloadText(`stock-at-subcontractors-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(header, csvRows))
    },
    [stock.value, stockWorkshop, stockQ, can.cost, t],
  )

  const model: SubcontractingModel = {
    prefix,
    can,
    show,
    view,
    q,
    rows,
    counts,
    countsProblem,
    stock,
    stockWorkshop,
    stockQ,
    asOf,
    live,
    updates,
    notice,
    newOrder: draft,
    timeZone: TIME_ZONE,
    slow,
  }

  return (
    <SubcontractingView
      model={model}
      actions={{
        onShow: (next) => router.replace(address({ show: next })),
        onView: (next) => router.replace(address({ view: next })),
        onSearch: (next) => router.replace(address({ q: next })),
        onMore: () => void more(),
        onRetry: () => void load(),
        onRetryStock: () => void loadStock(),
        onShowUpdates: () => void load(),
        onExport: exportRows,
        onExportStock: exportStock,
        onStockWorkshop: setStockWorkshop,
        onStockSearch: setStockQ,
        onOpen: (id) => router.push(`${prefix}/purchasing/subcontracting/${id}`),
        onDismissNotice: () => setNotice(null),
        onNew: (open) => (open ? (can.manage ? openNew() : undefined) : closeNew()),
        newOrder: {
          onQuery: searchWorkOrders,
          onWorkOrder: pickWorkOrder,
          onToggle: (operationId, on) =>
            setDraft((current) => {
              if (!current?.outside) return current
              const left = Math.max(0, current.outside.cells.reduce((sum, cell) => sum + cell.quantity, 0) - (current.outside.operations.find((entry) => entry.id === operationId)?.ordered ?? 0))
              const picked = on ? [...current.picked.filter((entry) => entry.operationId !== operationId), { operationId, pieces: String(left) }] : current.picked.filter((entry) => entry.operationId !== operationId)
              return { ...current, picked, problem: null }
            }),
          onPieces: (operationId, pieces) => setDraft((current) => (current ? { ...current, picked: current.picked.map((entry) => (entry.operationId === operationId ? { ...entry, pieces } : entry)), problem: null } : current)),
          onWorkshop: (workshop) => setDraft((current) => (current ? { ...current, workshop, problem: null } : current)),
          onOther: (open) => {
            setDraft((current) => (current ? { ...current, otherOpen: open } : current))
            if (open) searchOthers('')
          },
          onOtherQuery: searchOthers,
          onReturnDate: (day) => setDraft((current) => (current ? { ...current, returnDate: day } : current)),
          onPlanKit: (on) => setDraft((current) => (current ? { ...current, planKit: on } : current)),
          onNote: (note) => setDraft((current) => (current ? { ...current, note } : current)),
          onCreate: () => void create(),
        },
      }}
    />
  )
}
