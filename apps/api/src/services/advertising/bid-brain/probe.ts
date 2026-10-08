/**
 * BID BRAIN BB-21 (design BRAIN-UPGRADES-DESIGN.md U2 "Learning ε" and U3 "Switchback probes") — switchback probes that
 * measure a keyword's bid elasticity ε for the response model (response.ts). SHADOW FIRST.
 *
 *   probe      one keyword for 12 days from its start (the serving day in the market's own zone): four periods of 3 days
 *              on two arms, the brain's bid at the start ± δ (δ = 15 % of it, 5 % on a protected, brand or winner term), in
 *              a trend-balanced order — HLLH or LHHL, so a steady drift cancels — the two orders alternating among one
 *              product's probes of a day (half sit high while half sit low: the design's matched halves). Budget-neutral:
 *              6 days on each arm, symmetric in cents, so the average bid over the probe is the brain's bid exactly
 *   picked     a keyword the goal holds (layer goal or band, no write: a moving keyword is no clean base) with ≥ 20 clicks
 *              a week, in the products whose ε is least certain first (posterior sd), then by traffic; one probe at a time
 *              per keyword, 28 days of rest after one ends, at most 2 starts per product a week. The arms stay inside the
 *              limits, the high one under the band top's and break-even's bid, one switch H ↔ L within the strategy's
 *              largest change, and the high arm's expected extra spend a day ≤ 100¢ (at ε + 1 sd): δ shrinks to fit, and
 *              under ±4 % or 2¢ there is no room
 *   never      under an override (stop, pin, stock, freeze, phase, Min-bid hour, the money brake), a raise cap, a rule's
 *              ceiling or floor, a brake, in a budget-capped campaign (a raise buys no clicks there: it would measure the
 *              budget), in a campaign the Owner keeps away from the brain, or in a product whose ε is measured (sd < 0.25)
 *   a day      every full run sets the day's arm. A stop, stock, a phase floor, the money brake, a give-back, a raise cap,
 *              a rule or a brake deciding instead makes the day not count; a Min-bid hour holds its floor for its hours
 *              (the same hours on both arms, and its give-back returns to the arm), so the day still counts. A person's
 *              bid (a pin) or auto-undo's freeze ends the probe — theirs stands; so do an arm outside today's limits, a
 *              keyword that lost its goal, and too few clean days left. The first day of a period that switches arms is a
 *              washout (the switch lands inside the day) and never counts. A LIVE day counts only once a run found the arm
 *              in place (the bid written, not refused, deferred or clamped); an arm found missing after a run set it that
 *              day makes the day not count
 *   measured   3 days after its last day (the clicks are in): per arm the clean days' clicks, impressions, cost and orders;
 *                ε̂ = [ln((c_H + ½) ÷ d_H) − ln((c_L + ½) ÷ d_L)] ÷ ln(H ÷ L)
 *              with a Poisson variance widened by the days' own over-dispersion (quasi-Poisson, φ ≥ 1); ≥ 3 clean days a
 *              side, else STOPPED
 *   ε update   the reading updates its product's ε by a normal (precision-weighted) update of the posterior the run found
 *              (`epsPrior` → `epsPosterior`, stored on the probe); the response model pools every DONE live probe of the
 *              market with the natural moves (response.ts productEps)
 *
 *   NEXUS_BID_BRAIN_PROBES = off · shadow (default) · on
 *     off     nothing is read or written
 *     shadow  probes are planned, followed and measured in the ledger (mode SHADOW: both arms served the same bid, so the
 *             measurement is a placebo — a check of the design's noise — and never feeds ε); the stored why says "probe
 *             (shadow): would bid …"; every decision, write and step stays the brain's, byte for byte
 *     on      for a campaign the brain owns, a probe is LIVE: the day's arm replaces the goal's decision (layer `probe`, an
 *             honest why with the goal's own why in brackets); a campaign it does not own keeps shadow probes
 *
 * Pure: no database, no clock. The loaders and the ledger are probe-store.ts.
 */
import type { Decision, TargetFacts } from './decide.js'
import type { AdGroupRow } from './facts.js'
import { applyLaneDirectives, bidForAcos, DEFAULT_MAX_CHANGE_PCT, limitRange, placementsFor } from './recipe.js'
import { EPS_MEASURED_SD, EPS_PRIOR, goalContext, updateNormal, type EpsReading, type Normal } from './response.js'
import { extraSpend, seedOf } from './explore.js'

export type ProbeMode = 'off' | 'shadow' | 'on'

/** The switch. Anything unrecognised is shadow: no bid changes by accident. */
export function probeMode(env: string | undefined = process.env.NEXUS_BID_BRAIN_PROBES): ProbeMode {
  const v = (env ?? '').trim().toLowerCase()
  if (v === 'off' || v === '0' || v === 'false') return 'off'
  if (v === 'on' || v === '1' || v === 'true') return 'on'
  return 'shadow'
}

