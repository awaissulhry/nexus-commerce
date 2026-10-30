import { definePermissions } from '../auth/permissions/registry'
import type { Permission } from '../core/permissions'

/**
 * Receivables (apps/factory-api modules/receivables; B-W2a-55; FIN-109 customer ledger and statement, FIN-110 ageing,
 * FIN-111 the reminder ladder; design finance.receivables, SCR-151). Area `receivables`. Checked with can() against the
 * company owed AND the customer; office only (the floor, portal and link sessions read none of it). Every amount also
 * needs the price grain (money.price): without it the amounts are not sent and a reminder's text (which names them) is
 * not shown.
 *
 *   view               the ageing, a customer's ledger and statement (and its PDF), the reminders, the settings
 *   reminders.manage   prepare a reminder by hand, edit its text while it waits, skip it with a reason, cancel it
 *   reminders.approve  approve a reminder (a person, never the ladder) and send it: an e-mail, a letter, a call; nothing
 *                      reaches a customer while the company's reminders are switched off
 *   statements.send    e-mail a customer its statement (the PDF on the customer's record, shared with it)
 *   settings.manage    the reminder ladder, the minimum amount, and the late-payment rule as the accountant decided it
 *                      (D.Lgs. 231/2002)
 *   reminders.switch   the Owner's switch: reminders may reach the company's customers (step-up; turned on after the
 *                      go-live, W2a plan §2; refused while the late-payment rule is UNDECIDED)
 */
export const RECEIVABLES_DEFINITIONS = definePermissions('receivables', {
  view: {
    risk: 'read',
    description: "See what customers owe and how late (ageing), each customer's ledger and statement, the payment reminders and the reminder settings (amounts only with the price grain).",
  },
  'reminders.manage': {
    risk: 'write',
    description: 'Prepare a payment reminder by hand, edit its text while it waits for approval, skip it with a reason, or cancel it.',
  },
  'reminders.approve': {
    risk: 'write',
    description: "Approve a payment reminder and send it (e-mail, letter or call); nothing is sent while the company's reminders are switched off.",
  },
  'statements.send': {
    risk: 'write',
    description: 'E-mail a customer its statement of account as a PDF.',
  },
  'settings.manage': {
    risk: 'write',
    description: 'Change the reminder ladder, the minimum amount reminded and the late-payment interest rule the accountant decided.',
  },
  'reminders.switch': {
    risk: 'stepUp',
    description: "Switch a company's payment reminders on or off: while off, no reminder reaches a customer (on only once the late-payment rule is decided).",
  },
})

export const RECEIVABLES_VIEW = 'receivables.view' satisfies Permission
export const RECEIVABLES_REMINDERS_MANAGE = 'receivables.reminders.manage' satisfies Permission
export const RECEIVABLES_REMINDERS_APPROVE = 'receivables.reminders.approve' satisfies Permission
export const RECEIVABLES_STATEMENTS_SEND = 'receivables.statements.send' satisfies Permission
export const RECEIVABLES_SETTINGS_MANAGE = 'receivables.settings.manage' satisfies Permission
export const RECEIVABLES_REMINDERS_SWITCH = 'receivables.reminders.switch' satisfies Permission

export const RECEIVABLES_PERMISSIONS: readonly Permission[] = Object.freeze([
  RECEIVABLES_VIEW,
  RECEIVABLES_REMINDERS_MANAGE,
  RECEIVABLES_REMINDERS_APPROVE,
  RECEIVABLES_STATEMENTS_SEND,
  RECEIVABLES_SETTINGS_MANAGE,
  RECEIVABLES_REMINDERS_SWITCH,
])
