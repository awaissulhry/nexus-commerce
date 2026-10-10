/**
 * ONE BRAIN AB-13 — the brain paints one product's hourly plan from its research (brain/hours-research.ts; design
 * 2026-10-08-ads-one-brain/DESIGN.md §2.3, D3 = B+: the brain paints freely, shows the plan, and it applies after the
 * Owner's approval). Pure: no database, no clock.
 *
 *   ladder      the targets the plan already holds (its windows and baseline — the Owner's own targets with his values),
 *               serving ones ordered by placement % (then CPC ceiling, none = highest), plus a Min-bid target (the plan's,
 *               else the library's built-in `pause`, else none). The brain never brings in a target the plan does not use.
 *   blocks      the week in 4-hour blocks (design §2.3, Perpetua's tested envelope [PER-6]): each block's expected ACoS =
 *               the product's expected ACoS × the block's cost-per-click index ÷ its conversion index, with its 90 %
 *               interval (the block's, its day part's, its weekday's and the level's uncertainty). Against the goal's
 *               band (bid-brain/goal.ts):
 *                 Min bid  expected ACoS above MIN_BID_ACOS_MULTIPLE × the band top, the whole interval above the top,
 *                          and real spend: the block spent at least what one order is expected to cost (design §2.3)
 *                 down     expected ACoS above the band top and the interval above the aim
 *                 up       expected ACoS below the band bottom and the interval below the aim (never where top of search
 *                          clearly converts worse than the other lanes); a floored block is judged on its pool's cost per
 *                          click (its own is the floor's)
 *                 keep     anything else — thin data keeps the plan (design §2.3: "fall back when data is thin"), as the
 *                          wide interval of a thin product rarely clears a rule
 *   cells       each hour moves from ITS OWN target in its block's direction by the furthest step whose bid multiplier
 *               (1 + placement %) moves at most hourCellMovePct (default 30 %, §5). Up never past that cap: when even the
 *               next step up is beyond it the hour stays (batch 2 review fix — a 0 % → +100 % plan doubled a bid in one
 *               paint); down at least one step (a cut). Into Min bid from any target (a cut); out of Min bid to the lowest
 *               serving target. 0 % moves nothing.
 *   kept        a locked hour cell (hours lever, "hourCell:dXhY", the product's or a member campaign's) never changes; an
 *               hour the plan holds no target in stays so; a target that would change a locked lane (placements lever)
 *               is not taken; with hourPlanAsLimits the Owner's own painted plan caps each hour — never above his target
 *               or his placement %, his Min-bid hours stay Min bid (U4-D1).
 *   anti-flap   at most minBidEntriesPerDay Min-bid entries a day (design §2.3, the anti-flap of rank-defend): the new
 *               Min-bid runs with the least spend go back first.
 *   effect      the expected week before and after (spend, orders, sales, ACoS) with a range: spend moves 0.5–1 × and
 *               clicks 0.3–0.7 × the bid multiplier on the lane it changes (top of search's share of spend), a Min-bid
 *               hour keeps 0–10 %, an hour leaving Min bid gets its pool's share of the week (± 50 %), and conversion its
 *               90 % interval.
 *   windows     the painted week as windows the plan stores (`endHour` exclusive, the baseline kept where it still
 *               holds an hour), read back through the engine's own rule (resolveActiveTargetKey) before it is returned.
 *   unmoved     A2c — every hour of a block that wants to move but stays, with why (stepWhy beside stepFrom: the next step
 *               past hourCellMovePct, the top or bottom of the plan's ladder, no Min-bid target, already at Min bid, no
 *               target; and the Owner's hour lock, lane lock, his plan as the limit, the anti-flap) and what unblocks it.
 *               A plan that paints nothing says so in its first line, with the counts per reason — never "every block
 *               stays inside the band" when blocks wanted to move.
 */
import { resolveActiveTargetKey, type ScheduleWindow } from '../rank-controller.js'
import type { LaneName } from '../bid-brain/recipe.js'
import {
  DAY_WORDS, PART_HOURS, PARTS, blockKey, cellRef, intervalFactors, partOf, partWords,
  type BlockResearch, type HoursResearch,
} from './hours-research.js'

/** Design §2.3: an hour whose expected ACoS is above 1.5 × the band top becomes a Min-bid hour. */
export const MIN_BID_ACOS_MULTIPLE = 1.5
/** A Min-bid hour keeps this share of its spend and orders (2–3¢ bids barely serve). */
export const MIN_BID_KEEPS = { lo: 0, mid: 0.05, hi: 0.1 }
/** Spend and clicks against the bid multiplier (elasticities, low and high). */
export const SPEND_ELASTICITY = { lo: 0.5, mid: 0.75, hi: 1 }
export const CLICK_ELASTICITY = { lo: 0.3, mid: 0.5, hi: 0.7 }
/** An hour leaving Min bid gets its pool's share of the week, ± this much. */
export const LEAVE_FLOOR_SPREAD = 0.5
/** Top of search "clearly converts worse": its ACoS this much above the other lanes', and above the band top. */
const TOS_WORSE = 1.2

/** A rank target as the painter reads it (the library's values; a campaign's own values apply on top, as they are). */
export interface PaintTarget {
  key: string
  name: string
  /** A Min-bid target: every bid at the floor, every lane at 0 %. */
  floor: boolean
  /** The placement % its hours hold (the highest lane of a blend). */
  placementPct: number
  /** The % it declares per lane; a lane it does not declare stays as it is. */
  lanes: Partial<Record<LaneName, number>>
  maxCpcCents: number | null
}

export interface Goal { aim: number; lo: number; hi: number; words: string }