/** ±15 % around the brain's bid (design U3); a protected, brand or winner term only ±5 %. */
export const PROBE_AMPLITUDE = 0.15
export const PROTECTED_AMPLITUDE = 0.05
/** Under ±4 % (or 2¢) a probe is lost in the noise: no room. */
export const MIN_AMPLITUDE = 0.04
export const MIN_DELTA_CENTS = 2
export const PERIOD_DAYS = 3
/** Trend-balanced orders (ABBA): a steady drift over the 12 days cancels between the arms. */
export const SEQUENCES = ['HLLH', 'LHHL'] as const
export const PROBE_DAYS = PERIOD_DAYS * SEQUENCES[0].length
/** Enough traffic: ≥ 20 clicks a week over the last 14 days (design U3). */
export const MIN_WEEKLY_CLICKS = 20
export const TRAFFIC_DAYS = 14
export const MAX_STARTS_PER_PRODUCT_WEEK = 2
export const REST_DAYS = 28
export const MIN_CLEAN_DAYS = 3
/** Days after the last one before it is measured (its clicks are in; clicks need no attribution wait). */
export const SETTLE_DAYS = 3
/** The high arm's expected extra spend a day, at most (cents). */
export const DAILY_EXTRA_CAP_CENTS = 100
/** Ended probes are kept a year: their readings are what ε rests on. */
export const KEEP_DAYS = 365

/** The layers whose decision an arm may stand in for (an override, a give-back or a brake decides instead). */
export const PROBE_LAYERS: ReadonlySet<string> = new Set(['goal', 'band', 'limit'])

export type Arm = 'H' | 'L'
export type ProbeStatus = 'RUNNING' | 'MEASURING' | 'DONE' | 'STOPPED'
export type ProbeLedgerMode = 'SHADOW' | 'LIVE'
export const ACTIVE_STATUSES: readonly ProbeStatus[] = ['RUNNING', 'MEASURING']

/** One serving day of a probe, as the runs of the day recorded it. */
export interface ProbeDay {
  arm: Arm
  bidCents: number
  /** Every run of the day set the arm (or, in shadow, would have): the day counts unless it is a washout. */
  served: boolean
  /** What decided instead and made the day not count (the first one of the day). */
  yielded?: string
  /** A Min-bid hour held its floor in a run of the day (the day still counts). */
  minBid?: true
  /** LIVE: a run of the day found the arm in place (the keyword's bid was the arm): only a confirmed day counts. */
  confirmed?: true
}

/** A day that counts: served by every run of it and, for a LIVE probe, found in place (never a washout: the caller). */
export const dayCounts = (mode: ProbeLedgerMode, d: ProbeDay | undefined): boolean => d?.served === true && (mode !== 'LIVE' || d.confirmed === true)

export interface ArmObserved { days: number; clicks: number; impressions: number; costCents: number; orders: number }
export interface ProbeObserved {
  H: ArmObserved
  L: ArmObserved
  /** Washout days and days that did not count (a stop, a brake …, or no run). */
  washout: number
  notCounted: number
  /** The quasi-Poisson over-dispersion of the days' clicks (≥ 1). */
  dispersion: number
  /** The serving day it was measured on. */
  asOf: string
}

/** One probe as the ledger keeps it (probe-store.ts maps the BidProbe row to and from this). */
export interface ProbeRecord {
  id: string
  marketplace: string
  campaignId: string
  adGroupId: string
  targetId: string
  /** The pool its reading feeds: the product key (its ad group's families, joined), null: none known (the market only). */
  productKey: string | null
  mode: ProbeLedgerMode
  status: ProbeStatus
  centerCents: number
  highCents: number
  lowCents: number
  amplitude: number
  /** protected-term | brand | winner — why its amplitude is the small one; null: none. */
  protection: string | null
  sequence: string
  startDay: string
  endDay: string
  days: Record<string, ProbeDay>
  observed: ProbeObserved | null
  reading: EpsReading | null
  /** Its product's ε before the reading, and after (null: no reading). */
  epsPrior: Normal | null
  epsPosterior: Normal | null
  why: string
  stoppedWhy: string | null
}

const DAY_MS = 86_400_000
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS)
export const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
const pct = (f: number) => `${Math.round(f * 1000) / 10}%`
const r2 = (x: number) => Math.round(x * 100) / 100

/** The product key of an ad group, as the response pools it (its families, sorted and joined); null: none known. */
export const productKeyOfGroup = (g: Pick<AdGroupRow, 'families'> | undefined): string | null => (g?.families.length ? g.families.join('|') : null)

// ── The schedule ──────────────────────────────────────────────────────────────────────────────────

export interface ScheduleDay { day: string; index: number; period: number; arm: Arm; washout: boolean }

/** The probe's day `day`: its index (0 = the start), arm and whether it is a washout; null outside the 12 days. */
export function scheduleDay(sequence: string, startDay: string, day: string): ScheduleDay | null {
  const index = daysBetween(startDay, day)
  if (!(index >= 0 && index < sequence.length * PERIOD_DAYS)) return null
  const period = Math.floor(index / PERIOD_DAYS)
  const arm = sequence[period] as Arm
  return { day, index, period, arm, washout: index % PERIOD_DAYS === 0 && (period === 0 || sequence[period - 1] !== arm) }
}

