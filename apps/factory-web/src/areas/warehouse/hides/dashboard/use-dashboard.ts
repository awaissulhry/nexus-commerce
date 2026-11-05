'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { readProblem } from '../../../_shared/stock/model'
import { cuttingYield, gradeMix, leatherDashboard, leatherValue, type CuttingYield, type GradeMix, type LeatherDashboard, type LeatherValue } from './api'
import { readOpen, writeOpen, yieldRange, type PanelRead } from './dashboard-model'

/** The reads the dashboard's panels make (the remnants panel reads the grade mix's totals). */
export type DashboardRead = 'area' | 'mix' | 'dashboard' | 'yield'

export interface LeatherDashboardModel {
  open: boolean
  /** The cost grain: the Area value series may show. */
  cost: boolean
  series: 'area' | 'value'
  area: PanelRead<LeatherValue>
  mix: PanelRead<GradeMix>
  dashboard: PanelRead<LeatherDashboard>
  yield: PanelRead<CuttingYield>
  /** The grid's filters, so the bar that set one shows pressed. */
  active: { article: string | null; lot: string | null }
}

export interface LeatherDashboardActions {
  onToggle?: (open: boolean) => void
  onSeries?: (series: 'area' | 'value') => void
  onRetry?: (read: DashboardRead) => void
  /** A bar of an article and colour: the grid shows its hides (`?item=&colour=`). */
  onArticle?: (key: string) => void
  /** A lot's bar: the grid shows its hides (`?lot=`). */
  onLot?: (lotId: string) => void
  /** The remnants panel: the remnant pieces view. */
  onRemnants?: () => void
  /** An on-hold bar: the grid shows that article's hides in quarantine. */
  onOnHold?: (key: string) => void
}

const LOADING = { value: null, problem: null, asOf: null } as const

/**
 * The leather dashboard's container part (Hides, B-W2b-131): reads each panel on its own (each has its own AsOf, empty and
 * error) while the dashboard is open, for the site of the page; the open state is kept per person in this browser (a
 * private window keeps it for the page only). `refresh()` reads every open panel again (the page calls it on live stock
 * and cut events, coalesced). The yield needs production.cutting.view: held with the reason otherwise, never read.
 */
export function useLeatherDashboard(api: ApiClient, scope: { siteId: string | null; stockView: boolean; cost: boolean; cuttingView: boolean }, active: LeatherDashboardModel['active']) {
  const [open, setOpen] = useState(true)
  const [series, setSeries] = useState<'area' | 'value'>('area')
  const [area, setArea] = useState<PanelRead<LeatherValue>>(LOADING)
  const [mix, setMix] = useState<PanelRead<GradeMix>>(LOADING)
  const [dashboard, setDashboard] = useState<PanelRead<LeatherDashboard>>(LOADING)
  const [yields, setYields] = useState<PanelRead<CuttingYield>>(scope.cuttingView ? LOADING : { ...LOADING, held: 'dash.yield.held' })
  const asked = useRef<Record<DashboardRead, number>>({ area: 0, mix: 0, dashboard: 0, yield: 0 })

  useEffect(() => {
    setOpen(readOpen(typeof window === 'undefined' ? null : window.localStorage))
  }, [])

  const read = useCallback(
    (which: DashboardRead) => {
      if (!scope.stockView) return
      const id = ++asked.current[which]
      const now = () => new Date().toISOString()
      const fail = (error: unknown) => ({ value: null, problem: readProblem(error), asOf: null })
      const mine = () => id === asked.current[which]
      if (which === 'area') {
        setArea((current) => ({ ...current, problem: null }))
        leatherValue(api, { siteId: scope.siteId })
          .then((value) => mine() && setArea({ value, problem: null, asOf: now() }))
          .catch((error: unknown) => mine() && setArea(fail(error)))
      } else if (which === 'mix') {
        setMix((current) => ({ ...current, problem: null }))
        gradeMix(api, { siteId: scope.siteId, groupBy: 'lot' })
          .then((value) => mine() && setMix({ value, problem: null, asOf: now() }))
          .catch((error: unknown) => mine() && setMix(fail(error)))
      } else if (which === 'dashboard') {
        setDashboard((current) => ({ ...current, problem: null }))
        leatherDashboard(api, { siteId: scope.siteId })
          .then((value) => mine() && setDashboard({ value, problem: null, asOf: value.asOf }))
          .catch((error: unknown) => mine() && setDashboard(fail(error)))
      } else {
        if (!scope.cuttingView) {
          setYields({ ...LOADING, held: 'dash.yield.held' })
          return
        }
        setYields((current) => ({ ...current, problem: null }))
        cuttingYield(api, { siteId: scope.siteId, ...yieldRange(new Date()) })
          .then((value) => mine() && setYields({ value, problem: null, asOf: now() }))
          .catch((error: unknown) => mine() && setYields(fail(error)))
      }
    },
    [api, scope.siteId, scope.stockView, scope.cuttingView],
  )

  const refresh = useCallback(() => {
    if (!open) return
    for (const which of ['area', 'mix', 'dashboard', 'yield'] as const) read(which)
  }, [open, read])

  useEffect(() => {
    refresh()
  }, [refresh])

  const model: LeatherDashboardModel = { open, cost: scope.cost, series: scope.cost ? series : 'area', area, mix, dashboard, yield: yields, active }
  const actions = {
    onToggle: (next: boolean) => {
      setOpen(next)
      writeOpen(typeof window === 'undefined' ? null : window.localStorage, next)
    },
    onSeries: (next: 'area' | 'value') => setSeries(scope.cost ? next : 'area'),
    onRetry: (which: DashboardRead) => read(which),
  }
  return { model, actions, refresh }
}
