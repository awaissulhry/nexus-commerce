'use client'

/**
 * RC2.TR1 — Time × Rank grid editor.
 *
 * A full 7×24 weekly grid where you paint each hour with a rank-aggressiveness
 * level: Max push / Strong / Normal / Light / Pause. Each level maps to a
 * dayparting bid multiplier (Pause = a window gap → campaign paused that hour),
 * compiled into AdSchedule windows (TR3) and applied across the product family.
 *
 * Honest model: "rank for a time" = bid aggressiveness for that time — Amazon's
 * placement % can't time-vary, so the variation rides on the keyword-bid
 * multiplier; the top-of-search IS gauge is the proxy for "are you ranking there".
 *
 * TR1 (this file): the painter + demand seeding. Mapping config (TR2),
 * compile→windows + apply across the family (TR3), auto-paint/presets (TR4).
 */

import { useEffect, useMemo, useRef, useState } from 'react'

export type Level = 'max' | 'strong' | 'normal' | 'light' | 'pause'
export interface LevelDef { k: Level; label: string; mult: number | null; pause?: boolean; color: string; text: string }
export const LEVELS: LevelDef[] = [
  { k: 'max', label: 'Max push', mult: 100, color: '#0a7d48', text: '#fff' },
  { k: 'strong', label: 'Strong', mult: 50, color: '#3aa873', text: '#fff' },
  { k: 'normal', label: 'Normal', mult: 0, color: '#e2e8f0', text: '#334155' },
  { k: 'light', label: 'Light', mult: -40, color: '#e6b067', text: '#5b3d12' },
  { k: 'pause', label: 'Pause', mult: null, pause: true, color: '#d97757', text: '#fff' },
]
export const LEVEL_BY_KEY: Record<Level, LevelDef> = Object.fromEntries(LEVELS.map(l => [l.k, l])) as Record<Level, LevelDef>

interface Bucket { orders: number; units: number; revenueCents: number }
export interface DaypartWindow { days: number[]; startHour: number; endHour: number; bidMultiplierPct?: number }

// Compile the 7×24 grid → AdSchedule.windows. Days with identical 24h profiles
// are merged; Pause hours become gaps (campaign paused outside all windows);
// Normal hours deliver with no multiplier; Max/Strong/Light carry their bid %.
export function compileGrid(grid: Level[][]): DaypartWindow[] {
  const groups = new Map<string, number[]>()
  for (let d = 0; d < 7; d++) { const s = grid[d].join(''); const arr = groups.get(s); if (arr) arr.push(d); else groups.set(s, [d]) }
  const windows: DaypartWindow[] = []
  for (const days of groups.values()) {
    const row = grid[days[0]]
    let h = 0
    while (h < 24) {
      const lv = row[h]
      if (lv === 'pause') { h++; continue }
      let end = h
      while (end < 24 && row[end] === lv) end++
      const mult = LEVEL_BY_KEY[lv].mult
      const win: DaypartWindow = { days: [...days], startHour: h, endHour: end }
      if (mult != null && mult !== 0) win.bidMultiplierPct = mult
      windows.push(win)
      h = end
    }
  }
  // All-pause grid → 0 windows, but the cron reads empty windows as "always on".
  // Emit a never-match sentinel so an all-pause grid is genuinely always paused.
  if (windows.length === 0) return [{ days: [], startHour: 0, endHour: 0 }]
  return windows
}

const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0] // render Mon→Sun; grid is indexed by real dow (0=Sun)
const pad2 = (n: number) => String(n).padStart(2, '0')

// DD5 — a readable day-set label ("Mon–Fri", "Sat, Sun", "Every day").
function dayGroupLabel(days: number[]): string {
  const present = DOW_ORDER.filter(d => days.includes(d))
  if (present.length === 7) return 'Every day'
  if (present.length === 0) return ''
  const idx = present.map(d => DOW_ORDER.indexOf(d))
  const runs: string[] = []
  let i = 0
  while (i < idx.length) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++
    runs.push(i === j ? DOW_LABEL[DOW_ORDER[idx[i]]] : `${DOW_LABEL[DOW_ORDER[idx[i]]]}–${DOW_LABEL[DOW_ORDER[idx[j]]]}`)
    i = j + 1
  }
  return runs.join(', ')
}

// DD5 — plain-English summary of the grid, per day-group.
export function describeGrid(grid: Level[][]): string[] {
  const groups = new Map<string, number[]>()
  for (let d = 0; d < 7; d++) { const s = grid[d].join(''); const arr = groups.get(s); if (arr) arr.push(d); else groups.set(s, [d]) }
  const out: string[] = []
  for (const days of groups.values()) {
    const row = grid[days[0]]
    const parts: string[] = []
    let h = 0
    while (h < 24) {
      const lv = row[h]
      let end = h
      while (end < 24 && row[end] === lv) end++
      if (lv !== 'normal') parts.push(`${LEVEL_BY_KEY[lv].label} ${pad2(h)}–${pad2(end % 24)}`)
      h = end
    }
    out.push(`${dayGroupLabel(days)}: ${parts.length ? parts.join(', ') + ', Normal otherwise' : 'Normal all day'}`)
  }
  return out
}
const emptyGrid = (): Level[][] => Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 'normal' as Level))

