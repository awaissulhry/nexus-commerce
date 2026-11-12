'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { downloadText, useLive } from '../../_shared/buying/hooks'
import { listPlanningSites, type PlanningSite } from '../board/api'
import { getDemand, getDemandRows, type Demand, type DemandAsk, type SourceRows } from './api'
import { cellFilter, cellRefKey, controlsOf, csvOfGrid, demandCan, gridLines, listFilterOf, NAMESPACE, PAGE, POPOVER_LIMIT, queryOf, readProblemOf, type CellRef, type DemandControls, type Words } from './model'
import type { DemandModel, DemandPopover, ListRows, Loaded } from './view-model'
import { DemandView } from './view/DemandView'

/** The live changes of the demand's sources (orders, quotes, sample rounds, rework, recuts, returns, shipments, the strategy). */
const SOURCE_EVENTS = ['sales_order.', 'quote.', 'sample_round.', 'production.rework', 'recut_ticket.', 'return.', 'shipment.', 'planning.item_parameters_changed']
const isSourceChange = (type: string) => SOURCE_EVENTS.some((prefix) => type.startsWith(prefix))

/**
 * `/w/<company>/planning/demand` (SCR-374; Planning › Long range › Demand & forecast, planning.view): the company's planning
 * sites (`?site=`, else the first), then two reads of the site, each its own section: GET /planning/demand (the tiles and the
 * time-phased grid, with `?bucket=` `?weeks=` `?q=`) and GET /planning/demand/rows (the list, with its own `?layer=` `?rq=` and
 * one cell `?style=` `?colour=` `?size=` `?mtm=` `?cell=`; pages of 100). A cell's popover reads the same rows filtered to the
 * cell when it opens. `?layers=` is the grid's toggles (the screen adds them up; nothing is read again). Nothing is written.
 * Live: a change of a source waits behind "N updates · Show" (rows never move under the cursor).
 */
export function DemandPage() {
  return (
    <WithMessages namespaces={[NAMESPACE, 'lists']}>
      <DemandContainer />
    </WithMessages>
  )
}

