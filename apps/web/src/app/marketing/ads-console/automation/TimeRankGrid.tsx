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
const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0] // render Mon→Sun; grid is indexed by real dow (0=Sun)
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

export function TimeRankGrid({ demandGrid, onChange }: { demandGrid: Bucket[][] | null; onChange?: (grid: Level[][]) => void }) {
  const [grid, setGrid] = useState<Level[][]>(emptyGrid)
  const [brush, setBrush] = useState<Level>('max')
  const [userEdited, setUserEdited] = useState(false)
  const painting = useRef(false)

  // Seed from demand once it arrives (until the operator paints).
  useEffect(() => {
    if (!userEdited && demandGrid) setGrid(seedFromDemand(demandGrid))
  }, [demandGrid, userEdited])

  useEffect(() => { onChange?.(grid) }, [grid]) // eslint-disable-line react-hooks/exhaustive-deps

  // Global mouseup ends a paint stroke.
  useEffect(() => {
    const up = () => { painting.current = false }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  const paint = (d: number, h: number) => {
    setUserEdited(true)
    setGrid(g => { if (g[d][h] === brush) return g; const next = g.map(r => r.slice()); next[d][h] = brush; return next })
  }
  const paintRow = (d: number) => { setUserEdited(true); setGrid(g => { const next = g.map(r => r.slice()); next[d] = next[d].map(() => brush); return next }) }
  const paintCol = (h: number) => { setUserEdited(true); setGrid(g => g.map(r => { const nr = r.slice(); nr[h] = brush; return nr })) }
  const fillAll = () => { setUserEdited(true); setGrid(g => g.map(r => r.map(() => brush))) }
  const reseed = () => { setUserEdited(false); setGrid(seedFromDemand(demandGrid)) }

  const counts = useMemo(() => {
    const c: Record<Level, number> = { max: 0, strong: 0, normal: 0, light: 0, pause: 0 }
    for (const row of grid) for (const cell of row) c[cell]++
    return c
  }, [grid])

  return (
    <div className="az-trgrid">
      <div className="az-trgrid-bar">
        <span className="lbl">Paint:</span>
        {LEVELS.map(l => (
          <button key={l.k} type="button" className={`az-tr-swatch ${brush === l.k ? 'on' : ''}`} style={{ background: l.color, color: l.text }} onClick={() => setBrush(l.k)}>{l.label}</button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" className="az-tr-mini" onClick={fillAll}>Fill all</button>
        <button type="button" className="az-tr-mini" onClick={reseed} title="Reset to the demand-suggested grid">Reset to demand</button>
      </div>

      <div className="az-trgrid-table" onMouseLeave={() => { painting.current = false }}>
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
              return (
                <div
                  key={h}
                  className="az-tr-cell"
                  style={{ background: def.color }}
                  title={`${DOW_LABEL[d]} ${String(h).padStart(2, '0')}:00 — ${def.label}`}
                  onMouseDown={(e) => { e.preventDefault(); painting.current = true; paint(d, h) }}
                  onMouseEnter={() => { if (painting.current) paint(d, h) }}
                  onClick={() => paint(d, h)}
                />
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
        <span className="hint">Click or drag to paint · day/hour headers paint a whole row/column</span>
      </div>
    </div>
  )
}