/** Every day of the schedule. */
export function scheduleOf(sequence: string, startDay: string): ScheduleDay[] {
  return Array.from({ length: sequence.length * PERIOD_DAYS }, (_, i) => scheduleDay(sequence, startDay, addDays(startDay, i))!)
}

export const endDayOf = (sequence: string, startDay: string): string => addDays(startDay, sequence.length * PERIOD_DAYS - 1)

/** The average bid the schedule serves (cents): the brain's bid exactly, for symmetric arms. */
export function averageBid(p: Pick<ProbeRecord, 'sequence' | 'highCents' | 'lowCents'>): number {
  const days = scheduleOf(p.sequence, '2000-01-01')
  return days.reduce((s, d) => s + (d.arm === 'H' ? p.highCents : p.lowCents), 0) / days.length
}

/**
 * The order of a new probe: the first of a product's starts on a day takes HLLH or LHHL by a seed of the product and the
 * day, the next one the other, and so on — so half of a product's probes sit high while half sit low.
 */
export function sequenceFor(productKey: string | null, startDay: string, nth: number): string {
  return SEQUENCES[(seedOf(`${productKey ?? '-'}|${startDay}`) + nth) % SEQUENCES.length]
}

// ── The arms ──────────────────────────────────────────────────────────────────────────────────────

export interface Bound { cents: number; words: string }

/**
 * The two arms around `centerCents`: δ = round(center × amplitude), held under each upper bound (the high arm) and above
 * the lower one (the low arm), within a switch's largest change, then shrunk until the high arm's expected extra spend a
 * day (`extraAt(δ)`) fits the cap. Symmetric in cents: the average of the arms is the center exactly.
 */
export function probeArms(a: {
  centerCents: number
  amplitude: number
  uppers: readonly Bound[]
  lower: Bound
  /** The strategy's largest change per action (percent): one switch H ↔ L stays within it. */
  maxChangePct: number
  extraAt?: (deltaCents: number) => number
  capCents?: number
}): { deltaCents: number; highCents: number; lowCents: number; amplitude: number; held: string | null } | { none: string } {
  const c = a.centerCents
  if (!(c > 0)) return { none: 'no bid to probe around' }
  let delta = Math.round(c * a.amplitude)
  let held: string | null = null
  const m = Math.max(0, a.maxChangePct) / 100
  const switchCap = m < 2 ? Math.floor((c * m) / (2 - m)) : delta
  if (delta > switchCap) { delta = switchCap; held = `one switch within the largest change ${Math.round(m * 100)}%` }
  for (const u of a.uppers) {
    if (Number.isFinite(u.cents) && c + delta > u.cents) { delta = Math.floor(u.cents - c); held = u.words }
  }
  if (c - delta < a.lower.cents) { delta = c - a.lower.cents; held = a.lower.words }
  const cap = a.capCents ?? DAILY_EXTRA_CAP_CENTS
  if (a.extraAt) {
    while (delta >= MIN_DELTA_CENTS && a.extraAt(delta) > cap) { delta -= 1; held = `the ${cap}¢ a day spend cap` }
  }
  if (delta < MIN_DELTA_CENTS || delta < c * MIN_AMPLITUDE - 1e-9) {
    return { none: `no room to probe: ±${Math.max(0, delta)}¢ around ${c}¢${held ? ` (held to ${held})` : ''} is under ±${pct(MIN_AMPLITUDE)} or ${MIN_DELTA_CENTS}¢` }
  }
  return { deltaCents: delta, highCents: c + delta, lowCents: c - delta, amplitude: Math.round((delta / c) * 10_000) / 10_000, held }
}

// ── When an arm may stand in ──────────────────────────────────────────────────────────────────────

/**
 * Why the day's arm cannot stand in for this decision: `end` (the probe ends — a person's bid, auto-undo's freeze, a lost
 * goal), `yield` (another layer decides: the day does not count), `floor` (a Min-bid hour: its floor, the day still
 * counts), or null (the arm stands in).
 */
export function probeVerdict(f: TargetFacts, d: Pick<Decision, 'layer' | 'action'>): { kind: 'end' | 'yield' | 'floor'; words: string } | null {
  const o = f.overrides ?? {}
  if (o.pin) return { kind: 'end', words: `a person's or a held bid (${o.pin.by}) — it stands` }
  if (o.freeze) return { kind: 'end', words: `auto-undo froze the campaign (${o.freeze.by})` }
  if (d.layer === 'no_goal') return { kind: 'end', words: 'the keyword has no goal any more' }
  if (d.layer === 'min_bid_hour') return { kind: 'floor', words: 'a Min-bid hour holds its floor' }
  if (d.layer === 'brake') return { kind: 'yield', words: `a brake (${(f.brakes ?? []).join('; ') || 'nothing written'})` }
  if (!PROBE_LAYERS.has(d.layer)) return { kind: 'yield', words: `the ${d.layer.replace('_', '-')} layer decides` }
  if (f.raiseCap) return { kind: 'yield', words: `raises wait (${f.raiseCap})` }
  if (f.directives?.length) return { kind: 'yield', words: 'a rule\'s ceiling or floor steers it' }
  if (Object.values(o).some((v) => v != null)) return { kind: 'yield', words: 'an override applies' }
  return null
}

