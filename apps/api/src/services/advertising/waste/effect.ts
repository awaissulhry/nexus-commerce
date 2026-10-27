/**
 * Negative Targeting page, step 4 (2026-10-25) — "Did it work?" on the Stopped view: the money a stop saved
 * since it was made. Pure: stopped.ts reads the spend of each stopped row's own place and gives it here.
 *
 *   days      whole days since the stop (`since`: the hold, the pause on record, the add of the negative — stopped.ts)
 *   too early under EFFECT_MIN_DAYS days: TOO_EARLY, and no money claim (no before, no after, no saving)
 *   before    the spend per day over the min(days, EFFECT_BEFORE_DAYS) days before the stop day: our keyword's own spend
 *             (paused, kept paused), or the spend of the words a negative blocks in its place (its ad group, or every ad
 *             group of its campaign) — never older than the days Nexus keeps (READ_DAYS)
 *   after     the same spend after the stop day, to the last settled day (3 days ago: the page's late-order-safe rule)
 *   saved     before per day × the days counted after − after (it may be below 0: it spends more than before)
 *   still     STILL_SPENDS when its words spent in another place since the stop, not blocked there now (the Stopped
 *             view's own still-bought facts: stopped.ts stillBought, stillServesIn) — the saving here is still said
 *   words     one plain line with no money in it (the money sits under its keys, stripped for a person who may not see it)
 * The stop day itself is in neither window: the stop came some time that day.
 */
import { CLICK_LAG_DAYS, dayIndex, READ_DAYS } from './pure.js'

/** Too early to judge before this many days. */
export const EFFECT_MIN_DAYS = 14
/** The most days before the stop that are read. */
export const EFFECT_BEFORE_DAYS = 30
/** Fewer days before the stop than this held by Nexus: no before, so no effect. */
export const EFFECT_MIN_BEFORE_DAYS = 7

export type EffectVerdict = 'TOO_EARLY' | 'SAVED' | 'STILL_SPENDS'

export interface StopEffect {
  since: string
  days: number
  verdict: EffectVerdict
  beforePerDayCents: number | null
  afterCents: number | null
  savedCents: number | null
  words: string
}

/** The day windows (day indexes, inclusive) one stop is judged on. `before` null: those days are older than Nexus keeps. */
export interface EffectWindows {
  stopDay: number
  days: number
  before: { from: number; to: number; days: number } | null
  after: { from: number; to: number; days: number }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The windows of a stop on `since`, judged on `now`. */
export function effectWindows(since: Date | string, now: Date): EffectWindows {
  const today = dayIndex(now)
  const stopDay = dayIndex(new Date(since))
  const days = Math.max(0, today - stopDay)
  const kept = today - (READ_DAYS - 1)
  const from = Math.max(stopDay - Math.min(Math.max(days, 1), EFFECT_BEFORE_DAYS), kept)
  const to = stopDay - 1
  const beforeDays = to - from + 1
  const settled = today - CLICK_LAG_DAYS
  return {
    stopDay, days,
    before: beforeDays >= EFFECT_MIN_BEFORE_DAYS ? { from, to, days: beforeDays } : null,
    after: { from: stopDay + 1, to: settled, days: Math.max(0, settled - stopDay) },
  }
}

/**
 * The effect of one stop. `spend`: its place's spend in the windows (cents), null when not read; `stillIn`: the other
 * places where its words still spend (0 when none). Null when it cannot be judged: no before held by Nexus.
 */
export function stopEffect(input: { since: string; now: Date; spend: { before: number; after: number } | null; stillIn: number }): StopEffect | null {
  const w = effectWindows(input.since, input.now)
  if (w.days < EFFECT_MIN_DAYS) {
    return { since: input.since, days: w.days, verdict: 'TOO_EARLY', beforePerDayCents: null, afterCents: null, savedCents: null, words: `Stopped ${plural(w.days, 'day')} ago, checked from ${EFFECT_MIN_DAYS} days` }
  }
  if (!w.before || !input.spend) return null
  const perDay = input.spend.before / w.before.days
  const saved = Math.round(perDay * w.after.days) - input.spend.after
  const counted = plural(w.after.days, 'day')
  // HONEST 14 — one true sentence: below 0 it spends more than before, never "as much". HONEST 18b — `stillIn` counts the
  // places where the words spent since the stop (stopped.ts), so the words say exactly that.
  const words = input.stillIn > 0
    ? `Stopped here, but its words spent in ${plural(input.stillIn, 'other ad group')} since the stop`
    : input.spend.before === 0 && input.spend.after === 0 ? `It spent nothing in the ${plural(w.before.days, 'day')} before the stop, nor in the ${counted} since`
      : input.spend.after === 0 ? `No spend here in the ${counted} since the stop`
        : saved > 0 ? `Spends less here in the ${counted} since the stop`
          : saved < 0 ? `Spends more here in the ${counted} since the stop than before it`
            : `Spends as much here as before, in the ${counted} since the stop`
  return {
    since: input.since, days: w.days, verdict: input.stillIn > 0 ? 'STILL_SPENDS' : 'SAVED',
    beforePerDayCents: Math.round(perDay), afterCents: input.spend.after, savedCents: saved, words,
  }
}
