/**
 * RDX/E1 — "what will this schedule do to my bids in the next 24 hours", answered before it is
 * armed rather than reconstructed afterwards from the activity trail.
 *
 * The gap this closes: arming a plan commits to an engine that writes to Amazon every 15 minutes,
 * and until now the only thing in front of the operator at that moment was the painted grid. The
 * grid shows which HOURS are covered; it does not show what each hour's target actually does to a
 * bid, and it certainly does not show where the bid can climb to. Two schedules that look identical
 * on the grid can differ by a factor of nine in what they are permitted to spend.
 *
 * Everything here is derived from the same two functions the live loop uses — `resolveActiveWindow`
 * for coverage and `biasBand` for the floor/ceiling — so the preview cannot say one thing while the
 * engine does another. This module is pure: the caller supplies the 24 already-resolved local
 * (dow, hour) slots, because deriving those is a timezone question for the database, not arithmetic
 * to be re-invented per call site.
 */
import { resolveActiveWindow, biasBand } from './rank-controller.js'
import type { ScheduleWindow } from './rank-controller.js'

/** One hour of wall-clock, already converted to the schedule's timezone by the caller. */
export interface Next24Slot {
  at: string // ISO instant the hour begins
  dow: number // 0 = Sunday, matching ScheduleWindow.days
  hour: number // 0-23 local
  /**
   * RDX/G2 — the plan that governs THIS hour, when a dated event overrides the weekly one.
   *
   * ad-rank-defend.job.ts swaps the whole plan for an enabled event covering the moment
   * (`planWindows = ev ? ev.windows : s.windows`). A preview that read only the weekly plan would
   * therefore show one thing while the engine did another for the entire span of an armed event —
   * the precise failure E1 exists to prevent. Resolved per hour rather than once, because an
   * event can begin or end partway through the next 24 hours, and the hand-over is exactly the
   * moment worth seeing.
   */
  plan?: { windows: ScheduleWindow[] | null; defaultTargetKey: string | null; eventName: string }
}

/** The fields of a RankTarget this preview reads. Narrowed so tests need no DB row. */
export interface Next24Target {
  key: string
  name: string
  color?: string | null
  biasPct?: number | null
  maxBiasPct?: number | null
  maxCpcCents?: number | null
  acosCapPct?: number | null
  allOut?: boolean
  pause?: boolean
}

export interface Next24Row {
  at: string
  dow: number
  hour: number
  targetKey: string | null
  targetName: string | null
  color: string | null
  /** where this hour's target came from — a painted window, the schedule baseline, or nothing */
  source: 'window' | 'baseline' | 'none'
  /** the dated event governing this hour in place of the weekly plan, if any */
  eventName: string | null
  /** the bias the loop holds in this hour (Placement %) */
  floorPct: number | null
  /** the highest bias the loop may reach in this hour */
  ceilingPct: number | null
  /** ceiling > floor (or all-out): the bid can move UP during the hour, not just sit at the floor */
  canChase: boolean
  maxCpcCents: number | null
  acosCapPct: number | null
  allOut: boolean
  /**
   * NP — a "pause" target does NOT pause delivery. ad-rank-defend.job.ts floors every bid to ~2¢
   * and keeps the campaign ENABLED (prior bids remembered for exact restore), because a real
   * status=PAUSED disrupts Amazon's algorithm. Naming this `suppressed` rather than `paused` is
   * the whole point: an operator reading "paused" would believe delivery stops, which is the one
   * thing that does not happen.
   */
  suppressed: boolean
  /** all-out with no CPC ceiling — nothing bounds the bid in this hour but Amazon's own 900% cap */
  unbounded: boolean
  /** the target named by a window/baseline no longer exists in the library */
  missingTarget: boolean
}

export interface Next24Summary {
  /** distinct targets in order of first appearance, with how many of the 24 hours each governs */
  targets: Array<{ key: string; name: string; color: string | null; hours: number }>
  /** how many times the governing target changes across the window — each one is a bid write */
  changes: number
  hoursCovered: number
  hoursUncovered: number
  /** hours the engine floors bids to ~2¢ — delivery continues; see Next24Row.suppressed */
  hoursSuppressed: number
  /** hours where all-out runs with no maxCpc — the compounding trap, stated as a count */
  hoursUnbounded: number
  /** highest ceiling any hour permits, and the hours that reach it */
  maxCeilingPct: number | null
  /** targets referenced by the plan that are not in the library — those hours cannot resolve */
  missingTargetKeys: string[]
  /** dated events governing any of the next 24 hours, and how many hours each takes */
  events: Array<{ name: string; hours: number }>
}

