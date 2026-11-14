import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { SUBCONTRACT_VERDICTS } from '@nexus/factory-domain/payables/subcontract-match/rules'
import { COST_KINDS } from '@nexus/factory-domain/purchasing/subcontract-depth/cost'

/**
 * The subcontractor invoice match's contracts (B-W2b-403; FIN-138; PQ1:03). Pieces are integers or decimal strings; every
 * price and amount is money.cost (dropped for a reader without the cost grain).
 */

const words = output({ en: z.string(), it: z.string() })

const operation = output({
  id: id(),
  seq: z.number().int(),
  code: z.string(),
  name: z.string(),
  pricePerPiece: money.cost(z.string()),
  pieces: z.number().int(),
  piecesBackGood: z.number().int(),
  piecesDefective: z.number().int(),
  piecesScrapped: z.number().int(),
  waitingForInspection: z.number().int(),
  bookedByFee: z.number().int(),
  bookable: z.number().int(),
  earnedFee: money.cost(z.number().int()),
})

const entry = output({
  id: id(),
  kind: z.enum(COST_KINDS),
  operationId: id().nullable(),
  quantity: z.string(),
  unitPrice: money.cost(z.string()),
  amount: money.cost(z.number().int()),
  occurredAt: instant(),
  reason: z.string().nullable(),
  reversalOfId: id().nullable(),
  reversed: z.boolean(),
  ofThisLine: z.boolean(),
})

const match = output({
  verdict: z.enum(SUBCONTRACT_VERDICTS),
  invoicedPieces: z.string().nullable(),
  invoicedTotal: notMoney(z.string().nullable()),
  invoicedUnitPrice: money.cost(z.string().nullable()),
  orderUnitPrice: money.cost(z.string()),
  price: notMoney(z.enum(['SAME', 'HIGHER', 'LOWER']).nullable()),
  piecesOwed: z.number().int(),
  piecesWaiting: z.number().int(),
  piecesDefective: z.number().int(),
  piecesScrapped: z.number().int(),
  piecesAtInvoicedPrice: notMoney(z.number()),
  onWorkOrder: output({ earnedFee: money.cost(z.number().int()), fees: money.cost(z.number().int()), charges: money.cost(z.number().int()), sum: money.cost(z.number().int()) }),
  suggestions: z.array(output({ subcontractOperationId: id(), seq: z.number().int(), quantity: z.number().int(), unitPrice: money.cost(z.string()) })),
})

const line = output({
  lineId: id(),
  seq: z.number().int(),
  description: z.string(),
  quantity: z.string().nullable(),
  netAmount: money.cost(z.number().int()),
  order: output({ id: id(), number: z.string(), status: z.string(), currency: z.string(), version: z.number().int(), workOrderId: id() }),
  operations: z.array(operation),
  entries: z.array(entry),
  match,
  words,
  book: output({ held: z.string().nullable() }),
})

const answer = output({ invoiceId: id(), currency: z.string(), lines: z.array(line) })

export const subcontractMatchContract = defineContract({ params: input({ invoiceId: id() }), response: { 200: answer } })

export const bookFeeContract = defineContract({
  params: input({ invoiceId: id(), lineId: id() }),
  body: input({ orderVersion: z.number().int().min(1), subcontractOperationId: id(), quantity: z.number().int().min(1).max(1_000_000) }),
  response: { 201: output({ entryId: id(), ledger: output({ posted: z.number().int(), waiting: z.array(z.string()) }), match: answer }) },
})
