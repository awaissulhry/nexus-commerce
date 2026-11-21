import type { ProgressFigure } from '../../../../../lib/production/model'
import { HELD_FOR_SALES, HELD_REOPEN, type MenuAct, type MenuLink, type RowActs } from '../../../../../lib/production/work-order-acts/model'
import type { WorkOrderChange } from '../../../../home/approvals/work-order-changes/api'
import type { MtmGroupRead, MtmUnitRead, Work, WorkOrderOwn, Words } from '../overview/api'
import { ownProgress, type CountedStep } from '../production'

/**
 * F-PT-104 (order PRODUCTION tab, 10-design §4, 15-steps W1; bugs B1–B6) — the Work orders section, without a screen: the head's one
 * answer, each work order as a row of the order's OWN pieces (the production read, B-SA-031: never another customer's), what the
 * reader may do with it (hidden without the right — L9 — held in words only by the row's state), the waiting decisions.
 *
 *   status        the catalogue's word; On hold has its own words and the warning tone (B1: never the raw key)
 *   Rush          our factory rush ("Rush"), never the customer's urgency ("Urgent (customer)", Production now's) — B3
 *   progress      ONE figure of its own cells (the furthest step counted: its words and its bar from the same number) and the other
 *                 steps beside it — a step its site does not count is "—", never 0; "Checked" for the quality step (B4)
 *   dates         Due (in place with the right), the plan's end and "after due" — the Production list's own risk facts (B-PT-001;
 *                 absent until the server sends them: the due day and its lateness only, never a made-up plan)
 *   materials     the production lane's readiness word, a door to #materials
 */

/** The work orders' status tones (On hold: warning — B1). */
export const WO_TONE: Readonly<Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'>> = Object.freeze({ DRAFT: 'neutral', RELEASED: 'info', IN_PROGRESS: 'info', ON_HOLD: 'warning', COMPLETED: 'success', CLOSED: 'neutral', CANCELLED: 'danger' })

/** The status word's key: the shared catalogue's (`woStatus.*`), On hold this tab's own (the shared catalogue has none — B1). */
export const statusKeyOf = (status: string): string => (status === 'ON_HOLD' ? 'productionTab.wo.onHold' : `woStatus.${status}`)

/** "3 work orders · 240 pieces for this order · 1 on hold · 1 after due" (made-to-measure units count one work order each). */
export interface WorkSummary {
  readonly count: number
  readonly pieces: number
  readonly onHold: number
  readonly afterDue: number
}

/** A row is past its due, or its plan ends after it (the risk facts when the server sends them; else the due's own lateness). */
export const afterDueOf = (row: Pick<WorkOrderOwn, 'daysLate' | 'risk'>): boolean => (row.daysLate ?? 0) > 0 || row.risk?.state === 'LATE' || !!row.risk?.planAfterDue

export function workSummaryOf(work: Pick<Work, 'workOrders' | 'mtm'>): WorkSummary {
  const rows = work.workOrders
  return {
    count: rows.length + work.mtm.reduce((sum, group) => sum + group.workOrders, 0),
    pieces: rows.reduce((sum, row) => sum + row.own.pieces, 0) + work.mtm.reduce((sum, group) => sum + group.own.pieces, 0),
    onHold: rows.filter((row) => row.held || row.status === 'ON_HOLD').length,
    afterDue: rows.filter((row) => !row.sharedWithOtherCustomers && afterDueOf(row)).length,
  }
}

/** The steps beside the figure ("Cut 160 · Checked 40"): the counted steps other than the figure's own; not counted: null ("—"). */
export interface StepCount {
  readonly step: 'cut' | 'sewn' | 'checked'
  readonly value: number | null
}

const STEP_OF: Readonly<Record<CountedStep, StepCount['step']>> = Object.freeze({ cut: 'cut', sewn: 'sewn', finished: 'checked' })

export interface WorkProgress {
  readonly figure: ProgressFigure
  /** The figure's step in this tab's words (cut / sewn / checked); null: no figure (a draft, nothing counted). */
  readonly step: StepCount['step'] | null
  readonly others: readonly StepCount[]
}

export function workProgressOf(own: WorkOrderOwn['own'], status: string): WorkProgress {
  const { figure } = ownProgress(own, status)
  const step = figure.step === 'cut' || figure.step === 'sewn' || figure.step === 'finished' ? STEP_OF[figure.step] : null
  const all: StepCount[] = [
    { step: 'cut', value: own.cut },
    { step: 'sewn', value: own.sewn },
    { step: 'checked', value: own.checked },
  ]
  return { figure, step, others: status === 'DRAFT' ? [] : all.filter((entry) => entry.step !== step) }
}

