import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'
import { PAYMENTS_BANK_PERMISSIONS } from '../bank/permissions'

/**
 * Writing off a small difference (B-W2b-393; FIN-119; apps/factory-api modules/payments/write-offs): checked with can()
 * against the payment's company AND its party, amounts only with money.price. Setting the tolerance itself is the
 * receivables settings' (receivables.settings.manage). Declared in `auth/permissions/catalogue.ts`.
 */
export const WRITE_OFF_DEFINITIONS = definePermissions('payments', {
  writeOff: { risk: 'write', description: "Write off a payment's small difference (a little less or a little more than the invoices) within the company's tolerance, and take a write-off back." },
})

export const PAYMENTS_WRITE_OFF = 'payments.writeOff' satisfies Permission
export const WRITE_OFF_PERMISSIONS: readonly Permission[] = Object.freeze([PAYMENTS_WRITE_OFF])

/**
 * Who works the bank (auth/roles/templates; the owner from every(), the read-only role the view through the registry):
 * finance imports statements, matches lines and writes off small differences.
 */
export const PAYMENTS_BANK_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [...PAYMENTS_BANK_PERMISSIONS, PAYMENTS_WRITE_OFF],
})
