'use client'

/**
 * Shared full-screen schedule builder (Budget Schedule · Dayparting), pixel-matched to
 * Helium 10 Ads. Top bar (✕ · atom · "Create Budget Schedule" · Learn · Create Schedule) +
 * left scroll-spy nav + a single scrolling pane whose sections are the steps:
 *   Schedule Name · Campaign Section · {Budget} Schedule (type + hourly chart + weekly table) ·
 *   Advanced Settings (start/end/exclude dates).
 * Reuses the rule-builder shell CSS (h10-rb-*) + the campaign-picker styling (cp-*).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { X, Video, Plus, Copy, Trash2, Calendar, BarChart3, LayoutGrid, Search } from 'lucide-react'
import { H10Select, HoverCard } from '../../campaigns/FilterDropdown'
import { CampaignSection, type SchedCampaign } from './CampaignSection'
import { scheduleConfigFor, CHART_METRICS, GROUP_BY, DAYS_OF_WEEK_FILTER, WEEKDAYS, TIME_OPTIONS, adjustmentsFor } from './scheduleConfig'
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

// metric picker with the H10 colour dot (Metric 1 navy, Metric 2 blue).
function MetricSelect({ value, onChange, dot, label }: { value: string; onChange: (v: string) => void; dot: string; label: string }) {
  return (
    <span className="h10-sb-metric">
      <span className="dot" style={{ background: dot }} />
      <H10Select width={150} options={CHART_METRICS} value={value} onChange={onChange} ariaLabel={label} />
    </span>
  )
}

interface SchedWindow { id: number; day: number; start: string; end: string; adj: string; value: string }
let _wid = 1
const seedWindows = (): SchedWindow[] => WEEKDAYS.map((d) => ({ id: _wid++, day: d.idx, start: '', end: '', adj: '', value: '' }))

const todayStr = () => {
  const d = new Date()
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
}

export function ScheduleBuilder({ slug }: { slug: string }) {
  const router = useRouter()
  const scheduleId = useSearchParams().get('scheduleId')
  const isEdit = !!scheduleId
  const cfg = scheduleConfigFor(slug)
  const close = useCallback(() => router.push('/marketing/ads/rules-automation'), [router])

  const [name, setName] = useState('')
  const [selCampaigns, setSelCampaigns] = useState<SchedCampaign[]>([])
  const [type, setType] = useState('campaign-budget')
  // chart prefs
  const [metric1, setMetric1] = useState('Spend')
  const [metric2, setMetric2] = useState('ACoS')
  const [groupBy, setGroupBy] = useState('hour')
  const [daysFilter, setDaysFilter] = useState('all')
  const [chartMode, setChartMode] = useState<'line' | 'grid'>('line')
  // weekly schedule windows (per day; a day can hold multiple time periods)
  const [windows, setWindows] = useState<SchedWindow[]>(() => seedWindows())
  const [selRows, setSelRows] = useState<Set<number>>(new Set())
  // advanced — schedule start & end date
  const [startDate, setStartDate] = useState(() => todayStr())
  const [endDate, setEndDate] = useState('')
  const [neverExpire, setNeverExpire] = useState(true)
  const [excludeDates, setExcludeDates] = useState(false)
  const [creating, setCreating] = useState(false)

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

  const valid = name.trim().length > 0 && selCampaigns.length > 0 &&
    windows.some((w) => w.start && w.end && w.adj && w.value.trim() !== '') &&
    (neverExpire || startDate.trim() !== '')

  const submit = useCallback(async () => {
    if (!valid || creating) return
    setCreating(true)
    try {
      const payload = {
        name: name.trim(), kind: 'budget', type,
        campaigns: selCampaigns.map((c) => ({ id: c.id, name: c.name, marketplace: c.marketplace, adProduct: c.adProduct, dailyBudget: c.dailyBudget })),
        windows: windows.filter((w) => w.start && w.end && w.adj).map((w) => ({ day: w.day, start: w.start, end: w.end, adj: w.adj, value: Number(w.value) || 0 })),
        chartPrefs: { metric1, metric2, groupBy, daysFilter },
        startDate: neverExpire ? null : startDate, endDate: neverExpire ? null : (endDate || null), neverExpire, excludeDates,
      }
      const base = `${getBackendUrl()}/api/advertising/budget-schedules`
      const r = await fetch(isEdit ? `${base}/${scheduleId}` : base, { method: isEdit ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j?.error == null) router.push('/marketing/ads/rules-automation')
    } finally { setCreating(false) }
  }, [valid, creating, name, type, selCampaigns, windows, metric1, metric2, groupBy, daysFilter, startDate, endDate, neverExpire, excludeDates, isEdit, scheduleId, router])

  // render the weekly table grouped by WEEKDAYS order; the day short-label shows on the first window of each day.
  const orderedWindows = useMemo(() => {
    const byDay = new Map<number, SchedWindow[]>()
    for (const w of windows) { if (!byDay.has(w.day)) byDay.set(w.day, []); byDay.get(w.day)!.push(w) }
    return WEEKDAYS.flatMap((d) => (byDay.get(d.idx) ?? []).map((w, i) => ({ w, short: i === 0 ? d.short : '' })))
  }, [windows])

  const adjustments = adjustmentsFor(type)

  return (
    <div className="h10-rb h10-sb">
      <header className="h10-rb-top">
        <div className="l">
          <button type="button" className="x" aria-label="Close" onClick={close}><X size={19} /></button>
          <AtomMark size={20} />
          <b>{isEdit ? cfg.title.replace('Create', 'Edit') : cfg.title}</b>
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
              <h2>Schedule Name</h2>
              <input className="h10-rb-input rn" value={name} onChange={(e) => setName(e.target.value)} placeholder="Enter a budget schedule name" aria-label="Schedule name" />
            </section>

            {/* ── Campaign Section ── */}
            <section id="sb-campaigns" className="h10-rb-sec">
              <h2>Campaign Section</h2>
              <p className="h10-rb-desc">Select the Campaigns and products you want to include</p>
              <CampaignSection selected={selCampaigns} onAdd={addCampaign} onAddMany={addCampaigns} onRemove={removeCampaign} onClear={clearCampaigns} />
            </section>

            {/* ── Budget Schedule ── */}
            <section id="sb-schedule" className="h10-rb-sec">
              <h2>{cfg.sectionTitle}</h2>
              <p className="h10-rb-desc">{cfg.sectionDesc}</p>
              <div className="h10-sb-types">
                {cfg.types.map((t) => (
                  <label key={t.value} className={`h10-sb-type ${type === t.value ? 'on' : ''}`}>
                    <input type="radio" name="schedtype" checked={type === t.value} onChange={() => setType(t.value)} />
                    <span className="b"><span className="t">{t.label}</span><span className="d">{t.desc}</span></span>
                  </label>
                ))}
              </div>

              {/* Hourly Campaign Performance — controls + chart (no-data state until AMS hourly data lands) */}
              <div className="h10-sb-chart">
                <div className="h10-sb-chart-controls">
                  <div className="row1">
                    <div className="f"><label>Metric 1</label><MetricSelect value={metric1} onChange={setMetric1} dot="#0b2447" label="Metric 1" /></div>
                    <div className="f"><label>Metric 2</label><MetricSelect value={metric2} onChange={setMetric2} dot="#1f6fde" label="Metric 2" /></div>
                    <span className="grow" />
                    <div className="h10-sb-chart-toggle" role="group" aria-label="Chart view">
                      <button type="button" className={chartMode === 'line' ? 'on' : ''} aria-pressed={chartMode === 'line'} onClick={() => setChartMode('line')} aria-label="Line chart"><BarChart3 size={16} /></button>
                      <button type="button" className={chartMode === 'grid' ? 'on' : ''} aria-pressed={chartMode === 'grid'} onClick={() => setChartMode('grid')} aria-label="Heatmap"><LayoutGrid size={16} /></button>
                    </div>
                  </div>
                  <div className="row2">
                    <div className="f"><label>Period <HoverCard text="The window of hourly performance data shown in the chart." placement="above"><span className="h10-sb-i" aria-hidden="true">ⓘ</span></HoverCard></label>
                      <span className="h10-sb-date wide"><Calendar size={15} /><input value="04/18/2026 - 06/16/2026" readOnly aria-label="Period" /></span></div>
                    <div className="f"><label>Group By <HoverCard text="Bucket the chart by hour of day or by day of week." placement="above"><span className="h10-sb-i" aria-hidden="true">ⓘ</span></HoverCard></label>
                      <H10Select width={170} options={GROUP_BY} value={groupBy} onChange={setGroupBy} ariaLabel="Group by" /></div>
                    <div className="f"><label>Days of Week Included</label>
                      <H10Select width={170} options={DAYS_OF_WEEK_FILTER} value={daysFilter} onChange={setDaysFilter} ariaLabel="Days of week included" /></div>
                  </div>
                </div>
                <div className="h10-sb-chart-body">
                  <div className="h10-sb-nodata">
                    <span className="ill"><Search size={26} /></span>
                    <span className="t">Hourly data is not available for this marketplace.</span>
                  </div>
                </div>
              </div>

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
                      {w.adj && <span className="h10-sb-adjval"><input inputMode="decimal" value={w.value} onChange={(e) => setWin(w.id, { value: e.target.value })} placeholder={adjustments.find((a) => a.value === w.adj)?.unit === 'mult' ? '1.5' : adjustments.find((a) => a.value === w.adj)?.unit === 'eur' ? '€' : '%'} aria-label="Adjustment value" /></span>}
                    </span>
                    <span className="act">
                      <button type="button" aria-label="Add time period" onClick={() => addWin(w.day)}><Plus size={15} /></button>
                      <button type="button" aria-label="Duplicate" onClick={() => dupWin(w.id)}><Copy size={15} /></button>
                      <button type="button" aria-label="Delete" onClick={() => delWin(w.id)}><Trash2 size={15} /></button>
                    </span>
                  </div>
                ))}
              </div>
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