function DemandContainer() {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const words: Words = useMemo(() => ({ t, locale }), [t, locale])
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const query = params?.toString() ?? ''
  const controls = useMemo(() => controlsOf(new URLSearchParams(query)), [query])
  const prefix = pathname.replace(/\/planning\/demand\/?$/, '')
  const can = useMemo(() => demandCan(session.permissions), [session.permissions])

  const [sites, setSites] = useState<Loaded<PlanningSite[]>>({ status: 'loading' })
  const [demand, setDemand] = useState<Loaded<Demand>>({ status: 'loading' })
  const [list, setList] = useState<Loaded<ListRows>>({ status: 'loading' })
  const [open, setOpen] = useState<readonly string[]>([])
  const [popover, setPopover] = useState<DemandPopover | null>(null)
  const [updates, setUpdates] = useState(0)
  const [dialog, setDialog] = useState<{ kind: 'keys' } | null>(null)
  const [siteTry, setSiteTry] = useState(0)
  const controlsRef = useRef(controls)
  controlsRef.current = controls
  const reads = useRef({ demand: 0, list: 0, popover: 0 })

  const site = sites.status === 'ready' ? (sites.value.find((entry) => entry.id === controls.site) ?? sites.value[0] ?? null) : null
  const siteId = site?.id ?? null
  const ask: DemandAsk | null = useMemo(() => (siteId ? { siteId, bucket: controls.bucket, weeks: controls.weeks, q: controls.q } : null), [siteId, controls.bucket, controls.weeks, controls.q])
  const listFilter = useMemo(() => listFilterOf(controls), [controls.layer, controls.rq, controls.style, controls.colour, controls.size, controls.mtm, controls.cell])
  const listKey = JSON.stringify(listFilter)

  const setControls = useCallback(
    (next: Partial<DemandControls>) => {
      const qs = queryOf({ ...controlsRef.current, ...next })
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [router, pathname],
  )

  useEffect(() => {
    if (!can.view) return
    let gone = false
    setSites({ status: 'loading' })
    listPlanningSites(api, session.company?.id ?? null)
      .then((value) => !gone && setSites({ status: 'ready', value }))
      .catch((error: unknown) => {
        if (gone) return
        const problem = readProblemOf(error)
        setSites({ status: 'error', problem })
        setDemand({ status: 'error', problem })
        setList({ status: 'error', problem })
      })
    return () => {
      gone = true
    }
  }, [api, can.view, session.company?.id, siteTry])

  const loadDemand = useCallback(async () => {
    if (!ask) return
    const id = ++reads.current.demand
    try {
      const value = await getDemand(api, ask)
      if (id === reads.current.demand) {
        setDemand({ status: 'ready', value })
        setUpdates(0)
      }
    } catch (error) {
      if (id === reads.current.demand) setDemand({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, ask])

  const loadList = useCallback(async () => {
    if (!ask) return
    const id = ++reads.current.list
    try {
      const value = await getDemandRows(api, { ...ask, q: null }, listFilter, { limit: PAGE })
      if (id === reads.current.list) setList({ status: 'ready', value: firstPage(value) })
    } catch (error) {
      if (id === reads.current.list) setList({ status: 'error', problem: readProblemOf(error) })
    }
    // listKey stands for the filter's terms.
  }, [api, ask, listKey])

  const loadMore = useCallback(async () => {
    if (!ask || list.status !== 'ready' || !list.value.nextCursor || list.value.more === 'loading') return
    const id = reads.current.list
    const current = list.value
    setList({ status: 'ready', value: { ...current, more: 'loading' } })
    try {
      const value = await getDemandRows(api, { ...ask, q: null }, listFilter, { cursor: current.nextCursor, limit: PAGE })
      if (id === reads.current.list) setList({ status: 'ready', value: { ...firstPage(value), rows: [...current.rows, ...value.rows] } })
    } catch (error) {
      if (id !== reads.current.list) return
      // The page the cursor named is gone (the demand moved): read the list from its start again.
      if (readProblemOf(error) === 'error.moved') void loadList()
      else setList({ status: 'ready', value: { ...current, more: 'failed' } })
    }
  }, [api, ask, list, listFilter, loadList])

  useEffect(() => {
    if (sites.status !== 'ready') return
    if (!siteId) {
      setDemand({ status: 'error', problem: 'error.noSite' })
      setList({ status: 'error', problem: 'error.noSite' })
      return
    }
    setDemand({ status: 'loading' })
    setPopover(null)
    void loadDemand()
  }, [sites.status, siteId, loadDemand])

  useEffect(() => {
    if (sites.status !== 'ready' || !siteId) return
    setList({ status: 'loading' })
    void loadList()
  }, [sites.status, siteId, loadList])

  // A new horizon or site keeps no open line that is gone.
  const rowKeys = demand.status === 'ready' ? demand.value.rows.map((row) => row.key).join(',') : null
  useEffect(() => {
    if (rowKeys === null) return
    setOpen((current) => current.filter((key) => rowKeys.split(',').includes(key)))
  }, [rowKeys])

  const loadCell = useCallback(
    async (ref: CellRef) => {
      if (!ask || demand.status !== 'ready') return
      const line = gridLines(demand.value.rows, open.includes(ref.lineId.split('|')[0]!) ? [...open] : [...open, ref.lineId.split('|')[0]!]).find((entry) => entry.id === ref.lineId)
      if (!line) return
      const id = ++reads.current.popover
      setPopover({ ref, rows: { status: 'loading' } })
      try {
        const value = await getDemandRows(api, { ...ask, q: null }, cellFilter(line, ref.bucket), { limit: POPOVER_LIMIT })
        if (id === reads.current.popover) setPopover((current) => (current && cellRefKey(current.ref) === cellRefKey(ref) ? { ref, rows: { status: 'ready', value } } : current))
      } catch (error) {
        if (id === reads.current.popover) setPopover((current) => (current && cellRefKey(current.ref) === cellRefKey(ref) ? { ref, rows: { status: 'error', problem: readProblemOf(error) } } : current))
      }
    },
    [api, ask, demand, open],
  )

  const live = useLive(
    (change) => {
      if (!isSourceChange(change.type)) return
      const own = change.fields.siteId === undefined || change.fields.siteId === siteId
      if (own) setUpdates((count) => count + 1)
    },
    () => {
      void loadDemand()
      void loadList()
    },
    can.view,
  )

  const model: DemandModel = { prefix, can, sites, siteId, controls, demand, list, open, popover, live, updates, dialog, built: OFFICE_PAGES }

  return (
    <DemandView
      model={model}
      actions={{
        onSite: (next) => setControls({ site: next, style: null, colour: null, size: null, mtm: false, cell: null }),
        onBucket: (bucket) => setControls({ bucket, cell: null }),
        onWeeks: (weeks) => setControls({ weeks, cell: null }),
        onLayers: (layers) => setControls({ layers }),
        onSearch: (q) => setControls({ q }),
        onTile: (layer) => setControls({ layer }),
        onToggleOpen: (ids, next) => setOpen((current) => (next ? [...new Set([...current, ...ids])] : current.filter((id) => !ids.includes(id)))),
        onCell: (ref) => {
          if (ref === null) {
            reads.current.popover += 1
            setPopover(null)
          } else void loadCell(ref)
        },
        onRetryCell: () => popover && void loadCell(popover.ref),
        onList: (next) => setControls(next),
        onClearList: () => setControls({ layer: null, rq: '', style: null, colour: null, size: null, mtm: false, cell: null }),
        onMore: () => void loadMore(),
        onOpenSource: (href) => router.push(href),
        onRetry: (section) => {
          if (sites.status === 'error') setSiteTry((count) => count + 1)
          else if (section === 'demand') void loadDemand()
          else void loadList()
        },
        onShowUpdates: () => {
          void loadDemand()
          void loadList()
        },
        onExportGrid: (ids) => {
          if (demand.status !== 'ready') return
          const lines = gridLines(demand.value.rows, open).filter((line) => ids.length === 0 || ids.includes(line.row.key))
          downloadText(`demand-${demand.value.site.code}-${demand.value.today}.csv`, csvOfGrid(demand.value, lines, controlsRef.current.layers, words))
        },
        onKeys: () => setDialog({ kind: 'keys' }),
        onCloseDialog: () => setDialog(null),
      }}
    />
  )
}

function firstPage(value: SourceRows): ListRows {
  return { rows: value.rows, pieces: value.pieces, sources: value.kinds.reduce((sum, entry) => sum + entry.sources, 0), nextCursor: value.nextCursor, more: 'idle' }
}
