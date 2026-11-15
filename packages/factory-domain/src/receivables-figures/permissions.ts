import { definePermissions } from '../auth/permissions/registry'
import type { Permission } from '../core/permissions'

/**
 * A customer's own figures against ours (B-W2b-406; FIN-135; apps/factory-api modules/receivables/their-figures; design
 * finance.bank sec:customer-figures). Checked with can() against the company AND the customer, office only. Reading rides on
 * receivables.view; every figure is a price (money.price): without it the amounts are not sent, and typing them is refused.
 * Declared in `auth/permissions/catalogue.ts`.
 *
 *   theirFigures.manage   type what a customer's statement says as of a day (per order, its payments, its balance), keep
 *                         the statement's file with it, and correct a typing mistake (never deleted)
 */
export const THEIR_FIGURES_DEFINITIONS = definePermissions('receivables', {
  'theirFigures.manage': {
    risk: 'write',
    description: "Record what a customer's own statement says (per order, its payments and its balance) to compare it with our books, and correct a typing mistake.",
  },
})

export const RECEIVABLES_THEIR_FIGURES_MANAGE = 'receivables.theirFigures.manage' satisfies Permission

export const THEIR_FIGURES_PERMISSIONS: readonly Permission[] = Object.freeze([RECEIVABLES_THEIR_FIGURES_MANAGE])

/** Who gets it (auth/roles/templates; the owner from every()): finance, who reconciles with customers. */
export const THEIR_FIGURES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [RECEIVABLES_THEIR_FIGURES_MANAGE],
})
