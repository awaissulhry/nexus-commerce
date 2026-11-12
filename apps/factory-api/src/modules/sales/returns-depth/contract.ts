import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { DOCUMENT_LANGUAGES } from '@nexus/factory-domain/documents/model'
import { money } from '@nexus/factory-domain/money/marked'
import { ARRIVAL_STATES, DEPTH_LIMITS, FEE_DROPS, FEE_KINDS, POLICY_CHANNELS } from '@nexus/factory-domain/sales/returns-depth/rules'
import { FREIGHT_PAYERS, RETURN_DISPOSITIONS, RETURN_LIMITS, RETURN_STATUSES } from '@nexus/factory-domain/sales/returns/rules'

/**
 * Returns in depth (B-W2b-341; SAL-336, SAL-337, SAL-338, SAL-342, SAL-343, SAL-346). Credits, values and fees are
 * money.price (dropped for a caller without the grain; a body that sends one without it is refused). Every write takes an
 * Idempotency-Key and the version of what it changes. Refusals in words: `body/<field>` (400), a state or a use that takes no
 * such change (409). No worker's name anywhere.
 */

const version = z.number().int().min(1)
const channel = z.enum(POLICY_CHANNELS)
const freight = z.enum(FREIGHT_PAYERS)
const text = (max: number) => z.string().max(max * 2)
const issue = output({ path: z.string(), message: z.string() })
const returnParams = input({ returnId: id() })
const lineParams = input({ returnId: id(), lineId: id() })

// ---- policies -------------------------------------------------------------------------------------------------------

const policyView = output({
  id: id(),
  companyId: id(),
  channel,
  name: z.string(),
  windowDays: z.number().int(),
  goodsDueDays: z.number().int().nullable(),
  freightPaidBy: freight,
  conditions: z.string().nullable(),
  withdrawalWords: z.string().nullable(),
  effectiveFrom: z.string(),
  live: z.boolean(),
  retiredAt: z.string().nullable(),
  retiredById: id().nullable(),
  usedBy: z.number().int(),
  version: z.number().int(),
  updatedAt: z.string(),
  updatedById: id().nullable(),
})

export const listPoliciesContract = defineContract({
  querystring: input({ companyId: id().optional(), channel: channel.optional(), live: z.enum(['true', 'false']).transform((value) => value === 'true').optional() }),
  response: { 200: output({ policies: z.array(policyView.extend({ canManage: z.boolean() })), canManage: z.boolean() }) },
})

const policyTerms = {
  name: text(DEPTH_LIMITS.name),
  windowDays: z.number().int(),
  goodsDueDays: z.number().int().nullable(),
  freightPaidBy: freight,
  conditions: text(DEPTH_LIMITS.conditions).nullish(),
  withdrawalWords: text(DEPTH_LIMITS.withdrawalWords).nullish(),
  effectiveFrom: businessDate().optional(),
}

export const createPolicyContract = defineContract({
  body: input({ companyId: id(), channel, ...policyTerms }),
  response: { 201: output({ policy: policyView, retired: output({ id: id(), name: z.string() }).nullable() }) },
})

export const changePolicyContract = defineContract({
  params: input({ policyId: id() }),
  body: input({ version, name: policyTerms.name.optional(), windowDays: policyTerms.windowDays.optional(), goodsDueDays: policyTerms.goodsDueDays.optional(), freightPaidBy: freight.optional(), conditions: policyTerms.conditions, withdrawalWords: policyTerms.withdrawalWords, effectiveFrom: policyTerms.effectiveFrom }),
  response: { 200: output({ policy: policyView }) },
})

export const retirePolicyContract = defineContract({
  params: input({ policyId: id() }),
  body: input({ version }),
  response: { 200: output({ policy: policyView }) },
})

// ---- fee rules ------------------------------------------------------------------------------------------------------

