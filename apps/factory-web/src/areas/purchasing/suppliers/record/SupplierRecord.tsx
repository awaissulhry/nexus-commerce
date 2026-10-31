'use client'

import { PartyRecord } from '../../../parties/_shared/PartyRecord'
import { ApprovedSources } from '../sources/ApprovedSources'

/**
 * `/w/<company>/purchasing/suppliers/<id>` (SCR-057): the shared party record (areas/parties/_shared) on the buying side,
 * with Purchasing's own Items & prices tab (`?tab=items`: the supplier's approved sources, B-W2a-69) in its slot.
 */
export function SupplierRecord({ partyId }: { partyId: string }) {
  return <PartyRecord side="suppliers" partyId={partyId} items={(party) => <ApprovedSources party={party} />} />
}
