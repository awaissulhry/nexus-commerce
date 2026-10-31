'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { WithMessages } from '../../../../record-panels/i18n'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { createShipment, listShipments, listSiteSettings, printDdtOf, readyToShip, type ShipmentRow, type SiteSettings } from '../api'
import { printDdtsPlan, type PrintOutcome } from '../daily-model'
import { downloadText, useCoalesced, useLive } from '../hooks'
import {
  abilitiesOf,
  carrierKey,
  carrierWords,
  cutOffCards,
  cutOffsBySite,
  listAddress,
  liveTouches,
  newShipmentLines,
  readProblem,
  rowsFromAddress,
  rowsQuery,
  shipmentsCsv,
  tileCounts,
  writeProblem,
  zonedToday,
  type RowView,
} from '../model'
import type { NewShipmentModel, PrintDdtsModel, ShipmentsListModel } from './list-model'
import { ShipmentsListView } from './view/ShipmentsListView'

/** The open shipments the ship-today queue reads at once (its cards, tiles and rows). */
const QUEUE_LIMIT = 200

/**
 * `/w/<company>/warehouse/shipments` (SCR-066): the ship-today queue first — the shipments that have not left yet (DRAFT
 * and PACKED, up to 200 read at once), a card per carrier with today's cut-off (the site's shipping settings) and what is
 * ready and still to pack, the tiles (to pack, to label, labelled but not handed over, in transit) — then every
 * shipment by state (`?rows=`), 50 a page with Show more; the search by number, order, customer PO, customer or tracking
 * number (`?q=`). Live: a shipment or DDT event waits behind "N updates · Show". New shipment (`?new=1`, `&order=<id>`
 * from the order studio) plans a DRAFT from what quality released and is not shipped yet, then opens it. Export N = CSV.
 * B-W2a-71: Print N DDTs — each selected shipment's live DDT on its site's document printer, one call each, the outcome
 * per shipment in words; the freight charged in the CSV with the price grain; `?rows=evidence`.
 */
export function ShipmentsPage() {
  return (
    <WithMessages namespaces={['shipments', 'lists']}>
      <ShipmentsContainer />
    </WithMessages>
  )
}

const CLOSED_CREATE: NewShipmentModel = { step: 1, orders: null, problem: null, salesOrderId: null, quantities: {}, transportBy: 'CARRIER', carrierCode: '', serviceCode: '', busy: false, refused: null }

