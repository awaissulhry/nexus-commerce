/**
 * R.13 — Event-driven prep mode.
 *
 * RetailEvent table holds known sales spikes (Black Friday, saldi,
 * Prime Day, etc.) with expectedLift multipliers. The forecast
 * signal layer already feeds this into the Holt-Winters model so
 * forecasts inflate around event windows. R.13 closes the operator-
 * surface gap: the system already knows the event, lift, and lead
 * time — it should just SAY "order N extra by date Y or you'll
 * miss it".
 *
 * Pure functions (no DB):
 *   eventAppliesToProduct() — productType-level scope match
 *   computeExtraUnitsForEvent() — extra units = velocity × duration × (lift-1)
 *   shouldPromoteForPrep() — within lead-time window?
 *
 * Scope cuts for v1:
 *   - Product-type scope only (channel/marketplace deferred)
 *   - Earliest-deadline event wins per SKU
 *   - One-tier urgency bump max (LOW→MEDIUM, MEDIUM→HIGH, HIGH→CRITICAL)
 *   - Lift ≤ 1.0 events filtered out (no incremental demand to prep for)
 */

import type { Urgency } from './replenishment-urgency.service.js'

const URGENCY_RANK: Record<Urgency, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
}
const RANK_TO_URGENCY: Record<number, Urgency> = {
  0: 'CRITICAL',
  1: 'HIGH',
  2: 'MEDIUM',
  3: 'LOW',
}

export interface RetailEventLite {
  id: string
  name: string
  startDate: Date
  endDate: Date
  productType: string | null
  channel: string | null
  marketplace: string | null
  expectedLift: number
  prepLeadTimeDays: number
  isActive: boolean
}

export interface PrepRecommendation {
  eventId: string
  name: string
  startDate: string  // ISO yyyy-mm-dd
  prepDeadline: string
  daysUntilStart: number
  daysUntilDeadline: number
  expectedLift: number
  extraUnitsRecommended: number
}

/**
 * Pure function: does this event apply to a product?
 *
 * v1 scope: productType match (or event has null productType =
 * applies to all). Channel/marketplace scope is loaded into the
 * RetailEvent shape but not yet enforced — adds query complexity
 * without clear v1 win for Xavia.
 */
export function eventAppliesToProduct(args: {
  event: RetailEventLite
  productType: string | null
}): boolean {
  if (!args.event.isActive) return false
  if (args.event.expectedLift <= 1) return false  // no incremental demand
  if (args.event.productType == null) return true // applies to all
  return args.event.productType === args.productType
}

/**
 * Extra units to pre-stock for this event:
 *   velocity × eventDurationDays × (lift - 1)
 * lift=1.8 + velocity 5/d + 10-day event = 5 × 10 × 0.8 = 40 extra units.
 * Negative-impact events (lift < 1) clamp to 0.
 */
export function computeExtraUnitsForEvent(args: {
  velocity: number
  eventDurationDays: number
  expectedLift: number
}): number {
  const v = Math.max(0, args.velocity)
  const dur = Math.max(0, args.eventDurationDays)
  const liftMinus1 = args.expectedLift - 1
  if (liftMinus1 <= 0) return 0
  return Math.ceil(v * dur * liftMinus1)
}

/**
 * Should event prep promote this SKU's urgency? Yes when the prep
 * deadline is within the lead-time window — operator must order NOW
 * or miss it.
 */
export function shouldPromoteForPrep(args: {
  daysUntilDeadline: number
  leadTimeDays: number
}): boolean {
  return args.daysUntilDeadline <= args.leadTimeDays
}

/**
 * Bump urgency by one tier. LOW→MEDIUM, MEDIUM→HIGH, HIGH→CRITICAL,
 * CRITICAL stays CRITICAL (already maxed). Capped at one tier — event
 * prep is "plan ahead", not "drop everything".
 */
export function bumpUrgencyOneTier(current: Urgency): Urgency {
  const newRank = Math.max(0, URGENCY_RANK[current] - 1)
  return RANK_TO_URGENCY[newRank]
}

const DAY_MS = 86400_000

/**
 * Find the most-pressing event (earliest deadline) that applies to
 * a product. Returns null if none apply.
 */
export function findApplicableEvent(args: {
  events: RetailEventLite[]
  productType: string | null
  velocity: number
  today?: Date
}): PrepRecommendation | null {
  const today = args.today ?? new Date()
  const todayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  const candidates = args.events
    .filter((e) => eventAppliesToProduct({ event: e, productType: args.productType }))
    .filter((e) => e.startDate.getTime() >= todayStart.getTime()) // future events only
    .sort((a, b) => a.startDate.getTime() - b.startDate.getTime())

  if (candidates.length === 0) return null
  const event = candidates[0]
  const prepDeadline = new Date(event.startDate.getTime() - event.prepLeadTimeDays * DAY_MS)
  const daysUntilStart = Math.ceil((event.startDate.getTime() - todayStart.getTime()) / DAY_MS)
  const daysUntilDeadline = Math.ceil((prepDeadline.getTime() - todayStart.getTime()) / DAY_MS)
  const eventDurationDays = Math.max(
    1,
    Math.ceil((event.endDate.getTime() - event.startDate.getTime()) / DAY_MS) + 1,
  )
  const extraUnitsRecommended = computeExtraUnitsForEvent({
    velocity: args.velocity,
    eventDurationDays,
    expectedLift: event.expectedLift,
  })

  return {
    eventId: event.id,
    name: event.name,
    startDate: event.startDate.toISOString().slice(0, 10),
    prepDeadline: prepDeadline.toISOString().slice(0, 10),
    daysUntilStart,
    daysUntilDeadline,
    expectedLift: event.expectedLift,
    extraUnitsRecommended,
  }
}
