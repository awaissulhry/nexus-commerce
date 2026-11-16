import type { Tone } from '@nexus/ui/primitives'
import { eachDay, isoWeekday } from '@nexus/factory-domain/calendars/dates'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { PromiseReasonCode } from '@nexus/factory-domain/sales/portal-orders/promise'

/**
 * F-PR-01 — the shared production parts' rules, without a screen (production plan §4, `09-design.md` §1, readability
 * rules R5–R9). The office (every customer) and the portal (one customer) draw the same parts from `lib/production/view/`,
 * so the rules live here once: the five plain stages, who the work waits on, the health chip, pieces per stage and size,
 * a customer request, the hold banner, the freshness line, and the one rule "a bar shows the figure its words name".
 *
 * Words are message keys of the `production` catalogue (`parts.*`, `progress.*`) with their parameters (`Phrase`); the
 * parts translate them. Every input is the caller's own read: a customer-facing part is given that customer's figures
 * only (per cell, the brand wall), and nothing here names another customer, a line, a worker or a cost.
 */

export interface Phrase {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}
const phrase = (key: string, params?: Phrase['params']): Phrase => (params ? { key, params } : { key })

/** Who reads the part: the factory's office (every customer it may see) or one customer in its portal. */
export type Face = 'office' | 'customer'

// ---- the one rule: a bar shows the figure its words name (R5) -------------------------------------------------------------

/** Garments a work order counts at each floor step; null where the site does not count that step (never 0). */
export interface StepCounts {
  readonly cut: number | null
  readonly bundled: number | null
  readonly sewn: number | null
  readonly finished: number | null
}

/** The floor steps, furthest first: the one a short phrase names is the furthest reached. */
export const PROGRESS_STEPS = ['finished', 'sewn', 'bundled', 'cut'] as const
export type ProgressStep = (typeof PROGRESS_STEPS)[number]

/** A share in whole percent (0–100), or null when nothing is counted or nothing is planned. */
export function percentOf(done: number | null, total: number): number | null {
  if (done === null || total <= 0) return null
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
}

export interface ProgressFigure {
  /** The step the words and the bar both name; null before release or when nothing is counted. */
  readonly step: ProgressStep | null
  readonly done: number | null
  readonly total: number
  /** The bar: that step's share, null when nothing is measured (an empty track, never 0). */
  readonly percent: number | null
  readonly words: Phrase
}

/**
 * ONE figure for a work order's short progress (the list cell, a card): the furthest step reached, its words ("Sewn 80 of
 * 100") and its bar (80 %) from the same number, so a bar never shows finished 0 % beside "Sewn 80 of 100" (09 §1.4).
 * Not released: no figure. Nothing reached yet: "nothing cut yet" with an empty cut bar (0 when cut is counted, none when
 * nothing is counted at all).
 */
export function progressFigure(counts: StepCounts | null, total: number, released: boolean): ProgressFigure {
  if (!released || !counts) return { step: null, done: null, total, percent: null, words: phrase('progress.notFrozen') }
  for (const step of PROGRESS_STEPS) {
    const value = counts[step]
    if (value !== null && value > 0) return { step, done: value, total, percent: percentOf(value, total), words: phrase(`progress.${step}`, { done: value, total }) }
  }
  const counted = PROGRESS_STEPS.some((step) => counts[step] !== null)
  return { step: counted ? 'cut' : null, done: counted ? 0 : null, total, percent: counted ? percentOf(0, total) : null, words: phrase('progress.none', { total }) }
}

// ---- the five plain stages (plan §4) ----------------------------------------------------------------------------------------

/** What a customer reads of its order in production; the order shows its slowest unfinished line (B-PR-15 BrandStage). */
export const PLAIN_STAGES = ['PREPARING', 'CUTTING', 'SEWING', 'QUALITY', 'READY'] as const
export type PlainStage = (typeof PLAIN_STAGES)[number]

export interface StageStripInput {
  /** The stage now; null when it is not known ("—", never step 1 by default). */
  readonly stage: PlainStage | null
  /** The calendar day (`YYYY-MM-DD`) each stage was reached, when known. */
  readonly reached?: Readonly<Partial<Record<PlainStage, string | null>>>
  /** The day each stage still to come is expected: office the plan, customer the published plan only. */
  readonly expected?: Readonly<Partial<Record<PlainStage, string | null>>>
  /** A line under the current stage, written by the caller ("Sewn 80 of 100"). */
  readonly note?: string | null
  /** false where the site does not scan sewing: the Sewing step says so instead of a count. */
  readonly sewingCounted?: boolean
  /** The work cannot go on: the current stage is blocked, and why (written by the caller). */
  readonly blocked?: { readonly why?: string | null } | null
}

