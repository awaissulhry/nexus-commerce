/**
 * LANE 5 (2026-10-10, "Amazon's free visibility numbers") — the bid brain holds a keyword at a target top-of-search
 * impression share (TOS IS), the Owner's `tosTargetPct` (brain/levers.ts; keyword > campaign > product, empty = off).
 * Owner decisions: D1 = A — hold the share at the target (raise below it, lower above it; the band top still cuts);
 * D2 = A — the keyword bid first; the top-of-search placement % moves only through the Owner's approved hourly plan.
 * Pure: no database, no clock (share-load.ts reads, decide.ts decides the layer).
 *
 *   reading   the keyword's own daily share (AD_TARGET rows of AmazonAdsDailyPerformance, the keyword-grain pass of
 *             ads-tos-is-ingest.service.ts), else the campaign's (CAMPAIGN rows) on single-target days only — a day the
 *             keyword holds at least 99 % of the campaign's impressions, so the campaign's share is the keyword's.
 *             Impression-weighted over the reading days after the brain's last share move, the newest 7 at most, in the
 *             last 14 days. A share is never called anything else; a weighted average says it is computed by Nexus.
 *   counts    only when the newest reading day is at most 4 days old, at least 2 reading days follow the last move, they
 *             hold at least 100 impressions, and no reading day was budget-capped (the campaign spent ≥ 95 % of its day's
 *             budget: the budget, not the bid, held the share). Otherwise it moves nothing and says why; right after its
 *             own move it waits (no other layer moves the bid meanwhile — the band top excepted), else the ACoS goal
 *             decides as without a target.
 *   move      below target − 5 points: raise one step min(maxChangePct, 10 %), capped at the band top's bid, the limits'
 *             highest bid and the top-of-search CPC ceiling ÷ ((1 + plan %) × Amazon dynamic bidding); above target + 5:
 *             lower one step, never below the limits' lowest bid; within ±5 points: hold. One move per new reading day.
 *             At a cap: the next lever is the top-of-search placement %, only with the Owner's approval of the painted
 *             hourly plan — never written here.
 */
import { dynamicOf, type Lane } from './recipe.js'

/** The dead zone around the target, percentage points. */
export const SHARE_DEAD_ZONE_PTS = 5
/** The largest share step, % of the bid (the strategy's largest change is the other cap). */
export const SHARE_STEP_MAX_PCT = 10
/** The reading's days: the newest this many after the last move. */
export const SHARE_MAX_READING_DAYS = 7
/** The reading counts with at least this many days after the last move. */
export const SHARE_MIN_READING_DAYS = 2
/** … and at least this many impressions over them. */
export const SHARE_MIN_IMPRESSIONS = 100
/** … and its newest day at most this many days old. */
export const SHARE_MAX_AGE_DAYS = 4
/** How far back the reading looks. */
export const SHARE_LOOKBACK_DAYS = 14
/** After its own move the layer waits for its reading days this long at most; then the ACoS goal decides again. */
export const SHARE_WAIT_DAYS = 7
/** A campaign-day that spent at least this share of its budget is budget-capped. */
export const BUDGET_CAPPED_SHARE = 0.95
/** A campaign-day counts for one keyword when that keyword holds at least this share of the campaign's impressions. */
export const SINGLE_TARGET_SHARE = 0.99
export const SHARE_NEXT_LEVER = 'the next lever is the top-of-search placement %, only with your approval of the painted hourly plan'

export type ShareGrain = 'keyword' | 'campaign'

/** One day of one keyword, as the reading reads it. Shares are 0–1 fractions (null: Amazon reported none). */
export interface ShareDay {
  day: string
  /** The keyword's AD_TARGET row that day (null: none). */
  keyword: { impressions: number; share: number | null } | null
  /** The campaign's CAMPAIGN row that day (null: none). `capped`: spent ≥ 95 % of the day's budget (null: budget not reported). */
  campaign: { impressions: number; share: number | null; capped: boolean | null } | null
}

