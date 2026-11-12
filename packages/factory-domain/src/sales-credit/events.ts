import { z } from 'zod'
import { defineEvent } from '../events/define'
import { CREDIT_RESULTS, CREDIT_STEPS } from '../sales/credit/credit'

/**
 * Credit limits (B-W2b-304; SAL-148, SAL-237, SAL-241, SAL-244). apps/factory-api's modules/sales/credit emits them in the
 * command that writes the check or the limit: the step's own command (a quote sent, an order made, a work order released,
 * a shipment leaving), a person's check again, the approver's yes on a CREDIT_OVERRIDE request, a limit changed. Their own
 * module folder (check-event-contract wants src/<module>/events.ts): the code is factory-domain sales/credit.
 *
 *   credit_check.recorded   a check was written: its step, the record it checked and its result (an override names the
 *                           HOLD it lets through)
 *   credit_limit.changed    a customer's credit limit with a company was set, changed or cleared
 *
 * Reach the office's credit screens (sales.credit.view over the company and the customer): ids, codes and results only;
 * never an amount.
 */

const live = { permission: 'sales.credit.view', fields: ['partyId', 'recordType', 'recordId', 'result'] } as const

export const events = [
  defineEvent({
    type: 'credit_check.recorded',
    context: 'sales-credit',
    description: "A customer's credit with a company was checked at a step (a quote sent, an order made, a work order released, a shipment leaving, a portal or API order, or again by a person): PASS, WARN (shown and let through) or HOLD (held until a yes); an override names the HOLD it lets through.",
    payload: z.strictObject({
      checkId: z.uuid(),
      partyId: z.uuid(),
      step: z.enum(CREDIT_STEPS),
      recordType: z.string(),
      recordId: z.uuid(),
      result: z.enum(CREDIT_RESULTS),
      overridesCheckId: z.uuid().nullable(),
    }),
    live,
  }),
  defineEvent({
    type: 'credit_limit.changed',
    context: 'sales-credit',
    description: "A customer's credit limit with a company was set, changed or cleared (the orders it held were checked again).",
    payload: z.strictObject({ partyId: z.uuid(), termsId: z.uuid(), change: z.enum(['SET', 'CLEARED']), rechecked: z.number().int().min(0) }),
    live: { permission: 'sales.credit.view', fields: ['partyId', 'change'] },
  }),
]
