import { Dec } from '../tax/decimal'

/**
 * B-SA-041 (sales page plan, lead picks P6', R1; 13-backend B4b; review 17-review P6-1…P6-9, C-4, C-11, C-16), pure: the gap an
 * accepted change of a sales order leaves between the order and its work orders, as WorkOrderChange records (factory-db
 * order-apply.prisma) held for a person who manages the work order. apps/factory-api's modules/production/work-order-changes
 * proposes, applies, declines and makes them stale; Accept (B-SA-042) proposes in its own command.
 *
 *   LOWER_TO_ORDER   the work order makes more of a line and size than the order now wants: its cells go down — a DRAFT's
 *                    cells set (setCellsInCommand), a RELEASED or IN_PROGRESS one through production's "Lower to the order"
 *                    (B-SA-040: never below what is cut). Pieces already cut beyond the new figure are its EXTRA pieces,
 *                    with the outcome the accepter named (CHARGE · LEFTOVER · SCRAP, R1; Round 4: chosen before Accept).
 *                    A made-to-measure unit is cancel only: its one cell 1 → 0, applied by cancelling its unit work order (a
 *                    cut unit is scrap with its approval: its extra piece's outcome is SCRAP).
 *   MAKE_MORE        the order wants more than its work orders make: an open DRAFT's cell grows (or the DRAFT takes a new cell
 *                    of a line it makes), else a new DRAFT is made (madeWorkOrderId).
 *
 * A proposal is not an approval (rule 42; review C-11): it moves no money and promises nothing to the customer (the commercial
 * decision was the Accept), so the accepter who holds workorders.manage may apply it himself; the proposer is always named.
 * "Left as is" is a DECLINED change with its words (≤ 300); STALE when what it carries out was put back before it was applied.
 */

export interface Words {
  readonly it: string
  readonly en: string
}

/** factory-db WorkOrderChangeKind, WorkOrderChangeStatus, WorkOrderChangeExtraOutcome (paired in factory-db domain-mirrors.ts). */
export const WORK_ORDER_CHANGE_KINDS = ['LOWER_TO_ORDER', 'MAKE_MORE'] as const
export type WorkOrderChangeKind = (typeof WORK_ORDER_CHANGE_KINDS)[number]
export const WORK_ORDER_CHANGE_STATUSES = ['PROPOSED', 'APPLIED', 'DECLINED', 'STALE'] as const
export type WorkOrderChangeStatus = (typeof WORK_ORDER_CHANGE_STATUSES)[number]
export const EXTRA_OUTCOMES = ['CHARGE', 'LEFTOVER', 'SCRAP'] as const
export type ExtraOutcome = (typeof EXTRA_OUTCOMES)[number]

/** The database's limits (…_order_apply_guards): 1 to 200 cells, pieces 0 to 100 000, why 1 to 500, a decision ≤ 300. */
export const MAX_CHANGE_CELLS = 200
export const MAX_CHANGE_PIECES = 100_000
export const MAX_CHANGE_REASON = 500
export const MAX_DECISION_NOTE = 300

/** One cell of a change, as factory-db keeps it (exactly these keys). */
export interface ChangeCell {
  readonly salesOrderLineId: string
  readonly size: string
  readonly from: number
  readonly to: number
  /** The work order's cell; null only on a MAKE_MORE cell that does not exist yet. */
  readonly workOrderSizeId: string | null
}

/** Pieces already cut beyond the new figure, of one cell the change lowers. */
export interface ExtraPieces {
  readonly workOrderSizeId: string
  readonly salesOrderLineId: string
  readonly size: string
  readonly count: number
}

// ---- what work orders make, and what the order wants -------------------------------------------------------------------

/** A cell of a work order that makes the order, as the plan reads it. */
export interface WorkCell {
  readonly workOrderId: string
  readonly number: string
  readonly status: string
  readonly kind: string
  /** The work order's style and site (a new DRAFT is made per style and site). */
  readonly styleId: string
  readonly siteId: string
  readonly cellId: string
  readonly salesOrderLineId: string
  readonly size: string
  readonly quantity: number
  /** What is already cut of it (the database's floor); 0 on a DRAFT. */
  readonly cut: number
}

