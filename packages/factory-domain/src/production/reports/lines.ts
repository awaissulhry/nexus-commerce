/**
 * The floor overview by line (B-W2a-38; MES-160; design production.floor "Lines": a card per line with its state word,
 * output against the plan today, the work orders on it and the operation where most pieces wait; Owner answer F2: per
 * station only calls, machine down and "nobody signed in", output per line only), pure.
 *
 *   state       RUNNING   a station of the line reported a bundle in the last RUNNING_WINDOW_MINUTES;
 *               WAITING   there is work on the line (an open work order allocated to it, or garments planned today) but
 *                         no report that recently;
 *               NO_WORK   nothing allocated or planned, and no recent report.
 *   planned     the garments the published plan puts through the line today: per work order its slots on the line
 *               (the whole work order placed there, else the bars of the line's last operation), each slot's garments
 *               in proportion to its working minutes that fall today (a two-day slot of 100 garments plans 50 a day).
 *   output      the daily report's good garments of the line today (daily.ts: through the line's last operation).
 *
 * Never a person: the line's stations say only whether someone is signed in and whether a machine at it is down.
 */

export const LINE_STATES = ['RUNNING', 'WAITING', 'NO_WORK'] as const
export type LineState = (typeof LINE_STATES)[number]

/** A line reported this recently is RUNNING. */
export const RUNNING_WINDOW_MINUTES = 30

export function lineStateOf(input: { readonly openWorkOrders: number; readonly plannedToday: number | null; readonly lastScanAt: Date | null; readonly now: Date }): LineState {
  if (input.lastScanAt && input.now.getTime() - input.lastScanAt.getTime() <= RUNNING_WINDOW_MINUTES * 60_000) return 'RUNNING'
  if (input.openWorkOrders > 0 || (input.plannedToday ?? 0) > 0) return 'WAITING'
  return 'NO_WORK'
}

/**
 * The garments of one slot planned for today: its garments × (its working minutes today / its working minutes), whole
 * garments (half up). A slot with no working minutes at all (placed over a closed time) shares by the clock instead.
 */
export function plannedShare(garments: number, minutes: { readonly today: number; readonly slot: number }, clock: { readonly today: number; readonly slot: number }): number {
  if (garments <= 0) return 0
  const [part, whole] = minutes.slot > 0 ? [minutes.today, minutes.slot] : [clock.today, clock.slot]
  if (whole <= 0 || part <= 0) return 0
  return Math.round((garments * Math.min(part, whole)) / whole)
}

export interface PlannedSlot {
  readonly workOrderId: string
  /** null: the whole work order (an allocation card); else the operation's seq (a bar). */
  readonly operationSeq: number | null
  readonly plannedToday: number
}

/**
 * The line's garments planned today from its slots: per work order the whole-order slots if it has any, else the bars
 * of its highest operation on the line (a garment through three operations of a line is one garment, planned once).
 */
export function plannedOnLine(slots: readonly PlannedSlot[]): number {
  const byWorkOrder = new Map<string, PlannedSlot[]>()
  for (const slot of slots) byWorkOrder.set(slot.workOrderId, [...(byWorkOrder.get(slot.workOrderId) ?? []), slot])
  let total = 0
  for (const list of byWorkOrder.values()) {
    const whole = list.filter((slot) => slot.operationSeq === null)
    if (whole.length > 0) {
      total += whole.reduce((sum, slot) => sum + slot.plannedToday, 0)
      continue
    }
    const top = Math.max(...list.map((slot) => slot.operationSeq ?? 0))
    total += list.filter((slot) => slot.operationSeq === top).reduce((sum, slot) => sum + slot.plannedToday, 0)
  }
  return total
}

export interface WaitingAt {
  readonly workOrderId: string
  readonly workOrderNumber: string
  readonly operationId: string
  readonly seq: number
  readonly code: string
  readonly name: string
  readonly waiting: number
}

/** The operation of the line's work orders where most pieces wait (null: nothing waits). Ties: the earlier work order. */
export function bottleneckOf(candidates: readonly WaitingAt[]): WaitingAt | null {
  let best: WaitingAt | null = null
  for (const candidate of candidates) if (candidate.waiting > 0 && (!best || candidate.waiting > best.waiting)) best = candidate
  return best
}

/** Output against the plan as a whole percent (null: nothing planned). */
export function outputPct(output: number, planned: number | null): number | null {
  if (planned === null || planned <= 0) return null
  return Math.round((output / planned) * 100)
}
