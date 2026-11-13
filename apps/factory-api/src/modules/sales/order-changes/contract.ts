import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output, unitPrice } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { MAX_REASON } from '@nexus/factory-domain/sales/orders/orders'
import { MAX_QUOTE_LINES, MAX_SIZE_QUANTITY, MAX_TEXT } from '@nexus/factory-domain/sales/quotes/quotes'
import { FREEZE_LIMITS, FREEZE_STATES, ORDER_FREEZE_ACTIONS, ORDER_FREEZE_FIELDS, ORDER_FREEZE_STAGES } from '@nexus/factory-domain/sales/order-changes/freeze'
import { CHANGE_YES_STATES, CUSTOMER_DECISIONS, PRICED_LIMITS } from '@nexus/factory-domain/sales/order-changes/priced'
import { diffView } from '../orders/daily-contract'
import { orderView } from '../orders/contract'

/**
 * The order-changes routes (B-W2b-309; modules/sales/order-changes). Prices, fees and deposits are money.price (dropped for a
 * caller without the grain; a body that sends one without it is refused). No cost, no person's figure.
 */

const words = output({ en: z.string(), it: z.string() })
const version = z.number().int().min(1)
const field = z.enum(ORDER_FREEZE_FIELDS)
const stage = z.enum(ORDER_FREEZE_STAGES)
const action = z.enum(ORDER_FREEZE_ACTIONS)
const issue = output({ path: z.string(), message: z.string() })
const orderParams = input({ orderId: id() })

// ---- freeze rules ----------------------------------------------------------------------------------------------------------

const ruleView = output({
  id: id(),
  companyId: id(),
  field,
  fieldWords: words,
  frozenFrom: stage,
  stageWords: words,
  action,
  active: z.boolean(),
  note: z.string().nullable(),
  words,
  updatedBy: z.string().nullable(),
  updatedAt: instant(),
  version: z.number().int(),
})

export const listFreezeRulesContract = defineContract({
  querystring: input({ companyId: id() }),
  response: { 200: output({ companyId: id(), rules: z.array(ruleView), fields: z.array(output({ field, words, scope: z.enum(['SIZE', 'LINE', 'ORDER']) })), mayManage: z.boolean() }) },
})

const note = z.string().max(FREEZE_LIMITS.note + 10).nullable().optional()

export const createFreezeRuleContract = defineContract({
  body: input({ companyId: id(), field, frozenFrom: stage, action, note }),
  response: { 201: output({ rule: ruleView }) },
})

export const updateFreezeRuleContract = defineContract({
  params: input({ ruleId: id() }),
  body: input({ version, active: z.boolean().optional(), action: action.optional(), note }),
  response: { 200: output({ rule: ruleView }) },
})

const stageOut = { stage: stage.nullable(), on: businessDate().nullable(), words }
const verdict = output({ field, fieldWords: words, state: z.enum(FREEZE_STATES), frozenFrom: stage.nullable(), ruleId: id().nullable(), words })

export const orderFreezeContract = defineContract({
  params: orderParams,
  response: {
    200: output({
      orderId: id(),
      number: z.string(),
      /** How many active rules the company keeps (0: every field open). */
      rules: z.number().int(),
      order: output({ ...stageOut, fields: z.array(verdict) }),
      lines: z.array(
        output({
          lineId: id(),
          seq: z.number().int(),
          ...stageOut,
          fields: z.array(verdict),
          sizes: z.array(output({ size: z.string(), ...stageOut, locked: z.boolean(), state: z.enum(FREEZE_STATES), words })),
        }),
      ),
    }),
  },
})

// ---- priced changes --------------------------------------------------------------------------------------------------------

const text = (max: number) => z.string().trim().max(max)
const sizeInput = input({ size: z.string().trim().min(1).max(10), quantity: z.number().int().min(0).max(MAX_SIZE_QUANTITY), unitPrice: money.price(unitPrice().nullish()) })
const amendLine = input({
  id: id().optional(),
  styleId: id().optional(),
  colourwayId: id().optional(),
  sizes: z.array(sizeInput).max(50).optional(),
  unitPrice: money.price(unitPrice().nullish()),
  description: text(MAX_TEXT.description).nullish(),
  note: text(MAX_TEXT.note).nullish(),
})

