import { UNITS, type Uom } from '../../product/units/units'
import { Dec, ZERO, type Decimal } from '../../tax/decimal'

/**
 * The reception report (B-W2b-300; SCM-119 "allocating after receipt needs reservations"; design warehouse.receipts
 * pop:rc-reception), the pure rules: after a receipt, which work orders and orders its goods serve, and what to reserve for
 * them from the lots it brought, in one step.
 *
 *   serves      PEGGED: the site's last planning run pegged the receipt's purchase order line to that demand (planning
 *               RequirementPegging, supply PURCHASE_ORDER); NEEDS: an open work order of the site that plans the material and
 *               colour and still needs some (no plan pegged it: an order made by hand).
 *   open        what the demand still needs: a work order's planned material less what is at it (issued, net of returns) and
 *               what is reserved for it; an order line's pegged quantity less what is reserved for it.
 *   proposed    pegged first, then by need date, then by work order / order line: each takes the smaller of what was pegged
 *               (when pegged) and what it still needs, from what the receipt's lots still have free (on hand, not held, not
 *               reserved), lot by lot in the receipt's order. Quarantined lots are free only once released.
 *   left        what is free after the proposals goes to stock.
 *
 * Every quantity is in the material's base unit, a decimal string with four decimals. The reservations themselves are made by
 * modules/inventory/reservations (its checks are the last word: a lot reserved meanwhile is refused in words).
 */

export const DEMAND_KINDS = ['WORK_ORDER', 'ORDER_LINE'] as const
export type DemandKind = (typeof DEMAND_KINDS)[number]

export const SERVE_WHY = ['PEGGED', 'NEEDS'] as const
export type ServeWhy = (typeof SERVE_WHY)[number]

/** Why nothing is proposed for a demand: it needs nothing more, the lots have nothing free left, they are held, it is not open. */
export const SERVE_HELD = ['NOT_NEEDED', 'NOTHING_LEFT', 'IN_QUARANTINE', 'NOT_OPEN'] as const
export type ServeHeld = (typeof SERVE_HELD)[number]

/** Why the report cannot reserve at all (the receipt's own state). */
export const REPORT_HELD = ['NOT_POSTED', 'NO_ORDER'] as const
export type ReportHeld = (typeof REPORT_HELD)[number]

export const REPORT_LIMITS = Object.freeze({ demands: 50, note: 500 })

export interface DemandFacts {
  /** `WORK_ORDER:<id>` or `ORDER_LINE:<id>`. */
  readonly key: string
  readonly why: ServeWhy
  /** YYYY-MM-DD, or null. */
  readonly needDate: string | null
  /** PEGGED: what the plan counted on from this purchase order line for it; null for NEEDS. */
  readonly pegged: string | null
  /** What it still needs (≥ 0). */
  readonly open: string
  /** The work order or order is still open (reservations are made only for open demands). */
  readonly openDemand: boolean
}

export interface LotFree {
  /** The lot (null: an untracked material, reserved by material and colour). */
  readonly lotId: string | null
  /** On hand of it now, less what is reserved of it (≥ 0). */
  readonly free: string
  /** Held: in quarantine, blocked, rejected or under an active hold. */
  readonly held: boolean
}

export interface ServePlan {
  readonly key: string
  readonly proposed: string
  readonly lots: readonly { readonly lotId: string | null; readonly quantity: string }[]
  readonly held: ServeHeld | null
}

const q = (value: Decimal): string => value.toFixed(4)
const d = (value: string | null): Decimal => (value === null ? ZERO : new Dec(value))

export const demandKey = (kind: DemandKind, id: string): string => `${kind}:${id}`
export function demandOfKey(key: string): { readonly kind: DemandKind; readonly id: string } | null {
  const [kind, id] = key.split(':')
  return (DEMAND_KINDS as readonly string[]).includes(kind ?? '') && id ? { kind: kind as DemandKind, id } : null
}

/** The order the demands are served in: pegged first, then the earliest need, then the key (a stable order). */
export function serveOrder(a: DemandFacts, b: DemandFacts): number {
  if (a.why !== b.why) return a.why === 'PEGGED' ? -1 : 1
  if (a.needDate !== b.needDate) return a.needDate === null ? 1 : b.needDate === null ? -1 : a.needDate.localeCompare(b.needDate)
  return a.key.localeCompare(b.key)
}

