import { WAITING_ON, type WaitingOn } from '@nexus/factory-domain/production-brand/waiting'
import type { WorkOrderStatus } from '@nexus/factory-domain/production/work-orders/machine'
import type { RowRisk, RowWaiting } from '../work-orders/risk'

/**
 * B-PR-33 — the all-customers overview's sums, pure (production plan §5 "Production › Overview"; 06-tree A.1; the Owner rule
 * 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be
 * able to see it all. And manage it all as well."). ./read gives one fact per open work order the reader reaches (the B-PR-03
 * wall already applied), this file adds them up per row (one customer, the mixed work orders made before the rule, the work of no
 * customer) and for the Total — so a person limited to some customers only ever gets sums of their own customers' work orders.
 *
 * The figures are the Work orders list's (every number opens that list with its filters, F-PR-04):
 *   in production  open work orders (DRAFT, RELEASED, IN_PROGRESS, ON_HOLD) and their pieces (`?open=true`)
 *   late, at risk, blocked     the risk state of ../work-orders/risk (`?risk=LATE|AT_RISK|BLOCKED`)
 *   waiting on     the keeper's waiting of its order(s) — us, the customer, a supplier, a workshop (`?waitingOn=`)
 *   blocked by     HOLD, CUSTOMER, MATERIAL whatever the risk state (`?blockedBy=`); GATE = a production work order not started
 *                  whose open order waits on a gate (the planning board does not place it; `?gate=true`); NEEDS_SPLIT = a work
 *                  order made before the one-customer rule with cells of several customers (`?mixed=true`)
 *   customer urgency  open work orders whose customer marked their order Urgent and whose urgency counts (B-PR-22b)
 *
 * WIP by stage (06-tree A.1 note, the office's words; pieces, never a person): Not released = pieces of DRAFT work orders ·
 * Released = of RELEASED ones (not started) · Cutting = pieces of a started one not cut yet · Sewing = cut, not sewn and not out ·
 * At workshop = pieces on its open subcontract orders not back · Quality = sewn, not through the final step · Finished = through
 * the final step, still on the open work order · On hold = pieces of held work orders (counted only there). A stage the floor does
 * not count for a work order (a routing whose sewing or final step is not scanned) is null for it ("—"), never a made-up 0; a row's
 * stage is the sum of what is counted, null only when nothing there is counted.
 */

export const WIP_STAGES = ['NOT_RELEASED', 'RELEASED', 'CUTTING', 'SEWING', 'AT_WORKSHOP', 'QUALITY', 'FINISHED', 'ON_HOLD'] as const
export type WipStage = (typeof WIP_STAGES)[number]

/** What blocks a work order on the overview: the list's three (../work-orders/risk) and the overview's two. */
export const OVERVIEW_BLOCKS = ['HOLD', 'CUSTOMER', 'MATERIAL', 'GATE', 'NEEDS_SPLIT'] as const
export type OverviewBlock = (typeof OVERVIEW_BLOCKS)[number]

/** Whose row a work order counts in: its one customer, the mixed ones made before the rule, or the work of no customer. */
export type GroupKey = { readonly kind: 'CUSTOMER'; readonly partyId: string } | { readonly kind: 'MIXED' } | { readonly kind: 'NO_CUSTOMER' }

export const groupId = (group: GroupKey): string => (group.kind === 'CUSTOMER' ? `customer:${group.partyId}` : group.kind)

/** A work order's progress summed over its cells (work-orders views progressTotalsOf): null where a step is not counted. */
export interface ProgressCounts {
  readonly cut: number | null
  readonly bundled: number | null
  readonly sewn: number | null
  readonly finished: number | null
}

/** One open work order's pieces per stage: only the stages it is in; a stage it is in but the floor does not count is null. */
export type StageShare = Partial<Record<WipStage, number | null>>

const clamp = (value: number, max: number): number => Math.max(0, Math.min(value, max))

/**
 * The pieces of one open work order per WIP stage. A started one (IN_PROGRESS) is split by its progress: a garment is cut once
 * cut or bundled (or sewn, or through the final step: it was cut); `atWorkshop` of the cut ones are out; finished ones were sewn.
 */
export function stageShareOf(input: { readonly status: WorkOrderStatus; readonly pieces: number; readonly progress: ProgressCounts | null; readonly atWorkshop: number }): { readonly share: StageShare; readonly sewingNotCounted: boolean } {
  const { status, pieces } = input
  if (status === 'DRAFT') return { share: { NOT_RELEASED: pieces }, sewingNotCounted: false }
  if (status === 'RELEASED') return { share: { RELEASED: pieces }, sewingNotCounted: false }
  if (status === 'ON_HOLD') return { share: { ON_HOLD: pieces }, sewingNotCounted: false }
  if (status !== 'IN_PROGRESS') return { share: {}, sewingNotCounted: false }
  const progress = input.progress ?? { cut: null, bundled: null, sewn: null, finished: null }
  const finished = progress.finished === null ? null : clamp(progress.finished, pieces)
  const sewn = progress.sewn === null ? null : clamp(Math.max(progress.sewn, finished ?? 0), pieces)
  const cut = clamp(Math.max(progress.cut ?? 0, progress.bundled ?? 0, sewn ?? 0, finished ?? 0), pieces)
  const out = clamp(input.atWorkshop, cut)
  return {
    share: {
      CUTTING: pieces - cut,
      AT_WORKSHOP: out,
      SEWING: sewn === null ? null : Math.max(0, cut - sewn - out),
      QUALITY: sewn === null || finished === null ? null : Math.max(0, sewn - finished),
      FINISHED: finished,
    },
    sewingNotCounted: sewn === null,
  }
}