const pricedFields = {
  reason: z.string().trim().max(MAX_REASON).optional(),
  customerRef: text(MAX_TEXT.customerRef).nullish(),
  requestedDate: businessDate().nullish(),
  lines: z.array(amendLine).min(1).max(MAX_QUOTE_LINES),
  /** The office's words per line part: { "<lineId>": "One more jacket in 52, cut on its own" }. */
  labels: z.record(id(), z.string().max(PRICED_LIMITS.label + 10)).optional(),
  /** The change fee, net, in the order's currency ("25.00"). */
  fee: money.price(z.string().trim().max(20).nullish()),
  /** The extra deposit: left out = the order's own percent of the growth; null = none. */
  deposit: money.price(
    input({ pct: z.string().trim().max(12).optional(), amount: money.price(z.string().trim().max(20).optional()), dueDate: businessDate().optional(), kind: z.enum(['ACCONTO', 'CAPARRA', 'CAPARRA_PENITENZIALE']).optional() }).nullish(),
  ),
}

const partView = output({ label: z.string(), orderLineId: id().nullable(), amount: money.price(z.number().int()) })
const depositPlan = output({ amount: money.price(z.number().int()), pct: z.string(), basis: z.string(), kind: z.string(), growthAmount: money.price(z.number().int()) })

export const previewPricedChangeContract = defineContract({
  params: orderParams,
  body: input({ version: version.optional(), ...pricedFields }),
  response: {
    200: output({
      ok: z.boolean(),
      problems: z.array(issue),
      revision: z.number().int(),
      version: z.number().int(),
      diff: diffView.nullable(),
      parts: money.price(z.array(partView)),
      feeAmount: money.price(z.number().int().nullable()),
      changeAmount: money.price(z.number().int().nullable()),
      deposit: money.price(depositPlan.nullable()),
      yes: z.enum(['WOULD_ASK', 'NO_RULE', 'NOBODY_TO_ASK']).nullable(),
      stage: output({ stage, words }).nullable(),
    }),
  },
})

const changeView = output({
  id: id(),
  revision: z.number().int(),
  reason: z.string(),
  createdAt: instant(),
  createdBy: z.string().nullable(),
  /** A priced change request (its parts or a fee): a yes/no, not money. */
  priced: notMoney(z.boolean()),
  diff: diffView,
  parts: money.price(z.array(partView)),
  feeAmount: money.price(z.number().int().nullable()),
  changeAmount: money.price(z.number().int()),
  deposit: output({ id: id(), kind: z.string(), kindWords: words, amount: money.price(z.number().int()), pct: z.string().nullable(), status: z.string(), dueDate: businessDate() }).nullable(),
  yes: output({ state: z.enum(CHANGE_YES_STATES), words, taskId: id().nullable(), reason: z.string().nullable() }),
  customer: output({ decision: z.enum(CUSTOMER_DECISIONS), words, requestId: id().nullable(), answeredAt: instant().nullable() }),
  putBack: output({ may: z.boolean(), why: z.string().nullable() }),
})

export const applyPricedChangeContract = defineContract({
  params: orderParams,
  body: input({ version, ...pricedFields, reason: z.string().trim().min(1).max(MAX_REASON) }),
  response: { 201: output({ order: orderView, change: changeView }) },
})

export const listChangesContract = defineContract({
  params: orderParams,
  response: { 200: output({ orderId: id(), number: z.string(), waitingForYes: output({ taskId: id(), since: instant() }).nullable(), reapprovalNeededAt: instant().nullable(), changes: z.array(changeView) }) },
})

export const putBackContract = defineContract({
  params: input({ orderId: id(), amendmentId: id() }),
  body: input({ version, reason: z.string().trim().max(MAX_REASON).optional() }),
  response: { 201: output({ order: orderView, change: changeView, depositCancelled: z.boolean() }) },
})

export const depositKindsContract = defineContract({
  querystring: input({ companyId: id() }),
  response: {
    200: output({
      companyId: id(),
      kinds: z.array(output({ kind: z.enum(['ACCONTO', 'CAPARRA', 'CAPARRA_PENITENZIALE']), words, available: z.boolean(), why: words.nullable() })),
      caparraPenitenziale: output({ on: z.boolean(), source: z.enum(['COMPANY', 'TENANT', 'NONE']) }),
    }),
  },
})