export interface PaintInput {
  research: HoursResearch
  goal: Goal | null
  plan: { windows: unknown; defaultTargetKey: string | null }
  /** The library by key. */
  targets: ReadonlyMap<string, PaintTarget>
  /** Hour cells the Owner locked ("d1h14"), lanes he locked (placements lever), and every lane (a whole-lever lock). */
  locks: { cells: ReadonlySet<string>; lanes: ReadonlySet<LaneName> }
  /** The Owner's own painted plan as the limit of each hour (hourPlanAsLimits), or null. */
  limits: { windows: unknown; defaultTargetKey: string | null } | null
  settings: { hourCellMovePct: number; minBidEntriesPerDay: number }
}

export type Direction = 'up' | 'down' | 'minbid' | 'keep'
export interface Range { lo: number; mid: number; hi: number }

export interface BlockDecision {
  d: number
  part: number
  dir: Direction
  expectedAcos: number | null
  acosLo: number | null
  acosHi: number | null
  spendCents: number
  why: string
}

export interface CellChange { cell: string; d: number; h: number; from: string | null; to: string | null; why: string }

export interface PaintEffect {
  before: { spendCents: number; orders: number; salesCents: number; acos: number | null }
  after: { spendCents: Range; orders: Range; salesCents: Range; acos: Range | null }
  delta: { spendCents: Range; orders: Range }
  assumptions: string[]
}

/** A2c — why an hour of a block that wants to move stays. */
export type UnmovedReason = 'locked' | 'no-target' | 'cap' | 'top' | 'bottom' | 'no-min-bid-target' | 'already-min-bid' | 'limit' | 'lane' | 'anti-flap'

/** A2c — the hours of one block that wanted to move and stayed, for one reason. */
export interface UnmovedBlock {
  block: string
  d: number
  part: number
  dir: Direction
  reason: UnmovedReason
  /** The reason in words, and what would let the hour move. */
  why: string
  unblock: string
  cells: string[]
}

export interface PaintedPlan {
  /** Why nothing could be painted (no ladder, no goal, frozen); null when the painter ran. */
  held: string | null
  ladder: { serving: string[]; minBid: string | null }
  blocks: BlockDecision[]
  /** [d][h], d 0 = Sunday: the target key each hour holds, before and after. */
  week: { before: Array<Array<string | null>>; after: Array<Array<string | null>> }
  changes: CellChange[]
  locked: string[]
  /** Hours held to the Owner's plan (limits), and Min-bid runs given back by the anti-flap. */
  limited: string[]
  antiFlap: Array<{ d: number; cells: string[]; why: string }>
  /** A2c — the hours of blocks that wanted to move and stayed, grouped by block and reason (none when nothing wanted to move). */
  unmoved: UnmovedBlock[]
  /** What the plan stores after (only when something changed). */
  windows: Array<{ days: number[]; startHour: number; endHour: number; targetKey: string }> | null
  defaultTargetKey: string | null
  effect: PaintEffect | null
  /** Plain words with no money in them, and the expected effect in money. */
  summary: string[]
  money: string[]
}

const windowsOf = (w: unknown): ScheduleWindow[] => (Array.isArray(w) ? (w as ScheduleWindow[]) : [])
/** The week of a plan, [d][h], by the engine's own rule. */
export function weekOf(plan: { windows: unknown; defaultTargetKey: string | null }): Array<Array<string | null>> {
  return Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => resolveActiveTargetKey(windowsOf(plan.windows), plan.defaultTargetKey, d, h)))
}

const factor = (t: PaintTarget) => 1 + t.placementPct / 100
const ceiling = (t: PaintTarget) => (t.maxCpcCents == null ? Number.POSITIVE_INFINITY : t.maxCpcCents)

/** The plan's targets as a ladder: serving ones by placement %, then CPC ceiling, then key; the Min-bid target apart. */
export function ladderOf(plan: { windows: unknown; defaultTargetKey: string | null }, targets: ReadonlyMap<string, PaintTarget>): { serving: string[]; minBid: string | null; missing: string[] } {
  const used = new Set<string>()
  for (const w of windowsOf(plan.windows)) if (w?.targetKey) used.add(w.targetKey)
  if (plan.defaultTargetKey) used.add(plan.defaultTargetKey)
  const missing = [...used].filter((k) => !targets.has(k)).sort()
  const known = [...used].map((k) => targets.get(k)).filter((t): t is PaintTarget => !!t)
  const serving = known.filter((t) => !t.floor).sort((a, b) => a.placementPct - b.placementPct || ceiling(a) - ceiling(b) || a.key.localeCompare(b.key)).map((t) => t.key)
  const ownFloor = known.filter((t) => t.floor).sort((a, b) => a.key.localeCompare(b.key))[0]
  const libraryFloor = targets.get('pause')?.floor ? 'pause' : [...targets.values()].filter((t) => t.floor).sort((a, b) => a.key.localeCompare(b.key))[0]?.key ?? null
  return { serving, minBid: ownFloor?.key ?? libraryFloor, missing }
}

/** The expected ACoS of one block with its 90 % interval (null without a level). */
export function blockAcos(b: BlockResearch, research: HoursResearch, floored: boolean): { mid: number; lo: number; hi: number } | null {
  const level = research.expected.acos
  if (level == null || !(b.crIndex > 0)) return null
  const cpcIndex = floored ? b.pooledCpcIndex : b.cpcIndex
  const mid = level * cpcIndex / b.crIndex
  const f = intervalFactors([b.crShape, b.partShape, b.weekdayShape, Math.max(1, research.expected.crShape)])
  // ACoS ∝ 1 / CR: a high conversion bound is a low ACoS bound.
  return { mid, lo: mid / f.hi, hi: mid / f.lo }
}

