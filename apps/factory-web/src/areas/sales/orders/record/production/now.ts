import { BLOCKER_KINDS, placeOf, type BlockerKind, type BlockerPlace } from '@nexus/factory-domain/production-brand/waiting'
import { HEALTH_REASON_CODES, type HealthReasonCode } from '@nexus/factory-domain/production-brand/health'
import type { BrandHealthView } from '../../../../../lib/production/health/api'
import type { Order } from '../../api'
import type { Dates, Headline, OrderProduction, ProductionLine, Words } from '../overview/api'
import { AFTER } from '../overview/model'
import { lineRowsOf, totalOf } from '../overview/progress'

/**
 * F-PT-102 (order PRODUCTION tab, 10-design §3 "Production now", S5 §3.2–3.3, 18-lead-settles L5) — the tab's top answer, without a
 * screen: where the order is (the stage — the SAME read and strip as Overview's "Where it is now"), how many of its pieces passed each
 * step (the SAME `lines` part as Overview's Progress by line, so the two never disagree), whether it keeps the promise and why (the
 * STORED health word — the band's — and ONE sentence that agrees with it), the one door to what holds it, and its urgency.
 *
 * Nothing here names a worker or another customer: every figure is the order's own (the production read's lines).
 */

/** Whether the order's production is followed now: not yet (before it is confirmed), now, or no more (shipped, closed, cancelled). */
export type NowState = 'notKept' | 'kept' | 'after'

export function nowStateOf(order: Pick<Order, 'status'>, headline: Headline | null | undefined): NowState {
  if (AFTER.includes(order.status)) return 'after'
  return headline?.health ? 'kept' : 'notKept'
}

// ---- F-PT-404 (B-PT-007): the health mark through the page's ONE read --------------------------------------------------------------
/**
 * The order's health as the mark's rule and its dialog read it (lib/production/health `BrandHealthView`), from the production read's
 * headline — no second GET on the order page. Null: not followed now, or an older answer without the state's version (the page then
 * reads the health on its own, as before).
 */
export function healthViewOf(order: Pick<Order, 'id' | 'number' | 'partyId' | 'status'>, headline: Headline | null | undefined): BrandHealthView | null {
  const health = headline?.health ?? null
  if (!health || health.version === undefined || AFTER.includes(order.status)) return null
  const reason = health.raise && (HEALTH_REASON_CODES as readonly string[]).includes(health.raise.reasonCode) ? (health.raise.reasonCode as HealthReasonCode) : null
  return {
    orderId: order.id,
    number: order.number,
    partyId: order.partyId,
    kept: true,
    computed: health.computed,
    health: health.code,
    reasonCode: reason,
    // The headline sends a raise only while it stands (the keeper's standingRaiseOf).
    raise: health.raise && reason ? { reasonCode: reason, note: health.raise.note, setAt: health.raise.at ?? '', setBy: health.raise.by, until: health.raise.until, stands: true } : null,
    waitingOn: headline?.waiting?.on ?? null,
    waitingSince: headline?.waiting?.since ?? null,
    version: health.version,
  }
}
// ---- end F-PT-404

// ---- the pieces per step ------------------------------------------------------------------------------------------------------

export const PIECE_STEPS = ['cut', 'sewn', 'checked', 'packed', 'shipped'] as const
export type PieceStep = (typeof PIECE_STEPS)[number]

/** "Cut 242 · Sewn 152 · Checked 40 · Packed 0 · Shipped 0 — of 244": a step not counted here is null ("—"), never a made-up 0. */
export interface PiecesView {
  readonly of: number
  readonly steps: readonly { readonly step: PieceStep; readonly value: number | null }[]
}

export function piecesOf(order: Pick<Order, 'lines'>, lines: readonly ProductionLine[] | null | undefined): PiecesView | null {
  if (!lines) return null
  const total = totalOf(lineRowsOf(lines, order))
  return { of: total.ordered ?? 0, steps: PIECE_STEPS.map((step) => ({ step, value: total[step] })) }
}

// ---- the health sentence (S5 §3.2: the first rule that AGREES with the stored word) ---------------------------------------------

/** One sentence of why, each kind with what it names (the view says it in the page's words; days in the page's way). */
export type HealthWhy =
  | { readonly kind: 'late'; readonly promise: string; readonly open: number }
  | { readonly kind: 'lineLate'; readonly line: string; readonly finish: string; readonly days: number; readonly promise: string }
  | { readonly kind: 'lineNoDate'; readonly line: string; readonly promise: string }
  | { readonly kind: 'gateLate'; readonly gate: { readonly label: string | null; readonly kind: string | null }; readonly target: string; readonly promise: string }
  | { readonly kind: 'marked'; readonly by: string | null; readonly at: string | null; readonly reason: Words; readonly computed: string | null }
  | { readonly kind: 'noDate' }
  | { readonly kind: 'onTrack'; readonly finish: string; readonly days: number; readonly promise: string }
  | { readonly kind: 'fromDates'; readonly plan: string | null; readonly promise: string }

const dayNumber = (value: string): number => Math.round(Date.parse(`${value.slice(0, 10)}T12:00:00Z`) / 86_400_000)
/** Whole days from `from` to `to` (YYYY-MM-DD; later is positive). */
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from)

/** A line as the sentence names it: "SEED-PNT-04 · Navy" (its style code and colour name; the order read's words). */
export function lineLabelOf(order: Pick<Order, 'lines'>, lineId: string): string | null {
  const line = order.lines.find((entry) => entry.id === lineId)
  if (!line) return null
  return [line.style?.code ?? null, line.colourway?.name || line.colourway?.code || null].filter(Boolean).join(' · ') || null
}

