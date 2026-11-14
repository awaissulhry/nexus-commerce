import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CANCELLATION_DEPOSIT_KINDS, CANCELLATION_DOCUMENTS, CANCELLED_BY, REFUND_RULES, RULE_NOTE_MAX } from '@nexus/factory-domain/invoicing/cancellation/cancellation'
import { money } from '@nexus/factory-domain/money/marked'
import { invoiceView } from '../contract'

/**
 * The deposit when an order is cancelled (B-W2b-396; FIN-080): the company's rules, and a cancelled order's deposits decided
 * by them with the credit notes that follow. Amounts are marked money.price; a percent kept is not money. A version is the
 * edit-conflict guard.
 */

const version = z.number().int().min(1)
const pct = z.string().trim().min(1).max(12)

export const ruleView = output({
  id: id(),
  version: z.number().int(),
  companyId: id(),
  depositKind: z.enum(CANCELLATION_DEPOSIT_KINDS),
  cancelledBy: z.enum(CANCELLED_BY),
  /** true: made-to-measure orders; false: the others; null: any order. */
  madeToMeasure: z.boolean().nullable(),
  refundRule: z.enum(REFUND_RULES),
  keepPct: z.string(),
  documentKind: z.enum(CANCELLATION_DOCUMENTS),
  note: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  createdAt: instant(),
  updatedAt: instant(),
})

export const listRulesContract = defineContract({
  querystring: input({ companyId: id(), status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).optional() }),
  response: { 200: output({ companyId: id(), rules: z.array(ruleView), rule: output({ status: z.literal('UNVERIFIED'), words: z.string() }), mayManage: z.boolean() }) },
})

export const createRuleContract = defineContract({
  body: input({
    companyId: id(),
    depositKind: z.enum(CANCELLATION_DEPOSIT_KINDS),
    cancelledBy: z.enum(CANCELLED_BY),
    madeToMeasure: z.boolean().nullable(),
    refundRule: z.enum(REFUND_RULES),
    /** Percent kept, 0 to 100 (above 0 exactly for KEEP_PERCENT); default 0. */
    keepPct: pct.optional(),
    documentKind: z.enum(CANCELLATION_DOCUMENTS),
    note: z.string().trim().max(RULE_NOTE_MAX).nullish(),
  }),
  response: { 201: output({ rule: ruleView }) },
})

export const updateRuleContract = defineContract({
  params: input({ ruleId: id() }),
  body: input({ version, refundRule: z.enum(REFUND_RULES).optional(), keepPct: pct.optional(), documentKind: z.enum(CANCELLATION_DOCUMENTS).optional(), note: z.string().trim().max(RULE_NOTE_MAX).nullish() }),
  response: { 200: output({ rule: ruleView }) },
})

export const archiveRuleContract = defineContract({ params: input({ ruleId: id() }), body: input({ version }), response: { 200: output({ rule: ruleView }) } })

const outcomeView = output({
  depositRequestId: id(),
  depositKind: z.string(),
  currency: z.string(),
  paid: money.price(z.number().int()),
  invoiced: money.price(z.number().int()),
  source: z.enum(['RULE', 'NO_RULE']),
  ruleId: id().nullable(),
  refundRule: z.enum(REFUND_RULES),
  keepPct: z.string(),
  kept: money.price(z.number().int()),
  refund: money.price(z.number().int()),
  extra: money.price(z.number().int()),
  document: z.enum(CANCELLATION_DOCUMENTS),
  creditAmount: money.price(z.number().int()),
  /** A credit note of its deposit invoice exists already (drafted or issued): decided. */
  decided: z.boolean(),
  words: z.string(),
})

export const orderOutcomeContract = defineContract({
  params: input({ orderId: id() }),
  querystring: input({ cancelledBy: z.enum(CANCELLED_BY) }),
  response: {
    200: output({
      orderId: id(),
      number: z.string(),
      status: z.string(),
      madeToMeasure: z.boolean(),
      cancelledBy: z.enum(CANCELLED_BY),
      deposits: z.array(outcomeView),
      rule: output({ status: z.literal('UNVERIFIED'), words: z.string() }),
    }),
  },
})

export const decideOrderContract = defineContract({
  params: input({ orderId: id() }),
  body: input({ cancelledBy: z.enum(CANCELLED_BY) }),
  response: { 200: output({ orderId: id(), deposits: z.array(outcomeView), creditNotes: z.array(invoiceView) }) },
})
