'use client'

/**
 * RG.2 — RankTimeGrid: a 7×24 weekly painter for Rank Plan windows.
 *
 * Same paint-on-grid UX as the dayparting TimeRankGrid, retargeted to RANK GOALS:
 * each swatch is a RankTarget (Own Top / Defend Top / Rest of Search / Pause …) plus
 * a neutral "Baseline" that clears a cell back to the plan default. Pick a swatch
 * (or press 1–N), then click/drag across the week. Day labels paint a whole day;
 * the foot buttons paint a whole hour-column.
 *
 * Controlled on `windows` (the parent owns the single source of truth): the grid is
 * derived via gridFromWindows and every edit compiles straight back to windows via
 * compileRankGrid — so the List view, Save/Discard dirty-tracking and the cron all
 * keep reading the exact same shape they already understand.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  compileRankGrid, gridFromWindows, rankGridCounts, describeRankGrid,
  targetColor, textOn, BASELINE, BASELINE_COLOR, BASELINE_TEXT,
  type RankWin, type RankGrid,
} from './rank-grid-model'

interface RankTarget { id: string; key: string; name: string; color: string | null; pause?: boolean; allOut?: boolean }
interface DemandCell { revenueCents: number; orders: number }

const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0] // render Mon→Sun; grid indexed by real dow (0=Sun)

export function RankTimeGrid({ windows, onWindowsChange, targets, baselineKey, demandGrid, onUseDemandPeaks, onEditTargets, onOpenTemplates }: {
  windows: RankWin[]
  onWindowsChange: (w: RankWin[]) => void
  targets: RankTarget[]
  baselineKey: string
  demandGrid: DemandCell[][] | null
  onUseDemandPeaks?: () => void
  onEditTargets?: () => void
  onOpenTemplates?: () => void
}) {
  const grid = useMemo(() => gridFromWindows(windows), [windows])

  // Palette: Baseline first (clears to default), then each rank target.
  const palette = useMemo(() => [
    { key: BASELINE, name: baselineKey ? `Baseline · ${targets.find(t => t.key === baselineKey)?.name ?? 'default'}` : 'Baseline', color: BASELINE_COLOR, text: BASELINE_TEXT },
    ...targets.map(t => { const c = targetColor(t); return { key: t.key, name: t.name, color: c, text: textOn(c) } }),
  ], [targets, baselineKey])
  const colorOf = useMemo(() => Object.fromEntries(palette.map(p => [p.key, p])) as Record<string, { color: string; text: string; name: string }>, [palette])

  const [brush, setBrush] = useState<string>('')
  // Default the brush to the first real target ONCE when targets load. Guarding on a
  // ref (not on the brush value) so picking Baseline — whose key is '' (falsy) — sticks
  // instead of being read as "uninitialised" and snapped back to a target.
  const brushInit = useRef(false)
  useEffect(() => {
    if (brushInit.current || !targets.length) return
    brushInit.current = true
    setBrush(targets[0].key)
  }, [targets])

  const painting = useRef(false)
  useEffect(() => {
    const up = () => { painting.current = false }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])
  // Keyboard 1..N picks the brush (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      const n = parseInt(e.key, 10)
      if (n >= 1 && n <= palette.length) setBrush(palette[n - 1].key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [palette])

  const mutate = (fn: (g: RankGrid) => RankGrid) => onWindowsChange(compileRankGrid(fn(grid)))
  const paint = (d: number, h: number) => { if (grid[d][h] === brush) return; mutate(g => { const n = g.map(r => r.slice()); n[d][h] = brush; return n }) }
  const paintRow = (d: number) => mutate(g => { const n = g.map(r => r.slice()); n[d] = n[d].map(() => brush); return n })
  const paintCol = (h: number) => mutate(g => g.map(r => { const nr = r.slice(); nr[h] = brush; return nr }))
  const fillAll = () => mutate(g => g.map(r => r.map(() => brush)))
  const clearAll = () => onWindowsChange([])
  const copyMonWeekdays = () => mutate(g => g.map((r, d) => (d >= 2 && d <= 5 ? g[1].slice() : r)))
  const copyMonEveryday = () => mutate(g => g.map(() => g[1].slice()))


  const nameOf = (k: string) => targets.find(t => t.key === k)?.name ?? k
  const counts = useMemo(() => rankGridCounts(grid), [grid])
  const maxRev = useMemo(() => (demandGrid ? Math.max(1, ...demandGrid.flat().map(c => c?.revenueCents ?? 0)) : 1), [demandGrid])
  const summary = useMemo(() => describeRankGrid(grid, nameOf, palette[0].name), [grid, palette]) // eslint-disable-line react-hooks/exhaustive-deps

  if (targets.length === 0) return <div className="az-rp-empty">Loading rank targets…</div>

  return (
    <div className="az-trgrid">
      <div className="az-trgrid-bar">
        <span className="lbl">Paint:</span>
        {palette.map(p => (
          <button key={p.key || 'baseline'} type="button" className={`az-tr-swatch ${brush === p.key ? 'on' : ''}`} style={{ background: p.color, color: p.text }} onClick={() => setBrush(p.key)} title={p.key === BASELINE ? 'Clear back to the baseline (no window)' : `Hold ${p.name} during painted hours`}>{p.name}</button>
        ))}
        <span style={{ flex: 1 }} />
        {onEditTargets && <button type="button" className="az-tr-mini" onClick={onEditTargets} title="Customize what each colour does (placement %, bids), or add your own">✎ Edit targets</button>}
        {onUseDemandPeaks && <button type="button" className="az-tr-mini" onClick={onUseDemandPeaks} title="Auto-paint the recommended rank windows from where the family actually sells">✨ Use demand peaks</button>}
        <button type="button" className="az-tr-mini" onClick={fillAll} title="Fill the whole week with the current brush">Fill all</button>
        <button type="button" className="az-tr-mini" onClick={clearAll} title="Clear every window back to baseline">Clear</button>
      </div>
      <div className="az-trgrid-bar">
        <span className="lbl">Bulk:</span>
        <button type="button" className="az-tr-mini" onClick={copyMonWeekdays} title="Copy Monday's row to Tue–Fri">Mon→weekdays</button>
        <button type="button" className="az-tr-mini" onClick={copyMonEveryday} title="Copy Monday's row to every day">Mon→all</button>
        <span style={{ flex: 1 }} />
        {onOpenTemplates && <button type="button" className="az-tr-mini" onClick={onOpenTemplates} title="Save / load named schedule templates (reusable across products & campaigns)">Templates…</button>}
      </div>

      <div className="az-trgrid-table" role="group" aria-label="Weekly rank schedule grid, 7 days by 24 hours. Press 1 to clear, 2 onward to pick a rank target, then click or drag to paint." onMouseLeave={() => { painting.current = false }}>
        <div className="az-tr-hrow">
          <div className="az-tr-corner" />
          {Array.from({ length: 24 }, (_, h) => <div key={h} className="az-tr-hh">{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</div>)}
        </div>
        {DOW_ORDER.map(d => (
          <div key={d} className="az-tr-drow">
            <button type="button" className="az-tr-dlbl" onClick={() => paintRow(d)} title={`Paint all of ${DOW_LABEL[d]}`}>{DOW_LABEL[d]}</button>
            {Array.from({ length: 24 }, (_, h) => {
              const key = grid[d][h]
              const def = colorOf[key] ?? { color: BASELINE_COLOR, text: BASELINE_TEXT, name: 'Baseline' }
              const rev = demandGrid?.[d]?.[h]?.revenueCents ?? 0
              return (
                <div
                  key={h}
                  className="az-tr-cell"
                  style={{ background: def.color }}
                  title={`${DOW_LABEL[d]} ${String(h).padStart(2, '0')}:00 — ${def.name}${demandGrid ? ` · ${demandGrid[d]?.[h]?.orders ?? 0} orders` : ''}`}
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
        {palette.map(p => (counts[p.key] ?? 0) > 0 && (
          <span key={p.key || 'baseline'} className="it"><i style={{ background: p.color }} />{p.name} {counts[p.key]}h</span>
        ))}
        <span style={{ flex: 1 }} />
        <span className="hint">Cell colour = the rank you hold · bar = where it sells · keys 1–{palette.length} pick a brush · drag to paint</span>
      </div>

      {summary.length > 0 && (
        <div className="az-tr-summary">
          <span className="t">In plain English</span>
          {summary.map((s, i) => <div key={i} className="line">{s}</div>)}
        </div>
      )}
    </div>
  )
}