/** The row's dates: due (and how late), the plan's end and whether it ends after the due (B-PT-001), the risk word when it is one. */
export interface WorkDates {
  readonly due: string | null
  readonly daysLate: number | null
  /** The plan's end; null: not on the plan yet (`planned` true) or not sent (`planned` null: the server has not said). */
  readonly planEnd: string | null
  readonly planned: boolean | null
  readonly afterDue: boolean
  /** LATE / AT_RISK / BLOCKED (and what blocks it) — never On track, which needs no word. */
  readonly risk: { readonly state: 'LATE' | 'AT_RISK' | 'BLOCKED'; readonly blockedBy: string | null } | null
}

export function workDatesOf(row: Pick<WorkOrderOwn, 'due' | 'daysLate' | 'risk' | 'sharedWithOtherCustomers'>): WorkDates {
  // A work order shared with other customers gets no plan and no risk on this order (its plan covers other customers' pieces).
  const risk = row.sharedWithOtherCustomers ? null : (row.risk ?? null)
  const late = row.daysLate !== null && row.daysLate > 0 ? row.daysLate : null
  return {
    due: row.due,
    daysLate: late,
    planEnd: risk?.plannedEnd ?? null,
    planned: row.risk === undefined || row.sharedWithOtherCustomers ? null : risk ? risk.plannedEnd !== null : null,
    afterDue: !row.sharedWithOtherCustomers && afterDueOf({ daysLate: row.daysLate, risk }),
    risk: risk && risk.state !== 'ON_TRACK' ? { state: risk.state, blockedBy: risk.blockedBy } : null,
  }
}

/** "Priority 200" only when it is not the normal 0. */
export const priorityShownOf = (priority: number | undefined): number | null => (priority !== undefined && priority !== 0 ? priority : null)

// ---- what the reader may do with a row (L9: hidden without the right, never a grey door) ---------------------------------------

/** The row's ⋯: only the acts the reader may use now, then the links; whether some were left out because the reader lacks the right. */
export interface ShownActs {
  readonly acts: readonly MenuAct[]
  readonly links: readonly MenuLink[]
  /** Due in place and "Priority and rush…" (workorders.manage, the row open). */
  readonly inline: boolean
  /** Something was left out for want of the right: the section's one hint line says who does it. */
  readonly hidden: boolean
}

const RIGHT_HELD = new Set([HELD_FOR_SALES.key, HELD_REOPEN.key])

export function shownActsOf(offer: RowActs): ShownActs {
  const hidden = offer.menu.some((entry) => entry.held !== null && RIGHT_HELD.has(entry.held.key)) || (!!offer.inline?.held && RIGHT_HELD.has(offer.inline.held.key))
  return { acts: offer.menu.filter((entry) => entry.held === null).map((entry) => entry.act), links: offer.links ?? [], inline: !!offer.inline && offer.inline.held === null, hidden }
}

// ---- the waiting decisions (F-PT-105: the strip above the rows; B5 — one Decide… each, MAKE_MORE too) ---------------------------

/** At most this many waiting decisions in the strip; the rest: "+N more on Changes ›". */
export const DECISIONS_SHOWN = 3

export interface DecisionRow {
  readonly id: string
  readonly title: Words
  readonly cells: string
  readonly at: string
  readonly mayDecide: boolean
}

/** The order's work-order changes that wait for a decision (any kind, a work order or none — MAKE_MORE), the oldest first. */
export function decisionsOf(list: readonly WorkOrderChange[] | null | undefined): { readonly shown: readonly DecisionRow[]; readonly more: number } {
  const waiting = [...(list ?? [])].filter((change) => change.status === 'PROPOSED').sort((a, b) => a.proposedAt.localeCompare(b.proposedAt))
  return {
    shown: waiting.slice(0, DECISIONS_SHOWN).map((change) => ({ id: change.id, title: change.words.title, cells: change.words.cells, at: change.proposedAt, mayDecide: change.mayDecide })),
    more: Math.max(0, waiting.length - DECISIONS_SHOWN),
  }
}

// ---- made to measure (one row per style × colourway; its units in the detail window — B6, B-PT-003) ----------------------------

/** The group's units by number and state (never the rider), B-PT-003; null: the server does not send them yet (the group row only). */
export function unitsOf(group: Pick<MtmGroupRead, 'unitList' | 'unitsMore'>): { readonly units: readonly MtmUnitRead[]; readonly more: number } | null {
  if (!group.unitList) return null
  return { units: [...group.unitList].sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true })), more: group.unitsMore ?? 0 }
}

/** A draft unit says "not released yet" — never "nothing cut yet" (B6). */
export const unitStateKeyOf = (status: string): string => (status === 'DRAFT' ? 'productionTab.wo.unitDraft' : statusKeyOf(status))
