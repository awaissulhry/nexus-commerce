import type { BusinessDate } from '../../core/time'
import { decimalOf, type Uom } from '../../product/units/units'
import { quantityWords, whyLine } from '../explain'
import type { RequirementAction } from '../explode'

/**
 * Why each proposal of a run exists, in plain words (B-W2b-306; PLN-095; design planning.mrp run-log), pure: one sentence
 * per requirement line (what to buy or make, for which orders, and the netting that leaves it short) and per planned work
 * or subcontract order (what to make, for which order lines, when, and what kept or moved it). English; the screens may say
 * them from the facts in their language. No money, no person.
 */

const list = (values: readonly string[]): string => (values.length <= 1 ? (values[0] ?? '') : values.length === 2 ? `${values[0]} and ${values[1]}` : `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`)
const someOf = (values: readonly string[], max = 3): string => (values.length <= max ? list(values) : `${values.slice(0, max).join(', ')} and ${values.length - max} more`)

export interface RequirementReasonFacts {
  readonly action: RequirementAction
  /** "SEED-LTH-01 BLK". */
  readonly label: string
  readonly uom: Uom
  readonly grossQuantity: string
  readonly usableStock: string
  readonly onOrder: string
  readonly netQuantity: string
  readonly suggestedQuantity: string
  readonly suggestedUom: Uom
  readonly needDate: BusinessDate
  /** The order numbers behind it. */
  readonly orders: readonly string[]
  readonly firm: { readonly quantity: string; readonly uom: Uom; readonly date: BusinessDate; readonly carried: boolean } | null
  /** PLN-072: the order line it is for alone. */
  readonly reservedFor: { readonly orderNumber: string; readonly lineSeq: number } | null
}

/** One requirement line in one sentence. */
export function requirementReason(line: RequirementReasonFacts): string {
  const why = whyLine({ action: line.action, uom: line.uom, grossQuantity: line.grossQuantity, usableStock: line.usableStock, heldStock: '0.0000', onOrder: line.onOrder, netQuantity: line.netQuantity, needDate: line.needDate })
  const forWhom = line.reservedFor ? `${line.reservedFor.orderNumber} line ${line.reservedFor.lineSeq} alone (order-specific: no other order's stock or purchase lines)` : line.orders.length > 0 ? someOf(line.orders) : 'no order (a firm planned order kept)'
  const short = decimalOf(line.netQuantity).gt(0)
  const head = short
    ? `${line.action === 'BUY' ? 'Buy' : 'Make'} ${quantityWords(line.suggestedQuantity, line.suggestedUom)} of ${line.label} by ${line.needDate} for ${forWhom}`
    : `Nothing to ${line.action === 'BUY' ? 'buy' : 'make'} of ${line.label} for ${forWhom}`
  const firm = line.firm ? ` A firm planned order of ${quantityWords(line.firm.quantity, line.firm.uom)} for ${line.firm.date} ${line.firm.carried ? 'was carried from the plan before' : 'was set on this plan'}.` : ''
  return `${head}: ${why}.${firm}`
}

export interface PlannedReasonFacts {
  readonly kind: 'MAKE' | 'SUBCONTRACT'
  /** "SEED-JKT-01 BLK". */
  readonly label: string
  readonly sizes: readonly { readonly size: string; readonly quantity: number }[]
  readonly quantity: number
  readonly startDate: BusinessDate
  readonly dueDate: BusinessDate
  /** The day its demand needs it. */
  readonly needDate: BusinessDate
  /** "SO-0001 line 10". */
  readonly orderLines: readonly string[]
  readonly workshop: string | null
  readonly operationSeqs: readonly number[]
  readonly firm: boolean
  readonly protectedFields: readonly string[]
}

const FIELD_WORDS: Readonly<Record<string, string>> = Object.freeze({
  sizes: 'size run',
  startDate: 'start date',
  dueDate: 'due date',
  lineId: 'line',
  partyId: 'workshop',
  operationSeqs: 'steps',
  kitDueAt: 'kit date',
  styleRevisionId: 'revision',
})

/** One planned work or subcontract order in one sentence. */
export function plannedOrderReason(row: PlannedReasonFacts): string {
  const sizes = row.sizes.map((entry) => `${entry.size}×${entry.quantity}`).join(', ')
  const verb = row.kind === 'SUBCONTRACT' ? `Send ${row.quantity} ${row.label} (${sizes}) to ${row.workshop ?? 'a workshop'}${row.operationSeqs.length > 0 ? ` for steps ${row.operationSeqs.join(', ')}` : ''}` : `Make ${row.quantity} ${row.label} (${sizes})`
  const forWhom = row.orderLines.length > 0 ? `for ${someOf(row.orderLines)}, needed ${row.needDate}: no work order makes these pieces yet` : 'for stock'
  const when = `It starts ${row.startDate} and is due ${row.dueDate}.`
  const late = row.dueDate > row.needDate ? ` It cannot be ready by ${row.needDate}: started today at the earliest, it is due ${row.dueDate}.` : ''
  const kept = row.firm ? ' Firm: the runs keep it as it is.' : row.protectedFields.length > 0 ? ` You protected its ${list(row.protectedFields.map((field) => FIELD_WORDS[field] ?? field))}: the runs keep ${row.protectedFields.length === 1 ? 'it' : 'them'} and rewrite the rest.` : ''
  return `${verb} ${forWhom}. ${when}${late}${kept}`
}
