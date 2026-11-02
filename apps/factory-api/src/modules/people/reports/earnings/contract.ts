import { z } from 'zod'
import { amountMinor, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money } from '@nexus/factory-domain/money/marked'

/**
 * The earnings report (B-W2b-43; MES-304; design people.reports "Earnings report": worker or line · pieces · earnings ·
 * make-up · make-up share). Every figure is `money.pay`. A group under the company's minimum size shows nothing.
 */

const month = z.string().regex(/^\d{4}-\d{2}$/)
const figures = {
  people: z.number().int().nullable(),
  pieces: z.string().nullable(),
  earnings: money.pay(amountMinor().nullable()),
  makeUp: money.pay(amountMinor().nullable()),
  makeUpSharePct: z.string().nullable(),
  tooFew: z.boolean(),
}

export const earningsReportContract = defineContract({
  querystring: input({ companyId: id(), from: month, to: month.optional(), siteId: id().optional() }),
  response: {
    200: output({
      companyId: id(),
      from: month,
      to: month,
      lines: z.array(output({ line: output({ id: id(), code: z.string(), name: z.string() }).nullable(), ...figures })),
      months: z.array(output({ month, ...figures })),
      asOf: instant(),
      words: z.array(z.string()),
    }),
  },
})

export const earningsByWorkerContract = defineContract({
  body: input({ companyId: id(), from: month, to: month.optional(), siteId: id().optional() }),
  response: {
    200: output({
      companyId: id(),
      from: month,
      to: month,
      workers: z.array(output({ employeeId: id(), name: z.string(), code: z.string().nullable(), pieces: z.string(), earnings: money.pay(amountMinor()), makeUp: money.pay(amountMinor()), makeUpSharePct: z.string().nullable() })),
      words: z.array(z.string()),
    }),
  },
})

export type EarningsReportQuery = z.infer<typeof earningsReportContract.querystring>
