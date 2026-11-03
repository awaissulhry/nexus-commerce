'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { downloadText, useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { pickerReasons, type PickerReason } from '../../../_shared/reasons/api'
import { listHides, listLocations, stockOverview, type HideRow, type HidesPage as HidesAnswer } from '../../../_shared/stock/api'
import { csvOf, readProblem, stockCan, TIME_ZONE } from '../../../_shared/stock/model'
import { listHolds } from '../../stock/daily/api'
import { demandLabel, holdsBySubject } from '../../stock/daily/model'
import { useReserve } from '../../stock/daily/useReserve'
import { useWriteOff } from '../../stock/daily/useWriteOff'
import type { SiteChoice } from '../../lots/model'
import { dailyCan, hidesValue, reserveHides, scrapTarget, type HoldsBySubject } from '../../lots/shared/daily'
import { LotsMessages, useWords } from '../../lots/shared/parts'
import { useLeatherDashboard } from '../dashboard/use-dashboard'
import { articleOfKey } from '../dashboard/dashboard-model'
import { useFindHides } from '../find/use-find'
import { exactHide, FILTER_PARAM, filtersOf, HIDE_CSV_COLUMNS, hideQuery, hideViewOf, type HideFilters, type HidesListModel, type HideView } from '../model'
import { useMoveHides } from '../move/use-move'
import { useHidePhotos } from '../photos/use-hide-photos'
import { usePrintTags } from '../print/usePrintTags'
import { listRemnants, remnantRecord, type RemnantsPage } from '../remnants/api'
import type { RemnantsListModel } from '../remnants/view/RemnantsList'
import { HidesListView } from './view/HidesListView'

/**
 * `/w/<company>/warehouse/hides` (SCR-200): the view (`?view=`, or the API's own `?state=` `?quality=` `?inStock=`), the
 * search (`?q=`: a typed or scanned tag; one exact hit opens the hide), the site (`?site=`) and the narrowing filters
 * (`?lot=` `?grade=` `?shade=` `?location=`) in the address; the hides 50 a page with "Show more", the tiles and the
 * filter's two numbers; live inventory.* and production.cut_* events behind "N updates · Show"; Print N tags. B-W2a-64:
 * the site's ACTIVE quality holds and the HOLD reasons (quality.holds.view: a held hide says why), Reserve N hides to a
 * work order and Scrap N hides (the shared every-day dialogs; with the cost grain the value leaving stock from the stock
 * read of the hides' material). B-W2b-131: the leather dashboard (SCR-134, on / off per person; a bar sets `?item=`
 * `?colour=`, `?lot=` or the view), Find hides for a job (the band's primary), Move N hides (one transfer each), the
 * Remnants tile as pieces beside area and the Remnants view as the tagged pieces (`?remnant=<id>` opens one), and the
 * rows' photos (files.read: a Thumbnail opens the Lightbox).
 */
export function HidesPage() {
  return (
    <LotsMessages>
      <HidesContainer />
    </LotsMessages>
  )
}

