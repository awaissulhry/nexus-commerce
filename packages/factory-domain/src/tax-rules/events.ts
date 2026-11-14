import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The events of tax rules as data (B-W2b-392; FIN-100, FIN-101, FIN-107; apps/factory-api modules/invoicing/{tax-codes,
 * intent,stamp-duty}). Context `tax-rules`, its own module folder (the invoicing events file is W1's). They reach the
 * office screens that read invoices (invoices.view). No amount, no person, no words: ids, codes and actions.
 *
 *   tax_code.changed               a company's tax code version was made, changed, ended, versioned, archived, deleted or
 *                                  confirmed by the accountant
 *   tax_settings.changed           a company's tax switches changed (GATE-ACCOUNTANT)
 *   declaration_of_intent.changed  a customer's declaration of intent was recorded, checked, revoked, used by an invoice's
 *                                  issue or given back by a credit note's
 *   stamp_duty_quarter.changed     a company's stamp duty quarter was recounted or paid
 */
export const TAX_CODE_ACTIONS = ['CREATED', 'EDITED', 'ENDED', 'VERSIONED', 'ARCHIVED', 'DELETED', 'CONFIRMED'] as const
export const DECLARATION_ACTIONS = ['CREATED', 'CHECKED', 'REVOKED', 'USED', 'RETURNED'] as const
export const QUARTER_ACTIONS = ['RECOUNTED', 'PAID'] as const

export const events = [
  defineEvent({
    type: 'tax_code.changed',
    context: 'tax-rules',
    description: "A company's tax code version was made, changed, ended, replaced by a new version, archived, deleted before its first day, or confirmed by the accountant.",
    payload: z.strictObject({ taxCodeId: z.uuid(), country: z.string(), code: z.string(), action: z.enum(TAX_CODE_ACTIONS) }),
    live: { permission: 'invoices.view', fields: ['taxCodeId', 'country', 'code', 'action'] },
  }),
  defineEvent({
    type: 'tax_settings.changed',
    context: 'tax-rules',
    description: "A company's tax switches changed (its tax codes on invoices, stamp duty charged to the customer, declarations of intent): each stays off until the accountant confirms.",
    payload: z.strictObject({ companyId: z.uuid(), taxCodesOn: z.boolean(), stampDutyOn: z.boolean(), declarationsOfIntentOn: z.boolean() }),
    live: { permission: 'invoices.view', fields: ['companyId', 'taxCodesOn', 'stampDutyOn', 'declarationsOfIntentOn'] },
  }),
  defineEvent({
    type: 'declaration_of_intent.changed',
    context: 'tax-rules',
    description: "A customer's declaration of intent was recorded, checked on the tax agency's site, revoked, used by an invoice's issue, or given back by a credit note's.",
    payload: z.strictObject({ declarationId: z.uuid(), partyId: z.uuid(), action: z.enum(DECLARATION_ACTIONS), invoiceId: z.uuid().nullable() }),
    live: { permission: 'invoices.view', fields: ['declarationId', 'partyId', 'action', 'invoiceId'] },
  }),
  defineEvent({
    type: 'stamp_duty_quarter.changed',
    context: 'tax-rules',
    description: "A company's stamp duty quarter was recounted from its issued invoices, or its payment was recorded (then it is frozen).",
    payload: z.strictObject({ quarterId: z.uuid(), quarterStart: z.string(), action: z.enum(QUARTER_ACTIONS), invoiceCount: z.number().int().min(0) }),
    live: { permission: 'invoices.view', fields: ['quarterId', 'quarterStart', 'action', 'invoiceCount'] },
  }),
] as const
