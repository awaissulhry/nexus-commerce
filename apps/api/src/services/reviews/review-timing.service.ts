/**
 * RRT — review-request send-timing resolver. Single source of truth shared by the
 * scheduler, the rule dry-run, and the editor live-preview.
 *
 * Resolves the send delay (rule override → editable ReviewTimingDefault table →
 * DEFAULT), picks the anchor date (delivery / ship / purchase; Amazon forced to
 * delivery), optionally pins a preferred local hour (in the marketplace timezone)
 * and skips weekends, then clamps to the rule window and Amazon's 4–25d hard cap.
 *
 * Parity: with the migration backfill `sendDelayDays = minDaysSinceDelivery` and
 * the new fields defaulting to today's behaviour (anchor=DELIVERY, no hour, no
 * weekend skip), this reproduces the old `deliveredAt + max(4,minDays)` exactly —
 * because minDays is always ≥4 (write-clamped) and the hour/weekend window-clamp
 * is gated off unless those features are used.
 */

const DAY = 24 * 60 * 60 * 1000
export const DEFAULT_DELAY_DAYS = 12 // last resort if the timing table has no match
const AMAZON_MIN_DAYS = 4
const AMAZON_MAX_DAYS = 25 // inside the 4–30d Solicitations window, margin for the send-time re-check

// Marketplace → IANA timezone (mirrors AMAZON_MARKETPLACE_ID_MAP). Default Rome.
const MARKETPLACE_TZ: Record<string, string> = {
  IT: 'Europe/Rome', DE: 'Europe/Berlin', FR: 'Europe/Paris', ES: 'Europe/Madrid',
  NL: 'Europe/Amsterdam', BE: 'Europe/Brussels', PL: 'Europe/Warsaw', SE: 'Europe/Stockholm',
  UK: 'Europe/London', GB: 'Europe/London', IE: 'Europe/Dublin', TR: 'Europe/Istanbul',
  US: 'America/New_York', AE: 'Asia/Dubai', SA: 'Asia/Riyadh', EG: 'Africa/Cairo',
  JP: 'Asia/Tokyo', AU: 'Australia/Sydney', SG: 'Asia/Singapore', IN: 'Asia/Kolkata',
}
export function timezoneForMarketplace(code: string | null | undefined): string {
  return (code && MARKETPLACE_TZ[code.toUpperCase()]) || 'Europe/Rome'
}

// ── Intl-based wall-clock helpers (repo idiom from dashboard-digest.service.ts;
// no luxon/dayjs — they're undeclared in package.json). DST-correct per-instant. ──
function zoneParts(instant: Date, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(instant)
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? ''
  const hour = Number(g('hour')) === 24 ? 0 : Number(g('hour'))
  return { y: Number(g('year')), m: Number(g('month')), d: Number(g('day')), hour, minute: Number(g('minute')), weekday: g('weekday') }
}
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as const
function dowInZone(instant: Date, tz: string): number {
  return DOW[zoneParts(instant, tz).weekday as keyof typeof DOW] ?? 0
}
/** UTC Date whose wall-clock time in `tz` is exactly y-(m0+1)-d hh:00 local. */
function zonedDateTime(y: number, m0: number, d: number, hour: number, tz: string): Date {
  const probe = new Date(Date.UTC(y, m0, d, 12, 0, 0))
  const o = zoneParts(probe, tz)
  const offsetMs = Date.UTC(o.y, o.m - 1, o.d, o.hour, o.minute) - probe.getTime()
  return new Date(Date.UTC(y, m0, d, hour, 0, 0) - offsetMs)
}

export interface TimingDefaultRow { pattern: string; delayDays: number; isActive: boolean; sortOrder: number }
export interface SendWindowRow { marketplace: string; dayOfWeek: number; hourLocal: number; dayRank: number; isActive: boolean }

