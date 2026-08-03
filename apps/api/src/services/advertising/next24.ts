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
import { resolveActiveWindow, biasBand, cpcCapPct } from './rank-controller.js'
import type { ScheduleWindow } from './rank-controller.js'

/**
 * MB.6 — what the campaigns' bids let the CPC ceiling permit.
 *
 * MB.4 made `maxCpcCents` bind the placement multiplier, so the band biasBand returns is no
 * longer the whole story: a target free to reach 900% may in practice be held to 471% by its
 * own ceiling. Passing this in lets the preview quote the SAME cap the engine will apply
 * instead of the pre-MB.4 answer — the divergence this module exists to prevent.
 *
 * A group spans many campaigns with different bids, so the binding constraint is the one
 * that caps LOWEST: reporting the most permissive campaign's ceiling would tell the operator
 * the plan reaches a bias that most of its campaigns cannot.
 */
export interface Next24Cpc { maxBaseBidCents: number | null; strategyMultiple: number }

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
  /** MB.6 — the ceiling the CPC limit imposes, when it binds BELOW the band's own ceiling */
  cpcCapPct: number | null
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
  cpc?: Next24Cpc,
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
        floorPct: null, ceilingPct: null, canChase: false, cpcCapPct: null, maxCpcCents: null, acosCapPct: null,
        allOut: false, suppressed: false, unbounded: false, missingTarget: false,
      }
    }
    if (!t) {
      // A key with no target behind it: the plan references a swatch someone deleted. The engine
      // skips the hour, so the preview must show a hole rather than a comfortable-looking row.
      return {
        ...at, targetKey: key, targetName: null, color: null, source, eventName,
        floorPct: null, ceilingPct: null, canChase: false, cpcCapPct: null, maxCpcCents: null, acosCapPct: null,
        allOut: false, suppressed: false, unbounded: false, missingTarget: true,
      }
    }
    const allOut = !!t.allOut
    const suppressed = !!t.pause
    const band = biasBand({ biasPct: t.biasPct ?? null, maxBiasPct: t.maxBiasPct ?? null, allOut })
    const floor = band.floor
    // MB.6 — the CPC ceiling can bind below the band. When it does it IS the ceiling, because
    // the engine will not let the bid past it; reporting the band's number would overstate the
    // reach of every hour this target governs.
    const cap = cpc ? cpcCapPct(t.maxCpcCents ?? null, cpc.maxBaseBidCents, cpc.strategyMultiple) : null
    const capPct = cap && cap.capPct < band.ceiling ? cap.capPct : null
    const ceiling = capPct != null ? Math.max(floor, capPct) : band.ceiling
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
      cpcCapPct: suppressed ? null : capPct,
      maxCpcCents: t.maxCpcCents ?? null,
      // all-out ignores the ACOS ceiling by design, so reporting one here would be a lie the
      // operator could act on. computeStep nulls it the same way.
      acosCapPct: allOut || suppressed ? null : (t.acosCapPct ?? null),
      allOut,
      suppressed,
      // MB.4 — with the ceiling enforced, "unbounded" means exactly what it says: no ceiling
      // set at all. A target WITH one is now genuinely bounded, which it was not before.
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

/**
 * RDX/G2 — what changes if this event is armed.
 *
 * `Arm` flips `enabled` and the engine picks the event up on its next tick, which on a live
 * schedule is a bid change within 15 minutes. The plan document asked for a dry-run diff before
 * anything arms; this is it.
 *
 * Both sides are produced by buildNext24 over the SAME slots — once with the event's plan and once
 * without — so the comparison inherits every rule the preview already applies (window vs baseline,
 * the engine's bias band, suppression, all-out's ignored ACoS cap) instead of restating them. Two
 * rows differ only where the governing target genuinely differs.
 */
export interface PlanDiffRow { at: string; dow: number; hour: number; from: string | null; to: string | null }
export interface PlanDiff {
  hoursChanged: number
  hoursSame: number
  changed: PlanDiffRow[]
  /** hours the event would run all-out, and of those how many have no CPC ceiling at all */
  allOutHours: number
  unboundedHours: number
  suppressedHours: number
  byTarget: Array<{ key: string; gained: number; lost: number; net: number }>
}

export function diffPlans(before: Next24Row[], after: Next24Row[]): PlanDiff {
  const changed: PlanDiffRow[] = []
  const gained = new Map<string, number>()
  const lost = new Map<string, number>()
  let same = 0
  const n = Math.min(before.length, after.length)
  for (let i = 0; i < n; i++) {
    const a = before[i], b = after[i]
    if (a.targetKey === b.targetKey) { same++; continue }
    changed.push({ at: b.at, dow: b.dow, hour: b.hour, from: a.targetName ?? a.targetKey, to: b.targetName ?? b.targetKey })
    if (a.targetKey) lost.set(a.targetKey, (lost.get(a.targetKey) ?? 0) + 1)
    if (b.targetKey) gained.set(b.targetKey, (gained.get(b.targetKey) ?? 0) + 1)
  }
  const keys = new Set([...gained.keys(), ...lost.keys()])
  return {
    hoursChanged: changed.length,
    hoursSame: same,
    changed,
    // Counted over the event's OWN hours, not just the changed ones: an event that holds all-out
    // in an hour the weekly plan already held all-out is still an all-out hour being armed.
    allOutHours: after.slice(0, n).filter((h) => h.allOut).length,
    unboundedHours: after.slice(0, n).filter((h) => h.unbounded).length,
    suppressedHours: after.slice(0, n).filter((h) => h.suppressed).length,
    byTarget: [...keys].map((key) => {
      const g = gained.get(key) ?? 0, l = lost.get(key) ?? 0
      return { key, gained: g, lost: l, net: g - l }
    }).sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || b.gained - a.gained),
  }
}