export interface ShareReading {
  /** The share, % (0–100): Amazon's own on one day, else the impression-weighted average computed by Nexus. */
  pct: number
  grain: ShareGrain
  days: number
  impressions: number
  from: string
  to: string
}

/** The brain's last share move on a keyword (BidBrainDecision.evidence.share.lastMove). */
export interface ShareMove {
  /** The UTC day of the run that moved it; reading days count from the day after. */
  moveDay: string
  dataDay: string
  /** The newest reading day the move rested on. */
  readingTo: string | null
  fromCents: number
  toCents: number
}

/** What the share layer knows about one keyword (absent: no target, the layer is off). */
export interface ShareFacts {
  /** The target share, % (5–95). */
  targetPct: number
  /** Who set it: "the Owner's keyword override (user:x, 2026-10-09)". */
  targetBy: string
  reading: ShareReading | null
  /** Why the reading does not count; null: it counts. */
  held: string | null
  /** The hold is the wait after the brain's own move. */
  waiting: boolean
  lastMove: ShareMove | null
}

const DAY_MS = 86_400_000
const shift = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10)
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
const n0 = (x: number) => Math.round(x).toLocaleString('en-US')

/** A share in %, never "0.00%" for a share above zero: below 0.01 % it is "<0.01%". */
export function sharePct(pct: number): string {
  if (pct > 0 && pct < 0.01) return '<0.01%'
  if (pct < 1) return `${Math.round(pct * 100) / 100}%`
  return `${Math.round(pct * 10) / 10}%`
}

/** The reading in words: its share, who computed it, the grain, the days, the range, the impressions. */
export function readingWords(r: ShareReading): string {
  const grain = r.grain === 'keyword' ? 'keyword grain' : 'campaign grain, on days the campaign served this keyword alone'
  if (r.days === 1) return `top-of-search impression share ${sharePct(r.pct)} (Amazon's, ${grain}, 1 reading day ${r.from}, ${n0(r.impressions)} impressions)`
  return `top-of-search impression share ${sharePct(r.pct)} (computed by Nexus: the impression-weighted average of Amazon's daily shares, ${grain}, ${r.days} reading days ${r.from} to ${r.to}, ${n0(r.impressions)} impressions)`
}

/**
 * One keyword's reading on `today` (the run's UTC day): the reading days after its last move, the grain, and whether it
 * counts (`held` null) — else why not, and whether that is the wait after its own move. Pure.
 */
