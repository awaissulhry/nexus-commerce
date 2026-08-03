/**
 * RDX/D1 — turn a set of selected heatmap cells into the smallest set of schedule windows.
 *
 * The grid is 7 days × 24 hours and the operator paints cells; a schedule is expressed as windows
 * of `{ days[], startHour, endHour, targetKey }`. Emitting one window per cell would technically
 * work and be unreadable — 20 painted cells would author 20 windows. This collapses them twice:
 * contiguous hours within a day become one range, then days sharing an identical range are merged
 * into a single window's `days[]`. Mon–Fri 18:00–22:00 is one window, not twenty.
 *
 * **`endHour` is EXCLUSIVE.** The engine tests `hour >= startHour && hour < endHour`
 * (rank-controller.ts `resolveActiveTargetKey`), so selecting hours 18,19,20,21 must produce
 * `{ startHour: 18, endHour: 22 }`. Getting this wrong by one authors a schedule that pushes at the
 * wrong hour — the whole point of the feature.
 *
 * Pure, so the collapsing is unit-tested rather than eyeballed on a grid.
 */

export interface RankWin {
  days: number[]
  startHour: number
  endHour: number
  targetKey?: string
}

/** Cell keys are `${dow}:${hour}` — the same shape the heatmap uses for its selection set. */
export function parseCellKey(key: string): { dow: number; hour: number } | null {
  const [d, h] = key.split(':')
  const dow = Number(d)
  const hour = Number(h)
  if (!Number.isInteger(dow) || !Number.isInteger(hour)) return null
  if (dow < 0 || dow > 6 || hour < 0 || hour > 23) return null
  return { dow, hour }
}

export function selectionToWindows(cells: Iterable<string>, targetKey: string): RankWin[] {
  // dow → sorted, de-duplicated hours
  const byDow = new Map<number, number[]>()
  for (const key of cells) {
    const c = parseCellKey(key)
    if (!c) continue
    const arr = byDow.get(c.dow) ?? []
    if (!arr.includes(c.hour)) arr.push(c.hour)
    byDow.set(c.dow, arr)
  }

  // Per day, collapse contiguous hours into [start, end) ranges.
  const rangesByDow = new Map<number, Array<[number, number]>>()
  for (const [dow, hours] of byDow) {
    hours.sort((a, b) => a - b)
    const ranges: Array<[number, number]> = []
    let start = hours[0]
    let prev = hours[0]
    for (let i = 1; i < hours.length; i++) {
      if (hours[i] === prev + 1) { prev = hours[i]; continue }
      ranges.push([start, prev + 1]) // +1: endHour is exclusive
      start = hours[i]
      prev = hours[i]
    }
    if (hours.length) ranges.push([start, prev + 1])
    rangesByDow.set(dow, ranges)
  }

  // Days that share an identical range collapse into one window's days[].
  const byRange = new Map<string, number[]>()
  for (const [dow, ranges] of rangesByDow) {
    for (const [s, e] of ranges) {
      const k = `${s}-${e}`
      const days = byRange.get(k) ?? []
      days.push(dow)
      byRange.set(k, days)
    }
  }

  const out: RankWin[] = []
  for (const [k, days] of byRange) {
    const [s, e] = k.split('-').map(Number)
    out.push({ days: days.sort((a, b) => a - b), startHour: s, endHour: e, targetKey })
  }
  // Deterministic order: earliest start, then earliest day — so the same selection always
  // produces the same template, and a diff between two templates is meaningful.
  out.sort((a, b) => a.startHour - b.startHour || a.endHour - b.endHour || a.days[0] - b.days[0])
  return out
}

/** Total hours covered — what the UI reports back to the operator before they commit. */
export function selectionHourCount(windows: RankWin[]): number {
  return windows.reduce((n, w) => n + w.days.length * (w.endHour - w.startHour), 0)
}
