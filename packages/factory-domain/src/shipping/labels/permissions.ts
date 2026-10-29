import { definePermissions } from '../../auth/permissions/registry'
import type { Permission } from '../../core/permissions'

/**
 * Carrier labels' permissions (B-W1-48; LOG-025, LOG-032): buying and voiding, each checked with can() against the
 * shipment's company, site and party. Buying SPENDS the company's money (Sendcloud charges each label to the company's
 * own account): a write the office does, never a floor device (packers print labels with shipping.pack and print.labels;
 * the gateway refuses floor callers anyway). Not step-up: the warehouse buys while the driver waits and holds no
 * two-factor. Reading tracking is shipping.view. Declared in `auth/permissions/catalogue.ts`.
 */
export const SHIPPING_LABELS_DEFINITIONS = definePermissions('shipping', {
  'labels.buy': {
    risk: 'write',
    description: "Buy the carrier labels of a packed shipment that has its DDT, through the company's Sendcloud account: each label is charged to the company.",
  },
  'labels.void': { risk: 'write', description: 'Void a carrier label before the goods leave (Sendcloud cancels it), so the parcel can change again.' },
})

export const SHIPPING_LABELS_BUY = 'shipping.labels.buy' satisfies Permission
export const SHIPPING_LABELS_VOID = 'shipping.labels.void' satisfies Permission

export const SHIPPING_LABELS_PERMISSIONS: readonly Permission[] = Object.freeze([SHIPPING_LABELS_BUY, SHIPPING_LABELS_VOID])