function ShipmentsContainer() {
  const t = useT('shipments')
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/warehouse\/shipments\/?$/, '')
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const rows = rowsFromAddress(params)
  const q = params?.get('q') ?? ''
  const carrier = rows === 'today' ? (params?.get('carrier') ?? null) : null
  const today = zonedToday()

  const [queue, setQueue] = useState<{ items: ShipmentRow[] | null; more: boolean; problem: string | null }>({ items: null, more: false, problem: null })
  const [list, setList] = useState<ShipmentsListModel['list']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [inTransit, setInTransit] = useState<number | null>(null)
  const [sites, setSites] = useState<SiteSettings[] | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<ShipmentsListModel['notice']>(null)
  const [create, setCreate] = useState<NewShipmentModel | null>(null)
  const [printDdts, setPrintDdts] = useState<PrintDdtsModel | null>(null)
  const printKeys = useRef<Record<string, string>>({})
  const readId = useRef(0)
  const createKey = useRef<string | null>(null)

  const go = useCallback((next: { rows?: RowView; q?: string; carrier?: string | null }) => router.replace(listAddress(pathname, { rows: next.rows ?? rows, q: next.q ?? q, carrier: next.carrier === undefined ? carrier : next.carrier })), [router, pathname, rows, q, carrier])

  const load = useCallback(async () => {
    const id = ++readId.current
    setList((current) => ({ ...current, problem: null }))
    // The queue (cards, tiles, today's rows) and the in-transit count are read under the search too.
    const queueRead = listShipments(api, { open: true, q, limit: QUEUE_LIMIT })
      .then((page) => {
        if (id !== readId.current) return null
        setQueue({ items: page.shipments, more: page.nextCursor !== null, problem: null })
        return page
      })
      .catch((error: unknown) => {
        if (id === readId.current) setQueue({ items: null, more: false, problem: readProblem(error) })
        throw error
      })
    listShipments(api, { status: 'SHIPPED', q, limit: QUEUE_LIMIT })
      .then((page) => id === readId.current && setInTransit(page.nextCursor === null ? page.shipments.length : null))
      .catch(() => id === readId.current && setInTransit(null))
    if (can.viewSettings && sites === null) {
      listSiteSettings(api)
        .then((answer) => setSites(answer))
        .catch(() => setSites([]))
    }
    try {
      if (rows === 'today') {
        const page = await queueRead
        if (!page) return
        setList({ items: page.shipments, more: page.nextCursor !== null, problem: null })
        setCursor(null)
      } else {
        queueRead.catch(() => undefined)
        const page = await listShipments(api, rowsQuery(rows, q))
        if (id !== readId.current) return
        setList({ items: page.shipments, more: page.nextCursor !== null, problem: null })
        setCursor(page.nextCursor)
      }
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setList({ items: null, more: false, problem: readProblem(error) })
    }
  }, [api, rows, q, can.viewSettings, sites])

  useEffect(() => {
    setList({ items: null, more: false, problem: null })
    void load()
    // `sites` is read once (load reads it when it is still unread); the rows and the search read again.
  }, [api, rows, q])

  const more = useCallback(async () => {
    if (!cursor || rows === 'today') return
    try {
      const page = await listShipments(api, rowsQuery(rows, q, cursor))
      setList((current) => ({ items: [...(current.items ?? []), ...page.shipments.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', words: { key: readProblem(error) } })
    }
  }, [api, cursor, rows, q])

  // Live: a shipment or DDT event, a release → "N updates · Show" (rows never move under the cursor).
  const reread = useCoalesced(() => void load(), 900)
  const live = useLive(
    (change) => {
      if (!liveTouches(change)) return
      setUpdates((count) => count + 1)
      if (create) return
      reread()
    },
    () => void load(),
  )

  // ---- New shipment ---------------------------------------------------------------------------------------------------

  const openCreate = useCallback(
    (salesOrderId: string | null) => {
      createKey.current = newIdempotencyKey()
      const defaults = sites?.[0]?.settings ?? null
      setCreate({ ...CLOSED_CREATE, salesOrderId, step: 1, transportBy: defaults?.defaultTransportBy ?? 'CARRIER', carrierCode: defaults?.defaultCarrierCode ?? '', serviceCode: defaults?.defaultServiceCode ?? '' })
      readyToShip(api)
        .then((orders) => {
          setCreate((current) => {
            if (!current) return current
            const chosen = salesOrderId && orders.some((order) => order.salesOrderId === salesOrderId) ? salesOrderId : orders.length === 1 ? orders[0]!.salesOrderId : current.salesOrderId
            return { ...current, orders, salesOrderId: chosen ?? null, step: chosen && salesOrderId ? 2 : 1 }
          })
        })
        .catch((error: unknown) => setCreate((current) => (current ? { ...current, problem: readProblem(error) } : current)))
    },
    [api, sites],
  )

  // `?new=1` (the band's New shipment, a palette command) and `&order=<id>` from the order studio's Create shipment.
  const wantsNew = params?.get('new') === '1'
  const wantedOrder = params?.get('order') ?? null
  const opened = useRef(false)
  useEffect(() => {
    if (!wantsNew || opened.current || !can.manage) return
    opened.current = true
    openCreate(wantedOrder)
  }, [wantsNew, wantedOrder, can.manage, openCreate])

  const closeCreate = useCallback(() => {
    setCreate(null)
    if (wantsNew) {
      opened.current = false
      router.replace(listAddress(pathname, { rows, q, carrier }))
    }
  }, [wantsNew, router, pathname, rows, q, carrier])

  const submitCreate = useCallback(async () => {
    if (!create || !create.salesOrderId || create.busy) return
    const order = create.orders?.find((entry) => entry.salesOrderId === create.salesOrderId)
    const lines = order ? newShipmentLines(order.cells, create.quantities) : []
    if (lines.length === 0) return
    setCreate({ ...create, busy: true, refused: null })
    try {
      const shipment = await createShipment(
        api,
        {
          salesOrderId: create.salesOrderId,
          transportBy: create.transportBy,
          // Blank: the site's default carrier and service (the API fills them); none at all without a carrier.
          ...(create.transportBy === 'CARRIER'
            ? { ...(create.carrierCode.trim() ? { carrierCode: create.carrierCode.trim() } : {}), ...(create.serviceCode.trim() ? { serviceCode: create.serviceCode.trim() } : {}) }
            : { carrierCode: null, serviceCode: null }),
          lines,
        },
        createKey.current ?? newIdempotencyKey(),
      )
      router.push(`${prefix}/warehouse/shipments/${shipment.id}`)
    } catch (error) {
      const problem = writeProblem(error)
      setCreate((current) => (current ? { ...current, busy: false, refused: { words: { key: problem.key }, detail: problem.detail ?? null } } : current))
    }
  }, [api, create, prefix, router])

  // ---- the model ---------------------------------------------------------------------------------------------------------

  const cutOffs = useMemo(() => cutOffsBySite(sites), [sites])
  const cards = queue.items ? cutOffCards(queue.items, cutOffs, today) : null
  const shown = list.items && carrier ? list.items.filter((row) => carrierKey(row) === carrier) : list.items
  const model: ShipmentsListModel = {
    prefix,
    can,
    today,
    rows,
    q,
    carrier,
    list: { ...list, items: shown },
    cards: queue.problem ? null : cards,
    tiles: tileCounts(queue.items, queue.more, inTransit),
    asOf,
    live,
    updates,
    notice,
    create,
    printDdts,
  }

  // ---- Print N DDTs (B-W2a-71) ---------------------------------------------------------------------------------------------

  const printWords = (error: unknown): PrintOutcome['words'] => {
    if (!isApiError(error)) return { key: 'printDdts.why.internal' }
    if (error.kind === 'invalid' && error.issues.some((issue) => issuePath(issue).includes('printerId'))) return { key: 'printDdts.why.noPrinter' }
    if (error.kind === 'conflict') return { key: 'printDdts.why.state' }
    if (error.kind === 'forbidden') return { key: 'printDdts.why.forbidden' }
    if (error.kind === 'not_found') return { key: 'printDdts.why.notFound' }
    return { key: 'printDdts.why.internal' }
  }

  const runPrintDdts = async () => {
    if (!printDdts || printDdts.busy || printDdts.outcomes) return
    const picked = (shown ?? []).filter((row) => printDdts.ids.includes(row.id))
    const plan = printDdtsPlan(picked)
    setPrintDdts({ ...printDdts, busy: true })
    const outcomes: PrintOutcome[] = []
    // One at a time: each is its own print command on its own site's printer.
    for (const row of plan.printable) {
      const key = (printKeys.current[row.id] ??= newIdempotencyKey())
      try {
        await printDdtOf(api, row.id, key)
        outcomes.push({ id: row.id, number: row.number, ddt: row.ddt?.number ?? null, state: 'queued', words: { key: 'printDdts.why.queued' } })
      } catch (error) {
        outcomes.push({ id: row.id, number: row.number, ddt: row.ddt?.number ?? null, state: 'refused', words: printWords(error) })
      }
    }
    for (const row of plan.skipped) outcomes.push({ id: row.id, number: row.number, ddt: null, state: 'skipped', words: { key: row.status === 'CANCELLED' ? 'printDdts.why.cancelled' : 'printDdts.why.noDdt' } })
    printKeys.current = {}
    setPrintDdts((current) => (current ? { ...current, busy: false, outcomes } : current))
  }

  const exportRows = (ids: string[]) => {
    const picked = (shown ?? []).filter((row) => ids.includes(row.id))
    downloadText(
      `shipments-${today}.csv`,
      shipmentsCsv(picked, {
        header: (column) => t(`csv.${column}`),
        status: (status) => t(`status.${status}`),
        carrier: (row) => {
          const words = carrierWords(row)
          return t(words.key, words.params)
        },
      }, { price: can.price }),
    )
  }

  return (
    <ShipmentsListView
      model={model}
      actions={{
        onRows: (next) => go({ rows: next, carrier: null }),
        onSearch: (next) => go({ q: next }),
        onCarrier: (next) => go({ rows: 'today', carrier: next }),
        onMore: () => void more(),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(`${prefix}/warehouse/shipments/${id}`),
        onExport: exportRows,
        onDismissNotice: () => setNotice(null),
        onNew: () => openCreate(null),
        onNewClose: closeCreate,
        onNewOrder: (salesOrderId) => setCreate((current) => (current ? { ...current, salesOrderId, quantities: {}, refused: null } : current)),
        onNewStep: (step) => setCreate((current) => (current ? { ...current, step, refused: null } : current)),
        onNewQuantity: (cellId, quantity) => setCreate((current) => (current ? { ...current, quantities: { ...current.quantities, [cellId]: quantity } } : current)),
        onNewAll: () =>
          setCreate((current) => {
            const order = current?.orders?.find((entry) => entry.salesOrderId === current.salesOrderId)
            return current && order ? { ...current, quantities: Object.fromEntries(order.cells.map((cell) => [cell.workOrderSizeId, cell.shippable])) } : current
          }),
        onNewDelivery: (next) => setCreate((current) => (current ? { ...current, ...next } : current)),
        onNewCreate: () => void submitCreate(),
        onPrintDdts: (ids) => {
          printKeys.current = {}
          setPrintDdts({ ids, busy: false, outcomes: null })
        },
        onPrintDdtsGo: () => void runPrintDdts(),
        onPrintDdtsClose: () => setPrintDdts((current) => (current?.busy ? current : null)),
      }}
    />
  )
}
