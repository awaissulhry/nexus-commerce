import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Shipping every day (B-W2a-48; LOG-105, LOG-090): the freight charged to the customer and the intra-EU transport
 * evidence, each checked with can() against the shipment's company, site and party (a site's freight rule: the site's
 * company and the site). Office only. The freight figures are prices: the routes mark them money.price, so a person
 * without the price grain neither reads nor sends one (the warehouse sees no money). The evidence carries no money: the
 * warehouse files the carrier's papers, finance says when they are enough. Declared in `auth/permissions/catalogue.ts`.
 */
export const SHIPPING_DAILY_DEFINITIONS = definePermissions('shipping', {
  'freight.manage': {
    risk: 'write',
    description: "Set a site's freight rule (none, per shipment or per parcel, free from an order value) and change the freight charged to the customer on a shipment until it is cancelled; the amounts need the price grain.",
  },
  'evidence.manage': {
    risk: 'write',
    description:
      "Keep a shipment's intra-EU transport evidence (art. 41 DL 331/1993): add the proof of delivery, CMR and carrier's invoice, say whether the shipment needs it, mark it complete when the papers are enough, or reopen it.",
  },
})

export const SHIPPING_FREIGHT_MANAGE = 'shipping.freight.manage' satisfies Permission
export const SHIPPING_EVIDENCE_MANAGE = 'shipping.evidence.manage' satisfies Permission

export const SHIPPING_DAILY_PERMISSIONS: readonly Permission[] = Object.freeze([SHIPPING_FREIGHT_MANAGE, SHIPPING_EVIDENCE_MANAGE])