/** The expected cost of one order at the product's level (cost per click ÷ conversion), null when not known. */
export function expectedCpaCents(research: HoursResearch): number | null {
  const { cpcCents, cr } = research.expected
  return cpcCents != null && cr != null && cr > 0 ? cpcCents / cr : null
}

/** Top of search clearly converts worse than the other lanes (and above the band top): no raise. */
function topOfSearchWorse(research: HoursResearch, goal: Goal): boolean {
  const tos = research.lanes.find((l) => l.lane === 'TOP_OF_SEARCH')
  const rest = research.lanes.filter((l) => l.lane !== 'TOP_OF_SEARCH')
  if (!tos?.acos || !rest.length) return false
  const restSpend = rest.reduce((s, l) => s + l.spendShare, 0)
  const restAcos = restSpend > 0 ? rest.reduce((s, l) => s + (l.acos ?? 0) * l.spendShare, 0) / restSpend : null
  return restAcos != null && restAcos > 0 && tos.acos > goal.hi && tos.acos > TOS_WORSE * restAcos
}

/**
 * Each block's direction, with its expected ACoS and why (pure). `floored.any`: blocks with a Min-bid hour now (judged on
 * their pool's cost per click: their own is the floor's); `floored.all`: blocks whose hours all sit at Min bid.
 */
export function decideBlocks(research: HoursResearch, goal: Goal, floored: { any: ReadonlySet<number>; all: ReadonlySet<number> } = { any: new Set(), all: new Set() }): BlockDecision[] {
  const cpa = expectedCpaCents(research)
  const tosWorse = topOfSearchWorse(research, goal)
  const pctOf = (x: number) => `${Math.round(x * 1000) / 10} %`
  return research.blocks.map((b) => {
    const k = blockKey(b.d, b.part)
    const allFloor = floored.all.has(k)
    const anyFloor = allFloor || floored.any.has(k)
    const where = `${DAY_WORDS[b.d]} ${partWords(b.part)}`
    const base = { d: b.d, part: b.part, spendCents: Math.round(b.own.spendCents * 100) / 100 }
    const acos = blockAcos(b, research, anyFloor)
    if (!acos) return { ...base, dir: 'keep' as const, expectedAcos: null, acosLo: null, acosHi: null, why: `${where}: no expected ACoS (no conversion level for the product or its pool) — kept` }
    const at = { expectedAcos: Math.round(acos.mid * 10_000) / 10_000, acosLo: Math.round(acos.lo * 10_000) / 10_000, acosHi: Math.round(acos.hi * 10_000) / 10_000 }
    const range = `expected ACoS ${pctOf(acos.mid)} (90 %: ${pctOf(acos.lo)}–${pctOf(acos.hi)}) against ${goal.words}`
    const realSpend = cpa != null && b.own.spendCents >= cpa
    if (!allFloor && acos.mid > MIN_BID_ACOS_MULTIPLE * goal.hi && acos.lo > goal.hi && realSpend) {
      return { ...base, ...at, dir: 'minbid' as const, why: `${where}: ${range}, above ${MIN_BID_ACOS_MULTIPLE} × the band top with real spend (${b.own.clicks} clicks, ${b.own.orders} orders in the window) — Min bid` }
    }
    if (acos.mid > goal.hi && acos.lo > goal.aim) return { ...base, ...at, dir: allFloor ? 'keep' as const : 'down' as const, why: `${where}: ${range}, above the band — ${allFloor ? 'stays at Min bid' : 'down a step'}` }
    if (acos.mid < goal.lo && acos.hi < goal.aim) {
      if (tosWorse && !allFloor) return { ...base, ...at, dir: 'keep' as const, why: `${where}: ${range}, below the band, but top of search converts clearly worse than the other lanes — no raise` }
      return { ...base, ...at, dir: 'up' as const, why: `${where}: ${range}, below the band${anyFloor ? ' on its pool\'s cost per click' : ''} — ${allFloor ? 'leaves Min bid' : 'up a step'}` }
    }
    const thin = acos.hi / Math.max(acos.lo, 1e-9) > 4
    return { ...base, ...at, dir: 'keep' as const, why: `${where}: ${range}${thin ? ' — too uncertain to move' : ''} — kept` }
  })
}

/** The lane % a target declares (undefined: it leaves the lane as it is). A Min-bid target sets every lane to 0. */
const laneOfTarget = (t: PaintTarget | undefined, lane: LaneName): number | undefined => (t?.floor ? 0 : t?.lanes[lane])

/**
 * The target an hour moves to from `current` in direction `dir` (pure). `cap` is hourCellMovePct as a fraction.
 * Returns the current key when it does not move.
 */
export function stepFrom(current: string, dir: Direction, ladder: { serving: string[]; minBid: string | null }, targets: ReadonlyMap<string, PaintTarget>, cap: number): string {
  const t = targets.get(current)
  if (!t || dir === 'keep' || cap <= 0) return current
  if (t.floor) return dir === 'up' && ladder.serving.length ? ladder.serving[0] : current
  if (dir === 'minbid') return ladder.minBid ?? current
  const i = ladder.serving.indexOf(current)
  if (i < 0) return current
  const f0 = factor(t)
  const within = (k: string) => Math.abs(factor(targets.get(k)!) / f0 - 1) <= cap + 1e-9
  if (dir === 'up') {
    // Batch 2 review fix — a raise stays inside the cap: when the next step up is already beyond it, the hour stays.
    if (i + 1 >= ladder.serving.length || !within(ladder.serving[i + 1])) return current
    let j = i + 1
    while (j + 1 < ladder.serving.length && within(ladder.serving[j + 1])) j++
    return ladder.serving[j]
  }
  if (i === 0) return current
  let j = i - 1
  while (j - 1 >= 0 && within(ladder.serving[j - 1])) j--
  return ladder.serving[j]
}

