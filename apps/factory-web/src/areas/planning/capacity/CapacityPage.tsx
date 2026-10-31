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
import { cellAt, controlsOf, csvOfLanes, NAMESPACE, periodProblem, queryOf, readProblemOf, type CapacityControls } from './model'
import type { CapacityModel, Loaded } from './view-model'
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
    <WithMessages namespaces={[NAMESPACE, BOARD_KIT_NAMESPACE, 'lists']}>
      <CapacityContainer />
    </WithMessages>
  )
}

const LIVE_TYPES = /^(planning\.(schedule_changed|schedule_published|capacity_changed|settings_changed)|calendar\.|workorder\.|production\.scan_recorded)/

function CapacityContainer() {
  const t = useT(NAMESPACE)
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
    try {
      const value = await getCapacity(api, { siteId, from: controls.from, to: controls.to, bucket: controls.bucket })
      if (id !== readId.current) return
      dataRef.current = value
      setCapacity({ status: 'ready', value })
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setCapacity({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, siteId, sites.status, controls])

  useEffect(() => {
    if (sites.status !== 'ready') return
    setCapacity({ status: 'loading' })
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
  useEffect(() => {
    if (!controls.cell) {
      setCell(null)
      return
    }
    if (capacity.status !== 'ready') return
    return readCell(controls.cell)
  }, [controls.cell, capacity.status, readCell])

  const model: CapacityModel = { prefix, canView, sites, siteId, controls, capacity, cell, live, updates, dialog }

  return (
    <CapacityView
      model={model}
      actions={{
        onSite: (next) => setControls({ site: next, cell: null, tile: null }),
        onPeriod: (period) => setControls({ ...period, cell: null }),
        onBucket: (bucket) => setControls({ bucket, cell: null }),
        onTile: (tile) => setControls(tile ? { tile, from: null, to: null, bucket: 'WEEK', cell: null } : { tile: null }),
        onCell: (key) => setControls({ cell: key }),
        onRetry: () => void load(),
        onRetryCell: () => controls.cell && readCell(controls.cell),
        onShowUpdates: () => quietly(),
        onExport: (laneKeys) => {
          const data = dataRef.current
          if (!data) return
          const lanes = data.lanes.filter((lane) => laneKeys.length === 0 || laneKeys.includes(`${lane.kind}:${lane.id}`))
          downloadText(`capacity-${data.site.code}-${data.from}-${data.to}.csv`, csvOfLanes(data, lanes, { t, locale }))
        },
        onPrint: () => window.print(),
        onKeys: () => setDialog({ kind: 'keys' }),
        onCloseDialog: () => setDialog(null),
      }}
    />
  )
}
