import { z } from 'zod'
import { defineEvent } from '../events/define'
import { BANK_SOURCES } from '../purchasing/bank/rules'
import { QUALIFICATION_STATUSES } from '../purchasing/qualification/rules'

/**
 * Supplier qualification and bank details (B-W2b-315; the code is factory-domain purchasing/{bank,qualification}). A module
 * folder of its own, as suppliers-depth (the event guard wants `src/<module>/events.ts`). apps/factory-api's
 * modules/purchasing/{bank,qualification} and portal-profile/bank.ts emit them in the command that makes the change.
 *
 *   supplier_bank_account.proposed      a new account was proposed (in the office or in the supplier's portal)
 *   supplier_bank_account.called_back   the supplier was called back on a number we had on file
 *   supplier_bank_account.activated     a second person checked it: payments use it now (the old one retired)
 *   supplier_bank_account.refused       a change was refused
 *   supplier_bank_account.retired       an account payments used was retired (closed)
 *   supplier_qualification.changed      a qualification was asked, changed, decided, suspended, lifted or withdrawn
 *   purchase_order.compliance_override_asked | _decided | _withdrawn
 *                                       a request to send an order without a valid document, its yes or no, taken back
 *
 * Ids, codes and states only: never an IBAN (not even masked), a holder, a phone, a reason or a person's words. The bank
 * events go live to purchasing.bank.view (finance), the qualifications to parties.view, the overrides to purchasing.view.
 */
export const events = [
  defineEvent({
    type: 'supplier_bank_account.proposed',
    context: 'supplier-qualification',
    description: "A supplier's new bank account was proposed (by the office or in the supplier's portal); payments keep using the old one until a call-back and a second check.",
    payload: z.strictObject({ accountId: z.uuid(), partyId: z.uuid(), source: z.enum(BANK_SOURCES), currency: z.string().length(3) }),
    live: { permission: 'purchasing.bank.view', fields: ['accountId', 'partyId', 'source'] },
  }),
  defineEvent({
    type: 'supplier_bank_account.called_back',
    context: 'supplier-qualification',
    description: 'The supplier was called back on a number we had on file before its bank change; the change waits for the second check.',
    payload: z.strictObject({ accountId: z.uuid(), partyId: z.uuid(), approvalTaskId: z.uuid().nullable() }),
    live: { permission: 'purchasing.bank.view', fields: ['accountId', 'partyId'] },
  }),
  defineEvent({
    type: 'supplier_bank_account.activated',
    context: 'supplier-qualification',
    description: "A second person checked a supplier's called-back bank change: payments use it now and the account it replaces is retired.",
    payload: z.strictObject({ accountId: z.uuid(), partyId: z.uuid(), currency: z.string().length(3), retiredAccountId: z.uuid().nullable(), approvalTaskId: z.uuid().nullable() }),
    live: { permission: 'purchasing.bank.view', fields: ['accountId', 'partyId'] },
  }),
  defineEvent({
    type: 'supplier_bank_account.refused',
    context: 'supplier-qualification',
    description: "A supplier's bank change was refused (with why): payments stay on the account they use.",
    payload: z.strictObject({ accountId: z.uuid(), partyId: z.uuid() }),
    live: { permission: 'purchasing.bank.view', fields: ['accountId', 'partyId'] },
  }),
  defineEvent({
    type: 'supplier_bank_account.retired',
    context: 'supplier-qualification',
    description: "A supplier's bank account payments used was retired (closed): payments to it in that currency are held until another one is active.",
    payload: z.strictObject({ accountId: z.uuid(), partyId: z.uuid() }),
    live: { permission: 'purchasing.bank.view', fields: ['accountId', 'partyId'] },
  }),
  defineEvent({
    type: 'supplier_qualification.changed',
    context: 'supplier-qualification',
    description: 'A supplier or workshop qualification was asked, changed, decided, suspended, lifted or withdrawn.',
    payload: z.strictObject({ qualificationId: z.uuid(), partyId: z.uuid(), status: z.enum(QUALIFICATION_STATUSES), change: z.enum(['CREATED', 'UPDATED', 'DECIDED', 'SUSPENDED', 'LIFTED', 'WITHDRAWN']) }),
    live: { permission: 'parties.view', fields: ['qualificationId', 'partyId', 'status'] },
  }),
  defineEvent({
    type: 'purchase_order.compliance_override_asked',
    context: 'supplier-qualification',
    description: 'Someone asked to send a purchase order without a valid document it needs; a second person decides.',
    payload: z.strictObject({ purchaseOrderId: z.uuid(), number: z.string(), partyId: z.uuid(), held: z.number().int().min(1) }),
    live: { permission: 'purchasing.view', fields: ['purchaseOrderId', 'number'] },
  }),
  defineEvent({
    type: 'purchase_order.compliance_override_decided',
    context: 'supplier-qualification',
    description: 'A second person said yes or no to sending a purchase order without a valid document.',
    payload: z.strictObject({ purchaseOrderId: z.uuid(), number: z.string(), partyId: z.uuid(), decision: z.enum(['APPROVED', 'REJECTED']) }),
    live: { permission: 'purchasing.view', fields: ['purchaseOrderId', 'number', 'decision'] },
  }),
  defineEvent({
    type: 'purchase_order.compliance_override_withdrawn',
    context: 'supplier-qualification',
    description: 'A request to send a purchase order without a valid document was taken back.',
    payload: z.strictObject({ purchaseOrderId: z.uuid(), number: z.string(), partyId: z.uuid() }),
    live: { permission: 'purchasing.view', fields: ['purchaseOrderId', 'number'] },
  }),
] as const