/**
 * A2c — why stepFrom keeps `current` although its block wants to move (null: it moves, or the block keeps). Pure; it reads
 * stepFrom's own branches, so the two never disagree.
 */
export function stepWhy(current: string, dir: Direction, ladder: { serving: string[]; minBid: string | null }, targets: ReadonlyMap<string, PaintTarget>, cap: number): Exclude<UnmovedReason, 'locked' | 'limit' | 'lane' | 'anti-flap'> | null {
  if (dir === 'keep') return null
  const t = targets.get(current)
  if (!t) return 'no-target'
  if (cap <= 0) return 'cap'
  if (t.floor) return dir === 'up' ? (ladder.serving.length ? null : 'no-target') : 'already-min-bid'
  if (dir === 'minbid') return ladder.minBid ? null : 'no-min-bid-target'
  const i = ladder.serving.indexOf(current)
  if (i < 0) return 'no-target'
  if (dir === 'up') {
    if (i + 1 >= ladder.serving.length) return 'top'
    return Math.abs(factor(targets.get(ladder.serving[i + 1])!) / factor(t) - 1) <= cap + 1e-9 ? null : 'cap'
  }
  return i === 0 ? 'bottom' : null
}

/** A2c — each reason in words and what unblocks it (no money: these are the plan's plain words). */
export function unmovedWords(reason: UnmovedReason, settings: PaintInput['settings']): { why: string; unblock: string } {
  switch (reason) {
    case 'locked': return { why: 'locked by the Owner', unblock: 'his hour lock ends (set-ads-brain unlock)' }
    case 'no-target': return { why: 'hold no target the brain can move (none in the plan there, or one that no longer exists)', unblock: 'give those hours a target of the plan' }
    case 'cap': return { why: `the next step of the plan's ladder moves the bid more than hourCellMovePct (${settings.hourCellMovePct} %)`, unblock: 'raise hourCellMovePct (set-ads-brain set-value), or add a target between the two steps to the plan' }
    case 'top': return { why: 'already at the plan\'s highest target', unblock: 'add a higher target to the plan' }
    case 'bottom': return { why: 'already at the plan\'s lowest serving target', unblock: 'add a lower target to the plan (the brain never turns a step down into Min bid)' }
    case 'no-min-bid-target': return { why: 'no Min-bid target in the plan or the library', unblock: 'add a Min-bid target (the library\'s "pause")' }
    case 'already-min-bid': return { why: 'already at Min bid', unblock: 'nothing: an hour cannot go lower' }
    case 'limit': return { why: 'held to the Owner\'s own plan (hourPlanAsLimits)', unblock: 'raise his plan in those hours, or set hourPlanAsLimits off' }
    case 'lane': return { why: 'the move would change a lane the Owner locked', unblock: 'his lane lock ends (placements lever)' }
    case 'anti-flap': return { why: `past ${settings.minBidEntriesPerDay} Min-bid ${settings.minBidEntriesPerDay === 1 ? 'entry' : 'entries'} a day (the anti-flap)`, unblock: 'raise minBidEntriesPerDay (set-ads-brain set-value)' }
  }
}

/** The Min-bid runs of a day: [start, end) hours; a run at 00:00 counts as an entry only if the day before ended outside Min bid. */
export function minBidRuns(week: ReadonlyArray<ReadonlyArray<string | null>>, d: number, isFloor: (k: string | null) => boolean): Array<{ start: number; end: number; entry: boolean }> {
  const runs: Array<{ start: number; end: number; entry: boolean }> = []
  const day = week[d]
  const prevLast = week[(d + 6) % 7][23]
  for (let h = 0; h < 24; h++) {
    if (!isFloor(day[h])) continue
    const start = h
    while (h + 1 < 24 && isFloor(day[h + 1])) h++
    runs.push({ start, end: h + 1, entry: start > 0 || !isFloor(prevLast) })
  }
  return runs
}

/** The week as windows (endHour exclusive) and a baseline; read back by the engine's own rule (pure; throws if it would not). */
export function encodeWeek(week: ReadonlyArray<ReadonlyArray<string | null>>, preferBaseline: string | null): { windows: Array<{ days: number[]; startHour: number; endHour: number; targetKey: string }>; defaultTargetKey: string | null } {
  const flat = week.flat()
  const hasEmpty = flat.some((k) => k == null)
  let baseline: string | null = null
  if (!hasEmpty) {
    if (preferBaseline && flat.includes(preferBaseline)) baseline = preferBaseline
    else {
      const counts = new Map<string, number>()
      for (const k of flat) counts.set(k!, (counts.get(k!) ?? 0) + 1)
      baseline = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
    }
  }
  const runs = new Map<string, { days: number[]; startHour: number; endHour: number; targetKey: string }>()
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 24; h++) {
      const k = week[d][h]
      if (k == null || k === baseline) continue
      const start = h
      while (h + 1 < 24 && week[d][h + 1] === k) h++
      const id = `${start}|${h + 1}|${k}`
      const run = runs.get(id) ?? { days: [], startHour: start, endHour: h + 1, targetKey: k }
      run.days.push(d)
      runs.set(id, run)
    }
  }
  const windows = [...runs.values()].sort((a, b) => a.days[0] - b.days[0] || a.startHour - b.startHour || a.targetKey.localeCompare(b.targetKey))
  const back = weekOf({ windows, defaultTargetKey: baseline })
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) if (back[d][h] !== week[d][h]) throw new Error(`the painted week does not read back at ${cellRef(d, h)}`)
  return { windows, defaultTargetKey: baseline }
}

