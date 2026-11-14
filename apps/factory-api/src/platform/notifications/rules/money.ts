import { events as accountingEvents } from '@nexus/factory-domain/accounting/events'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { HOME_VIEW } from '@nexus/factory-domain/insights/permissions'
import { events as invoicingEvents } from '@nexus/factory-domain/invoicing/events'
import { INVOICES_VIEW } from '@nexus/factory-domain/invoicing/permissions'
import { PAYMENTS_BANK_MATCH } from '@nexus/factory-domain/payments/bank/permissions'
import { events as receivablesEvents } from '@nexus/factory-domain/receivables/events'
import { RECEIVABLES_REMINDERS_APPROVE, RECEIVABLES_VIEW } from '@nexus/factory-domain/receivables/permissions'
import type { Draft, FanOutRule, RuleContext } from '../fan-out'

/**
 * Money notifications (B-W2b-403; FIN-169; design finance.settings "Approvals & notifications": "Payment received, SDI
 * rejection, overdue, deposit received, difference"). Payment received and deposit received are B-W2b-402's rules
 * (modules/receivables/notices/rules.ts: payments.received, payments.depositPaid), named here for the settings card; this
 * file adds the other three. Quiet, as every rule: only the people each rule names, never the person who caused it, each
 * while they may see the record and reach Home; no amount (none of these carries one):
 *
 *   money.sdiRejected            invoice.sdi_status_changed into REJECTED: ALERT to who issued the invoice and who follows it
 *                                (invoices.view): "fix it and send it again with the same number and date"
 *   money.overdue                payment_reminder.prepared by the ladder (not by hand: a person made it): SYSTEM to who follows
 *                                the customer and who approves its reminders (receivables.view / receivables.reminders.approve):
 *                                its invoices are overdue and a reminder waits for a yes
 *   money.reconciliationDifference  integrity_checks.ran with a failed payments check (ALLOCATIONS_WITHIN_PAYMENTS,
 *                                PAYMENTS_PLACED): ALERT to who matches the company's bank lines (payments.bank.match)
 * Who hears what is these rules' choice until a settings column keeps the Owner's (the step's schema need).
 */

const payloadOf = <T extends { type: string; payload: { parse(value: unknown): unknown } }>(events: readonly T[], type: string) => events.find((event) => event.type === type)!.payload

/** The payments checks of the nightly run whose failure is a reconciliation difference. */
export const RECONCILIATION_CHECKS = ['ALLOCATIONS_WITHIN_PAYMENTS', 'PAYMENTS_PLACED'] as const

/** The five money notifications, for the settings card (codes; the web words them). */
export const MONEY_NOTIFICATIONS = Object.freeze([
  { code: 'PAYMENT_RECEIVED', rule: 'payments.received', audience: 'CUSTOMER_FOLLOWERS_AND_ORDER_MAKERS' },
  { code: 'SDI_REJECTED', rule: 'money.sdiRejected', audience: 'ISSUER_AND_FOLLOWERS' },
  { code: 'OVERDUE', rule: 'money.overdue', audience: 'CUSTOMER_FOLLOWERS_AND_REMINDER_APPROVERS' },
  { code: 'DEPOSIT_RECEIVED', rule: 'payments.depositPaid', audience: 'ORDER_MAKER_AND_RELEASERS' },
  { code: 'RECONCILIATION_DIFFERENCE', rule: 'money.reconciliationDifference', audience: 'BANK_MATCHERS' },
] as const)

export const MONEY_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'money.sdiRejected',
    events: ['invoice.sdi_status_changed'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf(invoicingEvents, 'invoice.sdi_status_changed').parse(raw) as { invoiceId: string; invoiceStatus: string; previousStatus: string }
      if (payload.invoiceStatus !== 'REJECTED' || payload.previousStatus === 'REJECTED') return []
      const invoice = await context.tx.invoice.findUnique({ where: { id: payload.invoiceId }, select: { id: true, number: true, companyId: true, partyId: true, issuedById: true, createdById: true, status: true } })
      if (!invoice || invoice.status !== 'REJECTED') return []
      const followers = await context.tx.recordFollower.findMany({ where: { recordType: 'Invoice', recordId: invoice.id, muted: false }, select: { userId: true } })
      const people = [...new Set([invoice.issuedById ?? invoice.createdById, ...followers.map((row) => row.userId)].filter((id): id is string => id !== null))]
      const drafts: Draft[] = []
      for (const userId of people) {
        const reader = await context.reader(userId)
        if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, INVOICES_VIEW, { companyId: invoice.companyId, partyId: invoice.partyId })) continue
        drafts.push({ userId, category: 'ALERT', record: { type: 'Invoice', id: invoice.id, label: invoice.number ?? invoice.id }, companyId: invoice.companyId, anchor: 'sdi', messageKey: 'notifications.money.sdiRejected', params: { invoiceId: invoice.id }, actorId: null })
      }
      return drafts
    },
  },
  {
    name: 'money.overdue',
    events: ['payment_reminder.prepared'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf(receivablesEvents, 'payment_reminder.prepared').parse(raw) as { reminderId: string; partyId: string; level: number; invoices: number; byHand: boolean }
      if (payload.byHand) return []
      const reminder = await context.tx.paymentReminder.findUnique({ where: { id: payload.reminderId }, select: { id: true, companyId: true, partyId: true, status: true } })
      if (!reminder || reminder.status !== 'PREPARED') return []
      const party = await context.tx.party.findUnique({ where: { id: reminder.partyId }, select: { legalName: true } })
      const followers = new Set((await context.tx.recordFollower.findMany({ where: { recordType: 'Party', recordId: reminder.partyId, muted: false }, select: { userId: true } })).map((row) => row.userId))
      const scope = { companyId: reminder.companyId, partyId: reminder.partyId }
      const drafts: Draft[] = []
      for (const userId of await context.people()) {
        const reader = await context.reader(userId)
        if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, RECEIVABLES_VIEW, scope)) continue
        if (!followers.has(userId) && !can(reader.actor, RECEIVABLES_REMINDERS_APPROVE, scope)) continue
        drafts.push({ userId, category: 'SYSTEM', record: { type: 'Party', id: reminder.partyId, label: party?.legalName ?? reminder.partyId }, companyId: reminder.companyId, anchor: `reminder:${reminder.id}`, messageKey: 'notifications.money.overdue', params: { reminderId: reminder.id, count: payload.invoices }, actorId: null })
      }
      return drafts
    },
  },
  {
    name: 'money.reconciliationDifference',
    events: ['integrity_checks.ran'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = payloadOf(accountingEvents, 'integrity_checks.ran').parse(raw) as { companyId: string; ranAt: string; failed: string[] }
      const failed = payload.failed.filter((code) => (RECONCILIATION_CHECKS as readonly string[]).includes(code))
      if (failed.length === 0) return []
      const company = await context.tx.company.findUnique({ where: { id: payload.companyId }, select: { id: true, legalName: true } })
      if (!company) return []
      const drafts: Draft[] = []
      for (const userId of await context.people()) {
        const reader = await context.reader(userId)
        if (!reader || !holds(reader.actor, HOME_VIEW) || !can(reader.actor, PAYMENTS_BANK_MATCH, { companyId: company.id })) continue
        drafts.push({ userId, category: 'ALERT', record: { type: 'Company', id: company.id, label: company.legalName }, companyId: company.id, anchor: `integrity:${payload.ranAt}`, messageKey: 'notifications.money.reconciliationDifference', params: { count: failed.length }, actorId: null })
      }
      return drafts
    },
  },
])