export function shareReadingOf(days: readonly ShareDay[], opts: { today: string; lastMove?: ShareMove | null }): { reading: ShareReading | null; held: string | null; waiting: boolean } {
  const { today } = opts
  const lastMove = opts.lastMove ?? null
  const since = shift(today, -SHARE_LOOKBACK_DAYS)
  const inWindow = days.filter((d) => d.day < today && d.day >= since && (!lastMove || d.day > lastMove.moveDay))
  type Used = { day: string; share: number; impressions: number; capped: boolean | null }
  const kw: Used[] = inWindow
    .filter((d) => d.keyword && d.keyword.share != null && d.keyword.impressions > 0)
    .map((d) => ({ day: d.day, share: d.keyword!.share!, impressions: d.keyword!.impressions, capped: d.campaign?.capped ?? null }))
  const grain: ShareGrain = kw.length ? 'keyword' : 'campaign'
  const all = kw.length ? kw : inWindow
    .filter((d) => d.campaign && d.campaign.share != null && d.campaign.impressions > 0 && d.keyword && d.keyword.impressions > 0 && d.keyword.impressions >= SINGLE_TARGET_SHARE * d.campaign.impressions)
    .map((d) => ({ day: d.day, share: d.campaign!.share!, impressions: d.campaign!.impressions, capped: d.campaign!.capped }))
  const used = [...all].sort((a, b) => b.day.localeCompare(a.day)).slice(0, SHARE_MAX_READING_DAYS)
  const impressions = used.reduce((n, u) => n + u.impressions, 0)
  const reading: ShareReading | null = used.length && impressions > 0
    ? { pct: (used.reduce((n, u) => n + u.share * u.impressions, 0) / impressions) * 100, grain, days: used.length, impressions, from: used[used.length - 1].day, to: used[0].day }
    : null

  const after = lastMove ? ` after its share move on ${lastMove.moveDay} (${lastMove.fromCents}¢ → ${lastMove.toCents}¢)` : ''
  if (lastMove && daysBetween(lastMove.moveDay, today) <= SHARE_WAIT_DAYS && used.length < SHARE_MIN_READING_DAYS) {
    return { reading, held: `waits for ${SHARE_MIN_READING_DAYS} reading days${after} (${used.length} so far)`, waiting: true }
  }
  if (!reading) {
    return { reading: null, held: `no top-of-search impression share reading — none at keyword grain, nor at campaign grain on a day the campaign served this keyword alone, ${lastMove ? `in the days to ${shift(today, -1)}${after}` : `in the ${SHARE_LOOKBACK_DAYS} days ${since} to ${shift(today, -1)}`}`, waiting: false }
  }
  const age = daysBetween(reading.to, today)
  if (age > SHARE_MAX_AGE_DAYS) return { reading, held: `the newest reading day ${reading.to} is ${age} days old (at most ${SHARE_MAX_AGE_DAYS})`, waiting: false }
  if (used.length < SHARE_MIN_READING_DAYS) return { reading, held: `${used.length} reading day${after} — it needs ${SHARE_MIN_READING_DAYS}`, waiting: false }
  if (impressions < SHARE_MIN_IMPRESSIONS) return { reading, held: `${n0(impressions)} impressions over the reading days — it needs ${SHARE_MIN_IMPRESSIONS}`, waiting: false }
  const capped = used.filter((u) => u.capped === true).map((u) => u.day).sort()
  if (capped.length) return { reading, held: `the campaign spent at least ${Math.round(BUDGET_CAPPED_SHARE * 100)} % of its budget on ${capped.join(', ')}: the budget, not the bid, held the share`, waiting: false }
  return { reading, held: null, waiting: false }
}

/** A cap on a share raise, in words ("the bid where the expected ACoS meets the band top 28%"). */
export interface ShareCap { cents: number; from: string }

/**
 * BB-18's bid stack on the top-of-search lane: its CPC ceiling ÷ ((1 + the plan's placement %) × Amazon's dynamic bidding)
 * — the highest base bid the lane's ceiling allows at this hour's placement. Null: no lane or no ceiling.
 */
export function tosLaneCap(lanes: readonly Lane[] = []): ShareCap | null {
  const top = lanes.find((l) => l.lane === 'TOP_OF_SEARCH')
  const ceiling = top ? top.baseCeilingCents ?? top.maxCpcCents ?? null : null
  if (!top || ceiling == null || ceiling <= 0) return null
  const p = Math.max(0, top.planPct)
  const dyn = dynamicOf(top)
  return { cents: Math.floor(ceiling / ((1 + p / 100) * dyn)), from: `the top-of-search CPC ceiling ${ceiling}¢ ÷ (1 + ${p} % placement)${dyn > 1 ? ` ÷ ×${dyn} Amazon dynamic bidding` : ''}` }
}

export type ShareMoveResult =
  | { dir: 'raise'; cents: number; stepPct: number; capped: ShareCap | null }
  | { dir: 'lower'; cents: number; stepPct: number; capped: ShareCap | null }
  | { dir: 'hold'; cents: number; stepPct: number; why: 'dead_zone' | 'at_cap' | 'at_floor' | 'no_step'; capped: ShareCap | null }

