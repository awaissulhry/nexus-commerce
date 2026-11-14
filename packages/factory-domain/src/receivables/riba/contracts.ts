import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { money } from '../../money/marked'
import { MAX_RIBA_ITEMS, MAX_RIBA_TEXT, RIBA_BATCH_STATUSES, RIBA_ITEM_STATUSES, RIBA_REFUSALS, RIBA_SETTLEMENTS } from './riba'

/**
 * The contracts of Ri.Ba. collections (B-W2b-402; FIN-126; design finance.payments ⋯ "Ri.Ba. batch": invoices due in the
 * window, total, CBI file; the tile "Ri.Ba. unpaid"; the new tab "Ri.Ba. file download" = GET /files/:fileId/download).
 * Every amount is marked with the price grain and dropped for a caller without it. Words are English; the screens draw
 * them from the codes.
 */

const version = () => z.number().int().min(1)
const ref = output({ id: id(), code: z.string(), name: z.string() })
const refusal = output({ code: z.enum(Object.keys(RIBA_REFUSALS) as [keyof typeof RIBA_REFUSALS]), words: z.string() })
const debtorBank = output({ abi: z.string(), cab: z.string(), name: z.string().nullable(), source: z.enum(['GIVEN', 'INVOICE', 'BANK_LINE']) })
const abiCab = z.string().regex(/^\d{5}$/)

export const batchParams = input({ batchId: id() })

export const candidatesQuery = input({ companyId: id(), dueFrom: businessDate(), dueTo: businessDate(), batchId: id().optional() })

export const candidateView = output({
  invoice: output({ id: id(), number: z.string(), issueDate: businessDate() }),
  customer: ref,
  instalment: z.number().int(),
  dueDate: businessDate(),
  instalmentAmount: money.price(z.number().int()),
  /** What the receipt collects: what is open on the instalment. */
  amount: money.price(z.number().int()),
  currency: z.string(),
  /** The customer's bank the receipt goes to, as known (null: it must be given when the file is made). */
  debtorBank: debtorBank.nullable(),
  /** Why it cannot join a batch now (null: it can). */
  held: refusal.nullable(),
})

export const candidatesAnswer = output({ companyId: id(), dueFrom: businessDate(), dueTo: businessDate(), candidates: z.array(candidateView), total: money.price(z.number().int()), count: z.number().int() })

const pick = input({ invoiceId: id(), instalment: z.number().int().min(1).max(100) })

export const createBatchBody = input({
  companyId: id(),
  /** The collecting account; absent: the company's only live account. */
  bankAccountId: id().optional(),
  dueFrom: businessDate(),
  dueTo: businessDate(),
  /** The instalments to collect; absent: every candidate of the window. */
  items: z.array(pick).min(1).max(MAX_RIBA_ITEMS).optional(),
  note: z.string().trim().min(1).max(MAX_RIBA_TEXT.note).nullish(),
})
export type CreateBatchBody = z.infer<typeof createBatchBody>

export const pickBody = input({ version: version(), items: z.array(pick).min(1).max(MAX_RIBA_ITEMS) })
export type PickBody = z.infer<typeof pickBody>

export const issueBody = input({
  version: version(),
  /** The SIA code the bank gave the company for CBI files (5 letters or digits). */
  siaCode: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{5}$/),
  /** The customers' banks the factory does not know (or a correction): ABI and CAB per customer. */
  banks: z.array(input({ partyId: id(), abi: abiCab, cab: abiCab, name: z.string().trim().min(1).max(50).nullish() })).max(MAX_RIBA_ITEMS).optional(),
})
export type IssueBody = z.infer<typeof issueBody>

export const cancelBody = input({ version: version(), reason: z.string().trim().min(1).max(MAX_RIBA_TEXT.reason) })
export type CancelBody = z.infer<typeof cancelBody>

