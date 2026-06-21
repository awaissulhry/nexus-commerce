'use client'

/**
 * Shared full-screen schedule builder (Budget Schedule · Dayparting), pixel-matched to
 * Helium 10 Ads. Top bar (✕ · atom · "Create Budget Schedule" · Learn · Create Schedule) +
 * left scroll-spy nav + a single scrolling pane whose sections are the steps:
 *   Schedule Name · Campaign Section · {Budget} Schedule (type + hourly chart + weekly table) ·
 *   Advanced Settings (start/end/exclude dates).
 * Reuses the rule-builder shell CSS (h10-rb-*) + the campaign-picker styling (cp-*).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { X, Video, Plus, Copy, Trash2, Calendar, BarChart3, LayoutGrid, Search, Sparkles, Eye, AlertTriangle, CopyPlus } from 'lucide-react'
import { H10Select, HoverCard } from '../../campaigns/FilterDropdown'
import { CampaignSection, type SchedCampaign } from './CampaignSection'
import { MetricSelect } from './MetricSelect'
import { DaypartingHeatmap, type HeatCell, type MetricUnit } from './DaypartingHeatmap'
import { DaypartingChart, type ChartCell } from './DaypartingChart'
import { scheduleConfigFor, GROUP_BY, DAYS_OF_WEEK_FILTER, WEEKDAYS, TIME_OPTIONS, TIMEZONES, adjustmentsFor } from './scheduleConfig'
import { getBackendUrl } from '@/lib/backend-url'

// Adtomic-style atom mark — shared glyph with the rule builder (re-declared to avoid a
// cross-import into the concurrently-edited RuleBuilder.tsx).
function AtomMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="ic">
      <g transform="rotate(45 12 12)"><ellipse cx="12" cy="12" rx="10.4" ry="4.3" stroke="#1f6fde" strokeWidth="1.7" /></g>
      <g transform="rotate(-45 12 12)"><ellipse cx="12" cy="12" rx="10.4" ry="4.3" stroke="#1f6fde" strokeWidth="1.7" /></g>
      <circle cx="12" cy="12" r="2.5" fill="#0b1f44" />
    </svg>
  )
}

// raw aggregated cell from GET /advertising/dayparting/heatmap
interface RawCell { dow: number; hour: number; costCents: number; salesCents: number; orders: number; clicks: number; impressions: number; acos: number | null; roas: number | null }
// metric name → (value from a cell, display unit). Mirrors the H10 "Hourly Campaign Performance" metrics.
const METRIC_VAL: Record<string, { f: (c: RawCell) => number; unit: MetricUnit }> = {
  Spend: { f: (c) => c.costCents / 100, unit: 'eur' },
  Sales: { f: (c) => c.salesCents / 100, unit: 'eur' },
  ACoS: { f: (c) => c.acos ?? 0, unit: 'pct' },
  ROAS: { f: (c) => c.roas ?? 0, unit: 'int' },
  Orders: { f: (c) => c.orders, unit: 'int' },
  Clicks: { f: (c) => c.clicks, unit: 'int' },
  Impressions: { f: (c) => c.impressions, unit: 'int' },
  CPC: { f: (c) => (c.clicks > 0 ? c.costCents / 100 / c.clicks : 0), unit: 'eur' },
  CTR: { f: (c) => (c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0), unit: 'pct' },
  CVR: { f: (c) => (c.clicks > 0 ? (c.orders / c.clicks) * 100 : 0), unit: 'pct' },
  CPA: { f: (c) => (c.orders > 0 ? c.costCents / 100 / c.orders : 0), unit: 'eur' },
}
const metricVal = (m: string) => METRIC_VAL[m] ?? METRIC_VAL.Spend

interface SchedWindow { id: number; day: number; start: string; end: string; adj: string; value: string }
let _wid = 1
const seedWindows = (): SchedWindow[] => WEEKDAYS.map((d) => ({ id: _wid++, day: d.idx, start: '', end: '', adj: '', value: '' }))
const hh = (t: string) => (t ? Number(t.split(':')[0]) : -1)
const hLabel = (h: number) => `${String(h).padStart(2, '0')}:00`

// ── best-in-class helpers (pure) ──
// recommend one Enable window over the peak-performance span + one Pause window over a dead span,
// derived from the last-60-day hourly cells; applied to all 7 days as a tweakable starting point.
function recommendWindows(cells: RawCell[], metric: string): { enable: [number, number] | null; pause: [number, number] | null } {
  if (!cells.length) return { enable: null, pause: null }
  const g = metricVal(metric).f
  const byHour = Array.from({ length: 24 }, () => 0)
  for (const c of cells) byHour[c.hour] += g(c)
  const max = Math.max(...byHour)
  if (max <= 0) return { enable: null, pause: null }
  // peak span = contiguous hours ≥ 45% of peak around the argmax
  const peak = byHour.indexOf(max)
  let lo = peak, hi = peak
  while (lo > 0 && byHour[lo - 1] >= max * 0.45) lo--
  while (hi < 23 && byHour[hi + 1] >= max * 0.45) hi++
  // dead span = longest contiguous run of near-zero hours (≤ 5% of peak)
  let bestLen = 0, bestStart = -1, curStart = -1, curLen = 0
  for (let h = 0; h < 24; h++) {
    if (byHour[h] <= max * 0.05) { if (curStart < 0) curStart = h; curLen++; if (curLen > bestLen) { bestLen = curLen; bestStart = curStart } }
    else { curStart = -1; curLen = 0 }
  }
  return { enable: [lo, hi + 1], pause: bestLen >= 3 ? [bestStart, bestStart + bestLen] : null }
}
// days (idx) whose windows overlap in time
function overlapDays(windows: SchedWindow[]): Set<number> {
  const out = new Set<number>()
  const byDay = new Map<number, SchedWindow[]>()
  for (const w of windows) { if (hh(w.start) < 0 || hh(w.end) < 0) continue; if (!byDay.has(w.day)) byDay.set(w.day, []); byDay.get(w.day)!.push(w) }
  for (const [day, ws] of byDay) {
    const sorted = [...ws].sort((a, b) => hh(a.start) - hh(b.start))
    for (let i = 1; i < sorted.length; i++) if (hh(sorted[i].start) < hh(sorted[i - 1].end)) { out.add(day); break }
  }
  return out
}
// per-day × per-hour net status from the windows: 'enable' | 'pause' | '' (default)
function activeGrid(windows: SchedWindow[]): Record<number, string[]> {
  const grid: Record<number, string[]> = {}
  for (const d of WEEKDAYS) grid[d.idx] = Array.from({ length: 24 }, () => '')
  for (const w of windows) {
    if (!w.adj || hh(w.start) < 0 || hh(w.end) < 0) continue
    for (let h = hh(w.start); h < hh(w.end); h++) if (h >= 0 && h < 24) grid[w.day][h] = w.adj
  }
  return grid
}

const todayStr = () => {
  const d = new Date()
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
}

export function ScheduleBuilder({ slug, modeToggle }: { slug: string; modeToggle?: ReactNode }) {
  const router = useRouter()
  const scheduleId = useSearchParams().get('scheduleId')
  const isEdit = !!scheduleId
  const cfg = scheduleConfigFor(slug)
  const close = useCallback(() => router.push('/marketing/ads/rules-automation'), [router])

  const isDayparting = cfg.kind === 'dayparting'
  const [name, setName] = useState('')
  const [timezone, setTimezone] = useState('Europe/Rome')
  const [selCampaigns, setSelCampaigns] = useState<SchedCampaign[]>([])
  const [type, setType] = useState('campaign-budget')
  // chart prefs
  const [metric1, setMetric1] = useState('Spend')
  const [metric2, setMetric2] = useState('ACoS')
  const [groupBy, setGroupBy] = useState('hour')
  const [daysFilter, setDaysFilter] = useState('all')
  // Dayparting leads with the heatmap (grid); Budget Schedule leads with the line chart.
  const [chartMode, setChartMode] = useState<'line' | 'grid'>(cfg.heatmapDefault ? 'grid' : 'line')
  // hourly-performance cells (fetched per selected campaigns + timezone)
  const [rawCells, setRawCells] = useState<RawCell[]>([])
  const [cellsLoading, setCellsLoading] = useState(false)
  const [cellsHasData, setCellsHasData] = useState(false)
  // weekly schedule windows (per day; a day can hold multiple time periods)
  const [windows, setWindows] = useState<SchedWindow[]>(() => seedWindows())
  const [selRows, setSelRows] = useState<Set<number>>(new Set())
  // advanced — schedule start & end date
  const [startDate, setStartDate] = useState(() => todayStr())
  const [endDate, setEndDate] = useState('')
  const [neverExpire, setNeverExpire] = useState(true)
  const [excludeDates, setExcludeDates] = useState(false)
  const [creating, setCreating] = useState(false)

  // ── edit mode: load a saved dayparting schedule back into the builder ──
  useEffect(() => {
    if (!scheduleId || !isDayparting) return
    let alive = true
    ;(async () => {
      try {
        const j = await fetch(`${getBackendUrl()}/api/advertising/automation-rules/${scheduleId}`).then((r) => r.json())
        const a = (Array.isArray(j?.rule?.actions) ? j.rule.actions[0] : null) ?? {}
        if (!alive || a.type !== 'dayparting-schedule') return
        setName(j.rule.name ?? '')
        if (a.timezone) setTimezone(a.timezone)
        if (Array.isArray(a.campaigns)) setSelCampaigns(a.campaigns.map((c: Record<string, unknown>) => ({ id: String(c.id), name: String(c.name ?? c.id), marketplace: (c.marketplace as string) ?? null, status: 'ENABLED', targetingType: 'MANUAL', adProduct: String(c.adProduct ?? 'SP'), dailyBudget: c.dailyBudget != null ? Number(c.dailyBudget) : null, portfolioId: null })))
        if (Array.isArray(a.windows) && a.windows.length) setWindows(a.windows.map((w: Record<string, unknown>) => ({ id: _wid++, day: Number(w.day) || 0, start: String(w.start ?? ''), end: String(w.end ?? ''), adj: String(w.adj ?? ''), value: w.value != null ? String(w.value) : '' })))
        const cp = a.chartPrefs ?? {}
        if (cp.metric1) setMetric1(cp.metric1); if (cp.metric2) setMetric2(cp.metric2); if (cp.groupBy) setGroupBy(cp.groupBy); if (cp.daysFilter) setDaysFilter(cp.daysFilter)
        if (typeof a.neverExpire === 'boolean') setNeverExpire(a.neverExpire)
        if (a.startDate) setStartDate(a.startDate); if (a.endDate) setEndDate(a.endDate)
        if (typeof a.excludeDates === 'boolean') setExcludeDates(a.excludeDates)
      } catch { /* ignore */ }
    })()
    return () => { alive = false }
  }, [scheduleId, isDayparting])

  // ── edit mode (budget): load a saved budget schedule back into the builder ──
  useEffect(() => {
    if (!scheduleId || isDayparting) return
    let alive = true
    ;(async () => {
      try {
        const j = await fetch(`${getBackendUrl()}/api/advertising/budget-schedules/${scheduleId}`).then((r) => r.json())
        const s = j?.schedule
        if (!alive || !s) return
        const isoToMDY = (v: string) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}` }
        setName(s.name ?? '')
        if (s.type) setType(s.type)
        if (Array.isArray(s.campaigns)) setSelCampaigns(s.campaigns.map((c: Record<string, unknown>) => ({ id: String(c.id), name: String(c.name ?? c.id), marketplace: (c.marketplace as string) ?? null, status: 'ENABLED', targetingType: 'MANUAL', adProduct: String(c.adProduct ?? 'SP'), dailyBudget: c.dailyBudget != null ? Number(c.dailyBudget) : null, portfolioId: null })))
        if (Array.isArray(s.windows) && s.windows.length) setWindows(s.windows.map((w: Record<string, unknown>) => ({ id: _wid++, day: Number(w.day) || 0, start: String(w.start ?? ''), end: String(w.end ?? ''), adj: String(w.adj ?? ''), value: w.value != null ? String(w.value) : '' })))
        const cp = s.chartPrefs ?? {}
        if (cp.metric1) setMetric1(cp.metric1); if (cp.metric2) setMetric2(cp.metric2); if (cp.groupBy) setGroupBy(cp.groupBy); if (cp.daysFilter) setDaysFilter(cp.daysFilter)
        if (typeof s.neverExpire === 'boolean') setNeverExpire(s.neverExpire)
        if (s.startDate) setStartDate(isoToMDY(s.startDate)); if (s.endDate) setEndDate(isoToMDY(s.endDate))
      } catch { /* ignore */ }
    })()
    return () => { alive = false }
  }, [scheduleId, isDayparting])

  // fetch the hourly heatmap when the selected campaigns / timezone change (debounced)
  const campaignKey = selCampaigns.map((c) => c.id).join(',')
  useEffect(() => {
    if (!campaignKey) { setRawCells([]); setCellsHasData(false); return }
    let alive = true
    setCellsLoading(true)
    const t = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ campaignIds: campaignKey, windowDays: '60', tz: timezone })
        const j = await fetch(`${getBackendUrl()}/api/advertising/dayparting/heatmap?${qs}`).then((r) => r.json())
        if (!alive) return
        setRawCells(Array.isArray(j?.cells) ? j.cells : [])
        setCellsHasData(!!j?.hasData)
      } catch { if (alive) { setRawCells([]); setCellsHasData(false) } }
      finally { if (alive) setCellsLoading(false) }
    }, 300)
    return () => { alive = false; clearTimeout(t) }
  }, [campaignKey, timezone])

  // map raw cells → heatmap (single metric) / chart (two metrics)
  const heatCells = useMemo<HeatCell[]>(() => { const g = metricVal(metric1).f; return rawCells.map((c) => ({ dow: c.dow, hour: c.hour, value: g(c) })) }, [rawCells, metric1])
  const chartCells = useMemo<ChartCell[]>(() => { const g1 = metricVal(metric1).f, g2 = metricVal(metric2).f; return rawCells.map((c) => ({ dow: c.dow, hour: c.hour, m1: g1(c), m2: g2(c) })) }, [rawCells, metric1, metric2])

  const addCampaign = (c: SchedCampaign) => setSelCampaigns((cur) => (cur.some((x) => x.id === c.id) ? cur : [...cur, c]))
  const addCampaigns = (cs: SchedCampaign[]) => setSelCampaigns((cur) => { const have = new Set(cur.map((x) => x.id)); return [...cur, ...cs.filter((c) => !have.has(c.id))] })
  const removeCampaign = (id: string) => setSelCampaigns((cur) => cur.filter((c) => c.id !== id))
  const clearCampaigns = () => setSelCampaigns([])

  // weekly table mutations
  const setWin = (id: number, patch: Partial<SchedWindow>) => setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)))
  const addWin = (day: number) => setWindows((ws) => {
    const next = { id: _wid++, day, start: '', end: '', adj: '', value: '' }
    const out: SchedWindow[] = []
    let inserted = false
    for (let i = 0; i < ws.length; i++) {
      out.push(ws[i])
      const last = ws[i].day === day && (i + 1 >= ws.length || ws[i + 1].day !== day)
      if (last && !inserted) { out.push(next); inserted = true }
    }
    if (!inserted) out.push(next)
    return out
  })
  const dupWin = (id: number) => setWindows((ws) => { const w = ws.find((x) => x.id === id); if (!w) return ws; const i = ws.findIndex((x) => x.id === id); const copy = { ...w, id: _wid++ }; return [...ws.slice(0, i + 1), copy, ...ws.slice(i + 1)] })
  const delWin = (id: number) => setWindows((ws) => ws.filter((w) => w.id !== id))
  const toggleRow = (id: number) => setSelRows((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allSelected = windows.length > 0 && selRows.size === windows.length
  const toggleAll = () => setSelRows(allSelected ? new Set() : new Set(windows.map((w) => w.id)))

  // ── best-in-class (dayparting): AI recommend · copy/bulk days · overlap · active-hours preview ──
  const [showPreview, setShowPreview] = useState(false)
  const overlaps = useMemo(() => overlapDays(windows), [windows])
  // apply the heatmap-derived recommendation to all 7 days (Enable peak + Pause dead span)
  const recommend = () => {
    const rec = recommendWindows(rawCells, metric1)
    if (!rec.enable && !rec.pause) return
    const next: SchedWindow[] = []
    for (const d of WEEKDAYS) {
      if (rec.enable) next.push({ id: _wid++, day: d.idx, start: hLabel(rec.enable[0]), end: hLabel(rec.enable[1] % 24), adj: 'enable', value: '' })
      if (rec.pause) next.push({ id: _wid++, day: d.idx, start: hLabel(rec.pause[0]), end: hLabel(rec.pause[1] % 24), adj: 'pause', value: '' })
    }
    setWindows(next); setSelRows(new Set())
  }
  // copy the given row's window settings to every day (one window per day)
  const copyToAllDays = (src: SchedWindow) => {
    if (hh(src.start) < 0 || hh(src.end) < 0 || !src.adj) return
    setWindows(() => WEEKDAYS.map((d) => ({ id: _wid++, day: d.idx, start: src.start, end: src.end, adj: src.adj, value: src.value })))
    setSelRows(new Set())
  }
  const bulkApply = (patch: Partial<SchedWindow>) => { setWindows((ws) => ws.map((w) => (selRows.has(w.id) ? { ...w, ...patch } : w))) }
  const selWins = windows.filter((w) => selRows.has(w.id))

  // scroll-spy nav
  const scrollRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState('name')
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const top = el.scrollTop + 140
      let cur = cfg.nav[0].id
      for (const s of cfg.nav) { const node = document.getElementById(`sb-${s.id}`); if (node && node.offsetTop <= top) cur = s.id }
      setActive(cur)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [cfg.nav])
  const goto = (id: string) => { const node = document.getElementById(`sb-${id}`); const el = scrollRef.current; if (node && el) el.scrollTo({ top: node.offsetTop - 24, behavior: 'smooth' }) }

  const adjustments = adjustmentsFor(cfg.kind, type)
  const adjNeedsValue = (adj: string) => (adjustments.find((a) => a.value === adj)?.unit ?? 'eur') !== 'none'
  const winComplete = (w: SchedWindow) => !!(w.start && w.end && w.adj) && (!adjNeedsValue(w.adj) || w.value.trim() !== '')
  const valid = name.trim().length > 0 && selCampaigns.length > 0 &&
    windows.some(winComplete) &&
    (neverExpire || startDate.trim() !== '')

  const submit = useCallback(async () => {
    if (!valid || creating) return
    setCreating(true)
    try {
      const campaigns = selCampaigns.map((c) => ({ id: c.id, name: c.name, marketplace: c.marketplace, adProduct: c.adProduct, dailyBudget: c.dailyBudget }))
      const wins = windows.filter(winComplete).map((w) => ({ day: w.day, start: w.start, end: w.end, adj: w.adj, value: Number(w.value) || 0 }))
      const dates = { startDate: neverExpire ? null : startDate, endDate: neverExpire ? null : (endDate || null), neverExpire, excludeDates }
      let ok = false
      if (isDayparting) {
        // Dayparting persists through the automation-rules store (trigger SCHEDULE) — starts disabled + dry-run.
        const payload = {
          name: name.trim(), trigger: 'SCHEDULE', conditions: [],
          actions: [{ type: 'dayparting-schedule', timezone, campaigns, windows: wins, chartPrefs: { metric1, metric2, groupBy, daysFilter }, ...dates }],
        }
        const base = `${getBackendUrl()}/api/advertising/automation-rules`
        const r = await fetch(isEdit ? `${base}/${scheduleId}` : base, { method: isEdit ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        const j = await r.json().catch(() => ({})); ok = r.ok && j?.error == null
      } else {
        const payload = { name: name.trim(), kind: 'budget', type, campaigns, windows: wins, chartPrefs: { metric1, metric2, groupBy, daysFilter }, ...dates }
        const base = `${getBackendUrl()}/api/advertising/budget-schedules`
        const r = await fetch(isEdit ? `${base}/${scheduleId}` : base, { method: isEdit ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        const j = await r.json().catch(() => ({})); ok = r.ok && j?.error == null
      }
      if (ok) router.push('/marketing/ads/rules-automation')
    } finally { setCreating(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valid, creating, name, type, isDayparting, timezone, selCampaigns, windows, metric1, metric2, groupBy, daysFilter, startDate, endDate, neverExpire, excludeDates, isEdit, scheduleId, router])

  // render the weekly table grouped by WEEKDAYS order; the day short-label shows on the first window of each day.
  const orderedWindows = useMemo(() => {
    const byDay = new Map<number, SchedWindow[]>()
    for (const w of windows) { if (!byDay.has(w.day)) byDay.set(w.day, []); byDay.get(w.day)!.push(w) }
    return WEEKDAYS.flatMap((d) => (byDay.get(d.idx) ?? []).map((w, i) => ({ w, short: i === 0 ? d.short : '' })))
  }, [windows])

  return (
    <div className="h10-rb h10-sb">
      <header className="h10-rb-top">
        <div className="l">
          <button type="button" className="x" aria-label="Close" onClick={close}><X size={19} /></button>
          <AtomMark size={20} />
          <b>{isEdit ? cfg.title.replace('Create', 'Edit') : cfg.title}</b>
          {modeToggle}
        </div>
        <div className="r">
          <button type="button" className="learn"><Video size={15} /> Learn</button>
          <button type="button" className="h10-rb-create" disabled={!valid || creating} onClick={submit}>{creating ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save Changes' : cfg.createLabel)}</button>
        </div>
      </header>

      <div className="h10-rb-body" ref={scrollRef}>
        <nav className="h10-rb-nav" role="tablist" aria-label="Schedule steps">
          {cfg.nav.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={active === s.id} className={`h10-rb-step ${active === s.id ? 'on' : ''}`} onClick={() => goto(s.id)}>{s.label}</button>
          ))}
        </nav>

        <main className="h10-rb-main">
          <div className="h10-rb-wrap">
            {/* ── Schedule Name ── */}
            <section id="sb-name" className="h10-rb-sec">
              <h2>{isDayparting ? 'Dayparting Schedule Name' : 'Schedule Name'}</h2>
              <input className="h10-rb-input rn" value={name} onChange={(e) => setName(e.target.value)} placeholder={isDayparting ? 'Enter schedule name' : 'Enter a budget schedule name'} aria-label="Schedule name" />
            </section>

            {/* ── Timezone (Dayparting only) ── */}
            {cfg.hasTimezone && (
            <section id="sb-timezone" className="h10-rb-sec">
              <h2>Timezone</h2>
              <p className="h10-rb-desc">Select the timezone for this schedule.</p>
              <H10Select width={430} options={TIMEZONES} value={timezone} onChange={setTimezone} ariaLabel="Timezone" />
            </section>
            )}

            {/* ── Campaign Section ── */}
            <section id="sb-campaigns" className="h10-rb-sec">
              <h2>Campaign Section</h2>
              <p className="h10-rb-desc">Select the Campaigns and products you want to include</p>
              <CampaignSection selected={selCampaigns} onAdd={addCampaign} onAddMany={addCampaigns} onRemove={removeCampaign} onClear={clearCampaigns} />
            </section>

            {/* ── Budget Schedule ── */}
            <section id="sb-schedule" className="h10-rb-sec">
              <h2>{cfg.sectionTitle}{isDayparting && <HoverCard text="The heatmap shows your hourly performance so you can pick the windows to enable or pause each campaign." placement="above"><span className="h10-sb-i" aria-hidden="true"> ⓘ</span></HoverCard>}</h2>
              <p className="h10-rb-desc">{cfg.sectionDesc}</p>
              {cfg.types.length > 0 && (
              <div className="h10-sb-types">
                {cfg.types.map((t) => (
                  <label key={t.value} className={`h10-sb-type ${type === t.value ? 'on' : ''}`}>
                    <input type="radio" name="schedtype" checked={type === t.value} onChange={() => setType(t.value)} />
                    <span className="b"><span className="t">{t.label}</span><span className="d">{t.desc}</span></span>
                  </label>
                ))}
              </div>
              )}

              {/* Hourly Campaign Performance — controls + chart (no-data state until AMS hourly data lands) */}
              <div className="h10-sb-chart">
                <div className="h10-sb-chart-controls">
                  <div className="row1">
                    <div className="f"><label>Metric 1</label><MetricSelect value={metric1} onChange={setMetric1} dot="#0b2447" label="Metric 1" /></div>
                    {chartMode === 'line' && <div className="f"><label>Metric 2</label><MetricSelect value={metric2} onChange={setMetric2} dot="#1f6fde" label="Metric 2" /></div>}
                    <span className="grow" />
                    <div className="h10-sb-chart-toggle" role="group" aria-label="Chart view">
                      <button type="button" className={chartMode === 'line' ? 'on' : ''} aria-pressed={chartMode === 'line'} onClick={() => setChartMode('line')} aria-label="Line chart"><BarChart3 size={16} /></button>
                      <button type="button" className={chartMode === 'grid' ? 'on' : ''} aria-pressed={chartMode === 'grid'} onClick={() => setChartMode('grid')} aria-label="Heatmap"><LayoutGrid size={16} /></button>
                    </div>
                  </div>
                  <div className="row2">
                    <div className="f"><label>Period <HoverCard text="The window of hourly performance data shown in the chart." placement="above"><span className="h10-sb-i" aria-hidden="true">ⓘ</span></HoverCard></label>
                      <span className="h10-sb-date wide"><Calendar size={15} /><input value="04/18/2026 - 06/16/2026" readOnly aria-label="Period" /></span></div>
                    {chartMode === 'line' && <>
                    <div className="f"><label>Group By <HoverCard text="Bucket the chart by hour of day or by day of week." placement="above"><span className="h10-sb-i" aria-hidden="true">ⓘ</span></HoverCard></label>
                      <H10Select width={170} options={GROUP_BY} value={groupBy} onChange={setGroupBy} ariaLabel="Group by" /></div>
                    <div className="f"><label>Days of Week Included</label>
                      <H10Select width={170} options={DAYS_OF_WEEK_FILTER} value={daysFilter} onChange={setDaysFilter} ariaLabel="Days of week included" /></div>
                    </>}
                  </div>
                </div>
                <div className="h10-sb-chart-body">
                  {cellsLoading ? <DaypartingHeatmap cells={[]} loading />
                    : !cellsHasData ? (
                      <div className="h10-sb-nodata">
                        <span className="ill"><Search size={26} /></span>
                        <span className="t">{selCampaigns.length === 0 ? 'Add campaigns to see hourly performance.' : 'Hourly data is not available for this marketplace.'}</span>
                      </div>
                    ) : chartMode === 'grid'
                      ? <DaypartingHeatmap cells={heatCells} unit={metricVal(metric1).unit} />
                      : <DaypartingChart cells={chartCells} metric1={metric1} metric2={metric2} unit1={metricVal(metric1).unit} unit2={metricVal(metric2).unit} groupBy={groupBy as 'hour' | 'weekday'} daysFilter={daysFilter as 'all' | 'weekdays' | 'weekends'} />}
                </div>
              </div>

              {/* best-in-class toolbar (Dayparting): AI recommend · preview · bulk-apply */}
              {isDayparting && (
                <div className="h10-dp-tools">
                  <button type="button" className="h10-dp-aibtn" onClick={recommend} disabled={!cellsHasData} title={cellsHasData ? 'Propose Enable/Pause windows from your last 60 days' : 'Add campaigns with hourly data first'}><Sparkles size={15} /> Recommend Schedule</button>
                  <button type="button" className="h10-dp-toolbtn" onClick={() => setShowPreview((v) => !v)} aria-pressed={showPreview}><Eye size={15} /> {showPreview ? 'Hide' : 'Preview'} active hours</button>
                  {selRows.size > 0 && (
                    <span className="h10-dp-bulk">
                      <b>{selRows.size} selected</b>
                      <button type="button" onClick={() => selWins[0] && copyToAllDays(selWins[0])} disabled={!selWins[0]?.start || !selWins[0]?.end || !selWins[0]?.adj}><CopyPlus size={14} /> Copy to all days</button>
                      <button type="button" onClick={() => bulkApply({ adj: 'enable' })}>Set Enable</button>
                      <button type="button" onClick={() => bulkApply({ adj: 'pause' })}>Set Pause</button>
                      <button type="button" className="x" onClick={() => setSelRows(new Set())}>Clear</button>
                    </span>
                  )}
                </div>
              )}

              {/* weekly schedule table */}
              <div className="h10-sb-week">
                <div className="h10-sb-week-h">
                  <span className="ck"><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all days" /></span>
                  <span className="day">Days</span>
                  <span className="time">Time Period</span>
                  <span className="adj" />
                  <span className="act">Actions</span>
                </div>
                {orderedWindows.map(({ w, short }) => (
                  <div className="h10-sb-week-r" key={w.id}>
                    <span className="ck"><input type="checkbox" checked={selRows.has(w.id)} onChange={() => toggleRow(w.id)} aria-label={`Select ${short || 'row'}`} /></span>
                    <span className="day">{short}</span>
                    <span className="time">
                      <H10Select width={120} options={[{ value: '', label: 'Select time' }, ...TIME_OPTIONS]} value={w.start} onChange={(v) => setWin(w.id, { start: v })} ariaLabel="Start time" />
                      <span className="dash">-</span>
                      <H10Select width={120} options={[{ value: '', label: 'Select time' }, ...TIME_OPTIONS]} value={w.end} onChange={(v) => setWin(w.id, { end: v })} ariaLabel="End time" />
                    </span>
                    <span className="adj">
                      <H10Select width={200} options={[{ value: '', label: 'Select adjustment type' }, ...adjustments]} value={w.adj} onChange={(v) => setWin(w.id, { adj: v })} ariaLabel="Adjustment type" />
                      {w.adj && adjNeedsValue(w.adj) && <span className="h10-sb-adjval"><input inputMode="decimal" value={w.value} onChange={(e) => setWin(w.id, { value: e.target.value })} placeholder={adjustments.find((a) => a.value === w.adj)?.unit === 'mult' ? '1.5' : adjustments.find((a) => a.value === w.adj)?.unit === 'eur' ? '€' : '%'} aria-label="Adjustment value" /></span>}
                    </span>
                    <span className="act">
                      <button type="button" aria-label="Add time period" onClick={() => addWin(w.day)}><Plus size={15} /></button>
                      <button type="button" aria-label="Duplicate" onClick={() => dupWin(w.id)}><Copy size={15} /></button>
                      {isDayparting && <button type="button" aria-label="Copy to all days" title="Copy to all days" onClick={() => copyToAllDays(w)}><CopyPlus size={15} /></button>}
                      <button type="button" aria-label="Delete" onClick={() => delWin(w.id)}><Trash2 size={15} /></button>
                    </span>
                  </div>
                ))}
              </div>

              {/* overlap/conflict detection (Dayparting) */}
              {isDayparting && overlaps.size > 0 && (
                <div className="h10-dp-warn"><AlertTriangle size={15} /> Overlapping time periods on {[...overlaps].map((d) => WEEKDAYS.find((w) => w.idx === d)?.short).join(', ')} — the later window may override the earlier one.</div>
              )}

              {/* active-hours preview (Dayparting) */}
              {isDayparting && showPreview && (() => { const grid = activeGrid(windows); return (
                <div className="h10-dp-preview">
                  <div className="hd">Active hours preview</div>
                  <div className="grid">
                    {WEEKDAYS.map((d) => (
                      <div className="row" key={d.idx}>
                        <span className="lbl">{d.short}</span>
                        {grid[d.idx].map((s, h) => <span key={h} className={`cell ${s}`} title={`${d.short} ${hLabel(h)} — ${s || 'default'}`} />)}
                      </div>
                    ))}
                    <div className="row hours"><span className="lbl" />{Array.from({ length: 24 }, (_, h) => <span key={h} className="hr">{h % 6 === 0 ? (h === 0 ? '12A' : h === 12 ? '12P' : h < 12 ? `${h}A` : `${h - 12}P`) : ''}</span>)}</div>
                  </div>
                  <div className="leg"><span className="sw enable" /> Enable <span className="sw pause" /> Pause <span className="sw" /> Default</div>
                </div>
              ) })()}
            </section>

            {/* ── Advanced Settings ── */}
            <section id="sb-advanced" className="h10-rb-sec">
              <h2>Advanced Settings</h2>
              <div className="h10-rb-card h10-sb-adv">
                <div className="hd"><b>Schedule Start &amp; End Date</b><span>Set the start and end date for this schedule.</span></div>
                <div className="h10-sb-dates">
                  <div className="f"><label>Start Date <i>*</i></label>
                    <span className="h10-sb-date"><Calendar size={15} /><input value={startDate} onChange={(e) => setStartDate(e.target.value)} placeholder="MM/DD/YYYY" aria-label="Start date" /></span></div>
                  <div className="f"><label>End Date</label>
                    <span className={`h10-sb-date ${neverExpire ? 'disabled' : ''}`}><Calendar size={15} /><input value={endDate} onChange={(e) => setEndDate(e.target.value)} placeholder="Enter a Date" disabled={neverExpire} aria-label="End date" /></span></div>
                  <label className="h10-sb-toggle"><button type="button" className={`h10-bktoggle ${neverExpire ? 'on' : ''}`} role="switch" aria-checked={neverExpire} aria-label="Never expire" onClick={() => setNeverExpire((v) => !v)}><span /></button> Never Expire</label>
                  <label className="h10-sb-toggle"><button type="button" className={`h10-bktoggle ${excludeDates ? 'on' : ''}`} role="switch" aria-checked={excludeDates} aria-label="Exclude dates" onClick={() => setExcludeDates((v) => !v)}><span /></button> Exclude Dates</label>
                </div>
              </div>
            </section>

            {/* footer */}
            <div className="h10-rb-foot">
              <button type="button" className="h10-rb-btn ghost" onClick={close}>Cancel</button>
              <span className="grow" />
              <button type="button" className="h10-rb-create" disabled={!valid || creating} onClick={submit}>{creating ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save Changes' : cfg.createLabel)}</button>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