const feeRuleView = output({
  id: id(),
  companyId: id(),
  channel: channel.nullable(),
  name: z.string(),
  reasonCodes: z.array(z.string()),
  reasons: z.array(output({ code: z.string(), labelIt: z.string(), labelEn: z.string(), active: z.boolean() })),
  kind: z.enum(FEE_KINDS),
  percent: z.string().nullable(),
  /** AMOUNT: minor units of `currency`. */
  amount: money.price(z.number().int().nullable()),
  currency: z.string().nullable(),
  terms: z.string(),
  sequence: z.number().int(),
  active: z.boolean(),
  usedBy: z.number().int(),
  version: z.number().int(),
  updatedAt: z.string(),
  updatedById: id().nullable(),
})

export const listFeeRulesContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: { 200: output({ rules: z.array(feeRuleView.extend({ canManage: z.boolean() })), canManage: z.boolean() }) },
})

const feeTerms = {
  channel: channel.nullish(),
  name: text(DEPTH_LIMITS.name),
  reasonCodes: z.array(z.string().max(40)).max(DEPTH_LIMITS.reasonCodes),
  kind: z.enum(FEE_KINDS),
  percent: z.string().max(20).nullish(),
  currency: z.string().length(3).nullish(),
  sequence: z.number().int(),
  active: z.boolean(),
}

export const createFeeRuleContract = defineContract({
  body: input({ companyId: id(), channel: feeTerms.channel, name: feeTerms.name, reasonCodes: feeTerms.reasonCodes.optional(), kind: feeTerms.kind, percent: feeTerms.percent, amount: money.price(z.number().int().min(1).nullish()), currency: feeTerms.currency, sequence: feeTerms.sequence.optional(), active: feeTerms.active.optional() }),
  response: { 201: output({ rule: feeRuleView }) },
})

export const changeFeeRuleContract = defineContract({
  params: input({ ruleId: id() }),
  body: input({ version, channel: feeTerms.channel, name: feeTerms.name.optional(), reasonCodes: feeTerms.reasonCodes.optional(), kind: feeTerms.kind.optional(), percent: feeTerms.percent, amount: money.price(z.number().int().min(1).nullish()), currency: feeTerms.currency, sequence: feeTerms.sequence.optional(), active: feeTerms.active.optional() }),
  response: { 200: output({ rule: feeRuleView }) },
})

// ---- the policy check -----------------------------------------------------------------------------------------------

const windowView = output({ deliveredOn: z.string().nullable(), lastDay: z.string().nullable(), inWindow: z.boolean(), daysOver: z.number().int(), words: z.string().nullable() })

const checkView = output({
  channel,
  channelFrom: z.enum(['CUSTOMER', 'NAMED']),
  policy: policyView.nullable(),
  fallback: output({ windowDays: z.number().int().nullable(), goodsDueDays: z.number().int().nullable() }).nullable(),
  lines: z.array(output({ index: z.number().int(), seq: z.number().int().nullable(), window: windowView, madeToMeasure: z.boolean(), personalised: z.boolean() })),
  outsideWindow: z.boolean(),
  withdrawal: output({ asked: z.boolean(), applies: z.boolean(), why: z.array(z.string()), notes: z.array(z.string()) }),
  goodsDueBy: z.string().nullable(),
  warnings: z.array(issue),
  problems: z.array(issue),
  ok: z.boolean(),
})

const soldKey = input({ invoiceLineId: id().nullish(), salesOrderLineId: id().nullish(), size: z.string().max(20).nullish() })

export const previewPolicyContract = defineContract({
  body: input({ companyId: id(), partyId: id(), channel: channel.nullish(), withdrawal: z.boolean().optional(), lines: z.array(soldKey).min(1).max(RETURN_LIMITS.lines) }),
  response: { 200: output({ check: checkView }) },
})

// ---- the depth of one return, late arrivals ---------------------------------------------------------------------------

const arrivalView = output({ state: z.enum(ARRIVAL_STATES), daysLate: z.number().int(), words: z.string() })