/** A plain step for the DS MilestoneTracker; dates still as calendar days (the part writes them). */
export interface StageStep {
  readonly id: PlainStage
  readonly label: Phrase
  readonly state: 'done' | 'current' | 'todo'
  readonly date: string | null
  readonly expected: string | null
  readonly note: Phrase | string | null
}

/**
 * The five stages as steps: before the stage done (its day), the stage current, after it to come (its expected day).
 * Unknown stage: no steps (the part writes "—"). Blocked: the current step's line says why (DS gap G1, plan §8: the DS
 * tracker has no blocked state; the part adds the blocked mark beside it). Sewing not scanned: its step says so.
 */
export function stageSteps(input: StageStripInput): StageStep[] {
  if (input.stage === null) return []
  const at = PLAIN_STAGES.indexOf(input.stage)
  return PLAIN_STAGES.map((stage, index) => {
    const state = index < at ? 'done' : index === at ? 'current' : 'todo'
    let note: Phrase | string | null = null
    if (state === 'current') note = input.blocked?.why ?? input.note ?? null
    if (stage === 'SEWING' && input.sewingCounted === false && state !== 'done' && note === null) note = phrase('parts.stage.sewingNotCounted')
    return {
      id: stage,
      label: phrase(`parts.stage.${stage}`),
      state,
      date: state === 'done' ? (input.reached?.[stage] ?? null) : null,
      expected: state === 'done' ? null : (input.expected?.[stage] ?? null),
      note,
    }
  })
}

// ---- waiting on (06-tree §0.3, threads kit §5) -------------------------------------------------------------------------------

/** Who the work waits on (B-PR-15 WaitingOn): the customer reads only "You" (BRAND) or "Us" (the rest is ours to solve). */
export const WAITING_PARTIES = ['US', 'BRAND', 'SUPPLIER', 'WORKSHOP'] as const
export type WaitingParty = (typeof WAITING_PARTIES)[number]

export interface WaitingInput {
  /** null: nobody waits (no chip); undefined: not known ("—"). */
  readonly who: WaitingParty | null | undefined
  /** Since when (an instant). */
  readonly since?: string | null
  /** The wait's own due moment (an approval asked of the customer): amber once passed. */
  readonly dueAt?: string | null
  /** A request or approval turns amber after 1 working day; anything else after 3. */
  readonly kind?: 'request' | 'record'
  /** Office only: what it waits for ("PP sample"), written. */
  readonly what?: string | null
}

export interface WaitingView {
  readonly words: Phrase
  readonly tone: Tone
  /** "4 h", "2 d"; null without a since. */
  readonly age: Phrase | null
  readonly what: string | null
}

/** "{n} min", "{n} h", "{n} d" since an instant (nothing for a moment in the future). */
export function ageOf(since: string | null | undefined, now: number): Phrase | null {
  const at = since ? Date.parse(since) : NaN
  if (!Number.isFinite(at) || at > now) return null
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 60) return phrase('parts.age.minutes', { count: Math.max(1, minutes) })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return phrase('parts.age.hours', { count: hours })
  return phrase('parts.age.days', { count: Math.floor(hours / 24) })
}

/** Working days (Monday to Friday, in the company's zone) after the day of `since`, up to and with today. */
export function workingDaysSince(since: string | null | undefined, now: number): number {
  const at = since ? Date.parse(since) : NaN
  if (!Number.isFinite(at) || at > now) return 0
  const days = eachDay(businessDate(new Date(at)), businessDate(new Date(now))).slice(1)
  return days.filter((day) => isoWeekday(day) <= 5).length
}

/**
 * The chip, or null when nobody waits, or 'unknown' ("—"). Office: "Waiting on us · 4 h", "Waiting on customer · 2 d",
 * supplier, workshop. Customer: "Waiting on you" or "Waiting on us" (supplier and workshop are ours; no name of theirs).
 * Amber: the customer's wait once its own due moment passed; ours after 1 working day for a request, 3 for anything else.
 */
