'use client'

import { PartyRecord } from '../../../parties/_shared/PartyRecord'
import { CommercialTerms } from '../terms/CommercialTerms'

/**
 * `/w/<company>/sales/customers/<id>` (SCR-033): the shared party record seen from Sales, with the customer's Commercial
 * terms card on Tax & terms (B-W2a-49; SAL-012): it reads and saves the terms itself and has the record read the party
 * again after a save (the terms are the party's columns: its version moved).
 */
export function CustomerRecord({ partyId }: { partyId: string }) {
  return <PartyRecord side="customers" partyId={partyId} terms={(party, reload) => <CommercialTerms party={party} onChanged={reload} />} />
}
