/**
 * RG.1 — Rank-grid model (pure, framework-free so it's unit-testable).
 *
 * The Rank Plan stores its schedule as `windows: [{days,startHour,endHour,targetKey}]`
 * plus a baseline `defaultTargetKey` ("for the rest of the week, hold Y"). Authoring
 * those windows one-at-a-time in a list is slow. This module is the bridge between
 * that window list and a paintable 7×24 weekly grid (the RankTimeGrid painter):
 *
 *   windows  ──gridFromWindows──▶  grid (7 days × 24 hours, each cell a targetKey or '')
 *   grid     ──compileRankGrid──▶  windows  (runs of the same target → one window)
 *
 * A cell holding '' (BASELINE) means "no window here — the baseline target applies".
 * Compile skips those, so the grid only ever emits the non-baseline windows the
 * engine already understands. The round-trip is stable: compile(gridFromWindows(w))
 * yields the same windows (modulo day-grouping + ordering).
 */

export interface RankWin { days: number[]; startHour: number; endHour: number; targetKey?: string }
export type RankGrid = string[][] // [day 0=Sun..6=Sat][hour 0..23] → targetKey or '' (baseline)

export const BASELINE = '' // a cell with no explicit target → the plan's defaultTargetKey applies

export const emptyRankGrid = (): RankGrid =>
  Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => BASELINE))

/**
 * Grid → windows. Days with an identical 24h profile are merged into one window-set;
 * within a day, a run of the same target becomes one window [startHour, endHour).
 * Baseline ('') runs are skipped (the default covers them). Keys are joined with a
 * separator so multi-char target keys can't collide when fingerprinting a day-row.
 */
export function compileRankGrid(grid: RankGrid): RankWin[] {
  if (!grid || grid.length !== 7) return []
  const groups = new Map<string, number[]>()
  for (let d = 0; d < 7; d++) {
    const fp = grid[d].join('')
    const arr = groups.get(fp)
    if (arr) arr.push(d); else groups.set(fp, [d])
  }
  const windows: RankWin[] = []
  for (const days of groups.values()) {
    const row = grid[days[0]]
    let h = 0
    while (h < 24) {
      const key = row[h]
      if (!key) { h++; continue } // baseline → no window
      let end = h
      while (end < 24 && row[end] === key) end++
      windows.push({ days: [...days].sort((a, b) => a - b), startHour: h, endHour: end, targetKey: key })
      h = end
    }
  }
  // Stable, human-friendly order: by first day, then start hour.
  return windows.sort((a, b) => (a.days[0] - b.days[0]) || (a.startHour - b.startHour))
}

/** Windows → grid. Fill baseline, then stamp each window's target onto its days×hours. */
export function gridFromWindows(windows: RankWin[] | null | undefined): RankGrid {
  const grid = emptyRankGrid()
  for (const w of windows ?? []) {
    if (!w?.targetKey) continue
    const start = Math.max(0, Math.min(24, w.startHour | 0))
    const end = Math.max(0, Math.min(24, w.endHour | 0))
    for (const d of w.days ?? []) {
      if (d < 0 || d > 6) continue
      for (let h = start; h < end && h < 24; h++) grid[d][h] = w.targetKey
    }
  }
  return grid
}

/** Hours painted per target key (for the legend). */
export function rankGridCounts(grid: RankGrid): Record<string, number> {
  const c: Record<string, number> = {}
  for (const row of grid) for (const cell of row) c[cell] = (c[cell] ?? 0) + 1
  return c
}

const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0] // render Mon→Sun
const pad2 = (n: number) => String(n).padStart(2, '0')

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

/**
 * Plain-English summary of the grid, one line per day-group. `name` resolves a
 * targetKey to its display name; `baselineName` labels the untouched hours.
 */
export function describeRankGrid(grid: RankGrid, name: (key: string) => string, baselineName: string): string[] {
  if (!grid || grid.length !== 7) return []
  const groups = new Map<string, number[]>()
  for (let d = 0; d < 7; d++) {
    const fp = grid[d].join('')
    const arr = groups.get(fp); if (arr) arr.push(d); else groups.set(fp, [d])
  }
  const out: string[] = []
  for (const days of groups.values()) {
    const row = grid[days[0]]
    const parts: string[] = []
    let h = 0
    while (h < 24) {
      const key = row[h]
      let end = h
      while (end < 24 && row[end] === key) end++
      if (key) parts.push(`${name(key)} ${pad2(h)}–${pad2(end % 24)}`)
      h = end
    }
    const label = dayGroupLabel(days)
    if (!label) continue
    out.push(`${label}: ${parts.length ? `${parts.join(', ')}, ${baselineName} otherwise` : `${baselineName} all day`}`)
  }
  return out
}

// Target colours — prefer the RankTarget.color from the DB, fall back by key.
const FALLBACK_COLOR: Record<string, string> = {
  'own-top-allout': '#065f46',
  'own-top': '#0a7d48',
  'defend-top': '#2f9e6e',
  'rest-of-search': '#e6b067',
  pause: '#d97757',
}
export const BASELINE_COLOR = '#eef2f6'
export const BASELINE_TEXT = '#64748b'

export function targetColor(t?: { key: string; color?: string | null } | null): string {
  if (t?.color) return t.color
  return (t && FALLBACK_COLOR[t.key]) || '#cbd5e1'
}

// Readable text colour for a swatch background (relative-luminance threshold).
export function textOn(bg: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg.trim())
  if (!m) return '#fff'
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.62 ? '#1e293b' : '#fff'
}
