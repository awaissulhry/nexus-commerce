import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { CREDIT_FINDINGS, CREDIT_LIMITS, CREDIT_RESULTS, CREDIT_STEPS } from '@nexus/factory-domain/sales/credit/credit'
import { LIMIT_VIEWS } from './limits'
import { RECORD_TYPES } from './records'

/**
 * The credit routes' contracts (B-W2b-304; modules/sales/credit). Every amount is the price grain (minor units of the
 * row's `currency`): the grain filter drops it from an answer without money.price. Never a cost or a margin.
 */

const amount = () => money.price(z.number().int().nullable())
const label = output({ id: id(), code: z.string() })
const step = z.enum(CREDIT_STEPS)
const result = z.enum(CREDIT_RESULTS)
const finding = z.enum(CREDIT_FINDINGS)

const checkRow = output({
  id: id(),
  step,
  result,
  words: z.string().nullable(),
  checkedAt: instant(),
  by: z.string().nullable(),
  overridesCheckId: id().nullable(),
  overrideTaskId: id().nullable(),
  currency: z.string(),
  exposure: amount(),
  limit: amount(),
  overdue: amount(),
})

const customer = output({
  party: output({ id: id(), code: z.string(), name: z.string() }),
  company: label,
  currency: z.string().nullable(),
  limit: amount(),
  openOrders: amount(),
  openInvoices: amount(),
  overdue: amount(),
  subject: amount(),
  exposure: amount(),
  available: amount(),
  overLimitBy: amount(),
  /** The share of the limit used, in whole percent (a ratio of price-grain figures: drawn only beside them). */
  usedPct: notMoney(z.number().int().nullable()),
  onHold: z.boolean(),
  findings: z.array(finding),
  /** What a check of the record's step would answer now (null: no limit, no check). */
  wouldBe: result.nullable(),
  held: output({
    checkId: id(),
    step,
    checkedAt: instant(),
    request: output({ taskId: id(), status: z.string(), approver: z.string().nullable(), requestedAt: instant(), dueAt: instant().nullable() }).nullable(),
  }).nullable(),
  checks: z.array(checkRow),
  may: output({ checkAgain: z.boolean(), ask: z.boolean() }),
})

export const recordCreditContract = defineContract({
  params: input({ recordType: z.enum(RECORD_TYPES), recordId: id() }),
  response: {
    200: output({
      record: output({ type: z.string(), id: id(), label: z.string(), step }),
      customers: z.array(customer),
      readAt: instant(),
    }),
  },
})

const limitRow = output({
  termsId: id(),
  version: z.number().int(),
  party: output({ id: id(), code: z.string(), name: z.string() }),
  company: label,
  currency: z.string(),
  limit: amount(),
  used: amount(),
  openOrders: amount(),
  openInvoices: amount(),
  overdue: amount(),
  available: amount(),
  overLimitBy: amount(),
  usedPct: notMoney(z.number().int().nullable()),
  onHold: z.boolean(),
  findings: z.array(finding),
  held: output({ orders: z.number().int(), releases: z.number().int(), shipments: z.number().int(), firstOrders: z.array(output({ id: id(), number: z.string() })) }),
  changedAt: instant(),
  mayChange: z.boolean(),
})

export const listLimitsContract = defineContract({
  querystring: input({
    companyId: id().optional(),
    q: z.string().max(100).optional(),
    view: z.enum(LIMIT_VIEWS).optional(),
    cursor: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
  response: {
    200: output({
      readAt: instant(),
      tiles: output({ customers: z.number().int(), over: z.number().int(), held: z.number().int(), heldOrders: z.number().int() }),
      rows: z.array(limitRow),
      count: z.number().int(),
      next: z.number().int().nullable(),
    }),
  },
})

export const setLimitContract = defineContract({
  params: input({ partyId: id(), companyId: id() }),
  body: input({
    version: z.number().int().min(1).optional(),
    amount: money.price(z.number().int().nullable()),
    currency: z.string().max(3).nullable(),
    reason: z.string().max(CREDIT_LIMITS.words + 200),
  }),
  response: { 200: output({ row: limitRow.nullable(), rechecked: z.number().int() }) },
})

const note = input({ note: z.string().max(CREDIT_LIMITS.note + 200).nullable().optional() })

export const checkAgainContract = defineContract({
  params: input({ recordType: z.enum(RECORD_TYPES), recordId: id() }),
  body: note,
  response: { 200: output({ checkId: id(), result, asked: z.boolean(), orderGoesOn: z.boolean() }) },
})

export const askAgainContract = defineContract({
  params: input({ checkId: id() }),
  body: note,
  response: { 201: output({ taskId: id() }) },
})
