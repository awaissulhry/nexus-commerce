import type { ApprovalField, Facts, PreviewChange, Words } from '../../approvals/rules'
import type { Issue } from '../../core/errors'
import { fromMinorUnits, type MinorUnits } from '../../core/money'
import { Dec, HUNDRED, ZERO } from '../../tax/decimal'

/**
 * Orders in depth (B-W2b-303; SAL-201, SAL-205, SAL-207), pure: the priority and urgent flag of an order, several orders
 * from one order made from an accepted quote (the split), and the facts a SALES_ORDER approval rule tests. apps/factory-api
 * modules/sales/orders-depth runs them inside its commands; the database (…_sales_orders_depth_w2b_guards) is the last word.
 *
 *   priority     LOW | NORMAL | HIGH | URGENT (SalesOrder.priorityLevel, default NORMAL); URGENT carries its reason (one
 *                line, at most 500 characters) and only URGENT does. W1's whole-number `priority` stays: the order within a
 *                level (the backlog ranks by level, then by it). Office only: the partner never reads either.
 *   split        the parts of an order that become orders of their own: whole lines or some of their sizes. A line with a
 *                delivery schedule or chosen options moves whole; a fee line, a made-to-measure unit and a line closed short
 *                stay; the order keeps at least one piece; never more of a size than the order has.
 *   approval     SALES_ORDER's facts: the order's value (net, the price grain), its discount off the list (where the lines
 *                carry their waterfall), its lines and pieces, the customer's code, the currency, the priority, whether it
 *                came from a quote. One function for the plan before the order is made and for the request's re-read, so
 *                both see the same facts.
 */

export const SALES_ORDER_PRIORITY_LEVELS = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const
export type SalesOrderPriorityLevel = (typeof SALES_ORDER_PRIORITY_LEVELS)[number]
export const isPriorityLevel = (value: unknown): value is SalesOrderPriorityLevel => typeof value === 'string' && (SALES_ORDER_PRIORITY_LEVELS as readonly string[]).includes(value)

export const ORDERS_DEPTH_LIMITS = Object.freeze({
  urgentReason: 500,
  /** Orders whose priority one "Set priority" changes at once. */
  bulkPriority: 200,
  /** Orders one split makes. */
  splitParts: 20,
  splitReason: 500,
  /** W1's whole-number priority within a level. */
  priorityMin: -1000,
  priorityMax: 1000,
})

export const PRIORITY_WORDS: Readonly<Record<SalesOrderPriorityLevel, Words>> = Object.freeze({
  LOW: { en: 'Low', it: 'Bassa' },
  NORMAL: { en: 'Normal', it: 'Normale' },
  HIGH: { en: 'High', it: 'Alta' },
  URGENT: { en: 'Urgent', it: 'Urgente' },
})

const ONE_LINE = /^[^\r\n]+$/

/** The priority as it will be written: the level, the urgent reason (null unless URGENT), or the problems in words. */
export function priorityOf(input: { readonly priorityLevel: SalesOrderPriorityLevel; readonly urgentReason?: string | null | undefined }, at = 'body'): { priorityLevel: SalesOrderPriorityLevel; urgentReason: string | null } | Issue[] {
  const reason = input.urgentReason?.trim() ? input.urgentReason.trim() : null
  if (input.priorityLevel !== 'URGENT') {
    if (reason !== null) return [{ path: `${at}/urgentReason`, message: 'A reason goes with Urgent only: leave it out for this level.' }]
    return { priorityLevel: input.priorityLevel, urgentReason: null }
  }
  if (reason === null) return [{ path: `${at}/urgentReason`, message: 'Say why the order is urgent.' }]
  if (!ONE_LINE.test(reason) || reason.length > ORDERS_DEPTH_LIMITS.urgentReason) return [{ path: `${at}/urgentReason`, message: `The reason is one line of at most ${ORDERS_DEPTH_LIMITS.urgentReason} characters.` }]
  return { priorityLevel: 'URGENT', urgentReason: reason }
}

