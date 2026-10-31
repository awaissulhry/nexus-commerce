'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useT } from '../../../lib/i18n/provider'
import { recordAddress } from '../../../lib/records/record-links'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { downloadText, useCoalesced, useLive } from '../../_shared/buying/hooks'
import { pickerReasons, type PickerReason } from '../../_shared/reasons/api'
import { ledgerCounts, listLocations, listLots, stockAsOf, stockOverview, type LotCounts, type ReservedKey } from '../../_shared/stock/api'
import { csvOf, readProblem, stockCan, TIME_ZONE } from '../../_shared/stock/model'
import { StockMessages } from '../../_shared/stock/parts'
import { useAdjust } from './adjust/useAdjust'
import { listHolds, type HoldRow } from './daily/api'
import { asOfInstant, DAILY_NAMESPACE } from './daily/model'
import { useHold } from './daily/useHold'
import { dailyCan, holdSubjectsOf, stockAddressOf, stockQueryString, type AsOfDraft, type GridRow, type SiteChoice, type StockAddress, type StockLine, type StockPageModel } from './model'
import { StockView } from './view/StockView'

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
    <StockMessages extra={['warehouse-stock', DAILY_NAMESPACE]}>
      <StockContainer />
    </StockMessages>
  )
}

function StockContainer() {
  const t = useT('warehouse-stock')
  const s = useT('stock')
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
  const readId = useRef(0)

  const go = useCallback(
    (next: Partial<StockAddress>) => {
      const qs = stockQueryString({ ...address, ...next })
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`)
    },
    [address, pathname, router],
  )

  useEffect(() => {
    if (!can.locationsView) return
    listLocations(api, {})
      .then((answer) => setSites(answer.sites.filter((site) => !session.company || site.companyId === session.company.id).map(({ id, code, name }) => ({ id, code, name }))))
      .catch(() => setSites([]))
  }, [api, can.locationsView, session.company])

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
  const live = useLive(
    (change) => {
      if (change.type === 'inventory.moved') setUpdates((count) => count + 1)
      if (change.type.startsWith('lot.') || change.type.startsWith('inventory.receipt_') || change.type === 'inventory.opening_posted') refreshTiles()
    },
    () => void load(),
    can.stockView && !address.asOf,
  )

  const adjust = useAdjust(api, can.cost, (words) => {
    setNotice({ tone: 'success', key: words.key, params: words.params })
    void load()
  })
  const hold = useHold(api, () => void load())

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
  }

  return (
    <StockView
      model={model}
      adjustActions={adjust.actions}
      holdActions={hold.actions}
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
      }}
    />
  )
}