// ── Planning ──────────────────────────────────────────────────────────────────────────────────────

/** What the store brings for one keyword the run decided. */
export interface ProbeCandidate {
  f: TargetFacts
  /** The run's final decision for it (after exploration). */
  d: Decision
  campaignId: string
  adGroupId: string
  productKey: string | null
  /** Clicks of the last 14 days, to yesterday. */
  clicks14: number
  /** Its product's ε posterior (the response's, or the prior with the probes' readings). */
  eps: Normal
  protection: string | null
  /** Its campaign spent ≥ 95 % of its budget on 3 of the last 7 settled days. */
  capped: boolean
  /** Why the Owner keeps the brain off its campaign; null: he does not. */
  ownerBrake: string | null
  /** The mode a probe of it would have: LIVE when the switch is on and the brain owns its campaign. */
  mode: ProbeLedgerMode
}

export interface ProbeOption {
  targetId: string
  campaignId: string
  adGroupId: string
  productKey: string | null
  mode: ProbeLedgerMode
  centerCents: number
  highCents: number
  lowCents: number
  amplitude: number
  protection: string | null
  clicks14: number
  epsSd: number
  eps: Normal
  /** The high arm's expected extra spend a day (cents, at ε + 1 sd). */
  extraCents: number
  held: string | null
}
export interface ProbeSkip { targetId: string; why: string }
export const isProbeOption = (x: ProbeOption | ProbeSkip): x is ProbeOption => 'centerCents' in x

/** The ledger as planning needs it: keywords in a probe now, and when each one's rest ends (per mode). */
export interface PlanLedger {
  active: ReadonlySet<string>
  /** targetId|mode → the first day it may start again. */
  restUntil: ReadonlyMap<string, string>
  /** productKey|mode → probes started in the last 7 days (and today's, for the order). */
  startsWeek: ReadonlyMap<string, number>
  startsToday: ReadonlyMap<string, number>
}

const keyOf = (a: string | null, mode: ProbeLedgerMode) => `${a ?? '-'}|${mode}`
export const restKey = (targetId: string, mode: ProbeLedgerMode): string => keyOf(targetId, mode)
export const productModeKey = (productKey: string | null, mode: ProbeLedgerMode): string => keyOf(productKey, mode)

/** One keyword: a probe it could start today, or why not. */
export function probeOption(c: ProbeCandidate, ledger: Pick<PlanLedger, 'active' | 'restUntil'>, today: string): ProbeOption | ProbeSkip {
  const { f, d } = c
  const skip = (why: string): ProbeSkip => ({ targetId: f.targetId, why })
  if (ledger.active.has(f.targetId)) return skip('in a probe already')
  const verdict = probeVerdict(f, d)
  if (verdict) return skip(verdict.words)
  if (d.layer === 'limit' || d.action !== 'hold') return skip('the goal still moves it (no clean base)')
  if (d.goal == null || d.goalBidCents == null) return skip('no goal bid')
  if (c.ownerBrake) return skip(`the Owner keeps the brain off its campaign (${c.ownerBrake})`)
  if (c.capped) return skip('budget capped: a raise buys no clicks there')
  const weekly = (c.clicks14 * 7) / TRAFFIC_DAYS
  if (weekly < MIN_WEEKLY_CLICKS) return skip(`${Math.round(weekly)} clicks a week (under ${MIN_WEEKLY_CLICKS})`)
  if (c.eps.sd < EPS_MEASURED_SD) return skip(`its product's ε is measured (± ${r2(c.eps.sd)})`)
  const rest = ledger.restUntil.get(restKey(f.targetId, c.mode))
  if (rest && today < rest) return skip(`resting after its last probe until ${rest}`)
  const ctx = goalContext(f)
  if (!ctx) return skip('no goal')
  const node = ctx.est.node
  const center = d.bidCents
  const range = limitRange(f.limits, f.lanes)
  const uppers: Bound[] = [{ cents: bidForAcos(ctx.goal.hi, node.cr, ctx.aov, ctx.ratio) * ctx.factor, words: `the band top ${pct(ctx.goal.hi)}` }]
  const be = f.goal.breakEvenAcos != null && f.goal.breakEvenAcos > 0 ? f.goal.breakEvenAcos : null
  if (be != null) uppers.push({ cents: bidForAcos(be, node.cr, ctx.aov, ctx.ratio) * ctx.factor, words: `break-even ${pct(be)}` })
  if (range.upper != null) uppers.push({ cents: range.upper, words: range.upperFrom ?? 'the highest bid' })
  const c0 = c.clicks14 / TRAFFIC_DAYS
  const cautious = c.eps.mean + c.eps.sd
  const extraAt = (delta: number) => extraSpend({ ratio: ctx.ratio, c0, bid: center + delta, base: center, today: center, eps: cautious })
  const arms = probeArms({
    centerCents: center, amplitude: c.protection ? PROTECTED_AMPLITUDE : PROBE_AMPLITUDE, uppers,
    lower: { cents: range.lower, words: range.lowerFrom }, maxChangePct: f.limits.maxChangePct ?? DEFAULT_MAX_CHANGE_PCT, extraAt,
  })
  if ('none' in arms) return skip(arms.none)
  return {
    targetId: f.targetId, campaignId: c.campaignId, adGroupId: c.adGroupId, productKey: c.productKey, mode: c.mode,
    centerCents: center, highCents: arms.highCents, lowCents: arms.lowCents, amplitude: arms.amplitude, protection: c.protection,
    clicks14: c.clicks14, epsSd: c.eps.sd, eps: c.eps, extraCents: extraAt(arms.deltaCents), held: arms.held,
  }
}