const depthLine = output({
  id: id(),
  seq: z.number().int(),
  size: z.string().nullable(),
  quantity: z.number().int(),
  receivedQuantity: z.number().int(),
  serial: z.string().nullable(),
  batchNumber: z.string().nullable(),
  garmentSerial: z.string().nullable(),
  garmentBatch: z.string().nullable(),
  parentLineId: id().nullable(),
  exchangeSize: z.string().nullable(),
  window: windowView.nullable(),
  currency: z.string().nullable(),
  /** What all its pieces are worth (net). */
  value: money.price(z.number().int().nullable()),
  creditAmount: money.price(z.number().int().nullable()),
  creditWithoutReturn: output({
    credited: z.boolean(),
    waiting: output({ taskId: id(), requestedAt: z.string(), approverRoleId: id().nullable(), approverUserId: id().nullable(), dueAt: z.string().nullable() }).nullable(),
    allowed: z.boolean(),
    held: z.string().nullable(),
  }),
  fee: output({ ruleId: id(), ruleName: z.string(), amount: money.price(z.number().int().nullable()), dropped: z.enum(FEE_DROPS).nullable(), words: z.string(), wordsWithAmount: money.price(z.string()) }).nullable(),
})

export const depthView = output({
  id: id(),
  number: z.string(),
  status: z.enum(RETURN_STATUSES),
  companyId: id(),
  siteId: id(),
  partyId: id(),
  channel,
  policy: output({ named: policyView.nullable(), live: policyView.nullable(), current: z.boolean(), withdrawal: z.boolean(), followsSalesSettings: z.boolean(), check: checkView.omit({ ok: true }) }),
  deadline: output({ goodsDueBy: z.string().nullable(), receivedOn: z.string().nullable(), arrival: arrivalView }),
  scanCode: z.string().nullable(),
  papers: output({ printable: z.boolean(), held: z.string().nullable() }),
  feesApply: z.boolean(),
  lines: z.array(depthLine),
  version: z.number().int(),
})

export const applyPolicyContract = defineContract({
  params: returnParams,
  body: input({ version, channel: channel.nullish(), withdrawal: z.boolean().optional(), goodsDueBy: businessDate().nullish(), reason: text(DEPTH_LIMITS.reason).nullish() }),
  response: { 200: output({ check: checkView, goodsDueBy: z.string().nullable(), return: depthView }) },
})

export const depthContract = defineContract({ params: returnParams, response: { 200: output({ return: depthView }) } })

export const arrivedLateContract = defineContract({
  querystring: input({ companyId: id().optional(), view: z.enum(['open', 'all']).optional() }),
  response: {
    200: output({
      rows: z.array(output({ id: id(), number: z.string(), companyId: id(), siteId: id(), party: output({ id: id(), code: z.string(), legalName: z.string() }).nullable(), status: z.enum(RETURN_STATUSES), goodsDueBy: z.string().nullable(), receivedOn: z.string().nullable(), daysLate: z.number().int(), words: z.string() })),
      count: z.number().int(),
      truncated: z.boolean(),
      asOf: z.string(),
    }),
  },
})

// ---- fees -----------------------------------------------------------------------------------------------------------

export const previewFeesContract = defineContract({
  params: returnParams,
  body: input({ lines: z.array(input({ lineId: id(), disposition: z.enum(RETURN_DISPOSITIONS), creditAmount: money.price(z.number().int().min(0).nullish()) })).min(1).max(RETURN_LIMITS.lines) }),
  response: {
    200: output({
      policyNamed: z.boolean(),
      channel: channel.nullable(),
      noFees: z.string().nullable(),
      lines: z.array(
        output({
          lineId: id(),
          seq: z.number().int(),
          currency: z.string().nullable(),
          creditBefore: money.price(z.number().int()),
          fee: output({ ruleId: id(), ruleName: z.string(), amount: money.price(z.number().int()), dropped: z.enum(FEE_DROPS).nullable(), words: z.string(), wordsWithAmount: money.price(z.string()) }).nullable(),
          creditAfter: money.price(z.number().int()),
        }),
      ),
    }),
  },
})

