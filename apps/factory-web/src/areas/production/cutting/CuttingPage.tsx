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
import { addressOf, addressText, csvOf, CUTTING_NAMESPACE, cuttingCanOf, newCutChoices, phrase, readProblem, romeDayStart, writeProblem, type CutAddress } from './model'
import type { AllocModel, NewCutModel } from './view/CutDialogs'
import { CuttingView, type CuttingModel } from './view/CuttingView'

const TIME_ZONE = 'Europe/Rome'
const PAGE = 50

/**
 * `/w/<company>/production/cutting` (SCR-238): the cuts of the saved filter (`?view=`), the search (`?q=`), 50 a page with
 * "Show more", the tiles (answered with the list) and the room's yield today, and live cut, hide, bundle and recut
 * events behind "N updates · Show". `?new=1` opens New cut order; Create cut order opens Allocate hides
 * (`?alloc=<work order>`), whose hides are reserved whole for the work order.
 */
export function CuttingPage() {
  return (
    <WithMessages namespaces={[CUTTING_NAMESPACE, 'lists']}>
      <Container />
    </WithMessages>
  )
}

function Container() {
  const t = useT(CUTTING_NAMESPACE)
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/production\/cutting\/?$/, '')
  const can = useMemo(() => cuttingCanOf(session.permissions), [session.permissions])
  const address = addressOf(params)

  const [rows, setRows] = useState<CuttingModel['rows']>({ items: null, more: false, problem: null })
  const [limit, setLimit] = useState(PAGE)
  const [tiles, setTiles] = useState<CutTiles | null>(null)
  const [yieldToday, setYieldToday] = useState<YieldFigures | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [slow, setSlow] = useState(false)
  const [notice, setNotice] = useState<CuttingModel['notice']>(null)
  const [newCut, setNewCut] = useState<NewCutModel | null>(null)
  const [alloc, setAlloc] = useState<AllocModel | null>(null)
  const reserveKey = useRef<string | null>(null)
  const readId = useRef(0)

  const go = useCallback((next: Partial<CutAddress>) => router.replace(`${pathname}${addressText({ ...address, ...next })}`), [router, pathname, address])

  const loadYield = useCallback(() => {
    if (!can.view) return
    const now = new Date()
    roomYield(api, { from: romeDayStart(now).toISOString(), to: now.toISOString() })
      .then(setYieldToday)
      .catch(() => setYieldToday(null))
  }, [api, can.view])

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    loadYield()
    try {
      const page = await listCuts(api, { view: address.view, q: address.q, limit })
      if (id !== readId.current) return
      setRows({ items: page.cuts, more: page.more, problem: null })
      setTiles(page.tiles)
      setAsOf(page.asOf)
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readProblem(error) })
    }
  }, [api, can.view, address.view, address.q, limit, loadYield])

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

  // Live: a cut, a hide closed, a bundle or a recut somewhere → "N updates · Show"; the tiles follow.
  const refreshTiles = useCoalesced(() => {
    loadYield()
    listCuts(api, { view: address.view, q: address.q, limit: 1 })
      .then((page) => setTiles(page.tiles))
      .catch(() => undefined)
  }, 1000)
  const live = useLive(
    (change) => {
      if (!/^production\.(cut_|hide_|bundle|replacement_)|^workorder\./.test(change.type)) return
      setUpdates((count) => count + 1)
      refreshTiles()
    },
    () => void load(),
    can.view,
  )

  // ---- New cut order ----------------------------------------------------------------------------------------------------------

  const loadChoices = useCallback(() => {
    setNewCut((current) => ({ choices: null, problem: null, busy: false, ...(current?.picked ? { picked: current.picked } : {}) }))
    listCuts(api, { view: 'waiting', q: '', limit: 200 })
      .then((page) => setNewCut((current) => (current ? { ...current, choices: newCutChoices(page.cuts), problem: null } : current)))
      .catch((error: unknown) => setNewCut((current) => (current ? { ...current, choices: null, problem: readProblem(error) } : current)))
  }, [api])

  useEffect(() => {
    if (address.newCut && !newCut && can.view) loadChoices()
    if (!address.newCut && newCut) setNewCut(null)
    // Only when the address asks.
  }, [address.newCut])

  // ---- Allocate hides ----------------------------------------------------------------------------------------------------------

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
      const known = [...(rows.items ?? []), ...(newCut?.choices ?? [])].find((row) => row.workOrder.id === workOrderId)
      let cut = known ?? null
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
    [api, rows.items, newCut?.choices, can.stock, readAvailability],
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

  // ---- export ----------------------------------------------------------------------------------------------------------------------

  const exportRows = useCallback(
    (ids: string[]) => {
      const picked = (rows.items ?? []).filter((row) => ids.includes(row.workOrder.id))
      const header = ['cut', 'kind', 'style', 'material', 'lot', 'state', 'piecesPlanned', 'piecesCut', 'hides', 'area', 'yieldPct', 'plannedPct', 'table', 'lastCut'].map((column) => t(`csv.${column}`))
      downloadText(`cuts-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(picked, header, 'en'))
    },
    [rows.items, t],
  )

  const model: CuttingModel = {
    prefix,
    can,
    address,
    rows,
    tiles,
    yieldToday,
    asOf,
    live,
    updates,
    slow,
    timeZone: TIME_ZONE,
    notice,
    newCut: address.newCut ? (newCut ?? { choices: null, problem: null, busy: false }) : null,
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
          if (address.newCut) loadChoices()
          if (address.alloc) void openAlloc(address.alloc)
        },
        onOpen: (row) => (can.workOrders ? router.push(`${prefix}/production/cutting/${row.workOrder.id}`) : undefined),
        onShowUpdates: () => void load(),
        onNew: (open) => go({ newCut: open, alloc: null }),
        onCreateCut: (workOrderId) => go({ newCut: false, alloc: workOrderId }),
        onAllocate: (workOrderId) => go({ alloc: workOrderId, newCut: false }),
        onMaterial: (material) => alloc?.cut && readAvailability(alloc.cut, material),
        onReserve: (hideIds) => void reserve(hideIds),
        onExport: exportRows,
        onTickets: (workOrderId) => router.push(`${prefix}/production/cutting/${workOrderId}?tab=tickets`),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