export function waitingView(face: Face, input: WaitingInput, now: number): WaitingView | null | 'unknown' {
  if (input.who === undefined) return 'unknown'
  if (input.who === null) return null
  const words = face === 'customer' ? phrase(input.who === 'BRAND' ? 'parts.waiting.customer.you' : 'parts.waiting.customer.us') : phrase(`parts.waiting.office.${input.who}`)
  const due = input.dueAt ? Date.parse(input.dueAt) : NaN
  const pastDue = Number.isFinite(due) && due < now
  const late = input.who === 'BRAND' ? pastDue : pastDue || workingDaysSince(input.since, now) >= (input.kind === 'request' ? 1 : 3)
  return { words, tone: late ? 'warning' : 'neutral', age: ageOf(input.since, now), what: face === 'office' ? (input.what ?? null) : null }
}

// ---- health (06-tree §0.4, 07 §4.2) ------------------------------------------------------------------------------------------

/** Computed from the dates (planning's riskOf): late, at risk, no date promised yet, on track. */
export const HEALTH_STATES = ['LATE', 'AT_RISK', 'NOT_PROMISED', 'ON_TIME'] as const
export type HealthState = (typeof HEALTH_STATES)[number]
const HEALTH_RANK: Readonly<Record<HealthState, number>> = Object.freeze({ LATE: 0, AT_RISK: 1, NOT_PROMISED: 2, ON_TIME: 3 })

export interface HealthInput {
  /** From the dates; null: no plan ("—"); undefined: not read. */
  readonly computed: HealthState | null | undefined
  readonly daysLate?: number | null
  /** A person raised it to At risk (B-PR-35): the curated reason the customer reads, and the office's own note. */
  readonly raised?: {
    readonly reason: PromiseReasonCode
    /** Office only: never drawn on the customer face. */
    readonly note?: string | null
    readonly by?: string | null
    /** The day it was raised (`YYYY-MM-DD` or an instant). */
    readonly at?: string | null
  } | null
  /** The planned finish and the promise, calendar days, for the office's "From the dates" line. */
  readonly plan?: string | null
  readonly promise?: string | null
}

export interface HealthView {
  readonly state: HealthState | null
  readonly words: Phrase
  readonly tone: Tone
  /** The curated reason the customer may read (only when a person raised it). */
  readonly reason: PromiseReasonCode | null
  /** Office only: the person's note to show "Office only". */
  readonly note: { readonly text: string; readonly by: string | null; readonly at: string | null } | null
}

const HEALTH_TONE: Readonly<Record<HealthState, Tone>> = Object.freeze({ LATE: 'danger', AT_RISK: 'warning', NOT_PROMISED: 'neutral', ON_TIME: 'success' })

/**
 * Two signals, one chip (industry trap 2): the worse of the computed health and a person's raise to At risk. The office
 * also gets the person's note (drawn "Office only"); the customer the chip and the curated reason, never the note.
 */
export function healthView(face: Face, input: HealthInput): HealthView | 'unknown' {
  if (input.computed === undefined) return 'unknown'
  const raised = input.raised ? 'AT_RISK' : null
  const candidates = [input.computed, raised].filter((state): state is HealthState => state !== null)
  const state = candidates.length === 0 ? null : candidates.reduce((worst, next) => (HEALTH_RANK[next] < HEALTH_RANK[worst] ? next : worst))
  if (state === null) return { state: null, words: phrase('parts.health.none'), tone: 'neutral', reason: null, note: null }
  const words = state === 'LATE' && input.daysLate && input.daysLate > 0 ? phrase('parts.health.lateBy', { count: input.daysLate }) : phrase(`parts.health.${state}`)
  const note = face === 'office' && input.raised?.note ? { text: input.raised.note, by: input.raised.by ?? null, at: input.raised.at ?? null } : null
  return { state, words, tone: HEALTH_TONE[state], reason: input.raised?.reason ?? null, note }
}

// ---- pieces per stage and size (plan §4 "+ Progress") ------------------------------------------------------------------------

/** The stages a customer's pieces are counted at (the portal progress read's): Cut = cut and bundled. */
export const PIECE_STAGES = ['CUT', 'SEWN', 'INSPECTED', 'PACKED'] as const
export type PieceStage = (typeof PIECE_STAGES)[number]

export interface PieceCounts {
  readonly ordered: number
  readonly cut: number | null
  readonly sewn: number | null
  readonly inspected: number | null
  readonly packed: number | null
}

export interface PiecesColourway {
  readonly id: string
  /** Written by the caller: "JK-210 Rider · Black". */
  readonly label: string
  /** In the size scale's order. */
  readonly sizes: readonly ({ readonly size: string } & PieceCounts)[]
}

export interface StageFigure {
  readonly stage: PieceStage
  readonly done: number | null
  readonly total: number
  readonly percent: number | null
}