/** A probe the plan starts today. */
export interface PlannedProbe extends ProbeOption { sequence: string; startDay: string; endDay: string; why: string }

/**
 * Today's starts: the products whose ε is least certain first (posterior sd), then the busiest keywords (ties by id); at
 * most MAX_STARTS_PER_PRODUCT_WEEK starts per product (and mode) in 7 days. Each product's starts of a day alternate
 * HLLH / LHHL. The rest are left with the cap in their words.
 */
export function planProbes(items: ReadonlyArray<ProbeOption | ProbeSkip>, ledger: Pick<PlanLedger, 'startsWeek' | 'startsToday'>, today: string): { started: PlannedProbe[]; capped: ProbeSkip[] } {
  const options = items.filter(isProbeOption)
  const order = [...options].sort((a, b) => b.epsSd - a.epsSd || b.clicks14 - a.clicks14 || (a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0))
  const week = new Map(ledger.startsWeek)
  const day = new Map(ledger.startsToday)
  const started: PlannedProbe[] = []
  const capped: ProbeSkip[] = []
  for (const o of order) {
    const key = productModeKey(o.productKey, o.mode)
    const n = week.get(key) ?? 0
    if (n >= MAX_STARTS_PER_PRODUCT_WEEK) { capped.push({ targetId: o.targetId, why: `its product started ${n} probes in 7 days (at most ${MAX_STARTS_PER_PRODUCT_WEEK})` }); continue }
    const nth = day.get(key) ?? 0
    const sequence = sequenceFor(o.productKey, today, nth)
    week.set(key, n + 1)
    day.set(key, nth + 1)
    const delta = o.highCents - o.centerCents
    const why = `ε of its product ${r2(o.eps.mean)} ± ${r2(o.eps.sd)} is the least certain it may test; ${Math.round((o.clicks14 * 7) / TRAFFIC_DAYS)} clicks a week; `
      + `±${delta}¢ (${pct(o.amplitude)}${o.protection ? `, small: a ${o.protection}` : ''}${o.held ? `, held to ${o.held}` : ''}) around ${o.centerCents}¢, `
      + `high days +${Math.round(o.extraCents)}¢ expected at most`
    started.push({ ...o, sequence, startDay: today, endDay: endDayOf(sequence, today), why })
  }
  return { started, capped }
}

// ── A run's step of a running probe ───────────────────────────────────────────────────────────────

export interface ProbeStepInput {
  p: ProbeRecord
  today: string
  /** The keyword's facts and final decision in this run; absent: another run decides it. */
  f?: TargetFacts
  d?: Decision
  /** The keyword is still among the market's allowlisted keywords. */
  known: boolean
  mode: ProbeMode
  /** The brain owns its campaign in this run. */
  owned: boolean
}

export interface ProbeStep {
  next: ProbeRecord
  changed: boolean
  /** A LIVE probe's arm that stands in for the decision today; null: none. */
  arm: { bidCents: number; arm: Arm; index: number; washout: boolean } | null
  /** Its words for the stored why; null: nothing to say. */
  note: string | null
  /** The measurement is due (the store reads the days, then calls finishProbe). */
  measure: boolean
}

const tagOf = (p: Pick<ProbeRecord, 'mode'>) => (p.mode === 'LIVE' ? 'probe' : 'probe (shadow)')

/** The clean days so far and the days still to come, per arm (washouts never count). */
export function cleanCounts(p: Pick<ProbeRecord, 'mode' | 'sequence' | 'startDay' | 'days'>, today: string): Record<Arm, { clean: number; toCome: number }> {
  const out: Record<Arm, { clean: number; toCome: number }> = { H: { clean: 0, toCome: 0 }, L: { clean: 0, toCome: 0 } }
  for (const s of scheduleOf(p.sequence, p.startDay)) {
    if (s.washout) continue
    if (s.day > today) out[s.arm].toCome += 1
    // Today may still be confirmed by a later run.
    else if (s.day === today ? p.days[s.day]?.served === true : dayCounts(p.mode, p.days[s.day])) out[s.arm].clean += 1
  }
  return out
}

