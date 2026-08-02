'use client'

/**
 * DPS.4 — "when does this account actually sell", as the first thing on the page.
 *
 * Every best-in-class dayparting tool (Adtomic, AdLabs, Eva, Pacvue) leads with the 7×24 grid and
 * treats authoring as the second step: you look, then you decide. This panel puts that grid above
 * the schedule list so the page answers "which hours are worth holding a rank in" before it asks
 * you to name windows.
 *
 * Data is REAL Amazon Marketing Stream hourly performance (AmazonAdsHourlyPerformance) via
 * GET /advertising/dayparting/heatmap — the signal most tools charge four figures a month for.
 * Scope rides the endpoint's DPS.4 params so the page never pushes 200+ campaign ids through a
 * query string: `scope=all` for the account, `groupId=` for one schedule's member campaigns.
 *
 * The grid itself is the existing DaypartingHeatmap, unchanged — same component the builder draws,
 * so a cell means the same thing in both places.
 */
import { useEffect, useMemo, useState } from 'react'
import { H10Select } from '../../campaigns/FilterDropdown'
import { DaypartingHeatmap, type HeatCell } from '../_schedule/DaypartingHeatmap'
import { CHART_METRICS } from '../_schedule/scheduleConfig'
import { metricVal, type RawCell } from '../_schedule/heatMetrics'
import { getBackendUrl } from '@/lib/backend-url'

const WINDOWS = [
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '60', label: 'Last 60 days' },
  { value: '90', label: 'Last 90 days' },
]

export interface ScopeOption { value: string; label: string }

export function HourlyPerformance({ scopes }: { scopes: ScopeOption[] }) {
  const [scope, setScope] = useState('all')
  const [metric, setMetric] = useState('Spend')
  const [days, setDays] = useState('60')
  const [raw, setRaw] = useState<RawCell[]>([])
  const [hasData, setHasData] = useState(true)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    // scope 'all' → whole account; anything else is a RankScheduleGroup id → its member campaigns.
    const qs = scope === 'all' ? `scope=all&windowDays=${days}` : `groupId=${encodeURIComponent(scope)}&windowDays=${days}`
    void fetch(`${getBackendUrl()}/api/advertising/dayparting/heatmap?${qs}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        setRaw(Array.isArray(j?.cells) ? j.cells : [])
        setHasData(!!j?.hasData)
      })
      .catch(() => { if (alive) { setRaw([]); setHasData(false) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [scope, days])

  const cells = useMemo<HeatCell[]>(() => {
    const read = metricVal(metric).f
    return raw.map((c) => ({ dow: c.dow, hour: c.hour, value: read(c) }))
  }, [raw, metric])

  const scopeOptions = useMemo(() => [{ value: 'all', label: 'All campaigns' }, ...scopes], [scopes])

  // Peak hour is the single most actionable read on this grid, so state it in words rather than
  // making the operator scan 168 cells for the darkest one.
  const peak = useMemo(() => {
    if (!cells.length) return null
    const top = cells.reduce((a, b) => (b.value > a.value ? b : a), cells[0])
    if (top.value <= 0) return null
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const hh = (h: number) => `${String(h).padStart(2, '0')}:00`
    return `${DAYS[top.dow]} ${hh(top.hour)}`
  }, [cells])

  return (
    <div className="h10-dp-panel">
      <div className="h10-dp-panelhd">
        <div className="h10-dp-panelttl">
          <h3>Hourly performance</h3>
          <p>
            Amazon Marketing Stream, {metric} by day and hour, Europe/Rome.
            {peak ? <> Busiest: <b>{peak}</b>.</> : null}
          </p>
        </div>
        <div className="h10-dp-panelctl">
          <H10Select width={210} options={scopeOptions} value={scope} onChange={setScope} ariaLabel="Heatmap scope" />
          <H10Select width={140} options={CHART_METRICS} value={metric} onChange={setMetric} ariaLabel="Heatmap metric" />
          <H10Select width={150} options={WINDOWS} value={days} onChange={setDays} ariaLabel="Heatmap period" />
        </div>
      </div>
      {!loading && !hasData ? (
        <div className="h10-dp-panelempty">
          No hourly data for this selection yet. Amazon Marketing Stream fills forward from the day it
          was switched on — it is not backfilled — so a newly-added campaign takes a while to appear.
        </div>
      ) : (
        <DaypartingHeatmap cells={cells} unit={metricVal(metric).unit} loading={loading} />
      )}
    </div>
  )
}