const r2 = (x: number) => Math.round(x * 100) / 100
const r4 = (x: number) => Math.round(x * 10_000) / 10_000
const range = (a: number, b: number, mid: number): Range => ({ lo: Math.min(a, b), mid, hi: Math.max(a, b) })
const sumRange = (xs: readonly Range[]): Range => xs.reduce<Range>((s, x) => ({ lo: s.lo + x.lo, mid: s.mid + x.mid, hi: s.hi + x.hi }), { lo: 0, mid: 0, hi: 0 })

/** The expected effect of the changed hours on a week (pure). */
export function expectedEffect(research: HoursResearch, before: ReadonlyArray<ReadonlyArray<string | null>>, changes: readonly CellChange[], targets: ReadonlyMap<string, PaintTarget>): PaintEffect | null {
  const week = research.expected.week
  const aov = research.expected.aovCents
  const cr = research.expected.cr
  if (!(week.spendCents > 0) || cr == null || aov == null) return null
  // Each hour's share of the week's spend and orders (the product's pooled curve), and its pool's.
  const spendW = research.hours.map((x) => x.clicksShare * x.cpcIndex)
  const orderW = research.hours.map((x) => x.clicksShare * x.crIndex)
  const sw = spendW.reduce((s, x) => s + x, 0) || 1
  const ow = orderW.reduce((s, x) => s + x, 0) || 1
  const pooled = (d: number, h: number) => { const b = research.blocks[blockKey(d, partOf(h))]; return (b.pooledClicksShare * b.pooledCpcIndex) / PART_HOURS }
  const servingWeight = before.reduce((s, day, d) => s + day.reduce((t, k, h) => t + (k && !targets.get(k)?.floor ? pooled(d, h) : 0), 0), 0)
  const tos = research.topOfSearchSpendShare
  const ds: Range[] = []
  const dor: Range[] = []
  for (const c of changes) {
    const k = c.d * 24 + c.h
    const b = research.blocks[blockKey(c.d, partOf(c.h))]
    const crF = intervalFactors([b.crShape, b.partShape, b.weekdayShape, Math.max(1, research.expected.crShape)])
    const s0 = week.spendCents * spendW[k] / sw
    const o0 = week.orders * orderW[k] / ow
    const from = c.from ? targets.get(c.from) : undefined
    const to = c.to ? targets.get(c.to) : undefined
    if (!from || !to) continue
    if (!from.floor && to.floor) {
      ds.push(range(s0 * (MIN_BID_KEEPS.lo - 1), s0 * (MIN_BID_KEEPS.hi - 1), s0 * (MIN_BID_KEEPS.mid - 1)))
      dor.push(range(o0 * crF.hi * (MIN_BID_KEEPS.lo - 1), o0 * crF.lo * (MIN_BID_KEEPS.hi - 1), o0 * (MIN_BID_KEEPS.mid - 1)))
    } else if (from.floor && !to.floor) {
      const share = servingWeight > 0 ? pooled(c.d, c.h) / servingWeight : 0
      const sIf = week.spendCents * share
      const cpc = (research.expected.cpcCents ?? 0) * b.pooledCpcIndex
      const oIf = cpc > 0 ? (sIf / cpc) * cr * b.crIndex : 0
      ds.push(range(sIf * (1 - LEAVE_FLOOR_SPREAD) - s0, sIf * (1 + LEAVE_FLOOR_SPREAD) - s0, sIf - s0))
      dor.push(range(oIf * (1 - LEAVE_FLOOR_SPREAD) * crF.lo - o0, oIf * (1 + LEAVE_FLOOR_SPREAD) * crF.hi - o0, oIf - o0))
    } else if (!from.floor && !to.floor) {
      const rEff = 1 + tos * (factor(to) / factor(from) - 1)
      const m = (e: number) => Math.pow(rEff, e) - 1
      ds.push(range(s0 * m(SPEND_ELASTICITY.lo), s0 * m(SPEND_ELASTICITY.hi), s0 * m(SPEND_ELASTICITY.mid)))
      const cands = [o0 * crF.lo * m(CLICK_ELASTICITY.lo), o0 * crF.lo * m(CLICK_ELASTICITY.hi), o0 * crF.hi * m(CLICK_ELASTICITY.lo), o0 * crF.hi * m(CLICK_ELASTICITY.hi)]
      dor.push({ lo: Math.min(...cands), mid: o0 * m(CLICK_ELASTICITY.mid), hi: Math.max(...cands) })
    }
  }
  const dS = sumRange(ds), dO = sumRange(dor)
  const S1 = { lo: week.spendCents + dS.lo, mid: week.spendCents + dS.mid, hi: week.spendCents + dS.hi }
  const O1 = { lo: Math.max(0, week.orders + dO.lo), mid: Math.max(0, week.orders + dO.mid), hi: Math.max(0, week.orders + dO.hi) }
  const sales = (o: number) => o * aov
  const acosAt = (s: number, o: number) => (o > 0 ? s / sales(o) : null)
  const corners = [acosAt(S1.lo, O1.lo), acosAt(S1.lo, O1.hi), acosAt(S1.hi, O1.lo), acosAt(S1.hi, O1.hi)].filter((x): x is number => x != null)
  const acosMid = acosAt(S1.mid, O1.mid)
  return {
    before: { spendCents: r2(week.spendCents), orders: r4(week.orders), salesCents: r2(week.salesCents), acos: week.salesCents > 0 ? r4(week.spendCents / week.salesCents) : null },
    after: {
      spendCents: { lo: r2(S1.lo), mid: r2(S1.mid), hi: r2(S1.hi) },
      orders: { lo: r4(O1.lo), mid: r4(O1.mid), hi: r4(O1.hi) },
      salesCents: { lo: r2(sales(O1.lo)), mid: r2(sales(O1.mid)), hi: r2(sales(O1.hi)) },
      acos: acosMid != null && corners.length ? { lo: r4(Math.min(...corners)), mid: r4(acosMid), hi: r4(Math.max(...corners)) } : null,
    },
    delta: { spendCents: { lo: r2(dS.lo), mid: r2(dS.mid), hi: r2(dS.hi) }, orders: { lo: r4(dO.lo), mid: r4(dO.mid), hi: r4(dO.hi) } },
    assumptions: [
      `Spend moves ${SPEND_ELASTICITY.lo}–${SPEND_ELASTICITY.hi} × and clicks ${CLICK_ELASTICITY.lo}–${CLICK_ELASTICITY.hi} × the bid multiplier (1 + placement %) on the lane it changes, top of search holding ${Math.round(tos * 100)} % of the spend${research.topOfSearchShareKnown ? '' : ' (assumed: no placement report)'}.`,
      `A Min-bid hour keeps ${MIN_BID_KEEPS.lo * 100}–${MIN_BID_KEEPS.hi * 100} % of its spend and orders; an hour leaving Min bid gets its pool's share of the week's spend (± ${LEAVE_FLOOR_SPREAD * 100} %).`,
      'Conversion per hour carries its 90 % interval; the week before is the window\'s spend a week and its expected (pooled) orders.',
    ],
  }
}

