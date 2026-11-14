import { z } from 'zod'
import { defineEvent } from '../events/define'
import { PROPOSAL_STATUSES } from '../payables/proposal/rules'

/**
 * The events of payables in depth (B-W2b-403; FIN-140, FIN-142; apps/factory-api modules/payables/{proposal,approve.ts}).
 * Context `payables-depth`, its own module folder (the payables events file is W2a's). Ids, states, codes and counts only:
 * never an amount, an IBAN or a name (a screen refetches what it shows, with its grain).
 *
 *   supplier_invoice.first_approved   an invoice above the amount got its first yes: a second person approves it
 *   payment_proposal.changed          a payment proposal was made, its lines changed, approved once or for good, sent back
 *                                     to draft, cancelled or recorded paid (`change`); `held`: its lines without a verified
 *                                     bank account; `remitted`: the remittance advices it e-mailed (paid only)
 */
export const PROPOSAL_CHANGES = ['CREATED', 'LINES_CHANGED', 'FIRST_APPROVED', 'APPROVED', 'SENT_BACK', 'CANCELLED', 'PAID'] as const

const count = z.number().int().min(0)

export const events = [
  defineEvent({
    type: 'supplier_invoice.first_approved',
    context: 'payables-depth',
    description: 'A supplier invoice above the amount got its first approval: a second person approves it.',
    payload: z.strictObject({ supplierInvoiceId: z.uuid(), partyId: z.uuid(), status: z.enum(['RECEIVED', 'APPROVED', 'PAID', 'DISPUTED', 'VOIDED']), matchStatus: z.enum(['PENDING', 'MATCHED', 'DIFFERENCES', 'NO_PO', 'WAITING_GOODS']) }),
    live: { permission: 'payables.view', fields: ['supplierInvoiceId', 'partyId', 'status'] },
  }),
  defineEvent({
    type: 'payment_proposal.changed',
    context: 'payables-depth',
    description: "A week's payment proposal was made, changed, approved, sent back, cancelled or recorded paid.",
    payload: z.strictObject({ proposalId: z.uuid(), companyId: z.uuid(), weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), status: z.enum(PROPOSAL_STATUSES), change: z.enum(PROPOSAL_CHANGES), lines: count, held: count, remitted: count }),
    live: { permission: 'payables.view', fields: ['proposalId', 'companyId', 'status', 'change'] },
  }),
] as const
