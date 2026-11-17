import type { MILESTONE_STATES } from '@nexus/factory-domain/planning/milestones/rules'
import type { Milestones } from '../../../../planning/milestones/api'

/**
 * F-PR-05a — "Gates & readiness" on the work order's Overview (06-tree A.4 O-WO-gates): the gates of its order(s) — what must pass
 * before the work may start (PP sample, size set, sample, leather, trims, lab, other) — with their state, planner, target, the day
 * passed and how late, each a door to the gate in Planning › Time & action. Read with planning.view only: without it the card is not
 * drawn (the readiness line then stays in the release / frozen card).
 */

export type GateState = (typeof MILESTONE_STATES)[number]

export interface GateRow {
  readonly id: string
  readonly orderNumber: string
  /** The gate's kind (Time & action's words `kind.<KIND>`), and the label of an "Other" gate. */
  readonly kind: string
  readonly label: string | null
  readonly state: GateState
  readonly owner: string | null
  readonly target: string | null
  readonly actual: string | null
  /** Days late (waiting past its target, or passed after it); null: on time or no target. */
  readonly late: number | null
  /** Its door: the gate opened in Time & action. */
  readonly href: string
}

/** The gates of the orders read, in the orders' order then the gate's target (none last). */
export function gateRowsOf(answers: readonly Milestones[], prefix: string): GateRow[] {
  return answers.flatMap((answer) =>
    answer.orders.flatMap((order) =>
      [...order.gates]
        .sort((a, b) => (a.targetDate === b.targetDate ? 0 : a.targetDate === null ? 1 : b.targetDate === null ? -1 : a.targetDate < b.targetDate ? -1 : 1))
        .map((gate): GateRow => {
          const milestone = order.milestones.find((entry) => entry.gateId === gate.id) ?? null
          const state: GateState = milestone?.state ?? (gate.state === 'PASSED' ? 'DONE' : gate.state === 'STARTED_BEFORE' ? 'STARTED_BEFORE' : 'WAITING')
          const query = new URLSearchParams({ q: order.number, open: `gate:${gate.id}` })
          return {
            id: gate.id,
            orderNumber: order.number,
            kind: gate.kind,
            label: gate.label,
            state,
            owner: gate.owner?.name ?? null,
            target: gate.targetDate,
            actual: gate.passedOn,
            late: milestone?.late ?? null,
            href: `${prefix}/planning/milestones?${query.toString()}`,
          }
        }),
    ),
  )
}

/** How many gates still wait (the card's head). */
export const waitingGates = (rows: readonly GateRow[]): number => rows.filter((row) => row.state === 'WAITING').length
