'use client'

import { usePathname } from 'next/navigation'
import { WithMessages } from '../../../../record-panels/i18n'
import { PartyRecord } from '../../../parties/_shared/PartyRecord'
import { useCustomerMoney } from '../money/hooks'
import { CUSTOMER_MONEY_NAMESPACE } from '../money/model'
import { useCustomerOverview } from '../money/overview'
import { PortalAccess } from '../portal/PortalAccess'
import { CommercialTerms } from '../terms/CommercialTerms'
// B-W2b-324: Customer 360 and customers in depth (the glance, requirements, the hold, PO number, consent and personal data).
import { CustomerDepthProvider, customerDepthSlot } from '../depth/CustomerDepth'

/**
 * `/w/<company>/sales/customers/<id>` (SCR-033): the shared party record seen from Sales, with the customer's Commercial
 * terms card on Tax & terms (B-W2a-49; SAL-012): it reads and saves the terms itself and has the record read the party
 * again after a save (the terms are the party's columns: its version moved). B-W2a-81: the Overview's Overdue and
 * Returns this year tiles and the open returns and claims under Now (money/: three reads beside the party, each with
 * its permission). B-W2b-324: the customer in depth through the shared record's `depth` slot (depth/): the glance on the
 * Overview (free credit, promises, samples in progress, measurement profiles, riders, repairs, the hold and its reason, a
 * rider's team, the requirements in force), the Requirements tab (`?tab=requirements`), Tax & terms › Hold and Customer PO
 * number required, and the contacts' consent, lawful basis and personal-data actions on Addresses & contacts.
 */
export function CustomerRecord({ partyId }: { partyId: string }) {
  return (
    <WithMessages namespaces={[CUSTOMER_MONEY_NAMESPACE]}>
      <Customer partyId={partyId} />
    </WithMessages>
  )
}

function Customer({ partyId }: { partyId: string }) {
  const pathname = usePathname()
  const prefix = pathname.replace(/\/sales\/customers\/.*$/, '')
  const overview = useCustomerOverview(useCustomerMoney(partyId, prefix))
  return (
    <CustomerDepthProvider partyId={partyId}>
      <PartyRecord
        side="customers"
        partyId={partyId}
        overview={overview}
        terms={(party, reload) => <CommercialTerms party={party} onChanged={reload} />}
        // B-W2b-180: Portal access (`?tab=portal`).
        portal={(party) => <PortalAccess side="customers" party={{ id: party.id, name: party.tradeName ?? party.legalName, companyId: party.companyId }} />}
        depth={(party, reload) => customerDepthSlot(party, reload, prefix)}
      />
    </CustomerDepthProvider>
  )
}
