import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * The proforma invoice (B-W2b-391; LOG-058): make one for a shipment going abroad (customs), a sample shipment or a deposit
 * request, and read a record's proformas. Checked with can() against the record's company (and its party). Office only. A
 * proforma prints prices, so every route also asks the price grain (money.price): a holder without it is refused. Declared
 * in `auth/permissions/catalogue.ts`.
 */
export const SHIPPING_PROFORMA_DEFINITIONS = definePermissions('shipping', {
  'proforma.issue': {
    risk: 'write',
    description:
      "Make a proforma invoice, a non-fiscal document with its own PF number, for a shipment going abroad (customs), a sample shipment or a deposit request (a payment asked in advance), and read a record's proformas. Its prices need the price grain.",
  },
})

export const SHIPPING_PROFORMA_ISSUE = 'shipping.proforma.issue' satisfies Permission

export const SHIPPING_PROFORMA_PERMISSIONS: readonly Permission[] = Object.freeze([SHIPPING_PROFORMA_ISSUE])

/**
 * Who holds it (auth/roles/templates; the owner from every(), the read-only role none: a write): finance (payment requests,
 * the export customer's papers), the office role that sees prices. The warehouse sees no prices: a shipment's pack prints a
 * proforma only for someone who does. B-CP-011 (step 5, lead pick): no longer sales — it sees no price since B-CP-011, so the
 * right was dead (every proforma route also asks the price grain).
 */
export const SHIPPING_PROFORMA_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  finance: [SHIPPING_PROFORMA_ISSUE],
})
