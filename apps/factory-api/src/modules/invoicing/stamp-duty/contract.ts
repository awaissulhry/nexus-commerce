import { z } from 'zod'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { QUARTER_STATES } from '@nexus/factory-domain/invoicing/stamp-duty/stamp-duty'
import { money } from '@nexus/factory-domain/money/marked'

/**
 * The contracts of the stamp duty quarters (B-W2b-392; FIN-101; design finance.invoices "Stamp duty this quarter"): a
 * company's quarters of a year with what is kept and what the invoices say now, the day it is due and its F24 tax code;
 * recount one; record its payment. Totals are marked money.price. A version is the edit-conflict guard.
 */

export const quarterView = output({
  /** The kept row's id, or null while the quarter was never counted. */
  id: id().nullable(),
  version: z.number().int().nullable(),
  companyId: id(),
  quarterStart: businessDate(),
  quarterEnd: businessDate(),
  /** "Q4 2026". */
  label: z.string(),
  /** What is kept (the last count). */
  invoiceCount: z.number().int(),
  total: money.price(z.number().int()),
  /** What the issued invoices of the quarter that carry stamp duty say now. */
  liveCount: z.number().int(),
  liveTotal: money.price(z.number().int()),
  /** The kept count differs from the invoices (recount it). */
  stale: z.boolean(),
  /** When it is due and its F24 tax code (UNVERIFIED: the accountant confirms), and whether a small first half moved it later. */
  dueOn: businessDate(),
  f24Code: z.string(),
  deferred: z.boolean(),
  state: z.enum(QUARTER_STATES),
  paidAt: z.string().nullable(),
  paidById: id().nullable(),
  words: z.string(),
})

export const listQuartersContract = defineContract({
  querystring: input({ companyId: id(), year: z.coerce.number().int().min(2019).max(2100).optional() }),
  response: {
    200: output({
      companyId: id(),
      year: z.number().int(),
      today: businessDate(),
      stampDutyOn: z.boolean(),
      /** What waits for the accountant while the switch is off; null when on. */
      waits: z.string().nullable(),
      /** The rule as applied (UNVERIFIED parts named). */
      rule: z.string(),
      quarters: z.array(quarterView),
    }),
  },
})

export const recountQuarterContract = defineContract({
  body: input({ companyId: id(), quarterStart: businessDate() }),
  response: { 200: output({ quarter: quarterView }) },
})

export const payQuarterContract = defineContract({
  params: input({ quarterId: id() }),
  /** The day it was paid (default today): after the quarter ended, not in the future. */
  body: input({ version: z.number().int().min(1), paidOn: businessDate().optional() }),
  response: { 200: output({ quarter: quarterView }) },
})
