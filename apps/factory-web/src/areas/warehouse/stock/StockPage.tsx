'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useT } from '../../../lib/i18n/provider'
import { recordAddress } from '../../../lib/records/record-links'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { downloadText, useCoalesced, useLive } from '../../_shared/buying/hooks'
import { pickerReasons, type PickerReason } from '../../_shared/reasons/api'
import { ledgerCounts, listLots, stockAsOf, stockOverview, type LotCounts, type ReservedKey } from '../../_shared/stock/api'
import { csvOf, readProblem, stockCan, TIME_ZONE } from '../../_shared/stock/model'
import { StockMessages } from '../../_shared/stock/parts'
import { useAdjust } from './adjust/useAdjust'
import { listHolds, type HoldRow } from './daily/api'
import { asOfInstant, DAILY_NAMESPACE } from './daily/model'
import { useHold } from './daily/useHold'
import { dailyCan, holdSubjectsOf, stockAddressOf, stockQueryString, type AsOfDraft, type GridRow, type SiteChoice, type StockAddress, type StockLine, type StockPageModel } from './model'
import { StockView } from './view/StockView'
// B-W2b-327: the places with their kinds and blocks, below minimum, why is it this number, Move…, a waiting adjustment.
import { listPlaces, type PlaceView } from '../locations/depth/api'
import { lowStock, postMove, whyFigure, type LowRow, type WaitingAdjustment } from './depth/api'
import { DEPTH_NAMESPACE, lowCount, moveHeldKey, moveInputs, movePlan, moveProblemOf, moveTargets, placesById, whyKeyOf, type MoveActions, type MoveDialogModel } from './depth/model'
import { wallOf } from './daily/model'

/**
 * `/w/<company>/warehouse/stock` (SCR-060): the site, the view, the tile and the search in the address (`?site=&view=
 * &tile=&q=`); reads the stock (`GET /inventory/stock`, one answer per site scope), the lots' tiles and the lots that
 * wait for their Cr VI result (`GET /inventory/lots?crVi=PENDING`), and with the cost grain the moves not valued yet;
 * live inventory.moved behind "N updates · Show" (rows never move under the reader), lot decisions refresh the tiles.
 * Adjust stock posts one move through the shared dialog, then the page reads again.
 *
 * B-W2a-64: `?asOf=<instant>` reads the stock as it was then (`GET /inventory/stock?asOf=`, read only: no live, no
 * reservations, no holds); now, the answer's reservations per key are placed on the rows, and with quality.holds.view
 * the site's ACTIVE holds (`GET /quality/holds`) and the HOLD reasons' words say why a row is held; Put N lots on hold
 * through the shared dialog (useHold), then the page reads again.
 */
export function StockPage() {
  return (
    <StockMessages extra={['warehouse-stock', DAILY_NAMESPACE, DEPTH_NAMESPACE]}>
      <StockContainer />
    </StockMessages>
  )
}

