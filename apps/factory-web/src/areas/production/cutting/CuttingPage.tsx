'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { downloadText, useCoalesced, useLive } from '../_shared/hooks'
import { getAvailability, reserveHides } from '../work-orders/daily/api'
import { listCuts, roomYield, type CutRow, type CutTiles, type CutView, type YieldFigures } from './api'
import { addressOf, addressText, CUTTING_NAMESPACE, cuttingCanOf, phrase, readProblem, romeDayStart, usedText, writeProblem, type CutAddress } from './model'
import { createCutOrder, listCutOrders, siteStations, waitingGroups, type CutOrderSummary, type CutOrderTiles, type Station, type WaitingGroup } from './orders/api'
import { groupKeyOf, listCsv, listRows, NO_DRAFT, newOrderBody, newOrderHeld, orderHref, orderProblem, ORDERS_NAMESPACE, ordersCanOf, orderViewOf, sheetHref, type ListRow, type NewOrderDraft } from './orders/model'
import type { NewOrderModel } from './orders/view/NewCutOrderDialog'
import type { AllocModel } from './view/CutDialogs'
import { CuttingView, type CuttingModel } from './view/CuttingView'

const TIME_ZONE = 'Europe/Rome'
const PAGE = 50
const LIVE_CUTS = /^production\.(cut_|hide_|bundle|replacement_)|^workorder\./
const LIVE_ORDERS = /^(cut_order|cut_ticket|lay|cut_consumption)\./

/**
 * `/w/<company>/production/cutting` (SCR-238): the cut orders (B-W2b-129) and the work orders' leather cuts (W2a) of the saved
 * filter (`?view=`) and the search (`?q=`), 50 a page with "Show more", the tiles (answered with the lists; the fabric cut orders
 * added to Waiting and Cutting) and the room's yield today, and live cut, hide, bundle, recut and cut order events behind "N
 * updates · Show". `?new=1` opens New cut order (several work orders of one material and colour → a PLANNED cut order, opened
 * on its record); `?alloc=<work order>` opens Allocate hides for a work order's leather cut (each hide reserved whole).
 */
export function CuttingPage() {
  return (
    <WithMessages namespaces={[CUTTING_NAMESPACE, ORDERS_NAMESPACE, 'lists']}>
      <Container />
    </WithMessages>
  )
}

