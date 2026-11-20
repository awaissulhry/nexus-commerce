import type { Order } from '../../api'
import type { Phrase } from '../../model'
import type { Dates, Headline } from './api'
import { AFTER } from './model'
// ---- F-OO-143: a refused new date (the ONE waiting list's DATE row) and Decide… (the ONE promise dialog, its follow-up named) ----
import { romeToday } from '../../model'
import type { WaitingRow } from './model'
import type { BandDialog, RecordDialog } from '../record-model'
// ---- end F-OO-143
// ---- F-OO-145: the steps before production in place — Planning's own gate model (a one-order subset of its read), its held words ----
import type { Gate } from './api'
import type { GateBody, Gate as PlanningGate, Milestone as PlanningMilestone, Milestones, Order as PlanningOrder } from '../../../../planning/milestones/api'
import { bodyOf, DEFAULT_CONTROLS, heldOf, queryOf, type GateDraft, type Translate } from '../../../../planning/milestones/model'
import { GATE_KINDS, GATE_STATES, LEATHER_STATES, MILESTONE_KINDS, MILESTONE_STATES, PASS_VIAS, WAITING_TILES } from '@nexus/factory-domain/planning/milestones/rules'
// ---- end F-OO-145

/**
 * F-OO-100 (order overview lane: one file per section) — Next dates, its rules moved out of model.ts unchanged (F-SA-233, P16).
 * The requested date's field id stays in model.ts: Lines and the overview acts read it too.
 *
 * F-OO-141 (order overview lane; 10-design §4; review F8): the card's rows — the promise first (how often it moved), what the plan
 * says against it (derived: "(from the plan)"), the date the customer asked for, then the order's open gates. The shipping
 * milestone is never listed (its target IS the promise, its own row), nor "Production start" (not a next date, review F8).
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

/** One of the order's open gates (late first). */
export interface NextDate {
  readonly id: string
  /** The gate this milestone is (a Discuss names it by its reference); null: none read. */
  readonly gateId: string | null
  readonly gateKind: string | null
  readonly label: string | null
  readonly target: string | null
  readonly late: number | null
}

/** The next open gates, three at most: late first (most late first), then by target. Only gates (F-OO-141). */
export function nextDatesOf(dates: Dates | null | undefined, count = 3): NextDate[] {
  const open = (dates?.milestones ?? []).filter((row) => row.kind === 'GATE' && row.state !== 'DONE')
  const sorted = [...open].sort((a, b) => Number((b.late ?? 0) > 0) - Number((a.late ?? 0) > 0) || (b.late ?? 0) - (a.late ?? 0) || (a.target ?? '9999').localeCompare(b.target ?? '9999'))
  return sorted.slice(0, count).map((row) => ({ id: row.id, gateId: row.gateId, gateKind: row.gateKind, label: row.label, target: row.target, late: row.late }))
}

// ---- F-OO-141: Promised (ex-factory) and what the plan says against it -----------------------------------------------------------

/** "Promised (ex-factory)": the promise in force and how it moved; null without a promise ("—"). */
export interface PromiseRow {
  readonly date: string
  /** "{date} · moved 2× · +6 d since first promised" or "{date} · moved 1×"; null: it never moved (a first promise is no move, B-OO-007). */
  readonly moved: Phrase | null
}

export function promiseRowOf(order: Pick<Order, 'promiseDate'>, headline: Pick<Headline, 'promise'> | null | undefined): PromiseRow | null {
  const date = headline?.promise.date ?? order.promiseDate
  if (!date) return null
  const moves = headline?.promise.moves ?? 0
  const slip = headline?.promise.slipDays ?? null
  if (moves > 0 && slip !== null && slip !== 0) return { date, moved: phrase('dates.promisedMoved', { date, count: moves, days: slip > 0 ? `+${slip}` : String(slip) }) }
  if (moves > 0) return { date, moved: phrase('dates.promisedMovedOnly', { date, count: moves }) }
  return { date, moved: null }
}

/**
 * "Plan says ready": the published plan's finish against the promise — after it (by n days), before it, on the promise day; with
 * no promise, the plan's day alone; nothing planned yet ("Nothing plans it yet"). Derived, never set here. Not said when the dates
 * were not read (no claim) nor after production (the plan is history then).
 */
