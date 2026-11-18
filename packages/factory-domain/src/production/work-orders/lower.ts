import { decimalText, roundTo } from '../../product/units/units'
import { Dec } from '../../tax/decimal'
import { PLANNED_ROUND } from './spec'

/**
 * B-SA-040 (sales page plan, lead pick R1; review 17-review P6-1): production's "Lower to the order", pure. A RELEASED or
 * IN_PROGRESS work order's cell goes down to what its order needs now, never below what is already cut: max(already cut, the
 * figure asked), never above what it makes now (a raise is MAKE_MORE: a DRAFT's cells, or a new DRAFT). A DRAFT keeps its
 * own command (set its cells). "Already cut" is the database's own floor (factory-db `factory_work_order_cell_floor`: garments
 * cut from hides, bundled, or on a cut order not cancelled), read by apps/factory-api with SELECT so the command and the guard
 * always agree. A cell asked to 0 with nothing cut goes (a cancelled size).
 *
 * The cut orders of a cell: a LEATHER cut order still PLANNED follows the cell down (its line lowered, or removed); a cut order
 * already fixed for the cell (RELEASED, a FABRIC one still PLANNED: its marker's ratio × plies) holding more than the cell may
 * keep is refused in words ("Re-plan the lay of CO-0007 first"); one being cut (IN_PROGRESS) waits until it is cut; one CUT or
 * RECONCILED is what is cut. Words in Italian and English; they name the work order, the cut order and sizes, never a customer.
 */

export interface Words {
  readonly it: string
  readonly en: string
}

/** The work order kinds and states "Lower to the order" changes. */
export const LOWER_STATUSES = ['RELEASED', 'IN_PROGRESS'] as const

/** What the cell goes to: the figure asked, never below what is cut, never above what it makes now. */
export function loweredTo(current: number, asked: number, cut: number): number {
  return Math.min(current, Math.max(asked, cut))
}

/** How a cut order holding garments of a cell stands toward lowering it. */
export type CutOrderStand = 'FOLLOWS' | 'FIXED' | 'CUTTING' | 'CUT'

/** A cut order's stand: a PLANNED leather one follows; PLANNED fabric and RELEASED are fixed; IN_PROGRESS is being cut. */
export function cutOrderStand(order: { readonly kind: string; readonly status: string }): CutOrderStand {
  if (order.status === 'CUT' || order.status === 'RECONCILED') return 'CUT'
  if (order.status === 'IN_PROGRESS') return 'CUTTING'
  if (order.status === 'PLANNED' && order.kind === 'LEATHER') return 'FOLLOWS'
  return 'FIXED'
}

/** One line of a live cut order on the cell, as the plan reads it. */
export interface CutLineFacts {
  readonly lineId: string
  readonly cutOrderId: string
  readonly number: string
  readonly seq: number
  readonly stand: CutOrderStand
  /** The garments it holds of the cell (a reconciled line: what was cut). */
  readonly garments: number
}

/** What the cell's cut order lines do: the lines that follow it down (new garments, 0: removed), or the first that stops it. */
export type CutLinePlan =
  | { readonly ok: true; readonly lowered: readonly { readonly lineId: string; readonly cutOrderId: string; readonly number: string; readonly from: number; readonly to: number }[] }
  | { readonly ok: false; readonly code: 'REPLAN_LAY' | 'CUTTING_UNDER_WAY'; readonly number: string }

/**
 * The cut order lines of a cell asked down to `asked` garments: the following ones give back what the cell may no longer hold
 * (the latest first), never below 0; when the lines still hold more than `asked`, the first line that is fixed or being cut and
 * not cut stops it (its words). Lines cut hold what is cut: the cell stays at least that (the database's floor).
 */
export function cutLinePlan(lines: readonly CutLineFacts[], asked: number): CutLinePlan {
  let excess = lines.reduce((sum, line) => sum + line.garments, 0) - asked
  const lowered: { lineId: string; cutOrderId: string; number: string; from: number; to: number }[] = []
  for (const line of [...lines].filter((entry) => entry.stand === 'FOLLOWS').sort((a, b) => b.seq - a.seq || b.lineId.localeCompare(a.lineId))) {
    if (excess <= 0) break
    const give = Math.min(line.garments, excess)
    lowered.push({ lineId: line.lineId, cutOrderId: line.cutOrderId, number: line.number, from: line.garments, to: line.garments - give })
    excess -= give
  }
  if (excess > 0) {
    const stop = [...lines].filter((entry) => entry.stand === 'FIXED' || entry.stand === 'CUTTING').sort((a, b) => a.number.localeCompare(b.number))[0]
    if (stop) return { ok: false, code: stop.stand === 'CUTTING' ? 'CUTTING_UNDER_WAY' : 'REPLAN_LAY', number: stop.number }
  }
  return { ok: true, lowered }
}