function HidesContainer() {
  const t = useWords()
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => stockCan(session.permissions), [session.permissions])
  const daily = useMemo(() => dailyCan(session.permissions), [session.permissions])
  const view = hideViewOf(params)
  const q = params?.get('q') ?? ''
  const siteId = params?.get('site') ?? null
  const filters = useMemo(() => filtersOf(params), [params])

  const [rows, setRows] = useState<HidesListModel['rows']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [counts, setCounts] = useState<HidesAnswer['counts'] | null>(null)
  const [matching, setMatching] = useState<HidesAnswer['matching'] | null>(null)
  const [sites, setSites] = useState<SiteChoice[]>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [holds, setHolds] = useState<HoldsBySubject>({})
  const [holdReasons, setHoldReasons] = useState<PickerReason[]>([])
  const readId = useRef(0)
  const searched = useRef(false)
  const rowsRef = useRef<readonly HideRow[]>([])
  rowsRef.current = rows.items ?? []

  const address = useCallback(
    (next: { view?: HideView; q?: string; site?: string | null; drop?: keyof HideFilters; set?: Partial<HideFilters>; remnant?: string | null }) => {
      const query = new URLSearchParams()
      query.set('view', next.view ?? view)
      const nextQ = next.q ?? q
      if (nextQ.trim()) query.set('q', nextQ.trim())
      const nextSite = next.site === undefined ? siteId : next.site
      if (nextSite) query.set('site', nextSite)
      const nextFilters = { ...filters, ...next.set }
      for (const [name, value] of Object.entries(nextFilters) as [keyof HideFilters, string | null][]) if (value && name !== next.drop && !(next.drop === 'itemId' && name === 'itemColourId')) query.set(FILTER_PARAM[name], value)
      const remnant = next.remnant === undefined ? (params?.get('remnant') ?? null) : next.remnant
      if (remnant && (next.view ?? view) === 'remnants') query.set('remnant', remnant)
      return `${pathname}?${query.toString()}`
    },
    [pathname, view, q, siteId, filters, params],
  )

  useEffect(() => {
    if (!can.locationsView) return
    listLocations(api, {})
      .then((answer) => setSites(answer.sites.filter((site) => !session.company || site.companyId === session.company.id).map((site) => ({ id: site.id, code: site.code, name: site.name }))))
      .catch(() => setSites([]))
  }, [api, can.locationsView, session.company])

  // B-W2a-64: why a held hide is held (its own or its lot's quality hold), in the reason's words.
  const loadHolds = useCallback(() => {
    if (!daily.holdsView) return
    listHolds(api, { status: 'ACTIVE', siteId })
      .then((answer) => setHolds(Object.fromEntries(holdsBySubject(answer.holds))))
      .catch(() => setHolds({}))
  }, [api, daily.holdsView, siteId])
  useEffect(() => {
    if (!daily.holdsView) return
    pickerReasons(api, ['HOLD'])
      .then(setHoldReasons)
      .catch(() => setHoldReasons([]))
  }, [api, daily.holdsView])

  // B-W2b-131: the tagged remnant pieces (the tile: pieces · area; the Remnants view: one by one).
  const [remnantTotals, setRemnantTotals] = useState<RemnantsPage['totals'] | null>(null)
  const [remnantRows, setRemnantRows] = useState<RemnantsListModel['rows']>({ items: null, more: false, problem: null })
  const [remnantCursor, setRemnantCursor] = useState<string | null>(null)
  const [remnantMinimum, setRemnantMinimum] = useState<RemnantsPage['minimum'] | null>(null)
  const [remnantOpen, setRemnantOpen] = useState<RemnantsListModel['open']>(null)
  const openRemnantId = view === 'remnants' ? (params?.get('remnant') ?? null) : null
  const remnantsId = useRef(0)
  const [remnantViewTotals, setRemnantViewTotals] = useState<RemnantsPage['totals'] | null>(null)
  const loadRemnants = useCallback(
    async (after: string | null = null) => {
      if (!can.stockView) return
      const id = ++remnantsId.current
      // The tile counts every piece of the site, as the other tiles count every hide (never the search or the filters).
      if (!after)
        listRemnants(api, { siteId, limit: 1 })
          .then((page) => {
            if (id !== remnantsId.current) return
            setRemnantTotals(page.totals)
            setRemnantMinimum(page.minimum)
          })
          .catch(() => id === remnantsId.current && setRemnantTotals(null))
      if (view !== 'remnants') return
      try {
        const page = await listRemnants(api, { siteId, itemId: filters.itemId, lotId: filters.lotId, q, cursor: after, limit: 50 })
        if (id !== remnantsId.current) return
        setRemnantViewTotals(page.totals)
        setRemnantRows((current) => ({ items: after && current.items ? [...current.items, ...page.rows.filter((row) => !current.items!.some((seen) => seen.id === row.id))] : page.rows, more: page.nextCursor !== null, problem: null }))
        setRemnantCursor(page.nextCursor)
      } catch (error) {
        if (id !== remnantsId.current) return
        setRemnantRows({ items: null, more: false, problem: readProblem(error) })
        setRemnantViewTotals(null)
      }
    },
    [api, can.stockView, siteId, filters.itemId, filters.lotId, q, view],
  )
  useEffect(() => {
    setRemnantRows({ items: null, more: false, problem: null })
    void loadRemnants(null)
  }, [loadRemnants])
  useEffect(() => {
    if (!openRemnantId) {
      setRemnantOpen(null)
      return
    }
    setRemnantOpen({ id: openRemnantId, value: null, problem: null })
    remnantRecord(api, openRemnantId)
      .then((value) => setRemnantOpen((current) => (current?.id === openRemnantId ? { id: openRemnantId, value, problem: null } : current)))
      .catch((error: unknown) => setRemnantOpen((current) => (current?.id === openRemnantId ? { id: openRemnantId, value: null, problem: readProblem(error) } : current)))
  }, [api, openRemnantId])

  const load = useCallback(async () => {
    if (!can.stockView) return
    const id = ++readId.current
    loadHolds()
    try {
      const page = await listHides(api, hideQuery(view, q, siteId, filters))
      if (id !== readId.current) return
      setRows({ items: page.hides, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setCounts(page.counts)
      setMatching(page.matching)
      setAsOf(new Date().toISOString())
      setUpdates(0)
      if (searched.current) {
        searched.current = false
        const hit = exactHide(q, page.hides)
        if (hit) router.push(`${prefix}/warehouse/hides/${encodeURIComponent(hit)}`)
      }
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readProblem(error) })
      setCounts(null)
      setMatching(null)
    }
  }, [api, can.stockView, view, q, siteId, filters, prefix, router, loadHolds])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listHides(api, hideQuery(view, q, siteId, filters, cursor))
      setRows((current) => ({ items: [...(current.items ?? []), ...page.hides.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setRows((current) => ({ ...current, more: false, problem: current.items ? null : readProblem(error) }))
    }
  }, [api, cursor, view, q, siteId, filters])

  // Live: a move or a cut → the tiles follow (coalesced), the rows wait behind "N updates · Show".
  const refreshCounts = useCoalesced(() => {
    listHides(api, { ...hideQuery(view, q, siteId, filters), limit: 1 })
      .then((page) => {
        setCounts(page.counts)
        setMatching(page.matching)
      })
      .catch(() => undefined)
  }, 1000)
  const dashboard = useLeatherDashboard(
    api,
    { siteId, stockView: can.stockView, cost: daily.cost, cuttingView: session.permissions.includes('production.cutting.view') },
    { article: filters.itemId ? `${filters.itemId}|${filters.itemColourId ?? ''}` : null, lot: filters.lotId },
  )
  const refreshDashboard = useCoalesced(() => {
    dashboard.refresh()
    void loadRemnants(null)
  }, 2000)
  const live = useLive(
    (change) => {
      if (change.type.startsWith('inventory.') || change.type.startsWith('production.cut')) {
        setUpdates((count) => count + 1)
        refreshCounts()
        refreshDashboard()
      }
      if (change.type.startsWith('quality.hold')) {
        loadHolds()
        refreshDashboard()
      }
    },
    () => void load(),
    can.stockView,
  )

  const unitWord = useCallback((uom: HideRow['areaUom']) => t(`stock:uom.${uom}`), [t])
  const hidesOf = useCallback((ids: readonly string[]) => rowsRef.current.filter((row) => ids.includes(row.id)), [])
  const print = usePrintTags(api, locale, unitWord, hidesOf)
  // B-W2b-131: after this page's own write the list, the dashboard and the remnant pieces read again (live events need the
  // outbox relay; this does not wait for them).
  const afterWrite = useCallback(() => {
    void load()
    dashboard.refresh()
    void loadRemnants(null)
  }, [load, dashboard, loadRemnants])
  const reserve = useReserve(api, { workOrders: daily.workOrders, timeZone: TIME_ZONE }, afterWrite)
  const writeOff = useWriteOff(api, { withCost: daily.cost, canPhoto: daily.filesUpload, canNcr: daily.ncrRaise, prefix }, afterWrite)
  const find = useFindHides(
    api,
    { reserve: daily.reserve, override: session.permissions.includes('inventory.shade.override'), workOrders: daily.workOrders, grades: session.permissions.includes('product.materials.view') },
    sites,
    afterWrite,
  )
  const move = useMoveHides(api, afterWrite)
  // The Photo column: the shown rows' photos (files.read), the newest one's image per hide.
  const filesRead = session.permissions.includes('files.read')
  const shownIds = useMemo(() => (rows.items ?? []).map((row) => row.id), [rows.items])
  const photos = useHidePhotos(api, shownIds, { enabled: filesRead && can.stockView && view !== 'remnants', urls: 'first' })

  const openReserve = useCallback(
    (ids: readonly string[]) => {
      const picked = hidesOf(ids)
      if (picked.length === 0) return
      reserve.open(picked[0]!.siteId, reserveHides(picked, holds, holdReasons, locale))
    },
    [hidesOf, reserve, holds, holdReasons, locale],
  )

  const openScrap = useCallback(
    async (ids: readonly string[]) => {
      const picked = hidesOf(ids)
      if (picked.length === 0) return
      let value: { amount: number; currency: string } | null = null
      // With the cost grain the value leaving stock: the stock read of the hides' material (one per material), its rows of these hides.
      const items = [...new Set(picked.map((row) => row.item.id))]
      if (daily.cost && items.length === 1) {
        try {
          const answer = await stockOverview(api, { siteId: picked[0]!.siteId, itemId: items[0]! })
          value = hidesValue(answer.rows, ids, answer.items.find((entry) => entry.itemId === items[0])?.currency ?? null)
        } catch {
          value = null
        }
      }
      writeOff.open(scrapTarget(picked, holds, value))
    },
    [api, daily.cost, hidesOf, holds, writeOff],
  )

  const exportRows = useCallback(
    (ids: readonly string[]) => {
      const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
      const header = HIDE_CSV_COLUMNS.map((column) => t(`hd.csv.${column}`))
      const lines = picked.map((row) => [
        row.code,
        row.supplierCode ?? '',
        `${row.item.code} ${row.item.name}`,
        row.colour ? `${row.colour.code} ${row.colour.name}` : '',
        row.lot.code,
        t(`stock:quality.${row.lot.qualityStatus}`),
        row.lot.dyeBatch ?? '',
        row.shade ?? row.lot.shade ?? '',
        row.grade ?? '',
        row.area,
        t(`stock:uom.${row.areaUom}`),
        row.baseArea,
        row.left,
        t(`stock:uom.${row.item.baseUom}`),
        t(`stock:hideState.${row.state}`),
        row.location?.code ?? '',
        row.thicknessMm ?? '',
        row.defects ?? '',
        row.receivedAt ?? '',
        row.reservedFor ? demandLabel(row.reservedFor.demand) : '',
      ])
      downloadText(`hides-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(header, lines))
    },
    [rows.items, t],
  )

  const model: HidesListModel = {
    prefix,
    can,
    view,
    q,
    filters,
    sites,
    siteId,
    rows,
    counts,
    matching,
    asOf,
    live,
    updates,
    timeZone: TIME_ZONE,
    print: print.dialog,
    daily,
    holds,
    holdReasons,
    reserve: reserve.model,
    writeOff: writeOff.model,
    dashboard: dashboard.model,
    find: find.model,
    move: move.model,
    canTransfer: session.permissions.includes('inventory.transfer'),
    remnantTotals,
    remnants: view === 'remnants' ? { prefix, timeZone: TIME_ZONE, rows: remnantRows, totals: remnantViewTotals, minimum: remnantMinimum, open: remnantOpen } : null,
    photos: filesRead ? photos.state : null,
    lightbox: photos.lightbox,
  }

  return (
    <HidesListView
      model={model}
      actions={{
        onView: (next) => router.replace(address({ view: next })),
        onSearch: (next) => {
          searched.current = next.trim() !== ''
          router.replace(address({ q: next }))
        },
        onSite: (next) => router.replace(address({ site: next })),
        onClearFilter: (name) => router.replace(address({ drop: name })),
        onMore: () => void more(),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(`${prefix}/warehouse/hides/${encodeURIComponent(id)}`),
        onExport: exportRows,
        print: print.actions,
        onReserve: openReserve,
        onScrap: (ids) => void openScrap(ids),
        reserve: reserve.actions,
        writeOff: writeOff.actions,
        dashboard: {
          ...dashboard.actions,
          onArticle: (key) => {
            const { itemId, colourId } = articleOfKey(key)
            const same = filters.itemId === itemId && filters.itemColourId === colourId
            router.replace(address({ view: view === 'remnants' ? 'inStock' : view, set: { itemId: same ? null : itemId, itemColourId: same ? null : colourId } }))
          },
          onLot: (lotId) => router.replace(address({ view: view === 'remnants' ? 'inStock' : view, set: { lotId: filters.lotId === lotId ? null : lotId } })),
          onRemnants: () => router.replace(address({ view: 'remnants' })),
          onOnHold: (key) => {
            const { itemId, colourId } = articleOfKey(key)
            router.replace(address({ view: 'quarantine', set: { itemId, itemColourId: colourId } }))
          },
        },
        onFind: () => find.open(siteId),
        find: find.actions,
        onMove: (ids) => move.open(hidesOf(ids)),
        move: move.actions,
        remnants: {
          onMore: () => void loadRemnants(remnantCursor),
          onRetry: () => void loadRemnants(null),
          onOpen: (id) => router.replace(address({ remnant: id })),
        },
        onPhoto: (hideId, hideCode) => photos.open(hideId, hideCode, 0),
        lightbox: { onIndex: photos.step, onClose: photos.close },
      }}
    />
  )
}