/** The step toward the target from today's bid (D1 = A): raise below, lower above, hold within ±5 points. Pure. */
export function shareMove(args: { currentCents: number; reading: Pick<ShareReading, 'pct'>; targetPct: number; maxChangePct: number; caps: readonly (ShareCap | null)[]; floorCents: number }): ShareMoveResult {
  const cur = args.currentCents
  const stepPct = Math.min(Math.max(0, args.maxChangePct), SHARE_STEP_MAX_PCT)
  const gap = args.reading.pct - args.targetPct
  if (Math.abs(gap) <= SHARE_DEAD_ZONE_PTS) return { dir: 'hold', cents: cur, stepPct, why: 'dead_zone', capped: null }
  if (stepPct <= 0) return { dir: 'hold', cents: cur, stepPct, why: 'no_step', capped: null }
  if (gap < 0) {
    const caps = args.caps.filter((c): c is ShareCap => !!c && Number.isFinite(c.cents))
    const cap = caps.length ? caps.reduce((a, b) => (b.cents < a.cents ? b : a)) : null
    let want = Math.round(cur * (1 + stepPct / 100))
    if (want <= cur) want = cur + 1
    let capped: ShareCap | null = null
    if (cap && want > Math.floor(cap.cents)) { want = Math.floor(cap.cents); capped = cap }
    if (want <= cur) return { dir: 'hold', cents: cur, stepPct, why: 'at_cap', capped: cap }
    return { dir: 'raise', cents: want, stepPct, capped }
  }
  let want = Math.round(cur * (1 - stepPct / 100))
  if (want >= cur) want = cur - 1
  if (want < args.floorCents) want = args.floorCents
  if (want >= cur) return { dir: 'hold', cents: cur, stepPct, why: 'at_floor', capped: null }
  return { dir: 'lower', cents: want, stepPct, capped: null }
}

/**
 * The move the brain stores after a share write (evidence.share.lastMove); the previous one otherwise. Integration review
 * fix — `applied`: the write went through (queued at Amazon) or the campaign is in shadow; a LIVE write the gate, the dial,
 * the caps or the kill switch kept back is no move (the next run may still move). Pure.
 */
export function nextLastMove(d: { layer: string; action: string; currentCents: number; bidCents: number; dataDay: string }, share: ShareFacts, today: string, applied = true): ShareMove | null {
  if (!applied || d.layer !== 'share' || d.action !== 'write' || d.bidCents === d.currentCents) return share.lastMove
  return { moveDay: today, dataDay: d.dataDay, readingTo: share.reading?.to ?? null, fromCents: d.currentCents, toCents: d.bidCents }
}

/** What a stored decision keeps of the share layer (BidBrainDecision.evidence.share). Pure. */
export function shareEvidence(d: { layer: string; action: string; currentCents: number; bidCents: number; dataDay: string }, share: ShareFacts, today: string, applied = true): Record<string, unknown> {
  return {
    targetPct: share.targetPct, targetBy: share.targetBy, reading: share.reading, held: share.held, waiting: share.waiting,
    lastMove: nextLastMove(d, share, today, applied),
  }
}

/** Whether a decision's write took effect for the share layer's memory: a shadow campaign's always, a LIVE one's only when queued. Pure. */
export const shareMoveApplied = (live: boolean, outcome: { sent: string } | undefined): boolean => !live || outcome?.sent === 'queued'

/** A stored lastMove read back (null: none, or not well formed). Pure. */
export function readLastMove(raw: unknown): ShareMove | null {
  const m = raw as Partial<ShareMove> | null
  if (!m || typeof m !== 'object') return null
  const day = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  if (!day(m.moveDay) || typeof m.fromCents !== 'number' || typeof m.toCents !== 'number') return null
  return { moveDay: m.moveDay!, dataDay: day(m.dataDay) ? m.dataDay! : m.moveDay!, readingTo: day(m.readingTo) ? m.readingTo! : null, fromCents: m.fromCents, toCents: m.toCents }
}