export function healthWhyOf(input: { readonly order: Pick<Order, 'lines' | 'promiseDate'>; readonly headline: Headline | null | undefined; readonly dates: Dates | null | undefined; readonly lines: readonly ProductionLine[] | null | undefined }): HealthWhy | null {
  const health = input.headline?.health ?? null
  if (!health) return null
  const promise = input.headline?.promise.date ?? input.order.promiseDate ?? null
  if (health.code === 'NO_DATE' || !promise) return health.code === 'NO_DATE' ? { kind: 'noDate' } : null
  const fallback: HealthWhy = { kind: 'fromDates', plan: input.dates?.planned.finish ?? null, promise }
  const forecast = input.dates?.forecast ?? null // withheld without planning.promise.view: the fallback line
  const promiseOf = (lineId: string) => input.order.lines.find((line) => line.id === lineId)?.promiseDate ?? promise
  switch (health.code) {
    case 'LATE': {
      const open = (input.lines ?? []).filter((line) => line.kind !== 'FEE').reduce((sum, line) => sum + Math.max(0, line.ordered - line.shipped), 0)
      return { kind: 'late', promise, open }
    }
    case 'AT_RISK': {
      // A person's mark while it stands and the dates alone would say otherwise: the mark is the why.
      if (health.raise && health.computed !== 'AT_RISK' && health.computed !== 'LATE') return { kind: 'marked', by: health.raise.by?.name ?? null, at: health.raise.at, reason: health.raise.words, computed: health.computed }
      const worst = (forecast ?? [])
        .filter((line) => line.risk === 'AT_RISK' && line.finish)
        .map((line) => ({ line, days: daysBetween(promiseOf(line.lineId), line.finish!) }))
        .sort((a, b) => b.days - a.days)[0]
      if (worst && worst.days > 0) {
        const label = lineLabelOf(input.order, worst.line.lineId)
        if (label) return { kind: 'lineLate', line: label, finish: worst.line.finish!, days: worst.days, promise: promiseOf(worst.line.lineId) }
      }
      const undated = (forecast ?? []).find((line) => line.finish === null || line.source === 'NONE')
      const undatedLabel = undated ? lineLabelOf(input.order, undated.lineId) : null
      if (undated && undatedLabel) return { kind: 'lineNoDate', line: undatedLabel, promise: promiseOf(undated.lineId) }
      const gate = (input.dates?.milestones ?? []).find((row) => row.state === 'WAITING' && (row.late ?? 0) > 0 && row.target)
      if (gate) return { kind: 'gateLate', gate: { label: gate.label, kind: gate.gateKind }, target: gate.target!, promise }
      if (health.raise) return { kind: 'marked', by: health.raise.by?.name ?? null, at: health.raise.at, reason: health.raise.words, computed: health.computed }
      return fallback
    }
    case 'ON_TRACK': {
      const finish = input.dates?.planned.finish ?? null
      if (finish && daysBetween(finish, promise) >= 0) return { kind: 'onTrack', finish, days: daysBetween(finish, promise), promise }
      return fallback
    }
    default:
      return fallback
  }
}

// ---- the next step (S5 §3.3: one door, never a second copy of an act) -----------------------------------------------------------

/**
 * The first blocker the keeper names (its own order) becomes ONE door to the place it is handled — HOLD: Problems & holds (#holds),
 * DATE: Dates & plan (#dates), REQUEST: the Changes tab — in the blocker's own words. Nothing blocks and the order is late or at risk:
 * "Ask {supervisor} for an update…" (the same note dialog). On track: no next step.
 */
export type NextStep = { readonly kind: 'blocker'; readonly words: Words; readonly place: BlockerPlace } | { readonly kind: 'ask' }

const KNOWN = new Set<string>(BLOCKER_KINDS)

export function nextStepOf(headline: Headline | null | undefined): NextStep | null {
  const health = headline?.health?.code ?? null
  const first = headline?.waiting.blockers[0] ?? null
  if (first) return { kind: 'blocker', words: first.words, place: KNOWN.has(first.kind) ? placeOf({ kind: first.kind as BlockerKind, sub: first.sub ?? null }) : 'REQUEST' }
  if (health === 'LATE' || health === 'AT_RISK') return { kind: 'ask' }
  return null
}

/** Where a door lands on the page: a section of this tab (#holds, #dates) or another tab (Changes). */
export const placeAnchorOf = (place: BlockerPlace): { readonly tab: 'production' | 'changes'; readonly anchor: string | null } => (place === 'HOLD' ? { tab: 'production', anchor: 'holds' } : place === 'DATE' ? { tab: 'production', anchor: 'dates' } : { tab: 'changes', anchor: null })

// ---- the urgency line (L5) ----------------------------------------------------------------------------------------------------

/**
 * Urgent (customer) · Rush (factory) · the office priority — three different things, never one word "Urgent" (B3): the customer's own
 * urgency, our factory rush on one of its work orders, the office's priority when it is not the normal one.
 */
export interface UrgencyView {
  readonly customer: boolean
  readonly rush: boolean
  readonly priority: Words | null
}

export function urgencyOf(headline: Headline | null | undefined, work: OrderProduction['work']): UrgencyView | null {
  if (!headline) return null
  const rush = headline.urgency.factoryRush || !!work?.workOrders.some((row) => row.rush && !row.sharedWithOtherCustomers)
  const priority = headline.urgency.officePriority.level !== 'NORMAL' ? headline.urgency.officePriority.words : null
  return { customer: headline.urgency.customer?.code === 'URGENT', rush, priority }
}