function Container() {
  const o = useT(ORDERS_NAMESPACE)
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/production\/cutting\/?$/, '')
  const can = useMemo(() => cuttingCanOf(session.permissions), [session.permissions])
  const orders = useMemo(() => ordersCanOf(session.permissions), [session.permissions])
  const address = addressOf(params)

  const [cuts, setCuts] = useState<{ items: readonly CutRow[] | null; more: boolean; problem: string | null }>({ items: null, more: false, problem: null })
  const [orderRows, setOrderRows] = useState<{ items: readonly CutOrderSummary[] | null; more: boolean; problem: string | null }>({ items: null, more: false, problem: null })
  const [limit, setLimit] = useState(PAGE)
  const [tiles, setTiles] = useState<CutTiles | null>(null)
  const [fabric, setFabric] = useState<CutOrderTiles | null>(null)
  const [yieldToday, setYieldToday] = useState<YieldFigures | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [slow, setSlow] = useState(false)
  const [notice, setNotice] = useState<CuttingModel['notice']>(null)
  const [groups, setGroups] = useState<{ value: readonly WaitingGroup[] | null; problem: string | null }>({ value: null, problem: null })
  const [stations, setStations] = useState<readonly Station[] | null>(null)
  const [draft, setDraft] = useState<NewOrderDraft>(NO_DRAFT)
  const [creating, setCreating] = useState<{ busy: boolean; error: NewOrderModel['error'] }>({ busy: false, error: null })
  const [alloc, setAlloc] = useState<AllocModel | null>(null)
  const reserveKey = useRef<string | null>(null)
  const createKey = useRef<string | null>(null)
  const readId = useRef(0)

  const go = useCallback((next: Partial<CutAddress>) => router.replace(`${pathname}${addressText({ ...address, ...next })}`), [router, pathname, address])

  const loadYield = useCallback(() => {
    if (!can.view) return
    const now = new Date()
    roomYield(api, { from: romeDayStart(now).toISOString(), to: now.toISOString() })
      .then(setYieldToday)
      .catch(() => setYieldToday(null))
  }, [api, can.view])

  /** The fabric cut orders per status (the tiles): one row is enough, the counts come with it. */
  const loadFabric = useCallback(() => {
    listCutOrders(api, { view: 'open', kind: 'FABRIC', limit: 1 })
      .then((page) => setFabric(page.tiles))
      .catch(() => setFabric(null))
  }, [api])

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    loadYield()
    loadFabric()
    const orderView = orderViewOf(address.view)
    const [cutsRead, ordersRead] = await Promise.allSettled([
      listCuts(api, { view: address.view, q: address.q, limit }),
      orderView ? listCutOrders(api, { view: orderView, q: address.q, limit }) : Promise.resolve(null),
    ])
    if (id !== readId.current) return
    if (cutsRead.status === 'fulfilled') {
      setCuts({ items: cutsRead.value.cuts, more: cutsRead.value.more, problem: null })
      setTiles(cutsRead.value.tiles)
      setAsOf(cutsRead.value.asOf)
    } else setCuts({ items: null, more: false, problem: readProblem(cutsRead.reason) })
    if (ordersRead.status === 'fulfilled') setOrderRows({ items: ordersRead.value?.rows ?? [], more: !!ordersRead.value?.nextCursor, problem: null })
    else setOrderRows({ items: null, more: false, problem: readProblem(ordersRead.reason) })
    setUpdates(0)
  }, [api, can.view, address.view, address.q, limit, loadYield, loadFabric])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => setLimit(PAGE), [address.view, address.q])

  // "Still loading…" after about a second (the design's slow note).
  useEffect(() => {
    setSlow(false)
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [address.view, address.q])

  // Live: a cut, a hide closed, a bundle, a recut or a cut order somewhere → "N updates · Show"; the tiles follow.
  const refreshTiles = useCoalesced(() => {
    loadYield()
    loadFabric()
    listCuts(api, { view: address.view, q: address.q, limit: 1 })
      .then((page) => setTiles(page.tiles))
      .catch(() => undefined)
  }, 1000)
  const live = useLive(
    (change) => {
      if (!LIVE_CUTS.test(change.type) && !LIVE_ORDERS.test(change.type)) return
      setUpdates((count) => count + 1)
      refreshTiles()
    },
    () => void load(),
    can.view,
  )

  // ---- New cut order (B-W2b-129) ----------------------------------------------------------------------------------------------

  const loadGroups = useCallback(() => {
    setGroups({ value: null, problem: null })
    waitingGroups(api)
      .then((value) => setGroups({ value, problem: null }))
      .catch((error: unknown) => setGroups({ value: null, problem: readProblem(error) }))
  }, [api])

  useEffect(() => {
    if (address.newCut && can.view) {
      createKey.current = newIdempotencyKey()
      setDraft(NO_DRAFT)
      setCreating({ busy: false, error: null })
      loadGroups()
    }
    // Only when the address asks.
  }, [address.newCut])

  const group = groups.value?.find((entry) => groupKeyOf(entry) === draft.groupKey) ?? null
  useEffect(() => {
    setStations(null)
    if (!group || !orders.print) return
    const controller = new AbortController()
    siteStations(api, group.siteId, controller.signal)
      .then(setStations)
      .catch(() => setStations([]))
    return () => controller.abort()
  }, [api, group?.siteId, orders.print])

  const create = useCallback(async () => {
    if (!group || newOrderHeld(draft, group, orders, creating.busy)) return
    const key = createKey.current ?? newIdempotencyKey()
    createKey.current = key
    setCreating({ busy: true, error: null })
    try {
      const record = await createCutOrder(api, newOrderBody(draft, group), key)
      createKey.current = null
      setCreating({ busy: false, error: null })
      router.push(orderHref(prefix, record.cutOrder.id))
    } catch (error) {
      createKey.current = newIdempotencyKey()
      setCreating({ busy: false, error: orderProblem(error) })
      // The cells are read again: another cut order may have taken one meanwhile.
      waitingGroups(api)
        .then((value) => setGroups({ value, problem: null }))
        .catch(() => undefined)
    }
  }, [api, draft, group, orders, creating.busy, router, prefix])

  // ---- Allocate hides (a work order's leather cut, W2a) -----------------------------------------------------------------------

  const readAvailability = useCallback(
    (cut: CutRow, material: { itemId: string; itemColourId: string | null }) => {
      setAlloc((current) => (current ? { ...current, material, availability: { value: null, problem: null } } : current))
      getAvailability(api, { siteId: cut.workOrder.siteId, itemId: material.itemId, itemColourId: material.itemColourId })
        .then((value) => setAlloc((current) => (current?.cut?.workOrder.id === cut.workOrder.id ? { ...current, availability: { value, problem: null } } : current)))
        .catch((error: unknown) => setAlloc((current) => (current?.cut?.workOrder.id === cut.workOrder.id ? { ...current, availability: { value: null, problem: readProblem(error) } } : current)))
    },
    [api],
  )

  const openAlloc = useCallback(
    async (workOrderId: string) => {
      reserveKey.current = newIdempotencyKey()
      setAlloc({ cut: null, material: null, availability: { value: null, problem: null }, busy: false, problem: null })
      let cut = (cuts.items ?? []).find((row) => row.workOrder.id === workOrderId) ?? null
      if (!cut) {
        try {
          cut = (await listCuts(api, { view: 'all', q: '', limit: 200 })).cuts.find((row) => row.workOrder.id === workOrderId) ?? null
        } catch (error) {
          setAlloc((current) => (current ? { ...current, availability: { value: null, problem: readProblem(error) } } : current))
          return
        }
      }
      if (!cut) {
        setAlloc((current) => (current ? { ...current, availability: { value: null, problem: 'problem.gone' } } : current))
        return
      }
      const material = cut.materials[0]
      setAlloc((current) => (current ? { ...current, cut } : current))
      if (material && can.stock) readAvailability(cut, { itemId: material.itemId, itemColourId: material.itemColourId })
      else setAlloc((current) => (current ? { ...current, availability: { value: null, problem: can.stock ? 'problem.gone' : 'problem.forbidden' } } : current))
    },
    [api, cuts.items, can.stock, readAvailability],
  )

  useEffect(() => {
    if (address.alloc && alloc?.cut?.workOrder.id !== address.alloc) void openAlloc(address.alloc)
    if (!address.alloc && alloc) setAlloc(null)
    // Only when the address asks.
  }, [address.alloc])

  const reserve = useCallback(
    async (hideIds: string[]) => {
      const cut = alloc?.cut
      if (!cut || hideIds.length === 0) return
      const key = reserveKey.current ?? newIdempotencyKey()
      reserveKey.current = key
      setAlloc((current) => (current ? { ...current, busy: true, problem: null } : current))
      try {
        await reserveHides(api, { siteId: cut.workOrder.siteId, workOrderId: cut.workOrder.id, hideIds }, key)
        reserveKey.current = null
        setAlloc(null)
        setNotice({ tone: 'success', words: phrase('notice.allocated', { count: hideIds.length, number: cut.workOrder.number }) })
        go({ alloc: null, newCut: false })
        void load()
      } catch (error) {
        reserveKey.current = newIdempotencyKey()
        setAlloc((current) => (current ? { ...current, busy: false, problem: writeProblem(error) } : current))
        // The hides are read again, so the dialog shows what may be taken now.
        if (alloc?.material) readAvailability(cut, alloc.material)
      }
    },
    [alloc?.cut, alloc?.material, api, go, load, readAvailability],
  )

  // ---- the rows, export, tickets ----------------------------------------------------------------------------------------------

  // A failed read of the cuts is the list's error (never drawn as an empty list); a failed read of the cut orders is said above it.
  const items = cuts.items === null ? null : listRows(address.view, orderRows.items, cuts.items)
  const rows: CuttingModel['rows'] = cuts.problem ? { items: null, more: false, problem: cuts.problem } : { items, more: cuts.more || orderRows.more, problem: null }

  const exportRows = useCallback(
    (keys: string[]) => {
      const picked = (items ?? []).filter((row) => keys.includes(row.key))
      const header = ['cut', 'kind', 'workOrders', 'style', 'material', 'lot', 'state', 'planned', 'piecesCut', 'plies', 'hides', 'area', 'yieldPct', 'table', 'date'].map((column) => o(`csv.${column}`))
      downloadText(`cuts-${new Date().toISOString().slice(0, 10)}.csv`, listCsv(picked, header, (cut) => usedText(cut.hides.used, 'en')))
    },
    [items, o],
  )

  const openRow = (row: ListRow) => {
    if (row.order) router.push(orderHref(prefix, row.order.id))
    else if (can.workOrders) router.push(`${prefix}/production/cutting/${row.cut.workOrder.id}`)
  }

  const model: CuttingModel = {
    prefix,
    can,
    orders,
    address,
    rows,
    ordersProblem: !cuts.problem && orderRows.problem ? orderRows.problem : null,
    tiles,
    fabric,
    yieldToday,
    asOf,
    live,
    updates,
    slow,
    timeZone: TIME_ZONE,
    notice,
    newOrder: address.newCut ? { groups: groups.value, problem: groups.problem, stations, draft, busy: creating.busy, error: creating.error } : null,
    alloc: address.alloc ? (alloc ?? { cut: null, material: null, availability: { value: null, problem: null }, busy: false, problem: null }) : null,
  }

  return (
    <CuttingView
      model={model}
      actions={{
        onView: (view: CutView) => go({ view }),
        onSearch: (q) => go({ q }),
        onMore: () => setLimit((current) => Math.min(200, current + PAGE)),
        onRetry: () => {
          void load()
          if (address.newCut) loadGroups()
          if (address.alloc) void openAlloc(address.alloc)
        },
        onOpen: openRow,
        onShowUpdates: () => void load(),
        onNew: (open) => go({ newCut: open, alloc: null }),
        onDraft: (next) => {
          setDraft(next)
          setCreating((current) => ({ ...current, error: null }))
        },
        onCreate: () => void create(),
        onAllocate: (workOrderId) => go({ alloc: workOrderId, newCut: false }),
        onMaterial: (material) => alloc?.cut && readAvailability(alloc.cut, material),
        onReserve: (hideIds) => void reserve(hideIds),
        onExport: exportRows,
        onTickets: (row) => {
          if (row.order) window.open(sheetHref(prefix, row.order.id), '_blank', 'noopener')
          else router.push(`${prefix}/production/cutting/${row.cut.workOrder.id}?tab=tickets`)
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