const countOf = (counts: PieceCounts, stage: PieceStage): number | null => (stage === 'CUT' ? counts.cut : stage === 'SEWN' ? counts.sewn : stage === 'INSPECTED' ? counts.inspected : counts.packed)

/** A colourway's whole: ordered summed; a stage summed, or null when no size counts it. */
export function piecesTotal(colourway: PiecesColourway): PieceCounts {
  const sum = (stage: PieceStage): number | null => {
    const values = colourway.sizes.map((size) => countOf(size, stage))
    return values.every((value) => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0)
  }
  return { ordered: colourway.sizes.reduce((total, size) => total + size.ordered, 0), cut: sum('CUT'), sewn: sum('SEWN'), inspected: sum('INSPECTED'), packed: sum('PACKED') }
}

/** Each stage's figure of some counts: the bar and its words ("50 of 60") from one number; unknown stays null. */
export function stageFigures(counts: PieceCounts): StageFigure[] {
  return PIECE_STAGES.map((stage) => {
    const done = countOf(counts, stage)
    return { stage, done, total: counts.ordered, percent: percentOf(done, counts.ordered) }
  })
}

/** One cell's text: the count, or "—" where the stage is not counted. */
export const pieceCell = (counts: PieceCounts, stage: PieceStage | 'ORDERED'): string => {
  if (stage === 'ORDERED') return String(counts.ordered)
  const value = countOf(counts, stage)
  return value === null ? '—' : String(value)
}

/** Nothing cut yet in any colourway (counted and zero, or not counted at all). */
export const nothingCut = (colourways: readonly PiecesColourway[]): boolean => colourways.every((colourway) => (piecesTotal(colourway).cut ?? 0) === 0)

// ---- a customer request (09-design §1.6) -------------------------------------------------------------------------------------

/** Today's change and cancel, and the kinds the plan adds (B-PR-23: RUSH = "Urgent – asked", HOLD = pause, …). */
export const REQUEST_KINDS = ['CHANGE', 'CANCEL', 'RUSH', 'HOLD', 'RESUME', 'SPLIT_SHIPMENT', 'SAMPLE_ROUND'] as const
export type RequestKind = (typeof REQUEST_KINDS)[number]
export const REQUEST_STATES = ['OPEN', 'COUNTERED', 'ACCEPTED', 'REFUSED', 'WITHDRAWN'] as const
export type RequestState = (typeof REQUEST_STATES)[number]

export interface RequestInput {
  readonly id: string
  readonly kind: RequestKind
  readonly state: RequestState
  readonly askedAt: string
  /** Office face: the customer's person who asked. */
  readonly askedBy?: string | null
  /** Customer face: the person reading asked it. */
  readonly mine?: boolean
  /** Old → new, written by the caller ("Line 10 · M": 20 → 24). */
  readonly changes?: readonly { readonly id: string; readonly label: string; readonly from: string; readonly to: string }[]
  /** The customer's own words. */
  readonly note?: string | null
  /** Impact before Send (L4): what is fixed, the earliest date (best / likely / worst), and price — never a capacity figure. */
  readonly impact?: {
    readonly frozen?: readonly string[]
    readonly earliest?: { readonly best: string; readonly likely?: string | null; readonly worst?: string | null } | null
    /** NONE: no price change; MAY_APPLY: said to a role without the price grain; PRICED: `priceText` holds the amount. */
    readonly price?: 'NONE' | 'MAY_APPLY' | 'PRICED'
    readonly priceText?: string | null
  } | null
  /** Our answer. The office sees who answered; the customer reads "Our answer". */
  readonly answer?: { readonly at: string; readonly by?: string | null; readonly words?: string | null } | null
}

export interface RequestView {
  readonly kind: Phrase
  readonly state: Phrase
  readonly tone: Tone
  readonly asked: Phrase
  /** Office, while open: how long it waits on us (amber after 1 working day). */
  readonly waiting: WaitingView | null
}

const REQUEST_TONE: Readonly<Record<RequestState, Tone>> = Object.freeze({ OPEN: 'warning', COUNTERED: 'warning', ACCEPTED: 'success', REFUSED: 'danger', WITHDRAWN: 'neutral' })

/**
 * A request's head in the face's words: office "Waiting on us · 4 h", the customer "Being reviewed" (only true states).
 * `when` is the asked moment already written by the part.
 */