// ---- several orders from one (SAL-201) ------------------------------------------------------------------------------------

export interface SplitSize {
  readonly size: string
  readonly quantity: number
}

/** A line of the order being split, as the plan reads it. */
export interface SplitSourceLine {
  readonly id: string
  readonly seq: number
  readonly kind: string
  readonly closedShort: boolean
  readonly sizes: readonly SplitSize[]
  /** It has a delivery schedule (SalesOrderLineDelivery): it moves whole. */
  readonly hasDeliveries: boolean
  /** It has options chosen (SalesOrderLineOption): it moves whole. */
  readonly hasOptions: boolean
}

export interface SplitLineInput {
  readonly lineId: string
  /** The sizes and pieces that move; left out: the whole line. */
  readonly sizes?: readonly SplitSize[] | undefined
}

export interface SplitPartInput {
  readonly lines: readonly SplitLineInput[]
}

export interface PlannedLine {
  readonly lineId: string
  readonly seq: number
  /** Every piece of the line moves (its delivery schedule goes with it). */
  readonly whole: boolean
  readonly sizes: readonly SplitSize[]
}

export interface SplitPlan {
  readonly parts: readonly (readonly PlannedLine[])[]
  /** What each line of the order keeps (a line that keeps nothing is not listed: it leaves the order). */
  readonly remaining: ReadonlyMap<string, readonly SplitSize[]>
  /** The lines that leave the order whole. */
  readonly leaving: readonly string[]
}

const pieces = (sizes: readonly SplitSize[]): number => sizes.reduce((sum, size) => sum + size.quantity, 0)

/** The split as it will be written, or the problems in words (paths `body/parts/<i>/lines/<j>`). */
export function planSplit(source: readonly SplitSourceLine[], parts: readonly SplitPartInput[]): SplitPlan | Issue[] {
  const issues: Issue[] = []
  if (parts.length === 0) return [{ path: 'body/parts', message: 'Name at least one part that becomes an order of its own.' }]
  if (parts.length > ORDERS_DEPTH_LIMITS.splitParts) return [{ path: 'body/parts', message: `One split makes at most ${ORDERS_DEPTH_LIMITS.splitParts} orders.` }]
  const byId = new Map(source.map((line) => [line.id, line]))
  const left = new Map(source.map((line) => [line.id, new Map(line.sizes.map((size) => [size.size, size.quantity]))]))
  const planned: PlannedLine[][] = []
  parts.forEach((part, p) => {
    const at = `body/parts/${p}`
    const lines: PlannedLine[] = []
    if (part.lines.length === 0) issues.push({ path: `${at}/lines`, message: 'A part takes at least one line.' })
    const seen = new Set<string>()
    part.lines.forEach((input, l) => {
      const where = `${at}/lines/${l}`
      const line = byId.get(input.lineId)
      if (!line) return void issues.push({ path: `${where}/lineId`, message: 'Not a line of this order.' })
      if (seen.has(line.id)) return void issues.push({ path: `${where}/lineId`, message: `Line ${line.seq} is named twice in this part.` })
      seen.add(line.id)
      if (line.kind !== 'SIZE_GRID') return void issues.push({ path: `${where}/lineId`, message: `Line ${line.seq} is ${line.kind === 'FEE' ? 'a fee' : 'a made-to-measure unit'}: it stays on this order.` })
      if (line.closedShort) return void issues.push({ path: `${where}/lineId`, message: `Line ${line.seq} is closed short: it stays on this order.` })
      const stock = left.get(line.id)!
      const whole = input.sizes === undefined
      const asked: SplitSize[] = whole ? line.sizes.filter((size) => size.quantity > 0).map((size) => ({ ...size })) : [...input.sizes!]
      if (!whole && asked.length === 0) return void issues.push({ path: `${where}/sizes`, message: 'Name the sizes that move, or leave the sizes out to move the whole line.' })
      const sizes: SplitSize[] = []
      const named = new Set<string>()
      for (const [s, size] of asked.entries()) {
        if (named.has(size.size)) {
          issues.push({ path: `${where}/sizes/${s}/size`, message: `Size ${size.size} is named twice.` })
          continue
        }
        named.add(size.size)
        const has = stock.get(size.size)
        if (has === undefined) {
          issues.push({ path: `${where}/sizes/${s}/size`, message: `Line ${line.seq} has no size ${size.size}.` })
          continue
        }
        if (!Number.isSafeInteger(size.quantity) || size.quantity < 1) {
          issues.push({ path: `${where}/sizes/${s}/quantity`, message: 'A whole number of pieces, 1 or more.' })
          continue
        }
        if (size.quantity > has) {
          issues.push({ path: `${where}/sizes/${s}/quantity`, message: `Line ${line.seq} has ${has} of size ${size.size} left to move, not ${size.quantity}.` })
          continue
        }
        stock.set(size.size, has - size.quantity)
        sizes.push({ size: size.size, quantity: size.quantity })
      }
      const everything = pieces(sizes) === pieces(line.sizes)
      if ((line.hasDeliveries || line.hasOptions) && !everything) {
        issues.push({ path: `${where}/sizes`, message: `Line ${line.seq} has ${line.hasDeliveries ? 'a delivery schedule' : 'options chosen'}: it moves whole or stays.` })
      }
      if (sizes.length > 0) lines.push({ lineId: line.id, seq: line.seq, whole: everything, sizes })
    })
    planned.push(lines)
  })
  if (issues.length > 0) return issues
  const remaining = new Map<string, readonly SplitSize[]>()
  const leaving: string[] = []
  for (const line of source) {
    const kept = [...left.get(line.id)!.entries()].filter(([, quantity]) => quantity > 0).map(([size, quantity]) => ({ size, quantity }))
    if (line.kind === 'SIZE_GRID' && kept.length === 0) leaving.push(line.id)
    else remaining.set(line.id, line.kind === 'SIZE_GRID' ? kept : line.sizes)
  }
  if (remaining.size === 0) return [{ path: 'body/parts', message: 'The order keeps at least one line: move less, or change the order itself.' }]
  return { parts: planned, remaining, leaving }
}