export const settleBody = input({
  version: version(),
  items: z
    .array(input({ itemId: id(), status: z.enum(RIBA_SETTLEMENTS), settledOn: businessDate(), unpaidFee: money.price(z.number().int().min(0).nullish()) }))
    .min(1)
    .max(MAX_RIBA_ITEMS),
})
export type SettleBody = z.infer<typeof settleBody>

export const itemView = output({
  id: id(),
  invoice: output({ id: id(), number: z.string().nullable(), issueDate: businessDate().nullable() }),
  customer: ref,
  instalment: z.number().int(),
  dueDate: businessDate(),
  amount: money.price(z.number().int()),
  status: z.enum(RIBA_ITEM_STATUSES),
  settledOn: businessDate().nullable(),
  unpaidFee: money.price(z.number().int().nullable()),
  /** PAID: the payment recorded for it. */
  paymentId: id().nullable(),
  /** What is still open on the invoice now (UNPAID: what the customer owes again). */
  invoiceOpen: money.price(z.number().int()),
  debtorBank: debtorBank.nullable(),
  version: z.number().int(),
})

export const batchView = output({
  id: id(),
  company: ref,
  bankAccount: output({ id: id(), iban: z.string(), bankName: z.string().nullable(), active: z.boolean() }),
  dueFrom: businessDate(),
  dueTo: businessDate(),
  status: z.enum(RIBA_BATCH_STATUSES),
  note: z.string().nullable(),
  items: z.array(itemView),
  count: z.number().int(),
  total: money.price(z.number().int()),
  currency: z.string(),
  /** ISSUED: the CBI file (download it with GET /files/:fileId/download), when and by whom it was made. */
  file: output({ id: id(), name: z.string(), sizeBytes: z.number().int() }).nullable(),
  issuedAt: instant().nullable(),
  issuedBy: output({ id: id(), name: z.string().nullable() }).nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  settled: output({ paid: z.number().int(), unpaid: z.number().int(), waiting: z.number().int() }),
  /** Whether the company's Ri.Ba. switch is on (the file is made only then), and the rule in words. */
  switchOn: z.boolean(),
  rule: output({ status: z.literal('UNVERIFIED'), words: z.string() }),
  can: output({ pick: z.boolean(), issue: z.boolean(), cancel: z.boolean(), settle: z.boolean() }),
  createdAt: instant(),
  version: z.number().int(),
})

export const batchAnswer = output({ batch: batchView })

export const batchesQuery = input({ companyId: id().optional(), status: z.enum(RIBA_BATCH_STATUSES).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })

export const batchRow = output({
  id: id(),
  company: ref,
  dueFrom: businessDate(),
  dueTo: businessDate(),
  status: z.enum(RIBA_BATCH_STATUSES),
  count: z.number().int(),
  total: money.price(z.number().int()),
  fileId: id().nullable(),
  issuedAt: instant().nullable(),
  settled: output({ paid: z.number().int(), unpaid: z.number().int(), waiting: z.number().int() }),
  createdAt: instant(),
})

export const batchesAnswer = output({ batches: z.array(batchRow) })

export const unpaidQuery = input({ companyId: id().optional() })

export const unpaidAnswer = output({
  /** The tile "Ri.Ba. unpaid", per currency: returned instalments whose invoice is still open and not presented again. */
  tiles: z.array(output({ currency: z.string(), count: z.number().int(), open: money.price(z.number().int()), fees: money.price(z.number().int()) })),
  items: z.array(
    output({
      itemId: id(),
      batchId: id(),
      company: ref,
      customer: ref,
      invoice: output({ id: id(), number: z.string().nullable() }),
      instalment: z.number().int(),
      dueDate: businessDate(),
      settledOn: businessDate(),
      amount: money.price(z.number().int()),
      unpaidFee: money.price(z.number().int()),
      invoiceOpen: money.price(z.number().int()),
      currency: z.string(),
      daysSince: z.number().int(),
    }),
  ),
})