/** A line of the order as it is after the Accept: what its work orders should make of each size now. */
export interface WantedLine {
  readonly lineId: string
  readonly styleId: string
  /** The line's site, when it names one (a new DRAFT is made there; else the work order's own default). */
  readonly siteId: string | null
  readonly madeToMeasure: boolean
  /** Per size (a made-to-measure unit: its base size), the pieces work orders should make now. */
  readonly sizes: ReadonlyMap<string, number>
}

/** A WorkOrderChange to propose. */
export interface PlannedChange {
  readonly kind: WorkOrderChangeKind
  /** LOWER_TO_ORDER: always; MAKE_MORE: the open DRAFT whose cells grow, or null (a new DRAFT). */
  readonly workOrderId: string | null
  readonly number: string | null
  /** MAKE_MORE with no work order: the new DRAFT's style and site (null: the line's default). */
  readonly styleId: string
  readonly siteId: string | null
  readonly cells: readonly ChangeCell[]
  readonly extra: readonly ExtraPieces[]
}

/** The work order states a change may still touch (an open work order; ON_HOLD: applied once the hold is lifted). */
export const CHANGEABLE_STATUSES = ['DRAFT', 'RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const
const changeable = (status: string): boolean => (CHANGEABLE_STATUSES as readonly string[]).includes(status)
const counted = (status: string): boolean => status !== 'CANCELLED'

/** Which cell gives first: a DRAFT before a released one, the one with the most left uncut, then by number. */
const lowerOrder = (a: WorkCell, b: WorkCell): number => {
  const draft = Number(b.status === 'DRAFT') - Number(a.status === 'DRAFT')
  if (draft !== 0) return draft
  const room = b.quantity - b.cut - (a.quantity - a.cut)
  return room !== 0 ? room : b.number.localeCompare(a.number)
}

/**
 * The WorkOrderChanges the order's lines ask of its work orders (per line and size: what they make, not cancelled, against what
 * the order wants). A decrease goes first where nothing is cut (DRAFT cells, then the cells with the most left uncut); what is
 * still over the order after that is cut already: those cells go below their cut in the change, and the difference is their
 * EXTRA pieces. A raise grows an open DRAFT of the line (its cell of that size, else a new cell), else a new DRAFT per style and
 * site. A made-to-measure unit is never raised; wanted 0, its open unit work order is lowered 1 → 0 (cancelled on apply).
 * COMPLETED and CLOSED work orders count as made and are never changed. B-SA-042: `raiseAtMost` (per `<lineId>|<size>`) caps a
 * raise at what the change itself added — a line only partly in work orders is the planner's to plan, not a change's.
 */
export function planChanges(lines: readonly WantedLine[], cells: readonly WorkCell[], /* B-SA-042 */ raiseAtMost?: ReadonlyMap<string, number>): PlannedChange[] {
  const lowers = new Map<string, { workOrder: WorkCell; cells: ChangeCell[]; extra: ExtraPieces[] }>()
  const raises = new Map<string, { workOrderId: string | null; number: string | null; styleId: string; siteId: string | null; cells: ChangeCell[] }>()
  for (const line of lines) {
    const ofLine = cells.filter((cell) => cell.salesOrderLineId === line.lineId && counted(cell.status))
    const sizes = [...new Set([...line.sizes.keys(), ...ofLine.map((cell) => cell.size)])]
    for (const size of sizes) {
      const wanted = line.sizes.get(size) ?? 0
      const made = ofLine.filter((cell) => cell.size === size)
      let gap = made.reduce((sum, cell) => sum + cell.quantity, 0) - wanted
      if (gap > 0) {
        const open = made.filter((cell) => changeable(cell.status)).sort(lowerOrder)
        const to = new Map(open.map((cell) => [cell.cellId, cell.quantity]))
        // First what is not cut yet.
        for (const cell of open) {
          if (gap <= 0) break
          const give = Math.min(cell.quantity - cell.cut, gap)
          if (give <= 0) continue
          to.set(cell.cellId, cell.quantity - give)
          gap -= give
        }
        // Then below what is cut: extra pieces (the cell itself stays at its cut: Lower to the order never goes below it).
        for (const cell of open) {
          if (gap <= 0) break
          const now = to.get(cell.cellId)!
          const give = Math.min(now, gap)
          if (give <= 0) continue
          to.set(cell.cellId, now - give)
          gap -= give
        }
        for (const cell of open) {
          const target = to.get(cell.cellId)!
          if (target >= cell.quantity) continue
          const entry = lowers.get(cell.workOrderId) ?? { workOrder: cell, cells: [], extra: [] }
          entry.cells.push({ salesOrderLineId: line.lineId, size, from: cell.quantity, to: target, workOrderSizeId: cell.cellId })
          if (cell.cut > target) entry.extra.push({ workOrderSizeId: cell.cellId, salesOrderLineId: line.lineId, size, count: cell.cut - target })
          lowers.set(cell.workOrderId, entry)
        }
      } else if (gap < 0 && !line.madeToMeasure) {
        // B-SA-042: a change raises by what it added (and what the changes it replaces still asked), never the rest of a line the
        // planner has not put in work orders yet.
        const more = raiseAtMost ? Math.min(-gap, raiseAtMost.get(`${line.lineId}|${size}`) ?? 0) : -gap
        if (more <= 0) continue
        const drafts = ofLine.filter((cell) => cell.status === 'DRAFT' && cell.kind !== 'MADE_TO_MEASURE')
        const sameSize = drafts.filter((cell) => cell.size === size).sort((a, b) => a.number.localeCompare(b.number))[0]
        const sameLine = drafts.sort((a, b) => a.number.localeCompare(b.number))[0]
        const host = sameSize ?? sameLine
        const key = host ? host.workOrderId : `new|${line.styleId}|${line.siteId ?? '-'}`
        const entry = raises.get(key) ?? { workOrderId: host?.workOrderId ?? null, number: host?.number ?? null, styleId: line.styleId, siteId: host?.siteId ?? line.siteId, cells: [] }
        entry.cells.push(sameSize ? { salesOrderLineId: line.lineId, size, from: sameSize.quantity, to: sameSize.quantity + more, workOrderSizeId: sameSize.cellId } : { salesOrderLineId: line.lineId, size, from: 0, to: more, workOrderSizeId: null })
        raises.set(key, entry)
      }
    }
  }
  const planned: PlannedChange[] = []
  for (const entry of lowers.values()) {
    planned.push({ kind: 'LOWER_TO_ORDER', workOrderId: entry.workOrder.workOrderId, number: entry.workOrder.number, styleId: entry.workOrder.styleId, siteId: entry.workOrder.siteId, cells: entry.cells, extra: entry.extra })
  }
  for (const entry of raises.values()) planned.push({ kind: 'MAKE_MORE', workOrderId: entry.workOrderId, number: entry.number, styleId: entry.styleId, siteId: entry.siteId, cells: entry.cells, extra: [] })
  return planned.flatMap((change) => chunked(change))
}

/** A change holds at most 200 cells (the database's limit): a bigger one is split, its extra pieces with their cells. */
function chunked(change: PlannedChange): PlannedChange[] {
  if (change.cells.length <= MAX_CHANGE_CELLS) return [change]
  const out: PlannedChange[] = []
  for (let start = 0; start < change.cells.length; start += MAX_CHANGE_CELLS) {
    const cells = change.cells.slice(start, start + MAX_CHANGE_CELLS)
    const ids = new Set(cells.map((cell) => cell.workOrderSizeId))
    out.push({ ...change, cells, extra: change.extra.filter((entry) => ids.has(entry.workOrderSizeId)) })
  }
  return out
}

/** The extra pieces a set of changes leaves, all together (the review window shows them before Accept). */
export const extraOf = (changes: readonly PlannedChange[]): ExtraPieces[] => changes.flatMap((change) => change.extra)

// ---- how a change is applied --------------------------------------------------------------------------------------------

/** How a PROPOSED change is carried out on its work order as it is now (null: it cannot be now, `refusal` says why). */
export type ApplyRoute = 'SET_DRAFT_CELLS' | 'LOWER_RELEASED' | 'CANCEL_WORK_ORDER' | 'NEW_DRAFT'

/**
 * The route of a change: a made-to-measure unit's, and a lowering that takes every cell of its work order to 0 (B-SA-042: a
 * whole order or line cancelled), cancel the work order (its pieces cut stay: Lower to the order keeps them); a DRAFT's cells are
 * set; a released one is lowered; MAKE_MORE grows a DRAFT, or makes a new one.
 */
export function applyRouteOf(
  change: { readonly kind: WorkOrderChangeKind; readonly workOrderId: string | null },
  workOrder: { readonly status: string; readonly kind: string } | null,
  everyCellToZero = false,
): { readonly route: ApplyRoute } | { readonly refusal: 'WORK_ORDER_DONE' | 'ON_HOLD' | 'NOT_A_DRAFT' } {
  if (change.kind === 'MAKE_MORE' && change.workOrderId === null) return { route: 'NEW_DRAFT' }
  if (!workOrder || !changeable(workOrder.status)) return { refusal: 'WORK_ORDER_DONE' }
  if (workOrder.status === 'ON_HOLD') return { refusal: 'ON_HOLD' }
  if (change.kind === 'MAKE_MORE') return workOrder.status === 'DRAFT' ? { route: 'SET_DRAFT_CELLS' } : { refusal: 'NOT_A_DRAFT' }
  if (workOrder.kind === 'MADE_TO_MEASURE' || everyCellToZero) return { route: 'CANCEL_WORK_ORDER' }
  return workOrder.status === 'DRAFT' ? { route: 'SET_DRAFT_CELLS' } : { route: 'LOWER_RELEASED' }
}

/** Does a lowering take every cell of its work order to 0 (its cells now, by id)? */
export const takesEveryCell = (cells: readonly ChangeCell[], workOrderCellIds: readonly string[]): boolean =>
  workOrderCellIds.length > 0 && workOrderCellIds.every((id) => cells.some((cell) => cell.workOrderSizeId === id && cell.to === 0))

/** The cells whose `from` is no longer what the work order makes (the change was proposed on another figure). */
export function changedSince(cells: readonly ChangeCell[], current: ReadonlyMap<string, number>, byLineSize: ReadonlyMap<string, number>): ChangeCell[] {
  return cells.filter((cell) => {
    const now = cell.workOrderSizeId !== null ? current.get(cell.workOrderSizeId) : byLineSize.get(`${cell.salesOrderLineId}|${cell.size}`)
    return (now ?? 0) !== cell.from
  })
}

/** Why words are needed and how long they may be: a decline's (left as is) 1 to 300 characters. */
export function declineProblem(words: string | null | undefined): string | null {
  const text = typeof words === 'string' ? words.trim() : ''
  if (text === '') return 'Say why it is left as is.'
  if (text.length > MAX_DECISION_NOTE) return `At most ${MAX_DECISION_NOTE} characters.`
  return null
}

// ---- extra pieces charged to the customer (B-SA-042, R1: "keep and charge the customer", a priced change) ----------------

/** A line's price per size, as the amendment's snapshot after holds it (the size's own, else the line's), decimal text. */
export interface PricedSize {
  readonly lineId: string
  readonly size: string
  readonly unitPrice: string
}

/**
 * The change fee that charges the customer for its extra pieces: each piece at its size's unit price, rounded to the cent (half
 * up), decimal text with 2 places; null when it comes to nothing (a size priced 0, or no extra piece).
 */
export function chargeFeeOf(extra: readonly Pick<ExtraPieces, 'salesOrderLineId' | 'size' | 'count'>[], prices: readonly PricedSize[]): string | null {
  let total = new Dec(0)
  for (const entry of extra) {
    const price = prices.find((row) => row.lineId === entry.salesOrderLineId && row.size === entry.size)
    if (price) total = total.plus(new Dec(price.unitPrice).times(entry.count))
  }
  const fee = total.toDecimalPlaces(2, Dec.ROUND_HALF_UP)
  return fee.gt(0) ? fee.toFixed(2) : null
}

// ---- words -------------------------------------------------------------------------------------------------------------

/** The refusals of the work-order changes, by code (409 `refusal/<CODE>`). */
export const CHANGE_REFUSALS = ['CHANGED_SINCE', 'DECIDED', 'WORK_ORDER_DONE', 'ON_HOLD', 'NOT_A_DRAFT', 'UNIT_CUT', 'NOT_THIS_ORDER', 'REQUEST_NOT_ACCEPTED', 'EXTRA_OUTCOME'] as const
export type ChangeRefusal = (typeof CHANGE_REFUSALS)[number]

const STATUS_WORDS: Readonly<Record<WorkOrderChangeStatus, Words>> = {
  PROPOSED: { en: 'waiting', it: 'in attesa' },
  APPLIED: { en: 'applied', it: 'applicata' },
  DECLINED: { en: 'left as is', it: 'lasciata com’è' },
  STALE: { en: 'no longer needed', it: 'non più necessaria' },
}

export const CHANGE_WORDS = {
  changedSince: (number: string): Words => ({ en: `${number} changed since — propose again`, it: `${number} è cambiato nel frattempo: proponi di nuovo` }),
  decided: (status: WorkOrderChangeStatus): Words => ({ en: `This work order change is ${STATUS_WORDS[status].en} already.`, it: `Questa modifica dell'ordine di lavoro è già ${STATUS_WORDS[status].it}.` }),
  workOrderDone: (number: string): Words => ({ en: `${number} is no longer open: decline the change with a word instead.`, it: `${number} non è più aperto: rifiuta la modifica con una parola.` }),
  onHold: (number: string): Words => ({ en: `${number} is on hold: lift the hold first, then apply the change.`, it: `${number} è in pausa: togli prima la pausa, poi applica la modifica.` }),
  notADraft: (number: string): Words => ({ en: `${number} is released: it makes no more — propose a new work order instead.`, it: `${number} è rilasciato: non ne fa di più — proponi invece un nuovo ordine di lavoro.` }),
  unitCut: (number: string): Words => ({ en: `The unit of ${number} is cut already: scrap it with its approval, or keep it.`, it: `Il capo di ${number} è già tagliato: scartalo con la sua approvazione, o tienilo.` }),
  requestNotAccepted: (): Words => ({ en: 'A work order change carries out an accepted request: answer the request first.', it: "Una modifica dell'ordine di lavoro esegue una richiesta accettata: rispondi prima alla richiesta." }),
  notThisOrder: (): Words => ({ en: 'A work order change names a work order of its own order.', it: "Una modifica dell'ordine di lavoro nomina un ordine di lavoro del suo stesso ordine." }),
  status: (status: WorkOrderChangeStatus): Words => STATUS_WORDS[status],
  /** "Work order change · WO-…" (Home › Approvals, B-SA-044). */
  title: (number: string | null): Words => (number ? { en: `Work order change · ${number}`, it: `Modifica dell'ordine di lavoro · ${number}` } : { en: 'Work order change · new work order', it: "Modifica dell'ordine di lavoro · nuovo ordine di lavoro" }),
  /** What a change does, per cell: "M 40 → 36". */
  cells: (cells: readonly Pick<ChangeCell, 'size' | 'from' | 'to'>[]): string => cells.map((cell) => `${cell.size} ${cell.from} → ${cell.to}`).join(', '),
  extraOutcome: (outcome: ExtraOutcome, customer: string): Words =>
    outcome === 'CHARGE' ? { en: 'Keep and charge the customer', it: 'Tieni e addebita al cliente' } : outcome === 'LEFTOVER' ? { en: `Keep as leftover for ${customer}`, it: `Tieni come rimanenza di ${customer}` } : { en: 'Scrap', it: 'Scarta' },
  extra: (count: number, size: string): Words => ({ en: `Extra pieces: ${count} ${size} already cut`, it: `Pezzi in più: ${count} ${size} già tagliati` }),
  /** Round 4: Accept stays held until what happens to the extra pieces is chosen. op-fx3: one piece is said in the singular (the
   *  catalogue's own orders `edit.held.extra_one` words: "the 1 extra piece" / "del 1 pezzo in più"). */
  chooseExtra: (count: number): Words =>
    count === 1 ? { en: `Choose what happens to the ${count} extra piece`, it: `Scegli cosa fare del ${count} pezzo in più` } : { en: `Choose what happens to the ${count} extra pieces`, it: `Scegli cosa fare dei ${count} pezzi in più` },
} as const
