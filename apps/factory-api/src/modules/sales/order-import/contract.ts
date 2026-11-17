import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/** B-TH-101 (threads plan TH-9, SHEET-G13): the mapping an order import of a customer's sheet is offered again. */
export const rememberedMappingContract = defineContract({
  params: input({ importId: id() }),
  querystring: input({ partyId: id() }),
  response: {
    200: output({
      /** The last applied import of the same headers for this customer: its columns (header → column, null: left out); null: none. */
      remembered: output({ mapping: z.record(z.string(), z.string().nullable()), fromImportId: id(), fileName: z.string(), appliedAt: instant() }).nullable(),
    }),
  },
})
