import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Export and customs (B-W2b-409; LOG-086, LOG-087, LOG-088, LOG-089, LOG-097): make a shipment's commercial invoice and its
 * CN 22 or CN 23, open its export declaration (the pack to the broker or the carrier), record the MRN, name the invoice and
 * confirm the exit with its proof, remove a declaration sent by mistake. Checked with can() against the shipment's company,
 * site and party. Office only. A paper that prints values (the commercial invoice, the CN forms, a pack with them) also asks
 * the price grain (money.price). Reading the Export tab is shipping.view; the company's EORI and a site's broker-pack switch
 * are the shipping settings' (shipping.settings.view | manage). Declared in `auth/permissions/catalogue.ts`.
 */
export const SHIPPING_CUSTOMS_DEFINITIONS = definePermissions('shipping', {
  'customs.manage': {
    risk: 'write',
    description:
      "Do a shipment's export paperwork: make its commercial invoice and CN 22 or CN 23 (their values need the price grain), send the broker or the carrier the data pack, record the MRN, name the invoice and confirm the exit with its proof (art. 8 DPR 633/1972), remove a declaration sent by mistake.",
  },
})

export const SHIPPING_CUSTOMS_MANAGE = 'shipping.customs.manage' satisfies Permission

export const SHIPPING_CUSTOMS_PERMISSIONS: readonly Permission[] = Object.freeze([SHIPPING_CUSTOMS_MANAGE])

/**
 * Who holds it (auth/roles/templates; the owner from every(), the read-only role none: a write): the warehouse (the dispatch
 * desk files the export: the pack, the MRN, the exit proof; it sees no values), sales (the export customer's commercial
 * invoice) and finance (the proof of exit keeps the export VAT-free; the alert tells finance).
 */
export const SHIPPING_CUSTOMS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  warehouse: [SHIPPING_CUSTOMS_MANAGE],
  sales: [SHIPPING_CUSTOMS_MANAGE],
  finance: [SHIPPING_CUSTOMS_MANAGE],
})
