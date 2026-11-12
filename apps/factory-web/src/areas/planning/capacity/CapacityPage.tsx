'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { downloadText, useCoalesced, useLive } from '../../_shared/buying/hooks'
import { BOARD_KIT_NAMESPACE } from '../../_shared/planning-board/words'
import { listPlanningSites, type PlanningSite } from '../board/api'
import { getCapacity, getCellOrders, type Capacity, type CellOrders } from './api'
import { getHeatmap, getSubcontractorCapacity, getWorkshopCell, HEAT_WEEKS, type Heatmap, type Subcontractors } from './depth/api'
import { csvWorkshopRows, DEPTH_NAMESPACE, heatCellAt, kindOfTag, parseWorkshopKey, workshopCellAt, workshopRowKey } from './depth/model'
import { cellAt, controlsOf, csvOfLanes, NAMESPACE, periodProblem, queryOf, readProblemOf, type CapacityControls } from './model'
import type { CapacityModel, HeatDetail, Loaded } from './view-model'
import { CapacityView } from './view/CapacityView'

/**
 * `/w/<company>/planning/capacity` (SCR-123; Planning › Capacity & load, planning.view): the company's planning sites
 * (`?site=`, else the first), the capacity of the period (`?from=` `?to=`, the API's four weeks by default) in buckets
 * (`?bucket=DAY|WEEK|MONTH`), the tile pressed (`?tile=`), and a cell's orders (`?cell=`, read when it opens). Capacity
 * is counted on every read; live: a move on the board, a publish, a calendar, the lanes' capacity or a work order wait
 * behind "N updates · Show". Read only: nothing is written here.
 */
export function CapacityPage() {
  return (
    <WithMessages namespaces={[NAMESPACE, BOARD_KIT_NAMESPACE, 'lists', DEPTH_NAMESPACE]}>
      <CapacityContainer />
    </WithMessages>
  )
}

const LIVE_TYPES = /^(planning\.(schedule_changed|schedule_published|capacity_changed|settings_changed)|calendar\.|workorder\.|production\.scan_recorded|subcontractor_capacity\.changed|work_order_operation\.outsourced|subcontract_order\.)/