export function requestView(face: Face, input: RequestInput, now: number, when: string): RequestView {
  const asked = face === 'customer' ? phrase(input.mine ? 'parts.request.askedByYou' : 'parts.request.askedAt', { when }) : input.askedBy ? phrase('parts.request.askedBy', { name: input.askedBy, when }) : phrase('parts.request.askedAt', { when })
  const open = waitingView('office', { who: 'US', since: input.askedAt, kind: 'request' }, now)
  return {
    kind: phrase(`parts.request.kind.${input.kind}`),
    state: phrase(`parts.request.${face}.${input.state}`),
    tone: face === 'customer' && input.state === 'OPEN' ? 'info' : REQUEST_TONE[input.state],
    asked,
    waiting: face === 'office' && input.state === 'OPEN' && open !== 'unknown' ? open : null,
  }
}

// ---- holds (09-design §1.7) --------------------------------------------------------------------------------------------------

/** A quality hold (today's), the factory's production hold, or a pause the customer asked for (B-PR-15 WorkOrderHold). */
export const HOLD_KINDS = ['QUALITY', 'PRODUCTION', 'BRAND'] as const
export type HoldKind = (typeof HOLD_KINDS)[number]

export interface HoldInput {
  readonly id: string
  readonly kind: HoldKind
  /** Since when (`YYYY-MM-DD` or an instant). */
  readonly since: string
  /** Office only: the reason as the office reads it ("Quality: shade difference"). */
  readonly reason?: string | null
  /** The curated words the customer reads ("Extra quality checks"); never the office's reason. */
  readonly customerWords?: string | null
}

const HOLD_RANK: Readonly<Record<HoldKind, number>> = Object.freeze({ QUALITY: 0, PRODUCTION: 1, BRAND: 2 })

/** One banner per page, the most serious (quality, then production, then a pause; the oldest first); the rest counted. */
export function mostSerious(holds: readonly HoldInput[]): { hold: HoldInput | null; more: number } {
  const sorted = [...holds].sort((a, b) => HOLD_RANK[a.kind] - HOLD_RANK[b.kind] || a.since.localeCompare(b.since))
  return { hold: sorted[0] ?? null, more: Math.max(0, sorted.length - 1) }
}

export interface HoldView {
  readonly tone: Tone
  readonly title: Phrase
  readonly body: Phrase | null
}

/**
 * Office: "On hold since 14 Nov · Quality: shade difference" and when it goes on. Customer: curated words only — "Paused at
 * your request since 14 Nov", or "On hold since 14 Nov: Extra quality checks" and "We tell you when it continues."
 * `since` is passed through written by the part.
 */
export function holdView(face: Face, hold: HoldInput, since: string): HoldView {
  const tone: Tone = hold.kind === 'QUALITY' ? 'danger' : 'warning'
  if (face === 'office') {
    return {
      tone,
      title: hold.reason ? phrase('parts.hold.office.titleWhy', { date: since, reason: hold.reason }) : phrase('parts.hold.office.title', { date: since }),
      body: phrase(`parts.hold.office.${hold.kind}`),
    }
  }
  if (hold.kind === 'BRAND') return { tone, title: phrase('parts.hold.customer.paused', { date: since }), body: null }
  return {
    tone,
    title: hold.customerWords ? phrase('parts.hold.customer.titleWhy', { date: since, words: hold.customerWords }) : phrase('parts.hold.customer.title', { date: since }),
    body: phrase('parts.hold.customer.next'),
  }
}

// ---- freshness (09-design §1.9, R7) ------------------------------------------------------------------------------------------

/** Live by push, read again on a timer, offline, or still connecting. "Live" only when pushed. */
export type FreshMode = 'live' | 'polling' | 'offline' | 'connecting'

export interface FreshView {
  readonly words: Phrase
  /** The live dot's tone; null: no dot. */
  readonly dot: Tone | null
}

/** "● Live · as of 10:42", "Updated 10:42 · refreshes every minute", "Offline · as of 10:44"; `time` already written. */
export function freshView(mode: FreshMode, time: string | null, everySeconds = 60): FreshView {
  if (mode === 'connecting') return { words: phrase('parts.fresh.connecting'), dot: null }
  if (time === null) return { words: phrase('parts.fresh.never'), dot: null }
  if (mode === 'live') return { words: phrase('parts.fresh.live', { time }), dot: 'success' }
  if (mode === 'offline') return { words: phrase('parts.fresh.offline', { time }), dot: 'neutral' }
  return everySeconds === 60 ? { words: phrase('parts.fresh.everyMinute', { time }), dot: null } : { words: phrase('parts.fresh.everySeconds', { time, count: everySeconds }), dot: null }
}