/** Effective local send hour for a weekday: a per-market row beats the global '*'. null = none. */
export function windowHourFor(marketplace: string | null | undefined, weekday: number, windows: SendWindowRow[]): number | null {
  if (!windows.length) return null
  const code = (marketplace || '').toUpperCase()
  const active = windows.filter((w) => w.isActive && w.dayOfWeek === weekday)
  const perMarket = code ? active.find((w) => w.marketplace.toUpperCase() === code) : undefined
  if (perMarket) return perMarket.hourLocal
  const global = active.find((w) => w.marketplace === '*')
  return global ? global.hourLocal : null
}

/** Best (lowest dayRank) weekday from the windows for a market, falling back to global. */
export function rankedWeekdays(marketplace: string | null | undefined, windows: SendWindowRow[]): number[] {
  if (!windows.length) return []
  const code = (marketplace || '').toUpperCase()
  const byDay = new Map<number, SendWindowRow>()
  for (const w of windows.filter((x) => x.isActive)) {
    if (w.marketplace === '*' && !byDay.has(w.dayOfWeek)) byDay.set(w.dayOfWeek, w)
    if (code && w.marketplace.toUpperCase() === code) byDay.set(w.dayOfWeek, w) // per-market overrides
  }
  return [...byDay.values()].sort((a, b) => a.dayRank - b.dayRank).map((w) => w.dayOfWeek)
}
export interface TimingOrderInput {
  channel: string
  marketplace: string | null
  deliveredAt: Date | null
  shippedAt: Date | null
  purchaseDate: Date | null
  productType: string | null
}
export interface TimingRuleInput {
  sendDelayDays: number | null
  anchor: string
  sendHourLocal: number | null
  skipWeekends: boolean
  shiftToBestDay?: boolean
  minDaysSinceDelivery: number
  maxDaysSinceDelivery: number
}
export interface ResolvedTiming {
  scheduledFor: Date | null // null = no usable anchor date → caller skips
  anchorUsed: 'DELIVERY' | 'SHIP' | 'PURCHASE'
  anchorDate: Date | null
  delayDays: number
  effectiveDelayDays: number | null
  source: 'rule-override' | 'timing-table' | 'default'
  sendHour: number | null // local hour pinned (null = anchor's time-of-day kept)
  sendHourSource: 'rule' | 'window' | 'none'
}

/** First active table row (by sortOrder) whose pattern is a substring of productType. */
export function lookupTimingTable(productType: string | null, defaults: TimingDefaultRow[]): number | null {
  if (!productType) return null
  const t = productType.toLowerCase()
  const row = [...defaults].filter((r) => r.isActive).sort((a, b) => a.sortOrder - b.sortOrder)
    .find((r) => t.includes(r.pattern.toLowerCase()))
  return row ? row.delayDays : null
}

