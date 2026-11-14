import { z } from 'zod'
import { defineEvent } from '../events/define'
import { BANK_FORMATS } from '../payments/bank-formats/statement'
import { WRITE_OFF_KINDS } from '../payments/write-offs/write-offs'

/**
 * The events of bank statements, matching and write-offs (B-W2b-393; FIN-130, FIN-132, FIN-117, FIN-119; apps/factory-api
 * modules/payments/{bank,matching,write-offs}). Context `payments-bank`, its own module folder (the payments events file is
 * W1's). Payloads carry ids, codes and counts: never an amount, a name, an IBAN or a reference text (a screen refetches
 * what it shows, with its grain).
 *
 *   bank_statement.imported      a statement file's new lines were imported into a company's account
 *   bank_line.suggestions_changed the suggested matches of some lines changed (an import, a payment recorded or placed,
 *                                 an invoice issued, an acceptance elsewhere): the match screen re-reads them
 *   bank_match.accepted          a person accepted a match of a bank line (a suggestion, or their own choice): money in
 *                                 recorded and placed its payment (or is the payment typed by hand); money out names the
 *                                 supplier invoice it paid
 *   bank_match.reversed          a wrong acceptance was taken back (the payment it recorded voided first)
 *   payment.written_off          a payment's small difference was written off within the company's tolerance
 *   payment.write_off_reversed   a write-off was taken back
 *   write_off_tolerance.changed  the write-off tolerance of a company (or of every company) changed
 */
const bankLive = { permission: 'payments.bank.view' } as const

export const events = [
  defineEvent({
    type: 'bank_statement.imported',
    context: 'payments-bank',
    description: "A bank statement file's new lines were imported into one of the company's accounts (a line imported before was refused).",
    payload: z.strictObject({ statementId: z.uuid(), bankAccountId: z.uuid(), format: z.enum(BANK_FORMATS), lines: z.number().int().min(1), duplicates: z.number().int().min(0), skipped: z.number().int().min(0) }),
    live: { ...bankLive, fields: ['statementId', 'bankAccountId', 'lines'] },
  }),
  defineEvent({
    type: 'bank_line.suggestions_changed',
    context: 'payments-bank',
    description: 'The suggested matches of some bank lines of a company changed.',
    payload: z.strictObject({ bankLineIds: z.array(z.uuid()).min(1).max(500), added: z.number().int().min(0), removed: z.number().int().min(0) }),
    live: { ...bankLive, fields: ['added', 'removed'] },
  }),
  defineEvent({
    type: 'bank_match.accepted',
    context: 'payments-bank',
    description: 'A person accepted a match of a bank line: money in recorded and placed its payment (or is a payment typed by hand), money out names the supplier invoice it paid.',
    payload: z.strictObject({ matchId: z.uuid(), bankLineId: z.uuid(), partyId: z.uuid(), paymentId: z.uuid().nullable(), supplierInvoiceId: z.uuid().nullable(), recorded: z.boolean(), chosenByPerson: z.boolean() }),
    live: { ...bankLive, fields: ['matchId', 'bankLineId', 'paymentId'] },
  }),
  defineEvent({
    type: 'bank_match.reversed',
    context: 'payments-bank',
    description: 'A wrong acceptance of a bank line was taken back (the payment it recorded was voided first); the line is to match again.',
    payload: z.strictObject({ matchId: z.uuid(), bankLineId: z.uuid(), partyId: z.uuid(), paymentId: z.uuid().nullable(), voided: z.boolean() }),
    live: { ...bankLive, fields: ['matchId', 'bankLineId', 'paymentId'] },
  }),
  defineEvent({
    type: 'payment.written_off',
    context: 'payments-bank',
    description: "A payment's small difference was written off within the company's tolerance (the customer paid a little less on an invoice, or a little more).",
    payload: z.strictObject({ writeOffId: z.uuid(), paymentId: z.uuid(), partyId: z.uuid(), kind: z.enum(WRITE_OFF_KINDS), invoiceId: z.uuid().nullable() }),
    live: { permission: 'payments.view', fields: ['writeOffId', 'paymentId', 'kind'] },
  }),
  defineEvent({
    type: 'payment.write_off_reversed',
    context: 'payments-bank',
    description: 'A write-off of a payment was taken back (a reversal row with a note).',
    payload: z.strictObject({ writeOffId: z.uuid(), reversalOfId: z.uuid(), paymentId: z.uuid(), partyId: z.uuid(), kind: z.enum(WRITE_OFF_KINDS) }),
    live: { permission: 'payments.view', fields: ['writeOffId', 'paymentId', 'kind'] },
  }),
  defineEvent({
    type: 'write_off_tolerance.changed',
    context: 'payments-bank',
    description: 'The write-off tolerance of a company, or of every company, changed (none: nothing is written off).',
    payload: z.strictObject({ settingsId: z.uuid(), companyId: z.uuid().nullable(), set: z.boolean() }),
    live: { permission: 'receivables.view', fields: ['settingsId', 'companyId', 'set'] },
  }),
] as const
