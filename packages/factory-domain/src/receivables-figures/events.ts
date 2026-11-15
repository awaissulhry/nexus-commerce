import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The events of a customer's own figures (B-W2b-406; FIN-135; apps/factory-api modules/receivables/their-figures). Context
 * `receivables-figures`, its own module folder (the receivables events file is W2a's). Ids, a day and counts only: never an
 * amount, a reference or a note. Live on the Bank page of the people who hold receivables.view for the company (design
 * finance.bank "Their figures vs ours").
 *
 *   customer_figures.changed   a customer's stated figures as of a day were recorded, or corrected
 */
export const events = [
  defineEvent({
    type: 'customer_figures.changed',
    context: 'receivables-figures',
    description: "A customer's own figures as of a day (per order, its payments, its balance) were recorded or corrected.",
    payload: z.strictObject({
      figuresId: z.uuid(),
      partyId: z.uuid(),
      asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      action: z.enum(['RECORDED', 'CORRECTED']),
      orders: z.number().int().min(0),
      payments: z.number().int().min(0),
      fileKept: z.boolean(),
    }),
    live: { permission: 'receivables.view', fields: ['figuresId', 'partyId', 'action'] },
  }),
]