export function resolveSendTiming(
  order: TimingOrderInput,
  rule: TimingRuleInput | null,
  timingDefaults: TimingDefaultRow[],
  sendWindows: SendWindowRow[] = [],
): ResolvedTiming {
  // 1. delay
  let delayDays: number
  let source: ResolvedTiming['source']
  if (rule?.sendDelayDays != null) { delayDays = rule.sendDelayDays; source = 'rule-override' }
  else {
    const t = lookupTimingTable(order.productType, timingDefaults)
    if (t != null) { delayDays = t; source = 'timing-table' } else { delayDays = DEFAULT_DELAY_DAYS; source = 'default' }
  }

  // 2. anchor (Amazon forced to DELIVERY — Solicitations is delivery-based)
  const anchorUsed: ResolvedTiming['anchorUsed'] =
    order.channel === 'AMAZON' ? 'DELIVERY'
      : rule?.anchor === 'SHIP' ? 'SHIP'
        : rule?.anchor === 'PURCHASE' ? 'PURCHASE' : 'DELIVERY'
  const anchorDate =
    anchorUsed === 'SHIP' ? (order.shippedAt ?? order.deliveredAt ?? order.purchaseDate)
      : anchorUsed === 'PURCHASE' ? (order.purchaseDate ?? order.shippedAt ?? order.deliveredAt)
        : (order.deliveredAt ?? order.shippedAt ?? order.purchaseDate)
  if (!anchorDate) return { scheduledFor: null, anchorUsed, anchorDate: null, delayDays, effectiveDelayDays: null, source, sendHour: null, sendHourSource: 'none' }

  // 3. base date (keeps the anchor's time-of-day until we pin a send hour)
  let scheduled = new Date(anchorDate.getTime() + delayDays * DAY)
  const tz = timezoneForMarketplace(order.marketplace)

  const amazonClamp = (d: Date): Date => {
    if (order.channel === 'AMAZON' && order.deliveredAt) {
      const aLo = new Date(order.deliveredAt.getTime() + AMAZON_MIN_DAYS * DAY)
      const aHi = new Date(order.deliveredAt.getTime() + AMAZON_MAX_DAYS * DAY)
      if (d < aLo) return aLo
      if (d > aHi) return aHi
    }
    return d
  }

  // 4. position the calendar DAY first (weekend roll → window clamp → Amazon day
  //    cap), preserving time-of-day; the send HOUR is pinned afterwards by the
  //    settled weekday so a day-shift can't strand the hour on the wrong weekday.

  // 4a. skip weekends (roll Sat/Sun forward to Monday)
  if (rule?.skipWeekends) {
    let guard = 0
    while ((dowInZone(scheduled, tz) === 0 || dowInZone(scheduled, tz) === 6) && guard++ < 3) {
      scheduled = new Date(scheduled.getTime() + DAY)
    }
  }
  // 4b. clamp into the rule's eligibility window [min,max] days from the anchor.
  // Parity-safe: existing rules have delay == minDaysSinceDelivery, so this is a
  // no-op for them; it bounds operator delays + any hour/weekend drift.
  if (rule) {
    const lo = new Date(anchorDate.getTime() + rule.minDaysSinceDelivery * DAY)
    const hi = new Date(anchorDate.getTime() + rule.maxDaysSinceDelivery * DAY)
    if (lo <= hi) {
      if (scheduled < lo) scheduled = lo
      if (scheduled > hi) scheduled = hi
    }
  }
  // 4c. Amazon day cap
  scheduled = amazonClamp(scheduled)

  // 4d. STO.6 — optionally shift forward within the same week to the best-ranked
  //     weekday (only if it stays inside every clamp above).
  if (rule?.shiftToBestDay) {
    const order2 = rankedWeekdays(order.marketplace, sendWindows)
    if (order2.length) {
      const curDow = dowInZone(scheduled, tz)
      const curRank = order2.indexOf(curDow)
      for (let add = 1; add <= 6; add++) {
        const cand = new Date(scheduled.getTime() + add * DAY)
        if (amazonClamp(cand).getTime() !== cand.getTime()) break // would leave the legal window
        if (rule.skipWeekends && (dowInZone(cand, tz) === 0 || dowInZone(cand, tz) === 6)) continue
        const candRank = order2.indexOf(dowInZone(cand, tz))
        if (candRank !== -1 && (curRank === -1 || candRank < curRank)) { scheduled = cand; break }
      }
    }
  }

  // 5. pin the send HOUR by the settled weekday: rule override → send-window table
  //    (per-market beats global) → none (keep the anchor's time-of-day).
  let sendHour: number | null = rule?.sendHourLocal ?? null
  let sendHourSource: ResolvedTiming['sendHourSource'] = rule?.sendHourLocal != null ? 'rule' : 'none'
  if (sendHour == null) {
    const w = windowHourFor(order.marketplace, dowInZone(scheduled, tz), sendWindows)
    if (w != null) { sendHour = w; sendHourSource = 'window' }
  }
  if (sendHour != null) {
    const z = zoneParts(scheduled, tz)
    scheduled = zonedDateTime(z.y, z.m - 1, z.d, sendHour, tz)
    // legality re-assert: an earlier hour on the min day (or later on the max day)
    // must not cross Amazon's window — legality beats the hour nicety here.
    scheduled = amazonClamp(scheduled)
  }

  return {
    scheduledFor: scheduled,
    anchorUsed,
    anchorDate,
    delayDays,
    effectiveDelayDays: Math.round((scheduled.getTime() - anchorDate.getTime()) / DAY),
    source,
    sendHour,
    sendHourSource,
  }
}
