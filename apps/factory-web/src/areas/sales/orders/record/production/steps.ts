import type { Order } from '../../api'
import { depositGate } from '../../model'
import type { DateMilestone, Dates, Gate, GateAction } from '../overview/api'
import { daysBetween } from './now'

/**
 * F-PT-202 (order PRODUCTION tab, 10-design §5 Block B, S3; bugs B11, B15–B20) — the steps to shipping (time & action), without a
 * screen: the deposit FIRST (production waits for it — its door is Money), then the order's gates, production start "(working
 * plan)", shipping "(the promise)" — each with its planned and done day, ONE status word set and ONE tone, who acts, and what THIS
 * reader may do: one primary (Mark done… while the gate waits and Planning allows it) and the rest in its ⋯, each by the gate's own
 * actions (Planning's read for this reader): allowed → offered; a right missing → HIDDEN (L9); refused by the gate's state → held
 * with Planning's words. Readers with no gate act may ask the gate's planner for an update (an office note).
 */

export type StepKind = 'DEPOSIT' | 'GATE' | 'START' | 'SHIP'
export type StepStatus = { readonly kind: 'done' } | { readonly kind: 'late'; readonly days: number } | { readonly kind: 'soon'; readonly days: number } | { readonly kind: 'waiting' } | { readonly kind: 'startedBefore' } | { readonly kind: 'toCome' }

/** Who acts on a step, in words the view says (B-S3: derived on the web). */
export type WhoActs =
  | { readonly kind: 'customerDeposit' }
  | { readonly kind: 'customerSample' }
  | { readonly kind: 'planner'; readonly name: string | null }
  | { readonly kind: 'production' }
  | { readonly kind: 'shipping' }
  | { readonly kind: 'nobody' }

export interface StepRow {
  readonly id: string
  readonly kind: StepKind
  readonly milestoneId: string | null
  readonly gateId: string | null
  readonly gateKind: string | null
  readonly label: string | null
  readonly planned: string | null
  readonly done: string | null
  readonly status: StepStatus
  readonly who: WhoActs
  /** The read's gate (its version and this reader's actions); null for the deposit, start and shipping. */
  readonly gate: Gate | null
}

/** "Waiting · in 3 days" turns amber from this many days before the target (B17: one tone rule). */
export const SOON_DAYS = 3
const SAMPLE_GATES = new Set(['SAMPLE_APPROVED', 'PP_SAMPLE', 'SIZE_SET'])

function statusOf(row: Pick<DateMilestone, 'state' | 'late' | 'target'>, today: string): StepStatus {
  if (row.state === 'DONE') return { kind: 'done' }
  if (row.state === 'STARTED_BEFORE') return { kind: 'startedBefore' }
  if ((row.late ?? 0) > 0) return { kind: 'late', days: row.late! }
  if (row.state === 'WAITING') {
    const days = row.target ? daysBetween(today, row.target) : null
    return days !== null && days >= 0 && days <= SOON_DAYS ? { kind: 'soon', days } : { kind: 'waiting' }
  }
  return { kind: 'toCome' }
}

function whoOf(row: DateMilestone, gate: Gate | null): WhoActs {
  if (row.kind === 'START') return { kind: 'production' }
  if (row.kind === 'SHIP') return { kind: 'shipping' }
  if (gate?.sampleRound || (row.gateKind && SAMPLE_GATES.has(row.gateKind))) return { kind: 'customerSample' }
  const owner = row.owner ?? gate?.owner ?? null
  return owner ? { kind: 'planner', name: owner.name } : { kind: 'nobody' }
}