/** Two records of a day alike (field by field: the ledger's JSON keeps no key order). */
const sameDay = (a: ProbeDay | undefined, b: ProbeDay): boolean =>
  !!a && a.arm === b.arm && a.bidCents === b.bidCents && a.served === b.served && (a.yielded ?? null) === (b.yielded ?? null) && !!a.minBid === !!b.minBid
  && !!a.confirmed === !!b.confirmed

/** The day's words for a running probe. */
function dayWords(p: ProbeRecord, s: ScheduleDay, bid: number): string {
  const delta = p.highCents - p.centerCents
  const would = p.mode === 'LIVE' ? '' : `would bid ${bid}¢ — `
  return `${would}day ${s.index + 1} of ${PROBE_DAYS}, the ${s.arm === 'H' ? 'high' : 'low'} arm (${p.centerCents}¢ ${s.arm === 'H' ? '+' : '−'} ${delta}¢)${s.washout ? ', a washout day' : ''}; `
    + `switchback ${p.sequence} from ${p.startDay}, budget-neutral: ${PROBE_DAYS / 2} days at ${p.highCents}¢ and ${PROBE_DAYS / 2} at ${p.lowCents}¢, average ${averageBid(p)}¢`
}

/**
 * One run's step of a probe: its end (the switch, ownership, a person, the limits, too few clean days left), the day's
 * record, the arm a LIVE probe sets, and whether its measurement is due. A rerun on the same facts changes nothing.
 */
export function stepProbe(input: ProbeStepInput): ProbeStep {
  const { p, today, f, d } = input
  const same: ProbeStep = { next: p, changed: false, arm: null, note: null, measure: false }
  if (p.status === 'DONE' || p.status === 'STOPPED') return same
  const end = (why: string): ProbeStep => ({ next: { ...p, status: 'STOPPED', stoppedWhy: why }, changed: true, arm: null, note: `${tagOf(p)}: stopped — ${why}`, measure: false })
  const s = scheduleDay(p.sequence, p.startDay, today)
  if (p.status === 'MEASURING' || (!s && today > p.endDay)) {
    // The schedule is over: measured once its last day's clicks are in, whatever the switch or the keyword did since.
    const next: ProbeRecord = p.status === 'RUNNING' ? { ...p, status: 'MEASURING' } : p
    return { next, changed: next !== p, arm: null, note: null, measure: daysBetween(p.endDay, today) > SETTLE_DAYS }
  }
  if (!s) return same
  if (!input.known) return end('the keyword left the brain (removed, archived or off the allowlist)')
  // A keyword another run decides (a product cycle's, or the full run's) is that run's to step.
  if (!f || !d) return same
  if (p.mode === 'LIVE' && input.mode !== 'on') return end('the switch is no longer on')
  if (p.mode === 'LIVE' && !input.owned) return end('the brain no longer owns the campaign')
  if (p.mode === 'SHADOW' && input.mode === 'on' && input.owned) return end('the switch went on: a live probe takes over')
  const bid = s.arm === 'H' ? p.highCents : p.lowCents
  const range = limitRange(f.limits, f.lanes)
  if (range.upper != null && bid > range.upper) return end(`the ${s.arm === 'H' ? 'high' : 'low'} arm ${bid}¢ is above ${range.upperFrom ?? 'the highest bid'} ${range.upper}¢ now`)
  if (bid < range.lower) return end(`the ${s.arm === 'H' ? 'high' : 'low'} arm ${bid}¢ is under ${range.lowerFrom} ${range.lower}¢ now`)
  const verdict = probeVerdict(f, d)
  if (verdict?.kind === 'end') return end(verdict.words)
  const prev = p.days[today]
  // LIVE: the arm stands in, so the keyword's bid should be it — unless this is the day's first run (it writes it now).
  const live = p.mode === 'LIVE' && !verdict
  const inPlace = live && f.currentCents === bid
  const missing = live && !inPlace && prev?.served === true && prev.bidCents === bid
  const yielded = verdict?.kind === 'yield' || missing
  const why = verdict?.kind === 'yield' ? verdict.words : missing ? `the arm ${bid}¢ was not in place at a later run (${f.currentCents}¢: a write refused, deferred or clamped)` : null
  const day: ProbeDay = {
    arm: s.arm, bidCents: bid, served: (prev?.served ?? true) && !yielded,
    ...(prev?.yielded || why ? { yielded: prev?.yielded ?? why! } : {}),
    ...(prev?.minBid || verdict?.kind === 'floor' ? { minBid: true as const } : {}),
    ...(prev?.confirmed || inPlace ? { confirmed: true as const } : {}),
  }
  const changed = !sameDay(prev, day)
  const next: ProbeRecord = changed ? { ...p, days: { ...p.days, [today]: day } } : p
  const counts = cleanCounts(next, today)
  const lacking = (['H', 'L'] as const).filter((a) => counts[a].clean + counts[a].toCome < MIN_CLEAN_DAYS)
  if (lacking.length) {
    const stopped = end(`too few clean days left (high ${counts.H.clean} + ${counts.H.toCome} to come, low ${counts.L.clean} + ${counts.L.toCome}; ${MIN_CLEAN_DAYS} a side needed)`)
    return { ...stopped, next: { ...stopped.next, days: next.days } }
  }
  const note = verdict
    ? `${tagOf(p)}: day ${s.index + 1} of ${PROBE_DAYS} ${verdict.kind === 'floor' ? 'still counts — a Min-bid hour holds its floor for its hours' : `does not count — ${verdict.words}`}`
    : missing ? `${tagOf(p)}: day ${s.index + 1} of ${PROBE_DAYS} does not count — ${why}; ${dayWords(p, s, bid)}`
      : `${tagOf(p)}: ${dayWords(p, s, bid)}`
  return { next, changed, arm: verdict ? null : { bidCents: bid, arm: s.arm, index: s.index, washout: s.washout }, note, measure: false }
}