// ---- garments -------------------------------------------------------------------------------------------------------

const shippedView = output({
  batches: z.array(output({ batchNumber: z.string(), workOrderId: id(), pieces: z.number().int() })),
  serials: z.array(output({ serial: z.string(), batchNumber: z.string().nullable(), status: z.string() })),
})
const garmentRef = output({ id: id(), seq: z.number().int(), garmentSerial: z.string().nullable(), garmentBatch: z.string().nullable() })

export const lineGarmentsContract = defineContract({
  params: lineParams,
  response: {
    200: output({
      line: output({ id: id(), seq: z.number().int(), size: z.string().nullable(), quantity: z.number().int(), serial: z.string().nullable(), batchNumber: z.string().nullable(), garmentSerial: z.string().nullable(), garmentBatch: z.string().nullable() }),
      shipped: shippedView,
      suggested: output({ garmentBatch: z.string().nullable(), garmentSerial: z.string().nullable() }),
    }),
  },
})

export const nameGarmentContract = defineContract({
  params: lineParams,
  body: input({ version, garmentSerial: z.string().max(100).nullish(), garmentBatch: z.string().max(100).nullish() }),
  response: { 200: output({ line: garmentRef, changed: z.boolean(), return: depthView }) },
})

export const fillGarmentsContract = defineContract({
  params: returnParams,
  body: input({ version }),
  response: {
    200: output({
      filled: z.array(output({ lineId: id(), seq: z.number().int(), garmentBatch: z.string().nullable(), garmentSerial: z.string().nullable() })),
      toPick: z.array(output({ lineId: id(), seq: z.number().int(), batches: z.number().int(), serials: z.number().int() })),
      return: depthView,
    }),
  },
})

export const scanGarmentContract = defineContract({
  params: returnParams,
  body: input({ version, code: z.string().min(1).max(100) }),
  /** The dock's answer: no price, no policy; the RMA's version for its next write. */
  response: { 200: output({ line: garmentRef, named: z.enum(['SERIAL_AND_LOT', 'LOT_ONLY']), words: z.string(), changed: z.boolean(), version: z.number().int() }) },
})

// ---- credit without a return ----------------------------------------------------------------------------------------

export const previewCreditContract = defineContract({
  params: lineParams,
  body: input({ creditAmount: money.price(z.number().int().min(1).nullish()) }),
  response: {
    200: output({
      ok: z.boolean(),
      problems: z.array(issue),
      lineId: id(),
      seq: z.number().int(),
      pieces: z.number().int(),
      currency: z.string().nullable(),
      value: money.price(z.number().int().nullable()),
      creditAmount: money.price(z.number().int().nullable()),
      effect: z.string(),
      approval: output({ needed: z.boolean(), approverRoleId: id().nullable(), approverUserId: id().nullable(), nobodyElse: z.boolean() }),
      waiting: output({ taskId: id(), requestedAt: z.string() }).nullable(),
    }),
  },
})

const creditAnswer = output({
  credited: z.boolean(),
  waiting: output({ taskId: id(), approverRoleId: id().nullable(), approverUserId: id().nullable(), dueAt: z.string().nullable() }).nullable(),
  return: depthView,
})

export const creditContract = defineContract({
  params: lineParams,
  body: input({ version, creditAmount: money.price(z.number().int().min(1).nullish()), note: text(DEPTH_LIMITS.reason).nullish() }),
  response: { 200: creditAnswer, 202: creditAnswer },
})

// ---- the scan code and the papers -----------------------------------------------------------------------------------

export const scanCodeContract = defineContract({ params: returnParams, body: input({ version }), response: { 200: output({ scanCode: z.string(), created: z.boolean(), return: depthView }) } })

export const papersContract = defineContract({ params: returnParams, querystring: input({ language: z.enum(DOCUMENT_LANGUAGES).optional() }), response: {} })