export type PlanSays =
  | { readonly kind: 'after'; readonly date: string; readonly days: number }
  | { readonly kind: 'before'; readonly date: string; readonly days: number }
  | { readonly kind: 'same'; readonly date: string }
  | { readonly kind: 'plain'; readonly date: string }
  | { readonly kind: 'none'; readonly warn: boolean }

/** Days from one calendar day to another (`YYYY-MM-DD`, whole days; a later `to` is positive). */
const daysFrom = (from: string, to: string): number => Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000)

export function planSaysOf(order: Pick<Order, 'status'>, promise: string | null, dates: Pick<Dates, 'planned'> | null | undefined): PlanSays | null {
  if (!dates || AFTER.includes(order.status)) return null
  const finish = dates.planned.finish
  // Nothing plans an order that has a promise: amber, the cause of "At risk" (a waiting order is not planned yet: plain words).
  if (!finish) return { kind: 'none', warn: !!promise && order.status !== 'PENDING_APPROVAL' }
  if (!promise) return { kind: 'plain', date: finish }
  const days = daysFrom(promise, finish)
  if (days > 0) return { kind: 'after', date: finish, days }
  if (days < 0) return { kind: 'before', date: finish, days: -days }
  return { kind: 'same', date: finish }
}

/** The plan's words in amber: it ends after the promise, or nothing plans an order that has one. */
export const planWarns = (plan: PlanSays): boolean => plan.kind === 'after' || (plan.kind === 'none' && plan.warn)
// ---- end F-OO-141

// ---- F-OO-143 (order overview 10-design §4.2; review F1, F3; replaces F-OP-105): the new date the customer refused ----------------
/**
 * How long a waiting row has waited: whole days from the Rome day it started to today (Rome); 0 the same day; null when the read
 * does not know when it started. Never negative (a start "after" today is today).
 */
export function ageDaysOf(since: string | null, today: string): number | null {
  if (!since) return null
  const start = Date.parse(since)
  if (Number.isNaN(start)) return null
  return Math.max(0, daysFrom(romeToday(new Date(start)), today))
}

/** An age in words: "2 d" / "2 g", the same day "today" / "oggi". */
export const ageWordsOf = (days: number): Phrase => (days === 0 ? phrase('dates.ageToday') : phrase('dates.age', { days }))

/** A new date the customer refused whose follow-up is still open: the waiting list's DATE row BRAND_REQUEST · REPROMISE (F3). */
export interface RefusedDate {
  readonly key: string
  /** The refused REPROMISE request — its follow-up task has the same id (planning/promise-keep brand-answer). */
  readonly requestId: string
  /** Days since the customer refused it (the row's `since` = the answer's time); null: not known. */
  readonly age: number | null
}

/**
 * The refused new dates of the ONE waiting list (`waiting.dates`, never a second read): each REPROMISE row with its request. The row
 * carries no date (review F1: "refused the new date", today's words). It is a date, so it is not in the Changes badge (F3).
 */
export function refusedDatesOf(rows: readonly Pick<WaitingRow, 'key' | 'kind' | 'sub' | 'ref' | 'since' | 'place'>[], today: string): RefusedDate[] {
  return rows.flatMap((row) => (row.place === 'DATE' && row.kind === 'BRAND_REQUEST' && row.sub === 'REPROMISE' && row.ref?.type === 'ApprovalRequest' ? [{ key: row.key, requestId: row.ref.id, age: ageDaysOf(row.since, today) }] : []))
}

/** Decide…: the ONE promise dialog (BandDialog `promise`) with the refused request named — no "Keep the date" (N14 dropped). */
export const decideDialogOf = (refused: Pick<RefusedDate, 'requestId'>): BandDialog => ({ kind: 'promise', followUp: { requestId: refused.requestId } })

/** The promise dialog's follow-up when Decide… opened it; null when Change… did (or another dialog is open). */
export const followUpOf = (dialog: RecordDialog | null | undefined): { readonly requestId: string } | null => (dialog?.kind === 'promise' ? (dialog.followUp ?? null) : null)
// ---- end F-OO-143

// ---- F-OO-145 (order overview 10-design §4.2; 13-backend B-OO-010; review F8): the steps before production, moved in place ----------
/** One of the order's open gates as Next dates draws it: the milestone, its state, its age and the read's gate (version, moves). */
export interface GateDate extends NextDate {
  /** The milestone's state (Planning's words `state.*`: Waiting, Started before, To come). */
  readonly state: string
  /** Days since the gate began to wait (its DATE row of the ONE waiting list: a gate, or Trims in as "material short"); null: not known. */
  readonly age: number | null
  /** The read's gate (B-OO-010: its version and what THIS reader may do with it); null: the read did not send it. */
  readonly gate: Gate | null
}