// ---- the SALES_ORDER request (SAL-205) --------------------------------------------------------------------------------------

/** The facts a SALES_ORDER rule may test (the RuleBuilder's fields); money with its grain. */
export const SALES_ORDER_FIELDS: readonly ApprovalField[] = Object.freeze<ApprovalField[]>([
  { id: 'orderValue', label: { en: 'order value (net)', it: "valore dell'ordine (netto)" }, kind: 'number', grain: 'price', min: 0 },
  { id: 'discountPct', label: { en: 'discount off the list', it: 'sconto sul listino' }, kind: 'number', grain: 'price', min: 0, max: 100 },
  { id: 'currency', label: { en: 'currency', it: 'valuta' }, kind: 'text' },
  { id: 'lineCount', label: { en: 'lines', it: 'righe' }, kind: 'number', unit: null, min: 0 },
  { id: 'pieces', label: { en: 'pieces', it: 'pezzi' }, kind: 'number', unit: 'pcs', min: 0 },
  { id: 'customerCode', label: { en: 'customer code', it: 'codice cliente' }, kind: 'text' },
  {
    id: 'priorityLevel',
    label: { en: 'priority', it: 'priorità' },
    kind: 'choice',
    options: SALES_ORDER_PRIORITY_LEVELS.map((level) => ({ value: level, label: PRIORITY_WORDS[level] })),
  },
  { id: 'fromQuote', label: { en: 'made from a quote', it: "nato da un'offerta" }, kind: 'yesNo' },
])

/** The request's change: the order goes on from waiting to confirmed. */
export const SALES_ORDER_CHANGES: readonly PreviewChange[] = Object.freeze([{ field: 'status', from: 'PENDING_APPROVAL', to: 'CONFIRMED' }])

