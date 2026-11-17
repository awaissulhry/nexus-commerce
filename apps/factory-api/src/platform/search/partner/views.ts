import type { PartnerKind } from '@nexus/factory-domain/auth/partners/kinds'
import type { PartnerView } from './view'
import complaint from './views/complaint'
// B-TH-103: a customer's requests (the portal's request page and its thread, the Orders group of the portal search).
import inquiry from './views/inquiry'
import ddt from './views/ddt'
import invoice from './views/invoice'
import party from './views/party'
// B-TH-040: a customer's catalogue orders (their thread, the Orders group of the portal search).
import portalOrderRequest from './views/portal-order-request'
import purchaseOrder from './views/purchase-order'
import quote from './views/quote'
import returnAuthorisation from './views/return-authorisation'
import salesOrder from './views/sales-order'
import shipment from './views/shipment'
import subcontractOrder from './views/subcontract-order'
// ---- B-TH-073: a brand's own private-label styles and its sample rounds (their thread, the Samples group of the portal search).
import sampleRound from './views/sample-round'
import style from './views/style'
// ---- end B-TH-073
// ---- B-TH-069: a project of the organisation, to its members only (its thread, the Projects group of the portal search).
import project from './views/project'
// ---- end B-TH-069
// ---- B-TH-081: a customer's repairs (the portal repair page's thread, the Returns group of the portal search).
import repairOrder from './views/repair-order'
// ---- end B-TH-081

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
  // B-W2b-197: a customer's returns and complaints (their Messages tab, the Returns group of the portal search).
  returnAuthorisation,
  complaint,
  // B-TH-103
  inquiry,
  // B-TH-040
  portalOrderRequest,
  // ---- B-TH-073
  style,
  sampleRound,
  // ---- end B-TH-073
  // ---- B-TH-069
  project,
  // ---- end B-TH-069
  // ---- B-TH-081
  repairOrder,
  // ---- end B-TH-081
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