function CapacityContainer() {
  const t = useT(NAMESPACE)
  const td = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const query = params?.toString() ?? ''
  const controls = useMemo(() => controlsOf(new URLSearchParams(query)), [query])
  const prefix = pathname.replace(/\/planning\/capacity\/?$/, '')
  const canView = session.permissions.includes('planning.view')

  const [sites, setSites] = useState<Loaded<PlanningSite[]>>({ status: 'loading' })
  const [capacity, setCapacity] = useState<Loaded<Capacity>>({ status: 'loading' })
  const [cell, setCell] = useState<CapacityModel['cell']>(null)
  const [subcontractors, setSubcontractors] = useState<Loaded<Subcontractors>>({ status: 'loading' })
  const [heatmap, setHeatmap] = useState<Loaded<Heatmap>>({ status: 'loading' })
  const [workshopCell, setWorkshopCell] = useState<CapacityModel['workshopCell']>(null)
  const [heatCell, setHeatCell] = useState<CapacityModel['heatCell']>(null)
  const subsRef = useRef<Subcontractors | null>(null)
  const heatRef = useRef<Heatmap | null>(null)
  const [updates, setUpdates] = useState(0)
  const [dialog, setDialog] = useState<CapacityModel['dialog']>(null)
  const readId = useRef(0)
  const dataRef = useRef<Capacity | null>(null)
  const controlsRef = useRef(controls)
  controlsRef.current = controls

  const site = sites.status === 'ready' ? (sites.value.find((entry) => entry.id === controls.site) ?? sites.value[0] ?? null) : null
  const siteId = site?.id ?? null

  const setControls = useCallback(
    (next: Partial<CapacityControls>) => {
      const qs = queryOf({ ...controlsRef.current, ...next })
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [router, pathname],
  )

  useEffect(() => {
    if (!canView) return
    let gone = false
    listPlanningSites(api, session.company?.id ?? null)
      .then((value) => !gone && setSites({ status: 'ready', value }))
      .catch((error: unknown) => {
        if (gone) return
        setSites({ status: 'error', problem: readProblemOf(error) })
        setCapacity({ status: 'error', problem: readProblemOf(error) })
      })
    return () => {
      gone = true
    }
  }, [api, canView, session.company?.id])

  const load = useCallback(async () => {
    if (!siteId) {
      if (sites.status === 'ready') setCapacity({ status: 'error', problem: 'error.noSite' })
      return
    }
    const problem = periodProblem(controls)
    if (problem) {
      setCapacity({ status: 'error', problem })
      return
    }
    const id = ++readId.current
    // B-W2b-338: the workshops' lines over the same period, and the heatmap from the period's first week; each fails alone.
    const [read, subs, heat] = await Promise.allSettled([
      getCapacity(api, { siteId, from: controls.from, to: controls.to, bucket: controls.bucket }),
      getSubcontractorCapacity(api, { siteId, from: controls.from, to: controls.to, bucket: controls.bucket }),
      getHeatmap(api, { siteId, from: controls.from, weeks: HEAT_WEEKS }),
    ])
    if (id !== readId.current) return
    if (read.status === 'fulfilled') {
      dataRef.current = read.value
      setCapacity({ status: 'ready', value: read.value })
      setUpdates(0)
    } else setCapacity({ status: 'error', problem: readProblemOf(read.reason) })
    if (subs.status === 'fulfilled') {
      subsRef.current = subs.value
      setSubcontractors({ status: 'ready', value: subs.value })
    } else {
      subsRef.current = null
      setSubcontractors({ status: 'error', problem: readProblemOf(subs.reason) })
    }
    if (heat.status === 'fulfilled') {
      heatRef.current = heat.value
      setHeatmap({ status: 'ready', value: heat.value })
    } else {
      heatRef.current = null
      setHeatmap({ status: 'error', problem: readProblemOf(heat.reason) })
    }
  }, [api, siteId, sites.status, controls])

  useEffect(() => {
    if (sites.status !== 'ready') return
    setCapacity({ status: 'loading' })
    setSubcontractors({ status: 'loading' })
    setHeatmap({ status: 'loading' })
    void load()
    // A new period, bucket or site: read again (the tile and the open cell are the page's own).
  }, [sites.status, siteId, controls.from, controls.to, controls.bucket])

  const live = useLive(
    (change) => {
      const own = change.fields.siteId === undefined || change.fields.siteId === siteId
      if (own && LIVE_TYPES.test(change.type)) setUpdates((count) => count + 1)
    },
    () => void load(),
    canView,
  )
  const quietly = useCoalesced(() => void load(), 800)

  // The open cell: its orders, read when it opens (the lane's days of that bucket).
  const readCell = useCallback(
    (key: string) => {
      const data = dataRef.current
      const at = data ? cellAt(data, key) : null
      if (!siteId || !at) {
        setCell({ key, orders: { status: 'error', problem: 'error.gone' } })
        return () => undefined
      }
      let gone = false
      setCell({ key, orders: { status: 'loading' } })
      getCellOrders(api, { siteId, laneKind: at.lane.kind, laneId: at.lane.id, from: at.cell.from, to: at.cell.to })
        .then((orders: CellOrders) => !gone && setCell({ key, orders: { status: 'ready', value: orders } }))
        .catch((error: unknown) => !gone && setCell({ key, orders: { status: 'error', problem: readProblemOf(error) } }))
      return () => {
        gone = true
      }
    },
    [api, siteId],
  )
  // A workshop cell of the table (`?cell=WORKSHOP:…`): the work behind it.
  const readWorkshopCell = useCallback(
    (key: string) => {
      const subs = subsRef.current
      const at = subs ? workshopCellAt(subs, key) : null
      const parsed = parseWorkshopKey(key)
      if (!siteId || !at || !parsed) {
        setWorkshopCell({ key, jobs: { status: 'error', problem: 'error.gone' } })
        return () => undefined
      }
      let gone = false
      setWorkshopCell({ key, jobs: { status: 'loading' } })
      getWorkshopCell(api, { siteId, partyId: at.line.id, workCentreKind: kindOfTag(parsed.tag), from: at.cell.from, to: at.cell.to })
        .then((jobs) => !gone && setWorkshopCell({ key, jobs: { status: 'ready', value: jobs } }))
        .catch((error: unknown) => !gone && setWorkshopCell({ key, jobs: { status: 'error', problem: readProblemOf(error) } }))
      return () => {
        gone = true
      }
    },
    [api, siteId],
  )

  useEffect(() => {
    if (!controls.cell) {
      setCell(null)
      setWorkshopCell(null)
      return
    }
    if (parseWorkshopKey(controls.cell)) {
      setCell(null)
      if (subcontractors.status !== 'ready') return
      return readWorkshopCell(controls.cell)
    }
    setWorkshopCell(null)
    if (capacity.status !== 'ready') return
    return readCell(controls.cell)
  }, [controls.cell, capacity.status, subcontractors.status, readCell, readWorkshopCell])

  // A heatmap cell (`?heat=`): a lane's orders or a workshop's work in that week.
  const readHeatCell = useCallback(
    (key: string) => {
      const heat = heatRef.current
      const at = heat ? heatCellAt(heat, key) : null
      if (!siteId || !at) {
        setHeatCell({ key, detail: { status: 'error', problem: 'error.gone' } })
        return () => undefined
      }
      let gone = false
      setHeatCell({ key, detail: { status: 'loading' } })
      const read: Promise<HeatDetail> =
        at.lane.kind === 'WORKSHOP'
          ? getWorkshopCell(api, { siteId, partyId: at.lane.id, workCentreKind: at.lane.unit === null ? null : at.lane.workCentreKind, from: at.cell.from, to: at.cell.to }).then((jobs) => ({ kind: 'workshop' as const, jobs }))
          : getCellOrders(api, { siteId, laneKind: at.lane.kind, laneId: at.lane.id, from: at.cell.from, to: at.cell.to }).then((orders) => ({ kind: 'lane' as const, orders }))
      read
        .then((detail) => !gone && setHeatCell({ key, detail: { status: 'ready', value: detail } }))
        .catch((error: unknown) => !gone && setHeatCell({ key, detail: { status: 'error', problem: readProblemOf(error) } }))
      return () => {
        gone = true
      }
    },
    [api, siteId],
  )

  useEffect(() => {
    if (!controls.heat) {
      setHeatCell(null)
      return
    }
    if (heatmap.status !== 'ready') return
    return readHeatCell(controls.heat)
  }, [controls.heat, heatmap.status, readHeatCell])

  const model: CapacityModel = { prefix, canView, sites, siteId, controls, capacity, cell, live, updates, dialog, subcontractors, workshopCell, heatmap, heatCell }

  return (
    <CapacityView
      model={model}
      actions={{
        onSite: (next) => setControls({ site: next, cell: null, tile: null, heat: null }),
        onPeriod: (period) => setControls({ ...period, cell: null, heat: null }),
        onBucket: (bucket) => setControls({ bucket, cell: null }),
        onTile: (tile) => setControls(tile ? { tile, from: null, to: null, bucket: 'WEEK', cell: null } : { tile: null }),
        onCell: (key) => setControls({ cell: key, heat: null }),
        onRetry: () => void load(),
        onRetryCell: () => controls.cell && (parseWorkshopKey(controls.cell) ? readWorkshopCell(controls.cell) : readCell(controls.cell)),
        onHeat: (key) => setControls({ heat: key, cell: null }),
        onRetryHeat: () => void load(),
        onRetryHeatCell: () => controls.heat && readHeatCell(controls.heat),
        onRetrySubcontractors: () => void load(),
        onShowUpdates: () => quietly(),
        onExport: (laneKeys) => {
          const data = dataRef.current
          if (!data) return
          const lanes = data.lanes.filter((lane) => laneKeys.length === 0 || laneKeys.includes(`${lane.kind}:${lane.id}`))
          const subs = subsRef.current
          const lines = subs ? subs.lanes.filter((line) => laneKeys.length === 0 || laneKeys.includes(workshopRowKey(line))) : []
          const csv = csvOfLanes(data, lanes, { t, locale }, subs ? csvWorkshopRows(subs, lines, { t: td, locale }, { t, locale }) : [])
          downloadText(`capacity-${data.site.code}-${data.from}-${data.to}.csv`, csv)
        },
        onPrint: () => window.print(),
        onKeys: () => setDialog({ kind: 'keys' }),
        onCloseDialog: () => setDialog(null),
      }}
    />
  )
}