/** A line as the facts read it: its kind, pieces, unit price and waterfall (W2b-5 priceSteps; null: none). */
export interface FactLine {
  readonly kind: string
  readonly quantity: number
  readonly unitPrice: string
  readonly priceSteps: unknown
}

export interface OrderShape {
  readonly currency: string
  readonly netAmount: MinorUnits
  readonly customerCode: string | null
  readonly priorityLevel: SalesOrderPriorityLevel
  readonly fromQuote: boolean
  readonly lines: readonly FactLine[]
}

/** The list price a waterfall starts from (its first step, when it is LIST), or null. */
function listPriceOf(steps: unknown): string | null {
  if (!Array.isArray(steps) || steps.length === 0) return null
  const first = steps[0] as { kind?: unknown; unitPrice?: unknown }
  return first && first.kind === 'LIST' && typeof first.unitPrice === 'string' && /^\d+(\.\d+)?$/.test(first.unitPrice) ? first.unitPrice : null
}

/**
 * The order's discount off the list in percent (two decimals), over the goods lines whose waterfall starts at the list:
 * (list × pieces − price × pieces) ÷ (list × pieces) × 100; null when no line carries one (a typed order of W2a, a line
 * priced by hand). Never negative: a price above the list is 0.
 */
export function discountPctOf(lines: readonly FactLine[]): string | null {
  let list = ZERO
  let net = ZERO
  for (const line of lines) {
    if (line.kind === 'FEE' || line.quantity <= 0) continue
    const listPrice = listPriceOf(line.priceSteps)
    if (listPrice === null) continue
    list = list.plus(new Dec(listPrice).times(line.quantity))
    net = net.plus(new Dec(line.unitPrice).times(line.quantity))
  }
  if (list.lte(0)) return null
  const pct = list.minus(net).dividedBy(list).times(HUNDRED)
  return (pct.lt(0) ? ZERO : pct).toDecimalPlaces(2).toFixed(2)
}

/** The facts of an order (before it is made, and as its request re-reads it). */
export function salesOrderFacts(shape: OrderShape): Facts {
  const goods = shape.lines.filter((line) => line.kind !== 'FEE')
  return {
    orderValue: fromMinorUnits(shape.netAmount, shape.currency).toFixed(),
    discountPct: discountPctOf(shape.lines),
    currency: shape.currency,
    lineCount: shape.lines.length,
    pieces: goods.reduce((sum, line) => sum + line.quantity, 0),
    customerCode: shape.customerCode,
    priorityLevel: shape.priorityLevel,
    fromQuote: shape.fromQuote,
  }
}

/** Why a waiting order waits, in words (the record's banner): a yes asked on it, a credit hold, or nobody asked yet. */
export const WAIT_WORDS = Object.freeze({
  REQUEST_PENDING: { en: 'It waits for a yes: a sales order rule asks one before it goes on.', it: "Attende un sì: una regola degli ordini lo chiede prima che proceda." },
  NO_REQUEST: { en: 'It waits for a yes, but nobody has asked for one yet (the request was turned down, taken back or went stale): ask for a yes, or cancel the order.', it: 'Attende un sì, ma nessuno lo ha ancora chiesto (la richiesta è stata respinta, ritirata o non è più valida): chiedi un sì, o annulla l\'ordine.' },
  CREDIT_HOLD: { en: "It waits for the customer's credit: a credit override or a new check lets it go on.", it: 'Attende il fido del cliente: una deroga o un nuovo controllo lo lasciano proseguire.' },
  // B-W2b-368 (XF1:02): a made-to-measure unit's measures wait for the factory review (B-W2b-358's rule; not a database value).
  MEASUREMENTS: { en: "It waits for the factory review: a made-to-measure unit's measures are not confirmed yet. The review confirms them (the order then goes on) or asks the rider for more.", it: 'Attende il controllo della fabbrica: le misure di un capo su misura non sono ancora confermate. Il controllo le conferma (poi l\'ordine prosegue) o chiede altre misure al pilota.' },
} satisfies Record<string, Words>)
export type WaitReason = keyof typeof WAIT_WORDS
