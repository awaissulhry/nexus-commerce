import { z } from 'zod'
import { defineContract, instant, output } from '@nexus/factory-domain/core/contracts'
import { incomingList, incomingListQuery } from '@nexus/factory-domain/sales/incoming/contracts'

/** Sales › Incoming's contracts (B-TH-039): factory-domain's sales/incoming/contracts. */
export const listIncomingContract = defineContract({ querystring: incomingListQuery, response: { 200: incomingList } })

// ---- B-SA-010 (sales page plan N1, pick P1): the office shell's "N waiting on us" beside Incoming -----------------------------
export const waitingCountContract = defineContract({
  response: {
    200: output({
      /** The rows whose next move is ours, of every kind the reader may list; null: the reader lists no kind (no badge). */
      count: z.number().int().nullable(),
      asOf: instant(),
    }),
  },
})
// ---- end B-SA-010
