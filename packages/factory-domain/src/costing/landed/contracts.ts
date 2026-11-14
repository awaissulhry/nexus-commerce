import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { money } from '../../money/marked'
import { UOMS } from '../../product/units/units'
import { LANDED_BASES, LANDED_STATUSES } from './rules'

/**
 * The contracts of landed cost (B-W2b-407; FIN-044). Every amount is `money.cost` (dropped for a caller without the cost
 * grain); lots, quantities, kilograms, documents and words are shown to every caller with costing.view. Who posted or
 * reversed an allocation is named only inside the one allocation (an office user, never a worker).
 */

const partyRef = output({ id: id(), name: z.string() })
const userRef = output({ id: id(), name: z.string() })
const invoiceRef = output({ id: id(), number: z.string(), issueDate: businessDate(), status: z.string() })
const chargeLineRef = output({ id: id(), seq: z.number().int(), description: z.string(), netAmount: money.cost(z.number().int()) })

/** Where a charge line stands: no live allocation, a DRAFT being prepared, POSTED. */
export const CHARGE_STATES = ['WAITING', 'DRAFT', 'POSTED'] as const

export const landedChargeView = output({
  companyId: id(),
  supplier: partyRef,
  invoice: invoiceRef,
  line: chargeLineRef,
  currency: z.string(),
  state: z.enum(CHARGE_STATES),
  /** The live allocation (DRAFT or POSTED), else null. */
  allocation: output({ id: id(), status: z.enum(LANDED_STATUSES), basis: z.enum(LANDED_BASES), version: z.number().int() }).nullable(),
  /** Allocations reversed before. */
  reversed: z.number().int(),
})
export type LandedChargeView = z.infer<typeof landedChargeView>

export const landedQuery = input({
  companyId: id().optional(),
  partyId: id().optional(),
  supplierInvoiceId: id().optional(),
  state: z.enum(CHARGE_STATES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})
export type LandedQuery = z.infer<typeof landedQuery>

export const landedAnswer = output({ charges: z.array(landedChargeView), truncated: z.boolean(), waits: z.string().nullable(), empty: z.string() })

export const landedShareView = output({
  id: id(),
  lot: output({ id: id(), code: z.string() }),
  item: output({ id: id(), code: z.string(), name: z.string(), baseUom: z.enum(UOMS) }),
  site: output({ id: id(), code: z.string() }),
  receipt: output({ id: id(), number: z.string() }).nullable(),
  /** Base units received on the lot's receipt line. */
  receivedQuantity: z.string().nullable(),
  /** The lot's figure on the basis (VALUE: minor units of its purchase value; WEIGHT: kg; QUANTITY: base units). */
  basisAmount: money.cost(z.string()),
  amount: money.cost(z.number().int()),
})
export type LandedShareView = z.infer<typeof landedShareView>

export const landedAllocationView = output({
  id: id(),
  companyId: id(),
  supplier: partyRef,
  invoice: invoiceRef,
  line: chargeLineRef,
  basis: z.enum(LANDED_BASES),
  basisWords: z.string(),
  amount: money.cost(z.number().int()),
  currency: z.string(),
  status: z.enum(LANDED_STATUSES),
  postedAt: instant().nullable(),
  postedBy: userRef.nullable(),
  reversedAt: instant().nullable(),
  reversedBy: userRef.nullable(),
  reverseReason: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  shares: z.array(landedShareView),
  words: z.string(),
  /** ACCOUNTANT_WAITS while the company's figures are off (a DRAFT is prepared, never posted then). */
  waits: z.string().nullable(),
  can: output({ change: z.boolean(), post: z.boolean(), reverse: z.boolean(), remove: z.boolean() }),
})
export type LandedAllocationView = z.infer<typeof landedAllocationView>

const weights = z
  .array(input({ lotId: id(), kilograms: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, 'Kilograms with up to four decimals.') }))
  .max(200)

export const landedCreateBody = input({
  supplierInvoiceLineId: id(),
  basis: z.enum(LANDED_BASES),
  /** The goods receipts whose lots it lands on; default: the receipts the same invoice's goods lines were matched to. */
  receiptIds: z.array(id()).min(1).max(50).optional(),
  /** WEIGHT: the kilograms of lots whose material is not counted in KG or G. */
  weights: weights.optional(),
  note: z.string().trim().min(1).max(1000).optional(),
})
export type LandedCreateBody = z.infer<typeof landedCreateBody>

export const landedChangeBody = input({
  version: z.number().int().min(1),
  basis: z.enum(LANDED_BASES).optional(),
  receiptIds: z.array(id()).min(1).max(50).optional(),
  weights: weights.optional(),
  note: z.string().trim().min(1).max(1000).nullable().optional(),
})
export type LandedChangeBody = z.infer<typeof landedChangeBody>

export const landedPostBody = input({ version: z.number().int().min(1) })
export const landedReverseBody = input({ version: z.number().int().min(1), reason: z.string().trim().min(3).max(1000) })
export const landedRemoveQuery = input({ version: z.coerce.number().int().min(1) })

export const landedAllocationAnswer = output({ allocation: landedAllocationView })