/** One open work order as the overview adds it up (./read). */
export interface OverviewFact {
  readonly id: string
  readonly group: GroupKey
  readonly status: WorkOrderStatus
  readonly pieces: number
  readonly risk: RowRisk | null
  readonly waiting: RowWaiting | null
  /** A production work order not started whose open order waits on a gate. */
  readonly gate: boolean
  /** Made before the one-customer rule with cells of several customers. */
  readonly mixed: boolean
  /** Its customer's urgency that counts is Urgent. */
  readonly customerUrgent: boolean
  readonly share: StageShare
  readonly sewingNotCounted: boolean
}

export interface StageSums {
  readonly stages: Record<WipStage, number | null>
  /** Started work orders whose sewing the floor does not count ("sewing not counted here"). */
  readonly sewingNotCounted: number
}

export interface Tally {
  /** Open work orders and their pieces. */
  readonly workOrders: number
  readonly pieces: number
  readonly late: number
  readonly atRisk: number
  readonly blocked: number
  readonly waitingOn: Record<WaitingOn, number>
  readonly blockedBy: Record<OverviewBlock, number>
  readonly customerUrgent: number
  readonly wip: StageSums
}

const zeros = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>

/** The sums of these work orders (one row, or the Total). */
export function tallyOf(facts: readonly OverviewFact[]): Tally {
  const waitingOn = zeros(WAITING_ON)
  const blockedBy = zeros(OVERVIEW_BLOCKS)
  const sums = zeros(WIP_STAGES)
  const counted = new Set<WipStage>()
  const uncounted = new Set<WipStage>()
  let pieces = 0
  let late = 0
  let atRisk = 0
  let blocked = 0
  let customerUrgent = 0
  let sewingNotCounted = 0
  for (const fact of facts) {
    pieces += fact.pieces
    if (fact.risk?.state === 'LATE') late += 1
    if (fact.risk?.state === 'AT_RISK') atRisk += 1
    if (fact.risk?.state === 'BLOCKED') blocked += 1
    if (fact.waiting) waitingOn[fact.waiting.on] += 1
    if (fact.risk?.blockedBy) blockedBy[fact.risk.blockedBy] += 1
    if (fact.gate) blockedBy.GATE += 1
    if (fact.mixed) blockedBy.NEEDS_SPLIT += 1
    if (fact.customerUrgent) customerUrgent += 1
    if (fact.sewingNotCounted) sewingNotCounted += 1
    for (const stage of WIP_STAGES) {
      if (!(stage in fact.share)) continue
      const value = fact.share[stage]
      if (value === null || value === undefined) uncounted.add(stage)
      else {
        sums[stage] += value
        counted.add(stage)
      }
    }
  }
  const stages = Object.fromEntries(WIP_STAGES.map((stage) => [stage, counted.has(stage) || !uncounted.has(stage) ? sums[stage] : null])) as Record<WipStage, number | null>
  return { workOrders: facts.length, pieces, late, atRisk, blocked, waitingOn, blockedBy, customerUrgent, wip: { stages, sewingNotCounted } }
}

/** The facts grouped by row, in first-seen order of each group (./read sorts the customers by name). */
export function groupsOf(facts: readonly OverviewFact[]): Map<string, { readonly group: GroupKey; readonly facts: OverviewFact[] }> {
  const out = new Map<string, { group: GroupKey; facts: OverviewFact[] }>()
  for (const fact of facts) {
    const key = groupId(fact.group)
    const entry = out.get(key) ?? { group: fact.group, facts: [] }
    entry.facts.push(fact)
    out.set(key, entry)
  }
  return out
}

/** Whose row a work order counts in, from its one customer and its cells' customers. */
export function groupOf(row: { readonly partyId: string | null; readonly cellParties: readonly (string | null)[] }): GroupKey {
  if (row.partyId !== null) return { kind: 'CUSTOMER', partyId: row.partyId }
  return row.cellParties.some((party) => party !== null) ? { kind: 'MIXED' } : { kind: 'NO_CUSTOMER' }
}

/** A row's waiting customer requests: those that wait (OPEN or COUNTERED) and those this reader answers in Home › Approvals. */
export interface RequestCounts {
  readonly waiting: number
  readonly toAnswer: number
}

/** Requests per kind and status, as the office reads them (B-PR-26 waitingByKind, with the countered ones apart). */
export function requestsByKind<Kind extends string>(rows: readonly { readonly kind: Kind; readonly status: string }[], kinds: readonly Kind[]): { kind: Kind; open: number; countered: number }[] {
  return kinds.flatMap((kind) => {
    const open = rows.filter((row) => row.kind === kind && row.status === 'OPEN').length
    const countered = rows.filter((row) => row.kind === kind && row.status === 'COUNTERED').length
    return open + countered > 0 ? [{ kind, open, countered }] : []
  })
}