// ── Measurement and the ε update ──────────────────────────────────────────────────────────────────

export interface DayRow { clicks: number; impressions: number; costCents: number; orders: number }

/**
 * Per arm, the clean days' clicks, impressions, cost and orders (`daily`: day → the keyword's row; a day with no row had
 * none), and — for a LIVE probe with ≥ 3 clean days a side — its reading of ε (quasi-Poisson).
 */
export function measureProbe(p: Pick<ProbeRecord, 'mode' | 'sequence' | 'startDay' | 'days' | 'highCents' | 'lowCents'>, daily: ReadonlyMap<string, DayRow>, asOf: string): { observed: ProbeObserved; reading: EpsReading | null; enough: boolean } {
  const zero = (): ArmObserved => ({ days: 0, clicks: 0, impressions: 0, costCents: 0, orders: 0 })
  const arms: Record<Arm, ArmObserved> = { H: zero(), L: zero() }
  const perDay: Record<Arm, number[]> = { H: [], L: [] }
  let washout = 0
  let notCounted = 0
  for (const s of scheduleOf(p.sequence, p.startDay)) {
    if (s.washout) { washout += 1; continue }
    if (!dayCounts(p.mode, p.days[s.day])) { notCounted += 1; continue }
    const r = daily.get(s.day)
    const a = arms[s.arm]
    a.days += 1
    a.clicks += r?.clicks ?? 0
    a.impressions += r?.impressions ?? 0
    a.costCents += r?.costCents ?? 0
    a.orders += r?.orders ?? 0
    perDay[s.arm].push(r?.clicks ?? 0)
  }
  // Over-dispersion: Pearson's χ² of the days around each arm's own mean, over its degrees of freedom.
  let chi = 0
  for (const a of ['H', 'L'] as const) {
    const m = arms[a].days ? arms[a].clicks / arms[a].days : 0
    if (m > 0) for (const c of perDay[a]) chi += ((c - m) * (c - m)) / m
  }
  const df = arms.H.days + arms.L.days - 2
  const dispersion = df > 0 ? Math.max(1, chi / df) : 1
  const round = (o: ArmObserved): ArmObserved => ({ ...o, costCents: Math.round(o.costCents), clicks: Math.round(o.clicks), impressions: Math.round(o.impressions), orders: Math.round(o.orders * 100) / 100 })
  const observed: ProbeObserved = { H: round(arms.H), L: round(arms.L), washout, notCounted, dispersion: Math.round(dispersion * 1000) / 1000, asOf }
  const enough = arms.H.days >= MIN_CLEAN_DAYS && arms.L.days >= MIN_CLEAN_DAYS
  if (!enough || p.mode !== 'LIVE' || !(p.highCents > p.lowCents && p.lowCents > 0)) return { observed, reading: null, enough }
  const lb = Math.log(p.highCents / p.lowCents)
  const lc = Math.log((arms.H.clicks + 0.5) / arms.H.days) - Math.log((arms.L.clicks + 0.5) / arms.L.days)
  const v = dispersion * (1 / (arms.H.clicks + 0.5) + 1 / (arms.L.clicks + 0.5))
  return { observed, reading: { eps: lc / lb, variance: v / (lb * lb) }, enough }
}

/**
 * The probe's end: DONE with what it observed and, for a LIVE probe, its reading and its product's ε updated by it (a
 * normal update of `prior`, the posterior the run found); STOPPED when a side has fewer than 3 clean days.
 */
export function finishProbe(p: ProbeRecord, m: { observed: ProbeObserved; reading: EpsReading | null; enough: boolean }, prior: Normal | null): ProbeRecord {
  if (!m.enough) return { ...p, status: 'STOPPED', observed: m.observed, stoppedWhy: `too few clean days (high ${m.observed.H.days}, low ${m.observed.L.days}; ${MIN_CLEAN_DAYS} a side needed)` }
  const before = prior ?? EPS_PRIOR
  return {
    ...p, status: 'DONE', observed: m.observed, reading: m.reading, epsPrior: { mean: r4(before.mean), sd: r4(before.sd) },
    epsPosterior: m.reading ? roundNormal(updateNormal(before, m.reading)) : null,
  }
}

