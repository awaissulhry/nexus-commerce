import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { INVOICE_TIMINGS } from '@nexus/factory-domain/sales/terms/terms'
import { RUN_PICK_MAX, RUN_STATUSES } from '@nexus/factory-domain/invoicing/runs/runs'
import { money } from '@nexus/factory-domain/money/marked'
import { deadlineView } from '../contract'

/**
 * The monthly invoice run's contracts (B-W2b-396; FIN-068; design finance.invoices pop-up "Monthly invoice run"). Amounts
 * are marked money.price (the API drops them for staff without the grain). A version is the edit-conflict guard.
 */

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Expected a month, YYYY-MM.' })
const runParams = input({ runId: id() })
const problem = output({ code: z.string(), path: z.string(), message: z.string() })

export const runView = output({
  id: id(),
  version: z.number().int(),
  companyId: id(),
  month: z.string(),
  status: z.enum(RUN_STATUSES),
  issuedAt: instant().nullable(),
  issuedById: id().nullable(),
  createdAt: instant(),
  /** Each customer picked, with its deferred invoice (null: none made, `words` says why) and the invoice's checks. */
  customers: z.array(
    output({
      partyId: id(),
      code: z.string(),
      legalName: z.string(),
      invoice: output({
        id: id(),
        version: z.number().int(),
        docType: z.string(),
        status: z.string(),
        number: z.string().nullable(),
        currency: z.string(),
        ddts: z.number().int(),
        netTotal: money.price(z.number().int()),
        grossTotal: money.price(z.number().int()),
        /** A draft whose checks pass (the run issues it). */
        ready: z.boolean(),
        /** The CheckList: each problem in words with where to fix it (a draft only). */
        problems: z.array(problem),
      }).nullable(),
      words: z.string(),
    }),
  ),
  counts: output({ customers: z.number().int(), drafts: z.number().int(), ready: z.number().int(), issued: z.number().int() }),
  words: z.string(),
  can: output({ pick: z.boolean(), issue: z.boolean(), delete: z.boolean() }),
})

export const listRunsContract = defineContract({
  querystring: input({ companyId: id().optional(), month: month.optional(), status: z.enum(RUN_STATUSES).optional() }),
  response: {
    200: output({
      runs: z.array(output({ id: id(), version: z.number().int(), companyId: id(), month: z.string(), status: z.enum(RUN_STATUSES), customers: z.number().int(), invoices: z.number().int(), issuedAt: instant().nullable(), createdAt: instant() })),
    }),
  },
})

export const runCandidatesContract = defineContract({
  querystring: input({ companyId: id(), month }),
  response: {
    200: output({
      asOf: businessDate(),
      companyId: id(),
      month: z.string(),
      /** The customers whose DDTs of the month take a deferred invoice (TD24), oldest deadline first. */
      customers: z.array(
        output({
          partyId: id(),
          code: z.string(),
          legalName: z.string(),
          invoiceTiming: z.enum(INVOICE_TIMINGS),
          ddts: z.number().int(),
          valueAmount: money.price(z.number().int()),
          freightAmount: money.price(z.number().int()),
          /** Drafts holding some of its DDTs already. */
          drafts: z.array(id()),
          deadline: deadlineView.nullable(),
          words: z.string(),
          /** Another live preview of this month picks it already. */
          inRunId: id().nullable(),
        }),
      ),
    }),
  },
})

export const getRunContract = defineContract({ params: runParams, response: { 200: output({ run: runView }) } })

const skipped = z.array(output({ partyId: id(), reason: z.string() }))

export const createRunContract = defineContract({
  body: input({ companyId: id(), month, partyIds: z.array(id()).min(1).max(RUN_PICK_MAX) }),
  response: { 201: output({ run: runView, skipped }) },
})

export const pickRunContract = defineContract({
  params: runParams,
  body: input({ version: z.number().int().min(1), partyIds: z.array(id()).min(1).max(RUN_PICK_MAX) }),
  response: { 200: output({ run: runView, skipped, removed: z.array(id()) }) },
})

export const issueRunContract = defineContract({
  params: runParams,
  body: input({
    version: z.number().int().min(1).optional(),
    /** Send each issued invoice to SDI (test mode while the company is in it); default true. */
    send: z.boolean().optional(),
  }),
  response: {
    200: output({
      run: runView,
      issued: z.array(output({ invoiceId: id(), number: z.string(), filesPending: z.boolean(), sent: z.boolean(), sendProblem: z.string().nullable() })),
      /** Drafts let go from the run (they stay drafts), with their problems. */
      held: z.array(output({ invoiceId: id(), partyId: id(), problems: z.array(problem) })),
    }),
  },
})

export const deleteRunContract = defineContract({
  params: runParams,
  querystring: input({ version: z.coerce.number().int().min(1).optional() }),
  response: { 200: output({ deleted: z.literal(true), id: id(), drafts: z.number().int() }) },
})