/**
 * The open gates Next dates lists — late first, three at most (nextDatesOf) — each with its state, its age from its own DATE row
 * (`ref` OrderGate: the waiting list's one row of that gate, never a second rule) and the read's gate; `more`: the open gates past
 * the three ("{n} more in All dates ›").
 */
export function gateDatesOf(dates: Dates | null | undefined, waiting: readonly Pick<WaitingRow, 'ref' | 'since' | 'place'>[], today: string, count = 3): { readonly rows: readonly GateDate[]; readonly more: number } {
  const open = nextDatesOf(dates, Number.MAX_SAFE_INTEGER)
  const rows = open.slice(0, count).map((row) => {
    const own = row.gateId ? waiting.find((entry) => entry.place === 'DATE' && entry.ref?.type === 'OrderGate' && entry.ref.id === row.gateId) : undefined
    return {
      ...row,
      state: dates?.milestones.find((entry) => entry.id === row.id)?.state ?? 'TO_COME',
      age: own ? ageDaysOf(own.since, today) : null,
      gate: (row.gateId ? dates?.gates.find((gate) => gate.id === row.gateId) : undefined) ?? null,
    }
  })
  return { rows, more: Math.max(0, open.length - rows.length) }
}

/** A gate's moves in More ▾, in this order: Planning's own dialogs (edit, pass, start before), the conversation, Planning itself. */
export const GATE_MOVES = ['move', 'done', 'startBefore', 'discuss', 'planning'] as const
export type GateMove = (typeof GATE_MOVES)[number]

/** Which of the gate's own actions (Planning's read for THIS reader) holds each of its dialogs. */
export const GATE_MOVE_ACTION: Readonly<Record<'move' | 'done' | 'startBefore', 'edit' | 'pass' | 'startBefore'>> = Object.freeze({ move: 'edit', done: 'pass', startBefore: 'startBefore' })

const isOf = <T extends string>(list: readonly T[], value: string | null | undefined): value is T => typeof value === 'string' && (list as readonly string[]).includes(value)

/**
 * The read's gate as Planning's own page reads it (its api `Gate`), or null when the read cannot say it whole: an older answer (no
 * version, no moves) or a kind or state this page does not know — its moves are then held "Not possible now.", never guessed.
 * What the order read does not carry is not made up where a dialog reads it: the gate's own planner id and maker (the API keeps
 * them; the edit dialog starts from the planner shown and sends a planner only when one is picked — gateChangesOf), its passing
 * (an open gate has none) and its held work orders (only Remove reads them, and this page never offers Remove).
 */
export function planningGateOf(gate: Gate, orderId: string): PlanningGate | null {
  if (gate.version === undefined || !gate.actions || !isOf(GATE_KINDS, gate.kind) || !isOf(GATE_STATES, gate.state)) return null
  return {
    id: gate.id,
    salesOrderId: orderId,
    kind: gate.kind,
    label: gate.label,
    targetDate: gate.targetDate,
    sampleRound: gate.sampleRound,
    owner: gate.owner,
    ownerId: null,
    makerId: null,
    state: gate.state,
    passedOn: gate.passedOn,
    passedAt: null,
    passedBy: null,
    via: isOf(PASS_VIAS, gate.via) ? gate.via : null,
    startedBefore: gate.startedBefore,
    leather: isOf(LEATHER_STATES, gate.leather) ? gate.leather : null,
    holds: 0,
    version: gate.version,
    actions: gate.actions,
  }
}

/**
 * Planning's one read (`Milestones`) for THIS order alone, built from the order page's own read (the `dates` part, under orders.view)
 * — the honest subset its dialogs read: the order (number, customer), its gates and milestones, today. Nothing else is claimed: no
 * tiles to count (zero), no other order, no work orders, Add a gate not offered here. Null while the dates are not read.
 */