const r4 = (x: number) => Math.round(x * 10_000) / 10_000
const roundNormal = (n: Normal): Normal => ({ mean: r4(n.mean), sd: r4(n.sd) })

/** A finished probe in words: "done — ε 0.62 ± 0.21 … its product's ε 0.80 ± 0.40 → 0.66 ± 0.18" (or the placebo). */
export function doneWords(p: ProbeRecord): string {
  const o = p.observed
  if (p.status === 'STOPPED') return `${tagOf(p)}: stopped — ${p.stoppedWhy ?? 'ended'}`
  if (!o) return `${tagOf(p)}: ${p.status.toLowerCase()}`
  const rate = (a: ArmObserved) => (a.days ? Math.round((a.clicks / a.days) * 10) / 10 : 0)
  const arms = `high ${p.highCents}¢: ${rate(o.H)} clicks a day over ${o.H.days} days, low ${p.lowCents}¢: ${rate(o.L)} over ${o.L.days}`
  if (!p.reading) {
    const ratio = rate(o.L) > 0 ? Math.round((rate(o.H) / rate(o.L)) * 100) / 100 : null
    return `${tagOf(p)}: done — a placebo (both arms served the same bid): ${arms}${ratio != null ? `, ratio ${ratio} (1 expected)` : ''}; no ε reading`
  }
  const sd = Math.sqrt(p.reading.variance)
  return `${tagOf(p)}: done — ε ${r2(p.reading.eps)} ± ${r2(sd)} (${arms}, dispersion ${o.dispersion})`
    + (p.epsPrior && p.epsPosterior ? `; its product's ε ${r2(p.epsPrior.mean)} ± ${r2(p.epsPrior.sd)} → ${r2(p.epsPosterior.mean)} ± ${r2(p.epsPosterior.sd)}` : '')
}

// ── `on`: the arm as the decision ─────────────────────────────────────────────────────────────────

/**
 * A LIVE probe's arm in place of the goal's decision: layer `probe`, written when it differs from today's bid, the step
 * recorded from the center (so the goal steps from the brain's own bid once the probe ends), the placements measured at
 * the arm. The goal's why stays in brackets.
 */
export function applyProbeArm(d: Decision, f: TargetFacts, p: Pick<ProbeRecord, 'centerCents'>, arm: { bidCents: number }, words: string): Decision {
  const lanes = applyLaneDirectives(f.lanes, f.laneDirectives)
  return {
    ...d,
    action: arm.bidCents !== d.currentCents ? 'write' : 'hold',
    layer: 'probe',
    bidCents: arm.bidCents,
    step: { dataDay: d.dataDay, fromCents: p.centerCents, toCents: arm.bidCents },
    placements: lanes.length && d.goal ? placementsFor(arm.bidCents, lanes, d.goal) : d.placements,
    why: `probe: ${words} (goal: ${d.why})`,
  }
}

/** A LIVE probe's arm for one keyword, as a run's step found it. */
export interface ProbeArm { p: Pick<ProbeRecord, 'centerCents'>; bidCents: number; words: string }

/**
 * `on`: each keyword with an arm gets applyProbeArm; every other decision is returned as it is. `off` / `shadow`, or no
 * arm: the very same array, untouched — the brain decides byte for byte as without probes.
 */
export function applyProbeArms(decisions: readonly Decision[], facts: readonly TargetFacts[], arms: ReadonlyMap<string, ProbeArm>, mode: ProbeMode): Decision[] {
  if (mode !== 'on' || !arms.size) return decisions as Decision[]
  return decisions.map((d, i) => {
    const a = arms.get(d.targetId)
    return a && facts[i]?.targetId === d.targetId ? applyProbeArm(d, facts[i], a.p, a, a.words) : d
  })
}

// ── The run line ──────────────────────────────────────────────────────────────────────────────────

export interface ProbeSummary {
  mode: ProbeMode
  /** Probes running after the run (LIVE among them), started by it, arms it set, measuring, done and stopped by it. */
  running: number
  live: number
  started: number
  armed: number
  measuring: number
  done: number
  stopped: number
}

/** "probes (shadow): 3 running (1 new), 1 measuring, 1 done" — nothing when nothing happened. */
export function probeSummaryWords(s: ProbeSummary | null | undefined): string {
  if (!s) return ''
  const parts = [
    `${s.running} running${s.started ? ` (${s.started} new)` : ''}${s.mode === 'on' && s.live ? `, ${s.live} live` : ''}`,
    s.armed ? `${s.armed} arm${s.armed === 1 ? '' : 's'} set` : '',
    s.measuring ? `${s.measuring} measuring` : '',
    s.done ? `${s.done} done` : '',
    s.stopped ? `${s.stopped} stopped` : '',
  ].filter(Boolean)
  return `probes${s.mode === 'on' ? '' : ` (${s.mode})`}: ${parts.join(', ')}`
}