// Seed levels from the family's day×hour demand grid (revenue per cell).
export function seedFromDemand(grid: Bucket[][] | null | undefined): Level[][] {
  if (!grid || grid.length !== 7) return emptyGrid()
  const cells = grid.flat()
  const revs = cells.map(c => c?.revenueCents ?? 0)
  const mean = revs.reduce((a, b) => a + b, 0) / (revs.length || 1)
  const max = Math.max(1, ...revs)
  return Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => {
    const r = grid[d]?.[h]?.revenueCents ?? 0
    if (r < max * 0.05) return 'pause'
    const ratio = mean > 0 ? r / mean : 1
    if (ratio >= 1.6) return 'max'
    if (ratio >= 1.15) return 'strong'
    if (ratio >= 0.55) return 'normal'
    return 'light'
  }))
}

// S2 — controlled component: the cockpit owns the grid (one source of truth for
// the guided set-up, the editor and Apply). All edits go through onChange.
export function TimeRankGrid({ grid, onChange, demandGrid }: { grid: Level[][]; onChange: (grid: Level[][]) => void; demandGrid: Bucket[][] | null }) {
  const [brush, setBrush] = useState<Level>('max')
  const painting = useRef(false)

  // Global mouseup ends a paint stroke.
  useEffect(() => {
    const up = () => { painting.current = false }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  // TR6 — keyboard: number keys 1–5 pick the brush (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      const n = parseInt(e.key, 10)
      if (n >= 1 && n <= LEVELS.length) setBrush(LEVELS[n - 1].k)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const mutate = (fn: (g: Level[][]) => Level[][]) => onChange(fn(grid))
  const paint = (d: number, h: number) => { if (grid[d][h] === brush) return; mutate(g => { const next = g.map(r => r.slice()); next[d][h] = brush; return next }) }
  const paintRow = (d: number) => mutate(g => { const next = g.map(r => r.slice()); next[d] = next[d].map(() => brush); return next })
  const paintCol = (h: number) => mutate(g => g.map(r => { const nr = r.slice(); nr[h] = brush; return nr }))
  const fillAll = () => mutate(g => g.map(r => r.map(() => brush)))
  const reseed = () => onChange(seedFromDemand(demandGrid))
  // TR4 — presets (compose over the current grid).
  const pPauseNight = () => mutate(g => g.map(r => r.map((c, h) => (h < 7 ? 'pause' : c))))
  const pPushEvenings = () => mutate(g => g.map(r => r.map((c, h) => (h >= 17 && h < 23 ? 'max' : c))))
  const pWeekendsLight = () => mutate(g => g.map((r, d) => (d === 0 || d === 6 ? r.map(() => 'light') : r)))
  // TR6 — copy Monday's profile + save/load a reusable template (localStorage).
  const copyMonWeekdays = () => mutate(g => g.map((r, d) => (d >= 2 && d <= 5 ? g[1].slice() : r)))
  const copyMonEveryday = () => mutate(g => g.map(() => g[1].slice()))
  const TPL_KEY = 'ads:trgrid:template:v1'
  const saveTpl = () => { try { localStorage.setItem(TPL_KEY, JSON.stringify(grid)) } catch { /* ignore */ } }
  const loadTpl = () => { try { const s = localStorage.getItem(TPL_KEY); if (s) onChange(JSON.parse(s) as Level[][]) } catch { /* ignore */ } }

  const counts = useMemo(() => {
    const c: Record<Level, number> = { max: 0, strong: 0, normal: 0, light: 0, pause: 0 }
    for (const row of grid) for (const cell of row) c[cell]++
    return c
  }, [grid])
  // DD3 — demand overlay scaling (the bar at the bottom of each cell).
  const maxRev = useMemo(() => (demandGrid ? Math.max(1, ...demandGrid.flat().map(c => c?.revenueCents ?? 0)) : 1), [demandGrid])
  // DD5 — plain-English summary of the current grid.
  const summary = useMemo(() => describeGrid(grid), [grid])

  // TR2 — what share of the family's demand falls under each painted level.
  // The honest preview (no AMS hourly ad-spend yet): are you pushing where it
  // sells, and are your pauses costing real revenue?
  const coverage = useMemo(() => {
    if (!demandGrid || demandGrid.length !== 7) return null
    const total = demandGrid.flat().reduce((s, c) => s + (c?.revenueCents ?? 0), 0)
    if (total <= 0) return null
    const by: Record<Level, number> = { max: 0, strong: 0, normal: 0, light: 0, pause: 0 }
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) by[grid[d][h]] += demandGrid[d]?.[h]?.revenueCents ?? 0
    const pct = Object.fromEntries(LEVELS.map(l => [l.k, Math.round((by[l.k] / total) * 100)])) as Record<Level, number>
    return { pct, pushShare: pct.max + pct.strong }
  }, [grid, demandGrid])

  return (
    <div className="az-trgrid">
      <div className="az-trgrid-bar">
        <span className="lbl">Paint:</span>
        {LEVELS.map(l => (
          <button key={l.k} type="button" className={`az-tr-swatch ${brush === l.k ? 'on' : ''}`} style={{ background: l.color, color: l.text }} onClick={() => setBrush(l.k)}>{l.label}</button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" className="az-tr-mini" onClick={fillAll}>Fill all</button>
        <button type="button" className="az-tr-mini" onClick={reseed} title="Auto-paint from the family's demand">Auto-paint from demand</button>
      </div>
      <div className="az-trgrid-bar">
        <span className="lbl">Presets:</span>
        <button type="button" className="az-tr-mini" onClick={pPauseNight} title="Pause 00:00–07:00 every day">Pause overnight</button>
        <button type="button" className="az-tr-mini" onClick={pPushEvenings} title="Max push 17:00–23:00 every day">Push evenings</button>
        <button type="button" className="az-tr-mini" onClick={pWeekendsLight} title="Ease off Saturday &amp; Sunday">Weekends light</button>
        <span style={{ flex: 1 }} />
        <button type="button" className="az-tr-mini" onClick={copyMonWeekdays} title="Copy Monday to Tue–Fri">Mon→weekdays</button>
        <button type="button" className="az-tr-mini" onClick={copyMonEveryday} title="Copy Monday to every day">Mon→all</button>
        <button type="button" className="az-tr-mini" onClick={saveTpl} title="Save this grid as a reusable template">Save</button>
        <button type="button" className="az-tr-mini" onClick={loadTpl} title="Load your saved template">Load</button>
      </div>

      <div className="az-trgrid-table" role="group" aria-label="Weekly time × rank grid, 7 days by 24 hours. Press 1–5 to pick a level, then click or drag to paint." onMouseLeave={() => { painting.current = false }}>
        <div className="az-tr-hrow">
          <div className="az-tr-corner" />
          {Array.from({ length: 24 }, (_, h) => <div key={h} className="az-tr-hh">{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</div>)}
        </div>
        {DOW_ORDER.map(d => (
          <div key={d} className="az-tr-drow">
            <button type="button" className="az-tr-dlbl" onClick={() => paintRow(d)} title={`Paint all of ${DOW_LABEL[d]}`}>{DOW_LABEL[d]}</button>
            {Array.from({ length: 24 }, (_, h) => {
              const lv = grid[d][h]
              const def = LEVEL_BY_KEY[lv]
              const rev = demandGrid?.[d]?.[h]?.revenueCents ?? 0
              return (
                <div
                  key={h}
                  className="az-tr-cell"
                  style={{ background: def.color }}
                  title={`${DOW_LABEL[d]} ${String(h).padStart(2, '0')}:00 — ${def.label}${demandGrid ? ` · ${demandGrid[d]?.[h]?.orders ?? 0} orders` : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); painting.current = true; paint(d, h) }}
                  onMouseEnter={() => { if (painting.current) paint(d, h) }}
                  onClick={() => paint(d, h)}
                >
                  {demandGrid && rev > 0 && <span className="dmd" style={{ height: `${Math.min(100, (rev / maxRev) * 100)}%` }} />}
                </div>
              )
            })}
          </div>
        ))}
        <div className="az-tr-hrow foot">
          <div className="az-tr-corner" />
          {Array.from({ length: 24 }, (_, h) => <button key={h} type="button" className="az-tr-collbl" onClick={() => paintCol(h)} title={`Paint ${String(h).padStart(2, '0')}:00 across the week`}>{h % 3 === 0 ? '↥' : ''}</button>)}
        </div>
      </div>

      <div className="az-trgrid-legend">
        {LEVELS.map(l => counts[l.k] > 0 && (
          <span key={l.k} className="it"><i style={{ background: l.color }} />{l.label} {counts[l.k]}h{l.mult != null && l.mult !== 0 ? ` (${l.mult > 0 ? '+' : ''}${l.mult}%)` : ''}{l.pause ? '' : ''}</span>
        ))}
        <span style={{ flex: 1 }} />
        <span className="hint">Cell colour = your rank · bar at the bottom = sales then (taller = more) · keys 1–5 pick a level · drag to paint</span>
      </div>

      {coverage && (
        <div className="az-tr-preview">
          <span className="t">Demand covered</span>
          {LEVELS.map(l => coverage.pct[l.k] > 0 && <span key={l.k} className="it"><i style={{ background: l.color }} />{l.label} {coverage.pct[l.k]}%</span>)}
          {coverage.pushShare > 0 && <span className="ok">Pushing on {coverage.pushShare}% of sales</span>}
          {coverage.pct.pause >= 8 && <span className="warn">Pausing hours that carry {coverage.pct.pause}% of sales — use Light to ease off instead of stopping</span>}
        </div>
      )}

      {summary.length > 0 && (
        <div className="az-tr-summary">
          <span className="t">In plain English</span>
          {summary.map((s, i) => <div key={i} className="line">{s}</div>)}
        </div>
      )}
    </div>
  )
}
