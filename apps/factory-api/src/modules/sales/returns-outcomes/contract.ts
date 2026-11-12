import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CASE_LIMITS } from '@nexus/factory-domain/sales/portal-returns/rules'
import { FINISH_LIMITS, FINISH_REASONS, REMAKE_CHANNELS, REMAKE_LIMITS } from '@nexus/factory-domain/sales/returns-outcomes/rules'
import { GOODS_OUTCOMES, RETURN_DISPOSITIONS, RETURN_LIMITS, RETURN_STATUSES } from '@nexus/factory-domain/sales/returns/rules'
import { fileView } from '../../../platform/files/contract'
import { sourceRequest } from '../../shipping/ddt/contract'
import { requestReturnContract, submitClaimContract } from '../portal-returns/contract'
import { dockView } from '../returns/contract'

/**
 * Remakes, exchanges and closing a return (B-W2b-346; SAL-298, SAL-350, SAL-351, SAL-355, SAL-360). No money in these
 * answers. Every write takes an Idempotency-Key and the RMA's `version`. Refusals in words: `body/<field>` (400), a state
 * that takes no such change (409). No worker's name anywhere. A size exchange is decided on W2a's decision route
 * (`exchangeSize` on a SIZE_EXCHANGE line); its replacement line is W2a's replacement order.
 */

const version = z.number().int().min(1)
const issue = output({ path: z.string(), message: z.string() })
const returnParams = input({ returnId: id() })
const text = (max: number) => z.string().max(max * 2)
const held = z.string().nullable()

const outcomesView = output({
  id: id(),
  number: z.string(),
  status: z.enum(RETURN_STATUSES),
  channel: z.string(),
  remake: output({
    asked: z.boolean(),
    at: instant().nullable(),
    via: z.enum(REMAKE_CHANNELS).nullable(),
    lineIds: z.array(id()),
    fit: z.string().nullable(),
    photos: z.array(output({ lineId: id(), count: z.number().int(), needed: z.number().int() })),
    held,
  }),
  lines: z.array(
    output({
      id: id(),
      seq: z.number().int(),
      description: z.string(),
      size: z.string().nullable(),
      quantity: z.number().int(),
      receivedQuantity: z.number().int(),
      expected: z.number().int(),
      graded: z.boolean(),
      disposition: z.enum(RETURN_DISPOSITIONS).nullable(),
      goodsOutcome: z.enum(GOODS_OUTCOMES).nullable(),
      exchangeSize: z.string().nullable(),
      replacementLineId: id().nullable(),
      creditWithoutReturn: z.boolean(),
      parentLineId: id().nullable(),
      splitLineIds: z.array(id()),
      split: output({ allowed: z.boolean(), held, rest: z.number().int() }),
      exchange: output({ sizes: z.array(z.string()), held }),
      sendBack: output({ allowed: z.boolean(), held, ddtNumber: z.string().nullable() }),
      remake: z.boolean(),
      photos: z.number().int(),
      version: z.number().int(),
    }),
  ),
  sendBack: output({
    allowed: z.boolean(),
    held,
    lineIds: z.array(id()),
    ddts: z.array(output({ id: id(), number: z.string(), documentDate: z.string(), startAt: instant(), packages: z.number().int(), transportBy: z.string(), carrierName: z.string().nullable(), lineIds: z.array(id()) })),
  }),
  finish: output({
    held,
    reasons: z.array(output({ reason: z.enum(FINISH_REASONS), allowed: z.boolean(), held })),
    suggested: z.enum(FINISH_REASONS).nullable(),
    missingPieces: z.number().int(),
    finishReason: z.enum(FINISH_REASONS).nullable(),
    closedAt: instant().nullable(),
  }),
  version: z.number().int(),
})

export const outcomesContract = defineContract({ params: returnParams, response: { 200: output({ return: outcomesView }) } })

export const splitContract = defineContract({
  params: input({ returnId: id(), lineId: id() }),
  body: input({ version }),
  response: { 200: output({ return: dockView, line: output({ id: id(), seq: z.number().int(), quantity: z.number().int() }), newLine: output({ id: id(), seq: z.number().int(), quantity: z.number().int() }) }) },
})

export const sendBackContract = defineContract({
  params: returnParams,
  body: input({ version, lineIds: z.array(id()).max(RETURN_LIMITS.lines).optional(), note: text(1000).nullish(), ddt: sourceRequest.omit({ version: true, lineIds: true }).optional() }),
  response: {
    200: output({
      return: outcomesView,
      decidedLineIds: z.array(id()),
      ddt: output({ id: id(), number: z.string(), file: fileView.nullable(), pdfProblem: z.string().nullable() }).nullable(),
    }),
  },
})

export const finishContract = defineContract({
  params: returnParams,
  body: input({ version, finishReason: z.enum(FINISH_REASONS), reason: text(FINISH_LIMITS.words).nullish() }),
  response: { 200: output({ return: outcomesView, warnings: z.array(issue) }) },
})

const fit = text(REMAKE_LIMITS.fit)

export const askRemakeContract = defineContract({
  params: returnParams,
  body: input({ version, lineIds: z.array(id()).min(1).max(RETURN_LIMITS.lines), fit }),
  response: { 200: output({ return: outcomesView }) },
})

/** One item of what the customer received (its reason is the remake's: the fit). */
const remakeLine = input({
  invoiceLineId: id().nullish(),
  salesOrderLineId: id().nullish(),
  size: z.string().trim().max(20).nullish(),
  quantity: z.number().int().min(1).max(99_999),
  serial: z.string().trim().max(CASE_LIMITS.serial).nullish(),
})
const remakeBody = { lines: z.array(remakeLine).min(1).max(1), fit, customerRef: z.string().trim().max(CASE_LIMITS.customerRef).nullish() }

export const portalRemakeContract = defineContract({ body: input(remakeBody), response: { 201: requestReturnContract.response[201] } })

export const linkRemakeContract = defineContract({
  querystring: input({ language: z.enum(['it', 'en']).optional() }),
  body: input({ ...remakeBody, typedName: z.string().trim().max(120).nullish() }),
  response: { 201: submitClaimContract.response[201] },
})
