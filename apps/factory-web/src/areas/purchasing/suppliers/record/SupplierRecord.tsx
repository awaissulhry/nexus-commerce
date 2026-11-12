'use client'

import { PartyRecord } from '../../../parties/_shared/PartyRecord'
import { PortalAccess } from '../../../sales/customers/portal/PortalAccess'
import { ApprovedSources } from '../sources/ApprovedSources'
// B-W2b-172: the supplier questionnaire (`?tab=questionnaire`).
import { Questionnaire } from '../questionnaire/Questionnaire'
// B-W2b-334: the supplier in depth (kinds, status, origin, closures, what each contact receives, Documents & qualification,
// Quality & rating, Bank details).
import { SupplierDepthProvider, supplierDepthSlot } from '../depth/SupplierDepth'

/**
 * `/w/<company>/purchasing/suppliers/<id>` (SCR-057): the shared party record (areas/parties/_shared) on the buying side,
 * with Purchasing's own Items & prices tab (`?tab=items`: the supplier's approved sources, B-W2a-69) in its slot, and its
 * W2b parts (B-W2b-334, `?tab=documents|quality|bank` and the Overview's and Contacts' cards) in the depth slot.
 */
export function SupplierRecord({ partyId }: { partyId: string }) {
  return (
    <SupplierDepthProvider partyId={partyId}>
      <PartyRecord
        side="suppliers"
        partyId={partyId}
        items={(party) => <ApprovedSources party={party} />}
        // B-W2b-180: Portal access (`?tab=portal`; the same tab as a customer's, areas/sales/customers/portal).
        portal={(party) => <PortalAccess side="suppliers" party={{ id: party.id, name: party.tradeName ?? party.legalName, companyId: party.companyId }} />}
        // B-W2b-172: the supplier questionnaire (`?tab=questionnaire`, areas/purchasing/suppliers/questionnaire).
        questionnaire={(party) => <Questionnaire partyId={party.id} />}
        depth={supplierDepthSlot}
      />
    </SupplierDepthProvider>
  )
}
