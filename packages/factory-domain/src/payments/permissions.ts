import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * The payments module's permissions (apps/factory-api modules/payments; features FIN-121, FIN-066; Q12; A2 SCR-082).
 * Each is checked with can() against the payment's company AND its party. Amounts travel only with money.price.
 *
 *   view    the payments list and record, and what each pays (its allocations)
 *   record  record a bank transfer received, allocate it to deposit requests and issued invoices, take an allocation
 *           back (a reversal row); "deposit received" also marks the request PAID (issuing its TD02 needs invoices.issue)
 *   void    void a payment typed by mistake, once its allocations are all reversed
 */
export const PAYMENTS_DEFINITIONS = definePermissions('payments', {
  view: { risk: 'read', description: 'See the payments received and what each one pays.' },
  record: { risk: 'write', description: 'Record a bank transfer received, allocate it to deposit requests and invoices, and reverse an allocation.' },
  void: { risk: 'write', description: 'Void a payment typed by mistake, once its allocations are all reversed.' },
})

export const PAYMENTS_VIEW = 'payments.view' satisfies Permission
export const PAYMENTS_RECORD = 'payments.record' satisfies Permission
export const PAYMENTS_VOID = 'payments.void' satisfies Permission
export const PAYMENTS_PERMISSIONS: readonly Permission[] = Object.freeze([PAYMENTS_VIEW, PAYMENTS_RECORD, PAYMENTS_VOID])