export function buildNext24(
  slots: Next24Slot[],
  windows: ScheduleWindow[] | null | undefined,
  defaultTargetKey: string | null | undefined,
  targets: Map<string, Next24Target>,
): { hours: Next24Row[]; summary: Next24Summary } {
  const hours: Next24Row[] = slots.map((s) => {
    // Only the three wall-clock fields carry into the row. Spreading the slot would copy `plan`
    // — a full windows array — into every one of the 24 rows and out over the wire.
    const at = { at: s.at, dow: s.dow, hour: s.hour }
    // An event replaces the plan wholesale — its windows AND its baseline — exactly as the job
    // does. Taking the event's windows but the group's baseline would invent a third behaviour.
    const planWindows = s.plan ? s.plan.windows : windows
    const planBaseline = s.plan ? s.plan.defaultTargetKey : defaultTargetKey
    const eventName = s.plan?.eventName ?? null
    const win = resolveActiveWindow(planWindows, s.dow, s.hour)
    const key = win?.targetKey ?? planBaseline ?? null
    // 'window' only when a painted window actually named the target — falling through to the
    // baseline is a materially different fact for the operator ("I painted this" vs "this is the
    // rest of the week"), and it is the distinction the grid alone cannot express.
    const source: Next24Row['source'] = win?.targetKey ? 'window' : key ? 'baseline' : 'none'
    const t = key ? targets.get(key) : undefined
    if (!key) {
      return {
        ...at, targetKey: null, targetName: null, color: null, source, eventName,
        floorPct: null, ceilingPct: null, canChase: false, maxCpcCents: null, acosCapPct: null,
        allOut: false, suppressed: false, unbounded: false, missingTarget: false,
      }
    }
    if (!t) {
      // A key with no target behind it: the plan references a swatch someone deleted. The engine
      // skips the hour, so the preview must show a hole rather than a comfortable-looking row.
      return {
        ...at, targetKey: key, targetName: null, color: null, source, eventName,
        floorPct: null, ceilingPct: null, canChase: false, maxCpcCents: null, acosCapPct: null,
        allOut: false, suppressed: false, unbounded: false, missingTarget: true,
      }
    }
    const allOut = !!t.allOut
    const suppressed = !!t.pause
    const { floor, ceiling } = biasBand({ biasPct: t.biasPct ?? null, maxBiasPct: t.maxBiasPct ?? null, allOut })
    return {
      ...at,
      targetKey: key,
      targetName: t.name,
      color: t.color ?? null,
      source,
      eventName,
      // A suppression hour never reaches computeStep's band — the job floors the BASE bid and
      // returns before any placement move. Reporting "floor 0% / ceiling 0%" would describe a
      // placement multiplier that is simply not what happens, so the band is withheld.
      floorPct: suppressed ? null : floor,
      ceilingPct: suppressed ? null : ceiling,
      canChase: suppressed ? false : (allOut || ceiling > floor),
      maxCpcCents: t.maxCpcCents ?? null,
      // all-out ignores the ACOS ceiling by design, so reporting one here would be a lie the
      // operator could act on. computeStep nulls it the same way.
      acosCapPct: allOut || suppressed ? null : (t.acosCapPct ?? null),
      allOut,
      suppressed,
      unbounded: !suppressed && allOut && (t.maxCpcCents ?? null) == null,
      missingTarget: false,
    }
  })

  const order: string[] = []
  const counts = new Map<string, number>()
  for (const h of hours) {
    if (!h.targetKey) continue
    if (!counts.has(h.targetKey)) order.push(h.targetKey)
    counts.set(h.targetKey, (counts.get(h.targetKey) ?? 0) + 1)
  }
  let changes = 0
  for (let i = 1; i < hours.length; i++) if (hours[i].targetKey !== hours[i - 1].targetKey) changes++

  const ceilings = hours.map((h) => h.ceilingPct).filter((v): v is number => v != null)
  const missing = [...new Set(hours.filter((h) => h.missingTarget && h.targetKey).map((h) => h.targetKey as string))]

  return {
    hours,
    summary: {
      targets: order.map((k) => {
        const t = targets.get(k)
        return { key: k, name: t?.name ?? k, color: t?.color ?? null, hours: counts.get(k) ?? 0 }
      }),
      changes,
      hoursCovered: hours.filter((h) => h.targetKey).length,
      hoursUncovered: hours.filter((h) => !h.targetKey).length,
      hoursSuppressed: hours.filter((h) => h.suppressed).length,
      hoursUnbounded: hours.filter((h) => h.unbounded).length,
      maxCeilingPct: ceilings.length ? Math.max(...ceilings) : null,
      missingTargetKeys: missing,
      events: (() => {
        const byName = new Map<string, number>()
        for (const h of hours) if (h.eventName) byName.set(h.eventName, (byName.get(h.eventName) ?? 0) + 1)
        return [...byName.entries()].map(([name, hrs]) => ({ name, hours: hrs }))
      })(),
    },
  }
}
