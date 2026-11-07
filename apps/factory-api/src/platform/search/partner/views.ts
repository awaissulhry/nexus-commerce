import type { PartnerKind } from '@nexus/factory-domain/auth/partners/kinds'
import type { PartnerView } from './view'
import ddt from './views/ddt'
import invoice from './views/invoice'
import party from './views/party'
import purchaseOrder from './views/purchase-order'
import quote from './views/quote'
import salesOrder from './views/sales-order'
import shipment from './views/shipment'
import subcontractOrder from './views/subcontract-order'

/**
 * The partner views (./view.ts) of the records a partner may open: the portal's search finds them, the portal's record
 * thread opens on them (B-W2b-168). The record types the partner role can read today; a returns or claims view joins
 * with the step that gives the partner role its read (one file in ./views/ and one line here: a merge point).
 */
export const PARTNER_VIEWS: readonly PartnerView[] = Object.freeze([
  salesOrder,
  quote,
  shipment,
  invoice,
  ddt,
  purchaseOrder,
  subcontractOrder,
  party,
])

const byType = new Map<string, PartnerView>()
for (const view of PARTNER_VIEWS) {
  if (byType.has(view.recordType)) throw new Error(`Two partner views of ${view.recordType}`)
  byType.set(view.recordType, view)
}

/** The partner view of a record type, or undefined: no partner may open that type. */
export function partnerViewOf(recordType: string): PartnerView | undefined {
  return byType.get(recordType)
}

/** Whether a partner of these kinds may open records of this view. */
export const viewFits = (view: PartnerView, kinds: readonly PartnerKind[]): boolean => view.kinds.some((kind) => kinds.includes(kind))
