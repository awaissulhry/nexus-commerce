import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Invoicing in depth (B-W2b-396; FIN-080; apps/factory-api modules/invoicing/cancellation). Checked with can() against the
 * company. Reading the rules and an order's outcome needs invoices.view; making the credit notes of a cancelled order's
 * deposits is invoices.manage (drafts, issued by invoices.issue with step-up). The monthly run, the invoice's language and
 * rate, fees and a sample round's charge use the invoices permissions as they are. Declared in
 * `auth/permissions/catalogue.ts`.
 *
 *   depositRules.manage  keep the company's rules for the deposit when an order is cancelled (what is kept or paid back,
 *                        for which kind of deposit, side and order, and the document that follows); archive one
 */
export const DEPOSIT_RULES_DEFINITIONS = definePermissions('invoices', {
  'depositRules.manage': {
    risk: 'write',
    description: "Keep the company's rules for the deposit when an order is cancelled: what is kept or paid back for each kind of deposit, who cancels and which orders, and the document that follows.",
  },
})

export const INVOICES_DEPOSIT_RULES_MANAGE = 'invoices.depositRules.manage' satisfies Permission

export const DEPOSIT_RULES_PERMISSIONS: readonly Permission[] = Object.freeze([INVOICES_DEPOSIT_RULES_MANAGE])

/** Who holds it (auth/roles/templates; the owner from every(), the read-only role none: a write): finance. */
export const DEPOSIT_RULES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [INVOICES_DEPOSIT_RULES_MANAGE],
})
