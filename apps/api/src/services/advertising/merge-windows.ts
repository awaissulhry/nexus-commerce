/**
 * RDX/D2 — add painted hours to an EXISTING schedule, without overwriting the plan that is there.
 *
 * D1 gave the page heatmap a template handoff: paint the hours that sell, save them as a template.
 * Applying that template (`apply-template`, also F2's bulk path) sets `windows: tpl.windows` — it
 * REPLACES the plan wholesale. That is correct for "use this shape", and useless for "also push in
 * these three evening hours": a schedule with 92 windows would be reduced to the 3 just painted.
 *
 * PREPEND, DON'T REWRITE
 * The merge prepends the painted windows and touches nothing else, because `resolveActiveWindow`
 * returns the FIRST window covering an hour — so prepending is exactly "these win where they
 * overlap", which is the operator's intent when they paint over existing coverage.
 *
 * The tidier-looking alternative — rebuild the 168-cell grid and re-collapse it to minimal windows
 * — was rejected. `ScheduleWindow` also carries `bidMultiplierPct`, which CLASSIC (non-goal-mode)
 * dayparting schedules run on; a collapse keyed on `targetKey` would silently discard it and
 * change what those schedules do. Prepending cannot lose a field it never reads, and it stays
 * reversible: removing the prepended entries restores the previous plan exactly.
 *
 * The cost is a longer array with windows that may now be shadowed. That is a cosmetic cost paid
 * to keep a live plan non-destructively editable, and the diff below is computed from the engine's
 * own resolver, so what the operator is shown is the real before/after regardless of how the
 * windows are stored.
 */
import { resolveActiveTargetKey } from './rank-controller.js'
import type { ScheduleWindow } from './rank-controller.js'

export interface CellChange {
  dow: number
  hour: number
  from: string | null
  to: string | null
}

export interface MergeDiff {
  /** hours that had no governing target and now have one */
  addedHours: number
  /** hours that had a target and now resolve to a DIFFERENT one */
  retargetedHours: number
  unchangedHours: number
  changed: CellChange[]
  /** net hours per target across the week, gained and lost, biggest movement first */
  byTarget: Array<{ key: string; gained: number; lost: number; net: number }>
}

export interface MergeResult {
  windows: ScheduleWindow[]
  diff: MergeDiff
}

/** A painted window is only meaningful if it names a target and covers at least one hour. */
export function isUsableWindow(w: unknown): w is ScheduleWindow {
  const x = w as ScheduleWindow | null
  if (!x || typeof x !== 'object' || !x.targetKey) return false
  const start = x.startHour ?? 0
  const end = x.endHour ?? 24
  return Number.isFinite(start) && Number.isFinite(end) && end > start && start >= 0 && end <= 24
}

/**
 * Prepend `painted` to `existing` and describe what changes across the 168 hours of a week.
 * `baseline` is the group's defaultTargetKey — an hour no window covers still resolves to it, so
 * leaving it out would report every baseline hour as a change.
 */
export function mergeWindows(
  existing: ScheduleWindow[] | null | undefined,
  painted: ScheduleWindow[] | null | undefined,
  baseline: string | null | undefined,
): MergeResult {
  const add = (painted ?? []).filter(isUsableWindow)
  const base = (existing ?? []).filter((w) => !!w && typeof w === 'object')
  const merged = [...add, ...base]

  const changed: CellChange[] = []
  const gained = new Map<string, number>()
  const lost = new Map<string, number>()
  let addedHours = 0, retargetedHours = 0, unchangedHours = 0

  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      const from = resolveActiveTargetKey(base, baseline, dow, hour)
      const to = resolveActiveTargetKey(merged, baseline, dow, hour)
      if (from === to) { unchangedHours++; continue }
      changed.push({ dow, hour, from, to })
      if (from == null) addedHours++
      else { retargetedHours++; lost.set(from, (lost.get(from) ?? 0) + 1) }
      if (to != null) gained.set(to, (gained.get(to) ?? 0) + 1)
    }
  }

  const keys = new Set([...gained.keys(), ...lost.keys()])
  const byTarget = [...keys]
    .map((key) => {
      const g = gained.get(key) ?? 0
      const l = lost.get(key) ?? 0
      return { key, gained: g, lost: l, net: g - l }
    })
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || b.gained - a.gained)

  return { windows: merged, diff: { addedHours, retargetedHours, unchangedHours, changed, byTarget } }
}