const plural = (n: number, w: string, many = `${w}s`) => `${n} ${n === 1 ? w : many}`
/** Minor units as a plain amount ("12.50"); the currency is the campaigns' own. */
const fmtMoney = (cents: number) => `${cents < 0 ? '−' : ''}${(Math.abs(cents) / 100).toFixed(2)}`
const fmtSignedMoney = (cents: number) => `${cents < 0 ? '−' : '+'}${(Math.abs(cents) / 100).toFixed(2)}`
const signed = (x: number, digits = 1) => `${x < 0 ? '−' : '+'}${Math.abs(x).toFixed(digits)}`
const pctWords = (x: number | null) => (x == null ? 'not known' : `${Math.round(x * 1000) / 10} %`)

/** Paint the product's plan (pure). */
export function paintPlan(input: PaintInput): PaintedPlan {
  const { research, targets } = input
  const before = weekOf(input.plan)
  const ladder = ladderOf(input.plan, targets)
  const empty = (held: string): PaintedPlan => ({
    held, ladder: { serving: ladder.serving, minBid: ladder.minBid }, blocks: [], week: { before, after: before.map((d) => [...d]) }, changes: [],
    locked: [...input.locks.cells].sort(), limited: [], antiFlap: [], unmoved: [], windows: null, defaultTargetKey: input.plan.defaultTargetKey, effect: null,
    summary: [held], money: [],
  })
  if (!ladder.serving.length) return empty('The plan holds no serving target the brain could move between (its targets are Min bid, missing or none): nothing painted.')
  if (!input.goal) return empty('No ACoS goal for the product in this market (the ads strategy holds none): the brain researched the hours but paints nothing without a goal to measure them against.')
  if (research.expected.acos == null) return empty('No expected ACoS: the product and its pool had no orders (or no clicks) in the window, so no hour can be judged; nothing painted.')
  const cap = Math.max(0, input.settings.hourCellMovePct) / 100
  if (cap <= 0) return empty('hourCellMovePct is 0: the Owner lets the brain move no hour; nothing painted.')

  const isFloor = (k: string | null) => !!k && !!targets.get(k)?.floor
  const floored = { any: new Set<number>(), all: new Set<number>() }
  for (let d = 0; d < 7; d++) for (let p = 0; p < PARTS; p++) {
    const hs = Array.from({ length: PART_HOURS }, (_, i) => p * PART_HOURS + i).filter((h) => !input.locks.cells.has(cellRef(d, h)) && before[d][h] != null)
    if (hs.some((h) => isFloor(before[d][h]))) floored.any.add(blockKey(d, p))
    if (hs.length && hs.every((h) => isFloor(before[d][h]))) floored.all.add(blockKey(d, p))
  }
  const blocks = decideBlocks(research, input.goal, floored)
  const limitWeek = input.limits ? weekOf(input.limits) : null
  const after = before.map((d) => [...d])
  const why = new Map<string, string>()
  const limited: string[] = []
  const lockedTouched = new Set<string>()
  const lanesRefused = new Set<string>()

  /** Does `cand` keep every locked lane as `cur` leaves it? */
  const lanesKept = (cur: string, cand: string) => [...input.locks.lanes].every((l) => laneOfTarget(targets.get(cur), l) === laneOfTarget(targets.get(cand), l))
  /** Hold `cand` to the Owner's plan at this hour (limits): never above his target or placement %, his Min bid stays. */
  const holdToLimit = (d: number, h: number, cand: string): string => {
    if (!limitWeek) return cand
    const limitKey = limitWeek[d][h]
    if (limitKey == null) return cand
    const lim = targets.get(limitKey)
    if (!lim) return cand
    if (lim.floor) return isFloor(cand) ? cand : limitKey
    const c = targets.get(cand)
    if (!c || c.floor) return cand
    const li = ladder.serving.indexOf(limitKey)
    const ci = ladder.serving.indexOf(cand)
    if (c.placementPct <= lim.placementPct && (li < 0 || ci <= li)) return cand
    // The highest serving step inside his limit (by ladder place and by placement %).
    const ok = ladder.serving.filter((k, i) => targets.get(k)!.placementPct <= lim.placementPct && (li < 0 || i <= li))
    return ok.length ? ok[ok.length - 1] : (ladder.minBid ?? cand)
  }

  // A2c — each hour of a block that wants to move and stays, with why.
  const stayed: Array<{ ref: string; d: number; h: number; reason: UnmovedReason }> = []
  const stays = (b: BlockDecision, h: number, reason: UnmovedReason) => { if (b.dir !== 'keep') stayed.push({ ref: cellRef(b.d, h), d: b.d, h, reason }) }
  for (const b of blocks) {
    for (let i = 0; i < PART_HOURS; i++) {
      const h = b.part * PART_HOURS + i
      const ref = cellRef(b.d, h)
      const cur = before[b.d][h]
      if (input.locks.cells.has(ref)) { if (b.dir !== 'keep') lockedTouched.add(ref); stays(b, h, 'locked'); continue }
      if (cur == null || !targets.has(cur)) { stays(b, h, 'no-target'); continue }
      const step = stepFrom(cur, b.dir, ladder, targets, cap)
      const cand = holdToLimit(b.d, h, step)
      if (cand !== step) limited.push(ref)
      if (cand === cur) { stays(b, h, step === cur ? stepWhy(cur, b.dir, ladder, targets, cap) ?? 'no-target' : 'limit'); continue }
      if (!lanesKept(cur, cand)) { lanesRefused.add(ref); stays(b, h, 'lane'); continue }
      after[b.d][h] = cand
      why.set(ref, cand !== step ? `${b.why}; held to the Owner's plan (${cand})` : b.why)
    }
  }

  // Anti-flap: at most minBidEntriesPerDay Min-bid entries a day; the new runs with the least spend go back first.
  const antiFlap: PaintedPlan['antiFlap'] = []
  const maxEntries = Math.max(0, input.settings.minBidEntriesPerDay)
  for (let d = 0; d < 7; d++) {
    for (;;) {
      const runs = minBidRuns(after, d, isFloor)
      if (runs.filter((r) => r.entry).length <= maxEntries) break
      const newRuns = runs.filter((r) => r.entry).map((r) => {
        const cells = Array.from({ length: r.end - r.start }, (_, i) => r.start + i).filter((h) => !isFloor(before[d][h]))
        const spend = cells.reduce((s, h) => s + (research.hours[d * 24 + h]?.spendCents ?? 0), 0)
        return { ...r, cells, spend }
      }).filter((r) => r.cells.length)
      if (!newRuns.length) break
      const back = newRuns.sort((a, b) => a.spend - b.spend || a.start - b.start)[0]
      for (const h of back.cells) { after[d][h] = before[d][h]; why.delete(cellRef(d, h)); stayed.push({ ref: cellRef(d, h), d, h, reason: 'anti-flap' }) }
      antiFlap.push({ d, cells: back.cells.map((h) => cellRef(d, h)), why: `${DAY_WORDS[d]}: at most ${maxEntries} Min-bid ${maxEntries === 1 ? 'entry' : 'entries'} a day — the new run ${String(back.start).padStart(2, '0')}–${String(back.end).padStart(2, '0')} stays as it was` })
    }
  }

  const changes: CellChange[] = []
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
    if (after[d][h] !== before[d][h]) changes.push({ cell: cellRef(d, h), d, h, from: before[d][h], to: after[d][h], why: why.get(cellRef(d, h)) ?? 'painted' })
  }
  const encoded = changes.length ? encodeWeek(after, input.plan.defaultTargetKey) : null
  const effect = changes.length ? expectedEffect(research, before, changes, targets) : null

  // A2c — the hours that stayed, grouped by block and reason, in the week's order.
  const blockOf = new Map(blocks.map((b) => [blockKey(b.d, b.part), b]))
  const groups = new Map<string, UnmovedBlock>()
  for (const x of stayed) {
    const b = blockOf.get(blockKey(x.d, partOf(x.h)))!
    const key = `${blockKey(b.d, b.part)}|${x.reason}`
    const g = groups.get(key) ?? { block: `${DAY_WORDS[b.d]} ${partWords(b.part)}`, d: b.d, part: b.part, dir: b.dir, reason: x.reason, ...unmovedWords(x.reason, input.settings), cells: [] }
    g.cells.push(x.ref)
    groups.set(key, g)
  }
  const unmoved = [...groups.values()].sort((a, b) => a.d - b.d || a.part - b.part || a.reason.localeCompare(b.reason))
  /** "6 hours already at the plan's highest target (add a higher target to the plan); …" — counts per reason, the most first. */
  const reasonLines = (list: readonly UnmovedBlock[]) => {
    const byReason = new Map<UnmovedReason, number>()
    for (const g of list) byReason.set(g.reason, (byReason.get(g.reason) ?? 0) + g.cells.length)
    return [...byReason].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, n]) => { const w = unmovedWords(reason, input.settings); return `${plural(n, 'hour')} ${w.why} (${w.unblock})` }).join('; ')
  }
  const wanting = blocks.filter((b) => b.dir !== 'keep')
  const dirWords = (['down', 'minbid', 'up'] as const).map((dir) => { const n = wanting.filter((b) => b.dir === dir).length; return n ? `${n} ${dir === 'minbid' ? 'to Min bid' : dir}` : '' }).filter(Boolean).join(', ')

  const count = (pred: (c: CellChange) => boolean) => changes.filter(pred).length
  const toFloor = count((c) => !isFloor(c.from) && isFloor(c.to))
  const offFloor = count((c) => isFloor(c.from) && !isFloor(c.to))
  const ups = count((c) => !isFloor(c.from) && !isFloor(c.to) && targets.get(c.to!)!.placementPct > targets.get(c.from!)!.placementPct)
  const downs = changes.length - toFloor - offFloor - ups
  const summary: string[] = []
  summary.push(changes.length
    ? `Paints ${plural(changes.length, 'hour')} of the week (${[ups ? `${ups} up` : '', downs ? `${downs} down` : '', toFloor ? `${toFloor} to Min bid` : '', offFloor ? `${offFloor} out of Min bid` : ''].filter(Boolean).join(', ')}) in 4-hour blocks, between the plan's own targets (${ladder.serving.join(' < ')}${ladder.minBid ? `; Min bid: ${ladder.minBid}` : ''}), at most ${Math.round(cap * 100)} % of bid multiplier per hour (one step at least).`
    // A2c — nothing painted although blocks wanted to move: say how many and what holds each hour, never "inside the band".
    : wanting.length
      ? `Paints nothing although ${plural(wanting.length, 'block')} of the week ${wanting.length === 1 ? 'wants' : 'want'} to move (${dirWords}): ${reasonLines(unmoved)}.`
      : 'Paints nothing: every block of the week stays inside the goal\'s band, or too close to it to move.')
  // A2c — some hours moved, others of the moving blocks stayed for the ladder's own reasons (locks, limits and the anti-flap have their lines below).
  const ladderStays = changes.length ? unmoved.filter((g) => !['locked', 'lane', 'limit', 'anti-flap'].includes(g.reason)) : []
  if (ladderStays.length) summary.push(`Hours of the moving blocks that stay: ${reasonLines(ladderStays)}.`)
  if (input.locks.cells.size) summary.push(`${plural(input.locks.cells.size, 'hour')} locked by the Owner kept as they are${lockedTouched.size ? ` (${lockedTouched.size} of them the brain would have moved)` : ''}.`)
  if (input.locks.lanes.size) summary.push(`Lanes the Owner locked kept: ${[...input.locks.lanes].join(', ')} — a target that would change them is not taken${lanesRefused.size ? ` (${plural(lanesRefused.size, 'hour')} stay for that)` : ''}.`)
  if (limitWeek) summary.push(`Held to the Owner's own plan (hourPlanAsLimits): never above his target or placement % in an hour, his Min-bid hours stay${limited.length ? ` — ${plural(new Set(limited).size, 'hour')} held` : ''}.`)
  if (antiFlap.length) summary.push(`Anti-flap: ${antiFlap.map((a) => a.why).join('; ')}.`)
  if (ladder.missing.length) summary.push(`The plan names ${ladder.missing.map((k) => `"${k}"`).join(', ')}, which no longer exist: those hours are left as they are.`)
  if (research.confidence.thin) summary.push(`Thin product: the hours lean on the pooled curve (${research.confidence.words.split(';')[1]?.trim() ?? 'pooled'}); a thin product's interval is wide, so few hours clear a rule.`)
  const moneyLines: string[] = []
  if (effect) {
    const e = effect
    moneyLines.push(`Expected week: spend ${fmtMoney(e.before.spendCents)} → ${fmtMoney(e.after.spendCents.mid)} (${fmtMoney(e.after.spendCents.lo)} to ${fmtMoney(e.after.spendCents.hi)}), orders ${e.before.orders.toFixed(1)} → ${e.after.orders.mid.toFixed(1)} (${e.after.orders.lo.toFixed(1)} to ${e.after.orders.hi.toFixed(1)}), ACoS ${pctWords(e.before.acos)} → ${pctWords(e.after.acos?.mid ?? null)}${e.after.acos ? ` (${pctWords(e.after.acos.lo)}–${pctWords(e.after.acos.hi)})` : ''}.`)
    moneyLines.push(`Change a week: spend ${fmtSignedMoney(e.delta.spendCents.mid)} (${fmtSignedMoney(e.delta.spendCents.lo)} to ${fmtSignedMoney(e.delta.spendCents.hi)}), orders ${signed(e.delta.orders.mid)} (${signed(e.delta.orders.lo)} to ${signed(e.delta.orders.hi)}).`)
  }
  return {
    held: null, ladder: { serving: ladder.serving, minBid: ladder.minBid }, blocks, week: { before, after }, changes,
    locked: [...input.locks.cells].sort(), limited: [...new Set(limited)].sort(), antiFlap, unmoved,
    windows: encoded?.windows ?? null, defaultTargetKey: encoded ? encoded.defaultTargetKey : input.plan.defaultTargetKey,
    effect, summary, money: moneyLines,
  }
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * The before / after grid as a person reads it (Monday first): one letter per hour (the legend names each target, `.` no
 * target), and a line marking the changed hours (`^`) and the locked ones (`#`). Pure.
 */