/** The refusals of "Lower to the order", by code (409 `refusal/<CODE>`; the web's `refusal.<CODE>`). */
export const LOWER_REFUSALS = ['NOT_RELEASED', 'DRAFT', 'ON_HOLD', 'UNIT', 'REPAIR', 'NO_ORDER_LINE', 'ONLY_LOWERS', 'REPLAN_LAY', 'CUTTING_UNDER_WAY', 'CELL_IN_USE', 'LAST_CELL'] as const
export type LowerRefusal = (typeof LOWER_REFUSALS)[number]

export const LOWER_WORDS = {
  lowered: (size: string, from: number, to: number): Words => ({ en: `Lowered to the order: ${size} ${from} → ${to}`, it: `Ridotto all'ordine: ${size} ${from} → ${to}` }),
  alreadyCut: (count: number): Words => ({ en: `Already cut: ${count}`, it: `Già tagliati: ${count}` }),
  replanLay: (number: string): Words => ({ en: `Re-plan the lay of ${number} first`, it: `Ripianifica prima il piazzamento di ${number}` }),
  cuttingUnderWay: (number: string): Words => ({ en: `${number} is being cut: lower the work order once it is cut`, it: `Il taglio di ${number} è in corso: riduci l'ordine di lavoro quando è tagliato` }),
  draft: (number: string): Words => ({ en: `Work order ${number} is a DRAFT: set its cells instead (Lower to the order is for a released work order).`, it: `L'ordine di lavoro ${number} è una bozza: imposta le sue celle (Riduci all'ordine è per un ordine di lavoro rilasciato).` }),
  notReleased: (number: string, status: string): Words => ({ en: `Work order ${number} is ${status}: its cells no longer change.`, it: `L'ordine di lavoro ${number} è ${status}: le sue celle non cambiano più.` }),
  onHold: (number: string): Words => ({ en: `Work order ${number} is on hold: lift the hold first, then lower it to the order.`, it: `L'ordine di lavoro ${number} è in pausa: togli prima la pausa, poi riducilo all'ordine.` }),
  unit: (number: string): Words => ({ en: `Work order ${number} makes one made-to-measure unit: it is cancelled, never lowered.`, it: `L'ordine di lavoro ${number} fa un capo su misura: si annulla, non si riduce.` }),
  repair: (number: string): Words => ({ en: `Work order ${number} repairs one garment: its cell does not change.`, it: `L'ordine di lavoro ${number} ripara un capo: la sua cella non cambia.` }),
  noOrderLine: (size: string): Words => ({ en: `Size ${size} makes no order line: it is not lowered to an order.`, it: `La taglia ${size} non fa nessuna riga d'ordine: non si riduce a un ordine.` }),
  onlyLowers: (size: string, current: number, asked: number): Words => ({
    en: `Lower to the order only lowers: size ${size} makes ${current}, ${asked} asked. To make more, propose making more.`,
    it: `Riduci all'ordine riduce soltanto: la taglia ${size} ne fa ${current}, ne sono chiesti ${asked}. Per farne di più, proponi di farne di più.`,
  }),
  cellInUse: (size: string): Words => ({ en: `Size ${size} cannot go: labels, serials or records of the floor name it. Lower it to 1, or clear those first.`, it: `La taglia ${size} non può sparire: etichette, matricole o registrazioni del reparto la nominano. Riducila a 1, o toglile prima.` }),
  lastCell: (number: string): Words => ({ en: `Every size of ${number} would go: cancel the work order instead.`, it: `Ogni taglia di ${number} sparirebbe: annulla invece l'ordine di lavoro.` }),
  reprint: (): Words => ({ en: 'Print the traveller again: its quantities changed.', it: 'Ristampa il foglio di lavorazione: le quantità sono cambiate.' }),
} as const

/** The words of a cut order line plan that stops: the refusal's code and words. */
export function cutLineRefusal(plan: Extract<CutLinePlan, { ok: false }>): { readonly code: LowerRefusal; readonly words: Words } {
  return { code: plan.code, words: plan.code === 'CUTTING_UNDER_WAY' ? LOWER_WORDS.cuttingUnderWay(plan.number) : LOWER_WORDS.replanLay(plan.number) }
}

/**
 * A planned material following its cell from `from` garments to `to` (1 or more): its quantity scaled and rounded UP once to
 * 4 decimals (an issue is never planned short, as the release planned it); null when it would not go strictly lower (the
 * database lets a planned material only go down).
 */
export function followedQuantity(quantity: string, from: number, to: number): string | null {
  if (!(Number.isSafeInteger(from) && Number.isSafeInteger(to) && to > 0 && to < from)) return null
  const now = new Dec(quantity)
  const scaled = roundTo(now.times(to).dividedBy(from), PLANNED_ROUND)
  return scaled.lt(now) && scaled.gt(0) ? decimalText(scaled) : null
}