export function gateWorldOf(order: Pick<Order, 'id' | 'number' | 'companyId' | 'partyId' | 'party' | 'status' | 'promiseDate' | 'customerRef'>, dates: Dates | null | undefined, today: string): Milestones | null {
  if (!dates) return null
  const milestones: PlanningMilestone[] = dates.milestones.flatMap((row) =>
    isOf(MILESTONE_KINDS, row.kind) && isOf(MILESTONE_STATES, row.state) ? [{ id: row.id, kind: row.kind, gateId: row.gateId, gateKind: isOf(GATE_KINDS, row.gateKind) ? row.gateKind : null, label: row.label, salesOrderId: order.id, target: row.target, actual: row.actual, state: row.state, late: row.late, owner: row.owner }] : [],
  )
  const one: PlanningOrder = {
    id: order.id,
    number: order.number,
    companyId: order.companyId,
    customer: { id: order.partyId, code: order.party?.code ?? '', name: order.party?.legalName ?? '' },
    status: order.status,
    promiseDate: order.promiseDate,
    customerRef: order.customerRef,
    workOrders: { count: 0, notStarted: 0, byKind: [] },
    gates: dates.gates.flatMap((gate) => planningGateOf(gate, order.id) ?? []),
    milestones,
    waiting: [],
    late: dates.late,
    next: dates.next,
    mayAddGate: { allowed: false, needs: null, refusal: null },
  }
  return { today, timeZone: 'Europe/Rome', tiles: Object.fromEntries(WAITING_TILES.map((tile) => [tile, 0])) as Milestones['tiles'], orders: [one], truncated: false }
}

/** "Move the date…": Planning's Change the gate, its draft as the gate is read (the planner shown, the round named). */
export const gateDraftOf = (gate: PlanningGate): GateDraft => ({ kind: gate.kind, label: gate.label ?? '', targetDate: gate.targetDate ?? '', sampleRoundId: gate.sampleRound?.id ?? '', ownerId: gate.owner?.id ?? '' })

/**
 * What Save sends (Planning's PATCH, with the gate's version beside it): only what the person changed — an untouched field is left
 * out, so the API keeps it as it is (its own planner too, which this read does not carry). The kind never changes.
 */
export function gateChangesOf(initial: GateDraft, draft: GateDraft): GateBody {
  const was = bodyOf(initial)
  const now = bodyOf(draft)
  return {
    ...(now.label !== was.label ? { label: now.label } : {}),
    ...(now.targetDate !== was.targetDate ? { targetDate: now.targetDate } : {}),
    ...(now.sampleRoundId !== was.sampleRoundId ? { sampleRoundId: now.sampleRoundId } : {}),
    ...(now.ownerId !== was.ownerId ? { ownerId: now.ownerId } : {}),
  }
}

/** One item of a gate's More ▾ and why it waits, in Planning's catalogue words (its `needs.*` / `refusal.*`); null: it may go. */
export interface GateMoveItem {
  readonly id: GateMove
  readonly held: string | null
}

/**
 * A gate's More ▾: Move the date… (edit), Mark done… (pass), Start before the gate… (start before) — each held by the gate's own
 * `actions.*` through Planning's heldOf (the right it needs, then its refusal CODE: catalogue words in both languages, never the API's
 * English `message`); Sales sees them held. Discuss this date where the page has a conversation; Open in Planning › with planning.view
 * (held in words without it). A gate the read cannot say whole: its dialogs "Not possible now.".
 */
export function gateMovesOf(gate: Gate | null, orderId: string, input: { readonly thread: boolean; readonly planningView: boolean; readonly busy: boolean }, t: Translate): GateMoveItem[] {
  const usable = gate ? planningGateOf(gate, orderId) : null
  const act = (move: keyof typeof GATE_MOVE_ACTION): GateMoveItem => ({ id: move, held: heldOf(usable?.actions[GATE_MOVE_ACTION[move]], t, input.busy) })
  return [act('move'), act('done'), act('startBefore'), ...(input.thread ? [{ id: 'discuss' as const, held: null }] : []), { id: 'planning', held: input.planningView ? null : t('needs.planning.view') }]
}

/** Read-only sees no More ▾ — unless the read says this reader may move a gate (a planner who changes nothing else on the order). */
export const gateMovesShown = (readOnly: boolean, gates: readonly Pick<GateDate, 'gate'>[]): boolean => !readOnly || gates.some((row) => !!row.gate?.actions && Object.values(row.gate.actions).some((action) => action.allowed))

/** Open in Planning ›: Time & action, searched by the order's number, the gate's dialog open (a gate the read did not name: the search alone). */
export const planningGateHref = (prefix: string, number: string, gateId: string | null): string => `${prefix}/planning/milestones?${queryOf({ ...DEFAULT_CONTROLS, q: number, open: gateId ? `gate:${gateId}` : null })}`
// ---- end F-OO-145