export function gridLines(painted: Pick<PaintedPlan, 'week' | 'changes' | 'locked'>, targets: ReadonlyMap<string, Pick<PaintTarget, 'name'>>): { days: Array<{ day: string; d: number; before: string; after: string; marks: string }>; legend: Record<string, string> } {
  const letterOf = new Map<string, string>()
  const letter = (k: string | null) => {
    if (k == null) return '.'
    if (!letterOf.has(k)) letterOf.set(k, LETTERS[letterOf.size] ?? '*')
    return letterOf.get(k)!
  }
  const changed = new Set(painted.changes.map((c) => c.cell))
  const locked = new Set(painted.locked)
  const days = [1, 2, 3, 4, 5, 6, 0].map((d) => ({
    day: DAY_WORDS[d], d,
    before: painted.week.before[d].map(letter).join(''),
    after: painted.week.after[d].map(letter).join(''),
    marks: Array.from({ length: 24 }, (_, h) => (changed.has(cellRef(d, h)) ? '^' : locked.has(cellRef(d, h)) ? '#' : ' ')).join(''),
  }))
  const legend: Record<string, string> = {}
  for (const [k, l] of letterOf) { const name = targets.get(k)?.name; legend[l] = name && name !== k ? `${k} (${name})` : k }
  return { days, legend }
}
