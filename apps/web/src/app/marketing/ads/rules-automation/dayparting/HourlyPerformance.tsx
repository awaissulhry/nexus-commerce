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

/**
 * DPS.4b — whole weeks, not "last N days".
 *
 * A day×hour grid summed over a non-multiple of 7 gives some weekdays one more occurrence than
 * others (60 days = 8 weeks + 4 days), which inflated those rows by up to 33% on the shortest
 * window purely through calendar arithmetic. Offering weeks makes the label honest and every cell
 * comparable. Day counts are spelled out so nobody has to do the multiplication.
 */
const WINDOWS = [
  { value: '2', label: 'Last 2 weeks' },
  { value: '4', label: 'Last 4 weeks' },
  { value: '8', label: 'Last 8 weeks' },
  { value: '13', label: 'Last 13 weeks' },
]

export interface ScopeOption { value: string; label: string }

export function HourlyPerformance({ scopes }: { scopes: ScopeOption[] }) {
  const [scope, setScope] = useState('all')
  const [metric, setMetric] = useState('Spend')
  const [weeks, setWeeks] = useState('8')
  const [raw, setRaw] = useState<RawCell[]>([])
  const [hasData, setHasData] = useState(true)
  const [loading, setLoading] = useState(true)
  // What the server actually resolved the window to, and how much of it holds data. Shown verbatim
  // rather than echoing what was asked for — Marketing Stream is not backfilled, so a long window
  // over a young campaign is mostly empty and the operator must be able to see that.
  const [meta, setMeta] = useState<{ from: string | null; to: string | null; weeks: number; daysWithData: number; restatedCells: number } | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    // scope 'all' → whole account; anything else is a RankScheduleGroup id → its member campaigns.
    const qs = scope === 'all' ? `scope=all&weeks=${weeks}` : `groupId=${encodeURIComponent(scope)}&weeks=${weeks}`
    void fetch(`${getBackendUrl()}/api/advertising/dayparting/heatmap?${qs}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return
        setRaw(Array.isArray(j?.cells) ? j.cells : [])
        setHasData(!!j?.hasData)
        setMeta({ from: j?.from ?? null, to: j?.to ?? null, weeks: Number(j?.weeks ?? 0), daysWithData: Number(j?.coverage?.daysWithData ?? 0), restatedCells: Number(j?.coverage?.restatedCells ?? 0) })
      })
      .catch(() => { if (alive) { setRaw([]); setHasData(false); setMeta(null) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [scope, weeks])

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
          {/* The exact range summed, and how many of its days actually carry data. Every weekday in
              this window has the same number of occurrences, so the cells compare like for like. */}
          {meta?.from && meta?.to && (
            <p className="h10-dp-panelrange">
              {meta.weeks} complete week{meta.weeks === 1 ? '' : 's'}: <b>{meta.from}</b> → <b>{meta.to}</b> · today excluded (still in progress) ·{' '}
              {meta.daysWithData} of {meta.weeks * 7} days carry data
              {meta.daysWithData < meta.weeks * 7 * 0.5 && <span className="warn"> — sparse, read with care</span>}
              {/* Disclosed rather than swallowed: these buckets held Amazon retractions that
                  out-weighed the traffic recorded inside this window, so they read as zero. */}
              {meta.restatedCells > 0 && <> · {meta.restatedCells} bucket{meta.restatedCells === 1 ? '' : 's'} floored at zero by Amazon restatements</>}
            </p>
          )}
        </div>
        <div className="h10-dp-panelctl">
          <H10Select width={210} options={scopeOptions} value={scope} onChange={setScope} ariaLabel="Heatmap scope" />
          <H10Select width={140} options={CHART_METRICS} value={metric} onChange={setMetric} ariaLabel="Heatmap metric" />
          <H10Select width={150} options={WINDOWS} value={weeks} onChange={setWeeks} ariaLabel="Heatmap period" />
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
