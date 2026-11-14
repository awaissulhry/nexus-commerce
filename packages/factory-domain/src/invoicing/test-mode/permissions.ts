import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * E-invoice test mode (B-W2b-401; FIN-096; apps/factory-api modules/invoicing/test-mode). Checked with can() against the
 * company. Reading where a company stands (test mode or live, the simulated answer, our own copies) is invoices.view.
 * Declared in `auth/permissions/catalogue.ts`.
 *
 *   testMode.manage  leave a company's e-invoice test mode (go live: invoices go to SDI for real) or go back to it, and pick
 *                    the answer test mode simulates. Step-up: going live cannot be taken back for what was sent
 */
export const TEST_MODE_DEFINITIONS = definePermissions('invoices', {
  'testMode.manage': {
    risk: 'stepUp',
    description: "Leave a company's e-invoice test mode (from then on invoices go to SDI for real and cannot be taken back) or go back to it, and pick the answer test mode simulates (delivered, rejected, not deliverable).",
  },
})

export const INVOICES_TEST_MODE_MANAGE = 'invoices.testMode.manage' satisfies Permission

export const TEST_MODE_PERMISSIONS: readonly Permission[] = Object.freeze([INVOICES_TEST_MODE_MANAGE])

/** Who holds it (auth/roles/templates; the owner from every(), the read-only role none): finance. */
export const TEST_MODE_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [INVOICES_TEST_MODE_MANAGE],
})