function StockContainer() {
  const t = useT('warehouse-stock')
  const s = useT('stock')
  const w = useT(DEPTH_NAMESPACE)
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/warehouse\/stock\/?$/, '')
  const can = useMemo(() => stockCan(session.permissions), [session.permissions])
  const daily = useMemo(() => dailyCan(session.permissions), [session.permissions])
  const address = useMemo(() => stockAddressOf(params), [params])

  const [rows, setRows] = useState<GridRow[] | null>(null)
  const [reservations, setReservations] = useState<ReservedKey[]>([])
  const [holds, setHolds] = useState<HoldRow[]>([])
  const [holdReasons, setHoldReasons] = useState<PickerReason[]>([])
  const [asOfDialog, setAsOfDialog] = useState<AsOfDraft | null>(null)
  const [currencies, setCurrencies] = useState<Record<string, string>>({})
  const [truncated, setTruncated] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [counts, setCounts] = useState<LotCounts | null>(null)
  const [crViLots, setCrViLots] = useState<string[]>([])
  const [unvalued, setUnvalued] = useState<number | null>(null)
  const [sites, setSites] = useState<SiteChoice[]>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [dismissed, setDismissed] = useState<string[]>([])
  const [notice, setNotice] = useState<StockPageModel['notice']>(null)
  const [places, setPlaces] = useState<PlaceView[]>([])
  const [low, setLow] = useState<StockPageModel['low']>(null)
  const [why, setWhy] = useState<StockPageModel['why']>(null)
  const [move, setMove] = useState<MoveDialogModel | null>(null)
  const [waiting, setWaiting] = useState<WaitingAdjustment | null>(null)
  const readId = useRef(0)
  const whyId = useRef(0)
  const moveKeys = useRef(new Map<string, string>())

  const go = useCallback(
    (next: Partial<StockAddress>) => {
      const qs = stockQueryString({ ...address, ...next })
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`)
    },
    [address, pathname, router],
  )

  // The company's sites and their places (B-W2b-327: each with its kind — In transit — and its block — Move…).
  const loadPlaces = useCallback(() => {
    if (!can.locationsView) return
    listPlaces(api, {})
      .then((answer) => {
        const own = answer.sites.filter((site) => !session.company || site.companyId === session.company.id)
        setSites(own.map(({ id, code, name }) => ({ id, code, name })))
        setPlaces(own.flatMap((site) => site.locations))
      })
      .catch(() => {
        setSites([])
        setPlaces([])
      })
  }, [api, can.locationsView, session.company])
  useEffect(loadPlaces, [loadPlaces])

  // B-W2b-327 (SCM-281): below minimum at the sites shown (one read per site; a failed one makes the tile "—").
  const siteIds = useMemo(() => (address.site ? [address.site] : sites.map((site) => site.id)), [address.site, sites])
  const loadLow = useCallback(() => {
    if (!can.stockView || address.asOf || siteIds.length === 0) {
      setLow(null)
      return
    }
    setLow((current) => current ?? { status: 'loading' })
    Promise.allSettled(siteIds.map((siteId) => lowStock(api, siteId)))
      .then((answers) => {
        const counts = answers.map((answer) => (answer.status === 'fulfilled' ? answer.value.count : null))
        const failed = answers.find((answer) => answer.status === 'rejected')
        if (failed && answers.every((answer) => answer.status === 'rejected')) {
          setLow({ status: 'error', problem: readProblem((failed as PromiseRejectedResult).reason) })
          return
        }
        const ready = answers.flatMap((answer) => (answer.status === 'fulfilled' ? [answer.value] : []))
        setLow({ status: 'ready', value: { count: lowCount(counts) ?? ready.reduce((sum, answer) => sum + answer.count, 0), rows: ready.flatMap((answer) => answer.rows.filter((row) => row.below)), alertsOff: ready.some((answer) => !answer.alerts.on) } })
      })
  }, [api, can.stockView, address.asOf, siteIds])
  useEffect(loadLow, [loadLow])

  const loadTiles = useCallback(() => {
    listLots(api, { siteId: address.site, crVi: 'PENDING', limit: 200 })
      .then((page) => {
        setCounts(page.counts)
        setCrViLots(page.lots.map((lot) => lot.id))
      })
      .catch(() => setCounts(null))
    if (can.cost)
      ledgerCounts(api, address.site)
        .then((answer) => setUnvalued(answer.unvalued ?? null))
        .catch(() => setUnvalued(null))
  }, [api, address.site, can.cost])

  // The site's ACTIVE quality holds (their reasons on the rows); a failed read leaves the lot-status words.
  const loadHolds = useCallback(() => {
    if (!daily.holdsView || address.asOf) return
    listHolds(api, { status: 'ACTIVE', siteId: address.site })
      .then((answer) => setHolds(answer.holds.filter((hold) => hold.subjectType === 'Lot' || hold.subjectType === 'Hide')))
      .catch(() => setHolds([]))
  }, [api, daily.holdsView, address.site, address.asOf])

  useEffect(() => {
    if (!daily.holdsView) return
    pickerReasons(api, ['HOLD'])
      .then(setHoldReasons)
      .catch(() => setHoldReasons([]))
  }, [api, daily.holdsView])

  const load = useCallback(async () => {
    if (!can.stockView) return
    const id = ++readId.current
    loadTiles()
    loadHolds()
    try {
      const answer = address.asOf ? await stockAsOf(api, { siteId: address.site }, address.asOf) : await stockOverview(api, { siteId: address.site })
      if (id !== readId.current) return
      setRows(answer.rows)
      setReservations('reservations' in answer ? (answer.reservations ?? []) : [])
      setCurrencies(Object.fromEntries(answer.items.flatMap((entry) => (entry.currency ? [[entry.itemId, entry.currency]] : []))))
      setTruncated(answer.truncated)
      setProblem(null)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows(null)
      setProblem(readProblem(error))
    }
  }, [api, can.stockView, address.site, address.asOf, loadTiles, loadHolds])

  useEffect(() => {
    setRows(null)
    void load()
  }, [load])

  const refreshTiles = useCoalesced(loadTiles, 800)
  const refreshPlaces = useCoalesced(loadPlaces, 800)
  const refreshLow = useCoalesced(loadLow, 1500)
  const live = useLive(
    (change) => {
      if (change.type === 'inventory.moved') setUpdates((count) => count + 1)
      if (change.type.startsWith('lot.') || change.type.startsWith('inventory.receipt_') || change.type === 'inventory.opening_posted') refreshTiles()
      // B-W2b-327: a block or a label code changed (Move… reads it), moves change what is below its minimum.
      if (change.type === 'inventory.location_blocked') refreshPlaces()
      if (change.type === 'inventory.moved') refreshLow()
    },
    () => void load(),
    can.stockView && !address.asOf,
  )

  const adjust = useAdjust(
    api,
    can.cost,
    (words) => {
      setNotice({ tone: 'success', key: words.key, params: words.params })
      void load()
    },
    // B-W2b-327: the warehouse rules' approval banner and the posting day; above the value it waits for a yes.
    { companyId: session.company?.id ?? null, approvers: session.permissions.includes('approvals.view'), today: wallOf(Date.now(), TIME_ZONE).day, onWaiting: setWaiting },
  )
  const hold = useHold(api, () => void load())

  // B-W2b-327 (design st-why): the quantity's "why is it this number", read when it opens (since its first move).
  const openWhy = useCallback(
    (line: StockLine | null) => {
      const id = ++whyId.current
      if (!line) {
        setWhy(null)
        return
      }
      setWhy({ lineId: line.id, state: { status: 'loading' } })
      whyFigure(api, whyKeyOf(line))
        .then((value) => id === whyId.current && setWhy({ lineId: line.id, state: { status: 'ready', value } }))
        .catch((error: unknown) => id === whyId.current && setWhy({ lineId: line.id, state: { status: 'error', problem: readProblem(error) } }))
    },
    [api],
  )
  const whyLine = useRef<StockLine | null>(null)

  // B-W2b-327: Move… — one W1 move (POST /inventory/transfers) per stock key and hide, each with its own Idempotency-Key
  // kept for the dialog (a retry of the same dialog is the same move); what moved and what was refused said after.
  const openMove = useCallback(
    (lines: StockLine[]) => {
      moveKeys.current = new Map()
      const siteId = lines[0]?.siteId ?? ''
      setMove({ lines, planned: movePlan(lines, rows ?? []), draft: { toLocationId: '', quantity: lines.length === 1 ? (Number(lines[0]!.onHand) ? String(Number(lines[0]!.onHand)) : '') : '', note: '' }, targets: moveTargets(places, siteId), posting: false, problem: null, done: null })
    },
    [rows, places],
  )
  const moveActions: MoveActions = {
    onChange: (draft) => setMove((current) => (current ? { ...current, draft, problem: null } : current)),
    onClose: () => {
      const moved = move?.done?.moved ?? 0
      setMove(null)
      if (moved > 0) void load()
    },
    onPost: () => {
      const current = move
      if (!current || moveHeldKey(current, placesById(places))) return
      setMove({ ...current, posting: true, problem: null })
      const inputs = moveInputs(current)
      void (async () => {
        let moved = 0
        const refused: { label: string; problem: { key: string; params?: Record<string, string | number> } }[] = []
        for (const entry of inputs) {
          const idempotencyKey = moveKeys.current.get(entry.key) ?? newIdempotencyKey()
          moveKeys.current.set(entry.key, idempotencyKey)
          try {
            await postMove(api, entry.input, idempotencyKey)
            moved += 1
          } catch (error) {
            refused.push({ label: entry.label, problem: moveProblemOf(error) })
            if (isApiError(error) && (error.kind === 'unavailable' || error.kind === 'forbidden')) break
          }
        }
        if (moved === 0 && refused.length > 0) setMove((now) => (now ? { ...now, posting: false, problem: refused[0]!.problem } : now))
        else setMove((now) => (now ? { ...now, posting: false, done: { moved, refused } } : now))
      })()
    },
  }

  const exportLow = useCallback(
    (picked: LowRow[]) => {
      const header = ['site', 'material', 'materialName', 'colour', 'minimum', 'onHand', 'onOrder', 'reserved', 'position', 'short', 'unit'].map((column) => w(`wd.low.csv.${column}`))
      const csvRows = picked.map((row) => [row.site.code, row.item.code, row.item.name, row.colour?.code ?? '', row.minimum, row.onHand, row.onOrder, row.reserved, row.position, row.short, s(`uom.${row.item.baseUom}`)])
      downloadText(`below-minimum-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(header, csvRows))
    },
    [s, w],
  )

  const exportLines = useCallback(
    (lines: StockLine[]) => {
      const header = ['material', 'materialName', 'colour', 'lot', 'hide', 'quality', 'site', 'location', 'onHand', 'unit', 'hides', 'reserved', 'held', 'available', ...(can.cost ? ['unitCost', 'value', 'currency'] : [])].map((column) => t(`st.csv.${column}`))
      const csvRows = lines.map((line) => [
        line.item.code,
        line.item.name,
        line.colour?.code ?? '',
        line.lot?.code ?? '',
        line.hide?.code ?? '',
        line.lot ? s(`quality.${line.lot.qualityStatus}`) : '',
        line.siteCode,
        line.location.code,
        line.onHand,
        s(`uom.${line.item.baseUom}`),
        line.hides,
        line.reserved ?? '',
        line.held ?? '',
        line.available ?? '',
        ...(can.cost ? [line.unitCost ?? '', line.value === null || line.value === undefined ? '' : (line.value / 100).toFixed(2), currencies[line.item.id] ?? ''] : []),
      ])
      downloadText(`stock-${(address.asOf ?? new Date().toISOString()).slice(0, 10)}.csv`, csvOf(header, csvRows))
    },
    [can.cost, currencies, s, t, address.asOf],
  )

  const model: StockPageModel = {
    prefix,
    can,
    address,
    sites,
    rows,
    problem,
    truncated,
    counts,
    crViLots,
    unvalued,
    currencies,
    asOf,
    live,
    updates,
    dismissed,
    timeZone: TIME_ZONE,
    notice,
    adjust: adjust.model,
    daily,
    reservations,
    holds,
    holdReasons,
    asOfDialog,
    hold: hold.model,
    places,
    low,
    why,
    move,
    waiting,
  }

  return (
    <StockView
      model={model}
      adjustActions={adjust.actions}
      holdActions={hold.actions}
      moveActions={moveActions}
      actions={{
        onAddress: go,
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onDismiss: (id) => setDismissed((current) => [...current, id]),
        onNotice: () => setNotice(null),
        onOpenRecord: (type, id) => router.push(`${prefix}${recordAddress({ type, id }, OFFICE_PAGES)}`),
        onAdjust: (line) =>
          adjust.open({
            siteId: line.siteId,
            siteCode: line.siteCode,
            item: line.item,
            colour: line.colour,
            lot: line.lot ? { id: line.lot.id, code: line.lot.code } : null,
            hide: line.hide,
            location: line.location,
            onHand: line.onHand,
          }),
        onExport: exportLines,
        onAsOf: setAsOfDialog,
        onAsOfShow: (draft) => {
          const instant = asOfInstant(draft.day, draft.time, TIME_ZONE)
          if (!instant) return
          setAsOfDialog(null)
          go({ asOf: instant })
        },
        onNow: () => {
          setAsOfDialog(null)
          go({ asOf: null })
        },
        onHold: (lines) => {
          const { subjects, leftOut } = holdSubjectsOf(lines)
          if (subjects.length > 0) hold.open('Lot', subjects, leftOut)
        },
        onWhy: (line) => {
          whyLine.current = line
          openWhy(line)
        },
        onRetryWhy: () => openWhy(whyLine.current),
        onMove: openMove,
        onDismissWaiting: () => setWaiting(null),
        onRetryLow: loadLow,
        onExportLow: exportLow,
        onOpenItem: (itemId) => router.push(`${prefix}${recordAddress({ type: 'Item', id: itemId }, OFFICE_PAGES)}`),
      }}
    />
  )
}