/** The deposit, then every milestone of the read in its own order (the read sends them gates → start → shipping). */
export function stepsOf(order: Pick<Order, 'depositRequired' | 'chain'>, dates: Dates | null | undefined, today: string): StepRow[] {
  const gate = depositGate(order)
  const deposit: StepRow[] =
    gate.state === 'NOT_NEEDED'
      ? []
      : [
          {
            id: 'deposit',
            kind: 'DEPOSIT',
            milestoneId: null,
            gateId: null,
            gateKind: null,
            label: null,
            planned: gate.request?.dueDate ?? null,
            done: gate.state === 'PAID' ? (gate.request?.paidAt ?? null) : null,
            status: gate.state === 'PAID' || gate.state === 'WAIVED' ? { kind: 'done' } : gate.request && gate.request.dueDate < today ? { kind: 'late', days: daysBetween(gate.request.dueDate, today) } : { kind: 'waiting' },
            who: { kind: 'customerDeposit' },
            gate: null,
          },
        ]
  const rows = (dates?.milestones ?? []).map((row): StepRow => {
    const own = row.gateId ? (dates?.gates.find((entry) => entry.id === row.gateId) ?? null) : null
    return { id: row.id, kind: row.kind === 'START' || row.kind === 'SHIP' ? row.kind : 'GATE', milestoneId: row.id, gateId: row.gateId, gateKind: row.gateKind, label: row.label, planned: row.target, done: row.actual, status: statusOf(row, today), who: whoOf(row, own), gate: own }
  })
  return [...deposit, ...rows]
}

/** The block's chip: "N late" (OPEN steps past their day only — a step done late is no longer late, B15), "All done", or "On track". */
export type StepsChip = { readonly kind: 'late'; readonly count: number } | { readonly kind: 'allDone' } | { readonly kind: 'onTrack' } | null

export function stepsChipOf(rows: readonly StepRow[]): StepsChip {
  if (rows.length === 0) return null
  const late = rows.filter((row) => row.status.kind === 'late').length
  if (late > 0) return { kind: 'late', count: late }
  return rows.every((row) => row.status.kind === 'done') ? { kind: 'allDone' } : { kind: 'onTrack' }
}

/** "Now: Trims in · waits on the planner · 3 days late (target 18 Nov)": the first open step (late first), else none. */
export function nowStepOf(rows: readonly StepRow[]): StepRow | null {
  return rows.find((row) => row.status.kind === 'late') ?? rows.find((row) => row.status.kind === 'waiting' || row.status.kind === 'soon') ?? rows.find((row) => row.status.kind === 'toCome') ?? null
}

// ---- what this reader may do with a step (L9) -----------------------------------------------------------------------------------

/** One act of a step: offered (held null), held by the gate's state with Planning's words (a refusal), or not offered (a right missing). */
export type StepAct = 'done' | 'move' | 'startBefore' | 'remove'
export const STEP_ACT_ACTION: Readonly<Record<StepAct, 'pass' | 'edit' | 'startBefore' | 'remove'>> = Object.freeze({ done: 'pass', move: 'edit', startBefore: 'startBefore', remove: 'remove' })

/** Whether an act is offered: allowed, or refused by the state (said in words); never when a right is missing or the read cannot say. */
export const offeredOf = (action: GateAction | undefined): boolean => !!action && !action.needs && (action.allowed || !!action.refusal)

export interface StepActs {
  /** The ONE primary: Mark done… while the gate is open and the reader may pass it. */
  readonly primary: 'done' | null
  /** The ⋯: the gate's other acts this reader is offered (each held in words when the state refuses it). */
  readonly more: readonly StepAct[]
  /** The reader has no gate act at all: "Ask {planner} for an update" instead (threads.post). */
  readonly askOnly: boolean
}

export function stepActsOf(row: StepRow): StepActs {
  if (row.kind !== 'GATE' || !row.gate?.actions || row.status.kind === 'done') return { primary: null, more: [], askOnly: row.kind === 'GATE' && row.status.kind !== 'done' }
  const actions = row.gate.actions
  const primary = actions.pass.allowed ? ('done' as const) : null
  const more = (['move', 'startBefore', 'remove', 'done'] as const).filter((act) => (act === 'done' ? !primary && offeredOf(actions.pass) : offeredOf(actions[STEP_ACT_ACTION[act]])))
  return { primary, more, askOnly: !primary && more.length === 0 }
}