/** What to reserve for each demand from the receipt's lots, and what is left for stock. */
export function proposeServes(demands: readonly DemandFacts[], lots: readonly LotFree[]): { readonly plans: ServePlan[]; readonly left: string } {
  const free = lots.map((lot) => ({ lotId: lot.lotId, left: lot.held ? ZERO : Dec.max(ZERO, d(lot.free)) }))
  const onlyHeld = lots.length > 0 && lots.every((lot) => lot.held || d(lot.free).lte(0)) && lots.some((lot) => lot.held && d(lot.free).gt(0))
  const plans: ServePlan[] = []
  for (const demand of [...demands].sort(serveOrder)) {
    if (!demand.openDemand) {
      plans.push({ key: demand.key, proposed: q(ZERO), lots: [], held: 'NOT_OPEN' })
      continue
    }
    const open = Dec.max(ZERO, d(demand.open))
    let want = demand.pegged === null ? open : Dec.min(open, Dec.max(ZERO, d(demand.pegged)))
    if (want.lte(0)) {
      plans.push({ key: demand.key, proposed: q(ZERO), lots: [], held: 'NOT_NEEDED' })
      continue
    }
    const taken: { lotId: string | null; quantity: string }[] = []
    let total = ZERO
    for (const lot of free) {
      if (want.lte(0)) break
      if (lot.left.lte(0)) continue
      const take = Dec.min(want, lot.left)
      lot.left = lot.left.minus(take)
      want = want.minus(take)
      total = total.plus(take)
      taken.push({ lotId: lot.lotId, quantity: q(take) })
    }
    plans.push({ key: demand.key, proposed: q(total), lots: taken, held: total.gt(0) ? null : onlyHeld ? 'IN_QUARANTINE' : 'NOTHING_LEFT' })
  }
  return { plans, left: q(free.reduce((sum, lot) => sum.plus(lot.left), ZERO)) }
}

/** Why the receipt cannot be reported against its demands now, or null. */
export function reportHeld(receipt: { readonly status: string; readonly purchaseOrderId: string | null }): ReportHeld | null {
  if (receipt.status !== 'POSTED') return 'NOT_POSTED'
  if (receipt.purchaseOrderId === null) return 'NO_ORDER'
  return null
}

// ---- the note to the buyer ----------------------------------------------------------------------------------------------------

export interface NoteServe {
  /** "work order WO-0001" / "order SO-0003 line 10" in the note's language (the caller words it with `demandWords`). */
  readonly label: string
  readonly open: string
  readonly reservedNow: string
}

export interface NoteLine {
  /** "Line 10 SEED-LEA-100 BLK". */
  readonly label: string
  readonly received: string
  readonly uom: Uom
  readonly serves: readonly NoteServe[]
  readonly left: string
}

const isEnglish = (locale: string | null | undefined): boolean => (locale ?? '').toLowerCase().startsWith('en')

/** A demand in the note's language. */
export function demandWords(locale: string | null | undefined, demand: { readonly kind: DemandKind; readonly number: string; readonly seq?: number | null }): string {
  if (demand.kind === 'WORK_ORDER') return isEnglish(locale) ? `work order ${demand.number}` : `ordine di lavoro ${demand.number}`
  return isEnglish(locale) ? `order ${demand.number}${demand.seq ? ` line ${demand.seq}` : ''}` : `ordine ${demand.number}${demand.seq ? ` riga ${demand.seq}` : ''}`
}

/**
 * The reception report as an internal note on the purchase order's thread, mentioning its buyer (SCM-119 "sent to the buyer"):
 * per line what came, whom it serves (and what was reserved now), what goes to stock; the warehouse's own words after it.
 */
export function receptionNoteText(locale: string | null | undefined, facts: { readonly receipt: string; readonly order: string; readonly lines: readonly NoteLine[]; readonly note?: string | null }): string {
  const en = isEnglish(locale)
  const number = (value: string) => new Intl.NumberFormat(en ? 'en-GB' : 'it-IT', { maximumFractionDigits: 4 }).format(Number(value))
  const amount = (value: string, uom: Uom) => `${number(value)} ${UNITS[uom].symbol}`
  const head = en ? `Reception report ${facts.receipt} (${facts.order}):` : `Rapporto di ricevimento ${facts.receipt} (${facts.order}):`
  const rows = facts.lines.map((line) => {
    const serves = line.serves.map((serve) => {
      const reserved = d(serve.reservedNow).gt(0) ? (en ? ` (reserved now ${amount(serve.reservedNow, line.uom)})` : ` (riservati ora ${amount(serve.reservedNow, line.uom)})`) : ''
      return en ? `${serve.label} needs ${amount(serve.open, line.uom)}${reserved}` : `${serve.label} chiede ${amount(serve.open, line.uom)}${reserved}`
    })
    const served = serves.length > 0 ? serves.join('; ') : en ? 'no work order or order waits for it' : 'nessun ordine di lavoro o ordine lo aspetta'
    const left = d(line.left).gt(0) ? (en ? `; ${amount(line.left, line.uom)} to stock` : `; ${amount(line.left, line.uom)} a magazzino`) : ''
    return `- ${line.label}, ${en ? 'received' : 'ricevuti'} ${amount(line.received, line.uom)}: ${served}${left}.`
  })
  const note = (facts.note ?? '').trim()
  return [head, ...rows, ...(note ? ['', note] : [])].join('\n')
}
